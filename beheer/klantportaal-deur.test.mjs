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
import { PORTAAL_MERK } from "./lib/cloudflare.mjs";
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
    assert.match(r.watNu.join(" "), /Rol de app uit.*Test achter de deur.*met het vinkje/);
  }
  // Toegang bijwerken en de tweede doorgang raken de deur evenmin.
  await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  await tweedeDoorgang(ARG, opzet(w, PORTAAL));
  assert.ok(app(w, NAMEN.deur));
  // Met het vinkje: een storing bij het nalopen laat de deur staan (hij is de enige wijziging
  // en de laatste aanroep).
  const variabelen = (args) => args[0] === "variable" && args[1] === "list";
  await assert.rejects(
    () => richtIn(MET_VINKJE, opzet(w, PORTAAL, { gh: stuk(variabelen) })),
    /503/,
  );
  assert.ok(app(w, NAMEN.deur), "ook nu staat de deur er nog");
  // Pas een run met vinkje die helemaal lukt, haalt hem weg, en doet verder niets.
  w.aanroepen.length = 0;
  const r = await richtIn(MET_VINKJE, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur), undefined);
  assert.equal(w.aanroepen.at(-1).methode, "DELETE");
  assert.deepEqual(w.schrijfacties().length, 1, "de deur weghalen is de enige wijziging");
  assert.match(JSON.stringify(r.stappen), /weggehaald/);
  assert.match(r.watNu.join(" "), /Controle van buitenaf/);
});

test("deur: het vinkje wordt geweigerd, vóór de eerste wijziging en met uitleg, als het er vóór de run niet klaar voor stond", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  const voor = JSON.stringify([w.staat.apps, w.staat.auth, w.staat.ghVariabelen, w.staat.sql]);
  // Meteen het vinkje, zonder dat er iets klaarstaat: de run doet niets.
  w.aanroepen.length = 0;
  await assert.rejects(
    () => richtIn(MET_VINKJE, opzet(w, PORTAAL)),
    /gestopt zonder wijzigingen.*de deur gaat niet weg, want er staat nog iets anders te wijzigen.*VITE_INLOGDIENST staat in omgeving production nog niet op cloudflare,mailcode.*de inloginstellingen in Supabase staan nog niet zoals de inrichting ze zet \(.*external_email_enabled.*het merk van een klantportaal nog niet.*Draai eerst App inrichten zonder vinkje en test opnieuw/,
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
    /de deur gaat niet weg.*external_email_enabled.*hook_before_user_created_enabled.*hook_custom_access_token_enabled.*smtp_host/,
  );
  assert.ok(app(w, NAMEN.deur));
  // En omgekeerd: alles klaargezet, maar de variabele is teruggezet.
  await richtIn(ARG, opzet(w, PORTAAL));
  w.staat.ghVariabelen.production.VITE_INLOGDIENST = "cloudflare";
  await assert.rejects(() => richtIn(MET_VINKJE, opzet(w, PORTAAL)), /VITE_INLOGDIENST staat/);
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
    gebruikers: [klant(1, "inkoop@bloemist.nl"), medewerker(2, "anna@voorbeeld.nl")],
  });
  await richtIn(ARG, opzet(w, DEUR));
  await naarPortaal(w);
  w.aanroepen.length = 0;
  // De pull request die klantportaal weghaalt wordt gemerged; Toegang bijwerken draait
  // vanzelf, App inrichten niet.
  const r = await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, DEUR));
  assert.deepEqual(bans(w), [], "geen klant is geband");
  assert.equal(app(w, NAMEN.deur), undefined, "er staat (nog) geen deur");
  const tekst = r.fouten.join(" ");
  assert.match(tekst, /direct: wacht op App inrichten/);
  assert.match(tekst, /Draai App inrichten voor direct/);
  assert.match(
    tekst,
    /zet de deur terug als die weg was, zet inloggen per mail uit en meldt de klanten af/,
  );
  assert.match(tekst, /de 1 klantaccounts zijn met rust gelaten en geen klant is geband/);
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
      await assert.rejects(() => werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, toegang)));
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
    await werkToegangBij({ voorvoegsel: "vb-", droogloop: true }, opzet(w, PORTAAL));
    assert.deepEqual(w.schrijfacties(), []);
    assert.ok(app(w, NAMEN.deur));
    // Daarna de echte run zonder vinkje, zodat bij de volgende droogloop alles klaarstaat.
    if (ronde === 0) await richtIn(ARG, opzet(w, PORTAAL));
  }
});

