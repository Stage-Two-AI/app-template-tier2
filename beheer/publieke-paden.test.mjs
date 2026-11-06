/**
 * Publieke paden (`publiek` in toegang.json): een pagina zonder inlog, bijvoorbeeld
 * een link die je naar een klant stuurt. De inrichting zet daarvoor een eigen Access-app
 * met een bypass-policy op die paden plus de gebouwde bestanden, en haalt hem weg bij een
 * lege lijst. Alles tegen de nagebootste API (nep-wolk.mjs).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { richtIn, ruimOp, werkToegangBij } from "./inrichten-cloudflare.mjs";
import { cloudflareClient, PUBLIEK_VAST } from "./lib/cloudflare.mjs";
import { supabaseBeheer } from "./lib/supabase.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const GROEPEN = { stagetwo: { adressen: ["info@stagetwo.nl"] } };
const MET_PADEN = {
  groepen: GROEPEN,
  apps: { "cf-proef": { groepen: ["stagetwo"], publiek: ["/bekijk/*"] } },
};
const ZONDER = { groepen: GROEPEN, apps: { "cf-proef": ["stagetwo"] } };
const ARG = {
  app: "cf-proef",
  hostname: "cf-proef.stagetwo.nl",
  worker: "cf-proef",
  repo: "Stage-Two-AI/app-template-tier2",
  voorvoegsel: "cf-proef-",
  droogloop: false,
};
const PUBLIEK = "cf-proef-cf-proef-publiek";

function opzet(w, toegang) {
  return {
    cf: cloudflareClient({
      fetchFn: w.fetchFn,
      token: "t",
      accountId: "acc",
      teamDomein: "stagetwo",
    }),
    supabase: supabaseBeheer({
      fetchFn: w.fetchFn,
      token: "s",
      orgSlug: "stagetwo",
      slaap: async () => {},
    }),
    maakAdmin: w.maakAdmin,
    gh: w.gh,
    wachtOpDiscovery: async () => {},
    toegang,
    accountId: "acc",
    wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
    maskeer: () => {},
  };
}

const app = (w, naam) => w.staat.apps.find((a) => a.name === naam);
const uris = (a) => a.destinations.map((x) => x.uri);

test("inrichten: de publieke paden krijgen een eigen Access-app met de bypass-policy, plus de gebouwde bestanden", async () => {
  const w = nepWolk();
  const r = await richtIn(ARG, opzet(w, MET_PADEN));
  const policy = w.staat.policies.find((p) => p.name === "cf-proef-publiek");
  assert.deepEqual(
    { decision: policy.decision, include: policy.include },
    { decision: "bypass", include: [{ everyone: {} }] },
  );
  const open = app(w, PUBLIEK);
  assert.equal(open.type, "self_hosted");
  assert.deepEqual(uris(open), [
    "cf-proef.stagetwo.nl/bekijk/*",
    ...PUBLIEK_VAST.map((p) => `cf-proef.stagetwo.nl${p}`),
  ]);
  assert.ok(
    uris(open).includes("cf-proef.stagetwo.nl/assets/*"),
    "zonder JS en CSS een lege pagina",
  );
  assert.ok(uris(open).includes("cf-proef.stagetwo.nl/manifest.webmanifest"));
  assert.deepEqual(open.policies, [{ id: policy.id, precedence: 1 }]);
  // De deur op de hele hostname blijft dicht, met alleen de policy van de groep.
  const deur = app(w, "cf-proef-cf-proef");
  assert.equal(deur.domain, "cf-proef.stagetwo.nl");
  assert.ok(!deur.policies.some((p) => p.id === policy.id), "de deur krijgt nooit de bypass");
  for (const naam of ["cf-proef-cf-proef-inlog", "cf-proef-cf-proef-worker"]) {
    assert.ok(!app(w, naam).policies.some((p) => p.id === policy.id), `${naam} zonder bypass`);
  }
  assert.match(
    r.stappen.find((s) => s.stap === "3.5b publieke paden").actie,
    /aangemaakt.*\/bekijk\/\*/,
  );
  // Een tweede run schrijft niets.
  w.aanroepen.length = 0;
  const r2 = await richtIn(ARG, opzet(w, MET_PADEN));
  assert.deepEqual(w.schrijfacties(), []);
  assert.match(r2.stappen.find((s) => s.stap === "3.5b publieke paden").actie, /ongewijzigd/);
});

test("inrichten zonder publieke paden: geen bypass-policy en geen extra Access-app", async () => {
  const w = nepWolk();
  const r = await richtIn(ARG, opzet(w, ZONDER));
  assert.ok(!w.staat.policies.some((p) => p.decision === "bypass"));
  assert.equal(app(w, PUBLIEK), undefined);
  assert.ok(!r.stappen.some((s) => s.stap === "3.5b publieke paden"));
});

test("inrichten, droogloop: plant de publieke paden en schrijft niets", async () => {
  const w = nepWolk();
  const r = await richtIn({ ...ARG, droogloop: true }, opzet(w, MET_PADEN));
  assert.deepEqual(w.schrijfacties(), []);
  const s = r.stappen.find((x) => x.stap === "3.5b publieke paden");
  assert.match(s.actie, /gepland: policy cf-proef-publiek/);
  assert.match(
    s.actie,
    /gepland: cf-proef-cf-proef-publiek op cf-proef\.stagetwo\.nl.*\/bekijk\/\*/,
  );
});

test("inrichten in de tijdelijke stand: de publieke paden op het workers.dev-adres", async () => {
  const w = nepWolk({ subdomein: "stagetwo-acc" });
  await richtIn({ ...ARG, hostname: null, stand: "tijdelijk" }, opzet(w, MET_PADEN));
  assert.equal(uris(app(w, PUBLIEK))[0], "cf-proef.stagetwo-acc.workers.dev/bekijk/*");
});

