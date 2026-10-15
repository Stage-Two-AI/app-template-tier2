import assert from "node:assert/strict";
import { test } from "node:test";
import {
  leesArgumenten,
  richtIn,
  ruimOp,
  tweedeDoorgang,
  uitvoerRegel,
  vangnet,
  werkToegangBij,
} from "./inrichten-cloudflare.mjs";
import {
  cloudflareClient,
  inlogApp,
  valideerVoorvoegsel,
  wachtOpDiscovery,
} from "./lib/cloudflare.mjs";
import { organisaties, supabaseBeheer, uriAllowList } from "./lib/supabase.mjs";
import { magAanmelden } from "./lib/toegang.mjs";
import { vraag } from "./lib/vraag.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const TOEGANG = {
  groepen: { stagetwo: { adressen: ["info@stagetwo.nl"] } },
  apps: { "cf-proef": ["stagetwo"] },
};
const ARG = {
  app: "cf-proef",
  hostname: "cf-proef.stagetwo.nl",
  worker: "cf-proef",
  repo: "Stage-Two-AI/app-template-tier2",
  voorvoegsel: "cf-proef-",
  droogloop: false,
};
const WACHTWOORD = "GeheimDatabaseWachtwoord1234567";

function opzet(w, extra = {}) {
  const cf = cloudflareClient({
    fetchFn: w.fetchFn,
    token: "cf-token",
    accountId: "acc",
    teamDomein: "stagetwo",
  });
  const supabase = supabaseBeheer({
    fetchFn: w.fetchFn,
    token: "sb-token",
    orgSlug: "stagetwo",
    slaap: async () => {},
  });
  const geheimen = [];
  return {
    cf,
    supabase,
    maakAdmin: w.maakAdmin,
    gh: w.gh,
    wachtOpDiscovery: async () => {},
    toegang: TOEGANG,
    accountId: "acc",
    wachtwoord: () => WACHTWOORD,
    maskeer: (waarde) => geheimen.push(waarde),
    geheimen,
    ...extra,
  };
}

// ---------------------------------------------------------------- argumenten

const PROEF = ["--voorvoegsel", "cf-proef-"];
const RP = ["--voorvoegsel", "rp-", "--repo", "Richplant-BV/richplant-start"];

test("argumenten: app verplicht, modi sluiten elkaar uit", () => {
  assert.deepEqual(leesArgumenten([...PROEF, "--app", "cf-proef", "--droogloop"]), {
    app: "cf-proef",
    hostname: null,
    repo: null,
    wrangler: null,
    voorvoegsel: "cf-proef-",
    droogloop: true,
    opruimen: false,
    vangnet: false,
    tweedeDoorgang: false,
    toegang: false,
    testdatabase: false,
  });
  assert.equal(
    leesArgumenten([...PROEF, "--app", "cf-proef", "--testdatabase"]).testdatabase,
    true,
  );
  assert.throws(() => leesArgumenten([...PROEF, "--droogloop"]), /--app/);
  assert.throws(() => leesArgumenten([...PROEF, "--app", "Cf_Proef"]), /kleine letters/);
  assert.throws(
    () => leesArgumenten([...PROEF, "--app", "a", "--opruimen", "--vangnet"]),
    /één van/,
  );
  assert.throws(() => leesArgumenten([...PROEF, "--app", "a", "--wat"]), /onbekende optie/);
  assert.equal(
    leesArgumenten([...PROEF, "--opruimen"]).opruimen,
    true,
    "opruimen kan zonder --app",
  );
});

test("argumenten: zonder voorvoegsel stopt het script met een duidelijke melding", () => {
  assert.throws(
    () => leesArgumenten(["--app", "cf-proef", "--droogloop"], {}),
    /voorvoegsel ontbreekt.*--voorvoegsel.*BEHEER_VOORVOEGSEL/,
  );
  for (const fout of ["rp", "RP-", "rp_", "-rp-", "rp-'x-", `${"a".repeat(17)}-`]) {
    assert.throws(() => leesArgumenten(["--voorvoegsel", fout, "--app", "a"]), /voorvoegsel/, fout);
  }
  const uitEnv = leesArgumenten(["--toegang"], { BEHEER_VOORVOEGSEL: "rp-" });
  assert.equal(uitEnv.voorvoegsel, "rp-", "BEHEER_VOORVOEGSEL telt als instelling");
  const vlagWint = leesArgumenten(["--voorvoegsel", "cf-proef-", "--toegang"], {
    BEHEER_VOORVOEGSEL: "rp-",
  });
  assert.equal(vlagWint.voorvoegsel, "cf-proef-");
});

test("voorvoegsel: precies één streepje aan het eind, cf-proef- is de enige uitzondering", () => {
  for (const fout of ["cf-", "rp-x-", "cf-ander-", "cf-proef-x-"]) {
    assert.throws(() => valideerVoorvoegsel(fout), /voorvoegsel/, fout);
  }
  assert.equal(valideerVoorvoegsel("rp-"), "rp-");
  assert.equal(valideerVoorvoegsel("cf-proef-"), "cf-proef-");
});

test("argumenten: buiten de proef zijn --repo en --wrangler verplicht", () => {
  const actions = { GITHUB_REPOSITORY: "Richplant-BV/stack-beheer" };
  assert.throws(
    () =>
      leesArgumenten(
        ["--voorvoegsel", "rp-", "--app", "richplant", "--wrangler", "a/w.jsonc"],
        actions,
      ),
    /--repo/,
    "buiten de proef nooit terugvallen op de eigen repo",
  );
  assert.throws(
    () =>
      leesArgumenten(["--voorvoegsel", "rp-", "--app", "richplant", "--wrangler", "a/w.jsonc"], {}),
    /--repo/,
  );
  assert.throws(() => leesArgumenten([...RP, "--app", "richplant"], actions), /--wrangler/);
  const a = leesArgumenten(
    [...RP, "--app", "richplant", "--wrangler", "app/wrangler.jsonc"],
    actions,
  );
  assert.equal(a.repo, "Richplant-BV/richplant-start");
  assert.equal(a.wrangler, "app/wrangler.jsonc");
  assert.throws(
    () => leesArgumenten(["--voorvoegsel", "rp-", "--repo", "geen-org", "--toegang"]),
    /--repo/,
  );
  assert.equal(
    leesArgumenten(["--voorvoegsel", "rp-", "--toegang"], actions).repo,
    null,
    "toegang bijwerken heeft geen repo nodig",
  );
});

test("argumenten: de proef valt terug op GITHUB_REPOSITORY en wrangler.jsonc", () => {
  const a = leesArgumenten([...PROEF, "--app", "cf-proef"], {
    GITHUB_REPOSITORY: "Stage-Two-AI/app-template-tier2",
  });
  assert.equal(a.repo, "Stage-Two-AI/app-template-tier2");
  assert.equal(a.wrangler, null, "het script leest dan wrangler.jsonc in de werkmap");
  const b = leesArgumenten([...PROEF, "--app", "cf-proef", "--repo", "Stage-Two-AI/ander"], {
    GITHUB_REPOSITORY: "Stage-Two-AI/app-template-tier2",
  });
  assert.equal(b.repo, "Stage-Two-AI/ander", "--repo gaat voor");
});

// ---------------------------------------------------------------- droogloop

test("droogloop: maakt niets aan en toont de volledige lijst geplande stappen", async () => {
  const w = nepWolk();
  const r = await richtIn({ ...ARG, droogloop: true }, opzet(w));
  assert.deepEqual(w.schrijfacties(), []);
  assert.deepEqual(
    r.stappen.map((s) => s.stap),
    [
      "3.1 Supabase-project",
      "3.2 Access-policies",
      "3.2 Access SaaS-app (OIDC)",
      "3.3 custom provider custom:cloudflare",
      "3.4 auth-config",
      "3.5 Access-app op de hostname",
      "4 Access op de Worker",
      "3.6 GitHub-variabelen en -secrets",
    ],
  );
  assert.ok(r.stappen.every((s) => /gepland|bestaat al|nog niet uitgerold/.test(s.actie)));
});

// ---------------------------------------------------------------- volledige run

