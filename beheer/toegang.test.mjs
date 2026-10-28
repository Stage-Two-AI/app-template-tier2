import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { cloudflareClient } from "./lib/cloudflare.mjs";
import {
  aanmeldHookSql,
  hookFunctie,
  koppelPolicies,
  magAanmelden,
  policyVoorGroep,
  sqlTekst,
  synchroniseerPolicies,
  TESTGEBRUIKER,
  testaccountsVan,
  trekIn,
  valideerToegang,
  verwijderOverbodig,
} from "./lib/toegang.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const VV = "cf-proef-";
const KLANT = {
  groepen: {
    klant: { domeinen: ["klant.nl"], uitsluiten: ["jan@klant.nl"] },
    stagetwo: { adressen: ["info@stagetwo.nl"] },
  },
  apps: { "cf-proef": ["klant", "stagetwo"] },
};

// ---------------------------------------------------------------- validatie

test("validatie: het proefbestand in de repo is geldig", () => {
  const t = JSON.parse(readFileSync(new URL("./toegang.json", import.meta.url), "utf8"));
  assert.deepEqual(valideerToegang(t).apps["cf-proef"], ["stagetwo"]);
  assert.deepEqual(t.groepen.stagetwo.adressen, ["info@stagetwo.nl"]);
});

test("validatie: een app met een onbekende groep noemt app en groep", () => {
  const t = { groepen: KLANT.groepen, apps: { "cf-proef": ["klant", "inkoop"] } };
  assert.throws(() => valideerToegang(t), /app "cf-proef".*groep "inkoop".*onbekend/);
});

test("validatie: een lege groep noemt de groep en de velden", () => {
  const t = { groepen: { leeg: { uitsluiten: ["a@b.nl"] } }, apps: { x: ["leeg"] } };
  assert.throws(() => valideerToegang(t), /groep "leeg".*domeinen, adressen of idp_groepen/);
});

test("validatie: een app zonder groepen is een fout", () => {
  const t = { groepen: KLANT.groepen, apps: { "cf-proef": [] } };
  assert.throws(() => valideerToegang(t), /app "cf-proef".*geen groepen/);
});

test("validatie: een ongeldig domein of adres noemt groep en veld", () => {
  assert.throws(
    () => valideerToegang({ groepen: { a: { domeinen: ["klant'.nl"] } }, apps: { x: ["a"] } }),
    /groep "a", veld domeinen/,
  );
  assert.throws(
    () => valideerToegang({ groepen: { a: { adressen: ["geen-adres"] } }, apps: { x: ["a"] } }),
    /groep "a", veld adressen/,
  );
  assert.throws(
    () =>
      valideerToegang({
        groepen: { a: { domeinen: ["a.nl"], rollen: ["x"] } },
        apps: { x: ["a"] },
      }),
    /groep "a", veld rollen.*onbekend/,
  );
});

// ---------------------------------------------------------------- vertaling

test("vertaling: domein klant.nl wordt één include-regel op e-maildomein en niets anders (AE4)", () => {
  const p = policyVoorGroep("klant", { domeinen: ["klant.nl"] }, { voorvoegsel: VV });
  assert.equal(p.name, "cf-proef-klant");
  assert.equal(p.decision, "allow");
  assert.deepEqual(p.include, [{ email_domain: { domain: "klant.nl" } }]);
  assert.deepEqual(p.exclude, []);
  assert.deepEqual(p.require, []);
});

test("vertaling: uitsluiten wordt een exclude-regel voor dat adres", () => {
  const p = policyVoorGroep(
    "klant",
    { domeinen: ["klant.nl"], uitsluiten: ["jan@klant.nl"] },
    { voorvoegsel: VV },
  );
  assert.deepEqual(p.exclude, [{ email: { email: "jan@klant.nl" } }]);
});

test("vertaling: adressen worden e-mailregels", () => {
  const p = policyVoorGroep("stagetwo", { adressen: ["info@stagetwo.nl"] }, { voorvoegsel: VV });
  assert.deepEqual(p.include, [{ email: { email: "info@stagetwo.nl" } }]);
});

