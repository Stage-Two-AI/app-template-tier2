/**
 * Een app van de openbare template (app-template-tier2-openbaar) inrichten, uitgave 44. Tot en
 * met 43 stopte App inrichten bij zo'n app meteen: de controle van wrangler.jsonc was die van
 * de gewone template en weigert `main`. Deze tests draaien op de echte bestanden van de
 * openbare template (testdata/openbaar/, letterlijke kopieën; de bewaker van de werkplaats
 * houdt ze gelijk aan de bron).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  APP_KENMERK,
  configVoor,
  KLANTPORTAAL_INLOGDIENST,
  leesArgumenten,
  richtIn,
  ruimOp,
  schakelaarAan,
} from "./inrichten-cloudflare.mjs";
import { ARG, auth, DEUR, naarPortaal, opzet, PORTAAL, stap } from "./klantportaal-opzet.mjs";
import { GEWOON, OPENBAAR, valideerVariant, wranglerConfig } from "./lib/variant.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const HIER = dirname(fileURLToPath(import.meta.url));
const DATA = join(HIER, "testdata", "openbaar");
const ECHT = join(DATA, "wrangler.jsonc");
const WRANGLER = readFileSync(ECHT, "utf8");
const MAP = mkdtempSync(join(tmpdir(), "beheer-openbaar-"));
const schrijf = (naam, tekst) => {
  const pad = join(MAP, naam);
  writeFileSync(pad, tekst);
  return pad;
};

// De echte wrangler.jsonc staat in de tijdelijke stand. Met het domein erbij, op de plek en in
// de vorm die het bestand zelf in zijn commentaar voorschrijft, is het de standaardstand.
const DOMEIN = "direct.voorbeeldapps.nl";
const LAATSTE = '"preview_urls": true\n';
assert.equal(WRANGLER.split(LAATSTE).length, 2, "de laatste regel van wrangler.jsonc is gevonden");
const MET_DOMEIN = schrijf(
  "met-domein.jsonc",
  WRANGLER.replace(
    LAATSTE,
    `"preview_urls": true,\n  "routes": [{ "pattern": "${DOMEIN}", "custom_domain": true }]\n`,
  ),
);
const ZONDER_MAIN = schrijf(
  "zonder-main.jsonc",
  WRANGLER.replace('"main": "./workers/app.ts",\n', ""),
);
// De wrangler.jsonc van deze (gewone) template, en dezelfde met een `main` erbij.
const GEWONE = readFileSync(join(HIER, "..", "wrangler.jsonc"), "utf8");
const GEWONE_NAAM = /"name": "[^"]+",\n/.exec(GEWONE)[0];
const GEWOON_MET_MAIN = schrijf(
  "gewoon-met-main.jsonc",
  GEWONE.replace(GEWONE_NAAM, `${GEWONE_NAAM}  "main": "./workers/app.ts",\n`),
);

/** De bestanden die de inrichting uit de app-repo leest, zoals ze in de openbare template staan. */
const GH_BESTANDEN = {
  "src/lib/env.ts": readFileSync(join(DATA, "env.ts.txt"), "utf8"),
  "stack.config.json": readFileSync(join(DATA, "stack.config.json"), "utf8"),
};

/** De argumenten zoals het script ze zelf opbouwt: uit de vlaggen en uit wrangler.jsonc. */
function argumenten(wrangler, extra = []) {
  const arg = leesArgumenten([
    "--voorvoegsel",
    "vb-",
    "--app",
    "direct",
    "--repo",
    ARG.repo,
    "--wrangler",
    wrangler,
    "--variant",
    OPENBAAR,
    ...extra,
  ]);
  const config = configVoor(arg, "inrichten");
  return { ...arg, hostname: config.hostname, worker: config.worker, stand: config.stand };
}

// ---------------------------------------------------------------- de controle van wrangler.jsonc