test("volledige run: de schrijfacties volgen de volgorde van het ontwerp", async () => {
  const w = nepWolk();
  const d = opzet(w);
  const r = await richtIn(ARG, d);
  const schrijf = w.schrijfacties();
  const ref = w.staat.projecten[0].ref;
  assert.deepEqual(schrijf.slice(0, 8), [
    "POST sb/projects",
    // het wachtwoord meteen bewaren, vóór iets anders kan mislukken
    "gh secret set SUPABASE_PROJECT_REF",
    "gh secret set SUPABASE_DB_PASSWORD",
    "POST cf/access/policies",
    "POST cf/access/apps saas",
    "admin createProvider",
    `PATCH sb/projects/${ref}/config/auth`,
    "POST cf/access/apps self_hosted",
  ]);
  assert.ok(
    schrijf.slice(8).every((s) => s.startsWith("gh ")),
    "daarna alleen nog GitHub",
  );
  assert.equal(
    r.stappen.find((s) => s.stap === "4 Access op de Worker").actie,
    "overgeslagen: nog niet uitgerold",
  );
  assert.equal(r.supabase.ref, ref);
  assert.equal(r.issuer, "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/sso/oidc/cid-3");
});

test("volledige run: SaaS-app is OIDC met callback, scopes, PKCE en expliciete inlogmethoden", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w));
  const ref = w.staat.projecten[0].ref;
  const saas = w.aanroepen.find((a) => a.methode === "POST" && a.body?.type === "saas").body;
  assert.equal(saas.name, "cf-proef-cf-proef-inlog");
  assert.equal(saas.saas_app.auth_type, "oidc");
  assert.deepEqual(saas.saas_app.redirect_uris, [`https://${ref}.supabase.co/auth/v1/callback`]);
  assert.deepEqual(saas.saas_app.scopes, ["openid", "email", "profile", "groups"]);
  assert.deepEqual(saas.saas_app.grant_types, ["authorization_code"]);
  assert.deepEqual(saas.allowed_idps, ["idp-otp"]);
  const pol = w.staat.policies.find((p) => p.name === "cf-proef-stagetwo");
  assert.deepEqual(saas.policies, [{ id: pol.id, precedence: 1 }]);
  const deur = w.aanroepen.find((a) => a.methode === "POST" && a.body?.type === "self_hosted").body;
  assert.deepEqual(deur.policies, saas.policies, "deur en inlogdienst krijgen dezelfde policies");
  assert.equal(deur.domain, "cf-proef.stagetwo.nl");
});

test("volledige run: custom provider met issuer, client_id, PKCE en scopes, via de service role", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w));
  const ref = w.staat.projecten[0].ref;
  const maak = w.aanroepen.find((a) => a.methode === "createProvider");
  assert.equal(maak.url, `https://${ref}.supabase.co`);
  assert.equal(maak.sleutel, `geheim-sr-${ref}`);
  assert.deepEqual(maak.body, {
    provider_type: "oidc",
    identifier: "custom:cloudflare",
    name: "Cloudflare Access",
    client_id: "cid-3",
    client_secret: "geheim-cs-3",
    issuer: "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/sso/oidc/cid-3",
    pkce_enabled: true,
    scopes: ["openid", "email", "profile"],
    enabled: true,
  });
});

test("auth-config: e-mail uit, disable_signup onaangeroerd, redirects zonder wildcard in het subdomein", async () => {
  const w = nepWolk({ subdomein: "stagetwo-acc" });
  await richtIn(ARG, opzet(w));
  const patch = w.aanroepen.find((a) => a.methode === "PATCH").body;
  assert.equal(patch.external_email_enabled, false);
  assert.equal(patch.mailer_autoconfirm, true);
  assert.equal("disable_signup" in patch, false);
  assert.equal(patch.site_url, "https://cf-proef.stagetwo.nl");
  assert.equal(
    patch.uri_allow_list,
    "https://cf-proef.stagetwo.nl/**,https://pr-*-cf-proef.stagetwo-acc.workers.dev/**",
  );
});

test("uri_allow_list: het account-subdomein komt uit de API en is nooit een wildcard", () => {
  const lijst = uriAllowList({ hostname: "a.nl", worker: "app", subdomein: "acc-sub" });
  const preview = new URL(lijst[1].replace("*", "x").replace("/**", "/"));
  const labels = preview.hostname.split(".");
  assert.deepEqual(labels.slice(1), ["acc-sub", "workers", "dev"]);
  assert.throws(
    () => uriAllowList({ hostname: "a.nl", worker: "app", subdomein: "*" }),
    /subdomein/,
  );
  assert.throws(
    () => uriAllowList({ hostname: "a.nl", worker: "app", subdomein: "" }),
    /subdomein/,
  );
});

test("GitHub: variabelen per omgeving, secrets via stdin, niets in de argumenten", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w));
  const ref = w.staat.projecten[0].ref;
  for (const env of ["production", "preview"]) {
    assert.deepEqual(w.staat.ghVariabelen[env], {
      VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
      VITE_SUPABASE_ANON_KEY: `anon-${ref}`,
      VITE_INLOGDIENST: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      SUPABASE_POOLER_HOST: "aws-0-eu-central-1.pooler.supabase.com",
    });
  }
  const gh = w.aanroepen.filter((a) => a.soort === "gh");
  assert.ok(gh.every((a) => a.args.includes("--repo") && a.args.includes(ARG.repo)));
  assert.ok(
    gh.every((a) => !a.args.join(" ").includes(WACHTWOORD)),
    "geen geheim in de argumenten",
  );
  const ww = gh.find((a) => a.args[2] === "SUPABASE_DB_PASSWORD");
  assert.equal(ww.invoer, WACHTWOORD);
});

test("GitHub: de databasesecrets staan in omgeving production, niet op de repo", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w));
  assert.deepEqual(w.staat.ghSecrets.production.sort(), [
    "SUPABASE_DB_PASSWORD",
    "SUPABASE_PROJECT_REF",
  ]);
  assert.deepEqual(w.staat.ghSecrets.repo ?? [], [], "geen repo-secret: een PR-tak kan die lezen");
  const zetten = w.aanroepen.filter(
    (a) => a.soort === "gh" && a.args[1] === "set" && a.args[0] === "secret",
  );
  assert.ok(zetten.length > 0);
  for (const a of zetten) {
    assert.equal(a.args[a.args.indexOf("--env") + 1], "production", a.args.join(" "));
  }
});

test("GitHub: de openbare previewwaarden staan als PREVIEW_-repovariabelen", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w));
  const ref = w.staat.projecten[0].ref;
  assert.deepEqual(w.staat.ghVariabelen.repo, {
    PREVIEW_VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
    PREVIEW_VITE_SUPABASE_ANON_KEY: `anon-${ref}`,
    PREVIEW_VITE_SUPABASE_SCHEMA: "public",
    PREVIEW_VITE_INLOGDIENST: "cloudflare",
  });
});

test("voorvoegsel rp- en --repo: alles krijgt rp- en alles gaat naar die repo", async () => {
  const w = nepWolk({ workerBestaat: true });
  const arg = {
    ...ARG,
    app: "richplant",
    hostname: "richplant-start.richplant.nl",
    worker: "richplant-start",
    voorvoegsel: "rp-",
    repo: "Richplant-BV/richplant-start",
  };
  const toegang = {
    groepen: { richplant: { domeinen: ["richplant.nl"] } },
    apps: { richplant: ["richplant"] },
  };
  await richtIn(arg, opzet(w, { toegang }));
  assert.deepEqual(
    w.staat.policies.map((p) => p.name),
    ["rp-richplant"],
  );
  assert.deepEqual(w.staat.apps.map((a) => a.name).sort(), [
    "rp-richplant",
    "rp-richplant-inlog",
    "rp-richplant-worker",
  ]);
  assert.deepEqual(
    w.staat.projecten.map((p) => p.name),
    ["rp-richplant"],
  );
  const gh = w.aanroepen.filter((a) => a.soort === "gh");
  assert.ok(gh.length > 0);
  for (const a of gh) {
    assert.equal(a.args[a.args.indexOf("--repo") + 1], "Richplant-BV/richplant-start");
    assert.equal(a.args.includes("Stage-Two-AI/app-template-tier2"), false);
  }
});

