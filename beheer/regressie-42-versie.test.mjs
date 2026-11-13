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
 *   - het script zelf als proces (Toegang bijwerken), met stdout en de exitcode;
 *   - de brede vergelijkingen van de vierde aanval (onderaan): een storing op elke aanroep
 *     (elke methode, negen soorten fouten, elf scenario's), handwerk van de klant in zes
 *     modi, 63 varianten van toegang.json, en het script als proces in zes modi en negen
 *     omgevingen (stdout, stderr, exitcode, ::add-mask:: en de samenvatting).
 * Wat bewust verschilt, staat in de tests "wat bewust verschilt" en "wat bewust anders is":
 * alleen tekst van een paar foutmeldingen, een app die "constructor" heet, de optie
 * --deur-weghalen, en `klantportaal: false` dat nu geldig is.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
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
import { valideerToegang } from "./lib/toegang.mjs";
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
    valideerToegang: (await laad("lib/toegang.mjs")).valideerToegang,
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
  valideerToegang,
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

test("gewone app is exact versie 42: het script zelf (Toegang bijwerken als proces) geeft dezelfde regel op stdout en dezelfde exitcode, ook bij een hapering, en schrijft geen eigen samenvatting (die schrijft de workflow)", {
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
  // Zonder klantportaal schrijft het script geen samenvatting, net als 42: de workflow doet dat.
  assert.equal(existsSync(samenvatting), false);
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

// ---------------------------------------------------------------- brede vergelijkingen

/**
 * De brede vergelijkingen van de vierde aanvaller, als gewone test. Elke run zet de wereld klaar
 * met de code van 42 (zoals bij een echte klant) en draait dan dezelfde stap met 42 en met nu,
 * tegen de nep-wolk van 42. Vergeleken: alle aanroepen, en het resultaat of de foutmelding.
 * Bewust anders is alleen de tekst bij een antwoord dat geen JSON is; die wordt gelijkgetrokken.
 */
const BREED_KORT = {
  groepen: { klant: GROEPEN.klant, stagetwo: GROEPEN.stagetwo },
  apps: { start: ["klant", "stagetwo"] },
};
const BREED_LANG = {
  groepen: GROEPEN,
  apps: { start: { groepen: ["klant", "entra"], publiek: ["/bekijk/*"] }, ander: ["stagetwo"] },
  testaccounts: { start: ["scherm@klant.nl"] },
};
const BREED_GEBRUIKERS = () => [
  { id: ID(1), email: "piet@klant.nl", app_metadata: { provider: "custom:cloudflare" } },
  { id: ID(2), email: "jan@klant.nl", app_metadata: { provider: "custom:cloudflare" } },
  { id: ID(3), email: "vreemd@elders.nl", app_metadata: { provider: "email" } },
  { id: ID(4), email: "info@stagetwo.nl", banned_until: "2126-01-01T00:00:00Z" },
  { id: ID(6), email: "scherm@klant.nl" },
];
const BREED_MEER = { groepenIdp: { type: "azureAD", id: "idp-entra" }, idps: ["idp-entra"] };

/**
 * Kanalen waarin de zoveelste aanroep (elke soort: GET, POST, PUT, PATCH, DELETE, supabase-js en
 * gh) faalt op de gegeven manier: een foutstatus, geen JSON, een netwerkfout, of 200 zonder
 * (geldige) JSON.
 */
function metStoring(w, welke, soort) {
  const teller = { n: 0 };
  const raak = () => teller.n++ === welke;
  const antwoord = (status, tekst, statusText = "Fout") => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => tekst,
  });
  const fetchFn = async (url, opties = {}) => {
    if (!raak()) return w.fetchFn(url, opties);
    w.aanroepen.push({
      soort: "fetch",
      methode: opties.method ?? "GET",
      url,
      body: `STORING ${soort}`,
    });
    if (soort === "throw") throw new TypeError("fetch failed");
    if (soort === "geenjson") return antwoord(502, "<html>proxy</html>", "Bad Gateway");
    if (soort === "ok-geenjson") return antwoord(200, "<html>captive portal</html>", "OK");
    if (soort === "ok-leeg") return antwoord(200, "", "OK");
    const s = Number(soort);
    return antwoord(
      s,
      JSON.stringify({
        success: false,
        errors: [{ code: 1, message: `storing ${s}` }],
        message: `storing ${s}`,
      }),
    );
  };
  const maakAdmin = (url, sleutel) => {
    const echt = w.maakAdmin(url, sleutel);
    const stuk = async (methode, f) => {
      if (!raak()) return f();
      w.aanroepen.push({ soort: "admin", methode, url, body: `STORING ${soort}` });
      if (soort === "throw") throw new TypeError("fetch failed");
      return { data: null, error: { message: `storing ${soort}`, status: Number(soort) || 500 } };
    };
    return {
      customProviders: {
        listProviders: () => stuk("listProviders", () => echt.customProviders.listProviders()),
        createProvider: (p) => stuk("createProvider", () => echt.customProviders.createProvider(p)),
        updateProvider: (i, p) =>
          stuk("updateProvider", () => echt.customProviders.updateProvider(i, p)),
        deleteProvider: (i) => stuk("deleteProvider", () => echt.customProviders.deleteProvider(i)),
      },
      listUsers: (o) => stuk("listUsers", () => echt.listUsers(o)),
      updateUserById: (id, a) => stuk("updateUserById", () => echt.updateUserById(id, a)),
    };
  };
  const gh = async (args, o) => {
    if (!raak()) return w.gh(args, o);
    w.aanroepen.push({ soort: "gh", args, invoer: `STORING ${soort}` });
    throw new Error(`gh ${args.slice(0, 3).join(" ")} gaf 1: HTTP ${soort}`);
  };
  return { fetchFn, maakAdmin, gh, teller };
}

function storingDiensten(m, k, toegang) {
  return {
    cf: m.cloudflareClient({
      fetchFn: k.fetchFn,
      token: "cf-token",
      accountId: "acc",
      teamDomein: "stagetwo",
    }),
    supabase: m.supabaseBeheer({
      fetchFn: k.fetchFn,
      token: "sb-token",
      orgSlug: "klant",
      slaap: async () => {},
    }),
    maakAdmin: k.maakAdmin,
    gh: k.gh,
    wachtOpDiscovery: async () => {},
    toegang,
    accountId: "acc",
    wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
    maskeer: () => {},
    ...BREED_MEER,
  };
}

/** De bewust gewijzigde tekst bij een antwoord dat geen JSON is, gelijkgetrokken. */
const gelijkTrekken = (s) =>
  String(s ?? "")
    .replace(/gaf 502: <html>proxy<\/html>/g, "gaf 502: <GEENJSON>")
    .replace(
      /gaf 502: Bad Gateway; het antwoord was geen JSON \(\d+ tekens, niet getoond\)/g,
      "gaf 502: <GEENJSON>",
    )
    .replace(/"ruw":"[^"]*"/g, '"<GEENJSON>"')
    .replace(/"geenJson":"[^"]*"/g, '"<GEENJSON>"')
    .replace(/<html>captive portal<\/html>/g, "<GEENJSON>")
    .replace(/het antwoord was geen JSON \(\d+ tekens, niet getoond\)/g, "<GEENJSON>");

/** Eén run: klaarzetten met 42 (en eventueel met de hand verbuigen), dan `m` met een storing. */
async function storingRun(m, sc, welke = -1, soort = "500") {
  const w = v42.nepWolk({ gebruikers: BREED_GEBRUIKERS(), workerBestaat: true });
  if (sc.klaar) await sc.klaar(storingDiensten(v42, w, sc.toegang));
  sc.verbuig?.(w);
  w.aanroepen.length = 0;
  const k = metStoring(w, welke, soort);
  let uit;
  try {
    uit = { resultaat: await sc.draai(m, storingDiensten(m, k, sc.toegang)) };
  } catch (f) {
    uit = { fout: f.message };
  }
  const aanroepen = w.aanroepen.map((a) => [
    a.soort,
    a.methode ?? "",
    a.url ?? a.args?.join(" "),
    a.body instanceof FormData ? "<multipart>" : (a.body ?? a.invoer ?? null),
  ]);
  return { n: k.teller.n, beeld: gelijkTrekken(JSON.stringify({ aanroepen, ...uit })) };
}

const STORING_SCENARIOS = {
  "inrichten nieuw, lang, testdatabase, IdP-groepen, publiek": {
    toegang: BREED_LANG,
    draai: (m, d) => m.richtIn({ ...ARG, testdatabase: true }, d),
  },
  "inrichten bestaand, lang, testdatabase": {
    toegang: BREED_LANG,
    klaar: (d) => v42.richtIn({ ...ARG, testdatabase: true }, d),
    draai: (m, d) => m.richtIn({ ...ARG, testdatabase: true }, d),
  },
  "inrichten nieuw, tijdelijke stand, kort": {
    toegang: BREED_KORT,
    draai: (m, d) => m.richtIn({ ...ARG, hostname: null, stand: "tijdelijk" }, d),
  },
  "inrichten bestaand, kort, droogloop": {
    toegang: BREED_KORT,
    klaar: (d) => v42.richtIn(ARG, d),
    draai: (m, d) => m.richtIn({ ...ARG, droogloop: true }, d),
  },
  "tweede doorgang": {
    toegang: BREED_KORT,
    klaar: (d) => v42.richtIn(ARG, d),
    draai: (m, d) => m.tweedeDoorgang(ARG, d),
  },
  "toegang bijwerken, lang, testdatabase, intrekken": {
    toegang: BREED_LANG,
    klaar: (d) => v42.richtIn({ ...ARG, testdatabase: true }, d),
    draai: (m, d) => m.werkToegangBij({ voorvoegsel: "kl-" }, d),
  },
  "toegang bijwerken, twee apps, intrekken en ontbannen": {
    toegang: { ...BREED_KORT, apps: { start: ["klant"], ander: ["stagetwo"] } },
    klaar: async (d) => {
      await v42.richtIn(ARG, d);
      await v42.richtIn(
        { ...ARG, app: "ander", hostname: "ander.klant.nl", worker: "kl-ander" },
        d,
      );
    },
    draai: (m, d) => m.werkToegangBij({ voorvoegsel: "kl-" }, d),
  },
  "toegang bijwerken voor één app (--app)": {
    toegang: { ...BREED_KORT, apps: { start: ["klant"], ander: ["stagetwo"] } },
    klaar: (d) => v42.richtIn(ARG, d),
    draai: (m, d) => m.werkToegangBij({ voorvoegsel: "kl-", app: "start" }, d),
  },
  "toegang bijwerken, droogloop": {
    toegang: BREED_LANG,
    klaar: (d) => v42.richtIn({ ...ARG, testdatabase: true }, d),
    draai: (m, d) => m.werkToegangBij({ voorvoegsel: "kl-", droogloop: true }, d),
  },
  "opruimen van één app": {
    toegang: BREED_LANG,
    klaar: (d) => v42.richtIn({ ...ARG, testdatabase: true }, d),
    draai: (m, d) => m.ruimOp({ ...ARG, opruimen: true }, d),
  },
  "opruimen van alles": {
    toegang: BREED_LANG,
    klaar: (d) => v42.richtIn({ ...ARG, testdatabase: true }, d),
    draai: (m, d) => m.ruimOp({ ...ARG, app: null, opruimen: true }, d),
  },
};
const STORINGEN = [
  "400",
  "404",
  "409",
  "429",
  "500",
  "geenjson",
  "throw",
  "ok-geenjson",
  "ok-leeg",
];

test("gewone app is exact versie 42 bij een storing op elke aanroep (ook POST, PUT, PATCH, DELETE, supabase-js en gh), met elke soort fout, in elke modus", {
  skip: sla,
}, async () => {
  const verschillen = [];
  let runs = 0;
  let rood = 0;
  for (const [naam, sc] of Object.entries(STORING_SCENARIOS)) {
    const [a, b] = [await storingRun(v42, sc), await storingRun(nu, sc)];
    if (a.beeld !== b.beeld) verschillen.push(`${naam} | zonder storing`);
    assert.ok(a.n >= 3, naam);
    for (let i = 0; i < a.n; i += 1) {
      for (const soort of STORINGEN) {
        const x = await storingRun(v42, sc, i, soort);
        const y = await storingRun(nu, sc, i, soort);
        runs += 1;
        if (x.beeld.includes('"fout"')) rood += 1;
        if (x.beeld !== y.beeld) verschillen.push(`${naam} | aanroep ${i + 1} | ${soort}`);
      }
    }
  }
  assert.deepEqual(verschillen, []);
  assert.ok(runs > 2000, `${runs} runs`);
  assert.ok(rood > 0, "een storing maakt runs echt rood (anders bewijst dit niets)");
});

/** Handwerk dat bij een klant die al jaren draait voorkomt, met de hand in Cloudflare of Supabase. */
const HANDWERK = {
  "eigen custom_deny_message op de Access op de Worker": (w) => {
    w.staat.apps.find((a) => a.name === "kl-start-worker").custom_deny_message =
      "Alleen voor medewerkers van Klant BV.";
  },
  "eigen custom_deny_message op de deur": (w) => {
    w.staat.apps.find((a) => a.name === "kl-start").custom_deny_message = "Geen toegang";
  },
  "custom_deny_message leeg": (w) => {
    for (const a of w.staat.apps) a.custom_deny_message = "";
  },
  "eigen hooks in de auth-config (access token, before user created, send email)": (w) => {
    for (const auth of Object.values(w.staat.auth))
      Object.assign(auth, {
        hook_custom_access_token_enabled: true,
        hook_custom_access_token_uri: "pg-functions://postgres/public/custom_access_token_hook",
        hook_before_user_created_enabled: true,
        hook_before_user_created_uri: "https://hooks.klant.nl/voor?token=geheim",
        hook_send_email_enabled: true,
        hook_send_email_uri: "https://mail.klant.nl/hook",
      });
  },
  "eigen SMTP, captcha en mailsjablonen in de auth-config": (w) => {
    for (const auth of Object.values(w.staat.auth))
      Object.assign(auth, {
        smtp_host: "smtp.klant.nl",
        smtp_port: "587",
        smtp_user: "x",
        smtp_admin_email: "noreply@klant.nl",
        smtp_sender_name: "Klant",
        security_captcha_enabled: true,
        security_captcha_provider: "turnstile",
        mailer_templates_reauthentication_content: "<p>Je code: {{ .Token }}</p>",
        mailer_templates_email_change_content: "<p>wijzig</p>",
        mailer_secure_email_change_enabled: false,
        external_email_enabled: true,
        mailer_autoconfirm: false,
        sessions_inactivity_timeout: 12,
      });
  },
  "eigen hooks met een naam die op die van het klantportaal lijkt (ander schema, iets erachter)": (
    w,
  ) => {
    for (const auth of Object.values(w.staat.auth))
      Object.assign(auth, {
        hook_before_user_created_enabled: true,
        hook_before_user_created_uri:
          "pg-functions://postgres/public/kl_portaal_voor_aanmelden_oud",
        hook_custom_access_token_enabled: true,
        hook_custom_access_token_uri: "pg-functions://postgres/other/kl_portaal_voor_token",
      });
  },
  "de exacte adressen van de portaalhooks, maar uit": (w) => {
    for (const auth of Object.values(w.staat.auth))
      Object.assign(auth, {
        hook_before_user_created_enabled: false,
        hook_before_user_created_uri: "pg-functions://postgres/public/kl_portaal_voor_aanmelden",
        hook_custom_access_token_enabled: false,
        hook_custom_access_token_uri: "pg-functions://postgres/public/kl_portaal_voor_token",
      });
  },
  "extra policy en extra adres": (w) => {
    w.staat.policies.push({
      id: "pol-hand",
      name: "kl-handwerk",
      decision: "allow",
      include: [{ everyone: {} }],
    });
    const wk = w.staat.apps.find((a) => a.name === "kl-start-worker");
    wk.destinations = [...(wk.destinations ?? []), { type: "public", uri: "demo.klant.nl" }];
    wk.policies = [...(wk.policies ?? []), { id: "pol-hand", precedence: 9 }];
  },
  "gebruikers met app_metadata van een andere app": (w) => {
    w.staat.gebruikers.push(
      {
        id: ID(20),
        email: "dubbel@elders.nl",
        app_metadata: {
          provider: "email",
          providers: ["email", "custom:cloudflare"],
          rol: "klant",
          klantportaal: true,
        },
      },
      { id: ID(21), email: "oud@elders.nl", app_metadata: { klantportaal_klant: "true" } },
    );
  },
};
const HANDWERK_STROMEN = {
  inrichten: (m, d) => m.richtIn({ ...ARG, testdatabase: true }, d),
  "inrichten droogloop": (m, d) => m.richtIn({ ...ARG, testdatabase: true, droogloop: true }, d),
  toegang: (m, d) => m.werkToegangBij({ voorvoegsel: "kl-" }, d),
  "toegang droogloop": (m, d) => m.werkToegangBij({ voorvoegsel: "kl-", droogloop: true }, d),
  "tweede doorgang": (m, d) => m.tweedeDoorgang(ARG, d),
  opruimen: (m, d) => m.ruimOp({ ...ARG, opruimen: true }, d),
};

test("gewone app is exact versie 42 na handwerk van de klant (eigen hooks, sjablonen, merk-achtige teksten, extra policies, vreemde app_metadata), in elke modus, ook met een storing op elke aanroep", {
  skip: sla,
}, async () => {
  const toegang = {
    ...BREED_KORT,
    apps: { start: ["klant"] },
    testaccounts: { start: ["scherm@klant.nl"] },
  };
  const verschillen = [];
  for (const [hnaam, verbuig] of Object.entries(HANDWERK)) {
    for (const [snaam, draai] of Object.entries(HANDWERK_STROMEN)) {
      const sc = {
        toegang,
        klaar: (d) => v42.richtIn({ ...ARG, testdatabase: true }, d),
        verbuig,
        draai,
      };
      const [a, b] = [await storingRun(v42, sc), await storingRun(nu, sc)];
      if (a.beeld !== b.beeld) verschillen.push(`${hnaam} | ${snaam}`);
      for (let i = 0; i < a.n; i += 1) {
        for (const soort of ["429", "500", "throw"]) {
          const [x, y] = [await storingRun(v42, sc, i, soort), await storingRun(nu, sc, i, soort)];
          if (x.beeld !== y.beeld)
            verschillen.push(`${hnaam} | ${snaam} | aanroep ${i + 1} ${soort}`);
        }
      }
    }
  }
  assert.deepEqual(verschillen, []);
});

test("een eigen hook die op <voorvoegsel>portaal_voor_token eindigt (ander schema): App inrichten en daarna Toegang bijwerken doen exact wat 42 deed, en de vreemde wordt ingetrokken", {
  skip: sla,
}, async () => {
  const toegang = { ...BREED_KORT, apps: { start: ["klant"] } };
  const naloop = async (m) => {
    const w = nu.nepWolk({ gebruikers: BREED_GEBRUIKERS(), workerBestaat: true });
    await v42.richtIn(ARG, storingDiensten(v42, w, toegang));
    for (const auth of Object.values(w.staat.auth))
      Object.assign(auth, {
        hook_custom_access_token_enabled: true,
        hook_custom_access_token_uri: "pg-functions://postgres/auth_extra/kl_portaal_voor_token",
      });
    w.aanroepen.length = 0;
    const r1 = await m.richtIn(ARG, storingDiensten(m, w, toegang));
    const r2 = await m.werkToegangBij({ voorvoegsel: "kl-" }, storingDiensten(m, w, toegang));
    const aanroepen = w.aanroepen.map((a) => [
      a.soort,
      a.methode,
      a.url ?? a.args,
      a.body instanceof FormData ? "" : a.body,
    ]);
    return { r1, r2, aanroepen, sql: w.staat.sql };
  };
  const [a, b] = [await naloop(v42), await naloop(nu)];
  // Geen klant gemarkeerd; afgemeld wordt alleen wie ook op 42 werd ingetrokken.
  assert.ok(!b.sql.some((q) => /klantportaal_klant/.test(q)));
  assert.deepEqual(b.sql, a.sql);
  assert.ok(a.r2.ingetrokken.start.includes("vreemd@elders.nl"));
  assert.deepEqual(b.r2, a.r2);
  assert.deepEqual(b.r1, a.r1);
  assert.deepEqual(b.aanroepen, a.aanroepen);
});

// ---------------------------------------------------------------- toegang.json

/** 63 varianten van toegang.json, met de validatie van 42 en van nu naast elkaar. */
const MET = (apps, extra = {}) => ({
  groepen: { klant: { domeinen: ["klant.nl"] }, stagetwo: { adressen: ["info@stagetwo.nl"] } },
  apps,
  ...extra,
});
const TOEGANG_VARIANTEN = {
  kort: MET({ shop: ["klant"] }),
  lang: MET({ shop: { groepen: ["klant"] } }),
  "shop en shop-worker": MET({ shop: ["klant"], "shop-worker": ["klant"] }),
  "shop en shop-test": MET({ shop: ["klant"], "shop-test": ["klant"] }),
  "shop en shop-inlog": MET({ shop: ["klant"], "shop-inlog": ["klant"] }),
  "shop en shop-publiek": MET({ shop: ["klant"], "shop-publiek": ["klant"] }),
  "shop-worker-test en shop-worker": MET({
    "shop-worker": ["klant"],
    "shop-worker-test": ["klant"],
  }),
  "app met hoofdletter": MET({ Shop: ["klant"] }),
  "groep met hoofdletter": {
    groepen: { Klant: { domeinen: ["klant.nl"] } },
    apps: { shop: ["Klant"] },
  },
  "$opmerking bovenin, in app en in groep": {
    $x: 1,
    groepen: { klant: { domeinen: ["klant.nl"], $y: "z" } },
    apps: { shop: { groepen: ["klant"], $z: 1 } },
  },
  "lege apps": MET({}),
  "lege groepen-lijst bij app": MET({ shop: [] }),
  "app null": MET({ shop: null }),
  "app is getal": MET({ shop: 1 }),
  "app is tekst": MET({ shop: "klant" }),
  "dubbele groep in lijst": MET({ shop: ["klant", "klant"] }),
  "app constructor": MET({ constructor: ["klant"] }),
  "app __proto__ (JSON.parse)": JSON.parse(
    '{"groepen":{"klant":{"domeinen":["klant.nl"]}},"apps":{"__proto__":["klant"]}}',
  ),
  "groep publiek": {
    groepen: { publiek: { domeinen: ["klant.nl"] } },
    apps: { shop: ["publiek"] },
  },
  "groep met lege uitsluiten": {
    groepen: { klant: { domeinen: ["klant.nl"], uitsluiten: [] } },
    apps: { shop: ["klant"] },
  },
  "groep alleen uitsluiten": {
    groepen: { klant: { uitsluiten: ["a@b.nl"] } },
    apps: { shop: ["klant"] },
  },
  "lange app-naam (41)": MET({ ["a".repeat(41)]: ["klant"] }),
  "app-naam 63 tekens": MET({ ["a".repeat(63)]: ["klant"] }),
  "app-naam met underscore": MET({ shop_x: ["klant"] }),
  "app-naam begint met cijfer": MET({ "1shop": ["klant"] }),
  "app-naam eindigt op streepje": MET({ "shop-": ["klant"] }),
  "app-object zonder groepen": MET({ shop: { publiek: ["/x/*"] } }),
  "testaccounts leeg object": MET({ shop: ["klant"] }, { testaccounts: {} }),
  "testaccounts lege lijst": MET({ shop: ["klant"] }, { testaccounts: { shop: [] } }),
  "testaccounts $opmerking": MET(
    { shop: ["klant"] },
    { testaccounts: { $o: "x", shop: ["a@klant.nl"] } },
  ),
  "testaccounts hoofdletters": MET(
    { shop: ["klant"] },
    { testaccounts: { shop: ["Scherm@Klant.NL"] } },
  ),
  "klantportaal false": MET({ shop: { groepen: ["klant"], klantportaal: false } }),
  'klantportaal "true" (tekst)': MET({ shop: { groepen: ["klant"], klantportaal: "true" } }),
  "klantportaal null": MET({ shop: { groepen: ["klant"], klantportaal: null } }),
  "afzender bij gewone app": MET({ shop: { groepen: ["klant"], afzender: "noreply@klant.nl" } }),
  "captcha false bij gewone app": MET({ shop: { groepen: ["klant"], captcha: false } }),
  "turnstile_sitekey bij gewone app": MET({
    shop: { groepen: ["klant"], turnstile_sitekey: "0x4AAAAAAAabc" },
  }),
  "$klantportaal opmerking": MET({ shop: { groepen: ["klant"], $klantportaal: "later" } }),
  "publiek leeg": MET({ shop: { groepen: ["klant"], publiek: [] } }),
  "publiek met *": MET({ shop: { groepen: ["klant"], publiek: ["/bekijk/*"] } }),
  "publiek /": MET({ shop: { groepen: ["klant"], publiek: ["/"] } }),
  "publiek met query": MET({ shop: { groepen: ["klant"], publiek: ["/x?y=1"] } }),
  "publiek met spatie": MET({ shop: { groepen: ["klant"], publiek: ["/mijn pad"] } }),
  "publiek null": MET({ shop: { groepen: ["klant"], publiek: null } }),
  "gegevens_naar_test false": MET({ shop: { groepen: ["klant"], gegevens_naar_test: false } }),
  'gegevens_naar_test "false"': MET({ shop: { groepen: ["klant"], gegevens_naar_test: "false" } }),
  "onbekend veld in app": MET({ shop: { groepen: ["klant"], omschrijving: "x" } }),
  "testaccounts van onbekende app": MET(
    { shop: ["klant"] },
    { testaccounts: { ander: ["a@klant.nl"] } },
  ),
  "onbekend veld bovenin": MET({ shop: ["klant"] }, { versie: 2 }),
  "groep met streepje": {
    groepen: { "klant-a": { domeinen: ["klant.nl"] } },
    apps: { shop: ["klant-a"] },
  },
  "groep met punt": {
    groepen: { "klant.a": { domeinen: ["klant.nl"] } },
    apps: { shop: ["klant.a"] },
  },
  "groep met spatie": {
    groepen: { "klant a": { domeinen: ["klant.nl"] } },
    apps: { shop: ["klant a"] },
  },
  "groep met é": { groepen: { café: { domeinen: ["klant.nl"] } }, apps: { shop: ["café"] } },
  "domein met hoofdletters": { groepen: { k: { domeinen: ["Klant.NL"] } }, apps: { shop: ["k"] } },
  "domein met subdomein en streepje": {
    groepen: { k: { domeinen: ["mail.mijn-klant.co.uk"] } },
    apps: { shop: ["k"] },
  },
  "domein punycode": { groepen: { k: { domeinen: ["xn--caf-dma.nl"] } }, apps: { shop: ["k"] } },
  "adres met plus": { groepen: { k: { adressen: ["piet+test@klant.nl"] } }, apps: { shop: ["k"] } },
  "adres met apostrof": {
    groepen: { k: { adressen: ["o'brien@klant.nl"] } },
    apps: { shop: ["k"] },
  },
  "idp-groep met spatie en &": {
    groepen: { k: { idp_groepen: ["Verkoop & Service"] } },
    apps: { shop: ["k"] },
  },
  "idp-groep guid": {
    groepen: { k: { idp_groepen: ["0b5f0f2e-1c6d-4f0e-9a43-6a1f3f0b9c11"] } },
    apps: { shop: ["k"] },
  },
  "idp-groep met aanhalingsteken": {
    groepen: { k: { idp_groepen: ['Team "A"'] } },
    apps: { shop: ["k"] },
  },
  "idp-groep met /": { groepen: { k: { idp_groepen: ["afd/verkoop"] } }, apps: { shop: ["k"] } },
  "lege idp_groepen naast domeinen": {
    groepen: { k: { domeinen: ["klant.nl"], idp_groepen: [] } },
    apps: { shop: ["k"] },
  },
};
/** Wat bewust anders is: `klantportaal: false` is nu geldig; de rest is alleen een betere melding. */
const ANDERE_MELDING = [
  'klantportaal "true" (tekst)',
  "klantportaal null",
  "afzender bij gewone app",
  "captcha false bij gewone app",
  "turnstile_sitekey bij gewone app",
  "onbekend veld in app",
];

test("toegang.json: 63 varianten krijgen hetzelfde oordeel als op 42 (alleen klantportaal: false is nu geldig, en zes meldingen over velden van een klantportaal zijn duidelijker)", {
  skip: sla,
}, () => {
  assert.equal(Object.keys(TOEGANG_VARIANTEN).length, 63);
  const uitkomst = (f, t) => {
    try {
      f(structuredClone(t));
      return "geldig";
    } catch (e) {
      return `geweigerd: ${e.message}`;
    }
  };
  for (const [naam, bestand] of Object.entries(TOEGANG_VARIANTEN)) {
    const a = uitkomst(v42.valideerToegang, bestand);
    const b = uitkomst(nu.valideerToegang, bestand);
    if (naam === "klantportaal false") {
      assert.match(a, /^geweigerd: .*veld klantportaal: onbekend veld/);
      assert.equal(b, "geldig", naam);
    } else if (ANDERE_MELDING.includes(naam)) {
      assert.match(a, /^geweigerd/, naam);
      assert.match(b, /^geweigerd/, naam);
    } else {
      assert.equal(b, a, naam);
    }
  }
});

// ---------------------------------------------------------------- het script als proces, breed

/**
 * Het script als proces in elke modus en in elke omgeving: met en zonder GitHub Actions, met de
 * secrets van een klantportaal leeg, gezet, alleen spaties of gelijk aan een woord in de uitvoer,
 * en met GITHUB_STEP_SUMMARY een map, een bestand dat niet kan bestaan of een gewoon bestand.
 * Versie 42 en nu draaien elk in een eigen kopie met dezelfde toegang.json (zonder klantportaal)
 * en dezelfde wrangler.jsonc, tegen de nep-wolk van 42. `gh` is een nepscript en elke andere
 * host faalt: er gaat niets naar buiten.
 */
const PROCES_MODI = {
  toegang: ["--voorvoegsel", "cf-proef-", "--toegang"],
  "toegang droogloop": ["--voorvoegsel", "cf-proef-", "--toegang", "--droogloop"],
  "opruimen droogloop": ["--voorvoegsel", "cf-proef-", "--opruimen", "--droogloop"],
  "inrichten droogloop": ["--voorvoegsel", "cf-proef-", "--app", "cf-proef", "--droogloop"],
  "tweede doorgang droogloop": [
    "--voorvoegsel",
    "cf-proef-",
    "--app",
    "cf-proef",
    "--tweede-doorgang",
    "--droogloop",
  ],
  "inrichten zonder GH_TOKEN": ["--voorvoegsel", "cf-proef-", "--app", "cf-proef"],
};

let procesMap = null;
function procesOpzet() {
  if (procesMap) return procesMap;
  const basis = join(map, "proces");
  const w42 = join(basis, "v42");
  const w43 = join(basis, "nu");
  const bin = join(basis, "bin");
  for (const m of [w42, w43, bin]) mkdirSync(m, { recursive: true });
  cpSync(join(map, "beheer"), join(w42, "beheer"), { recursive: true, verbatimSymlinks: true });
  cpSync(join(map, "scripts"), join(w42, "scripts"), { recursive: true });
  cpSync(hier, join(w43, "beheer"), {
    recursive: true,
    filter: (bron) => !bron.includes(`${join(hier, "node_modules")}`),
  });
  symlinkSync(join(hier, "node_modules"), join(w43, "beheer", "node_modules"));
  cpSync(resolve(hier, "..", "scripts", "lib"), join(w43, "scripts", "lib"), { recursive: true });
  for (const w of [w42, w43]) {
    copyFileSync(join(hier, "toegang.json"), join(w, "beheer", "toegang.json"));
    copyFileSync(resolve(hier, "..", "wrangler.jsonc"), join(w, "wrangler.jsonc"));
  }
  writeFileSync(
    join(bin, "gh"),
    '#!/bin/sh\ncase "$*" in *list*) echo "[]";; *) echo "nep-gh: $*" >&2; exit 1;; esac\n',
  );
  chmodSync(join(bin, "gh"), 0o755);
  const voorlader = join(basis, "voorlader.mjs");
  writeFileSync(
    voorlader,
    `
import { nepWolk } from ${JSON.stringify(pathToFileURL(join(w42, "beheer", "nep-wolk.mjs")).href)};
const gebruiker = { id: "${ID(7)}", email: "indringer@elders.example", app_metadata: { provider: "email", providers: ["email"] } };
const w = nepWolk({
  workerBestaat: true,
  projecten: [{ ref: "refproef0000000000001", name: "cf-proef-cf-proef", organization_slug: "klant", status: "ACTIVE_HEALTHY" }],
});
const json = (s, body) => new Response(JSON.stringify(body), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (invoer, opties = {}) => {
  const url = String(invoer?.url ?? invoer);
  const methode = opties.method ?? invoer?.method ?? "GET";
  const u = new URL(url);
  if (u.hostname.endsWith(".supabase.co")) {
    if (methode === "GET") return json(200, { users: [gebruiker], aud: "authenticated" });
    return json(200, gebruiker);
  }
  if (!/^api\\.(cloudflare|supabase)\\.com$/.test(u.hostname)) throw new Error("geblokkeerd: " + u.hostname);
  const a = await w.fetchFn(url, { ...opties, method: methode });
  return new Response(await a.text(), { status: a.status, headers: { "content-type": "application/json" } });
};
`,
  );
  procesMap = { basis, w42, w43, bin, voorlader };
  return procesMap;
}

function draaiProces(wortel, args, omgeving) {
  const { bin, voorlader } = procesOpzet();
  return new Promise((klaar, mis) => {
    const kind = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(voorlader).href,
        join(wortel, "beheer", "inrichten-cloudflare.mjs"),
        ...args,
      ],
      {
        cwd: wortel,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          CLOUDFLARE_PROEF_TOKEN: "cf-token-123",
          CLOUDFLARE_ACCOUNT_ID: "acc",
          CLOUDFLARE_TEAM_DOMAIN: "stagetwo",
          SUPABASE_ACCESS_TOKEN: "sb-token-123",
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

test("gewone app is exact versie 42 als proces: elke modus in elke omgeving geeft dezelfde stdout, stderr en exitcode, geen ::add-mask:: voor de secrets van een klantportaal en geen samenvatting", {
  skip: sla,
}, async () => {
  const { basis, w42, w43 } = procesOpzet();
  const bestand = (naam) => join(basis, naam);
  const omgevingen = {
    kaal: {},
    "GitHub Actions": { GITHUB_ACTIONS: "true" },
    "GitHub Actions, SMTP/TURNSTILE leeg": {
      GITHUB_ACTIONS: "true",
      SMTP_WACHTWOORD: "",
      TURNSTILE_GEHEIM: "",
    },
    "GitHub Actions, SMTP_WACHTWOORD en TURNSTILE_GEHEIM gezet": {
      GITHUB_ACTIONS: "true",
      SMTP_WACHTWOORD: "re_GeheimVanEenAndereApp",
      TURNSTILE_GEHEIM: "0x4AAAAAAAgeheim",
    },
    "lokaal, SMTP_WACHTWOORD is een woord uit de uitvoer": { SMTP_WACHTWOORD: "proef" },
    "GitHub Actions, SMTP_WACHTWOORD alleen spaties": {
      GITHUB_ACTIONS: "true",
      SMTP_WACHTWOORD: "   ",
    },
    "GITHUB_STEP_SUMMARY is een map": { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: basis },
    "GITHUB_STEP_SUMMARY in een map die niet bestaat": {
      GITHUB_STEP_SUMMARY: join(basis, "nergens", "s.md"),
    },
    "GITHUB_STEP_SUMMARY is een gewoon bestand": {
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: "BESTAND",
    },
  };
  const paren = [];
  for (const [mnaam, args] of Object.entries(PROCES_MODI)) {
    paren.push(
      ...(await Promise.all(
        Object.entries(omgevingen).map(async ([onaam, omg], i) => {
          const per = (v) =>
            omg.GITHUB_STEP_SUMMARY === "BESTAND"
              ? { ...omg, GITHUB_STEP_SUMMARY: bestand(`${v}-${mnaam}-${i}.md`) }
              : omg;
          for (const v of ["42", "nu"]) {
            if (omg.GITHUB_STEP_SUMMARY === "BESTAND")
              writeFileSync(bestand(`${v}-${mnaam}-${i}.md`), "");
          }
          const a = await draaiProces(w42, args, per("42"));
          const b = await draaiProces(w43, args, per("nu"));
          const s =
            omg.GITHUB_STEP_SUMMARY === "BESTAND"
              ? readFileSync(bestand(`nu-${mnaam}-${i}.md`), "utf8")
              : "";
          return { naam: `${mnaam} | ${onaam}`, a, b, s };
        }),
      )),
    );
  }
  assert.equal(paren.length, 54);
  for (const { naam, a, b, s } of paren) {
    assert.match(a.stdout, /INRICHTING \{"status":"/, naam);
    assert.equal(b.stdout, a.stdout, naam);
    assert.equal(b.stderr, a.stderr, naam);
    assert.equal(b.code, a.code, naam);
    assert.doesNotMatch(b.stdout, /add-mask::(re_|0x4|proef|\s)/, naam);
    assert.equal(s, "", `${naam}: geen samenvatting`);
  }
  assert.ok(paren.some(({ a }) => a.code === 1));
  assert.ok(paren.some(({ a }) => a.code === 0));
});

test("als proces, wat bewust anders is dan 42: --deur-weghalen is nu een bekende optie, met een eigen melding bij --toegang (toen: onbekende optie)", {
  skip: sla,
}, async () => {
  const { w42, w43 } = procesOpzet();
  const args = ["--voorvoegsel", "cf-proef-", "--toegang", "--deur-weghalen"];
  const [a, b] = [await draaiProces(w42, args, {}), await draaiProces(w43, args, {})];
  assert.equal(a.code, 1);
  assert.equal(b.code, 1);
  assert.match(a.stdout, /"reden":"onbekende optie: --deur-weghalen"/);
  assert.match(
    b.stdout,
    /"reden":"--deur-weghalen hoort bij de gewone inrichting van een klantportaal/,
  );
});

test("als proces, met een klantportaal in toegang.json: de secrets van het klantportaal worden getrimd gemaskeerd, een lege overgeslagen, en het script schrijft zijn samenvatting", {
  skip: sla,
}, async () => {
  const { basis, w43 } = procesOpzet();
  const portaal = join(basis, "portaal");
  cpSync(w43, portaal, { recursive: true, verbatimSymlinks: true });
  const t = JSON.parse(readFileSync(join(portaal, "beheer", "toegang.json"), "utf8"));
  t.apps["cf-proef"] = {
    groepen: ["stagetwo"],
    klantportaal: true,
    afzender: "noreply@stagetwo.nl",
    captcha: false,
  };
  writeFileSync(join(portaal, "beheer", "toegang.json"), JSON.stringify(t));
  const s = join(basis, "portaal-samenvatting.md");
  writeFileSync(s, "");
  const r = await draaiProces(portaal, PROCES_MODI["toegang droogloop"], {
    GITHUB_ACTIONS: "true",
    GITHUB_STEP_SUMMARY: s,
    SMTP_WACHTWOORD: "  re_GeheimMetSpaties  ",
    TURNSTILE_GEHEIM: "   ",
  });
  const maskers = r.stdout.split("\n").filter((x) => x.startsWith("::add-mask::"));
  assert.ok(maskers.includes("::add-mask::re_GeheimMetSpaties"), r.stdout);
  assert.ok(!maskers.some((x) => /::add-mask::\s/.test(x) || x === "::add-mask::"), r.stdout);
  assert.match(readFileSync(s, "utf8"), /^## Toegang bijwerken/);
});
