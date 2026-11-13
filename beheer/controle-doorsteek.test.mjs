import assert from "node:assert/strict";
import { test } from "node:test";
import { adressenVoor, controleer } from "./controle-doorsteek.mjs";
import { cloudflareClient } from "./lib/cloudflare.mjs";
import { supabaseBeheer } from "./lib/supabase.mjs";
import { nepWolk } from "./nep-wolk.mjs";

const ACCESS = "https://stagetwo.cloudflareaccess.com/cdn-cgi/access/login/cf-proef.stagetwo.nl";

/** Een nep-internet: per adres (zonder query) een status en eventueel een doorverwijzing. */
function nepNet(routes) {
  const bezocht = [];
  async function fetchFn(url, opties = {}) {
    bezocht.push({ url, headers: opties.headers ?? {} });
    const sleutel = url.split("?")[0];
    const route = routes[sleutel] ?? { status: 404 };
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
      direct: { groepen: ["kantoor"], klantportaal: true, afzender: "a@winco.nl", captcha: false },
    },
  };
  assert.deepEqual(await adressenVoor(arg, d(portaal)), {
    hostname: "direct.wincoapps.com",
    projectRef: "refaaaaaaaaaaaaaaaaa",
    anonKey: "anon-refaaaaaaaaaaaaaaaaa",
    workersDev: "https://wi-direct.stagetwo-acc.workers.dev/",
    previewUrl: "https://actueel-wi-direct.stagetwo-acc.workers.dev/",
    klantportaal: true,
    team: "stagetwo.cloudflareaccess.com",
  });
  assert.deepEqual(
    gemaskeerd,
    ["geheim-sr-refaaaaaaaaaaaaaaaaa"],
    "de service role blijft uit het logboek",
  );
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
        supabase: { projecten: async () => [], sleutels: async () => ({}) },
      }),
    /draai eerst App inrichten/,
  );
});