test("vertaling: idp_groepen zonder gekoppelde IdP geeft een duidelijke fout, geen lege regel (AE3)", () => {
  assert.throws(
    () => policyVoorGroep("it", { idp_groepen: ["IT-beheer"] }, { voorvoegsel: VV }),
    /groep "it", veld idp_groepen: .*identiteitsdienst/,
  );
  const p = policyVoorGroep(
    "it",
    { idp_groepen: ["abc-123"] },
    { groepenIdp: { type: "azureAD", id: "idp-entra" }, voorvoegsel: VV },
  );
  assert.deepEqual(p.include, [{ azureAD: { id: "abc-123", identity_provider_id: "idp-entra" } }]);
});

test("voorvoegsel: zonder voorvoegsel geen policy, met rp- krijgt de policy rp-", () => {
  assert.throws(() => policyVoorGroep("klant", { domeinen: ["klant.nl"] }), /voorvoegsel/);
  assert.throws(
    () => policyVoorGroep("klant", { domeinen: ["klant.nl"] }, { voorvoegsel: "RP" }),
    /voorvoegsel/,
  );
  const p = policyVoorGroep("klant", { domeinen: ["klant.nl"] }, { voorvoegsel: "rp-" });
  assert.equal(p.name, "rp-klant");
});

test("voorvoegsel: de hookfunctie volgt het voorvoegsel en is veilig voor SQL", () => {
  assert.equal(hookFunctie("cf-proef-"), "cf_proef_voor_aanmelden");
  assert.equal(hookFunctie("rp-"), "rp_voor_aanmelden");
  assert.match(hookFunctie("a1b2-"), /^[a-z0-9_]+$/);
  for (const fout of [
    "a1-b2-",
    "cf-",
    undefined,
    "",
    "rp",
    "Rp-",
    "rp_",
    "1rp-",
    "rp-'; drop-",
    `${"a".repeat(17)}-`,
  ]) {
    assert.throws(() => hookFunctie(fout), /voorvoegsel/, String(fout));
  }
});

test("synchroniseren met rp-: alleen rp-policies zijn van ons, cf-proef- blijft buiten schot", async () => {
  const w = nepWolk({
    policies: [{ id: "ander", name: "cf-proef-oud", decision: "allow", include: [] }],
  });
  const cf = cloudflareClient({
    fetchFn: w.fetchFn,
    token: "t",
    accountId: "acc",
    teamDomein: "stagetwo",
  });
  const s = await synchroniseerPolicies(cf, KLANT, { voorvoegsel: "rp-" });
  assert.deepEqual(w.staat.policies.map((p) => p.name).sort(), [
    "cf-proef-oud",
    "rp-klant",
    "rp-stagetwo",
  ]);
  assert.deepEqual(s.overbodig, [], "een policy met een ander voorvoegsel is nooit overbodig");
});

test("synchroniseren: overbodig is alleen vv plus een groepsnaam, nooit een geneste of vreemde naam", async () => {
  const w = nepWolk({
    policies: [
      { id: "oud", name: "rp-oud", decision: "allow", include: [] },
      { id: "vreemd", name: "rp-Handmatig Gemaakt", decision: "allow", include: [] },
      { id: "proef", name: "cf-proef-stagetwo", decision: "allow", include: [] },
    ],
  });
  const cf = cloudflareClient({
    fetchFn: w.fetchFn,
    token: "t",
    accountId: "acc",
    teamDomein: "stagetwo",
  });
  const s = await synchroniseerPolicies(cf, KLANT, { voorvoegsel: "rp-" });
  assert.deepEqual(
    s.overbodig.map((p) => p.id),
    ["oud"],
  );
});

// ---------------------------------------------------------------- synchroniseren

