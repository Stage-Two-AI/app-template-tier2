import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adressenVoor, controleer, rapportTekst } from "./controle-doorsteek.mjs";
import { cloudflareClient } from "./lib/cloudflare.mjs";
import { supabaseBeheer } from "./lib/supabase.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const ACCESS = "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/login/cf-proef.stagetwo.nl";

/** Een nep-internet: per adres (zonder query) een status en eventueel een doorverwijzing. */
function nepNet(routes) {
  const bezocht = [];
  async function fetchFn(url, opties = {}) {
    bezocht.push({ url, headers: opties.headers ?? {}, methode: opties.method ?? "GET" });
    const sleutel = url.split("?")[0];
    // Een willekeurig diep pad (`/controle-<hex>/<hex>`) krijgt het antwoord van de voorpagina
    // van dat adres, tenzij de test er een eigen antwoord voor geeft (`<adres>*`).
    const u = new URL(url);
    const diep = u.pathname.startsWith("/controle-");
    const route = routes[sleutel] ??
      (diep ? (routes[`${u.origin}/*`] ?? routes[`${u.origin}/`]) : null) ?? { status: 404 };
    if (route.fout) throw new Error(route.fout);
    return {
      status: route.status,
      headers: new Headers(route.naar ? { location: route.naar } : {}),
      text: async () => route.body ?? "",
    };
  }
  return { fetchFn, bezocht };
}

const DICHT = {
  "https://cf-proef.stagetwo.nl/": { status: 302, naar: ACCESS },
  "https://abcdefghijklmnopqrst.supabase.co/auth/v1/authorize": {
    status: 302,
    naar: "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc/authorization?x=1",
  },
  "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc/authorization": {
    status: 302,
    naar: ACCESS,
  },
  "https://cf-proef.stagetwo-acc.workers.dev/": { status: 302, naar: ACCESS },
  "https://0f1e2d3c-cf-proef.stagetwo-acc.workers.dev/": { status: 302, naar: ACCESS },
  "https://pr-1-cf-proef.stagetwo-acc.workers.dev/": { status: 302, naar: ACCESS },
  "https://abcdefghijklmnopqrst.supabase.co/rest/v1/proef_zonder_grant": {
    status: 401,
    body: '{"message":"permission denied for table proef_zonder_grant"}',
  },
  // De openbare instellingen van de inlogdienst: een gewone app, inloggen per mail uit.
  "https://abcdefghijklmnopqrst.supabase.co/auth/v1/settings": {
    status: 200,
    body: JSON.stringify({
      external: { email: false, anonymous_users: false },
      mailer_autoconfirm: true,
    }),
  },
};
const SETTINGS = "https://abcdefghijklmnopqrst.supabase.co/auth/v1/settings";
const OTP = "https://abcdefghijklmnopqrst.supabase.co/auth/v1/otp";
const instellingen = (email, autoconfirm, anoniem = false) => ({
  status: 200,
  body: JSON.stringify({
    external: { email, anonymous_users: anoniem },
    mailer_autoconfirm: autoconfirm,
  }),
});
const CAPTCHA_WEIGERT = {
  status: 400,
  body: JSON.stringify({
    code: 400,
    error_code: "captcha_failed",
    msg: "captcha protection: request disallowed (no captcha_token found)",
  }),
};

const OPTIES = {
  hostname: "cf-proef.stagetwo.nl",
  projectRef: "abcdefghijklmnopqrst",
  anonKey: "anon-sleutel",
  workersDev: "https://cf-proef.stagetwo-acc.workers.dev/",
  versieUrl: "https://0f1e2d3c-cf-proef.stagetwo-acc.workers.dev/",
  previewUrl: "https://pr-1-cf-proef.stagetwo-acc.workers.dev/",
  tabelZonderGrant: "proef_zonder_grant",
};

function uitkomst(rapport, ae) {
  return rapport.filter((r) => r.ae === ae);
}