// ---------------------------------------------------------------- workers.dev en de previews

test("workers.dev: bewaakt de Access op de Worker van een klantportaal een gewenst adres niet (de Worker is hernoemd in wrangler.jsonc), dan zet stap 4 het erbij en haalt hij niets weg", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  const nieuw = { ...ARG, worker: "vb-direct-nieuw" };

  // De droogloop zegt het al.
  const droog = await richtIn({ ...nieuw, droogloop: true }, opzet(w, PORTAAL));
  assert.match(stap(droog, "4 Access op de Worker"), /gepland: vb-direct-nieuw\..* erbij zetten/);

  const r = await richtIn(nieuw, opzet(w, PORTAAL));
  assert.match(stap(r, "4 Access op de Worker"), /adres en merk klantportaal bijgewerkt/);
  assert.deepEqual(
    app(w, NAMEN.worker).destinations.map((x) => x.uri),
    [
      "vb-direct.stagetwo-acc.workers.dev",
      "*-vb-direct.stagetwo-acc.workers.dev",
      "vb-direct-nieuw.stagetwo-acc.workers.dev",
      "*-vb-direct-nieuw.stagetwo-acc.workers.dev",
    ],
    "de nieuwe adressen staan erbij, de oude zijn er nog",
  );
  assert.ok(
    r.waarschuwingen.some((x) => /vb-direct-nieuw.* niet; dat adres is erbij gezet/.test(x)),
  );
  // En pas daarna, in een run met het vinkje, gaat de deur van het domein weg.
  assert.ok(app(w, NAMEN.deur));
  await richtIn({ ...nieuw, deurWeghalen: true }, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur), undefined);
  assert.ok(gedekt(w).includes("*-vb-direct-nieuw.stagetwo-acc.workers.dev"));
});

test("workers.dev: een adres dat iemand met de hand onder de Access op de Worker zette blijft bewaakt, bij een gewone app (geen PUT, zoals versie 42) en bij een klantportaal (toevoegen, nooit vervangen)", async () => {
  const extra = "demo-vb-direct.voorbeeldapps.nl";
  const zetErbij = (w) => {
    const worker = app(w, NAMEN.worker);
    worker.destinations = [...worker.destinations, { type: "public", uri: extra }];
  };
  const puts = (w) => w.schrijfacties().filter((x) => x.startsWith("PUT cf/access/apps"));
  for (const draai of [richtIn, tweedeDoorgang]) {
    // Een gewone app: wat er ook met de adressen is gedaan, er volgt geen PUT.
    for (const verbuig of [
      zetErbij,
      (w) => (app(w, NAMEN.worker).domain = "iets-anders.stagetwo-acc.workers.dev"),
      (w) => (app(w, NAMEN.worker).destinations = []),
    ]) {
      const w = nepWolk({ workerBestaat: true });
      await richtIn(ARG, opzet(w, DEUR));
      verbuig(w);
      const voor = JSON.stringify(app(w, NAMEN.worker));
      w.aanroepen.length = 0;
      await draai(ARG, opzet(w, DEUR));
      assert.deepEqual(puts(w), []);
      assert.equal(JSON.stringify(app(w, NAMEN.worker)), voor);
    }
    // Een klantportaal waar de previews van de Access zijn afgehaald: die komen erbij, en het
    // adres dat er met de hand bij stond blijft.
    const w = nepWolk({ workerBestaat: true });
    await richtIn(ARG, opzet(w, DEUR));
    await richtIn(ARG, opzet(w, PORTAAL));
    const worker = app(w, NAMEN.worker);
    worker.destinations = [worker.destinations[0], { type: "public", uri: extra }];
    await draai(ARG, opzet(w, PORTAAL));
    assert.deepEqual(
      app(w, NAMEN.worker).destinations.map((x) => x.uri),
      ["vb-direct.stagetwo-acc.workers.dev", extra, "*-vb-direct.stagetwo-acc.workers.dev"],
    );
  }
  // Alleen een andere volgorde of hoofdletters is geen afwijking: dan wordt er niets geschreven.
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  await richtIn(ARG, opzet(w, PORTAAL));
  const i = w.staat.apps.findIndex((a) => a.name === NAMEN.worker);
  w.staat.apps[i] = {
    ...w.staat.apps[i],
    domain: "VB-Direct.stagetwo-acc.workers.dev",
    // Ook met velden erbij die Cloudflare zelf toevoegt.
    destinations: [...w.staat.apps[i].destinations]
      .reverse()
      .map((d) => ({ ...d, vnet_id: null, extra: 1 })),
    self_hosted_domains: w.staat.apps[i].destinations.map((d) => d.uri),
  };
  w.aanroepen.length = 0;
  const r = await richtIn(ARG, opzet(w, PORTAAL));
  assert.match(stap(r, "4 Access op de Worker"), /ongewijzigd/);
  assert.deepEqual(puts(w), []);
});