test("voorvoegsel rp-: opruimen raakt alleen rp-namen", async () => {
  const w = nepWolk({
    workerBestaat: true,
    policies: [{ id: "proef-pol", name: "cf-proef-stagetwo", decision: "allow", include: [] }],
    apps: [{ id: "proef-app", name: "cf-proef-cf-proef-inlog", type: "saas" }],
    projecten: [
      {
        ref: "proefref",
        name: "cf-proef-cf-proef",
        organization_slug: "stagetwo",
        status: "ACTIVE_HEALTHY",
      },
    ],
  });
  const arg = {
    ...ARG,
    app: "richplant",
    voorvoegsel: "rp-",
    repo: "Richplant-BV/richplant-start",
  };
  const toegang = { groepen: { rp: { domeinen: ["richplant.nl"] } }, apps: { richplant: ["rp"] } };
  const d = opzet(w, { toegang });
  await richtIn(arg, d);
  await ruimOp(arg, d);
  assert.deepEqual(
    w.staat.policies.map((p) => p.id),
    ["proef-pol"],
  );
  assert.deepEqual(
    w.staat.apps.map((a) => a.id),
    ["proef-app"],
  );
  assert.deepEqual(
    w.staat.projecten.map((p) => p.ref),
    ["proefref"],
  );
});

test("opruimen verwijdert alleen de exacte namen van deze app en deze groepen", async () => {
  // Namen die met rp- beginnen maar niet uit appNamen of toegang.json volgen (zoals
  // die van een genest voorvoegsel rp-x-) blijven staan, met een waarschuwing. Ze komen
  // pas na de inrichting in de wolk, zodat alleen ruimOp ze kan raken.
  const w = nepWolk();
  const arg = {
    ...ARG,
    app: "richplant",
    voorvoegsel: "rp-",
    repo: "Richplant-BV/richplant-start",
  };
  const toegang = { groepen: { rp: { domeinen: ["richplant.nl"] } }, apps: { richplant: ["rp"] } };
  const d = opzet(w, { toegang });
  await richtIn(arg, d);
  w.staat.policies.push({ id: "genest-pol", name: "rp-x-rp", decision: "allow", include: [] });
  w.staat.apps.push({
    id: "genest-app",
    name: "rp-x-richplant",
    type: "self_hosted",
    domain: "x.nl",
  });
  w.staat.projecten.push({
    ref: "genestref",
    name: "rp-x-richplant",
    organization_slug: "stagetwo",
    status: "ACTIVE_HEALTHY",
  });
  const r = await ruimOp(arg, d);
  assert.deepEqual(
    w.staat.policies.map((p) => p.id),
    ["genest-pol"],
  );
  assert.deepEqual(
    w.staat.apps.map((a) => a.id),
    ["genest-app"],
  );
  assert.deepEqual(
    w.staat.projecten.map((p) => p.ref),
    ["genestref"],
  );
  assert.match(r.waarschuwingen.join(" "), /rp-x-richplant/);
});

test("zonder voorvoegsel in de argumenten weigert de inrichting vóór er iets gebeurt", async () => {
  const w = nepWolk();
  const { voorvoegsel: _weg, ...zonder } = ARG;
  await assert.rejects(() => richtIn(zonder, opzet(w)), /voorvoegsel/);
  await assert.rejects(() => ruimOp(zonder, opzet(w)), /voorvoegsel/);
  assert.deepEqual(w.aanroepen, []);
});

test("tweede run met alles al aanwezig maakt niets dubbel aan", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(ARG, d);
  w.aanroepen.length = 0;
  const r = await richtIn(ARG, d);
  assert.deepEqual(w.schrijfacties(), []);
  assert.equal(w.staat.projecten.length, 1);
  assert.equal(w.staat.apps.length, 2);
  assert.equal(w.staat.policies.length, 1);
  assert.equal(w.staat.providers.length, 1);
  assert.ok(
    r.stappen
      .filter((s) => s.stap !== "4 Access op de Worker")
      .every((s) => /hergebruikt|ongewijzigd/.test(s.actie)),
    JSON.stringify(r.stappen),
  );
});

test("een resource zonder voorvoegsel met dezelfde naam laat het script stoppen zonder wijziging", async () => {
  for (const wolk of [
    { policies: [{ id: "p", name: "stagetwo", decision: "allow", include: [] }] },
    { apps: [{ id: "a", name: "cf-proef-inlog", type: "saas" }] },
    {
      apps: [{ id: "a", name: "eigen deur", type: "self_hosted", domain: "cf-proef.stagetwo.nl" }],
    },
    {
      projecten: [
        { ref: "r", name: "cf-proef", organization_slug: "stagetwo", status: "ACTIVE_HEALTHY" },
      ],
    },
  ]) {
    const w = nepWolk(wolk);
    await assert.rejects(
      () => richtIn(ARG, opzet(w)),
      /gestopt zonder wijzigingen.*zonder voorvoegsel|gestopt zonder wijzigingen.*bewaakt/,
    );
    assert.deepEqual(w.schrijfacties(), [], JSON.stringify(wolk));
  }
});

test("een 4xx van Cloudflare bij de SaaS-app stopt vóór de Supabase-provider, met het endpoint", async () => {
  const w = nepWolk({
    faal: (methode, _pad, body) =>
      methode === "POST" && body?.type === "saas"
        ? { status: 400, message: "ongeldige saas_app" }
        : null,
  });
  await assert.rejects(
    () => richtIn(ARG, opzet(w)),
    /POST \/client\/v4\/accounts\/acc\/access\/apps gaf 400: ongeldige saas_app/,
  );
  assert.equal(
    w.aanroepen.some((a) => a.methode === "createProvider"),
    false,
  );
  assert.equal(
    w.aanroepen.some((a) => a.methode === "PATCH"),
    false,
  );
});

test("het databasewachtwoord is bewaard, ook als een latere stap mislukt", async () => {
  // Het wachtwoord van een nieuw project is alleen bij het aanmaken bekend. Mislukt een
  // latere stap, dan moet het al in GitHub staan, anders is het voorgoed weg.
  const w = nepWolk({
    faal: (methode, _pad, body) =>
      methode === "POST" && body?.type === "saas" ? { status: 400, message: "kapot" } : null,
  });
  await assert.rejects(() => richtIn(ARG, opzet(w)), /gaf 400/);
  assert.ok(w.staat.ghSecrets.production.includes("SUPABASE_DB_PASSWORD"));
  assert.ok(w.staat.ghSecrets.production.includes("SUPABASE_PROJECT_REF"));
});

test("SaaS-app: een lege lijst inlogmethoden is een fout, ook vóór er iets wordt aangemaakt", async () => {
  assert.throws(
    () =>
      inlogApp({
        naam: "x",
        callback: "https://r.supabase.co/auth/v1/callback",
        policyIds: ["p"],
        idps: [],
      }),
    /inlogmethoden/,
  );
  const w = nepWolk({ idps: [{ id: "g", type: "google", name: "Google" }] });
  await assert.rejects(() => richtIn(ARG, opzet(w)), /one-time PIN|inlogmethode/);
  assert.deepEqual(w.schrijfacties(), []);
  const w2 = nepWolk({ idps: [] });
  await richtIn({ ...ARG, droogloop: true }, opzet(w2, { idps: ["idp-entra"] }));
});

// ---------------------------------------------------------------- tweede doorgang

test("tweede doorgang zonder Worker: meldt 'nog niet uitgerold' en wijzigt niets", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(ARG, d);
  w.aanroepen.length = 0;
  const r = await tweedeDoorgang(ARG, d);
  assert.match(r.melding, /nog niet uitgerold/);
  assert.deepEqual(w.schrijfacties(), []);
});

test("tweede doorgang met Worker: Access op workers.dev en alle preview-adressen, zelfde policies", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(ARG, d);
  const worker = w.staat.apps.find((a) => a.name === "cf-proef-cf-proef-worker");
  const deur = w.staat.apps.find((a) => a.name === "cf-proef-cf-proef");
  assert.ok(worker, "de eerste run zet hem al als de Worker bestaat");
  assert.deepEqual(worker.destinations, [
    { type: "public", uri: "cf-proef.stagetwo-acc.workers.dev" },
    { type: "public", uri: "*-cf-proef.stagetwo-acc.workers.dev" },
  ]);
  assert.deepEqual(worker.policies, deur.policies);
  w.aanroepen.length = 0;
  const r = await tweedeDoorgang(ARG, d);
  assert.match(r.melding, /ongewijzigd/);
  assert.deepEqual(w.schrijfacties(), []);
});

// ---------------------------------------------------------------- tijdelijke stand (workers.dev)

const TIJDELIJK = { ...ARG, hostname: null, stand: "tijdelijk" };
const WORKERS_DEV = "cf-proef.stagetwo-acc.workers.dev";