async function ingericht() {
  // Een wolk waarin de proef al staat zoals het bestand hem beschrijft.
  const w = nepWolk();
  const cf = cloudflareClient({
    fetchFn: w.fetchFn,
    token: "t",
    accountId: "acc",
    teamDomein: "stagetwo",
  });
  const s = await synchroniseerPolicies(cf, KLANT, { voorvoegsel: VV });
  const ids = KLANT.apps["cf-proef"].map((g) => s.ids[g]);
  for (const [naam, type] of [
    ["cf-proef-cf-proef", "self_hosted"],
    ["cf-proef-cf-proef-inlog", "saas"],
  ]) {
    await cf.maakApp({
      name: naam,
      type,
      policies: ids.map((id, i) => ({ id, precedence: i + 1 })),
    });
  }
  w.aanroepen.length = 0;
  return { w, cf };
}

test("synchroniseren: een ongewijzigd bestand leidt tot nul schrijfacties", async () => {
  const { w, cf } = await ingericht();
  const s = await synchroniseerPolicies(cf, KLANT, { voorvoegsel: VV });
  const apps = await cf.apps();
  await koppelPolicies(cf, KLANT, apps, s.ids, VV);
  await verwijderOverbodig(cf, s.overbodig);
  assert.deepEqual(w.schrijfacties(), []);
  assert.deepEqual(s.acties, []);
});

