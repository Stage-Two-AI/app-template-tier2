/**
 * Een gewone app (zonder klantportaal) krijgt dezelfde aanroepen en instellingen als op versie
 * 42, ook in scenario's die regressie-scenarios.mjs niet heeft. Anders dan regressie-42.test.mjs
 * werkt deze test niet met een vastgelegde verwachting: hij haalt de code van versie 42 zelf
 * (commit 8687e69, tag stack-v42) met `git archive` naar een tijdelijke map, draait daar en
 * hier dezelfde scenario's en legt de twee naast elkaar. De tijdelijke map gaat na afloop weg.
 * Zonder git of zonder die commit (een losse kopie van beheer/, zie "Los van de template")
 * worden de tests overgeslagen; regressie-42.test.mjs blijft dan de bewaker.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as nuScript from "./inrichten-cloudflare.mjs";
import { cloudflareClient } from "./lib/cloudflare.mjs";
import { supabaseBeheer } from "./lib/supabase.mjs";
import { nepWolk } from "./nep-wolk.mjs";
import { draaiScenarios } from "./regressie-scenarios.mjs";

/** Versie 42 van de template (tag stack-v42). */
const VERSIE_42 = "8687e697980cb847468d58c0d3ba51cbf3afd615";
const hier = fileURLToPath(new URL(".", import.meta.url));
let v42 = null;
let map = null;
// Opruimen, ook als een test faalt of het laden halverwege stopte.
after(() => {
  if (map) rmSync(map, { recursive: true, force: true });
});
try {
  map = mkdtempSync(join(tmpdir(), "beheer-v42-"));
  const tar = execFileSync("git", ["archive", VERSIE_42, "beheer", "scripts/lib"], {
    cwd: resolve(hier, ".."),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  execFileSync("tar", ["-x", "-C", map], { input: tar });
  symlinkSync(join(hier, "node_modules"), join(map, "beheer", "node_modules"));
  const laad = (b) => import(pathToFileURL(join(map, "beheer", b)).href);
  const script = await laad("inrichten-cloudflare.mjs");
  v42 = {
    richtIn: script.richtIn,
    werkToegangBij: script.werkToegangBij,
    tweedeDoorgang: script.tweedeDoorgang,
    ruimOp: script.ruimOp,
    cloudflareClient: (await laad("lib/cloudflare.mjs")).cloudflareClient,
    supabaseBeheer: (await laad("lib/supabase.mjs")).supabaseBeheer,
    nepWolk: (await laad("nep-wolk.mjs")).nepWolk,
  };
} catch {
  v42 = null;
}
const nu = {
  richtIn: nuScript.richtIn,
  werkToegangBij: nuScript.werkToegangBij,
  tweedeDoorgang: nuScript.tweedeDoorgang,
  ruimOp: nuScript.ruimOp,
  cloudflareClient,
  supabaseBeheer,
  nepWolk,
};
const sla = v42 ? false : "geen git of geen commit van versie 42 in deze kopie";

const GROEPEN = {
  klant: { domeinen: ["klant.nl"], uitsluiten: ["jan@klant.nl"] },
  stagetwo: { adressen: ["info@stagetwo.nl"] },
  entra: { idp_groepen: ["Verkoop"] },
};
const G2 = { klant: GROEPEN.klant, stagetwo: GROEPEN.stagetwo };
const ARG = {
  app: "start",
  hostname: "start.klant.nl",
  worker: "rp-start",
  repo: "Richplant-BV/start",
  voorvoegsel: "rp-",
  droogloop: false,
};
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Scenario's naast regressie-scenarios.mjs. Geeft per stap de aanroepen en het resultaat. */
async function extra(m) {
  const uit = {};
  const opzet = (w, toegang, meer = {}) => ({
    cf: m.cloudflareClient({
      fetchFn: w.fetchFn,
      token: "cf-token",
      accountId: "acc",
      teamDomein: "stagetwo",
    }),
    supabase: m.supabaseBeheer({
      fetchFn: w.fetchFn,
      token: "sb-token",
      orgSlug: "klant",
      slaap: async () => {},
    }),
    maakAdmin: w.maakAdmin,
    gh: w.gh,
    wachtOpDiscovery: async () => {},
    toegang,
    accountId: "acc",
    wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
    maskeer: () => {},
    ...meer,
  });
  const plat = (a) => {
    const body = a.body instanceof FormData ? "<multipart>" : a.body;
    if (a.soort === "fetch")
      return { s: a.soort, m: a.methode, url: a.url, body, headers: a.headers };
    if (a.soort === "admin")
      return { s: a.soort, m: a.methode, url: a.url, sleutel: a.sleutel, body };
    return { s: a.soort, args: a.args, invoer: a.invoer };
  };
  const stap = async (naam, w, werk) => {
    w.aanroepen.length = 0;
    let r;
    try {
      r = { resultaat: await werk() };
    } catch (f) {
      r = { fout: f.message };
    }
    uit[naam] = JSON.parse(
      JSON.stringify({ aanroepen: w.aanroepen.map(plat), ...r }, (_k, v) =>
        v === undefined ? null : v,
      ),
    );
  };

  // X1. 2300 accounts (drie pagina's), met identiteiten en metadata zoals de echte lijst die
  //     heeft, hoofdletters, een leeg adres, een verlopen ban; plus IdP-groepen.
  {
    const gebruikers = [
      {
        id: ID(1),
        email: "Piet@Klant.NL",
        identities: [{ provider: "custom:cloudflare", identity_data: { email: "piet@klant.nl" } }],
        app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
      },
      {
        id: ID(2),
        email: "jan@klant.nl",
        app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
      },
      {
        id: ID(3),
        email: "vreemd@elders.nl",
        identities: [{ provider: "email", identity_data: { email: "vreemd@elders.nl" } }],
        app_metadata: { provider: "email", providers: ["email"] },
      },
      { id: ID(4), email: "" },
      { id: ID(5), email: "weg@elders.nl", banned_until: "2020-01-01T00:00:00Z" },
      { id: ID(6), email: "info@stagetwo.nl", banned_until: "2126-01-01T00:00:00Z" },
      { id: ID(7), email: "verkoper@partner.nl" },
      ...Array.from({ length: 2300 }, (_, i) => ({
        id: ID(100 + i),
        email: i % 7 ? `m${i}@klant.nl` : `x${i}@elders.nl`,
      })),
    ];
    const toegang = {
      groepen: GROEPEN,
      apps: { start: { groepen: ["klant", "entra"], $opmerking: "x" }, ander: ["stagetwo"] },
      testaccounts: { start: ["Scherm@Klant.nl"] },
    };
    const w = m.nepWolk({ gebruikers, workerBestaat: true });
    const meer = {
      groepenIdp: { type: "azureAD", id: "idp-entra" },
      idps: ["idp-entra"],
      smtpWachtwoord: "re_StaatInDeOmgeving",
      captchaGeheim: "0xStaatInDeOmgeving",
    };
    await stap("X1a inrichten met testdatabase, IdP-groepen en SMTP-secret in de omgeving", w, () =>
      m.richtIn({ ...ARG, testdatabase: true }, opzet(w, toegang, meer)),
    );
    await stap("X1b toegang bijwerken, 2300 accounts", w, () =>
      m.werkToegangBij({ voorvoegsel: "rp-" }, opzet(w, toegang, meer)),
    );
    await stap("X1c toegang bijwerken droogloop", w, () =>
      m.werkToegangBij({ voorvoegsel: "rp-", droogloop: true }, opzet(w, toegang, meer)),
    );
    await stap("X1d tweede doorgang droogloop", w, () =>
      m.tweedeDoorgang({ ...ARG, droogloop: true }, opzet(w, toegang, meer)),
    );
    await stap("X1e opruimen zonder app, droogloop", w, () =>
      m.ruimOp({ ...ARG, app: null, opruimen: true, droogloop: true }, opzet(w, toegang, meer)),
    );
  }
  // X2. Een project waar de auth-instellingen met de hand zijn verbogen (e-mail aan,
  //     autoconfirm uit, eigen SMTP en limieten): wordt precies hetzelfde teruggezet?
  {
    const toegang = { groepen: G2, apps: { start: ["klant"] } };
    const w = m.nepWolk({ workerBestaat: true });
    await m.richtIn(ARG, opzet(w, toegang));
    for (const ref of Object.keys(w.staat.auth)) {
      Object.assign(w.staat.auth[ref], {
        external_email_enabled: true,
        mailer_autoconfirm: false,
        smtp_host: "smtp.elders.nl",
        rate_limit_email_sent: 5,
        security_captcha_enabled: true,
        security_manual_linking_enabled: true,
        mailer_otp_exp: 60,
      });
    }
    await stap("X2 inrichten op verbogen auth-instellingen", w, () =>
      m.richtIn(ARG, opzet(w, toegang)),
    );
  }
  // X3. Fout halverwege (auth-config weigert), daarna opnieuw.
  {
    const toegang = { groepen: G2, apps: { start: ["klant"] } };
    let stuk = true;
    const w = m.nepWolk({
      faal: (methode, pad) =>
        stuk && methode === "PATCH" && pad.endsWith("/config/auth")
          ? { status: 500, message: "stuk" }
          : null,
    });
    await stap("X3a inrichten, auth-config faalt", w, () => m.richtIn(ARG, opzet(w, toegang)));
    stuk = false;
    await stap("X3b inrichten opnieuw", w, () => m.richtIn(ARG, opzet(w, toegang)));
  }
  // X4. Een gewone app die nooit klantportaal was, waarvan de deur in Cloudflare is hernoemd,
  //     is weggehaald, of er nooit was (de tijdelijke stand), en waar iemand in te trekken is:
  //     een vertrokken medewerker met een inlog via Cloudflare, en een account zonder metadata.
  for (const [naam, verbuig, arg] of [
    ["hernoemd", (w) => (w.staat.apps.find((a) => a.name === "rp-start").name = "Start"), ARG],
    [
      "weggehaald",
      (w) =>
        w.staat.apps.splice(
          w.staat.apps.findIndex((a) => a.name === "rp-start"),
          1,
        ),
      ARG,
    ],
    ["tijdelijke stand", () => {}, { ...ARG, hostname: null, stand: "tijdelijk" }],
  ]) {
    const toegang = { groepen: G2, apps: { start: ["klant"] } };
    const w = m.nepWolk({
      workerBestaat: true,
      gebruikers: [
        {
          id: ID(1),
          email: "piet@klant.nl",
          app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
        },
        {
          id: ID(2),
          email: "ex@oudbedrijf.nl",
          identities: [
            { provider: "custom:cloudflare", identity_data: { email: "ex@oudbedrijf.nl" } },
          ],
          app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
        },
        { id: ID(3), email: "vreemd@elders.nl" },
      ],
    });
    await m.richtIn(arg, opzet(w, toegang));
    verbuig(w);
    await stap(`X4a deur ${naam}: toegang bijwerken trekt in`, w, () =>
      m.werkToegangBij({ voorvoegsel: "rp-" }, opzet(w, toegang)),
    );
    await stap(`X4b deur ${naam}: nog een keer, niets meer te doen`, w, () =>
      m.werkToegangBij({ voorvoegsel: "rp-" }, opzet(w, toegang)),
    );
    await stap(`X4c deur ${naam}: droogloop van App inrichten`, w, () =>
      m.richtIn({ ...arg, droogloop: true }, opzet(w, toegang)),
    );
  }
  return uit;
}

test("regressie: regressie-42.json komt echt uit de code van versie 42", {
  skip: sla,
}, async () => {
  const opnieuw = JSON.parse(JSON.stringify(await draaiScenarios(v42)));
  const vast = JSON.parse(readFileSync(new URL("./regressie-42.json", import.meta.url), "utf8"));
  assert.deepEqual(opnieuw, vast);
});

test("regressie: 2300 accounts, IdP-groepen, geheimen van het klantportaal in de omgeving, verbogen auth-instellingen, een fout halverwege en een gewone app waarvan de deur ontbreekt of hernoemd is (met iemand in te trekken) geven exact de aanroepen van versie 42", {
  skip: sla,
}, async () => {
  const [oud, nieuw] = [await extra(v42), await extra(nu)];
  const aantal = Object.values(oud).reduce((n, s) => n + s.aanroepen.length, 0);
  assert.ok(aantal > 150, "de scenario's doen echt iets");
  // Verwachte fouten: de nagebootste storing (X3a), en een hernoemde deur, waar App inrichten
  // toen en nu op stopt ("bewaakt ... al").
  const onverwacht = Object.entries(oud).filter(
    ([, s]) => s.fout && !/stuk|zonder voorvoegsel\) bewaakt/.test(s.fout),
  );
  assert.deepEqual(onverwacht, []);
  // Eén bewust verschil, alleen in tekst: de droogloop van App inrichten voor een gewone app
  // zonder deur zegt er nu bij wat de echte run doet als dit een klantportaal was. De
  // aanroepen zijn ook daar exact gelijk.
  const zonderDeur = "X4c deur weggehaald: droogloop van App inrichten";
  const erbij = nieuw[zonderDeur].resultaat.waarschuwingen.filter((x) =>
    /er staat nu geen deur/.test(x),
  );
  assert.equal(erbij.length, 1);
  nieuw[zonderDeur].resultaat.waarschuwingen = nieuw[zonderDeur].resultaat.waarschuwingen.filter(
    (x) => !erbij.includes(x),
  );
  for (const naam of Object.keys(oud)) {
    assert.deepEqual(nieuw[naam].aanroepen, oud[naam].aanroepen, naam);
    assert.deepEqual(nieuw[naam], oud[naam], naam);
  }
  // De scenario's zonder deur trekken echt iemand in (anders bewijst de vergelijking niets).
  for (const soort of ["hernoemd", "weggehaald", "tijdelijke stand"]) {
    const bans = oud[`X4a deur ${soort}: toegang bijwerken trekt in`].aanroepen.filter(
      (a) => a.m === "updateUserById",
    );
    assert.equal(bans.length, 2, soort);
  }
  assert.deepEqual(Object.keys(nieuw), Object.keys(oud));
});

test("regressie: een gewone app naast een klantportaal in hetzelfde bestand krijgt dezelfde aanroepen als naast een gewone app", async () => {
  const draai = async (ander) => {
    const toegang = { groepen: G2, apps: { start: ["klant"], portaal: ander } };
    const w = nepWolk({
      workerBestaat: true,
      gebruikers: [{ id: ID(1), email: "vreemd@elders.nl" }],
    });
    const d = () => ({
      cf: cloudflareClient({
        fetchFn: w.fetchFn,
        token: "cf-token",
        accountId: "acc",
        teamDomein: "stagetwo",
      }),
      supabase: supabaseBeheer({
        fetchFn: w.fetchFn,
        token: "sb-token",
        orgSlug: "klant",
        slaap: async () => {},
      }),
      maakAdmin: w.maakAdmin,
      gh: w.gh,
      wachtOpDiscovery: async () => {},
      toegang,
      accountId: "acc",
      wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
      maskeer: () => {},
      smtpWachtwoord: "re_x",
      captchaGeheim: "0x_y",
    });
    const r1 = await nuScript.richtIn(ARG, d());
    const r2 = await nuScript.werkToegangBij({ voorvoegsel: "rp-", app: "start" }, d());
    const r3 = await nuScript.werkToegangBij({ voorvoegsel: "rp-" }, d());
    const kaal = (a) =>
      JSON.stringify([
        a.soort,
        a.methode,
        a.url ?? a.args,
        a.body instanceof FormData ? "" : a.body,
        a.invoer,
      ]);
    // De policy van de groep van de andere app heet in beide gevallen hetzelfde.
    return JSON.stringify([w.aanroepen.map(kaal), r1, r2, r3]);
  };
  const gewoon = await draai(["stagetwo"]);
  const portaal = await draai({
    groepen: ["stagetwo"],
    klantportaal: true,
    afzender: "noreply@klant.nl",
    turnstile_sitekey: "0x4AAAAAAAOpenbareSleutel",
  });
  assert.equal(portaal, gewoon);
});