test("tijdelijke stand: alleen de Access op de Worker, geen app op een hostname", async () => {
  const w = nepWolk({ workerBestaat: true });
  const r = await richtIn(TIJDELIJK, opzet(w));
  const selfHosted = w.staat.apps.filter((a) => a.type === "self_hosted");
  assert.deepEqual(
    selfHosted.map((a) => a.name),
    ["cf-proef-cf-proef-worker"],
    "geen deur op een hostname, wel Access op de Worker",
  );
  assert.deepEqual(selfHosted[0].destinations, [
    { type: "public", uri: WORKERS_DEV },
    { type: "public", uri: `*-${WORKERS_DEV}` },
  ]);
  const saas = w.staat.apps.find((a) => a.type === "saas");
  assert.deepEqual(selfHosted[0].policies, saas.policies, "zelfde policies als de inlogdienst");
  assert.equal(r.hostname, WORKERS_DEV);
  assert.equal(r.cloudflare.deur, null);
  assert.match(
    r.stappen.find((s) => s.stap === "3.5 Access-app op de hostname").actie,
    /overgeslagen: tijdelijke stand/,
  );
});

test("tijdelijke stand: site_url en redirect-lijst op het workers.dev-adres plus het previewpatroon", async () => {
  const w = nepWolk({ workerBestaat: true });
  const r = await richtIn(TIJDELIJK, opzet(w));
  const patch = w.aanroepen.find((a) => a.methode === "PATCH").body;
  assert.equal(patch.site_url, `https://${WORKERS_DEV}`);
  assert.equal(
    patch.uri_allow_list,
    `https://${WORKERS_DEV}/**,https://pr-*-cf-proef.stagetwo-acc.workers.dev/**`,
  );
  assert.deepEqual(r.uri_allow_list, patch.uri_allow_list.split(","));
});

test("tijdelijke stand: een tweede run verandert niets", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(TIJDELIJK, d);
  w.aanroepen.length = 0;
  const r = await richtIn(TIJDELIJK, d);
  assert.deepEqual(w.schrijfacties(), []);
  assert.equal(w.staat.apps.length, 2, "inlogdienst en Worker-Access, verder niets");
  assert.ok(
    r.stappen.every((s) => /hergebruikt|ongewijzigd|overgeslagen: tijdelijke stand/.test(s.actie)),
    JSON.stringify(r.stappen),
  );
});

test("tijdelijke stand zonder uitrol: eerst placeholder, dan Access, pas daarna de GitHub-variabelen", async () => {
  const w = nepWolk();
  const r = await richtIn(TIJDELIJK, opzet(w));
  const schrijf = w.schrijfacties();
  const placeholder = schrijf.indexOf("PUT cf/workers/scripts/cf-proef");
  const subdomein = schrijf.indexOf("POST cf/workers/scripts/cf-proef/subdomain");
  const access = schrijf.indexOf("POST cf/access/apps self_hosted");
  const eersteVariabele = schrijf.findIndex((s) => s.startsWith("gh variable set"));
  assert.ok(placeholder >= 0, JSON.stringify(schrijf));
  assert.ok(placeholder < subdomein, "eerst het script, dan workers.dev aan");
  assert.ok(subdomein < access, "de Access pas als de Worker er staat");
  assert.ok(access < eersteVariabele, "de Access staat er vóór GitHub de uitrol mogelijk maakt");
  const worker = w.staat.apps.find((a) => a.name === "cf-proef-cf-proef-worker");
  assert.equal(worker.domain, WORKERS_DEV);
  assert.equal(r.cloudflare.worker, worker.id);
  assert.match(r.stappen.find((s) => s.stap === "4 Access op de Worker").actie, /placeholder/);
  assert.ok(
    !r.waarschuwingen.some((x) => /tweede-doorgang/.test(x)),
    JSON.stringify(r.waarschuwingen),
  );
  const put = w.aanroepen.find((a) => a.methode === "PUT" && a.pad?.endsWith("/scripts/cf-proef"));
  assert.ok(put.body instanceof FormData, "het script gaat als multipart");
  const sub = w.aanroepen.find((a) => a.pad?.endsWith("/scripts/cf-proef/subdomain"));
  assert.deepEqual(sub.body, { enabled: true, previews_enabled: true });
});

test("tijdelijke stand, Worker bestaat al: geen placeholder", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(TIJDELIJK, opzet(w));
  assert.ok(
    !w.schrijfacties().some((s) => s.includes("workers/scripts")),
    JSON.stringify(w.schrijfacties()),
  );
  assert.ok(w.staat.apps.some((a) => a.name === "cf-proef-cf-proef-worker"));
});

test("standaardstand, Worker bestaat niet: geen placeholder, stap 4 overgeslagen", async () => {
  const w = nepWolk();
  const r = await richtIn(ARG, opzet(w));
  assert.ok(!w.schrijfacties().some((s) => s.includes("workers/scripts")));
  assert.equal(
    r.stappen.find((s) => s.stap === "4 Access op de Worker").actie,
    "overgeslagen: nog niet uitgerold",
  );
  assert.ok(!w.staat.apps.some((a) => a.name === "cf-proef-cf-proef-worker"));
});

test("tijdelijke stand zonder uitrol, droogloop: niets geschreven, placeholder en Access gepland", async () => {
  const w = nepWolk();
  const r = await richtIn({ ...TIJDELIJK, droogloop: true }, opzet(w));
  assert.deepEqual(w.schrijfacties(), []);
  assert.equal(
    r.stappen.find((s) => s.stap === "4 Access op de Worker").actie,
    "gepland: placeholder en Access op de Worker",
  );
});

test("tijdelijke stand: droogloop plant geen hostname-app en toont het workers.dev-adres", async () => {
  const w = nepWolk();
  const r = await richtIn({ ...TIJDELIJK, droogloop: true }, opzet(w));
  assert.deepEqual(w.schrijfacties(), []);
  assert.match(
    r.stappen.find((s) => s.stap === "3.5 Access-app op de hostname").actie,
    /overgeslagen: tijdelijke stand/,
  );
  assert.match(r.stappen.find((s) => s.stap === "3.4 auth-config").actie, /workers\.dev/);
});

test("tijdelijke stand: een --hostname erbij is een fout, want er is nog geen domein", async () => {
  const w = nepWolk();
  await assert.rejects(
    () => richtIn({ ...TIJDELIJK, hostname: "app.klant.nl" }, opzet(w)),
    /tijdelijke stand.*hostname/,
  );
  assert.deepEqual(w.schrijfacties(), []);
});

test("tijdelijke stand: een Access-app zonder voorvoegsel op het workers.dev-adres laat het script stoppen", async () => {
  const w = nepWolk({
    workerBestaat: true,
    apps: [{ id: "a", name: "dashboardknop", type: "self_hosted", domain: WORKERS_DEV }],
  });
  await assert.rejects(() => richtIn(TIJDELIJK, opzet(w)), /gestopt zonder wijzigingen.*bewaakt/);
  assert.deepEqual(w.schrijfacties(), []);
});

test("tijdelijke stand: tweede doorgang zet Access op een bestaande Worker zonder Access", async () => {
  // Een app van vóór de placeholder: de Worker staat er, de Access op de Worker niet.
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(TIJDELIJK, d);
  w.staat.apps = w.staat.apps.filter((a) => a.name !== "cf-proef-cf-proef-worker");
  const r = await tweedeDoorgang(TIJDELIJK, d);
  assert.equal(r.melding, "aangemaakt");
  assert.deepEqual(
    w.staat.apps.filter((a) => a.type === "self_hosted").map((a) => a.domain),
    [WORKERS_DEV],
  );
});

// ---------------------------------------------------------------- vangnet

test("--vangnet: e-mail weer aan en een hook die jan@elders.nl weigert en piet@klant.nl toelaat", async () => {
  const w = nepWolk();
  const toegang = {
    groepen: { klant: { domeinen: ["klant.nl"] } },
    apps: { "cf-proef": ["klant"] },
  };
  const d = opzet(w, { toegang });
  await richtIn(ARG, d);
  w.aanroepen.length = 0;
  const r = await vangnet(ARG, d);
  const ref = w.staat.projecten[0].ref;
  assert.equal(w.staat.sql.length, 1);
  assert.match(w.staat.sql[0], /domein = any \(array\['klant\.nl'\]::text\[\]\)/);
  assert.doesNotMatch(w.staat.sql[0], /elders/);
  const patch = w.aanroepen.find((a) => a.methode === "PATCH").body;
  assert.equal(patch.external_email_enabled, true);
  assert.equal(patch.hook_before_user_created_enabled, true);
  assert.equal(
    patch.hook_before_user_created_uri,
    "pg-functions://postgres/public/cf_proef_voor_aanmelden",
  );
  assert.equal("disable_signup" in patch, false);
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "mailcode");
  assert.equal(w.staat.ghVariabelen.repo.PREVIEW_VITE_INLOGDIENST, "mailcode");
  assert.equal(magAanmelden("jan@elders.nl", toegang, "cf-proef"), "nee", "JS-spiegel van de hook");
  assert.equal(magAanmelden("piet@klant.nl", toegang, "cf-proef"), "ja", "JS-spiegel van de hook");
  assert.equal(r.supabase.ref, ref);
});