test("synchroniseren: een groep weghalen haalt de policy van beide apps en verwijdert hem", async () => {
  const { w, cf } = await ingericht();
  const zonderKlant = {
    groepen: { stagetwo: KLANT.groepen.stagetwo },
    apps: { "cf-proef": ["stagetwo"] },
  };
  const s = await synchroniseerPolicies(cf, zonderKlant, { voorvoegsel: VV });
  await koppelPolicies(cf, zonderKlant, await cf.apps(), s.ids, VV);
  await verwijderOverbodig(cf, s.overbodig);
  const schrijf = w.schrijfacties();
  assert.deepEqual(
    schrijf.slice(0, 2).map((x) => x.split(" ")[0]),
    ["PUT", "PUT"],
  );
  assert.match(schrijf[2], /^DELETE cf\/access\/policies\//);
  assert.equal(schrijf.length, 3);
  for (const app of w.staat.apps) {
    assert.deepEqual(
      app.policies.map((p) => p.id),
      [s.ids.stagetwo],
    );
  }
  assert.equal(
    w.staat.policies.some((p) => p.name === "cf-proef-klant"),
    false,
  );
});

test("synchroniseren: een gewijzigde groep werkt de policy bij, zonder nieuwe aan te maken", async () => {
  const { w, cf } = await ingericht();
  const anders = structuredClone(KLANT);
  anders.groepen.klant.domeinen.push("klant.be");
  await synchroniseerPolicies(cf, anders, { voorvoegsel: VV });
  assert.deepEqual(
    w.schrijfacties().map((x) => x.split(" ")[0]),
    ["PUT"],
  );
});

test("synchroniseren: een policy zonder voorvoegsel met dezelfde naam laat alles staan", async () => {
  const w = nepWolk({ policies: [{ id: "eigen", name: "klant", decision: "allow", include: [] }] });
  const cf = cloudflareClient({
    fetchFn: w.fetchFn,
    token: "t",
    accountId: "acc",
    teamDomein: "stagetwo",
  });
  await assert.rejects(
    () => synchroniseerPolicies(cf, KLANT, { voorvoegsel: VV }),
    /"klant".*zonder voorvoegsel/,
  );
  assert.deepEqual(w.schrijfacties(), []);
});

test("synchroniseren: een ongeldig bestand synchroniseert niets", async () => {
  const w = nepWolk();
  const cf = cloudflareClient({
    fetchFn: w.fetchFn,
    token: "t",
    accountId: "acc",
    teamDomein: "stagetwo",
  });
  await assert.rejects(() =>
    synchroniseerPolicies(
      cf,
      { groepen: KLANT.groepen, apps: { x: ["weg"] } },
      { voorvoegsel: VV },
    ),
  );
  assert.deepEqual(w.aanroepen, []);
});

// ---------------------------------------------------------------- intrekken

test("intrekken: een verwijderd adres krijgt een ban en wordt afgemeld; wie past blijft onaangeroerd", async () => {
  const gebruikers = [
    { id: "11111111-1111-4111-8111-111111111111", email: "piet@klant.nl" },
    { id: "22222222-2222-4222-8222-222222222222", email: "oud@elders.nl" },
    { id: "33333333-3333-4333-8333-333333333333", email: "jan@klant.nl" },
    {
      id: "44444444-4444-4444-8444-444444444444",
      email: "al@weg.nl",
      banned_until: "2126-01-01T00:00:00Z",
    },
  ];
  const log = [];
  const r = await trekIn({
    gebruikers,
    toegang: KLANT,
    app: "cf-proef",
    ban: async (id) => log.push(`ban ${id}`),
    afmelden: async (id) => log.push(`afmelden ${id}`),
    nu: new Date("2026-09-27T00:00:00Z"),
  });
  assert.deepEqual(log, [
    "ban 22222222-2222-4222-8222-222222222222",
    "afmelden 22222222-2222-4222-8222-222222222222",
    "ban 33333333-3333-4333-8333-333333333333",
    "afmelden 33333333-3333-4333-8333-333333333333",
  ]);
  assert.deepEqual(r.ingetrokken, ["oud@elders.nl", "jan@klant.nl"]);
  assert.deepEqual(r.onaangeroerd, 1);
});

test("intrekken: iedereen past, dan nul schrijfacties", async () => {
  const log = [];
  await trekIn({
    gebruikers: [{ id: "11111111-1111-4111-8111-111111111111", email: "Piet@Klant.nl" }],
    toegang: KLANT,
    app: "cf-proef",
    ban: async () => log.push("ban"),
    afmelden: async () => log.push("afmelden"),
  });
  assert.deepEqual(log, []);
});

test("intrekken: wie geband was en weer op de lijst staat, wordt weer toegelaten", async () => {
  const gebruikers = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      email: "piet@klant.nl",
      banned_until: "2126-01-01T00:00:00Z",
    },
    { id: "22222222-2222-4222-8222-222222222222", email: "kees@klant.nl" },
    {
      id: "33333333-3333-4333-8333-333333333333",
      email: "anna@klant.nl",
      banned_until: "2020-01-01T00:00:00Z",
    },
  ];
  const log = [];
  const r = await trekIn({
    gebruikers,
    toegang: KLANT,
    app: "cf-proef",
    ban: async (id) => log.push(`ban ${id}`),
    afmelden: async (id) => log.push(`afmelden ${id}`),
    ontban: async (id) => log.push(`ontban ${id}`),
    nu: new Date("2026-09-27T00:00:00Z"),
  });
  // Alleen de actieve ban wordt opgeheven; wie nooit of niet meer geband is, blijft ongemoeid.
  assert.deepEqual(log, ["ontban 11111111-1111-4111-8111-111111111111"]);
  assert.deepEqual(r.toegelaten, ["piet@klant.nl"]);
  assert.equal(r.onaangeroerd, 2);
  assert.deepEqual(r.ingetrokken, []);
});

test("intrekken: bij een groep met idp_groepen wordt een onbekend adres niet blind geband", async () => {
  const t = { groepen: { it: { idp_groepen: ["g1"] } }, apps: { a: ["it"] } };
  const log = [];
  const r = await trekIn({
    gebruikers: [{ id: "11111111-1111-4111-8111-111111111111", email: "x@y.nl" }],
    toegang: t,
    app: "a",
    ban: async () => log.push("ban"),
    afmelden: async () => log.push("afmelden"),
  });
  assert.deepEqual(log, []);
  assert.deepEqual(r.onbekend, ["x@y.nl"]);
});

// ---------------------------------------------------------------- de beslissing en de aanmeld-hook

