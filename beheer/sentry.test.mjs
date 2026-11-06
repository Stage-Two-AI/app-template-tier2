/**
 * Foutbewaking per app (lib/sentry.mjs en stap S van de inrichting), tegen een nagebootste
 * Sentry in nep-wolk.mjs. Er gaat nooit iets naar het echte Sentry.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { richtIn, SENTRY_NIET_GEKOPPELD } from "./inrichten-cloudflare.mjs";
import { cloudflareClient } from "./lib/cloudflare.mjs";
import { koppelSentry, leesDsn, sentryClient, sentryUitOmgeving } from "./lib/sentry.mjs";
import { supabaseBeheer } from "./lib/supabase.mjs";
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

function sentry(w, extra = {}) {
  return sentryClient({ fetchFn: w.fetchFn, token: "sntrys_nep", org: "klant", ...extra });
}

function opzet(w, extra = {}) {
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
    toegang: TOEGANG,
    accountId: "acc",
    wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
    maskeer: () => {},
    slaap: async () => {},
    sentry: sentry(w),
    ...extra,
  };
}

const DSN = "https://abc100@o1.ingest.de.sentry.io/100";

test("Sentry: met een sleutel krijgt de app een eigen project, de DSN in production, preview en als PREVIEW_, en een proefmelding die aankomt", async () => {
  const w = nepWolk();
  const r = await richtIn(ARG, opzet(w));
  const p = w.staat.sentry.projecten[0];
  assert.deepEqual(
    { slug: p.slug, team: p.team, platform: p.platform },
    {
      slug: "cf-proef",
      team: "klant",
      platform: "javascript-react",
    },
  );
  for (const env of ["production", "preview"])
    assert.equal(w.staat.ghVariabelen[env].VITE_SENTRY_DSN, DSN);
  assert.equal(w.staat.ghVariabelen.repo.PREVIEW_VITE_SENTRY_DSN, DSN);
  assert.equal(w.staat.sentry.ontvangen.length, 1, "precies één proefmelding");
  const s = r.stappen.find((x) => x.stap === "S foutmeldingen (Sentry)");
  assert.match(s.actie, /project cf-proef aangemaakt in klant, DSN gezet; proefmelding aangekomen/);
  assert.deepEqual(
    r.waarschuwingen.filter((x) => /Sentry/.test(x)),
    [],
  );
  // De proefmelding gaat met alleen de openbare sleutel naar de DSN, niet met de API-sleutel.
  const envelope = w.aanroepen.find((a) => a.pad === "o1.ingest.de.sentry.io/api/100/envelope/");
  assert.match(envelope.headers["X-Sentry-Auth"], /sentry_key=abc100/);
  assert.equal(envelope.headers.Authorization, undefined);
});

test("Sentry: een tweede run maakt geen tweede project en stuurt geen tweede proefmelding", async () => {
  const w = nepWolk();
  const d = opzet(w);
  await richtIn(ARG, d);
  const r = await richtIn(ARG, d);
  assert.equal(w.staat.sentry.projecten.length, 1);
  assert.equal(w.staat.sentry.ontvangen.length, 1);
  assert.match(
    r.stappen.find((x) => x.stap === "S foutmeldingen (Sentry)").actie,
    /staat aan \(project cf-proef in klant\)/,
  );
});

test("Sentry: een bestaand project met de naam van de app wordt hergebruikt", async () => {
  const w = nepWolk({ sentry: { projecten: [{ slug: "cf-proef", id: "7" }] } });
  const r = await richtIn(ARG, opzet(w));
  assert.equal(w.staat.sentry.projecten.length, 1);
  assert.equal(
    w.staat.ghVariabelen.production.VITE_SENTRY_DSN,
    "https://abc7@o1.ingest.de.sentry.io/7",
  );
  assert.match(
    r.stappen.find((x) => x.stap === "S foutmeldingen (Sentry)").actie,
    /project cf-proef gevonden/,
  );
});

test("Sentry: een DSN die er al staat (met de hand) blijft staan; geen project, geen proefmelding", async () => {
  const hand = "https://def456@o9.ingest.sentry.io/9";
  const w = nepWolk({ ghVariabelen: { production: { VITE_SENTRY_DSN: hand } } });
  const r = await richtIn(ARG, opzet(w));
  assert.equal(w.staat.ghVariabelen.production.VITE_SENTRY_DSN, hand);
  assert.equal(w.staat.sentry.projecten.length, 0);
  assert.equal(w.staat.sentry.ontvangen.length, 0);
  assert.match(
    r.stappen.find((x) => x.stap === "S foutmeldingen (Sentry)").actie,
    /DSN die er al stond; ongewijzigd/,
  );
});

test("Sentry: komt de proefmelding niet aan, dan een waarschuwing, en de inrichting gaat door", async () => {
  const w = nepWolk({ sentry: { aankomst: false } });
  let geslapen = 0;
  const r = await richtIn(
    ARG,
    opzet(w, {
      slaap: async () => {
        geslapen += 1;
      },
      sentryPogingen: 3,
    }),
  );
  assert.equal(geslapen, 2, "drie keer kijken, twee keer wachten");
  assert.equal(w.staat.ghVariabelen.production.VITE_SENTRY_DSN, DSN, "de DSN staat er wel");
  assert.ok(
    r.waarschuwingen.some((x) =>
      /proefmelding naar Sentry-project cf-proef.*niet aangekomen/.test(x),
    ),
  );
  assert.match(
    r.stappen.find((x) => x.stap === "S foutmeldingen (Sentry)").actie,
    /niet aangekomen/,
  );
});

test("Sentry: zonder sleutel een duidelijke regel in het resultaat, en niets bij Sentry", async () => {
  const w = nepWolk();
  const r = await richtIn(ARG, opzet(w, { sentry: null }));
  assert.equal(
    r.stappen.find((x) => x.stap === "S foutmeldingen (Sentry)").actie,
    SENTRY_NIET_GEKOPPELD,
  );
  assert.match(
    SENTRY_NIET_GEKOPPELD,
    /daarna de owner van de beheer-repo, met zijn eigen Sentry-account: sentry-koppelen\.mjs uit de plugin.*App inrichten opnieuw/,
  );
  assert.ok(!w.aanroepen.some((a) => a.pad?.includes("sentry.io")));
  assert.equal(w.staat.ghVariabelen.production.VITE_SENTRY_DSN, undefined);
});

test("Sentry: droogloop plant het project en schrijft niets, ook niet bij Sentry", async () => {
  const w = nepWolk();
  const r = await richtIn({ ...ARG, droogloop: true }, opzet(w));
  assert.deepEqual(w.schrijfacties(), []);
  assert.equal(w.staat.sentry.ontvangen.length, 0);
  assert.match(
    r.stappen.find((x) => x.stap === "S foutmeldingen (Sentry)").actie,
    /gepland: Sentry-project cf-proef in klant aanmaken/,
  );
});

test("Sentry: meer teams zonder SENTRY_TEAM is een duidelijke fout; met SENTRY_TEAM komt het project in dat team", async () => {
  const teams = [{ slug: "web" }, { slug: "intern" }];
  const w = nepWolk({ sentry: { teams } });
  await assert.rejects(
    () => koppelSentry(sentry(w), { app: "x" }),
    /meer teams \(web, intern\); zet SENTRY_TEAM/,
  );
  const w2 = nepWolk({ sentry: { teams } });
  await koppelSentry(sentry(w2, { team: "intern" }), { app: "x", slaap: async () => {} });
  assert.equal(w2.staat.sentry.projecten[0].team, "intern");
});

test("Sentry: uit de omgeving alleen met een sleutel, en een sleutel zonder SENTRY_ORG is een fout", () => {
  assert.equal(sentryUitOmgeving({}), null);
  assert.equal(sentryUitOmgeving({ SENTRY_AUTH_TOKEN: " " }), null);
  assert.throws(() => sentryUitOmgeving({ SENTRY_AUTH_TOKEN: "s" }), /SENTRY_ORG/);
  assert.equal(sentryUitOmgeving({ SENTRY_AUTH_TOKEN: "s", SENTRY_ORG: "klant" }).org, "klant");
  assert.throws(
    () => sentryUitOmgeving({ SENTRY_AUTH_TOKEN: "s", SENTRY_ORG: "Klant BV" }),
    /geen slug/,
  );
});

test("Sentry: de API-aanroepen gaan naar SENTRY_URL (de EU-regio) met de sleutel als Bearer", async () => {
  const gezien = [];
  const fetchFn = async (url, opties) => {
    gezien.push({ url, auth: opties.headers.Authorization });
    return { ok: true, status: 200, text: async () => "[]" };
  };
  await sentryClient({
    fetchFn,
    token: "sntrys_nep",
    org: "klant",
    url: "https://de.sentry.io/",
  }).projecten();
  assert.deepEqual(gezien, [
    {
      url: "https://de.sentry.io/api/0/organizations/klant/projects/?per_page=100",
      auth: "Bearer sntrys_nep",
    },
  ]);
});

test("leesDsn: sleutel, host en project uit een DSN; iets anders is een fout", () => {
  assert.deepEqual(leesDsn("https://abc123@o1.ingest.de.sentry.io/42"), {
    sleutel: "abc123",
    host: "o1.ingest.de.sentry.io",
    projectId: "42",
  });
  for (const fout of [
    "",
    "http://abc@o1.ingest.sentry.io/1",
    "https://o1.ingest.sentry.io/1",
    "geen dsn",
  ]) {
    assert.throws(() => leesDsn(fout), /geen DSN/, fout);
  }
});