test("--vangnet met rp-: de hookfunctie heet rp_voor_aanmelden", async () => {
  const w = nepWolk();
  const arg = { ...ARG, voorvoegsel: "rp-", repo: "Richplant-BV/richplant-start" };
  const d = opzet(w);
  await richtIn(arg, d);
  const r = await vangnet(arg, d);
  assert.equal(r.hook, "rp_voor_aanmelden");
  assert.match(w.staat.sql[0], /function public\.rp_voor_aanmelden\(event jsonb\)/);
});

test("vangnet aan: een wijziging in toegang.json werkt ook de aanmeld-hook bij", async () => {
  const w = nepWolk();
  const d = opzet(w, {
    toegang: { groepen: { klant: { domeinen: ["klant.nl"] } }, apps: { "cf-proef": ["klant"] } },
  });
  await richtIn(ARG, d);
  await vangnet(ARG, d);
  assert.equal(w.staat.sql.length, 1);
  d.toegang = {
    groepen: { klant: { domeinen: ["klant.nl", "klant.be"] } },
    apps: { "cf-proef": ["klant"] },
  };
  w.aanroepen.length = 0;
  const r = await werkToegangBij(ARG, d);
  assert.equal(w.staat.sql.length, 2, "de hook is opnieuw geschreven");
  assert.match(w.staat.sql[1], /create or replace function public\.cf_proef_voor_aanmelden/);
  assert.match(w.staat.sql[1], /array\['klant\.nl', 'klant\.be'\]/);
  assert.ok(
    r.acties.some((a) => /aanmeld-hook/.test(a)),
    JSON.stringify(r.acties),
  );
});

test("vangnet uit: toegang bijwerken schrijft geen hook", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(ARG, d);
  await werkToegangBij(ARG, d);
  assert.deepEqual(w.staat.sql, []);
});

test("vangnet aan, droogloop van toegang bijwerken: plant de hook maar schrijft niets", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(ARG, d);
  await vangnet(ARG, d);
  w.aanroepen.length = 0;
  const r = await werkToegangBij({ ...ARG, droogloop: true }, d);
  assert.deepEqual(w.schrijfacties(), []);
  assert.ok(
    r.acties.some((a) => /aanmeld-hook/.test(a)),
    JSON.stringify(r.acties),
  );
});

// ---------------------------------------------------------------- opruimen

test("--opruimen: omgekeerde volgorde, meldt wat er stond en laat alles zonder voorvoegsel staan", async () => {
  const w = nepWolk({
    workerBestaat: true,
    policies: [{ id: "eigen-pol", name: "kienia", decision: "allow", include: [] }],
    apps: [
      { id: "eigen-app", name: "kienia-portaal", type: "self_hosted", domain: "portaal.kienia.nl" },
    ],
    projecten: [
      {
        ref: "financeref",
        name: "finance",
        organization_slug: "stagetwo",
        status: "ACTIVE_HEALTHY",
      },
    ],
    ghVariabelen: { production: { ANDERE: "blijft" }, repo: { REPO_ANDERE: "blijft" } },
    // Een oud repo-secret uit de tijd vóór de omgeving production: ook weg.
    ghSecrets: { repo: ["SUPABASE_DB_PASSWORD", "ANDER_SECRET"] },
  });
  const d = opzet(w);
  await richtIn(ARG, d);
  const ref = w.staat.projecten.find((p) => p.name === "cf-proef-cf-proef").ref;
  w.aanroepen.length = 0;
  const r = await ruimOp({ ...ARG }, d);
  const schrijf = w.schrijfacties().filter((s) => !s.startsWith("gh "));
  assert.deepEqual(
    schrijf.map((s) => s.replace(/\/(app|pol)-\d+/, "/<id>")),
    [
      "DELETE cf/workers/scripts/cf-proef",
      "DELETE cf/access/apps/<id>",
      "DELETE cf/access/apps/<id>",
      "admin deleteProvider",
      "DELETE cf/access/apps/<id>",
      "DELETE cf/access/policies/<id>",
      `DELETE sb/projects/${ref}`,
    ],
  );
  const volgorde = r.verwijderd.map((v) => v.soort);
  assert.deepEqual(volgorde, [
    "Worker-script",
    "Access op de Worker",
    "GitHub",
    "Access-app op de hostname",
    "custom provider",
    "Access SaaS-app",
    "Access-policy",
    "Supabase-project",
  ]);
  assert.deepEqual(
    w.staat.policies.map((p) => p.id),
    ["eigen-pol"],
  );
  assert.deepEqual(
    w.staat.apps.map((a) => a.id),
    ["eigen-app"],
  );
  assert.deepEqual(
    w.staat.projecten.map((p) => p.ref),
    ["financeref"],
  );
  assert.deepEqual(w.staat.ghVariabelen.production, {
    ANDERE: "blijft",
    CLOUDFLARE_ACCOUNT_ID: "acc",
  });
  assert.deepEqual(w.staat.ghVariabelen.repo, { REPO_ANDERE: "blijft" });
  assert.deepEqual(w.staat.ghSecrets.production, []);
  assert.deepEqual(w.staat.ghSecrets.repo, ["ANDER_SECRET"]);
  assert.equal(w.staat.workerBestaat, false, "het Worker-script is weg");
  assert.deepEqual(
    r.verwijderd.find((v) => v.soort === "Worker-script"),
    { soort: "Worker-script", naam: "cf-proef" },
  );
});

test("--opruimen: een 404 bij het verwijderen van het Worker-script is geen fout", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(ARG, d);
  const r = await ruimOp(ARG, d);
  assert.ok(w.schrijfacties().includes("DELETE cf/workers/scripts/cf-proef"));
  assert.ok(!r.verwijderd.some((v) => v.soort === "Worker-script"));
});

test("--opruimen zonder Worker-naam uit de config raakt geen Worker-script", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(ARG, d);
  const { worker: _weg, ...zonder } = ARG;
  await ruimOp(zonder, d);
  assert.ok(!w.schrijfacties().some((s) => s.includes("workers/scripts")));
  assert.equal(w.staat.workerBestaat, true);
});

test("--opruimen droogloop: meldt het Worker-script maar verwijdert niets", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(ARG, d);
  w.aanroepen.length = 0;
  const r = await ruimOp({ ...ARG, droogloop: true }, d);
  assert.deepEqual(w.schrijfacties(), []);
  assert.ok(r.verwijderd.some((v) => v.soort === "Worker-script" && v.naam === "cf-proef"));
});

test("--opruimen zonder iets met voorvoegsel doet niets", async () => {
  const w = nepWolk({
    policies: [{ id: "eigen", name: "stagetwo", decision: "allow", include: [] }],
  });
  const r = await ruimOp(ARG, opzet(w));
  // Alleen de poging op het script met de naam uit de config; de 404 is "was er niet".
  assert.deepEqual(w.schrijfacties(), ["DELETE cf/workers/scripts/cf-proef"]);
  assert.deepEqual(r.verwijderd, []);
});

// ---------------------------------------------------------------- toegang bijwerken

test("toegang bijwerken: ongewijzigd bestand en passende gebruikers geven nul schrijfacties", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(ARG, d);
  w.staat.gebruikers.push({
    id: "11111111-1111-4111-8111-111111111111",
    email: "info@stagetwo.nl",
  });
  w.aanroepen.length = 0;
  await werkToegangBij({ ...ARG }, d);
  assert.deepEqual(w.schrijfacties(), []);
});