test("workers.dev: het vinkje haalt de deur niet weg als de Access op de Worker ontbreekt of een adres mist; de run zonder vinkje herstelt dat eerst", async () => {
  for (const verbuig of [
    (w) =>
      w.staat.apps.splice(
        w.staat.apps.findIndex((a) => a.name === NAMEN.worker),
        1,
      ),
    (w) => (app(w, NAMEN.worker).destinations = [app(w, NAMEN.worker).destinations[0]]),
  ]) {
    const w = nepWolk({ workerBestaat: true });
    await richtIn(ARG, opzet(w, DEUR));
    await richtIn(ARG, opzet(w, PORTAAL));
    verbuig(w);
    w.aanroepen.length = 0;
    await assert.rejects(
      () => richtIn(MET_VINKJE, opzet(w, PORTAAL)),
      /de deur gaat niet weg.*de Access op de Worker \(vb-direct-worker\) (ontbreekt|bewaakt \*-vb-direct\.stagetwo-acc\.workers\.dev nog niet)/,
    );
    assert.deepEqual(w.schrijfacties(), []);
    assert.ok(app(w, NAMEN.deur));
    await richtIn(ARG, opzet(w, PORTAAL));
    await richtIn(MET_VINKJE, opzet(w, PORTAAL));
    assert.equal(app(w, NAMEN.deur), undefined);
    assert.ok(gedekt(w).includes("*-vb-direct.stagetwo-acc.workers.dev"));
  }
});

test("workers.dev: Toegang bijwerken of een volgende run haalt bij een klantportaal de Access op de Worker nooit weg en maakt hem nooit leeg", async () => {
  const w = nepWolk({ workerBestaat: true });
  await naarPortaal(w);
  await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, PORTAAL));
  await richtIn(ARG, opzet(w, PORTAAL));
  const andereGroep = {
    groepen: { ...GROEPEN, extra: { adressen: ["hulp@bureau.nl"] } },
    apps: { direct: { ...PORTAAL_APP, groepen: ["extra"] } },
  };
  await werkToegangBij({ voorvoegsel: "vb-" }, opzet(w, andereGroep));
  const worker = app(w, NAMEN.worker);
  assert.ok(worker, "de Access op de Worker staat er");
  assert.equal(worker.policies.length, 1);
  assert.ok(!w.staat.policies.some((p) => p.decision === "bypass"));
  assert.ok(worker.destinations.some((x) => x.uri === "*-vb-direct.stagetwo-acc.workers.dev"));
});

test("workers.dev: de doorsteekcontrole met --klantportaal keurt niet goed zonder dat een preview is bekeken", async () => {
  const fetchFn = async (url) => {
    const u = String(url);
    const antwoord = (status, location) => ({
      status,
      headers: { get: (k) => (k === "location" ? (location ?? null) : null) },
      text: async () => "<html>app</html>",
    });
    if (u.startsWith("https://direct.voorbeeldapps.nl")) return antwoord(200);
    if (u.includes("vb-direct.stagetwo-acc.workers.dev"))
      return antwoord(302, "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/login/x");
    if (u.includes("supabase.co/auth/v1/authorize"))
      return antwoord(302, "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/login/y");
    if (u.includes("supabase.co/auth/v1/settings"))
      return {
        ...antwoord(200),
        text: async () =>
          JSON.stringify({
            external: { email: true, anonymous_users: false },
            mailer_autoconfirm: false,
          }),
      };
    if (u.includes("supabase.co/auth/v1/otp"))
      return { ...antwoord(400), text: async () => '{"error_code":"captcha_failed"}' };
    return antwoord(401);
  };
  const basis = {
    fetchFn,
    hostname: "direct.voorbeeldapps.nl",
    projectRef: "abcdefghijklmnopqrst",
    anonKey: "anon",
    workersDev: "https://vb-direct.stagetwo-acc.workers.dev/",
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
    previewUrl: "https://actueel-vb-direct.stagetwo-acc.workers.dev/",
  });
  assert.deepEqual(
    met.filter((x) => x.geslaagd === false),
    [],
  );
});

