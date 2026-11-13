import assert from "node:assert/strict";
import { test } from "node:test";
import { controleer } from "./controle-doorsteek.mjs";

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

test("klantportaal: zonder workers.dev-adres is de controle gezakt, niet overgeslagen", async () => {
  const { fetchFn } = nepNet(PORTAAL);
  const rapport = await controleer({
    ...OPTIES,
    workersDev: undefined,
    klantportaal: true,
    fetchFn,
  });
  const [workersDev] = uitkomst(rapport, "AE6");
  assert.equal(workersDev.geslaagd, false);
  assert.match(workersDev.bewijs, /bij een klantportaal verplicht/);
  // Zonder klantportaal blijft dat een overgeslagen controle, zoals altijd.
  const gewoon = await controleer({
    ...OPTIES,
    workersDev: undefined,
    fetchFn: nepNet(DICHT).fetchFn,
  });
  assert.equal(uitkomst(gewoon, "AE6")[0].geslaagd, null);
});

test("zonder --klantportaal is een open domein nog steeds gezakt (AE2)", async () => {
  const { fetchFn } = nepNet(PORTAAL);
  const rapport = await controleer({ ...OPTIES, fetchFn });
  assert.equal(uitkomst(rapport, "AE2")[0].geslaagd, false);
  assert.equal(uitkomst(rapport, "KP1").length, 0);
});
