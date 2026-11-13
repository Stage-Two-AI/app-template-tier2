/**
 * Klantportaal, Toegang bijwerken: geen klant wordt geband of afgemeld omdat er een regel uit
 * toegang.json ging, en een vertrokken medewerker houdt geen toegang als medewerker. Elke test
 * speelt een aanval na die bij het bouwen van uitgave 43 is geprobeerd.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eindstatus, richtIn, uitvoerRegel, werkToegangBij } from "./inrichten-cloudflare.mjs";
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

test("geen massaban: één regel minder in toegang.json (klantportaal weg, of de korte vorm) bant en meldt geen enkele klant af; de run is rood tot het is opgelost", async () => {
  const klanten = Array.from({ length: 300 }, (_, i) =>
    klant(i + 1, `klant${i + 1}@handel${i}.nl`),
  );
  const lang = { groepen: GROEPEN, apps: { direct: { groepen: ["kantoor"] } } };
  for (const zonder of [DEUR, lang]) {
    const w = await portaalMet([...klanten, medewerker(900, "anna@winco.nl")]);
    let r;
    for (let run = 0; run < 3; run += 1) {
      r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, zonder));
    }
    assert.deepEqual(bans(w), []);
    assert.deepEqual(afgemeld(w), []);
    assert.equal(w.aanroepen.filter((a) => a.methode === "updateUserById").length, 0);
    assert.deepEqual(r.klanten, { direct: 300 });
    assert.match(r.fouten.join(" "), /de 300 klanten zijn met rust gelaten.*Draai App inrichten/);
    assert.match(uitvoerRegel(eindstatus("toegang", r)), /"status":"mislukt"/);
    // De regel terugzetten herstelt alles: er is niets gebeurd dat terug moet.
    w.aanroepen.length = 0;
    const r2 = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
    assert.equal(w.staat.gebruikers.filter((g) => g.banned_until).length, 0);
    assert.deepEqual(r2.klanten, { direct: 300 });
    assert.equal(r2.fouten, undefined);
    assert.match(uitvoerRegel(eindstatus("toegang", r2)), /"status":"gelukt"/);
  }
});

test("de rem is smal: een vertrokken medewerker ontsnapt er nooit door; in dezelfde pull request klantportaal weg en een medewerker eruit trekt die medewerker meteen in", async () => {
  const vertrokken = {
    groepen: { kantoor: { domeinen: ["winco.nl"], uitsluiten: ["oud@winco.nl", "anna@winco.nl"] } },
    apps: { direct: ["kantoor"] },
  };
  const w = await portaalMet([klant(1, "inkoop@bloemist.nl"), medewerker(2, "anna@winco.nl")]);
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, vertrokken));
  assert.deepEqual(bans(w), [ID(2)], "anna is geband, de klant niet");
  assert.deepEqual(afgemeld(w), [ID(2)]);
  assert.deepEqual(r.ingetrokken, { direct: ["anna@winco.nl"] });
  assert.deepEqual(r.klanten, { direct: 1 });
  // En de run eindigt rood, met de uitleg: het portaal staat nog half open.
  const eind = eindstatus("toegang", r);
  assert.equal(eind.status, "mislukt");
  assert.match(
    eind.reden,
    /Medewerkers \(accounts met een inlog via Cloudflare\) zijn gewoon beoordeeld/,
  );
  assert.deepEqual(eind.ingetrokken, r.ingetrokken, "wat wel is gedaan staat er nog bij");
});

test("geen massaban: ook niet als App inrichten halverwege bleef steken (mail al uit, de klanten nog niet gemarkeerd, de deur nog niet terug)", async () => {
  const w = await portaalMet([klant(1, "inkoop@bloemist.nl"), klant(2, "piet@tuincentrum.be")]);
  // De auth-config is al die van een gewone app; het markeren van de klanten mislukte.
  Object.assign(auth(w), { external_email_enabled: false, mailer_autoconfirm: true });
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.deepEqual(bans(w), []);
  assert.match(r.fouten.join(" "), /het sluiten is halverwege blijven steken.*Draai App inrichten/);
  // De volgende run van App inrichten maakt het af: klanten gemarkeerd, deur terug.
  const dicht = await richtIn(ARG, opzet(w, DEUR));
  assert.match(stap(dicht, "3.4 klanten van het gesloten klantportaal"), /^2 klantaccounts/);
  assert.ok(app(w, NAMEN.deur));
  w.aanroepen.length = 0;
  const r2 = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.deepEqual(bans(w), []);
  assert.equal(r2.fouten, undefined);
  // Lukt de leesvraag naar de auth-instellingen niet: niet gokken, niemand bannen, rood.
  const kapot = await portaalMet([klant(1, "inkoop@bloemist.nl")]);
  const stuk = opzet(kapot, DEUR);
  stuk.supabase.authConfig = async () => {
    throw new Error("GET config/auth gaf 500");
  };
  const r3 = await werkToegangBij({ voorvoegsel: "wi-" }, stuk);
  assert.deepEqual(bans(kapot), []);
  assert.match(r3.fouten.join(" "), /de auth-instellingen waren niet te lezen/);
});

test("een portaal sluiten bant geen klanten: App inrichten zegt in de droogloop en in het resultaat wat er gebeurt, meldt de klanten af en markeert ze, en Toegang bijwerken laat ze daarna voorgoed met rust", async () => {
  const klanten = Array.from({ length: 50 }, (_, i) => klant(100 + i, `klant${i}@bloemist.nl`));
  const w = await portaalMet([
    ...klanten,
    medewerker(2, "anna@winco.nl"),
    medewerker(3, "ex@oudbedrijf.nl"),
  ]);
  // Iemand schrijft de korte vorm. De droogloop van App inrichten zegt wat dat betekent.
  const droog = await richtIn({ ...ARG, droogloop: true }, opzet(w, DEUR));
  assert.match(
    droog.waarschuwingen.join(" "),
    /HET KLANTPORTAAL VAN direct GAAT DICHT.*De deur komt terug.*inloggen per mail gaat uit.*Klanten kunnen daarna niet meer inloggen.*afgemeld.*nooit bant.*Is dit een vergissing/,
  );
  assert.equal(
    w.staat.sql.filter((q) => /raw_app_meta_data/.test(q)).length,
    0,
    "droog: niets gedaan",
  );
  // De echte run: hetzelfde bericht, de klanten afgemeld en gemarkeerd, niemand geband.
  w.aanroepen.length = 0;
  const echt = await richtIn(ARG, opzet(w, DEUR));
  assert.match(echt.waarschuwingen.join(" "), /HET KLANTPORTAAL VAN direct GAAT DICHT/);
  assert.match(
    stap(echt, "3.4 klanten van het gesloten klantportaal"),
    /^50 klantaccounts.*gemarkeerd en afgemeld; niemand geband/,
  );
  assert.ok(app(w, NAMEN.deur), "de deur is terug");
  assert.equal(auth(w).external_email_enabled, false);
  assert.deepEqual(bans(w), []);
  // Eerst mail uit, dan pas markeren en afmelden: daarna kan geen klant een nieuwe sessie maken.
  const acties = w.aanroepen.map((a) => a.body?.query ?? `${a.methode} ${a.pad ?? ""}`);
  const mailUit = acties.findIndex((a) => /^PATCH .*config\/auth$/.test(a));
  const markeren = acties.findIndex((a) => /^update auth\.users set raw_app_meta_data/.test(a));
  const afmelden = acties.findIndex((a) =>
    /^delete from auth\.sessions where user_id not in/.test(a),
  );
  assert.ok(
    mailUit !== -1 && mailUit < markeren && markeren < afmelden,
    JSON.stringify([mailUit, markeren, afmelden]),
  );
  // De medewerkers zijn niet gemarkeerd en niet afgemeld.
  assert.equal(w.staat.gebruikers.filter((g) => g.app_metadata?.klantportaal_klant).length, 50);
  // De eerstvolgende merges van toegang.json: de vertrokken medewerker gaat eruit, geen klant.
  w.aanroepen.length = 0;
  let r;
  for (let run = 0; run < 3; run += 1)
    r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.deepEqual(bans(w), [ID(3)], "alleen ex@oudbedrijf.nl");
  assert.deepEqual(r.klanten, { direct: 50 });
  assert.equal(r.fouten, undefined);
  assert.equal(authGelezen(w, project(w).ref), 0, "en zonder één extra leesvraag");
  // Wordt de app later weer een klantportaal, dan zijn alle klanten er nog, zonder ban.
  await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(w.staat.gebruikers.filter((g) => g.banned_until && g.id !== ID(3)).length, 0);
  // Een account met het kenmerk dat later via Cloudflare inlogt (een klant die medewerker
  // werd) wordt weer gewoon beoordeeld: het kenmerk beschermt alleen wie geen Cloudflare-inlog heeft.
  const w2 = nepWolk({
    workerBestaat: true,
    gebruikers: [
      {
        ...medewerker(7, "ex@elders.nl"),
        app_metadata: { providers: ["email", "custom:cloudflare"], klantportaal_klant: true },
      },
    ],
  });
  await richtIn(ARG, opzet(w2, DEUR));
  w2.aanroepen.length = 0;
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w2, DEUR));
  assert.deepEqual(bans(w2), [ID(7)]);
});

test("één mislukte leesvraag bij een klantportaal houdt het intrekken bij de andere apps niet tegen: doorgaan, en rood eindigen", async () => {
  const w = await portaalMet([medewerker(2, "anna@winco.nl")]);
  // Een tweede, gewone app van dezelfde klant, met een vertrokken medewerker.
  const ref = "refzzzzzzzzzzzzzzzzz";
  w.staat.projecten.push({
    ref,
    name: "wi-zzz",
    organization_slug: "winco",
    status: "ACTIVE_HEALTHY",
  });
  w.staat.apps.push({ id: "app-zzz", name: "wi-zzz", type: "self_hosted", policies: [] });
  w.staat.gebruikersOp[`https://${ref}.supabase.co`] = [medewerker(9, "ex@oudbedrijf.nl")];
  const toegang = { groepen: GROEPEN, apps: { direct: PORTAAL_APP, zzz: ["kantoor"] } };
  w.staat.identiteitenAntwoord = { message: "query timed out" };
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, toegang));
  assert.deepEqual(bans(w), [ID(9)], "ex@oudbedrijf.nl bij de andere app is ingetrokken");
  assert.deepEqual(r.ingetrokken, { zzz: ["ex@oudbedrijf.nl"] });
  assert.match(
    r.fouten.join(" "),
    /^direct: het intrekken is niet \(helemaal\) gelukt.*Bij de andere apps is gewoon ingetrokken/,
  );
  assert.equal(eindstatus("toegang", r).status, "mislukt");
  // Een fout bij een gewone app stopt de run, zoals op versie 42.
  const gewoon = nepWolk({ workerBestaat: true, gebruikers: [medewerker(9, "ex@oudbedrijf.nl")] });
  await richtIn(ARG, opzet(gewoon, DEUR));
  const d = opzet(gewoon, DEUR);
  d.maakAdmin = () => ({
    listUsers: async () => ({ data: null, error: { message: "stuk" } }),
  });
  await assert.rejects(() => werkToegangBij({ voorvoegsel: "wi-" }, d), /listUsers: stuk/);
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
  assert.equal(r.fouten, undefined);
});

test("geen rem voor een gewone app: is de deur hernoemd of weg, of staat de app in de tijdelijke stand, dan trekt Toegang bijwerken in zoals versie 42, zonder extra leesvraag", async () => {
  // Nooit klantportaal geweest; iemand geeft de Access-app in het dashboard een nettere naam.
  const w = nepWolk({
    workerBestaat: true,
    gebruikers: [medewerker(2, "anna@winco.nl"), medewerker(3, "ex@oudbedrijf.nl")],
  });
  await richtIn(ARG, opzet(w, DEUR));
  app(w, NAMEN.deur).name = "Winco Direct";
  w.aanroepen.length = 0;
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.deepEqual(bans(w), [ID(3)], "ex@oudbedrijf.nl wordt ingetrokken");
  assert.deepEqual(r.ingetrokken, { direct: ["ex@oudbedrijf.nl"] });
  assert.equal(r.fouten, undefined);
  assert.equal(authGelezen(w, project(w).ref), 0, "geen extra leesvraag");
  // De tijdelijke stand (geen deur, alleen workers.dev): hetzelfde.
  const tijdelijk = { ...ARG, hostname: null, stand: "tijdelijk" };
  const t = nepWolk({ workerBestaat: true, gebruikers: [{ id: ID(2), email: "anna@winco.nl" }] });
  await richtIn(tijdelijk, opzet(t, DEUR));
  assert.equal(app(t, NAMEN.deur), undefined);
  t.staat.gebruikers.push({ id: ID(1), email: "vreemd@elders.nl" });
  t.aanroepen.length = 0;
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(t, DEUR));
  assert.equal(authGelezen(t, project(t).ref), 0);
  assert.deepEqual(bans(t), [ID(1)]);
  assert.deepEqual(afgemeld(t), [ID(1)]);
  // De enige extra leesvraag: geen deur EN een in te trekken account met alleen een inlog per
  // mail (zo ziet een klant eruit). Staat mail uit en was de app nooit klantportaal, dan gaat
  // het daarna gewoon als versie 42: intrekken, groen.
  t.staat.gebruikers.push(klant(5, "oud-account@elders.nl"));
  t.aanroepen.length = 0;
  const r2 = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(t, DEUR));
  assert.equal(authGelezen(t, project(t).ref), 1);
  assert.deepEqual(bans(t), [ID(5)]);
  assert.equal(r2.fouten, undefined);
  const lees = t.aanroepen.findIndex((a) => a.methode === "GET" && a.pad.endsWith("/config/auth"));
  const ban = t.aanroepen.findIndex((a) => a.methode === "updateUserById");
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
  // Een antwoord dat geen lijst is, of rijen zonder user_id: dan trekt hij bij dit portaal
  // niemand in en eindigt de run rood.
  for (const antwoord of [{ result: [] }, "fout", null, [["a", "b"]], [{ email: "x@y.nl" }]]) {
    const w = await portaalMet(lastig);
    w.staat.identiteitenAntwoord = antwoord;
    const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
    assert.match(r.fouten.join(" "), /er is niets ingetrokken/);
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

// ---------------------------------------------------------------- een klantaccount op een medewerkeradres

test("een klantaccount op een adres dat (later) van een medewerker is: Toegang bijwerken en App inrichten melden het uitdrukkelijk, ook in de droogloop, met het adres gemaskeerd, en ruimen niets op", async () => {
  // jan was klant en komt in dienst (winco.nl is het domein van de medewerkers); kees gebruikte
  // het klantvak vóór de aanmeld-hook er was. Anna logt gewoon via Cloudflare in.
  const w = await portaalMet([
    klant(1, "Jan.Jansen@Winco.nl"),
    klant(2, "kees@winco.nl"),
    klant(3, "inkoop@bloemist.nl"),
    klant(4, "oud@winco.nl"), // uitgesloten: geen medewerker, dus een gewone klant
    medewerker(5, "anna@winco.nl"),
  ]);
  const voor = JSON.stringify(w.staat.gebruikers);
  const meldingen = (r) => (r.waarschuwingen ?? []).filter((x) => /klantaccount/.test(x));
  const runs = [
    await werkToegangBij({ voorvoegsel: "wi-", droogloop: true }, opzet(w, PORTAAL)),
    await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL)),
    await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL)),
    await richtIn(ARG, opzet(w, PORTAAL)),
  ];
  for (const r of runs) {
    const m = meldingen(r);
    assert.equal(m.length, 2, JSON.stringify(r.waarschuwingen));
    assert.match(m[0], new RegExp(`direct: j\\*\\*\\*@winco\\.nl \\(id ${ID(1)}\\)`));
    assert.match(m[1], new RegExp(`direct: k\\*\\*\\*@winco\\.nl \\(id ${ID(2)}\\)`));
    assert.match(
      m[0],
      /kan deze persoon niet als medewerker inloggen.*Er is niets gewijzigd.*verwijder het account in Supabase.*Inloggen voor medewerkers/,
    );
    // Het volledige adres staat nergens in het resultaat.
    assert.doesNotMatch(JSON.stringify(r), /jan\.jansen|kees@/i);
  }
  // Niets opgeruimd: geen ban, geen afmelding, geen account gewijzigd.
  assert.deepEqual(bans(w), []);
  assert.deepEqual(afgemeld(w), []);
  assert.equal(JSON.stringify(w.staat.gebruikers), voor);
  // Lukt het lezen bij App inrichten niet, dan loopt de inrichting door en zegt ze dat.
  w.staat.identiteitenAntwoord = "kapot";
  const r = await richtIn(ARG, opzet(w, PORTAAL));
  assert.match(
    r.waarschuwingen.join(" "),
    /niet nagegaan of er klantaccounts op een adres van een medewerker staan/,
  );
  // Een gewone app krijgt deze melding en deze leesvragen nooit.
  const gewoon = nepWolk({ workerBestaat: true, gebruikers: [klant(1, "jan@winco.nl")] });
  await richtIn(ARG, opzet(gewoon, DEUR));
  gewoon.aanroepen.length = 0;
  const g = await richtIn(ARG, opzet(gewoon, DEUR));
  assert.deepEqual(meldingen(g), []);
  assert.equal(gewoon.aanroepen.filter((a) => a.methode === "listUsers").length, 0);
});