test("workers.dev: geeft Cloudflare de Access op de Worker terug met bestemmingen zonder adres (de nieuwe Worker-bestemmingen), dan raakt geen run de adressen aan, zegt een klantportaal dat hardop, en stopt het vinkje vóór wijzigingen met uitleg", async () => {
  const zonderAdres = [
    { type: "worker", worker_id: "id-van-een-andere-worker" },
    { type: "preview_worker", worker_id: "id-van-een-andere-worker" },
  ];
  // Een gewone app: zoals versie 42, geen PUT en geen woord erover.
  const gewoon = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(gewoon, DEUR));
  for (const draai of [richtIn, tweedeDoorgang]) {
    app(gewoon, NAMEN.worker).destinations = structuredClone(zonderAdres);
    gewoon.aanroepen.length = 0;
    const r = await draai(ARG, opzet(gewoon, DEUR));
    assert.ok(!gewoon.schrijfacties().some((x) => x.startsWith("PUT cf/access/apps/")));
    assert.doesNotMatch((r.waarschuwingen ?? []).join(" "), /zonder adres/);
  }
  // Een klantportaal: de adressen blijven zoals ze zijn, met een duidelijke melding.
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  app(w, NAMEN.worker).destinations = structuredClone(zonderAdres);
  const droog = await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL));
  assert.match(stap(droog, "4 Access op de Worker"), /het adres is niet te controleren/);
  for (let run = 0; run < 2; run += 1) {
    const r = await richtIn(ARG, opzet(w, PORTAAL));
    assert.deepEqual(
      app(w, NAMEN.worker).destinations,
      zonderAdres,
      "de adressen zijn niet aangeraakt",
    );
    assert.match(
      r.waarschuwingen.join(" "),
      /bestemmingen zonder adres.*niet aangeraakt.*Een run met het vinkje Deur weghalen stopt hierop/,
    );
  }
  // Het vinkje: stoppen vóór de eerste wijziging, met wat de owner in Cloudflare doet.
  w.aanroepen.length = 0;
  await assert.rejects(
    () => richtIn(MET_VINKJE, opzet(w, PORTAAL)),
    /gestopt zonder wijzigingen.*de deur gaat niet weg.*bestemmingen zonder adres.*Zet in Cloudflare \(Zero Trust, Access, Applications, vb-direct-worker\) de adressen vb-direct\.stagetwo-acc\.workers\.dev en \*-vb-direct\.stagetwo-acc\.workers\.dev als gewone bestemming/,
  );
  assert.deepEqual(w.schrijfacties(), []);
  assert.ok(app(w, NAMEN.deur), "de deur staat er nog");
  // Verandert een groep, dan volgen de policies nog wel, met de bestemmingen zoals ze waren.
  const andereGroep = {
    groepen: { ...GROEPEN, extra: { adressen: ["hulp@bureau.nl"] } },
    apps: { direct: ["extra"] },
  };
  app(gewoon, NAMEN.worker).destinations = structuredClone(zonderAdres);
  await richtIn(ARG, opzet(gewoon, andereGroep));
  assert.deepEqual(app(gewoon, NAMEN.worker).destinations, zonderAdres);
  const extra = gewoon.staat.policies.find((p) => p.name === "vb-extra");
  assert.deepEqual(app(gewoon, NAMEN.worker).policies, [{ id: extra.id, precedence: 1 }]);
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

