/**
 * Een gewone app (zonder klantportaal, en nooit klantportaal geweest) is exact versie 42:
 * dezelfde aanroepen in dezelfde volgorde, hetzelfde resultaat, dezelfde regel op stdout en
 * dezelfde exitcode, ook als een leesvraag hapert. Anders dan regressie-42.test.mjs werkt deze
 * test niet met een vastgelegde verwachting: hij haalt de code van versie 42 zelf (commit
 * 8687e69, tag stack-v42) met `git archive` naar een tijdelijke map, draait daar en hier
 * dezelfde scenario's en legt de twee naast elkaar. De tijdelijke map gaat na afloop weg.
 * Zonder git of zonder die commit (een losse kopie van beheer/, zie "Los van de template")
 * worden de tests overgeslagen; regressie-42.test.mjs blijft dan de bewaker.
 *
 * Wat de vergelijking dekt:
 *   - de scenario's van regressie-scenarios.mjs en X1 tot en met X4 hieronder;
 *   - de drie gevallen waarin een eerdere versie van 43 afweek (H6 tot en met H8): een gewone
 *     app zonder deur met een vreemd mailaccount, met inloggen per mail met de hand aangezet en
 *     zonder, en een Access op de Worker met een adres dat iemand er met de hand bij zette;
 *   - haperingen: in elk van de stromen H1 tot en met H8 faalt elke leesvraag één keer met 429
 *     en één keer met 500 (Cloudflare, Supabase, de gebruikerslijst en gh);
 *   - het script zelf als proces (Toegang bijwerken), met stdout en de exitcode.
 * Wat bewust verschilt, staat in de laatste test: alleen tekst van een paar foutmeldingen, en
 * een app die "constructor" heet.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as nuScript from "./inrichten-cloudflare.mjs";
import { cloudflareClient, valideerVoorvoegsel } from "./lib/cloudflare.mjs";
import { supabaseBeheer } from "./lib/supabase.mjs";
import { nepWolk } from "./nep-wolk.mjs";
import { draaiScenarios } from "./regressie-scenarios.mjs";

/** Versie 42 van de template (tag stack-v42). */
const VERSIE_42 = "8687e697980cb847468d58c0d3ba51cbf3afd615";
const hier = fileURLToPath(new URL(".", import.meta.url));
let v42 = null;
let map = null;
// Opruimen, ook als een test faalt of het laden halverwege stopte.
after(() => {
  if (map) rmSync(map, { recursive: true, force: true });
});
try {
  map = realpathSync(mkdtempSync(join(tmpdir(), "beheer-v42-")));
  const tar = execFileSync("git", ["archive", VERSIE_42, "beheer", "scripts/lib"], {
    cwd: resolve(hier, ".."),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  execFileSync("tar", ["-x", "-C", map], { input: tar });
  symlinkSync(join(hier, "node_modules"), join(map, "beheer", "node_modules"));
  const laad = (b) => import(pathToFileURL(join(map, "beheer", b)).href);
  const script = await laad("inrichten-cloudflare.mjs");
  v42 = {
    richtIn: script.richtIn,
    werkToegangBij: script.werkToegangBij,
    tweedeDoorgang: script.tweedeDoorgang,
    ruimOp: script.ruimOp,
    leesArgumenten: script.leesArgumenten,
    uitvoerRegel: script.uitvoerRegel,
    // Zo maakte versie 42 de regel op stdout: altijd "gelukt" als er geen fout was.
    eindstatus: (modus, resultaat) => ({ status: "gelukt", modus, ...resultaat }),
    valideerVoorvoegsel: (await laad("lib/cloudflare.mjs")).valideerVoorvoegsel,
    cloudflareClient: (await laad("lib/cloudflare.mjs")).cloudflareClient,
    supabaseBeheer: (await laad("lib/supabase.mjs")).supabaseBeheer,
    nepWolk: (await laad("nep-wolk.mjs")).nepWolk,
  };
} catch {
  v42 = null;
}
const nu = {
  richtIn: nuScript.richtIn,
  werkToegangBij: nuScript.werkToegangBij,
  tweedeDoorgang: nuScript.tweedeDoorgang,
  ruimOp: nuScript.ruimOp,
  leesArgumenten: nuScript.leesArgumenten,
  uitvoerRegel: nuScript.uitvoerRegel,
  eindstatus: nuScript.eindstatus,
  valideerVoorvoegsel,
  cloudflareClient,
  supabaseBeheer,
  nepWolk,
};
const sla = v42 ? false : "geen git of geen commit van versie 42 in deze kopie";

const GROEPEN = {
  klant: { domeinen: ["klant.nl"], uitsluiten: ["jan@klant.nl"] },
  stagetwo: { adressen: ["info@stagetwo.nl"] },
  entra: { idp_groepen: ["Verkoop"] },
};
const G2 = { klant: GROEPEN.klant, stagetwo: GROEPEN.stagetwo };
const ARG = {
  app: "start",
  hostname: "start.klant.nl",
  worker: "kl-start",
  repo: "klant-org/start",
  voorvoegsel: "kl-",
  droogloop: false,
};
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Scenario's naast regressie-scenarios.mjs. Geeft per stap de aanroepen en het resultaat. */
async function extra(m) {
  const uit = {};
  const opzet = (w, toegang, meer = {}) => ({
    cf: m.cloudflareClient({
      fetchFn: w.fetchFn,
      token: "cf-token",
      accountId: "acc",
      teamDomein: "stagetwo",
    }),
    supabase: m.supabaseBeheer({
      fetchFn: w.fetchFn,
      token: "sb-token",
      orgSlug: "klant",
      slaap: async () => {},
    }),
    maakAdmin: w.maakAdmin,
    gh: w.gh,
    wachtOpDiscovery: async () => {},
    toegang,
    accountId: "acc",
    wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
    maskeer: () => {},
    ...meer,
  });
  const plat = (a) => {
    const body = a.body instanceof FormData ? "<multipart>" : a.body;
    if (a.soort === "fetch")
      return { s: a.soort, m: a.methode, url: a.url, body, headers: a.headers };
    if (a.soort === "admin")
      return { s: a.soort, m: a.methode, url: a.url, sleutel: a.sleutel, body };
    return { s: a.soort, args: a.args, invoer: a.invoer };
  };
  const stap = async (naam, w, werk) => {
    w.aanroepen.length = 0;
    let r;
    try {
      r = { resultaat: await werk() };
    } catch (f) {
      r = { fout: f.message };
    }
    uit[naam] = JSON.parse(
      JSON.stringify({ aanroepen: w.aanroepen.map(plat), ...r }, (_k, v) =>
        v === undefined ? null : v,
      ),
    );
  };

  // X1. 2300 accounts (drie pagina's), met identiteiten en metadata zoals de echte lijst die
  //     heeft, hoofdletters, een leeg adres, een verlopen ban; plus IdP-groepen.
  {
    const gebruikers = [
      {
        id: ID(1),
        email: "Piet@Klant.NL",
        identities: [{ provider: "custom:cloudflare", identity_data: { email: "piet@klant.nl" } }],
        app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
      },
      {
        id: ID(2),
        email: "jan@klant.nl",
        app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
      },
      {
        id: ID(3),
        email: "vreemd@elders.nl",
        identities: [{ provider: "email", identity_data: { email: "vreemd@elders.nl" } }],
        app_metadata: { provider: "email", providers: ["email"] },
      },
      { id: ID(4), email: "" },
      { id: ID(5), email: "weg@elders.nl", banned_until: "2020-01-01T00:00:00Z" },
      { id: ID(6), email: "info@stagetwo.nl", banned_until: "2126-01-01T00:00:00Z" },
      { id: ID(7), email: "verkoper@partner.nl" },
      ...Array.from({ length: 2300 }, (_, i) => ({
        id: ID(100 + i),
        email: i % 7 ? `m${i}@klant.nl` : `x${i}@elders.nl`,
      })),
    ];
    const toegang = {
      groepen: GROEPEN,
      apps: { start: { groepen: ["klant", "entra"], $opmerking: "x" }, ander: ["stagetwo"] },
      testaccounts: { start: ["Scherm@Klant.nl"] },
    };
    const w = m.nepWolk({ gebruikers, workerBestaat: true });
    const meer = {
      groepenIdp: { type: "azureAD", id: "idp-entra" },
      idps: ["idp-entra"],
      smtpWachtwoord: "re_StaatInDeOmgeving",
      captchaGeheim: "0xStaatInDeOmgeving",
    };
    await stap("X1a inrichten met testdatabase, IdP-groepen en SMTP-secret in de omgeving", w, () =>
      m.richtIn({ ...ARG, testdatabase: true }, opzet(w, toegang, meer)),
    );
    await stap("X1b toegang bijwerken, 2300 accounts", w, () =>
      m.werkToegangBij({ voorvoegsel: "kl-" }, opzet(w, toegang, meer)),
    );
    await stap("X1c toegang bijwerken droogloop", w, () =>
      m.werkToegangBij({ voorvoegsel: "kl-", droogloop: true }, opzet(w, toegang, meer)),
    );
    await stap("X1d tweede doorgang droogloop", w, () =>
      m.tweedeDoorgang({ ...ARG, droogloop: true }, opzet(w, toegang, meer)),
    );
    await stap("X1e opruimen zonder app, droogloop", w, () =>
      m.ruimOp({ ...ARG, app: null, opruimen: true, droogloop: true }, opzet(w, toegang, meer)),
    );
  }
  // X2. Een project waar de auth-instellingen met de hand zijn verbogen (e-mail aan,
  //     autoconfirm uit, eigen SMTP en limieten): wordt precies hetzelfde teruggezet?
  {
    const toegang = { groepen: G2, apps: { start: ["klant"] } };
    const w = m.nepWolk({ workerBestaat: true });
    await m.richtIn(ARG, opzet(w, toegang));
    for (const ref of Object.keys(w.staat.auth)) {
      Object.assign(w.staat.auth[ref], {
        external_email_enabled: true,
        mailer_autoconfirm: false,
        smtp_host: "smtp.elders.nl",
        rate_limit_email_sent: 5,
        security_captcha_enabled: true,
        security_manual_linking_enabled: true,
        mailer_otp_exp: 60,
      });
    }
    await stap("X2 inrichten op verbogen auth-instellingen", w, () =>
      m.richtIn(ARG, opzet(w, toegang)),
    );
  }
  // X3. Fout halverwege (auth-config weigert), daarna opnieuw.
  {
    const toegang = { groepen: G2, apps: { start: ["klant"] } };
    let stuk = true;
    const w = m.nepWolk({
      faal: (methode, pad) =>
        stuk && methode === "PATCH" && pad.endsWith("/config/auth")
          ? { status: 500, message: "stuk" }
          : null,
    });
    await stap("X3a inrichten, auth-config faalt", w, () => m.richtIn(ARG, opzet(w, toegang)));
    stuk = false;
    await stap("X3b inrichten opnieuw", w, () => m.richtIn(ARG, opzet(w, toegang)));
  }
  // X4. Een gewone app die nooit klantportaal was, waarvan de deur in Cloudflare is hernoemd,
  //     is weggehaald, of er nooit was (de tijdelijke stand), en waar iemand in te trekken is:
  //     een vertrokken medewerker met een inlog via Cloudflare, en een account zonder metadata.
  for (const [naam, verbuig, arg] of [
    ["hernoemd", (w) => (w.staat.apps.find((a) => a.name === "kl-start").name = "Start"), ARG],
    [
      "weggehaald",
      (w) =>
        w.staat.apps.splice(
          w.staat.apps.findIndex((a) => a.name === "kl-start"),
          1,
        ),
      ARG,
    ],
    ["tijdelijke stand", () => {}, { ...ARG, hostname: null, stand: "tijdelijk" }],
  ]) {
    const toegang = { groepen: G2, apps: { start: ["klant"] } };
    const w = m.nepWolk({
      workerBestaat: true,
      gebruikers: [
        {
          id: ID(1),
          email: "piet@klant.nl",
          app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
        },
        {
          id: ID(2),
          email: "ex@oudbedrijf.nl",
          identities: [
            { provider: "custom:cloudflare", identity_data: { email: "ex@oudbedrijf.nl" } },
          ],
          app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
        },
        { id: ID(3), email: "vreemd@elders.nl" },
      ],
    });
    await m.richtIn(arg, opzet(w, toegang));
    verbuig(w);
    await stap(`X4a deur ${naam}: toegang bijwerken trekt in`, w, () =>
      m.werkToegangBij({ voorvoegsel: "kl-" }, opzet(w, toegang)),
    );
    await stap(`X4b deur ${naam}: nog een keer, niets meer te doen`, w, () =>
      m.werkToegangBij({ voorvoegsel: "kl-" }, opzet(w, toegang)),
    );
    await stap(`X4c deur ${naam}: droogloop van App inrichten`, w, () =>
      m.richtIn({ ...arg, droogloop: true }, opzet(w, toegang)),
    );
  }
  return uit;
}

test("regressie: regressie-42.json komt echt uit de code van versie 42", {
  skip: sla,
}, async () => {
  const opnieuw = JSON.parse(JSON.stringify(await draaiScenarios(v42)));
  const vast = JSON.parse(readFileSync(new URL("./regressie-42.json", import.meta.url), "utf8"));
  assert.deepEqual(opnieuw, vast);
});

test("regressie: 2300 accounts, IdP-groepen, geheimen van het klantportaal in de omgeving, verbogen auth-instellingen, een fout halverwege en een gewone app waarvan de deur ontbreekt of hernoemd is (met iemand in te trekken) geven exact de aanroepen van versie 42", {
  skip: sla,
}, async () => {
  const [oud, nieuw] = [await extra(v42), await extra(nu)];
  const aantal = Object.values(oud).reduce((n, s) => n + s.aanroepen.length, 0);
  assert.ok(aantal > 150, "de scenario's doen echt iets");
  // Verwachte fouten: de nagebootste storing (X3a), en een hernoemde deur, waar App inrichten
  // toen en nu op stopt ("bewaakt ... al").
  const onverwacht = Object.entries(oud).filter(
    ([, s]) => s.fout && !/stuk|zonder voorvoegsel\) bewaakt/.test(s.fout),
  );
  assert.deepEqual(onverwacht, []);
  // Geen enkel verschil, ook niet in tekst: aanroepen en het hele resultaat zijn gelijk.
  for (const naam of Object.keys(oud)) {
    assert.deepEqual(nieuw[naam].aanroepen, oud[naam].aanroepen, naam);
    assert.deepEqual(nieuw[naam], oud[naam], naam);
  }
  // De scenario's zonder deur trekken echt iemand in (anders bewijst de vergelijking niets).
  for (const soort of ["hernoemd", "weggehaald", "tijdelijke stand"]) {
    const bans = oud[`X4a deur ${soort}: toegang bijwerken trekt in`].aanroepen.filter(
      (a) => a.m === "updateUserById",
    );
    assert.equal(bans.length, 2, soort);
  }
  assert.deepEqual(Object.keys(nieuw), Object.keys(oud));
});

test("regressie: een gewone app naast een klantportaal in hetzelfde bestand krijgt dezelfde aanroepen als naast een gewone app", async () => {
  const draai = async (ander) => {
    const toegang = { groepen: G2, apps: { start: ["klant"], portaal: ander } };
    const w = nepWolk({
      workerBestaat: true,
      gebruikers: [{ id: ID(1), email: "vreemd@elders.nl" }],
    });
    const d = () => ({
      cf: cloudflareClient({
        fetchFn: w.fetchFn,
        token: "cf-token",
        accountId: "acc",
        teamDomein: "stagetwo",
      }),
      supabase: supabaseBeheer({
        fetchFn: w.fetchFn,
        token: "sb-token",
        orgSlug: "klant",
        slaap: async () => {},
      }),
      maakAdmin: w.maakAdmin,
      gh: w.gh,
      wachtOpDiscovery: async () => {},
      toegang,
      accountId: "acc",
      wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
      maskeer: () => {},
      smtpWachtwoord: "re_x",
      captchaGeheim: "0x_y",
    });
    const r1 = await nuScript.richtIn(ARG, d());
    const r2 = await nuScript.werkToegangBij({ voorvoegsel: "kl-", app: "start" }, d());
    const r3 = await nuScript.werkToegangBij({ voorvoegsel: "kl-" }, d());
    const kaal = (a) =>
      JSON.stringify([
        a.soort,
        a.methode,
        a.url ?? a.args,
        a.body instanceof FormData ? "" : a.body,
        a.invoer,
      ]);
    // De policy van de groep van de andere app heet in beide gevallen hetzelfde.
    return JSON.stringify([w.aanroepen.map(kaal), r1, r2, r3]);
  };
  const gewoon = await draai(["stagetwo"]);
  const portaal = await draai({
    groepen: ["stagetwo"],
    klantportaal: true,
    afzender: "noreply@klant.nl",
    turnstile_sitekey: "0x4AAAAAAAOpenbareSleutel",
  });
  assert.equal(portaal, gewoon);
});

// ---------------------------------------------------------------- haperingen

/**
 * De drie kanalen van de nep-wolk, waarbij de zoveelste leesvraag (over alle kanalen geteld)
 * faalt met `status`. Een leesvraag is een GET naar Cloudflare of Supabase, het lezen van de
 * gebruikers of de providers, en een `gh ... list` of `gh api`. De mislukte vraag staat ook in
 * `w.aanroepen`, zodat de volgorde te vergelijken blijft. `teller.n` telt de leesvragen.
 */
function metHapering(w, welke, status) {
  const teller = { n: 0 };
  const raak = () => teller.n++ === welke;
  const fetchFn = (url, opties = {}) => {
    if ((opties.method ?? "GET") !== "GET" || !raak()) return w.fetchFn(url, opties);
    w.aanroepen.push({ soort: "fetch", methode: "GET", url, body: `hapert ${status}` });
    return Promise.resolve({
      ok: false,
      status,
      statusText: status === 429 ? "Too Many Requests" : "Internal Server Error",
      text: async () => JSON.stringify({ message: "hapert" }),
    });
  };
  const maakAdmin = (url, sleutel) => {
    const echt = w.maakAdmin(url, sleutel);
    const stuk = (methode) => {
      w.aanroepen.push({ soort: "admin", methode, url, sleutel, body: `hapert ${status}` });
      return { data: null, error: { message: `hapert ${status}` } };
    };
    return {
      ...echt,
      customProviders: {
        ...echt.customProviders,
        listProviders: async () =>
          raak() ? stuk("listProviders") : echt.customProviders.listProviders(),
      },
      listUsers: async (o) => (raak() ? stuk("listUsers") : echt.listUsers(o)),
    };
  };
  const gh = async (args, o) => {
    const lees = args.includes("list") || args[0] === "api";
    if (!lees || !raak()) return w.gh(args, o);
    w.aanroepen.push({ soort: "gh", args, invoer: `hapert ${status}` });
    throw new Error(`gh ${args.slice(0, 3).join(" ")} gaf 1: HTTP ${status}`);
  };
  return { fetchFn, maakAdmin, gh, teller };
}

const GEWOON = { groepen: G2, apps: { start: ["klant"] } };
const VREEMDE = {
  id: ID(7),
  email: "indringer@elders.example",
  identities: [{ provider: "email", identity_data: { email: "indringer@elders.example" } }],
  app_metadata: { provider: "email", providers: ["email"] },
};
const EX = {
  id: ID(8),
  email: "ex@oudbedrijf.nl",
  app_metadata: { provider: "custom:cloudflare", providers: ["custom:cloudflare"] },
};
const haalWeg = (w, naam) =>
  w.staat.apps.splice(
    w.staat.apps.findIndex((a) => a.name === naam),
    1,
  );

/**
 * De stromen van een gewone app. `klaar` zet de wereld klaar (met de code van dezelfde versie),
 * `draai` is de run die wordt vergeleken, `modus` is hoe het script hem op stdout noemt.
 */
const STROMEN = {
  "H1 App inrichten op een bestaande app": {
    modus: "inrichten",
    draai: (m, d) => m.richtIn(ARG, d),
  },
  "H2 App inrichten, droogloop": {
    modus: "inrichten",
    draai: (m, d) => m.richtIn({ ...ARG, droogloop: true }, d),
  },
  "H3 App inrichten met testdatabase": {
    modus: "inrichten",
    arg: { ...ARG, testdatabase: true },
    draai: (m, d) => m.richtIn({ ...ARG, testdatabase: true }, d),
  },
  "H4 tweede doorgang": {
    modus: "tweedeDoorgang",
    draai: (m, d) => m.tweedeDoorgang(ARG, d),
  },
  "H5 Toegang bijwerken met testdatabase en iemand in te trekken": {
    modus: "toegang",
    arg: { ...ARG, testdatabase: true },
    gebruikers: [EX, VREEMDE],
    draai: (m, d) => m.werkToegangBij({ voorvoegsel: "kl-" }, d),
  },
  // De drie gevallen van de derde aanval (doel 6).
  "H6 zonder deur, inloggen per mail met de hand aangezet, een vreemde met een mailaccount: Toegang bijwerken":
    {
      modus: "toegang",
      gebruikers: [VREEMDE],
      verbuig: (w) => {
        haalWeg(w, "kl-start");
        for (const ref of Object.keys(w.staat.auth))
          Object.assign(w.staat.auth[ref], { external_email_enabled: true });
      },
      draai: (m, d) => m.werkToegangBij({ voorvoegsel: "kl-" }, d),
      bans: 1,
    },
  "H7 zonder deur, inloggen per mail uit, een vreemde met een mailaccount: Toegang bijwerken": {
    modus: "toegang",
    gebruikers: [VREEMDE],
    verbuig: (w) => haalWeg(w, "kl-start"),
    draai: (m, d) => m.werkToegangBij({ voorvoegsel: "kl-" }, d),
    bans: 1,
  },
  "H8 de Access op de Worker heeft met de hand een extra adres: App inrichten": {
    modus: "inrichten",
    verbuig: (w) => {
      const worker = w.staat.apps.find((a) => a.name === "kl-start-worker");
      worker.destinations = [...worker.destinations, { type: "public", uri: "demo.klant.nl" }];
    },
    draai: (m, d) => m.richtIn(ARG, d),
    extraAdres: "demo.klant.nl",
  },
};

const diensten = (m, w, kanalen = w) => ({
  cf: m.cloudflareClient({
    fetchFn: kanalen.fetchFn,
    token: "cf-token",
    accountId: "acc",
    teamDomein: "stagetwo",
  }),
  supabase: m.supabaseBeheer({
    fetchFn: kanalen.fetchFn,
    token: "sb-token",
    orgSlug: "klant",
    slaap: async () => {},
  }),
  maakAdmin: kanalen.maakAdmin,
  gh: kanalen.gh,
  wachtOpDiscovery: async () => {},
  toegang: GEWOON,
  accountId: "acc",
  wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
  maskeer: () => {},
  // De geheimen van een klantportaal staan in de omgeving (een andere app van dezelfde klant
  // kan een klantportaal zijn); een gewone app doet er niets mee.
  smtpWachtwoord: "re_StaatInDeOmgeving",
  captchaGeheim: "0xStaatInDeOmgeving",
});

/** Eén run van een stroom: de aanroepen, het resultaat, stdout en de exitcode. */
async function draaiStroom(m, stroom, welke = -1, status = 0) {
  const w = m.nepWolk({ workerBestaat: true, gebruikers: stroom.gebruikers ?? [] });
  await m.richtIn(stroom.arg ?? ARG, diensten(m, w));
  stroom.verbuig?.(w);
  w.aanroepen.length = 0;
  const kanalen = metHapering(w, welke, status);
  let eind;
  try {
    eind = m.eindstatus(stroom.modus, await stroom.draai(m, diensten(m, w, kanalen)));
  } catch (fout) {
    eind = { status: "mislukt", modus: stroom.modus, reden: fout.message };
  }
  return {
    w,
    leesvragen: kanalen.teller.n,
    beeld: JSON.parse(
      JSON.stringify(
        {
          aanroepen: w.aanroepen.map((a) => ({
            s: a.soort,
            m: a.methode,
            url: a.url,
            args: a.args,
            body: a.body instanceof FormData ? "<multipart>" : a.body,
            invoer: a.invoer,
            sleutel: a.sleutel,
          })),
          stdout: m.uitvoerRegel(eind),
          exitcode: eind.status === "gelukt" ? 0 : 1,
        },
        (_k, v) => (v === undefined ? null : v),
      ),
    ),
  };
}

for (const [naam, stroom] of Object.entries(STROMEN)) {
  test(`gewone app is exact versie 42: ${naam}, ook als een leesvraag hapert (429 en 500 op elke leesvraag)`, {
    skip: sla,
  }, async () => {
    const [oud, nieuw] = [await draaiStroom(v42, stroom), await draaiStroom(nu, stroom)];
    assert.deepEqual(nieuw.beeld, oud.beeld);
    assert.equal(oud.beeld.exitcode, 0, "zonder hapering is de run groen, toen en nu");
    assert.equal(nieuw.leesvragen, oud.leesvragen, "geen leesvraag meer of minder dan op 42");
    assert.ok(oud.leesvragen >= 3);
    if (stroom.bans !== undefined) {
      for (const run of [oud, nieuw]) {
        const bans = run.w.aanroepen.filter(
          (a) => a.methode === "updateUserById" && a.body.ban_duration !== "none",
        );
        assert.equal(bans.length, stroom.bans, "de vreemde is ingetrokken, toen en nu");
        assert.doesNotMatch(run.beeld.stdout, /"fouten"|klantportaal|App inrichten/);
      }
    }
    if (stroom.extraAdres) {
      for (const run of [oud, nieuw]) {
        const puts = run.w.aanroepen.filter(
          (a) => a.soort === "fetch" && a.methode === "PUT" && /access\/apps\//.test(a.url),
        );
        assert.equal(puts.length, 0, "geen PUT op een Access-app");
        const worker = run.w.staat.apps.find((a) => a.name === "kl-start-worker");
        assert.ok(worker.destinations.some((x) => x.uri === stroom.extraAdres));
      }
    }
    let rood = 0;
    for (let welke = 0; welke < oud.leesvragen; welke += 1) {
      for (const status of [429, 500]) {
        const a = await draaiStroom(v42, stroom, welke, status);
        const b = await draaiStroom(nu, stroom, welke, status);
        assert.deepEqual(b.beeld, a.beeld, `leesvraag ${welke + 1} hapert met ${status}`);
        rood += a.beeld.exitcode;
      }
    }
    assert.ok(rood > 0, "een hapering maakt de run echt rood (anders bewijst dit niets)");
  });
}

// ---------------------------------------------------------------- het script als proces

/**
 * Laadt vóór het script een nagebootste `fetch`: Cloudflare en de Management API van Supabase
 * uit de nep-wolk, en de admin-API van het project (supabase-js) erbij. HAPERT=<n>:<status>
 * laat de zoveelste GET falen.
 */
const VOORLADER = `
import { nepWolk } from ${JSON.stringify(pathToFileURL(join(hier, "nep-wolk.mjs")).href)};
const gebruiker = { id: "${ID(7)}", email: "indringer@elders.example", app_metadata: { provider: "email", providers: ["email"] } };
const w = nepWolk({
  workerBestaat: true,
  projecten: [{ ref: "refproef0000000000001", name: "cf-proef-cf-proef", organization_slug: "klant", status: "ACTIVE_HEALTHY" }],
});
const [welke, status] = (process.env.HAPERT ?? "-1:0").split(":").map(Number);
let n = 0;
const json = (s, body) => new Response(JSON.stringify(body), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (invoer, opties = {}) => {
  const url = String(invoer?.url ?? invoer);
  const methode = opties.method ?? invoer?.method ?? "GET";
  if (methode === "GET" && n++ === welke) return json(status, { message: "hapert" });
  const u = new URL(url);
  if (u.hostname.endsWith(".supabase.co")) {
    if (methode === "GET") return json(200, { users: [gebruiker], aud: "authenticated" });
    return json(200, gebruiker);
  }
  const a = await w.fetchFn(url, { ...opties, method: methode });
  return new Response(await a.text(), { status: a.status, headers: { "content-type": "application/json" } });
};
`;

function draaiScript(wortel, voorlader, omgeving) {
  return new Promise((klaar, mis) => {
    const kind = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(voorlader).href,
        join(wortel, "beheer", "inrichten-cloudflare.mjs"),
        "--voorvoegsel",
        "cf-proef-",
        "--toegang",
      ],
      {
        cwd: wortel,
        env: {
          PATH: process.env.PATH,
          CLOUDFLARE_PROEF_TOKEN: "cf-token",
          CLOUDFLARE_ACCOUNT_ID: "acc",
          CLOUDFLARE_TEAM_DOMAIN: "stagetwo",
          SUPABASE_ACCESS_TOKEN: "sb-token",
          SUPABASE_ORG_SLUG: "klant",
          ...omgeving,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    kind.stdout.on("data", (c) => {
      stdout += c;
    });
    kind.stderr.on("data", (c) => {
      stderr += c;
    });
    kind.on("error", mis);
    kind.on("close", (code) => klaar({ stdout, stderr, code }));
  });
}

test("gewone app is exact versie 42: het script zelf (Toegang bijwerken als proces) geeft dezelfde regel op stdout en dezelfde exitcode, ook bij een hapering; de samenvatting is een bestand erbij", {
  skip: sla,
}, async () => {
  const voorlader = join(map, "voorlader.mjs");
  writeFileSync(voorlader, VOORLADER);
  const hierWortel = resolve(hier, "..");
  const samenvatting = join(map, "samenvatting.md");
  const gevallen = ["-1:0", ...[0, 1, 2, 3, 4, 5].flatMap((i) => [`${i}:429`, `${i}:500`])];
  const paren = await Promise.all(
    gevallen.map(async (HAPERT) => [
      HAPERT,
      await draaiScript(map, voorlader, { HAPERT }),
      await draaiScript(hierWortel, voorlader, {
        HAPERT,
        ...(HAPERT === "-1:0" ? { GITHUB_STEP_SUMMARY: samenvatting } : {}),
      }),
    ]),
  );
  for (const [geval, oud, nieuw] of paren) {
    assert.match(oud.stdout, /^INRICHTING \{"status":"/, `${geval}: ${oud.stderr}`);
    assert.equal(nieuw.stdout, oud.stdout, geval);
    assert.equal(nieuw.code, oud.code, geval);
    assert.equal(nieuw.stderr, oud.stderr, geval);
  }
  const [, goed] = paren[0];
  assert.equal(goed.code, 0);
  assert.match(goed.stdout, /"ingetrokken":\{"cf-proef":\["indringer@elders\.example"\]\}/);
  assert.ok(paren.some(([, oud]) => oud.code === 1));
  // De samenvatting staat in het bestand van GitHub, niet op stdout, en noemt geen adres.
  assert.ok(existsSync(samenvatting));
  const tekst = readFileSync(samenvatting, "utf8");
  assert.match(tekst, /## Toegang bijwerken/);
  assert.match(tekst, /cf-proef: 1 ingetrokken/);
  assert.doesNotMatch(tekst, /indringer@|Wat nu|klantportaal/i);
});

test("gewone app: wat bewust verschilt van versie 42 is alleen tekst (geen klantnaam meer in een foutmelding, en een antwoord dat geen JSON is komt niet meer in de melding), plus één verbetering: een app die 'constructor' heet bestaat niet", {
  skip: sla,
}, async () => {
  // 1. De melding bij een ontbrekend of ongeldig voorvoegsel noemde een klant. Zonder dat
  //    voorbeeld is de tekst gelijk.
  for (const fout of [undefined, "KL-"]) {
    const melding = (m) => {
      try {
        m.valideerVoorvoegsel(fout);
      } catch (f) {
        return f.message;
      }
      return null;
    };
    const zonderVoorbeeld = (x) =>
      x
        .replace(/\(proef: cf-proef-, [^)]*\)/, "(proef: cf-proef-)")
        .replace(/\(bijvoorbeeld [a-z]+-\)/, "(bijvoorbeeld)");
    assert.notEqual(melding(nu), melding(v42));
    assert.equal(zonderVoorbeeld(melding(nu)), zonderVoorbeeld(melding(v42)));
  }
  // 2. Een antwoord dat geen JSON is: dezelfde aanroepen, dezelfde status in de melding,
  //    alleen de ruwe tekst (waar een geheim in kan staan) is er niet meer.
  const beeld = async (m) => {
    const w = m.nepWolk({ workerBestaat: true });
    const fetchFn = (url, o) =>
      /\/workers\/subdomain$/.test(url)
        ? Promise.resolve({
            ok: false,
            status: 502,
            statusText: "Bad Gateway",
            text: async () => "<html>proxy</html>",
          })
        : w.fetchFn(url, o);
    let fout = null;
    await m.richtIn(ARG, diensten(m, w, { ...w, fetchFn })).catch((f) => {
      fout = f.message;
    });
    return { fout, aanroepen: w.aanroepen.map((a) => [a.soort, a.methode, a.url ?? a.args]) };
  };
  const [oud, nieuw] = [await beeld(v42), await beeld(nu)];
  assert.deepEqual(nieuw.aanroepen, oud.aanroepen);
  assert.match(oud.fout, /gaf 502: <html>proxy<\/html>/);
  assert.match(nieuw.fout, /gaf 502: Bad Gateway; het antwoord was geen JSON/);
  // 3. `--app constructor`: op 42 kwam die naam door "staat in toegang.json" heen (elk object
  //    heeft een constructor), maakte de run een Supabase-project aan en overschreef hij het
  //    databasewachtwoord van de repo. Nu stopt hij vóór de eerste aanroep.
  const projectenNa = async (m) => {
    const w = m.nepWolk({ workerBestaat: true });
    const d = diensten(m, w);
    await m
      .richtIn({ ...ARG, app: "constructor", hostname: "x.klant.nl", worker: "kl-x" }, d)
      .catch(() => {});
    return w.staat.projecten.length;
  };
  assert.equal(await projectenNa(v42), 1);
  assert.equal(await projectenNa(nu), 0);
});
