/**
 * Klantportaal, de deur: een app staat nooit zonder deur terwijl dat niet de bedoeling was,
 * nooit zonder deur én zonder werkende klantinlog, en workers.dev en de previews blijven
 * dicht. Elke test speelt een aanval na die bij het bouwen van uitgave 43 is geprobeerd.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { controleer } from "./controle-doorsteek.mjs";
import { richtIn, tweedeDoorgang, werkToegangBij } from "./inrichten-cloudflare.mjs";
import {
  AFZENDER,
  ARG,
  app,
  auth,
  bans,
  DEUR,
  GROEPEN,
  klant,
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

test("deur: faalt GitHub (of welke stap ook) tijdens de overgang naar klantportaal, dan staat de deur er nog", async () => {
  // Run 1 van de overgang: GitHub weigert de variabelen.
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  const stuk = (wanneer) => async (args, opties) => {
    if (wanneer(args)) throw new Error(`gh ${args.slice(0, 2).join(" ")} gaf 1: HTTP 503`);
    return w.gh(args, opties);
  };
  const variabele = (args) => args[0] === "variable" && args[1] === "set";
  await assert.rejects(() => richtIn(ARG, opzet(w, PORTAAL, { gh: stuk(variabele) })), /503/);
  assert.ok(app(w, NAMEN.deur), "de deur staat er nog");
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare");

  // Run 1 lukt nu; de deur blijft, want productie is nog gebouwd zonder mail-inlog.
  await richtIn(ARG, opzet(w, PORTAAL));
  assert.ok(app(w, NAMEN.deur));

  // Run 2: elke storing bij GitHub ná de variabelen laat de deur ook staan, want de deur is
  // de allerlaatste stap.
  const secrets = (args) => args[0] === "secret" && args[1] === "list";
  await assert.rejects(() => richtIn(ARG, opzet(w, PORTAAL, { gh: stuk(secrets) })), /503/);
  assert.ok(app(w, NAMEN.deur), "ook nu staat de deur er nog");

  // Pas een run die helemaal lukt, haalt hem weg; en dan toont productie de klantinlog.
  await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur), undefined);
  assert.equal(w.staat.ghVariabelen.production.VITE_INLOGDIENST, "cloudflare,mailcode");
  assert.equal(auth(w).external_email_enabled, true);
});

test("deur: de deur gaat nooit weg in dezelfde run waarin productie op de mail-inlog wordt gezet", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  const r = await richtIn(ARG, opzet(w, PORTAAL));
  assert.ok(app(w, NAMEN.deur));
  assert.ok(
    r.waarschuwingen.some((x) => /rol de app opnieuw uit/.test(x)),
    "het resultaat zegt dat de app eerst uitgerold moet worden",
  );
  // Zet iemand de variabele met de hand terug, dan begint het opnieuw: weer een run erbij.
  w.staat.ghVariabelen.production.VITE_INLOGDIENST = "cloudflare";
  await richtIn(ARG, opzet(w, PORTAAL));
  assert.ok(app(w, NAMEN.deur), "de variabele is in deze run gezet: de deur blijft");
  await richtIn(ARG, opzet(w, PORTAAL));
  assert.equal(app(w, NAMEN.deur), undefined);
});

test("deur: klantportaal uit toegang.json gehaald: Toegang bijwerken bant niemand en zegt dat App inrichten eerst moet draaien", async () => {
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
  assert.deepEqual(r.niet_ingetrokken, ["direct"]);
  const tekst = r.waarschuwingen.join(" ");
  assert.match(tekst, /NIEMAND INGETROKKEN/);
  assert.match(tekst, /Draai eerst App inrichten voor direct/);
  assert.match(tekst, /zet de deur terug en inloggen per mail uit/);
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

test("deur: een droogloop van deur naar klantportaal wijzigt niets, ook niet als de tweede run de deur zou weghalen", async () => {
  const w = nepWolk({ workerBestaat: true });
  await richtIn(ARG, opzet(w, DEUR));
  for (let ronde = 0; ronde < 2; ronde += 1) {
    w.aanroepen.length = 0;
    await richtIn({ ...ARG, droogloop: true }, opzet(w, PORTAAL));
    await werkToegangBij({ voorvoegsel: "wi-", droogloop: true }, opzet(w, PORTAAL));
    assert.deepEqual(w.schrijfacties(), []);
    assert.ok(app(w, NAMEN.deur));
    // Daarna de eerste echte run, zodat de volgende droogloop vóór de tweede run staat.
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
  // En pas daarna, in de tweede run, gaat de deur van het domein weg.
  assert.ok(app(w, NAMEN.deur));
  const r2 = await richtIn(nieuw, opzet(w, PORTAAL));
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
    destinations: [...w.staat.apps[i].destinations].reverse(),
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