test('de schakelaar van de app: zonder "klantportaal": true in stack.config.json stopt elke run van een klantportaal vóór de eerste wijziging, met en zonder vinkje', async () => {
  const ENV = "leesInlogdiensten(waarden.VITE_INLOGDIENST)";
  const zonder = [
    { "src/lib/env.ts": ENV },
    { "src/lib/env.ts": ENV, "stack.config.json": '{ "database": true }' },
    { "src/lib/env.ts": ENV, "stack.config.json": '{ "database": true, "klantportaal": false }' },
    // Tekst is geen schakelaar: alleen de echte sleutel met de waarde true telt.
    {
      "src/lib/env.ts": ENV,
      "stack.config.json":
        '{ "uitleg": "\\"klantportaal\\": true komt later", "klantportaal": "ja" }',
    },
    { "src/lib/env.ts": ENV, "stack.config.json": '{ "klantportaal": true, ' },
  ];
  for (const ghBestanden of zonder) {
    const w = nepWolk({ workerBestaat: true, ghBestanden });
    await richtIn(ARG, opzet(w, DEUR));
    const voor = structuredClone(w.staat);
    w.aanroepen.length = 0;
    for (const arg of [ARG, MET_VINKJE]) {
      await assert.rejects(
        () => richtIn(arg, opzet(w, PORTAAL)),
        /gestopt zonder wijzigingen.*is zelf nog geen klantportaal.*stack\.config\.json.*"klantportaal": true.*docs\/routes\/klantportaal\.md/,
      );
    }
    assert.deepEqual(w.schrijfacties(), []);
    assert.deepEqual(w.staat.apps, voor.apps);
    assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare");
    assert.ok(app(w, NAMEN.deur), "de deur staat er nog");
    const droog = await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL));
    assert.match(
      droog.waarschuwingen.join(" "),
      /de echte run stopt hierop.*is zelf nog geen klantportaal/,
    );
  }

  // Met de schakelaar leest de inrichting het bestand één keer en gaat door.
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  w.aanroepen.length = 0;
  const r = await richtIn(ARG, opzet(w, PORTAAL));
  assert.doesNotMatch(r.waarschuwingen.join(" "), /zelf nog geen klantportaal/);
  const gelezen = w.aanroepen.filter(
    (a) => a.soort === "gh" && /contents\/stack\.config\.json$/.test(a.args[1]),
  );
  assert.equal(gelezen.length, 1);

  // Een gewone app: geen leesvraag naar stack.config.json, ook niet als hij de schakelaar mist.
  const gewoon = nepWolk({ workerBestaat: true, ghBestanden: {} });
  await richtIn(ARG, opzet(gewoon, DEUR));
  assert.ok(
    !gewoon.aanroepen.some((a) => a.soort === "gh" && /stack\.config/.test(a.args.join(" "))),
  );
});