test("variant: de echte wrangler.jsonc van de openbare template is goed met --variant cloudflare-openbaar", () => {
  assert.deepEqual(wranglerConfig(OPENBAAR, ECHT), {
    worker: "cf-proef",
    stand: "tijdelijk",
    hostname: null,
  });
  assert.deepEqual(wranglerConfig(OPENBAAR, MET_DOMEIN), {
    worker: "cf-proef",
    stand: "standaard",
    hostname: DOMEIN,
  });
});

test("variant: zonder --variant blijft een wrangler.jsonc met `main` geweigerd, zoals op versie 43", () => {
  for (const variant of [null, undefined, GEWOON]) {
    assert.throws(() => wranglerConfig(variant, ECHT), /`main` hoort er niet in/, String(variant));
    assert.throws(
      () => wranglerConfig(variant, GEWOON_MET_MAIN),
      /`main` hoort er niet in/,
      `een gewone app met main, variant ${variant}`,
    );
  }
  // De gewone wrangler.jsonc zelf blijft goed, en de inrichting raadt de variant niet uit het bestand.
  assert.equal(wranglerConfig(null, join(HIER, "..", "wrangler.jsonc")).stand !== undefined, true);
});

test("variant: een app van de openbare template zonder `main` wordt geweigerd", () => {
  assert.throws(
    () => wranglerConfig(OPENBAAR, ZONDER_MAIN),
    /`main` moet "\.\/workers\/app\.ts" zijn/,
  );
  // En de gewone wrangler.jsonc (bestanden, geen servercode) is geen openbare app.
  assert.throws(
    () => wranglerConfig(OPENBAAR, join(HIER, "..", "wrangler.jsonc")),
    /wrangler\.jsonc/,
  );
});

test("variant: alleen de twee bekende waarden; --variant vraagt een waarde", () => {
  assert.equal(valideerVariant(null), null);
  assert.equal(valideerVariant(OPENBAAR), "cloudflare-openbaar");
  assert.equal(valideerVariant(GEWOON), "cloudflare");
  for (const fout of ["openbaar", "", "cloudflare-light", "toString", "__proto__"]) {
    assert.throws(() => valideerVariant(fout), /--variant kent/, fout);
  }
  const basis = ["--voorvoegsel", "vb-", "--app", "direct", "--repo", ARG.repo, "--wrangler", ECHT];
  assert.equal(leesArgumenten(basis).variant, null, "zonder de vlag: de gewone app");
  assert.equal(leesArgumenten([...basis, "--variant", OPENBAAR]).variant, OPENBAAR);
  assert.throws(() => leesArgumenten([...basis, "--variant", "iets"]), /--variant kent/);
  assert.throws(() => leesArgumenten([...basis, "--variant"]), /--variant vraagt een waarde/);
  assert.throws(() => leesArgumenten([...basis, "--variant", "--droogloop"]), /vraagt een waarde/);
});

test("variant: opruimen leest de Worker-naam van een openbare app alleen met de variant", () => {
  const met = leesArgumenten([
    "--voorvoegsel",
    "vb-",
    "--opruimen",
    "--app",
    "direct",
    "--repo",
    ARG.repo,
    "--wrangler",
    MET_DOMEIN,
    "--variant",
    OPENBAAR,
  ]);
  assert.equal(configVoor(met, "opruimen").worker, "cf-proef");
  // Zonder de variant is de config onleesbaar; opruimen gaat door en laat het Worker-script staan.
  assert.equal(configVoor({ ...met, variant: null }, "opruimen"), null);
  assert.throws(
    () => configVoor({ ...met, variant: null }, "inrichten"),
    /`main` hoort er niet in/,
  );
});

// ---------------------------------------------------------------- het script zelf, van buitenaf