test("alles dicht: elke controle slaagt, met bewijs", async () => {
  const { fetchFn } = nepNet(DICHT);
  const rapport = await controleer({ ...OPTIES, fetchFn });
  assert.ok(rapport.length >= 6);
  for (const r of rapport) {
    assert.equal(r.geslaagd, true, `${r.ae} ${r.wat}: ${r.bewijs}`);
    assert.ok(r.bewijs.length > 0);
  }
});

test("AE2 zakt als de app zonder login bereikbaar is", async () => {
  const { fetchFn } = nepNet({ ...DICHT, "https://cf-proef.stagetwo.nl/": { status: 200 } });
  const [deur] = uitkomst(await controleer({ ...OPTIES, fetchFn }), "AE2");
  assert.equal(deur.geslaagd, false);
  assert.match(deur.bewijs, /200/);
});

test("AE2 zakt als Supabase zonder toegang een code teruggeeft", async () => {
  const { fetchFn } = nepNet({
    ...DICHT,
    "https://abcdefghijklmnopqrst.supabase.co/auth/v1/authorize": {
      status: 302,
      naar: "https://cf-proef.stagetwo.nl/?code=gestolen",
    },
  });
  const supa = uitkomst(await controleer({ ...OPTIES, fetchFn }), "AE2")[1];
  assert.equal(supa.geslaagd, false);
  assert.match(supa.bewijs, /code/);
});

test("AE6 zakt als het versie-adres van productie de app zonder login toont", async () => {
  const { fetchFn } = nepNet({
    ...DICHT,
    "https://0f1e2d3c-cf-proef.stagetwo-acc.workers.dev/": { status: 200 },
  });
  const ae6 = uitkomst(await controleer({ ...OPTIES, fetchFn }), "AE6");
  assert.equal(
    ae6.some((r) => !r.geslaagd),
    true,
  );
});

test("AE6 slaagt als het workers.dev-adres helemaal niet bestaat", async () => {
  const { fetchFn } = nepNet({
    ...DICHT,
    "https://cf-proef.stagetwo-acc.workers.dev/": { fout: "getaddrinfo ENOTFOUND" },
  });
  const [workersDev] = uitkomst(await controleer({ ...OPTIES, fetchFn }), "AE6");
  assert.equal(workersDev.geslaagd, true);
  assert.match(workersDev.bewijs, /niet bereikbaar/);
});

test("AE8 zakt als een tabel zonder grant gegevens teruggeeft", async () => {
  const { fetchFn } = nepNet({
    ...DICHT,
    "https://abcdefghijklmnopqrst.supabase.co/rest/v1/proef_zonder_grant": {
      status: 200,
      body: "[]",
    },
  });
  const [ae8] = uitkomst(await controleer({ ...OPTIES, fetchFn }), "AE8");
  assert.equal(ae8.geslaagd, false);
});

test("AE8 stuurt alleen de anon-sleutel mee, nooit een andere", async () => {
  const { fetchFn, bezocht } = nepNet(DICHT);
  await controleer({ ...OPTIES, fetchFn });
  const rest = bezocht.find((b) => b.url.includes("/rest/v1/"));
  assert.equal(rest.headers.apikey, "anon-sleutel");
});

test("volgt geen doorverwijzingen automatisch: elke stap is zichtbaar", async () => {
  const { fetchFn, bezocht } = nepNet(DICHT);
  await controleer({ ...OPTIES, fetchFn });
  assert.ok(bezocht.some((b) => b.url.includes("/sso/oidc/abc/authorization")));
});

test("zonder optionele adressen worden die controles overgeslagen en gemeld", async () => {
  const { fetchFn } = nepNet(DICHT);
  const rapport = await controleer({
    ...OPTIES,
    versieUrl: undefined,
    previewUrl: undefined,
    fetchFn,
  });
  const overgeslagen = rapport.filter((r) => r.geslaagd === null);
  assert.equal(overgeslagen.length, 2);
});

// ---------------------------------------------------------------- klantportaal

const PORTAAL = {
  ...DICHT,
  "https://cf-proef.stagetwo.nl/": { status: 200, body: "<html>" },
  [SETTINGS]: instellingen(true, false),
  [OTP]: CAPTCHA_WEIGERT,
};