test("previews: bij een klantportaal met een testdatabase staan de previews niet op de lijst van terugkeeradressen van productie; zonder testdatabase waarschuwt elke run", async () => {
  const domein = "https://direct.voorbeeldapps.nl/**";
  const metPreviews = `${domein},https://pr-*-vb-direct.stagetwo-acc.workers.dev/**,https://actueel-vb-direct.stagetwo-acc.workers.dev/**`;
  const metTest = { ...ARG, testdatabase: true };
  const w = nepWolk({ workerBestaat: true });
  // Als gewone app: productie en de testdatabase hebben allebei de previews, zoals altijd.
  await richtIn(metTest, opzet(w, DEUR));
  assert.equal(auth(w).uri_allow_list, metPreviews);
  // Als klantportaal: productie alleen nog het domein; de testdatabase houdt de previews.
  const r = await richtIn(metTest, opzet(w, PORTAAL));
  assert.equal(auth(w).uri_allow_list, domein);
  assert.equal(auth(w, "vb-direct-test").uri_allow_list, metPreviews);
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

// ---------------------------------------------------------------- de derde aanval

test("deur: de run met het vinkje wijzigt niets behalve de deur. Staat er iets anders te wijzigen (een andere afzender in toegang.json), dan stopt hij vóór wijzigingen; nieuwe geheimen in de omgeving schrijft hij niet", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  await richtIn(ARG, opzet(w, PORTAAL)); // stap 3; stap 4: de owner test achter de deur
  const getest = structuredClone(auth(w));
  // Tussen stap 4 en stap 5 zet een pull request de afzender op een ander domein.
  const anders = {
    groepen: GROEPEN,
    apps: { direct: { ...PORTAAL_APP, afzender: "Voorbeeld <noreply@niet-geverifieerd.example>" } },
  };
  w.aanroepen.length = 0;
  await assert.rejects(
    () => richtIn(MET_VINKJE, opzet(w, anders)),
    /gestopt zonder wijzigingen.*er staat nog iets anders te wijzigen.*smtp_admin_email.*Draai eerst App inrichten zonder vinkje en test opnieuw/,
  );
  assert.deepEqual(w.schrijfacties(), []);
  assert.ok(app(w, NAMEN.deur));
  assert.deepEqual(auth(w), getest);
  // De secrets SMTP_WACHTWOORD en TURNSTILE_GEHEIM zijn intussen vervangen. De run met het
  // vinkje schrijft ze niet: wat live gaat is wat achter de deur is getest.
  const geheimen = [];
  const r = await richtIn(
    MET_VINKJE,
    opzet(w, PORTAAL, {
      smtpWachtwoord: "re_KapotteSleutel000",
      captchaGeheim: "0x4GeheimVanEenAndereWidget",
      maskeer: (x) => geheimen.push(x),
    }),
  );
  assert.equal(app(w, NAMEN.deur), undefined);
  assert.deepEqual(auth(w), getest, "geen enkele instelling is gewijzigd");
  assert.deepEqual(w.schrijfacties(), [
    `DELETE cf/access/apps/${r.stappen[0].actie.match(/\((app-\d+)\)/)[1]}`,
  ]);
  assert.doesNotMatch(JSON.stringify(r), /re_Kapotte|AndereWidget/);
});

test("deur: een app die net zo heet als iets wat de inrichting voor een klantportaal maakt (winkel en winkel-worker) wordt geweigerd, zodat het vinkje nooit de Access op de Worker van een andere app weghaalt; twee gewone apps blijven zoals op versie 42", () => {
  for (const staart of ["worker", "inlog", "publiek", "test", "test-inlog"]) {
    for (const [a, b] of [
      [["kantoor"], { ...PORTAAL_APP }],
      [{ ...PORTAAL_APP }, ["kantoor"]],
    ]) {
      assert.throws(
        () => valideerToegang({ groepen: GROEPEN, apps: { winkel: a, [`winkel-${staart}`]: b } }),
        new RegExp(
          `app "winkel-${staart}" en app "winkel": de naam "winkel-${staart}" gebruikt de inrichting zelf`,
        ),
      );
    }
    // Twee gewone apps: geen nieuwe weigering.
    valideerToegang({
      groepen: GROEPEN,
      apps: { winkel: ["kantoor"], [`winkel-${staart}`]: ["kantoor"] },
    });
  }
  valideerToegang({ groepen: GROEPEN, apps: { winkel: ["kantoor"], portaal: { ...PORTAAL_APP } } });
});

test("deur: bij het sluiten van een portaal komt de deur EERST terug, vóór de auth-config, het kenmerk en het afmelden; mislukt er daarna iets, dan staat het domein nooit zonder deur", async () => {
  const w = nepWolk({ workerBestaat: true, gebruikers: [klant(1, "inkoop@bloemist.nl")] });
  await richtIn(ARG, opzet(w, DEUR));
  await naarPortaal(w);
  assert.equal(app(w, NAMEN.deur), undefined);
  // Terug achter de deur; het markeren van de klanten mislukt.
  let kapot = true;
  const fetchFn = (url, opties) =>
    kapot && /database\/query$/.test(url) && /update auth\.users/.test(opties?.body ?? "")
      ? Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Fout",
          text: async () => JSON.stringify({ message: "Failed to run sql query" }),
        })
      : w.fetchFn(url, opties);
  w.aanroepen.length = 0;
  await assert.rejects(() => richtIn(ARG, opzet({ ...w, fetchFn }, DEUR)), /500/);
  assert.ok(app(w, NAMEN.deur), "de deur staat er, ook al is de run rood");
  const acties = w.schrijfacties();
  const deur = acties.indexOf("POST cf/access/apps self_hosted");
  const config = acties.findIndex(
    (x) => x.startsWith("PATCH sb/projects/") && x.endsWith("/config/auth"),
  );
  assert.ok(deur !== -1 && deur < config, `de deur (${deur}) komt vóór de auth-config (${config})`);
  // De volgende run maakt het af; het merk gaat pas dan weg.
  assert.equal(app(w, NAMEN.worker).custom_deny_message, PORTAAL_MERK);
  kapot = false;
  const r = await richtIn(ARG, opzet(w, DEUR));
  assert.equal(auth(w).external_email_enabled, false);
  assert.equal(app(w, NAMEN.worker).custom_deny_message, "");
  assert.match(stap(r, "4 Access op de Worker"), /merk klantportaal weggehaald/);
  assert.match(r.watNu.join(" "), /is dicht.*Start Toegang bijwerken opnieuw/);
});