test("beslissing: laat piet@klant.nl toe en weigert jan@elders.nl en de uitgeslotene", () => {
  const t = { groepen: { klant: KLANT.groepen.klant }, apps: { a: ["klant"] } };
  assert.equal(magAanmelden("piet@klant.nl", t, "a"), "ja");
  assert.equal(magAanmelden("PIET@klant.nl", t, "a"), "ja");
  assert.equal(magAanmelden("jan@elders.nl", t, "a"), "nee");
  assert.equal(magAanmelden("jan@klant.nl", t, "a"), "nee");
  assert.equal(magAanmelden("piet@sub.klant.nl", t, "a"), "nee");
  assert.equal(magAanmelden("a@b@klant.nl", t, "a"), "nee");
});

test("aanmeld-hook: via Cloudflare laat de SQL-functie alleen de gekozen domeinen en adressen door", () => {
  const sql = aanmeldHookSql(KLANT, "cf-proef", "cf_proef_voor_aanmelden");
  assert.match(sql, /create or replace function public\.cf_proef_voor_aanmelden\(event jsonb\)/);
  assert.match(sql, /domein = any \(array\['klant\.nl'\]::text\[\]\)/);
  assert.match(sql, /adres = any \(array\['info@stagetwo\.nl'\]::text\[\]\)/);
  assert.match(sql, /not \(adres = any \(array\['jan@klant\.nl'\]::text\[\]\)\)/);
  assert.match(sql, /'http_code', 403/);
  assert.match(
    sql,
    /grant execute on function public\.cf_proef_voor_aanmelden\(jsonb\) to supabase_auth_admin/,
  );
  assert.match(
    sql,
    /revoke execute on function public\.cf_proef_voor_aanmelden\(jsonb\) from authenticated, anon, public/,
  );
  assert.doesNotMatch(sql, /elders/);
});

test("aanmeld-hook: tekst in SQL wordt veilig geciteerd en een rare functienaam geweigerd", () => {
  assert.equal(sqlTekst("o'brien"), "'o''brien'");
  assert.throws(() => aanmeldHookSql(KLANT, "cf-proef", "x; drop table y"), /functienaam/);
});

// ---------------------------------------------------------------- testaccounts (testdatabase)

const MET_TEST = {
  ...KLANT,
  testaccounts: { "cf-proef": ["Scherm@Elders.nl", "testgebruiker@stagetwo.nl"] },
};

test("testaccounts: geldig per app, en altijd met de vaste testgebruiker erbij", () => {
  assert.equal(valideerToegang(MET_TEST), MET_TEST);
  assert.equal(TESTGEBRUIKER, "testgebruiker@stagetwo.nl");
  assert.deepEqual(testaccountsVan(MET_TEST, "cf-proef"), [
    "testgebruiker@stagetwo.nl",
    "scherm@elders.nl",
  ]);
  assert.deepEqual(testaccountsVan(KLANT, "cf-proef"), ["testgebruiker@stagetwo.nl"]);
});

test("testaccounts: een onbekende app, een ongeldig adres of de verkeerde vorm is een fout", () => {
  assert.throws(
    () => valideerToegang({ ...KLANT, testaccounts: { onbekend: ["a@b.nl"] } }),
    /testaccounts, app "onbekend": staat niet onder apps/,
  );
  assert.throws(
    () => valideerToegang({ ...KLANT, testaccounts: { "cf-proef": ["geen-adres"] } }),
    /testaccounts, app "cf-proef": "geen-adres" is geen geldig adres/,
  );
  assert.throws(
    () => valideerToegang({ ...KLANT, testaccounts: { "cf-proef": "a@b.nl" } }),
    /moet een lijst met adressen zijn/,
  );
  assert.throws(
    () => valideerToegang({ ...KLANT, testaccounts: ["a@b.nl"] }),
    /"testaccounts" is geen object/,
  );
});