test("klantportaal: het domein is open en workers.dev, het versie-adres en de preview zijn dicht", async () => {
  const { fetchFn } = nepNet(PORTAAL);
  const rapport = await controleer({ ...OPTIES, klantportaal: true, fetchFn });
  for (const r of rapport) assert.equal(r.geslaagd, true, `${r.ae} ${r.wat}: ${r.bewijs}`);
  const [open] = uitkomst(rapport, "KP1");
  assert.match(open.wat, /het domein is open/);
  assert.match(open.bewijs, /200/);
  assert.equal(uitkomst(rapport, "AE6").length, 2);
  assert.equal(uitkomst(rapport, "AE5").length, 1);
  // De inlog voor medewerkers loopt nog steeds langs de loginpagina van Access.
  assert.equal(uitkomst(rapport, "AE2").length, 1);
  assert.match(uitkomst(rapport, "AE2")[0].wat, /inlogroute Supabase/);
});

test("klantportaal: KP1 zakt als er nog een deur van Access op het domein staat, of als het domein niets geeft", async () => {
  for (const route of [
    { status: 302, naar: ACCESS },
    { status: 403 },
    { status: 404 },
    { status: 500 },
    { fout: "ENOTFOUND" },
  ]) {
    const { fetchFn } = nepNet({ ...PORTAAL, "https://cf-proef.stagetwo.nl/": route });
    const [open] = uitkomst(await controleer({ ...OPTIES, klantportaal: true, fetchFn }), "KP1");
    assert.equal(open.geslaagd, false, JSON.stringify(route));
  }
  const { fetchFn } = nepNet({
    ...PORTAAL,
    "https://cf-proef.stagetwo.nl/": { status: 302, naar: ACCESS },
  });
  const [open] = uitkomst(await controleer({ ...OPTIES, klantportaal: true, fetchFn }), "KP1");
  assert.match(open.bewijs, /er staat nog een deur/);
});

test("klantportaal: workers.dev en de preview open is nog steeds gezakt", async () => {
  for (const adres of [OPTIES.workersDev, OPTIES.versieUrl, OPTIES.previewUrl]) {
    const { fetchFn } = nepNet({ ...PORTAAL, [adres]: { status: 200 } });
    const rapport = await controleer({ ...OPTIES, klantportaal: true, fetchFn });
    const gezakt = rapport.filter((r) => r.geslaagd === false);
    assert.equal(gezakt.length, 1, adres);
    assert.match(gezakt[0].ae, /AE5|AE6/);
  }
});

test("klantportaal: zonder workers.dev-adres of zonder preview-adres is de controle gezakt, niet overgeslagen", async () => {
  const { fetchFn } = nepNet(PORTAAL);
  for (const [veld, ae, vlag] of [
    ["workersDev", "AE6", "--workers-dev"],
    ["previewUrl", "AE5", "--preview-url"],
  ]) {
    const rapport = await controleer({ ...OPTIES, [veld]: undefined, klantportaal: true, fetchFn });
    const [regel] = uitkomst(rapport, ae);
    assert.equal(regel.geslaagd, false, veld);
    assert.ok(regel.bewijs.includes(`bij een klantportaal verplicht (${vlag})`), regel.bewijs);
    // Zonder klantportaal blijft dat een overgeslagen controle, zoals altijd.
    const gewoon = await controleer({
      ...OPTIES,
      [veld]: undefined,
      fetchFn: nepNet(DICHT).fetchFn,
    });
    assert.equal(uitkomst(gewoon, ae)[0].geslaagd, null, veld);
  }
});

test("klantportaal: een goedkeuring zonder dat één preview is bekeken bestaat niet", async () => {
  // Alles dicht en het domein open, maar geen preview-adres opgegeven: pr-12-<worker>... kan
  // wagenwijd open staan zonder dat deze controle het ziet. Dan is het rapport gezakt.
  const { fetchFn } = nepNet(PORTAAL);
  const rapport = await controleer({
    ...OPTIES,
    previewUrl: undefined,
    versieUrl: undefined,
    klantportaal: true,
    fetchFn,
  });
  const gezakt = rapport.filter((r) => r.geslaagd === false);
  assert.deepEqual(
    gezakt.map((r) => r.wat),
    ["preview zonder login"],
  );
});