test("toegang bijwerken: een verwijderd adres geeft een ban en afmelden via SQL", async () => {
  const w = nepWolk();
  const d = opzet(w, {
    toegang: {
      groepen: { a: { adressen: ["info@stagetwo.nl", "oud@elders.nl"] } },
      apps: { "cf-proef": ["a"] },
    },
  });
  await richtIn(ARG, d);
  w.staat.gebruikers.push(
    { id: "11111111-1111-4111-8111-111111111111", email: "info@stagetwo.nl" },
    { id: "22222222-2222-4222-8222-222222222222", email: "oud@elders.nl" },
  );
  w.aanroepen.length = 0;
  d.toegang = {
    groepen: { a: { adressen: ["info@stagetwo.nl"] } },
    apps: { "cf-proef": ["a"] },
  };
  const r = await werkToegangBij(ARG, d);
  const schrijf = w.schrijfacties();
  assert.ok(schrijf.includes("admin updateUserById"));
  const ban = w.aanroepen.find((a) => a.methode === "updateUserById").body;
  assert.deepEqual(ban, { id: "22222222-2222-4222-8222-222222222222", ban_duration: "876000h" });
  assert.match(
    w.staat.sql.at(-1),
    /delete from auth\.sessions where user_id = '22222222-2222-4222-8222-222222222222'/,
  );
  assert.deepEqual(r.ingetrokken, { "cf-proef": ["oud@elders.nl"] });
});

test("toegang bijwerken: wie weer op de lijst komt, krijgt de ban opgeheven", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(ARG, d);
  w.staat.gebruikers.push(
    { id: "11111111-1111-4111-8111-111111111111", email: "info@stagetwo.nl" },
    {
      id: "22222222-2222-4222-8222-222222222222",
      email: "oud@elders.nl",
      banned_until: "2126-01-01T00:00:00Z",
    },
  );
  d.toegang = {
    groepen: { a: { adressen: ["info@stagetwo.nl", "oud@elders.nl"] } },
    apps: { "cf-proef": ["a"] },
  };
  w.aanroepen.length = 0;
  const r = await werkToegangBij(ARG, d);
  const updates = w.aanroepen.filter((a) => a.methode === "updateUserById").map((a) => a.body);
  assert.deepEqual(updates, [{ id: "22222222-2222-4222-8222-222222222222", ban_duration: "none" }]);
  assert.equal(w.staat.gebruikers[1].banned_until, undefined);
  assert.deepEqual(r.toegelaten, { "cf-proef": ["oud@elders.nl"] });
  assert.deepEqual(r.ingetrokken, {});
});

// ---------------------------------------------------------------- uitvoer en grenzen

test("toegang bijwerken: een mislukte policy-verwijdering houdt het intrekken niet tegen", async () => {
  const w = nepWolk();
  const d = opzet(w, {
    toegang: {
      groepen: {
        a: { adressen: ["info@stagetwo.nl"] },
        oud: { adressen: ["oud@elders.nl"] },
      },
      apps: { "cf-proef": ["a", "oud"] },
    },
  });
  await richtIn(ARG, d);
  w.staat.gebruikers.push({ id: "22222222-2222-4222-8222-222222222222", email: "oud@elders.nl" });
  d.toegang = {
    groepen: { a: { adressen: ["info@stagetwo.nl"] } },
    apps: { "cf-proef": ["a"] },
  };
  const origineel = w.fetchFn;
  d.cf = cloudflareClient({
    fetchFn: async (url, opties = {}) =>
      (opties.method ?? "GET") === "DELETE" && url.includes("/access/policies/")
        ? {
            ok: false,
            status: 400,
            statusText: "Fout",
            text: async () => '{"success":false,"errors":[{"message":"in gebruik"}]}',
          }
        : origineel(url, opties),
    token: "cf-token",
    accountId: "acc",
    teamDomein: "stagetwo",
  });
  const r = await werkToegangBij(ARG, d);
  assert.ok(
    w.aanroepen.some((a) => a.methode === "updateUserById"),
    "Jan is toch ingetrokken",
  );
  assert.match(r.waarschuwingen.join(" "), /niet verwijderd/);
});

test("uitvoer: één regel INRICHTING zonder geheimen in leesbare vorm", async () => {
  const w = nepWolk();
  const d = opzet(w);
  const r = await richtIn(ARG, d);
  const regel = uitvoerRegel({ status: "gelukt", ...r }, d.geheimen);
  assert.match(regel, /^INRICHTING \{.*\}\n$/);
  assert.equal(regel.split("\n").length, 2);
  const ref = w.staat.projecten[0].ref;
  for (const geheim of [WACHTWOORD, "geheim-cs-3", `geheim-sr-${ref}`, "cf-token", "sb-token"]) {
    assert.equal(regel.includes(geheim), false, geheim);
  }
  assert.ok(d.geheimen.includes(WACHTWOORD) && d.geheimen.includes("geheim-cs-3"));
  assert.equal(
    uitvoerRegel({ x: "a geheim-cs-3 b" }, ["geheim-cs-3"]),
    'INRICHTING {"x":"a *** b"}\n',
  );
});

test("Edge Functions en hun instellingen worden nergens aangeraakt", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w);
  await richtIn(ARG, d);
  await vangnet(ARG, d);
  await werkToegangBij(ARG, d);
  await ruimOp(ARG, d);
  assert.equal(
    w.aanroepen.some((a) => /functions/.test(a.url ?? "")),
    false,
  );
});

test("pooler: zonder session pooler van Supabase stopt de inrichting niet, maar waarschuwt", async () => {
  const w = nepWolk();
  w.staat.geenPooler = true;
  const r = await richtIn(ARG, opzet(w));
  assert.equal(w.staat.ghVariabelen.production.SUPABASE_POOLER_HOST, undefined);
  assert.ok(r.waarschuwingen.some((x) => x.includes("SUPABASE_POOLER_HOST")));
});

test("pooler: een fout bij het opvragen van de pooler stopt de inrichting niet, maar waarschuwt", async () => {
  const w = nepWolk({ poolerFout: 500 });
  const r = await richtIn(ARG, opzet(w));
  const prod = w.staat.ghVariabelen.production;
  assert.equal(prod.SUPABASE_POOLER_HOST, undefined);
  assert.ok(prod.VITE_SUPABASE_URL, "de andere variabelen staan er wel");
  assert.equal(prod.VITE_INLOGDIENST, "cloudflare");
  const w500 = r.waarschuwingen.find((x) => x.includes("pooler"));
  assert.match(w500 ?? "", /gaf 500/);
  assert.match(w500, /SUPABASE_POOLER_HOST/);
  assert.ok(
    r.stappen.some((s) => s.stap.startsWith("4")),
    "stap 4 loopt ook",
  );
});

// ---------------------------------------------------------------- Sentry

test("Sentry: met VITE_SENTRY_DSN in de beheeromgeving komt de DSN in beide omgevingen en als PREVIEW_", async () => {
  const w = nepWolk();
  const dsn = "https://abc123@o1.ingest.de.sentry.io/42";
  await richtIn(ARG, opzet(w, { sentryDsn: dsn }));
  for (const env of ["production", "preview"]) {
    assert.equal(w.staat.ghVariabelen[env].VITE_SENTRY_DSN, dsn);
  }
  assert.equal(w.staat.ghVariabelen.repo.PREVIEW_VITE_SENTRY_DSN, dsn);
});

test("Sentry: zonder (of met een lege) VITE_SENTRY_DSN zet de inrichting niets voor Sentry", async () => {
  for (const sentryDsn of [undefined, ""]) {
    const w = nepWolk();
    await richtIn(ARG, opzet(w, { sentryDsn }));
    for (const env of ["production", "preview"]) {
      assert.equal(w.staat.ghVariabelen[env].VITE_SENTRY_DSN, undefined);
    }
    assert.equal(w.staat.ghVariabelen.repo.PREVIEW_VITE_SENTRY_DSN, undefined);
    const namen = w.aanroepen.filter((a) => a.soort === "gh").map((a) => a.args.join(" "));
    assert.ok(
      namen.every((n) => !n.includes("SENTRY")),
      "geen gh-aanroep over Sentry",
    );
  }
});

test("Sentry: opruimen haalt VITE_SENTRY_DSN en PREVIEW_VITE_SENTRY_DSN weg", async () => {
  const w = nepWolk({ workerBestaat: true });
  const d = opzet(w, { sentryDsn: "https://abc123@o1.ingest.sentry.io/42" });
  await richtIn(ARG, d);
  const r = await ruimOp({ ...ARG }, d);
  for (const env of ["production", "preview"]) {
    assert.equal(w.staat.ghVariabelen[env].VITE_SENTRY_DSN, undefined);
  }
  assert.equal(w.staat.ghVariabelen.repo.PREVIEW_VITE_SENTRY_DSN, undefined);
  const github = r.verwijderd.find((v) => v.soort === "GitHub");
  assert.match(JSON.stringify(github), /production\/VITE_SENTRY_DSN/);
  assert.match(JSON.stringify(github), /repo\/PREVIEW_VITE_SENTRY_DSN/);
});