test("testaccounts: komen nooit in een Access-policy", () => {
  const policies = Object.entries(MET_TEST.groepen).map(([naam, groep]) =>
    policyVoorGroep(naam, groep, { voorvoegsel: VV }),
  );
  assert.doesNotMatch(JSON.stringify(policies), /scherm|testgebruiker/i);
});

test("intrekken in de testdatabase: testaccounts blijven staan, een gebande krijgt de ban opgeheven", async () => {
  const gebruikers = [
    { id: "11111111-1111-4111-8111-111111111111", email: "testgebruiker@stagetwo.nl" },
    {
      id: "22222222-2222-4222-8222-222222222222",
      email: "scherm@elders.nl",
      banned_until: "2126-01-01T00:00:00Z",
    },
    { id: "33333333-3333-4333-8333-333333333333", email: "vreemd@elders.nl" },
  ];
  const log = [];
  const r = await trekIn({
    gebruikers,
    toegang: MET_TEST,
    app: "cf-proef",
    testaccounts: testaccountsVan(MET_TEST, "cf-proef"),
    ban: async (id) => log.push(`ban ${id}`),
    afmelden: async (id) => log.push(`afmelden ${id}`),
    ontban: async (id) => log.push(`ontban ${id}`),
    nu: new Date("2026-10-28T00:00:00Z"),
  });
  assert.deepEqual(log, [
    "ontban 22222222-2222-4222-8222-222222222222",
    "ban 33333333-3333-4333-8333-333333333333",
    "afmelden 33333333-3333-4333-8333-333333333333",
  ]);
  assert.deepEqual(r.ingetrokken, ["vreemd@elders.nl"]);
  assert.deepEqual(r.toegelaten, ["scherm@elders.nl"]);
  assert.equal(r.onaangeroerd, 1);
});

test("intrekken in productie (zonder testaccounts): de testgebruiker wordt gewoon geband", async () => {
  const log = [];
  const r = await trekIn({
    gebruikers: [{ id: "11111111-1111-4111-8111-111111111111", email: TESTGEBRUIKER }],
    toegang: MET_TEST,
    app: "cf-proef",
    ban: async (id) => log.push(`ban ${id}`),
    afmelden: async (id) => log.push(`afmelden ${id}`),
  });
  assert.deepEqual(r.ingetrokken, [TESTGEBRUIKER]);
});

test("aanmeld-hook van de testdatabase: e-mail alleen voor testaccounts, Cloudflare voor de groepen, de rest nooit", () => {
  const sql = aanmeldHookSql(MET_TEST, "cf-proef", "cf_proef_voor_aanmelden");
  // De provider staat in user.app_metadata.provider van de invoer van de hook.
  assert.match(
    sql,
    /aanbieder text := coalesce\(event->'user'->'app_metadata'->>'provider', ''\);/,
  );
  // Met e-mail: alleen de testaccounts, daarna altijd weigeren (geen doorval naar de groepen).
  const emailTak = sql.slice(
    sql.indexOf("if aanbieder = 'email' then"),
    sql.indexOf("aanbieder <>"),
  );
  assert.match(emailTak, /adres = any \(array\['scherm@elders\.nl'\]::text\[\]\)/);
  // De vaste testgebruiker meldt zich nooit zelf aan: die maakt de admin-API, buiten de hook.
  assert.doesNotMatch(emailTak, /testgebruiker/);
  assert.match(emailTak, /'http_code', 403/);
  assert.doesNotMatch(emailTak, /klant\.nl|info@stagetwo/);
  // Elke andere provider dan custom:cloudflare: weigeren, vóór de groepen.
  assert.ok(sql.indexOf("aanbieder <> 'custom:cloudflare'") < sql.indexOf("-- groep klant"));
  assert.match(sql, /domein = any \(array\['klant\.nl'\]::text\[\]\)/);
  assert.match(sql, /not \(adres = any \(array\['jan@klant\.nl'\]::text\[\]\)\)/);
  assert.match(sql, /to supabase_auth_admin/);
  assert.match(sql, /from authenticated, anon, public/);
});
