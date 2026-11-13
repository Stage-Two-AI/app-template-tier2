/**
 * De scenario's van de regressietest (regressie-42.test.mjs): gewone apps, zonder
 * `klantportaal` in toegang.json, door elke modus van het inrichtingsscript. Per scenario
 * komt elke aanroep naar Cloudflare, Supabase en GitHub in een lijst, met methode, adres en
 * body, plus het resultaat van het script.
 *
 * Dit bestand kent de code niet zelf: de modules komen binnen als `m`. Zo draait precies
 * hetzelfde tegen de code van versie 42 (regressie-42.maak.mjs, die de verwachting
 * schrijft) en tegen de code van nu (de test). Geen testbestand (geen `.test.` in de naam).
 */

const GROEPEN = {
  klant: { domeinen: ["klant.nl"], uitsluiten: ["jan@klant.nl"] },
  stagetwo: { adressen: ["info@stagetwo.nl"] },
};
const KORT = { groepen: GROEPEN, apps: { "cf-proef": ["klant", "stagetwo"] } };
const LANG = {
  groepen: GROEPEN,
  apps: {
    "cf-proef": { groepen: ["klant"], publiek: ["/bekijk/*"], gegevens_naar_test: false },
    ander: ["stagetwo"],
  },
  testaccounts: { "cf-proef": ["schermtest@klant.nl"] },
};
const ARG = {
  app: "cf-proef",
  hostname: "cf-proef.stagetwo.nl",
  worker: "cf-proef",
  repo: "Stage-Two-AI/app-template-tier2",
  voorvoegsel: "cf-proef-",
  droogloop: false,
};
const RP = {
  ...ARG,
  app: "start",
  hostname: "start.klant.nl",
  worker: "rp-start",
  voorvoegsel: "rp-",
};
const TOEGANG_RP = { groepen: GROEPEN, apps: { start: ["klant"] } };

const GEBRUIKERS = () => [
  { id: "00000000-0000-4000-8000-000000000001", email: "piet@klant.nl" },
  { id: "00000000-0000-4000-8000-000000000002", email: "jan@klant.nl" },
  { id: "00000000-0000-4000-8000-000000000003", email: "vreemd@elders.nl" },
  {
    id: "00000000-0000-4000-8000-000000000004",
    email: "info@stagetwo.nl",
    banned_until: "2126-01-01T00:00:00Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000005",
    email: "weg@elders.nl",
    banned_until: "2126-01-01T00:00:00Z",
  },
  { id: "00000000-0000-4000-8000-000000000006", email: "schermtest@klant.nl" },
  { id: "00000000-0000-4000-8000-000000000007", email: "testgebruiker@stagetwo.nl" },
  // Een account zonder adres: wordt overgeslagen.
  { id: "00000000-0000-4000-8000-000000000008" },
];

function plat(a) {
  const body = a.body instanceof FormData ? "<multipart>" : a.body;
  if (a.soort === "fetch") {
    return { soort: a.soort, methode: a.methode, url: a.url, body, headers: a.headers };
  }
  if (a.soort === "admin") {
    return { soort: a.soort, methode: a.methode, url: a.url, sleutel: a.sleutel, body };
  }
  return { soort: a.soort, args: a.args, invoer: a.invoer };
}