test("wachtOpDiscovery: wacht tot Cloudflare de nieuwe OIDC-app serveert", async () => {
  const gevraagd = [];
  let keer = 0;
  const fetchFn = async (url) => {
    gevraagd.push(url);
    keer += 1;
    return { ok: keer >= 3, status: keer >= 3 ? 200 : 404 };
  };
  const pogingen = await wachtOpDiscovery(
    "https://t.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc",
    {
      fetchFn,
      slaap: async () => {},
    },
  );
  assert.equal(pogingen, 3);
  assert.equal(
    gevraagd[0],
    "https://t.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc/.well-known/openid-configuration",
  );
});

test("wachtOpDiscovery: geeft na het maximum een duidelijke fout", async () => {
  const fetchFn = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    wachtOpDiscovery("https://t/x", { fetchFn, slaap: async () => {}, pogingen: 4 }),
    /na 4 pogingen.*404/,
  );
});

test("inrichten wacht op de discovery vóór de provider in Supabase", async () => {
  const w = nepWolk();
  const volgorde = [];
  const d = opzet(w);
  d.wachtOpDiscovery = async (issuer) => {
    volgorde.push(`wacht:${issuer.includes("/cdn-cgi/access/sso/oidc/")}`);
  };
  const r = await richtIn(ARG, d);
  assert.deepEqual(volgorde, ["wacht:true"]);
  assert.ok(r.stappen.some((s) => s.stap.startsWith("3.3")));
});

// ---------------------------------------------------------------- vraag en de placeholder

test("vraag: een FormData-body gaat ongewijzigd mee, zonder JSON Content-Type", async () => {
  const gezien = [];
  const fetchFn = async (_url, opties) => {
    gezien.push(opties);
    return { ok: true, status: 200, statusText: "OK", text: async () => '{"result":1}' };
  };
  const form = new FormData();
  form.append("a", "b");
  const r = await vraag(fetchFn, "https://x.test/pad", { methode: "PUT", token: "t", body: form });
  assert.deepEqual(r, { result: 1 });
  assert.equal(gezien[0].body, form, "dezelfde FormData, niet geserialiseerd");
  assert.equal(gezien[0].headers.Authorization, "Bearer t");
  assert.ok(
    !Object.keys(gezien[0].headers).some((k) => k.toLowerCase() === "content-type"),
    "fetch zet zelf multipart met boundary",
  );
  await vraag(fetchFn, "https://x.test/pad", { methode: "POST", token: "t", body: { a: 1 } });
  assert.equal(gezien[1].headers["Content-Type"], "application/json");
  assert.equal(gezien[1].body, '{"a":1}');
});

test("vraag: een fout met een FormData-body noemt methode, pad en status zoals altijd", async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: async () => JSON.stringify({ errors: [{ message: "kapot" }] }),
  });
  await assert.rejects(
    () => vraag(fetchFn, "https://x.test/een/pad?x=1", { methode: "PUT", body: new FormData() }),
    (fout) => fout.message === "PUT /een/pad gaf 400: kapot" && fout.status === 400,
  );
});

test("maakPlaceholder: module die 503 geeft, daarna workers.dev en previews aan", async () => {
  const w = nepWolk();
  const cf = cloudflareClient({ fetchFn: w.fetchFn, token: "t", accountId: "acc" });
  await cf.maakPlaceholder("rp-app");
  assert.deepEqual(w.schrijfacties(), [
    "PUT cf/workers/scripts/rp-app",
    "POST cf/workers/scripts/rp-app/subdomain",
  ]);
  const form = w.aanroepen[0].body;
  assert.deepEqual(JSON.parse(await form.get("metadata").text()), {
    main_module: "placeholder.mjs",
    compatibility_date: "2026-09-01",
  });
  const module = form.get("placeholder.mjs");
  assert.equal(module.type, "application/javascript+module");
  assert.equal(module.name, "placeholder.mjs");
  const bron = await module.text();
  const { default: worker } = await import(`data:text/javascript,${encodeURIComponent(bron)}`);
  const antwoord = await worker.fetch(new Request("https://x.test/"));
  assert.equal(antwoord.status, 503);
  assert.equal(await antwoord.text(), "Deze app wordt ingericht.");
  assert.equal(await cf.workerBestaat("rp-app"), true);
});

test("verwijderWorker: true als hij er was, false bij 404, andere fouten gaan door", async () => {
  const w = nepWolk({ workerBestaat: true });
  const cf = cloudflareClient({ fetchFn: w.fetchFn, token: "t", accountId: "acc" });
  assert.equal(await cf.verwijderWorker("rp-app"), true);
  assert.equal(await cf.verwijderWorker("rp-app"), false);
  const kapot = nepWolk({
    workerBestaat: true,
    faal: (methode) => (methode === "DELETE" ? { status: 500, message: "stuk" } : null),
  });
  const cf2 = cloudflareClient({ fetchFn: kapot.fetchFn, token: "t", accountId: "acc" });
  await assert.rejects(() => cf2.verwijderWorker("rp-app"), /DELETE .* gaf 500/);
});

// ---------------------------------------------------------------- testdatabase

const TEST_ARG = { ...ARG, testdatabase: true };

test("testdatabase: eigen project en eigen SaaS-app, de previews wijzen erheen", async () => {
  const w = nepWolk();
  const r = await richtIn(TEST_ARG, opzet(w));
  const [prod, testProj] = w.staat.projecten;
  assert.equal(prod.name, "cf-proef-cf-proef");
  assert.equal(testProj.name, "cf-proef-cf-proef-test");
  const testInlog = w.staat.apps.find((a) => a.name === "cf-proef-cf-proef-test-inlog");
  assert.ok(testInlog, "eigen SaaS-app voor de testdatabase");
  assert.deepEqual(testInlog.saas_app.redirect_uris, [
    `https://${testProj.ref}.supabase.co/auth/v1/callback`,
  ]);
  const prodInlog = w.staat.apps.find((a) => a.name === "cf-proef-cf-proef-inlog");
  assert.deepEqual(
    testInlog.policies.map((p) => p.id ?? p),
    prodInlog.policies.map((p) => p.id ?? p),
    "zelfde policies, dus zelfde mensen",
  );
  // Productie blijft op productie, de PR-previews gaan naar de testdatabase.
  for (const env of ["production", "preview"]) {
    assert.equal(w.staat.ghVariabelen[env].VITE_SUPABASE_URL, `https://${prod.ref}.supabase.co`);
  }
  assert.equal(
    w.staat.ghVariabelen.repo.PREVIEW_VITE_SUPABASE_URL,
    `https://${testProj.ref}.supabase.co`,
  );
  assert.equal(w.staat.ghVariabelen.repo.PREVIEW_VITE_SUPABASE_ANON_KEY, `anon-${testProj.ref}`);
  // De testdatabase staat op een andere pooler; de canary in deploy-db.yml krijgt die.
  assert.equal(
    w.staat.ghVariabelen.production.SUPABASE_POOLER_HOST,
    "aws-0-eu-central-1.pooler.supabase.com",
  );
  assert.equal(
    w.staat.ghVariabelen.production.SUPABASE_TEST_POOLER_HOST,
    "aws-1-eu-central-1.pooler.supabase.com",
  );
  assert.deepEqual(w.staat.ghSecrets.production.sort(), [
    "SUPABASE_DB_PASSWORD",
    "SUPABASE_PROJECT_REF",
    "SUPABASE_TEST_DB_PASSWORD",
  ]);
  // In stack.config.json (git) de publishable key: de anon-JWT valt over guard:secrets.
  assert.deepEqual(r.testdatabase, {
    project_ref: testProj.ref,
    anon_key: `sb_publishable_${testProj.ref}`,
  });
  const provider = w.aanroepen.find(
    (a) => a.soort === "admin" && /Provider$/.test(a.methode) && a.url.includes(testProj.ref),
  );
  assert.ok(provider, "provider ook in de testdatabase");
  assert.ok(w.staat.auth[testProj.ref], "auth-config ook in de testdatabase");
});

test("testdatabase: een tweede run maakt niets dubbel aan", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(TEST_ARG, d);
  const projecten = w.staat.projecten.length;
  const apps = w.staat.apps.length;
  const r = await richtIn(TEST_ARG, d);
  assert.equal(w.staat.projecten.length, projecten);
  assert.equal(w.staat.apps.length, apps);
  assert.equal(r.waarschuwingen.filter((x) => /TEST_DB/.test(x)).length, 0);
  assert.ok(
    r.stappen
      .filter((s) => s.stap.startsWith("T "))
      .every((s) => /hergebruikt|ongewijzigd/.test(s.actie)),
    JSON.stringify(r.stappen),
  );
});