test("zonder --klantportaal is een open domein nog steeds gezakt (AE2)", async () => {
  const { fetchFn } = nepNet(PORTAAL);
  const rapport = await controleer({ ...OPTIES, fetchFn });
  assert.equal(uitkomst(rapport, "AE2")[0].geslaagd, false);
  assert.equal(uitkomst(rapport, "KP1").length, 0);
});

test("klantportaal: 'dicht' is alleen een doorverwijzing naar de loginpagina van Access; een typfout in een adres (onbereikbaar of 404) is gezakt, niet goedgekeurd", async () => {
  // De echte adressen staan wagenwijd open; de opgegeven adressen bevatten een typfout.
  const open = {
    ...PORTAAL,
    [OPTIES.workersDev]: { status: 200 },
    [OPTIES.previewUrl]: { status: 200 },
  };
  for (const route of [
    { status: 404 }, // workers.dev: "There is nothing here yet"
    { fout: "getaddrinfo ENOTFOUND" },
    { status: 401 },
    { status: 403 },
    { status: 302, naar: "https://elders.voorbeeld.test/cdn-cgi/access/login/x" },
    { status: 302, naar: "https://stagetwo.cloudflareaccess.com/iets-anders" },
    { status: 302, naar: "http://stagetwo.cloudflareaccess.com/cdn-cgi/access/login/x" },
    { status: 302, naar: "https://nep.cloudflareaccess.com.kwaad.test/cdn-cgi/access/login/x" },
  ]) {
    const { fetchFn } = nepNet({
      ...open,
      "https://cf-prof.stagetwo-acc.workers.dev/": route,
      "https://pr-1-cf-proef.stagetwoacc.workers.dev/": route,
    });
    const rapport = await controleer({
      ...OPTIES,
      klantportaal: true,
      fetchFn,
      workersDev: "https://cf-prof.stagetwo-acc.workers.dev/",
      previewUrl: "https://pr-1-cf-proef.stagetwoacc.workers.dev/",
    });
    const gezakt = rapport.filter((r) => r.geslaagd === false).map((r) => r.wat);
    assert.deepEqual(gezakt, ["workers.dev-adres", "preview zonder login"], JSON.stringify(route));
    assert.match(
      uitkomst(rapport, "AE5")[0].bewijs,
      /onbekend: geen doorverwijzing naar de loginpagina van Access.*klopt het adres/,
    );
  }
  // Kent de inrichting het team, dan telt alleen de loginpagina van dát team.
  const { fetchFn } = nepNet(PORTAAL);
  const goed = await controleer({
    ...OPTIES,
    klantportaal: true,
    fetchFn,
    team: "stagetwo.cloudflareaccess.com",
  });
  assert.deepEqual(
    goed.filter((r) => r.geslaagd === false),
    [],
  );
  const ander = await controleer({
    ...OPTIES,
    klantportaal: true,
    fetchFn,
    team: "anderteam.cloudflareaccess.com",
  });
  assert.equal(ander.filter((r) => r.geslaagd === false).length, 3);
  // Zonder klantportaal blijft de controle zoals hij was (een adres dat niet bestaat is dicht).
  const gewoon = await controleer({
    ...OPTIES,
    workersDev: "https://bestaat-niet.workers.dev/",
    fetchFn: nepNet(DICHT).fetchFn,
  });
  assert.equal(uitkomst(gewoon, "AE6")[0].geslaagd, true);
});

