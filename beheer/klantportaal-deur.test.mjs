/**
 * Klantportaal, de deur: een app staat nooit zonder deur terwijl dat niet de bedoeling was,
 * nooit zonder deur én zonder werkende klantinlog, en workers.dev en de previews blijven
 * dicht. Elke test speelt een aanval na die bij het bouwen van uitgave 43 is geprobeerd.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { controleer } from "./controle-doorsteek.mjs";
import {
  eindstatus,
  richtIn,
  ruimOp,
  tweedeDoorgang,
  werkToegangBij,
} from "./inrichten-cloudflare.mjs";
import {
  AFZENDER,
  ARG,
  app,
  auth,
  bans,
  DEUR,
  GROEPEN,
  klant,
  MET_VINKJE,
  medewerker,
  NAMEN,
  naarPortaal,
  opzet,
  PORTAAL,
  PORTAAL_APP,
  SITEKEY,
  stap,
} from "./klantportaal-opzet.mjs";
import { valideerToegang } from "./lib/toegang.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const gedekt = (w) => w.staat.apps.flatMap((a) => (a.destinations ?? []).map((x) => x.uri));

// ---------------------------------------------------------------- nooit zonder deur en zonder inlog

test("deur: een mens haalt de deur weg, niet de code: zonder vinkje blijft hij staan, wat er ook al klaarstaat of misging", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  const stuk = (wanneer) => async (args, opties) => {
    if (wanneer(args)) throw new Error(`gh ${args.slice(0, 2).join(" ")} gaf 1: HTTP 503`);
    return w.gh(args, opties);
  };
  // De eerste run mislukt NA het zetten van de variabelen (GitHub hapert bij het opruimen van
  // het oude secret). De owner ziet rood en draait opnieuw: voor hem is dat "de eerste run".
  const secrets = (args) => args[0] === "secret" && args[1] === "list";
  await assert.rejects(() => richtIn(ARG, opzet(w, PORTAAL, { gh: stuk(secrets) })), /503/);
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare,mailcode");
  // Hoe vaak hij ook draait zonder vinkje, en ook als iemand de variabelen met de hand zette:
  // de deur blijft.
  for (let run = 0; run < 4; run += 1) {
    const r = await richtIn(ARG, opzet(w, PORTAAL));
    assert.ok(app(w, NAMEN.deur), `run ${run + 1}: de deur staat er nog`);
    assert.doesNotMatch(JSON.stringify(r.stappen), /weggehaald/);
    assert.match(r.waarschuwingen.join(" "), /rol de app uit.*met het vinkje/);
  }
  // Toegang bijwerken en de tweede doorgang raken de deur evenmin.
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  await tweedeDoorgang(ARG, opzet(w, PORTAAL));
  assert.ok(app(w, NAMEN.deur));
  // Met het vinkje: een storing vóór het einde laat de deur staan (hij is de laatste aanroep).
  await assert.rejects(() => richtIn(MET_VINKJE, opzet(w, PORTAAL, { gh: stuk(secrets) })), /503/);
  assert.ok(app(w, NAMEN.deur), "ook nu staat de deur er nog");
  // Pas een run met vinkje die helemaal lukt, haalt hem weg.
  const r = await richtIn(MET_VINKJE, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur), undefined);
  assert.equal(w.aanroepen.at(-1).methode, "DELETE");
  assert.match(JSON.stringify(r.stappen), /weggehaald/);
});

test("deur: het vinkje wordt geweigerd, vóór de eerste wijziging en met uitleg, als het er vóór de run niet klaar voor stond", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  const voor = JSON.stringify([w.staat.apps, w.staat.auth, w.staat.ghVariabelen, w.staat.sql]);
  // Meteen het vinkje, zonder dat er iets klaarstaat: de run doet niets.
  w.aanroepen.length = 0;
  await assert.rejects(
    () => richtIn(MET_VINKJE, opzet(w, PORTAAL)),
    /gestopt zonder wijzigingen.*de deur gaat niet weg.*VITE_INLOGDIENST stond in omgeving production nog niet op cloudflare,mailcode.*inloggen per mail staat in Supabase nog uit.*Draai App inrichten eerst zonder het vinkje/,
  );
  assert.deepEqual(w.schrijfacties(), []);
  assert.equal(
    JSON.stringify([w.staat.apps, w.staat.auth, w.staat.ghVariabelen, w.staat.sql]),
    voor,
  );
  // Alleen de variabelen met de hand zetten (of een bouwer met schrijfrecht op de app-repo)
  // is niet genoeg: mail, SMTP en de hooks stonden nog niet.
  w.staat.ghVariabelen.production.VITE_INLOGDIENST = "cloudflare,mailcode";
  w.staat.ghVariabelen.production.VITE_TURNSTILE_SITEKEY = SITEKEY;
  await assert.rejects(
    () => richtIn(MET_VINKJE, opzet(w, PORTAAL)),
    /de deur gaat niet weg.*inloggen per mail staat in Supabase nog uit.*de mail gaat nog niet via Resend.*de aanmeld-hook staat nog niet aan.*de token-hook staat nog niet aan/,
  );
  assert.ok(app(w, NAMEN.deur));
  // En omgekeerd: alles klaargezet, maar de variabele is teruggezet.
  await richtIn(ARG, opzet(w, PORTAAL));
  w.staat.ghVariabelen.production.VITE_INLOGDIENST = "cloudflare";
  await assert.rejects(() => richtIn(MET_VINKJE, opzet(w, PORTAAL)), /VITE_INLOGDIENST stond/);
  assert.ok(app(w, NAMEN.deur));
  // Het vinkje bij een gewone app, of samen met een andere modus: geweigerd.
  await assert.rejects(
    () => richtIn(MET_VINKJE, opzet(w, DEUR)),
    /gestopt zonder wijzigingen.*alleen voor een klantportaal/,
  );
});

test("deur: klantportaal uit toegang.json gehaald: Toegang bijwerken bant geen klant, zet geen deur terug en eindigt rood tot App inrichten heeft gedraaid", async () => {
  const w = nepWolk({
    workerBestaat: true,
    gebruikers: [klant(1, "inkoop@bloemist.nl"), medewerker(2, "anna@winco.nl")],
  });
  await richtIn(ARG, opzet(w, DEUR));
  await naarPortaal(w);
  w.aanroepen.length = 0;
  // De pull request die klantportaal weghaalt wordt gemerged; Toegang bijwerken draait
  // vanzelf, App inrichten niet.
  const r = await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, DEUR));
  assert.deepEqual(bans(w), [], "geen klant is geband");
  assert.equal(app(w, NAMEN.deur), undefined, "er staat (nog) geen deur");
  const tekst = r.fouten.join(" ");
  assert.match(tekst, /inloggen per mail staat in productie nog aan/);
  assert.match(tekst, /Draai App inrichten voor direct/);
  assert.match(
    tekst,
    /zet de deur terug, zet inloggen per mail uit en meldt de klanten af \(zonder ban\)/,
  );
  assert.equal(eindstatus("toegang", r).status, "mislukt");
});

test("deur: een rare waarde of schrijfwijze van klantportaal haalt de deur nooit weg", async () => {
  const pogingen = [
    { klantportaal: "true", afzender: AFZENDER },
    { klantportaal: 1, afzender: AFZENDER },
    { klantportaal: null, afzender: AFZENDER },
    { Klantportaal: true, afzender: AFZENDER },
    { KLANTPORTAAL: true },
    { klantportaal: [true], afzender: AFZENDER },
    { klantportaal: { waarde: true }, afzender: AFZENDER },
    { klantportaal: "true", afzender: AFZENDER, turnstile_sitekey: SITEKEY },
    { klantportaal: 1, afzender: AFZENDER, captcha: false },
  ];
  for (const extra of pogingen) {
    const w = nepWolk({ workerBestaat: true });
    await richtIn(ARG, opzet(w, DEUR));
    const toegang = { groepen: GROEPEN, apps: { direct: { groepen: ["kantoor"], ...extra } } };
    assert.throws(() => valideerToegang(structuredClone(toegang)), JSON.stringify(extra));
    for (let run = 0; run < 3; run += 1) {
      await assert.rejects(() => richtIn(ARG, opzet(w, toegang)));
      await assert.rejects(() => werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, toegang)));
    }
    assert.ok(app(w, NAMEN.deur), `de deur staat er nog bij ${JSON.stringify(extra)}`);
  }
});

test("deur: een droogloop van deur naar klantportaal wijzigt niets, ook niet met het vinkje en ook niet als alles al klaarstaat", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  for (let ronde = 0; ronde < 2; ronde += 1) {
    w.aanroepen.length = 0;
    await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL));
    await richtIn({ ...MET_VINKJE, droogloop: true }, opzet(w, PORTAAL));
    await werkToegangBij({ voorvoegsel: "wi-", droogloop: true }, opzet(w, PORTAAL));
    assert.deepEqual(w.schrijfacties(), []);
    assert.ok(app(w, NAMEN.deur));
    // Daarna de echte run zonder vinkje, zodat bij de volgende droogloop alles klaarstaat.
    if (ronde === 0) await richtIn(ARG, opzet(w, PORTAAL));
  }
});

// ---------------------------------------------------------------- workers.dev en de previews

test("workers.dev: wijst de Access op de Worker naar een andere Worker (hernoemd in wrangler.jsonc), dan herstelt stap 4 dat en zegt nooit 'ongewijzigd'", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  const nieuw = { ...ARG, worker: "wi-direct-nieuw" };

  // De droogloop zegt het al.
  const droog = await richtIn({ ...nieuw, droogloop: true }, opzet(w, PORTAAL));
  assert.match(stap(droog, "4 Access op de Worker"), /omzetten naar wi-direct-nieuw\./);

  const r = await richtIn(nieuw, opzet(w, PORTAAL));
  const stap4 = stap(r, "4 Access op de Worker");
  assert.ok(!/ongewijzigd/.test(stap4), stap4);
  assert.match(stap4, /adres bijgewerkt/);
  const worker = app(w, NAMEN.worker);
  assert.equal(worker.domain, "wi-direct-nieuw.stagetwo-acc.workers.dev");
  assert.deepEqual(
    worker.destinations.map((x) => x.uri),
    ["wi-direct-nieuw.stagetwo-acc.workers.dev", "*-wi-direct-nieuw.stagetwo-acc.workers.dev"],
  );
  assert.ok(
    r.waarschuwingen.some((x) =>
      /bewaakte wi-direct\.stagetwo-acc\.workers\.dev.*verwijder/.test(x),
    ),
    "het resultaat wijst op de oude Worker, die nu zonder deur staat",
  );
  // En pas daarna, in een run met het vinkje, gaat de deur van het domein weg.
  assert.ok(app(w, NAMEN.deur));
  const r2 = await richtIn({ ...nieuw, deurWeghalen: true }, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur), undefined);
  assert.match(stap(r2, "4 Access op de Worker"), /ongewijzigd/);
  assert.ok(gedekt(w).includes("*-wi-direct-nieuw.stagetwo-acc.workers.dev"));
});

test("workers.dev: ook bij een gewone app en in de tweede doorgang wordt een verbogen Access op de Worker hersteld", async () => {
  for (const verbuig of [
    (a) => ({ ...a, domain: "iets-anders.stagetwo-acc.workers.dev" }),
    (a) => ({ ...a, destinations: [a.destinations[0]] }), // de previews eraf gehaald
    (a) => ({ ...a, destinations: [] }),
  ]) {
    for (const draai of [richtIn, tweedeDoorgang]) {
      const w = nepWolk({ workerBestaat: true });
      await richtIn(ARG, opzet(w, DEUR));
      const i = w.staat.apps.findIndex((a) => a.name === NAMEN.worker);
      w.staat.apps[i] = verbuig(w.staat.apps[i]);
      await draai(ARG, opzet(w, DEUR));
      assert.equal(app(w, NAMEN.worker).domain, "wi-direct.stagetwo-acc.workers.dev");
      assert.deepEqual(
        app(w, NAMEN.worker).destinations.map((x) => x.uri),
        ["wi-direct.stagetwo-acc.workers.dev", "*-wi-direct.stagetwo-acc.workers.dev"],
      );
    }
  }
  // Alleen een andere volgorde of hoofdletters is geen afwijking: dan wordt er niets geschreven.
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  const i = w.staat.apps.findIndex((a) => a.name === NAMEN.worker);
  w.staat.apps[i] = {
    ...w.staat.apps[i],
    domain: "WI-Direct.stagetwo-acc.workers.dev",
    // Ook met velden erbij die Cloudflare zelf toevoegt.
    destinations: [...w.staat.apps[i].destinations]
      .reverse()
      .map((d) => ({ ...d, vnet_id: null, extra: 1 })),
    self_hosted_domains: w.staat.apps[i].destinations.map((d) => d.uri),
  };
  w.aanroepen.length = 0;
  const r = await richtIn(ARG, opzet(w, DEUR));
  assert.match(stap(r, "4 Access op de Worker"), /ongewijzigd/);
  assert.ok(!w.schrijfacties().some((s) => s.startsWith("PUT cf/access/apps")));
});

test("workers.dev: Toegang bijwerken of een volgende run haalt bij een klantportaal de Access op de Worker nooit weg en maakt hem nooit leeg", async () => {
  const w = nepWolk({ workerBestaat: true });
  await naarPortaal(w);
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, PORTAAL));
  await richtIn(ARG, opzet(w, PORTAAL));
  const andereGroep = {
    groepen: { ...GROEPEN, extra: { adressen: ["hulp@bureau.nl"] } },
    apps: { direct: { ...PORTAAL_APP, groepen: ["extra"] } },
  };
  await werkToegangBij({ voorvoegsel: "wi-" }, opzet(w, andereGroep));
  const worker = app(w, NAMEN.worker);
  assert.ok(worker, "de Access op de Worker staat er");
  assert.equal(worker.policies.length, 1);
  assert.ok(!w.staat.policies.some((p) => p.decision === "bypass"));
  assert.ok(worker.destinations.some((x) => x.uri === "*-wi-direct.stagetwo-acc.workers.dev"));
});

test("workers.dev: de doorsteekcontrole met --klantportaal keurt niet goed zonder dat een preview is bekeken", async () => {
  const fetchFn = async (url) => {
    const u = String(url);
    const antwoord = (status, location) => ({
      status,
      headers: { get: (k) => (k === "location" ? (location ?? null) : null) },
      text: async () => "<html>app</html>",
    });
    if (u.startsWith("https://direct.wincoapps.com")) return antwoord(200);
    if (u.includes("wi-direct.stagetwo-acc.workers.dev"))
      return antwoord(302, "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/login/x");
    if (u.includes("supabase.co/auth/v1/authorize"))
      return antwoord(302, "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/login/y");
    return antwoord(401);
  };
  const basis = {
    fetchFn,
    hostname: "direct.wincoapps.com",
    projectRef: "abcdefghijklmnopqrst",
    anonKey: "anon",
    workersDev: "https://wi-direct.stagetwo-acc.workers.dev/",
    klantportaal: true,
  };
  const zonder = await controleer(basis);
  const gezakt = zonder.filter((x) => x.geslaagd === false);
  assert.equal(gezakt.length, 1);
  assert.match(gezakt[0].wat, /preview/);
  assert.match(gezakt[0].bewijs, /--preview-url/);
  // Met het vaste preview-adres erbij is alles bekeken en geslaagd.
  const met = await controleer({
    ...basis,
    previewUrl: "https://actueel-wi-direct.stagetwo-acc.workers.dev/",
  });
  assert.deepEqual(
    met.filter((x) => x.geslaagd === false),
    [],
  );
});

test("workers.dev: geeft Cloudflare de Access op de Worker terug met bestemmingen zonder adres (de nieuwe Worker-bestemmingen), dan volgt er geen herstel-PUT maar een duidelijke melding", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  const zonderAdres = [
    { type: "worker", worker_id: "id-van-wi-direct" },
    { type: "preview_worker", worker_id: "id-van-wi-direct" },
  ];
  for (const draai of [richtIn, tweedeDoorgang]) {
    for (let run = 0; run < 2; run += 1) {
      app(w, NAMEN.worker).destinations = structuredClone(zonderAdres);
      w.aanroepen.length = 0;
      const r = await draai(ARG, opzet(w, DEUR));
      assert.ok(!w.schrijfacties().some((s) => s.startsWith("PUT cf/access/apps/")), "geen PUT");
      assert.deepEqual(app(w, NAMEN.worker).destinations, zonderAdres, "de app is niet aangeraakt");
      const tekst = r.waarschuwingen.join(" ");
      assert.match(tekst, /bestemmingen zonder adres.*niet aangeraakt.*Controle van buitenaf/);
      assert.doesNotMatch(tekst, /staat die nu zonder deur/, "geen valse waarschuwing");
    }
  }
  const droog = await richtIn({ ...ARG, droogloop: true }, opzet(w, DEUR));
  assert.match(stap(droog, "4 Access op de Worker"), /het adres is niet te controleren/);
  // Verandert een groep, dan volgen de policies nog wel, met de bestemmingen zoals ze waren.
  const andereGroep = {
    groepen: { ...GROEPEN, extra: { adressen: ["hulp@bureau.nl"] } },
    apps: { direct: ["extra"] },
  };
  await richtIn(ARG, opzet(w, andereGroep));
  assert.deepEqual(app(w, NAMEN.worker).destinations, zonderAdres);
  const extra = w.staat.policies.find((p) => p.name === "wi-extra");
  assert.deepEqual(app(w, NAMEN.worker).policies, [{ id: extra.id, precedence: 1 }]);
});

test("een app van vóór versie 43: de inrichting leest eerst of de app de inlog van een klantportaal begrijpt, en stopt anders vóór de eerste wijziging", async () => {
  // De env-controle van versie 42 (en van de openbare template, die anders telt): één waarde
  // uit een vaste lijst. Met cloudflare,mailcode start zo'n app in de browser niet meer op.
  for (const ghBestanden of [
    { "src/lib/env.ts": "VITE_INLOGDIENST: z.enum(INLOGDIENSTEN)", ".claude/stack-version": "43" },
    {},
  ]) {
    const w = nepWolk({ workerBestaat: true, ghBestanden });
    await richtIn(ARG, opzet(w, DEUR));
    w.aanroepen.length = 0;
    await assert.rejects(
      () => richtIn(ARG, opzet(w, PORTAAL)),
      /gestopt zonder wijzigingen.*begrijpt de inlog van een klantportaal nog niet.*src\/lib\/env\.ts.*versie 43 of later/,
    );
    assert.deepEqual(w.schrijfacties(), []);
    assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare");
    const droog = await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL));
    assert.match(droog.waarschuwingen.join(" "), /de echte run stopt hierop.*begrijpt de inlog/);
  }
  // Een app op versie 43: de inrichting leest het bestand en gaat door.
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  w.aanroepen.length = 0;
  await richtIn(ARG, opzet(w, PORTAAL));
  const gelezen = w.aanroepen.filter(
    (a) => a.soort === "gh" && /contents\/src\/lib\/env\.ts$/.test(a.args[1]),
  );
  assert.equal(gelezen.length, 1);
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare,mailcode");
  // Een gewone app: de inrichting kijkt daar niet naar.
  const gewoon = nepWolk({ workerBestaat: true, ghBestanden: {} });
  await richtIn(ARG, opzet(gewoon, DEUR));
  assert.ok(!gewoon.aanroepen.some((a) => a.soort === "gh" && /env\.ts/.test(a.args.join(" "))));
});

test("previews: bij een klantportaal met een testdatabase staan de previews niet op de lijst van terugkeeradressen van productie; zonder testdatabase waarschuwt elke run", async () => {
  const domein = "https://direct.wincoapps.com/**";
  const metPreviews = `${domein},https://pr-*-wi-direct.stagetwo-acc.workers.dev/**,https://actueel-wi-direct.stagetwo-acc.workers.dev/**`;
  const metTest = { ...ARG, testdatabase: true };
  const w = nepWolk({ workerBestaat: true });
  // Als gewone app: productie en de testdatabase hebben allebei de previews, zoals altijd.
  await richtIn(metTest, opzet(w, DEUR));
  assert.equal(auth(w).uri_allow_list, metPreviews);
  // Als klantportaal: productie alleen nog het domein; de testdatabase houdt de previews.
  const r = await richtIn(metTest, opzet(w, PORTAAL));
  assert.equal(auth(w).uri_allow_list, domein);
  assert.equal(auth(w, "wi-direct-test").uri_allow_list, metPreviews);
  assert.deepEqual(r.uri_allow_list, [domein]);
  assert.doesNotMatch(r.waarschuwingen.join(" "), /geen testdatabase/);
  // Ook een latere run zonder de vlag ziet dat de testdatabase er is.
  await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(auth(w).uri_allow_list, domein);
  // Zonder testdatabase loggen de previews in bij productie: de adressen blijven, met een
  // waarschuwing in de droogloop en in elke run.
  const zonder = nepWolk({ workerBestaat: true });
  const droog = await richtIn({ ...ARG, droogloop: true }, opzet(zonder, PORTAAL));
  const echt = await richtIn(ARG, opzet(zonder, PORTAAL));
  assert.equal(auth(zonder).uri_allow_list, metPreviews);
  for (const uit of [droog, echt]) {
    assert.match(
      uit.waarschuwingen.join(" "),
      /geen testdatabase, dus de previews.*loggen in bij productie.*Geef de app een testdatabase/,
    );
  }
  // Terug naar een gewone app: de previews staan weer op de lijst, exact zoals versie 42.
  await richtIn(metTest, opzet(w, DEUR));
  assert.equal(auth(w).uri_allow_list, metPreviews);
});

test("opruimen van een klantportaal laat geen app achter op een open domein: de Worker gaat mee weg", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  await naarPortaal(w);
  assert.equal(app(w, NAMEN.deur), undefined, "het domein staat open");
  await ruimOp(ARG, opzet(w, PORTAAL));
  assert.equal(w.staat.workerBestaat, false, "er draait niets meer achter het domein");
  assert.deepEqual(w.staat.projecten, []);
});