test("het script: zonder --variant stopt het op `main`, met --variant komt het voorbij de controle", () => {
  const draai = (extra) =>
    spawnSync(
      process.execPath,
      [
        join(HIER, "inrichten-cloudflare.mjs"),
        "--voorvoegsel",
        "vb-",
        "--app",
        "direct",
        "--repo",
        ARG.repo,
        "--wrangler",
        MET_DOMEIN,
        "--droogloop",
        ...extra,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH } },
    );
  const zonder = draai([]);
  assert.equal(zonder.status, 1);
  assert.match(zonder.stdout, /^INRICHTING \{"status":"mislukt".*`main` hoort er niet in/m);
  // Met de variant is wrangler.jsonc goed; het script stopt pas bij de eerste sleutel die in
  // deze test (zonder omgeving) ontbreekt.
  const met = draai(["--variant", OPENBAAR]);
  assert.equal(met.status, 1);
  assert.doesNotMatch(met.stdout, /main/);
  assert.match(met.stdout, /^INRICHTING \{"status":"mislukt".*CLOUDFLARE_PROEF_TOKEN/m);
});

// ---------------------------------------------------------------- de hele inrichting

test("de openbare template is zelf een klantportaal dat de inlog van een klantportaal begrijpt", () => {
  assert.ok(
    GH_BESTANDEN[APP_KENMERK.bestand].includes(APP_KENMERK.tekst),
    "env.ts leest de lijst inlogdiensten",
  );
  assert.equal(schakelaarAan(GH_BESTANDEN["stack.config.json"]), true);
});

test("openbare app met klantportaal: de droogloop plant alles en wijzigt niets", async () => {
  const w = nepWolk({ ghBestanden: GH_BESTANDEN });
  const r = await richtIn(
    argumenten(MET_DOMEIN, ["--droogloop", "--testdatabase"]),
    opzet(w, PORTAAL),
  );
  assert.equal(r.droogloop, true);
  assert.equal(r.hostname, DOMEIN);
  assert.deepEqual(r.waarschuwingen, [], "niets wat de echte run zou tegenhouden");
  assert.equal(stap(r, "3.1 Supabase-project"), "gepland: vb-direct in eu-central-1");
  assert.match(
    stap(r, "3.4 auth-config"),
    new RegExp(
      `site_url https://${DOMEIN}, redirects https://${DOMEIN}/\\*\\* https://pr-\\*-cf-proef\\.`,
    ),
  );
  assert.match(stap(r, "3.4 auth-config"), /klantportaal: inloggen per mail aan/);
  assert.match(stap(r, "T testdatabase"), /vb-direct-test/);
  assert.match(stap(r, "3.5 Access-app op de hostname"), /^geen deur\. klantportaal/);
  assert.equal(stap(r, "4 Access op de Worker"), "gepland: placeholder en Access op de Worker");
  const schrijvend = w.aanroepen.filter(
    (a) =>
      (a.soort === "fetch" && a.methode !== "GET" && !/siteverify/.test(a.url)) ||
      a.soort === "admin",
  );
  assert.deepEqual(schrijvend, [], "een droogloop schrijft nergens");
  assert.deepEqual(w.staat.projecten, []);
  assert.deepEqual(w.staat.apps, []);
});

test("openbare app met klantportaal: de echte inrichting, eerst met de deur, dan het vinkje", async () => {
  const w = nepWolk({ ghBestanden: GH_BESTANDEN });
  const arg = argumenten(MET_DOMEIN, ["--testdatabase"]);
  const r1 = await richtIn(arg, opzet(w, PORTAAL));
  // De placeholder en de Access op de Worker staan er vóór de eerste uitrol; de Worker-naam
  // komt uit de wrangler.jsonc van de openbare template.
  assert.equal(stap(r1, "4 Access op de Worker"), "placeholder neergezet, Access aangemaakt");
  assert.ok(w.staat.apps.some((a) => a.name === "vb-direct-worker"));
  const r2 = await richtIn({ ...arg, deurWeghalen: true }, opzet(w, PORTAAL));
  assert.match(stap(r2, "3.5 Access-app op de hostname"), /^geen deur\. klantportaal/);
  assert.equal(
    w.staat.apps.some((a) => a.name === "vb-direct"),
    false,
    "geen deur op het domein",
  );
  // Wat de uitrol van de openbare template leest (uitrollen.yml daar): dezelfde namen.
  const productie = w.staat.ghVariabelen.production;
  assert.equal(productie.VITE_INLOGDIENST, KLANTPORTAAL_INLOGDIENST);
  assert.match(productie.VITE_SUPABASE_URL, /^https:\/\/ref\d+\.supabase\.co$/);
  assert.ok(
    productie.VITE_SUPABASE_ANON_KEY &&
      productie.VITE_TURNSTILE_SITEKEY &&
      productie.SUPABASE_POOLER_HOST,
  );
  assert.equal(w.staat.ghVariabelen.repo.PREVIEW_VITE_INLOGDIENST, "cloudflare");
  // De inlog op de server komt terug op /login/terug en de maillink gaat naar /login: beide
  // vallen onder het domein in de lijst van terugkeeradressen.
  const config = auth(w, "vb-direct");
  assert.equal(config.site_url, `https://${DOMEIN}`);
  assert.ok(config.uri_allow_list.split(",").includes(`https://${DOMEIN}/**`));
  assert.equal(config.external_email_enabled, true);
  // Een derde run verandert niets meer.
  const voor = w.aanroepen.length;
  const r3 = await richtIn(arg, opzet(w, PORTAAL));
  const schrijvend = w.aanroepen
    .slice(voor)
    .filter(
      (a) =>
        a.soort === "fetch" &&
        !["GET"].includes(a.methode) &&
        /access\/apps|workers\/scripts/.test(a.url),
    );
  assert.deepEqual(schrijvend, [], "geen wijziging aan Access of de Worker bij een herhaling");
  assert.equal(stap(r3, "4 Access op de Worker"), "ongewijzigd");
});

test("openbare app zonder klantportaal in toegang.json: gewoon achter de deur, zoals elke app", async () => {
  const w = nepWolk({ ghBestanden: GH_BESTANDEN });
  const r = await richtIn(argumenten(MET_DOMEIN), opzet(w, DEUR));
  assert.ok(
    w.staat.apps.some((a) => a.name === "vb-direct"),
    "de deur op het domein",
  );
  assert.ok(w.staat.apps.some((a) => a.name === "vb-direct-worker"));
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare");
  assert.equal(auth(w, "vb-direct").external_email_enabled, false);
  assert.ok(r.stappen.length > 0);
});

test("openbare app in de tijdelijke stand (de echte wrangler.jsonc): een klantportaal vraagt eerst een domein", async () => {
  const w = nepWolk({ ghBestanden: GH_BESTANDEN });
  const arg = argumenten(ECHT, ["--droogloop"]);
  assert.equal(arg.stand, "tijdelijk");
  const r = await richtIn(arg, opzet(w, PORTAAL));
  assert.ok(
    r.waarschuwingen.some((x) => /een klantportaal vraagt een eigen domein/.test(x)),
    "de droogloop zegt wat de echte run tegenhoudt",
  );
  await assert.rejects(
    richtIn({ ...arg, droogloop: false }, opzet(nepWolk({ ghBestanden: GH_BESTANDEN }), PORTAAL)),
    /eigen domein/,
  );
  // Zonder klantportaal mag de tijdelijke stand wel: dan is de Access op de Worker de deur.
  const w2 = nepWolk({ ghBestanden: GH_BESTANDEN });
  const r2 = await richtIn({ ...arg, droogloop: false }, opzet(w2, DEUR));
  assert.equal(r2.hostname, "cf-proef.stagetwo-acc.workers.dev");
  assert.equal(
    w2.staat.apps.some((a) => a.name === "vb-direct"),
    false,
    "geen deur op een domein dat er niet is",
  );
  assert.ok(w2.staat.apps.some((a) => a.name === "vb-direct-worker"));
});

test("openbare app opruimen: ook het Worker-script gaat weg", async () => {
  const w = nepWolk({ ghBestanden: GH_BESTANDEN });
  const arg = argumenten(MET_DOMEIN);
  await naarPortaal(w, PORTAAL, arg);
  const r = await ruimOp({ ...arg, opruimen: true }, opzet(w, PORTAAL));
  assert.ok(
    r.verwijderd.some((v) => v.soort === "Worker-script" && v.naam === "cf-proef"),
    JSON.stringify(r.verwijderd),
  );
  assert.deepEqual(w.staat.apps, []);
});