test("de knop: de controle zoekt zelf de adressen op die de inrichting kent (domein, workers.dev, de vaste preview, het project, de openbare sleutel, klantportaal of niet); niemand typt iets", async () => {
  const w = nepWolk({
    projecten: [
      {
        ref: "refaaaaaaaaaaaaaaaaa",
        name: "wi-direct",
        organization_slug: "winco",
        status: "ACTIVE_HEALTHY",
      },
    ],
  });
  const gemaskeerd = [];
  const d = (toegang) => ({
    cf: cloudflareClient({
      fetchFn: w.fetchFn,
      token: "t",
      accountId: "acc",
      teamDomein: "stagetwo",
    }),
    supabase: supabaseBeheer({ fetchFn: w.fetchFn, token: "t", orgSlug: "winco" }),
    toegang,
    maskeer: (x) => gemaskeerd.push(x),
  });
  const groepen = { kantoor: { domeinen: ["winco.nl"] } };
  const arg = {
    app: "direct",
    voorvoegsel: "wi-",
    hostname: "direct.wincoapps.com",
    worker: "wi-direct",
    stand: "standaard",
  };
  const portaal = {
    groepen,
    apps: {
      direct: { groepen: ["kantoor"], klantportaal: true, afzender: "a@klant.nl", captcha: false },
    },
  };
  assert.deepEqual(await adressenVoor(arg, d(portaal)), {
    hostname: "direct.wincoapps.com",
    projectRef: "refaaaaaaaaaaaaaaaaa",
    anonKey: "sb_publishable_refaaaaaaaaaaaaaaaaa",
    workersDev: "https://wi-direct.stagetwo-acc.workers.dev/",
    previewUrl: "https://actueel-wi-direct.stagetwo-acc.workers.dev/",
    klantportaal: true,
    captcha: false,
    team: "stagetwo.cloudflareaccess.com",
  });
  // De service-role-sleutel wordt niet opgehaald: de lijst sleutels zonder `reveal`, en er
  // valt dus ook niets te maskeren.
  assert.deepEqual(gemaskeerd, []);
  const sleutels = w.aanroepen.filter((a) => /api-keys/.test(a.url ?? ""));
  assert.equal(sleutels.length, 1);
  assert.doesNotMatch(sleutels[0].url, /reveal/);
  // Alleen lezen.
  assert.deepEqual(w.schrijfacties(), []);
  const gewoon = await adressenVoor(arg, d({ groepen, apps: { direct: ["kantoor"] } }));
  assert.equal(gewoon.klantportaal, false);
  // De tijdelijke stand: workers.dev is dan het adres van de app zelf.
  const tijdelijk = await adressenVoor(
    { ...arg, hostname: null, stand: "tijdelijk" },
    d({ groepen, apps: { direct: ["kantoor"] } }),
  );
  assert.equal(tijdelijk.hostname, "wi-direct.stagetwo-acc.workers.dev");
  assert.equal(tijdelijk.workersDev, undefined);
  await assert.rejects(
    () => adressenVoor({ ...arg, app: "bestaat-niet" }, d(portaal)),
    /staat niet in beheer\/toegang\.json/,
  );
  await assert.rejects(
    () =>
      adressenVoor(arg, {
        ...d(portaal),
        supabase: { projecten: async () => [], openbareSleutel: async () => "x" },
      }),
    /draai eerst App inrichten/,
  );
});

// ---------------------------------------------------------------- de derde aanval

test("een willekeurig diep pad: staat onder workers.dev of de preview een pad open terwijl de voorpagina naar Access gaat (een extra Access-app met een bypass), dan is de controle gezakt", async () => {
  for (const adres of [OPTIES.workersDev, OPTIES.previewUrl, OPTIES.versieUrl]) {
    const { fetchFn, bezocht } = nepNet({
      ...PORTAAL,
      [`${new URL(adres).origin}/*`]: { status: 200, body: "<html>open</html>" },
    });
    const rapport = await controleer({ ...OPTIES, klantportaal: true, fetchFn });
    const gezakt = rapport.filter((r) => r.geslaagd === false);
    assert.equal(gezakt.length, 1, adres);
    assert.match(
      gezakt[0].bewijs,
      /voorpagina: 302 naar .*; diep pad \/controle-[0-9a-f]{8}\/[0-9a-f]{8}: 200/,
    );
    // Elke run een ander pad.
    const diep = bezocht.map((b) => b.url).filter((u) => u.includes("/controle-"));
    assert.equal(diep.length, 3);
    assert.equal(new Set(diep.map((u) => new URL(u).pathname)).size, 3);
  }
  // Ook bij een gewone app: het domein zelf heeft een open pad.
  const { fetchFn } = nepNet({
    ...DICHT,
    "https://cf-proef.stagetwo.nl/*": { status: 200, body: "<html>" },
  });
  const [deur] = uitkomst(await controleer({ ...OPTIES, fetchFn }), "AE2");
  assert.equal(deur.geslaagd, false);
});