test("testdatabase: bestaand testproject zonder wachtwoord-secret krijgt een nieuw wachtwoord, productie niet", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(TEST_ARG, d);
  const testProj = w.staat.projecten.find((p) => p.name.endsWith("-test"));
  w.staat.ghSecrets.production = w.staat.ghSecrets.production.filter(
    (n) => n !== "SUPABASE_TEST_DB_PASSWORD",
  );
  w.aanroepen.length = 0;
  const r = await richtIn(TEST_ARG, d);
  const resets = w.aanroepen.filter(
    (a) => a.methode === "PATCH" && a.pad?.endsWith("/database/password"),
  );
  assert.equal(resets.length, 1, "alleen de testdatabase");
  assert.ok(resets[0].pad.includes(testProj.ref));
  assert.deepEqual(resets[0].body, { password: WACHTWOORD });
  assert.ok(w.staat.ghSecrets.production.includes("SUPABASE_TEST_DB_PASSWORD"));
  assert.ok(d.geheimen.includes(WACHTWOORD), "het nieuwe wachtwoord is gemaskeerd");
  assert.equal(r.waarschuwingen.filter((x) => /TEST_DB/.test(x)).length, 0);
  assert.match(r.stappen.find((s) => s.stap === "T testdatabase: wachtwoord").actie, /nieuw gezet/);
});

test("testdatabase: staat het wachtwoord-secret er, dan blijft het wachtwoord ongemoeid", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(TEST_ARG, d);
  w.aanroepen.length = 0;
  await richtIn(TEST_ARG, d);
  assert.ok(!w.aanroepen.some((a) => a.pad?.endsWith("/database/password")));
});

test("gewijzigde inlogmethoden: een volgende run zet allowed_idps en auto_redirect op elke Access-app gelijk, policies blijven", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(TEST_ARG, opzet(w));
  const voor = Object.fromEntries(w.staat.apps.map((a) => [a.name, a.policies]));
  assert.ok(w.staat.apps.every((a) => a.auto_redirect_to_identity === true));

  const r = await richtIn(TEST_ARG, opzet(w, { idps: ["idp-otp", "idp-entra"] }));
  assert.ok(w.staat.apps.length >= 3, JSON.stringify(w.staat.apps.map((a) => a.name)));
  for (const app of w.staat.apps) {
    assert.deepEqual(app.allowed_idps, ["idp-otp", "idp-entra"], app.name);
    assert.equal(app.auto_redirect_to_identity, false, app.name);
    assert.deepEqual(app.policies, voor[app.name], `${app.name}: policies ongewijzigd`);
    if (app.saas_app) assert.ok(app.saas_app.client_id, `${app.name}: client_id blijft`);
  }
  assert.ok(
    r.stappen.some((s) => /inlogmethoden bijgewerkt/.test(s.actie)),
    JSON.stringify(r.stappen),
  );

  await richtIn(TEST_ARG, opzet(w, { idps: ["idp-entra"] }));
  for (const app of w.staat.apps) {
    assert.deepEqual(app.allowed_idps, ["idp-entra"], app.name);
    assert.equal(app.auto_redirect_to_identity, true, app.name);
  }

  // Zelfde lijst in een andere volgorde: niets te doen.
  await richtIn(TEST_ARG, opzet(w, { idps: ["idp-otp", "idp-entra"] }));
  w.aanroepen.length = 0;
  await richtIn(TEST_ARG, opzet(w, { idps: ["idp-entra", "idp-otp"] }));
  assert.ok(!w.aanroepen.some((a) => a.methode === "PUT" && /\/access\/apps\//.test(a.pad ?? "")));
});

test("testdatabase: droogloop plant hem en schrijft niets", async () => {
  const w = nepWolk();
  const r = await richtIn({ ...TEST_ARG, droogloop: true }, opzet(w));
  assert.deepEqual(w.schrijfacties(), []);
  assert.match(r.stappen.find((s) => s.stap === "T testdatabase").actie, /cf-proef-cf-proef-test/);
});

test("testdatabase: zonder --testdatabase blijft alles op één project", async () => {
  const w = nepWolk();
  const r = await richtIn(ARG, opzet(w));
  assert.equal(w.staat.projecten.length, 1);
  assert.equal(r.testdatabase, undefined);
});

test("testdatabase: een app <naam>-test in toegang.json laat het script stoppen", async () => {
  const w = nepWolk();
  const toegang = { ...TOEGANG, apps: { ...TOEGANG.apps, "cf-proef-test": ["stagetwo"] } };
  await assert.rejects(() => richtIn(TEST_ARG, opzet(w, { toegang })), /cf-proef-test/);
  assert.deepEqual(w.schrijfacties(), []);
});

test("testdatabase: opruimen haalt het testproject, de test-SaaS-app en het secret weg", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(TEST_ARG, d);
  const r = await ruimOp(ARG, d);
  assert.deepEqual(w.staat.projecten, []);
  assert.ok(!w.staat.apps.some((a) => a.name.endsWith("-test-inlog")));
  assert.ok(!(w.staat.ghSecrets.production ?? []).includes("SUPABASE_TEST_DB_PASSWORD"));
  assert.ok(r.verwijderd.some((x) => x.naam.startsWith("cf-proef-cf-proef-test")));
});

test("testdatabase: toegang bijwerken trekt ook in de testdatabase in", async () => {
  const w = nepWolk({
    gebruikers: [{ id: "22222222-2222-4222-8222-222222222222", email: "oud@elders.nl" }],
  });
  const d = opzet(w);
  await richtIn(TEST_ARG, d);
  w.aanroepen.length = 0;
  const r = await werkToegangBij({ voorvoegsel: "cf-proef-" }, d);
  assert.deepEqual(r.ingetrokken["cf-proef"], ["oud@elders.nl"]);
  // De nep-wolk deelt de gebruikers tussen projecten; daarom hier alleen: de
  // testdatabase wordt ook nagelopen.
  const testRef = w.staat.projecten[1].ref;
  assert.ok(
    w.aanroepen.some((a) => a.methode === "listUsers" && a.url.includes(testRef)),
    "gebruikers van de testdatabase nagelopen",
  );
});

// ---------------------------------------------------------------- meer dan één Supabase-organisatie

function nepFetchOrgs(projecten, verzoeken = []) {
  return async (url, init = {}) => {
    verzoeken.push({
      url,
      methode: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : null,
    });
    const data = init.method === "POST" ? { ref: "nieuw" } : projecten;
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const PROJECTEN_ORGS = [
  { name: "wc-overzicht", organization_slug: "winco", status: "ACTIVE_HEALTHY" },
  { name: "wc-plantas", organization_slug: "plantas", status: "ACTIVE_HEALTHY" },
  { name: "vreemd", organization_slug: "ander", status: "ACTIVE_HEALTHY" },
  { name: "wc-weg", organization_slug: "winco", status: "REMOVED" },
];

test("organisaties: één of meer, met komma's en spaties", () => {
  assert.deepEqual(organisaties("winco"), ["winco"]);
  assert.deepEqual(organisaties(" winco , plantas "), ["winco", "plantas"]);
  assert.deepEqual(organisaties(""), []);
  assert.deepEqual(organisaties(undefined), []);
});

test("projecten: alleen uit de genoemde organisaties", async () => {
  const een = supabaseBeheer({
    token: "t",
    orgSlug: "winco",
    fetchFn: nepFetchOrgs(PROJECTEN_ORGS),
  });
  assert.deepEqual(
    (await een.projecten()).map((p) => p.name),
    ["wc-overzicht"],
  );
  const twee = supabaseBeheer({
    token: "t",
    orgSlug: "winco,plantas",
    fetchFn: nepFetchOrgs(PROJECTEN_ORGS),
  });
  assert.deepEqual(
    (await twee.projecten()).map((p) => p.name),
    ["wc-overzicht", "wc-plantas"],
  );
});

test("maakProject: een nieuw project komt in de eerste organisatie", async () => {
  const verzoeken = [];
  const b = supabaseBeheer({
    token: "t",
    orgSlug: "winco,plantas",
    fetchFn: nepFetchOrgs(PROJECTEN_ORGS, verzoeken),
  });
  await b.maakProject("wc-nieuw", "geheim");
  assert.equal(verzoeken.at(-1).body.organization_slug, "winco");
});
