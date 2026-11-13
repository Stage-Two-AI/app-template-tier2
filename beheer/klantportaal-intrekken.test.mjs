/**
 * Klantportaal, Toegang bijwerken: geen klant wordt geband of afgemeld omdat er een regel uit
 * toegang.json ging, en een vertrokken medewerker houdt geen toegang als medewerker. Elke test
 * speelt een aanval na die bij het bouwen van uitgave 43 is geprobeerd.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { richtIn, werkToegangBij } from "./inrichten-cloudflare.mjs";
import {
  ARG,
  afgemeld,
  app,
  auth,
  authGelezen,
  bans,
  cf,
  DEUR,
  GROEPEN,
  HOOKS,
  ID,
  klant,
  mail,
  medewerker,
  NAMEN,
  naarPortaal,
  opzet,
  PORTAAL,
  PORTAAL_APP,
  project,
  stap,
} from "./klantportaal-opzet.mjs";
import { klantportaalInstellingen, SESSIE } from "./lib/supabase.mjs";
import { MELDING_MEDEWERKER, portaalAanmeldHookSql } from "./lib/toegang.mjs";
import { nepWolk } from "./nep-wolk.mjs";

async function portaalMet(gebruikers) {
  const w = nepWolk({ gebruikers, workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  await naarPortaal(w);
  w.aanroepen.length = 0;
  return w;
}

// ---------------------------------------------------------------- geen massaban

test("geen massaban: één regel minder in toegang.json (klantportaal weg, of de korte vorm) bant en meldt geen enkele klant af", async () => {
  const klanten = Array.from({ length: 300 }, (_, i) =>
    klant(i + 1, `klant${i + 1}@handel${i}.nl`),
  );
  const lang = { groepen: GROEPEN, apps: { direct: { groepen: ["kantoor"] } } };
  for (const zonder of [DEUR, lang]) {
    const w = await portaalMet([...klanten, medewerker(900, "anna@winco.nl")]);
    const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, zonder));
    assert.deepEqual(bans(w), []);
    assert.deepEqual(afgemeld(w), []);
    assert.equal(w.aanroepen.filter((a) => a.methode === "updateUserById").length, 0);
    assert.deepEqual(r.niet_ingetrokken, ["direct"]);
    assert.ok(
      r.waarschuwingen.some((x) => /NIEMAND INGETROKKEN.*Draai eerst App inrichten/.test(x)),
    );
    // De regel terugzetten herstelt alles: er is niets gebeurd dat terug moet.
    w.aanroepen.length = 0;
    const r2 = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
    assert.equal(w.staat.gebruikers.filter((g) => g.banned_until).length, 0);
    assert.deepEqual(r2.klanten, { direct: 300 });
    assert.equal(r2.niet_ingetrokken, undefined);
  }
});

test("geen massaban: ook niet als App inrichten half terug is (mail al uit, deur nog niet terug)", async () => {
  const w = await portaalMet([klant(1, "inkoop@bloemist.nl"), klant(2, "piet@tuincentrum.be")]);
  // De auth-config is al die van een gewone app; de deur aanmaken mislukte.
  Object.assign(auth(w), { external_email_enabled: false, mailer_autoconfirm: true });
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.deepEqual(bans(w), []);
  assert.ok(
    r.waarschuwingen.some((x) => /er staat geen deur op direct\.wincoapps\.com/.test(x)),
    JSON.stringify(r.waarschuwingen),
  );
  // Een auth-config zonder leesbaar adres: ook wachten, nooit gokken.
  delete auth(w).site_url;
  w.aanroepen.length = 0;
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.deepEqual(bans(w), []);
});

test("geen massaban: een gewone app met een deur krijgt daarvoor geen enkele extra leesvraag", async () => {
  const w = nepWolk({
    workerBestaat: true,
    gebruikers: [
      { id: ID(1), email: "vreemd@elders.nl" },
      { id: ID(2), email: "anna@winco.nl" },
    ],
  });
  await richtIn(ARG, opzet(w, DEUR));
  w.aanroepen.length = 0;
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.deepEqual(bans(w), [ID(1)], "een gewone app trekt in zoals altijd");
  assert.equal(
    authGelezen(w, project(w).ref),
    0,
    "de auth-config van productie wordt niet gelezen",
  );
  assert.equal(r.niet_ingetrokken, undefined);
});

test("geen massaban: een gewone app in de tijdelijke stand (geen deur, alleen workers.dev) trekt in zoals altijd, met één leesvraag vooraf en alleen als er iemand in te trekken valt", async () => {
  const tijdelijk = { ...ARG, hostname: null, stand: "tijdelijk" };
  const w = nepWolk({ workerBestaat: true, gebruikers: [{ id: ID(2), email: "anna@winco.nl" }] });
  await richtIn(tijdelijk, opzet(w, DEUR));
  assert.equal(app(w, NAMEN.deur), undefined);
  // Niemand in te trekken: geen extra leesvraag.
  w.aanroepen.length = 0;
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.equal(authGelezen(w, project(w).ref), 0);
  // Wel iemand: één keer de auth-config lezen, vóór de ban; daarna gewoon intrekken.
  w.staat.gebruikers.push({ id: ID(1), email: "vreemd@elders.nl" });
  w.aanroepen.length = 0;
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.equal(authGelezen(w, project(w).ref), 1);
  assert.deepEqual(bans(w), [ID(1)]);
  assert.deepEqual(afgemeld(w), [ID(1)]);
  assert.deepEqual(r.ingetrokken, { direct: ["vreemd@elders.nl"] });
  const lees = w.aanroepen.findIndex((a) => a.methode === "GET" && a.pad.endsWith("/config/auth"));
  const ban = w.aanroepen.findIndex((a) => a.methode === "updateUserById");
  assert.ok(lees < ban, "eerst kijken, dan pas bannen");
});

test("bewust: een account met een Cloudflare- én een e-mailinlog gaat helemaal dicht als de medewerker uit de groep is, en het resultaat zegt dat erbij", async () => {
  const w = await portaalMet([
    {
      id: ID(1),
      email: "hulp@bureau.nl",
      identities: [mail("hulp@bureau.nl"), cf("hulp@bureau.nl")],
      app_metadata: { provider: "email", providers: ["email", "custom:cloudflare"] },
    },
  ]);
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w), [ID(1)]);
  assert.deepEqual(afgemeld(w), [ID(1)]);
  // Niet stil: de owner leest dat ook de klantkant dicht is en waar staat wat hij dan doet.
  assert.ok(
    r.waarschuwingen.some((x) =>
      /hulp@bureau\.nl is ingetrokken als medewerker en kon met hetzelfde account ook per mail inloggen.*bewust/.test(
        x,
      ),
    ),
    JSON.stringify(r.waarschuwingen),
  );
});

test("geen klant geraakt: een adres op het medewerkerdomein, hoofdletters, voorbij de 1000 accounts of een vreemd antwoord van de database", async () => {
  const veel = Array.from({ length: 2300 }, (_, i) => klant(i + 10, `K${i}@Handel.NL`));
  const lastig = [
    klant(1, "Klant@Winco.NL"), // adres op het domein van de medewerkers, hoofdletters
    klant(2, "oud@winco.nl"), // staat zelfs in uitsluiten
    { id: ID(3), email: "kaal@elders.nl" }, // geen metadata
    { id: ID(4) }, // geen adres
    { id: ID(5), email: "raar@elders.nl", app_metadata: { providers: "custom:cloudflare-nep" } },
  ];
  for (const antwoord of [undefined, [], [{ user_id: ID(9999), email: "x@y.nl" }]]) {
    const w = await portaalMet([...lastig, ...veel]);
    w.staat.identiteitenAntwoord = antwoord;
    const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
    assert.equal(w.aanroepen.filter((a) => a.methode === "updateUserById").length, 0);
    assert.deepEqual(afgemeld(w), []);
    assert.deepEqual(r.klanten, { direct: 2305 });
  }
  // Een antwoord dat geen lijst is, of rijen zonder user_id: dan stopt hij.
  for (const antwoord of [{ result: [] }, "fout", null, [["a", "b"]], [{ email: "x@y.nl" }]]) {
    const w = await portaalMet(lastig);
    w.staat.identiteitenAntwoord = antwoord;
    await assert.rejects(
      () => werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL)),
      /er is niets ingetrokken/,
    );
    assert.equal(w.aanroepen.filter((a) => a.methode === "updateUserById").length, 0);
  }
});

// ---------------------------------------------------------------- de vertrokken medewerker

test("vertrokken medewerker: een klantportaal begrenst de sessieduur, zodat een sessie zonder deur niet voorgoed blijft staan", async () => {
  const w = nepWolk({ workerBestaat: true });
  const r = await richtIn(ARG, opzet(w, PORTAAL));
  assert.deepEqual(SESSIE, { sessions_inactivity_timeout: 30 * 24 });
  assert.equal(auth(w).sessions_inactivity_timeout, 720);
  assert.match(stap(r, "3.4 sessieduur"), /30 dagen zonder gebruik/);
  // In een eigen aanroep, zonder een geheim erin.
  const eigen = w.aanroepen.filter(
    (a) => a.methode === "PATCH" && Object.hasOwn(a.body ?? {}, "sessions_inactivity_timeout"),
  );
  assert.equal(eigen.length, 1);
  assert.deepEqual(eigen[0].body, SESSIE);
  // Een tweede run schrijft hem niet opnieuw.
  w.aanroepen.length = 0;
  const r2 = await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(stap(r2, "3.4 sessieduur"), "ongewijzigd");
  // Een gewone app krijgt hem nooit (daar bewaakt de deur de sessie).
  const gewoon = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(gewoon, DEUR));
  assert.ok(!Object.keys(auth(gewoon)).some((k) => /^sessions_/.test(k)));
});

test("vertrokken medewerker: weigert Supabase de sessieduur (plan zonder die mogelijkheid), dan loopt de inrichting door en zegt het resultaat het hardop", async () => {
  const w = nepWolk({
    workerBestaat: true,
    faal: (methode, pad, body) =>
      methode === "PATCH" && pad.endsWith("/config/auth") && body?.sessions_inactivity_timeout
        ? { status: 402, message: "requires the Pro plan" }
        : null,
  });
  const r = await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(auth(w).external_email_enabled, true, "de rest is gezet");
  assert.equal(auth(w).hook_custom_access_token_enabled, true);
  assert.equal(auth(w).sessions_inactivity_timeout, undefined);
  assert.ok(
    r.waarschuwingen.some((x) => /sessieduur is niet begrensd.*Pro-plan.*12 uur/.test(x)),
    JSON.stringify(r.waarschuwingen),
  );
});

test("vertrokken medewerker: het adres van een medewerker is niet per mail aan te melden; de aanmeld-hook staat aan en volgt de groepen", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, PORTAAL));
  const inst = klantportaalInstellingen({
    afzender: { adres: "a@b.nl", naam: "A" },
    smtpWachtwoord: "x",
    captchaGeheim: "y",
    hooks: HOOKS,
  });
  assert.equal(inst.hook_before_user_created_enabled, true);
  assert.equal(inst.hook_custom_access_token_enabled, true);
  assert.equal(
    auth(w).hook_before_user_created_uri,
    `pg-functions://postgres/public/${HOOKS.aanmelden}`,
  );

  // De functie staat in de productiedatabase vóór de auth-config hem aanzet.
  const ref = project(w).ref;
  const sqlIndex = w.aanroepen.findIndex(
    (a) => a.pad?.endsWith(`/${ref}/database/query`) && a.body.query.includes(HOOKS.aanmelden),
  );
  const patchIndex = w.aanroepen.findIndex(
    (a) => a.methode === "PATCH" && a.body?.hook_before_user_created_enabled === true,
  );
  assert.ok(sqlIndex !== -1 && sqlIndex < patchIndex);

  const sql = portaalAanmeldHookSql(PORTAAL, "direct", HOOKS.aanmelden);
  assert.ok(w.staat.sqlOp.some((q) => q.ref === ref && q.query === sql));
  assert.match(sql, /domein = any \(array\['winco\.nl'\]::text\[\]\)/);
  assert.ok(sql.includes(MELDING_MEDEWERKER));
  // Via Cloudflare blijft de Access-policy de poort; elke andere manier is geweigerd.
  assert.match(sql, /if aanbieder = 'custom:cloudflare' then\s+return '\{\}'::jsonb;/);
  assert.match(sql, /if aanbieder <> 'email' or adres !~/);
  assert.match(
    sql,
    /revoke execute on function public\.wi_portaal_voor_aanmelden\(jsonb\) from authenticated, anon, public;/,
  );

  // Toegang bijwerken houdt hem actueel als de groepen wijzigen.
  const meer = {
    groepen: { ...GROEPEN, extern: { adressen: ["Hulp@Bureau.nl"], domeinen: ["partner.nl"] } },
    apps: { direct: { ...PORTAAL_APP, groepen: ["kantoor", "extern"] } },
  };
  w.staat.sqlOp.length = 0;
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, meer));
  const nieuw = w.staat.sqlOp.find((q) => q.ref === ref && q.query.includes(HOOKS.aanmelden));
  assert.ok(nieuw, "de hook is opnieuw geschreven");
  assert.match(nieuw.query, /array\['winco\.nl', 'partner\.nl'\]::text\[\]/);
  assert.match(nieuw.query, /adres = any \(array\['hulp@bureau\.nl'\]::text\[\]\)/);
  assert.ok(
    r.acties.some((a) =>
      /aanmeld-hook public\.wi_portaal_voor_aanmelden van klantportaal direct bijgewerkt/.test(a),
    ),
  );
  // Een gewone app krijgt in productie geen hook en geen SQL.
  const gewoon = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(gewoon, DEUR));
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(gewoon, DEUR));
  assert.deepEqual(gewoon.staat.sqlOp, []);
  assert.equal(auth(gewoon).hook_before_user_created_enabled, undefined);
});

test("vertrokken medewerker: een groep met alleen idp_groepen kan de aanmeld-hook niet beschermen, en dat staat als waarschuwing in elke run", async () => {
  const idp = {
    groepen: { ...GROEPEN, entra: { idp_groepen: ["Verkoop"] } },
    apps: { direct: { ...PORTAAL_APP, groepen: ["kantoor", "entra"] } },
  };
  const extra = { groepenIdp: { type: "azureAD", id: "idp-entra" } };
  const w = nepWolk({ workerBestaat: true });
  for (const droogloop of [true, false]) {
    const r = await richtIn({ ...ARG, droogloop }, opzet(w, idp, extra));
    assert.ok(
      r.waarschuwingen.some((x) => /groep entra werkt alleen op idp_groepen.*aanmeld-hook/.test(x)),
      JSON.stringify(r.waarschuwingen),
    );
  }
  const zonder = await richtIn(ARG, opzet(nepWolk({ workerBestaat: true }), PORTAAL));
  assert.ok(!zonder.waarschuwingen.some((x) => /idp_groepen/.test(x)));
});

test("vertrokken medewerker: ontsnapt niet door zijn adres te wijzigen, een e-mailinlog erbij te hebben of doordat de gebruikerslijst geen identiteiten geeft", async () => {
  const w = await portaalMet([
    // adres gewijzigd naar privé; de identiteit houdt het werkadres
    {
      id: ID(1),
      email: "prive@gmail.com",
      identities: [cf("oud@winco.nl")],
      app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
    },
    // e-mailinlog erbij, metadata zegt alleen "email"
    {
      id: ID(2),
      email: "hulp@bureau.nl",
      identities: [mail("hulp@bureau.nl"), cf("hulp@bureau.nl")],
      app_metadata: { provider: "email", providers: ["email"] },
    },
    // hoofdletters in het adres van de identiteit
    { id: ID(3), email: "x@gmail.com", identities: [cf("OUD@Winco.NL")], app_metadata: {} },
  ]);
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  assert.deepEqual(bans(w).sort(), [ID(1), ID(2), ID(3)]);
  assert.deepEqual(afgemeld(w).sort(), [ID(1), ID(2), ID(3)]);
});