test("de inlogdienst: een klantportaal waar geen klant kan inloggen (inloggen per mail uit), waar een adres niet bevestigd hoeft, waar anoniem aanmelden aan staat of waar de captcha uit staat, is gezakt", async () => {
  for (const [route, code] of [
    [{ [SETTINGS]: instellingen(false, false) }, "KP2"],
    [{ [SETTINGS]: instellingen(true, true) }, "KP2"],
    [{ [SETTINGS]: instellingen(true, false, true) }, "KP2"],
    [{ [SETTINGS]: { status: 401 } }, "KP2"],
    [{ [SETTINGS]: { status: 200, body: "<html>" } }, "KP2"],
    // Captcha uit: Supabase Auth klaagt dan over het ontbrekende adres, niet over de captcha.
    [{ [OTP]: { status: 400, body: '{"error_code":"validation_failed"}' } }, "KP3"],
    [{ [OTP]: { status: 200, body: "{}" } }, "KP3"],
    [{ [OTP]: { status: 429, body: "{}" } }, "KP3"],
    [{ [OTP]: { fout: "ENOTFOUND" } }, "KP3"],
  ]) {
    const { fetchFn } = nepNet({ ...PORTAAL, ...route });
    const rapport = await controleer({ ...OPTIES, klantportaal: true, fetchFn });
    assert.deepEqual(
      rapport.filter((r) => r.geslaagd === false).map((r) => r.ae),
      [code],
      JSON.stringify(route),
    );
  }
  // De aanvraag voor de captcha-controle noemt geen adres: er gaat nooit een mail uit.
  const { fetchFn, bezocht } = nepNet(PORTAAL);
  const rapport = await controleer({ ...OPTIES, klantportaal: true, fetchFn });
  assert.equal(uitkomst(rapport, "KP2")[0].bewijs, "e-mail aan, bevestigen aan, anoniem uit");
  const otp = bezocht.filter((b) => b.url === OTP);
  assert.equal(otp.length, 1);
  assert.equal(otp[0].methode, "POST");
  assert.equal(otp[0].headers.apikey, "anon-sleutel");
  // Staat de captcha volgens toegang.json uit, dan is die controle overgeslagen, niet groen.
  const zonder = await controleer({ ...OPTIES, klantportaal: true, captcha: false, fetchFn });
  assert.equal(uitkomst(zonder, "KP3")[0].geslaagd, null);
  // Een gewone app waar iemand inloggen per mail met de hand aanzette: gezakt.
  const gewoon = nepNet({ ...DICHT, [SETTINGS]: instellingen(true, true) });
  const [ae9] = uitkomst(await controleer({ ...OPTIES, fetchFn: gewoon.fetchFn }), "AE9");
  assert.equal(ae9.geslaagd, false);
  assert.match(ae9.bewijs, /e-mail aan/);
});