test("toegang bijwerken: paden erbij, anders en weer weg volgen het bestand; de policy gaat mee weg", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, ZONDER));
  // erbij
  let r = await werkToegangBij({ voorvoegsel: "cf-proef-" }, opzet(w, MET_PADEN));
  assert.deepEqual(uris(app(w, PUBLIEK)).slice(0, 1), ["cf-proef.stagetwo.nl/bekijk/*"]);
  assert.ok(
    r.acties.some((a) => /cf-proef-cf-proef-publiek aangemaakt/.test(a)),
    JSON.stringify(r.acties),
  );
  // anders
  const anders = {
    groepen: GROEPEN,
    apps: { "cf-proef": { groepen: ["stagetwo"], publiek: ["/bekijk/*", "/aanmelden"] } },
  };
  r = await werkToegangBij({ voorvoegsel: "cf-proef-" }, opzet(w, anders));
  assert.ok(uris(app(w, PUBLIEK)).includes("cf-proef.stagetwo.nl/aanmelden"));
  assert.ok(r.acties.some((a) => /publiek bijgewerkt/.test(a)));
  // ongewijzigd: geen schrijfacties op Cloudflare
  w.aanroepen.length = 0;
  await werkToegangBij({ voorvoegsel: "cf-proef-" }, opzet(w, anders));
  assert.deepEqual(
    w.schrijfacties().filter((s) => s.includes("cf/")),
    [],
  );
  // weer weg: de app en (omdat geen app hem nog gebruikt) de policy
  r = await werkToegangBij({ voorvoegsel: "cf-proef-" }, opzet(w, ZONDER));
  assert.equal(app(w, PUBLIEK), undefined);
  assert.ok(!w.staat.policies.some((p) => p.name === "cf-proef-publiek"));
  assert.ok(
    r.acties.some((a) => /weggehaald \(geen publieke paden meer\)/.test(a)),
    JSON.stringify(r.acties),
  );
  // en de deur bleef al die tijd staan
  assert.ok(app(w, "cf-proef-cf-proef"));
});

test("toegang bijwerken, droogloop: plant de publieke paden en schrijft niets", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, ZONDER));
  w.aanroepen.length = 0;
  const r = await werkToegangBij(
    { voorvoegsel: "cf-proef-", droogloop: true },
    opzet(w, MET_PADEN),
  );
  assert.deepEqual(w.schrijfacties(), []);
  assert.ok(
    r.acties.some((a) => /gepland: cf-proef-cf-proef-publiek/.test(a)),
    JSON.stringify(r.acties),
  );
});

test("toegang bijwerken: een app die nog niet is ingericht krijgt geen publieke app, wel een regel", async () => {
  const w = nepWolk();
  const r = await werkToegangBij({ voorvoegsel: "cf-proef-" }, opzet(w, MET_PADEN));
  assert.equal(app(w, PUBLIEK), undefined);
  assert.ok(r.acties.some((a) => /wachten op App inrichten/.test(a)));
});

test("de bypass-policy telt nooit als overbodige groepspolicy", async () => {
  const w = nepWolk();
  await richtIn(ARG, opzet(w, MET_PADEN));
  await werkToegangBij({ voorvoegsel: "cf-proef-" }, opzet(w, MET_PADEN));
  assert.ok(w.staat.policies.some((p) => p.name === "cf-proef-publiek"));
  assert.ok(app(w, PUBLIEK));
});

test("een Access-app zonder voorvoegsel op een publiek pad (een omweg met de hand) laat het script stoppen", async () => {
  const w = nepWolk({
    apps: [
      {
        id: "hand",
        name: "direct bekijken",
        type: "self_hosted",
        domain: "cf-proef.stagetwo.nl/bekijk/*",
        destinations: [{ type: "public", uri: "cf-proef.stagetwo.nl/bekijk/*" }],
      },
    ],
  });
  await assert.rejects(
    () => richtIn(ARG, opzet(w, MET_PADEN)),
    /"direct bekijken" \(zonder voorvoegsel\) staat al op cf-proef\.stagetwo\.nl\/bekijk\/\*/,
  );
  assert.deepEqual(w.schrijfacties(), []);
});

test("opruimen: de publieke app en de policy gaan mee, behalve als een andere app nog publieke paden heeft", async () => {
  const twee = {
    groepen: GROEPEN,
    apps: {
      "cf-proef": { groepen: ["stagetwo"], publiek: ["/bekijk/*"] },
      ander: { groepen: ["stagetwo"], publiek: ["/x/*"] },
    },
  };
  const w = nepWolk();
  await richtIn(ARG, opzet(w, twee));
  const r = await ruimOp({ ...ARG, opruimen: true }, opzet(w, twee));
  assert.equal(app(w, PUBLIEK), undefined);
  assert.ok(
    w.staat.policies.some((p) => p.name === "cf-proef-publiek"),
    "ander gebruikt hem nog",
  );
  assert.ok(
    r.waarschuwingen.some((x) => /cf-proef-publiek blijft staan \(gebruikt door ander\)/.test(x)),
  );

  const w2 = nepWolk();
  await richtIn(ARG, opzet(w2, MET_PADEN));
  const r2 = await ruimOp({ ...ARG, opruimen: true }, opzet(w2, MET_PADEN));
  assert.equal(w2.staat.apps.length, 0, JSON.stringify(w2.staat.apps.map((a) => a.name)));
  assert.equal(w2.staat.policies.length, 0);
  assert.ok(r2.verwijderd.some((x) => x.naam === PUBLIEK));
  assert.ok(
    r2.verwijderd.some((x) => x.soort === "Access-policy" && x.naam === "cf-proef-publiek"),
  );
});