/** Draait alle scenario's en geeft per scenario `{ aanroepen, resultaat }` of `{ fout }`. */
export async function draaiScenarios(m) {
  const uit = {};

  function opzet(w, toegang, extra = {}) {
    return {
      cf: m.cloudflareClient({
        fetchFn: w.fetchFn,
        token: "cf-token",
        accountId: "acc",
        teamDomein: "stagetwo",
      }),
      supabase: m.supabaseBeheer({
        fetchFn: w.fetchFn,
        token: "sb-token",
        orgSlug: "stagetwo",
        slaap: async () => {},
      }),
      maakAdmin: w.maakAdmin,
      gh: w.gh,
      wachtOpDiscovery: async () => {},
      toegang,
      accountId: "acc",
      wachtwoord: () => "GeheimDatabaseWachtwoord1234567",
      maskeer: () => {},
      ...extra,
    };
  }

  /** Eén stap: de aanroepen sinds de vorige stap en het resultaat. */
  async function stap(naam, w, werk) {
    w.aanroepen.length = 0;
    let resultaat;
    try {
      resultaat = { resultaat: await werk() };
    } catch (fout) {
      resultaat = { fout: fout.message };
    }
    uit[naam] = JSON.parse(
      JSON.stringify({ aanroepen: w.aanroepen.map(plat), ...resultaat }, (_k, v) =>
        v === undefined ? null : v,
      ),
    );
  }

  // A. De korte vorm, standaardstand: droogloop, eerste run, tweede run, toegang, opruimen.
  {
    const w = m.nepWolk({ gebruikers: GEBRUIKERS() });
    await stap("A1 droogloop op een leeg account", w, () =>
      m.richtIn({ ...ARG, droogloop: true }, opzet(w, KORT)),
    );
    await stap("A2 eerste inrichting", w, () => m.richtIn(ARG, opzet(w, KORT)));
    await stap("A3 tweede inrichting, alles bestaat", w, () => m.richtIn(ARG, opzet(w, KORT)));
    await stap("A4 droogloop als alles bestaat", w, () =>
      m.richtIn({ ...ARG, droogloop: true }, opzet(w, KORT)),
    );
    await stap("A5 tweede doorgang", w, () => m.tweedeDoorgang(ARG, opzet(w, KORT)));
    await stap("A6 toegang bijwerken, droogloop", w, () =>
      m.werkToegangBij({ voorvoegsel: "cf-proef-", droogloop: true }, opzet(w, KORT)),
    );
    await stap("A7 toegang bijwerken: ban, opheffen, overslaan", w, () =>
      m.werkToegangBij({ voorvoegsel: "cf-proef-" }, opzet(w, KORT)),
    );
    await stap("A8 toegang bijwerken, niets meer te doen", w, () =>
      m.werkToegangBij({ voorvoegsel: "cf-proef-" }, opzet(w, KORT)),
    );
    await stap("A9 een groep minder: policy ontkoppeld en weg", w, () =>
      m.werkToegangBij(
        { voorvoegsel: "cf-proef-" },
        opzet(w, { groepen: { klant: GROEPEN.klant }, apps: { "cf-proef": ["klant"] } }),
      ),
    );
    await stap("A10 opruimen, droogloop", w, () =>
      m.ruimOp({ ...ARG, opruimen: true, droogloop: true }, opzet(w, KORT)),
    );
    await stap("A11 opruimen", w, () => m.ruimOp({ ...ARG, opruimen: true }, opzet(w, KORT)));
  }

  // B. De lange vorm met publieke paden, een testdatabase en testaccounts.
  {
    const w = m.nepWolk({ gebruikers: GEBRUIKERS(), workerBestaat: true });
    const arg = { ...ARG, testdatabase: true };
    await stap("B1 droogloop met testdatabase en publieke paden", w, () =>
      m.richtIn({ ...arg, droogloop: true }, opzet(w, LANG)),
    );
    await stap("B2 eerste inrichting met testdatabase en publieke paden", w, () =>
      m.richtIn(arg, opzet(w, LANG)),
    );
    await stap("B3 tweede inrichting", w, () => m.richtIn(arg, opzet(w, LANG)));
    await stap("B4 toegang bijwerken, ook in de testdatabase", w, () =>
      m.werkToegangBij({ voorvoegsel: "cf-proef-" }, opzet(w, LANG)),
    );
    await stap("B5 toegang bijwerken voor één app", w, () =>
      m.werkToegangBij({ voorvoegsel: "cf-proef-", app: "cf-proef" }, opzet(w, LANG)),
    );
    await stap("B6 publieke paden weer weg", w, () =>
      m.werkToegangBij(
        { voorvoegsel: "cf-proef-" },
        opzet(w, { ...LANG, apps: { ...LANG.apps, "cf-proef": { groepen: ["klant"] } } }),
      ),
    );
    await stap("B7 opruimen van alles", w, () =>
      m.ruimOp({ ...arg, app: null, opruimen: true }, opzet(w, LANG)),
    );
  }

  // C. De tijdelijke stand (nog geen eigen domein).
  {
    const w = m.nepWolk();
    const arg = { ...ARG, hostname: null, stand: "tijdelijk" };
    await stap("C1 tijdelijke stand, droogloop", w, () =>
      m.richtIn({ ...arg, droogloop: true }, opzet(w, KORT)),
    );
    await stap("C2 tijdelijke stand, inrichting", w, () => m.richtIn(arg, opzet(w, KORT)));
    await stap("C3 tijdelijke stand, tweede run", w, () => m.richtIn(arg, opzet(w, KORT)));
    await stap("C4 daarna de standaardstand: de deur komt erbij", w, () =>
      m.richtIn(ARG, opzet(w, KORT)),
    );
  }

  // D. Een klant: ander voorvoegsel, eigen repo, eigen inlogmethoden, Sentry-DSN, oud secret.
  {
    const w = m.nepWolk({
      gebruikers: GEBRUIKERS(),
      ghSecrets: { production: ["SUPABASE_PROJECT_REF"] },
      ghBestanden: { ".github/workflows/deploy-db.yml": "project-ref: vars.SUPABASE_PROJECT_REF" },
    });
    const extra = {
      idps: ["idp-entra", "idp-otp"],
      sentryDsn: "https://abc@o1.ingest.de.sentry.io/1",
    };
    const arg = { ...RP, repo: "Richplant-BV/richplant-start" };
    await stap("D1 klant, eerste inrichting", w, () => m.richtIn(arg, opzet(w, TOEGANG_RP, extra)));
    await stap("D2 klant, andere inlogmethoden", w, () =>
      m.richtIn(arg, opzet(w, TOEGANG_RP, { ...extra, idps: ["idp-entra"] })),
    );
    await stap("D3 klant, toegang bijwerken", w, () =>
      m.werkToegangBij({ voorvoegsel: "rp-" }, opzet(w, TOEGANG_RP)),
    );
  }

  // E. Stoppen zonder wijzigingen: een naam zonder voorvoegsel bestaat al.
  {
    const w = m.nepWolk({ apps: [{ id: "vreemd", name: "cf-proef", type: "self_hosted" }] });
    await stap("E1 een app zonder voorvoegsel laat alles staan", w, () =>
      m.richtIn(ARG, opzet(w, KORT)),
    );
  }

  return uit;
}