test("geen regel die altijd groen is: de tabel zonder grant wordt alleen gecontroleerd als hij is opgegeven (de proef); het rapport zegt wat de owner nu doet", async () => {
  const { fetchFn, bezocht } = nepNet(PORTAAL);
  const rapport = await controleer({
    ...OPTIES,
    tabelZonderGrant: undefined,
    klantportaal: true,
    fetchFn,
  });
  assert.equal(uitkomst(rapport, "AE8").length, 0);
  assert.ok(!bezocht.some((b) => b.url.includes("/rest/v1/")));
  assert.deepEqual(
    rapport.map((r) => r.ae),
    ["KP1", "AE2", "AE6", "AE6", "AE5", "KP2", "KP3"],
  );
  const goed = rapportTekst("Controle van buitenaf: direct (klantportaal)", rapport, {
    klantportaal: true,
  });
  assert.match(goed, /^## Controle van buitenaf: direct \(klantportaal\)\n\nGeslaagd\./);
  assert.match(
    goed,
    /Wat nu\*\*\n\n1\. Alles klopt: alleen het domein is open\. Log zelf nog een keer in per mail/,
  );
  const open = nepNet({ ...PORTAAL, [OPTIES.previewUrl]: { status: 200 } });
  const slecht = rapportTekst(
    "x",
    await controleer({ ...OPTIES, klantportaal: true, fetchFn: open.fetchFn }),
    { klantportaal: true },
  );
  assert.match(slecht, /\*\*Gezakt:\*\* 1 van de 8 controles/);
  assert.match(slecht, /Er is een adres open dat dicht hoort te zijn\. Draai App inrichten/);
});

const hier = fileURLToPath(new URL(".", import.meta.url));
const wortel = resolve(hier, "..");

test("de knop als proces: haalt de service-role-sleutel niet op, zet geen sleutel op stdout, en schrijft zijn rapport zelf naar de samenvatting van de run", () => {
  const map = mkdtempSync(join(tmpdir(), "controle-knop-"));
  try {
    const voorlader = join(map, "voorlader.mjs");
    const gevraagd = join(map, "gevraagd.txt");
    writeFileSync(
      voorlader,
      `import { appendFileSync } from "node:fs";
import { nepWolk } from ${JSON.stringify(pathToFileURL(join(hier, "nep-wolk.mjs")).href)};
const w = nepWolk({ projecten: [{ ref: "refproef0000000000001", name: "cf-proef-cf-proef", organization_slug: "klant", status: "ACTIVE_HEALTHY" }] });
globalThis.fetch = async (url, opties) => {
  const u = new URL(url);
  appendFileSync(${JSON.stringify(gevraagd)}, String(url) + "\\n");
  if (u.hostname === "api.cloudflare.com" || u.hostname === "api.supabase.com") return w.fetchFn(url, opties);
  if (u.pathname === "/auth/v1/settings") return new Response(JSON.stringify({ external: { email: false, anonymous_users: false }, mailer_autoconfirm: true }), { status: 200 });
  return new Response(null, { status: 302, headers: { location: "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/login/x" } });
};
`,
    );
    const samenvatting = join(map, "samenvatting.md");
    const uit = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(voorlader).href,
        "beheer/controle-doorsteek.mjs",
        "--voorvoegsel",
        "cf-proef-",
        "--app",
        "cf-proef",
      ],
      {
        cwd: wortel,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_ACTIONS: "true",
          GITHUB_STEP_SUMMARY: samenvatting,
          CLOUDFLARE_PROEF_TOKEN: "cf-token",
          CLOUDFLARE_ACCOUNT_ID: "acc",
          CLOUDFLARE_TEAM_DOMAIN: "stagetwo",
          SUPABASE_ACCESS_TOKEN: "sb-token",
          SUPABASE_ORG_SLUG: "klant",
        },
      },
    );
    assert.equal(uit.status, 0, uit.stderr + uit.stdout);
    assert.doesNotMatch(uit.stdout, /add-mask|geheim-sr|service_role/);
    assert.doesNotMatch(readFileSync(gevraagd, "utf8"), /reveal/);
    const tekst = readFileSync(samenvatting, "utf8");
    assert.match(tekst, /## Controle van buitenaf: cf-proef\n\nGeslaagd\./);
    assert.match(tekst, /\| AE9 \| inloggen per mail staat uit \| ✓ \|/);
    assert.doesNotMatch(tekst, /geheim-sr|sb-token|cf-token/);
    // De controle zelf gebruikt de service role nergens.
    assert.doesNotMatch(
      readFileSync(join(hier, "controle-doorsteek.mjs"), "utf8"),
      /serviceRole|sleutels\(/,
    );
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
});
