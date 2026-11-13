/**
 * Het toegangsmodel (KTD8): wie mag bij welke app, in één bestand, `beheer/toegang.json`.
 *
 *   {
 *     "groepen": { "<groep>": { "domeinen": [], "adressen": [], "idp_groepen": [], "uitsluiten": [] } },
 *     "apps":    { "<app>": ["<groep>", ...] }
 *                  of { "<app>": { "groepen": ["<groep>", ...], "publiek": ["/bekijk/*"],
 *                                  "gegevens_naar_test": false } }
 *                  of { "<app>": { "groepen": ["<groep>", ...], "klantportaal": true,
 *                                  "afzender": "Naam <adres>",
 *                                  "turnstile_sitekey": "0x4AAA..." } },
 *     "testaccounts": { "<app>": ["<adres>", ...] }
 *   }
 *
 * De lange vorm van een app is optioneel; de korte (alleen de groepen) blijft werken.
 * `publiek`: paden die zonder inlog open zijn, bijvoorbeeld een link die je naar een
 * klant stuurt. Ze krijgen een eigen Access-app met een bypass-policy (zie publiekApp in
 * cloudflare.mjs); de gebouwde bestanden en iconen gaan vanzelf mee. `gegevens_naar_test`
 * (standaard true): met false kopieert Testdatabase verversen voor deze app geen gegevens en
 * bestanden van productie meer, maar ververst hij de testlogin wel.
 *
 * `klantportaal` (standaard false): de app is open voor klanten. Er komt geen deur op het
 * eigen domein, klanten loggen in per mail (link of code) en de groepen zijn alleen nog de
 * medewerkers, die via Cloudflare blijven inloggen. Het workers.dev-adres en de previews
 * blijven dicht. Hoort bij: `afzender` (verplicht, het adres waar de inlogmail vandaan komt)
 * en `turnstile_sitekey` (de openbare sleutel van de Turnstile-widget). De captcha staat bij
 * een klantportaal standaard aan; alleen met een uitdrukkelijke `"captcha": false` gaat hij
 * uit, en dan waarschuwt het resultaat. `publiek` kan er niet naast: het hele domein is dan
 * al open. Zie "Klantportaal" in beheer/README.md.
 *
 * `testaccounts` is optioneel en geldt alleen voor de testdatabase van die app
 * (`<vv><app>-test`): accounts met e-mail en wachtwoord, zodat iemand (of Claude) de
 * schermen kan zien zonder door Cloudflare te gaan. Ze komen nooit in een Access-policy
 * en nooit in productie. De vaste testgebruiker van Claude (TESTGEBRUIKER) telt altijd
 * als testaccount, ook als hij er niet in staat.
 *
 * Per groep maakt de inrichting één herbruikbare Access-policy; beide Access-apps van
 * een app (deur en inlogdienst) en de Access op de Worker krijgen dezelfde lijst. Wie
 * niet door de deur mag, krijgt dus ook geen token.
 *
 * Een policy laat toe wie past bij een van de include-regels en niet bij een van de
 * exclude-regels van díe policy. Meerdere policies op een app tellen als "of". De
 * beslissing hieronder (magAanmelden) en de aanmeld-hook van de testdatabase volgen
 * precies dat.
 */
import { appNamen, metPolicies, policyIdsVanApp, valideerVoorvoegsel } from "./cloudflare.mjs";

const VELDEN = ["domeinen", "adressen", "idp_groepen", "uitsluiten"];
const GROEPNAAM = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DOMEIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADRES = /^[a-z0-9._%+-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IDP_GROEP = /^[^'"\\\n]{1,200}$/;
/**
 * Een publiek pad: begint met /, alleen veilige tekens, hoogstens één * aan het eind. De
 * hele app openzetten ("/" of "/*") kan niet: dan valt de deur weg.
 */
const PAD = /^\/[a-zA-Z0-9._~/-]*\*?$/;
const geldigPad = (p) => typeof p === "string" && PAD.test(p) && p !== "/" && p !== "/*";
const APP_VELDEN = [
  "groepen",
  "publiek",
  "gegevens_naar_test",
  "klantportaal",
  "afzender",
  "captcha",
  "turnstile_sitekey",
];
/** De openbare sleutel van een Turnstile-widget (begint bij Cloudflare met 0x4). */
const SITEKEY = /^[A-Za-z0-9_-]{10,100}$/;
/**
 * De openbare sleutel van Turnstile is rond de 24 tekens, de geheime rond de 35, en ze beginnen
 * hetzelfde. Wat langer is dan dit, is de geheime: die hoort nooit in toegang.json (dat staat in
 * git, en de waarde komt als openbare variabele in de bundel van de app).
 */
export const SITEKEY_MAX = 30;
/**
 * De afzender van de inlogmail: een adres, of "Naam <adres>". De naam komt in het onderwerp
 * en in de tekst van de mail; daarom alleen letters, cijfers, spaties en . & ' ( ) -, zodat
 * er nooit HTML of een sjabloonopdracht ({{ }}) in kan staan.
 */
const AFZENDER_NAAM = /^[\p{L}\p{N}][\p{L}\p{N} .&'()-]{0,59}$/u;

/**
 * Het adres van de afzender: hetzelfde patroon als Supabase voor `smtp_admin_email` hanteert
 * (UpdateAuthConfigBody in de Management API, 13-11-2026). Wat hier doorheen komt, weigert
 * Supabase niet om zijn vorm.
 */
const AFZENDER_ADRES =
  /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

/**
 * De openbare testsleutels van Turnstile (documentatie van Cloudflare, "Testing"): een cijfer
 * 1, 2 of 3, een x en dan nullen. De testgeheimen keuren elk bewijs goed (of juist af) en de
 * test-sitekeys tonen een widget die altijd slaagt. Iedereen kent ze; in productie is dat geen
 * captcha. Geldt voor de geheime en voor de openbare sleutel.
 */
export function isTurnstileTestsleutel(waarde) {
  return /^[123]x0{8,}/i.test(String(waarde ?? ""));
}

/** Leest "Naam <adres>" of "adres"; null als het niet klopt. */
export function leesAfzender(waarde) {
  if (typeof waarde !== "string") return null;
  const m = waarde.trim().match(/^(?:([^<>]*)<([^<>\s]+)>|([^<>\s]+))$/);
  if (!m) return null;
  const adres = (m[2] ?? m[3]).toLowerCase();
  if (!AFZENDER_ADRES.test(adres)) return null;
  const naam = m[2] === undefined ? null : m[1].trim();
  if (naam !== null && !AFZENDER_NAAM.test(naam)) return null;
  return { adres, naam };
}
/** Wat appNamen achter de naam van een app zet (zie cloudflare.mjs). */
const NAAM_STAARTEN = ["worker", "inlog", "publiek", "test", "test-inlog"];
/** Die naam is van de policy van de publieke paden (publiekPolicyNaam). */
export const PUBLIEK_GROEP = "publiek";

/** De gekozen groepen van een app, in beide vormen van het bestand. */
export function groepenVanApp(t, app) {
  const w = t?.apps?.[app];
  return Array.isArray(w) ? w : (w?.groepen ?? []);
}

/** De publieke paden van een app (leeg als er geen zijn). */
export function publiekVanApp(t, app) {
  const w = t?.apps?.[app];
  return Array.isArray(w) ? [] : (w?.publiek ?? []);
}

/** Is deze app een klantportaal (geen deur op het domein, klanten per mail)? */
export function isKlantportaal(t, app) {
  const w = t?.apps?.[app];
  return !Array.isArray(w) && w?.klantportaal === true;
}

/**
 * De afzender van de inlogmail van een klantportaal, als `{ adres, naam }`. Zonder naam in
 * toegang.json is de naam die van de app. Gooit als de app geen klantportaal is.
 */
export function afzenderVanApp(t, app) {
  if (!isKlantportaal(t, app)) throw new Error(`app "${app}" is geen klantportaal`);
  const a = leesAfzender(t.apps[app].afzender);
  if (!a)
    throw new Error(`app "${app}": de afzender van het klantportaal ontbreekt of is ongeldig`);
  return { adres: a.adres, naam: a.naam ?? app };
}

/**
 * Staat Turnstile (captcha) aan op het inlogformulier van dit klantportaal? Standaard ja:
 * alleen een uitdrukkelijke `"captcha": false` zet hem uit.
 */
export function captchaVanApp(t, app) {
  return isKlantportaal(t, app) && t.apps[app].captcha !== false;
}

/** De openbare Turnstile-sleutel van een klantportaal met captcha; anders null. */
export function sitekeyVanApp(t, app) {
  return captchaVanApp(t, app) ? (t.apps[app].turnstile_sitekey ?? null) : null;
}

/** Kopieert Testdatabase verversen gegevens en bestanden voor deze app? Standaard ja. */
export function gegevensNaarTest(t, app) {
  const w = t?.apps?.[app];
  return Array.isArray(w) || w?.gegevens_naar_test !== false;
}

/** De vaste testgebruiker van Claude in elke testdatabase; altijd een testaccount. */
export const TESTGEBRUIKER = "testgebruiker@stagetwo.nl";

/** De provider van de inlog via Cloudflare Access (gelijk aan PROVIDER in supabase.mjs). */
export const PROVIDER_CLOUDFLARE = "custom:cloudflare";

function klein(lijst) {
  return (lijst ?? []).map((x) => String(x).toLowerCase());
}

/** Controleert het bestand en geeft het terug; bij fouten één melding met alles erin. */
export function valideerToegang(t) {
  const fouten = [];
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("toegang.json: geen object");
  for (const sleutel of Object.keys(t)) {
    if (!["groepen", "apps", "testaccounts"].includes(sleutel) && !sleutel.startsWith("$")) {
      fouten.push(`onbekend veld "${sleutel}" bovenin (alleen groepen, apps en testaccounts)`);
    }
  }
  const groepen = t.groepen;
  const apps = t.apps;
  if (!groepen || typeof groepen !== "object" || Array.isArray(groepen))
    fouten.push('"groepen" ontbreekt of is geen object');
  if (!apps || typeof apps !== "object" || Array.isArray(apps))
    fouten.push('"apps" ontbreekt of is geen object');
  if (fouten.length) throw new Error(`toegang.json: ${fouten.join("; ")}`);

  if (Object.hasOwn(groepen, PUBLIEK_GROEP)) {
    fouten.push(
      `groep "${PUBLIEK_GROEP}": die naam is van de policy voor de publieke paden; kies een andere naam`,
    );
  }
  for (const [naam, groep] of Object.entries(groepen)) {
    if (!GROEPNAAM.test(naam))
      fouten.push(`groep "${naam}": naam alleen kleine letters, cijfers en streepjes`);
    if (!groep || typeof groep !== "object" || Array.isArray(groep)) {
      fouten.push(`groep "${naam}": geen object`);
      continue;
    }
    for (const [veld, waarde] of Object.entries(groep)) {
      if (veld.startsWith("$")) continue;
      if (!VELDEN.includes(veld)) {
        fouten.push(`groep "${naam}", veld ${veld}: onbekend veld (wel: ${VELDEN.join(", ")})`);
        continue;
      }
      if (!Array.isArray(waarde) || waarde.some((x) => typeof x !== "string")) {
        fouten.push(`groep "${naam}", veld ${veld}: moet een lijst met tekst zijn`);
        continue;
      }
      const patroon = {
        domeinen: DOMEIN,
        adressen: ADRES,
        uitsluiten: ADRES,
        idp_groepen: IDP_GROEP,
      }[veld];
      for (const x of waarde) {
        const te = veld === "idp_groepen" ? x : x.toLowerCase();
        if (!patroon.test(te)) fouten.push(`groep "${naam}", veld ${veld}: "${x}" is ongeldig`);
      }
    }
    const aantal = ["domeinen", "adressen", "idp_groepen"].reduce(
      (n, v) => n + (groep[v]?.length ?? 0),
      0,
    );
    if (aantal === 0) {
      fouten.push(
        `groep "${naam}": geen domeinen, adressen of idp_groepen; een lege groep laat niemand toe`,
      );
    }
  }

  for (const [app, waarde] of Object.entries(apps)) {
    if (!GROEPNAAM.test(app))
      fouten.push(`app "${app}": naam alleen kleine letters, cijfers en streepjes`);
    if (!Array.isArray(waarde)) {
      if (!waarde || typeof waarde !== "object") {
        fouten.push(`app "${app}": een lijst groepen, of een object met groepen`);
        continue;
      }
      for (const veld of Object.keys(waarde)) {
        if (!APP_VELDEN.includes(veld) && !veld.startsWith("$"))
          fouten.push(`app "${app}", veld ${veld}: onbekend veld (wel: ${APP_VELDEN.join(", ")})`);
      }
      const paden = waarde.publiek ?? [];
      if (!Array.isArray(paden) || paden.some((p) => !geldigPad(p))) {
        fouten.push(
          `app "${app}": publiek is een lijst paden die met / beginnen, met hoogstens een * aan het eind (bijvoorbeeld "/bekijk/*"); de hele app ("/" of "/*") kan niet`,
        );
      }
      if (
        waarde.gegevens_naar_test !== undefined &&
        typeof waarde.gegevens_naar_test !== "boolean"
      ) {
        fouten.push(`app "${app}": gegevens_naar_test is true of false`);
      }
      if (waarde.klantportaal !== undefined && typeof waarde.klantportaal !== "boolean") {
        fouten.push(
          `app "${app}": klantportaal is true of false (zonder aanhalingstekens); nu staat er ${JSON.stringify(waarde.klantportaal)}`,
        );
      }
      if (waarde.captcha !== undefined && typeof waarde.captcha !== "boolean") {
        fouten.push(`app "${app}": captcha is true of false`);
      }
      if (
        waarde.turnstile_sitekey !== undefined &&
        (typeof waarde.turnstile_sitekey !== "string" || !SITEKEY.test(waarde.turnstile_sitekey))
      ) {
        fouten.push(
          `app "${app}": turnstile_sitekey is de openbare sleutel van de Turnstile-widget (letters, cijfers, - en _), niet de geheime`,
        );
      } else if ((waarde.turnstile_sitekey ?? "").length > SITEKEY_MAX) {
        fouten.push(
          `app "${app}": turnstile_sitekey heeft de lengte van de GEHEIME sleutel van Turnstile (meer dan ${SITEKEY_MAX} tekens). Hier hoort de openbare (Site Key). Staat de geheime nu in git, maak dan in Cloudflare een nieuwe (Turnstile, de widget, Rotate secret) en zet die alleen als secret TURNSTILE_GEHEIM`,
        );
      }
      if (isTurnstileTestsleutel(waarde.turnstile_sitekey)) {
        fouten.push(
          `app "${app}": turnstile_sitekey is een openbare testsleutel van Turnstile (een cijfer, een x en nullen). Die widget slaagt altijd en houdt niemand tegen. Maak een echte widget (Cloudflare, Turnstile, Add widget) en zet daarvan de Site Key`,
        );
      }
      if (waarde.klantportaal === true) {
        // De captcha staat standaard aan; uitzetten kan alleen uitdrukkelijk.
        if (waarde.captcha !== false && waarde.turnstile_sitekey === undefined) {
          fouten.push(
            `app "${app}": een klantportaal heeft standaard een captcha (Turnstile) op het inlogformulier. Zet "turnstile_sitekey" (de openbare sleutel van de widget; de geheime staat als secret TURNSTILE_GEHEIM in de beheeromgeving), of zet uitdrukkelijk "captcha": false als het portaal zonder captcha moet`,
          );
        }
        // Ook een lege lijst: wie later een pad toevoegt, moet eerst deze keuze zien.
        if (waarde.publiek !== undefined) {
          fouten.push(
            `app "${app}": publiek en klantportaal kunnen niet samen. Bij een klantportaal staat het hele domein al open; haal publiek weg, of haal klantportaal weg als alleen die paden open moeten`,
          );
        }
        if (waarde.afzender === undefined) {
          fouten.push(
            `app "${app}": een klantportaal heeft een afzender nodig voor de inlogmail, bijvoorbeeld "afzender": "Klantnaam <noreply@klant.nl>" (een adres op het domein dat bij Resend is geverifieerd)`,
          );
        } else if (!leesAfzender(waarde.afzender)) {
          fouten.push(
            `app "${app}": afzender is een e-mailadres of "Naam <adres>"; in de naam alleen letters, cijfers, spaties en . & ' ( ) -`,
          );
        }
      } else {
        for (const veld of ["afzender", "captcha", "turnstile_sitekey"]) {
          if (waarde[veld] !== undefined) {
            fouten.push(
              `app "${app}": ${veld} hoort bij een klantportaal; zet "klantportaal": true erbij of haal ${veld} weg`,
            );
          }
        }
      }
    }
    const gekozen = Array.isArray(waarde) ? waarde : waarde.groepen;
    if (!Array.isArray(gekozen) || gekozen.length === 0) {
      fouten.push(`app "${app}": geen groepen gekozen; een app zonder groep laat niemand toe`);
      continue;
    }
    for (const g of gekozen) {
      if (!Object.hasOwn(groepen, g)) fouten.push(`app "${app}", groep "${g}": onbekende groep`);
    }
  }

  // Een klantportaal en een app waarvan de naam botst met een naam die de inrichting voor de
  // ander maakt: de deur van klantportaal "x-worker" heet net als de Access op de Worker van
  // "x". Haalt het vinkje die deur weg, dan staan workers.dev en de previews van x open. Alleen
  // als een van de twee een klantportaal is; twee gewone apps blijven zoals op versie 42.
  for (const app of Object.keys(apps)) {
    for (const staart of NAAM_STAARTEN) {
      const ander = `${app}-${staart}`;
      if (!Object.hasOwn(apps, ander)) continue;
      if (!isKlantportaal(t, app) && !isKlantportaal(t, ander)) continue;
      fouten.push(
        `app "${ander}" en app "${app}": de naam "${ander}" gebruikt de inrichting zelf voor ${app} (een Access-app of het project van de testdatabase). Naast een klantportaal kan dat niet; geef "${ander}" een andere naam`,
      );
    }
  }

  const testaccounts = t.testaccounts;
  if (testaccounts !== undefined) {
    if (!testaccounts || typeof testaccounts !== "object" || Array.isArray(testaccounts)) {
      fouten.push('"testaccounts" is geen object (per app een lijst met adressen)');
    } else {
      for (const [app, lijst] of Object.entries(testaccounts)) {
        if (app.startsWith("$")) continue;
        if (!Object.hasOwn(apps, app)) {
          fouten.push(`testaccounts, app "${app}": staat niet onder apps`);
          continue;
        }
        if (!Array.isArray(lijst) || lijst.some((x) => typeof x !== "string")) {
          fouten.push(`testaccounts, app "${app}": moet een lijst met adressen zijn`);
          continue;
        }
        for (const x of lijst) {
          if (!ADRES.test(x.toLowerCase()))
            fouten.push(`testaccounts, app "${app}": "${x}" is geen geldig adres`);
        }
      }
    }
  }
  if (fouten.length) throw new Error(`toegang.json: ${fouten.join("; ")}`);
  return t;
}

/** De naam van de policy van een groep: het voorvoegsel plus de groepsnaam. */
export function policyNaam(groep, voorvoegsel) {
  return `${valideerVoorvoegsel(voorvoegsel)}${groep}`;
}

/**
 * Kan deze policy door dit script voor dit voorvoegsel gemaakt zijn? Dat is het
 * voorvoegsel plus een geldige groepsnaam. Een naam van een ander, genest voorvoegsel
 * kan hier niet tussen zitten: het voorvoegselpatroon (één streepje, aan het eind; zie
 * valideerVoorvoegsel) zorgt dat geen ander geldig voorvoegsel met dit voorvoegsel
 * begint.
 */
export function isEigenPolicy(naam, voorvoegsel) {
  const vv = valideerVoorvoegsel(voorvoegsel);
  return typeof naam === "string" && naam.startsWith(vv) && GROEPNAAM.test(naam.slice(vv.length));
}

/**
 * Een groep als herbruikbare Access-policy. NAGAAN (U7): de regelvormen
 * `email_domain.domain`, `email.email` en de IdP-groepsregels (`azureAD.id`,
 * `gsuite.email`, `okta.name`, elk met `identity_provider_id`).
 *
 * `groepenIdp` is de gekoppelde identiteitsdienst voor `idp_groepen`, als
 * `{ type: "azureAD" | "gsuite" | "okta", id }` (CLOUDFLARE_GROEPEN_IDP). De naam van de
 * policy is het voorvoegsel plus de groepsnaam.
 */
export function policyVoorGroep(naam, groep, { groepenIdp, voorvoegsel } = {}) {
  const vv = valideerVoorvoegsel(voorvoegsel);
  const include = [
    ...klein(groep.domeinen).map((domain) => ({ email_domain: { domain } })),
    ...klein(groep.adressen).map((email) => ({ email: { email } })),
  ];
  const idpGroepen = groep.idp_groepen ?? [];
  if (idpGroepen.length > 0) {
    if (!groepenIdp?.id || !groepenIdp?.type) {
      throw new Error(
        `groep "${naam}", veld idp_groepen: er is geen identiteitsdienst gekoppeld (zet CLOUDFLARE_GROEPEN_IDP als <type>:<id>, bijvoorbeeld azureAD:<id>)`,
      );
    }
    const regel = {
      azureAD: (g) => ({ azureAD: { id: g, identity_provider_id: groepenIdp.id } }),
      gsuite: (g) => ({ gsuite: { email: g, identity_provider_id: groepenIdp.id } }),
      okta: (g) => ({ okta: { name: g, identity_provider_id: groepenIdp.id } }),
    }[groepenIdp.type];
    if (!regel) {
      throw new Error(
        `groep "${naam}", veld idp_groepen: identiteitsdienst van type "${groepenIdp.type}" wordt niet ondersteund`,
      );
    }
    include.push(...idpGroepen.map(regel));
  }
  return {
    name: policyNaam(naam, vv),
    decision: "allow",
    include,
    exclude: klein(groep.uitsluiten).map((email) => ({ email: { email } })),
    require: [],
  };
}

/** Alle policies zoals het bestand ze wil; gooit vóór elke schrijfactie als er iets niet klopt. */
export function gewenstePolicies(toegang, opties) {
  const t = valideerToegang(toegang);
  return Object.entries(t.groepen).map(([naam, groep]) => ({
    groep: naam,
    body: policyVoorGroep(naam, groep, opties),
  }));
}

function vergelijkbaar(p) {
  return JSON.stringify({
    decision: p.decision,
    include: p.include ?? [],
    exclude: p.exclude ?? [],
    require: p.require ?? [],
  });
}

/** Een policy zonder voorvoegsel met de naam van een groep: van iemand anders, dus stoppen. */
export function kaleNaamConflicten(toegang, policies, voorvoegsel) {
  const vv = valideerVoorvoegsel(voorvoegsel);
  return Object.keys(toegang.groepen)
    .filter((g) => policies.some((p) => p.name === g))
    .map((g) => `Access-policy "${g}" bestaat al zonder voorvoegsel ${vv}`);
}

/**
 * Maakt de policies met voorvoegsel gelijk aan het bestand: aanmaken of bijwerken.
 * Verwijderen gebeurt apart (verwijderOverbodig), pas nadat de apps de oude policy
 * niet meer gebruiken; Cloudflare weigert een policy die nog gekoppeld is.
 */
export async function synchroniseerPolicies(
  cf,
  toegang,
  { groepenIdp, bestaand, voorvoegsel } = {},
) {
  const gewenst = gewenstePolicies(toegang, { groepenIdp, voorvoegsel });
  const huidig = bestaand ?? (await cf.policies());
  const conflicten = kaleNaamConflicten(toegang, huidig, voorvoegsel);
  if (conflicten.length) throw new Error(`gestopt zonder wijzigingen: ${conflicten.join("; ")}`);

  const ids = {};
  const acties = [];
  for (const { groep, body } of gewenst) {
    const er = huidig.find((p) => p.name === body.name);
    if (!er) {
      const nieuw = await cf.maakPolicy(body);
      ids[groep] = nieuw.id;
      acties.push(`policy ${body.name} aangemaakt`);
    } else {
      ids[groep] = er.id;
      if (vergelijkbaar(er) !== vergelijkbaar(body)) {
        await cf.werkPolicyBij(er.id, body);
        acties.push(`policy ${body.name} bijgewerkt`);
      }
    }
  }
  // De policy van de publieke paden is geen groep; die beheert de inrichting apart.
  const namen = new Set([
    ...gewenst.map((g) => g.body.name),
    policyNaam(PUBLIEK_GROEP, voorvoegsel),
  ]);
  const overbodig = huidig.filter((p) => isEigenPolicy(p.name, voorvoegsel) && !namen.has(p.name));
  return { ids, acties, overbodig };
}

export async function verwijderOverbodig(cf, overbodig) {
  const weg = [];
  for (const p of overbodig) {
    await cf.verwijderPolicy(p.id);
    weg.push(p.name);
  }
  return weg;
}

/** De policy-ids van een app, in de volgorde van het bestand. */
export function policyIdsVoorApp(toegang, app, ids) {
  return groepenVanApp(toegang, app).map((g) => ids[g]);
}

/**
 * Zet bij elke bestaande Access-app van elke app in het bestand de juiste policies.
 * Alleen waar de lijst anders is, wordt er geschreven.
 */
export async function koppelPolicies(cf, toegang, apps, ids, voorvoegsel) {
  const acties = [];
  for (const app of Object.keys(toegang.apps)) {
    const gewenst = policyIdsVoorApp(toegang, app, ids);
    const namen = appNamen(app, voorvoegsel);
    for (const naam of [namen.deur, namen.inlog, namen.testInlog, namen.worker]) {
      const er = apps.find((a) => a.name === naam);
      if (!er) continue;
      if (JSON.stringify(policyIdsVanApp(er)) === JSON.stringify(gewenst)) continue;
      await cf.werkAppBij(er.id, metPolicies(er, gewenst));
      acties.push(`policies van ${naam} bijgewerkt`);
    }
  }
  return acties;
}

/**
 * De testaccounts van een app, in kleine letters, met de vaste testgebruiker erbij.
 * Alleen voor de testdatabase; productie kent geen testaccounts.
 */
export function testaccountsVan(toegang, app) {
  const lijst = klein(toegang?.testaccounts?.[app]);
  return [...new Set([TESTGEBRUIKER, ...lijst])];
}

// ---------------------------------------------------------------- de beslissing

function geldigAdres(adres) {
  return /^[^@\s]+@[^@\s]+$/.test(adres);
}

/**
 * Mag dit adres bij deze app? "ja", "nee", of "onbekend" als een gekozen groep op
 * IdP-groepen werkt: aan een e-mailadres alleen zie je niet of iemand in die groep zit.
 */
export function magAanmelden(email, toegang, app) {
  const adres = String(email ?? "").toLowerCase();
  if (!geldigAdres(adres)) return "nee";
  const domein = adres.split("@")[1];
  let onbekend = false;
  for (const g of groepenVanApp(toegang, app)) {
    const groep = toegang.groepen[g];
    if (klein(groep.uitsluiten).includes(adres)) continue;
    if (klein(groep.domeinen).includes(domein) || klein(groep.adressen).includes(adres))
      return "ja";
    if ((groep.idp_groepen ?? []).length > 0) onbekend = true;
  }
  return onbekend ? "onbekend" : "nee";
}

/**
 * Heeft dit account een inlog via Cloudflare? Drie bronnen, en één is genoeg:
 *   - `cloudflare`: de rijen uit `auth.identities` (cloudflareIdentiteiten), de bron van
 *     waarheid;
 *   - `app_metadata.providers`: houdt Supabase Auth zelf bij, een gebruiker kan er niet bij;
 *   - `identities` op de gebruiker, als de lijst die meegeeft (de admin-lijst van Supabase
 *     doet dat niet: `FindUsersInAudience` laadt de identiteiten niet mee).
 * Meer bronnen maakt de kans kleiner dat een medewerker voor klant wordt aangezien; een
 * klant heeft in geen van de drie een Cloudflare-inlog, want die krijg je alleen door de
 * Access-policy van de inlogdienst.
 */
export function heeftCloudflareInlog(g, cloudflare) {
  if (cloudflare?.has(g.id)) return true;
  const meta = g.app_metadata ?? {};
  if (meta.provider === PROVIDER_CLOUDFLARE) return true;
  if (Array.isArray(meta.providers) && meta.providers.includes(PROVIDER_CLOUDFLARE)) return true;
  return (g.identities ?? []).some((i) => i?.provider === PROVIDER_CLOUDFLARE);
}

/** Kan dit account ook per mail inloggen (een e-mailinlog naast die van Cloudflare)? */
export function heeftMailInlog(g) {
  const meta = g.app_metadata ?? {};
  if (meta.provider === "email") return true;
  if (Array.isArray(meta.providers) && meta.providers.includes("email")) return true;
  return (g.identities ?? []).some((i) => i?.provider === "email");
}

/**
 * Het kenmerk dat App inrichten bij het sluiten van een klantportaal op elk klantaccount zet
 * (in `app_metadata`, waar een gebruiker zelf niet bij kan). Toegang bijwerken ziet het in de
 * gebruikerslijst die hij toch al leest, en bant zo'n account nooit: een portaal sluiten is
 * geen reden om honderden klanten te bannen. Een app die nooit klantportaal was, heeft geen
 * enkel account met dit kenmerk en gedraagt zich dus precies als altijd.
 */
export const KLANT_KENMERK = "klantportaal_klant";

/** Een klant van een gesloten klantportaal: het kenmerk, en geen inlog via Cloudflare. */
export function isOudKlant(g) {
  return g?.app_metadata?.[KLANT_KENMERK] === true && !heeftCloudflareInlog(g, null);
}

/** Lijkt dit account een klant: wel een inlog per mail, geen inlog via Cloudflare? */
export function lijktKlant(g) {
  return heeftMailInlog(g) && !heeftCloudflareInlog(g, null);
}

const ZONDER_CLOUDFLARE = `not in (select user_id from auth.identities where provider = '${PROVIDER_CLOUDFLARE}')`;

/**
 * Bij het sluiten van een klantportaal (terug naar een gewone app): elk account zonder inlog
 * via Cloudflare krijgt het klantkenmerk (één rij per account in het antwoord) en wordt
 * afgemeld. Geen ban. Twee losse vragen, allebei veilig te herhalen.
 */
export const KLANTEN_MARKEREN_SQL = `update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"${KLANT_KENMERK}": true}'::jsonb where id ${ZONDER_CLOUDFLARE} returning id::text as id;`;
export const KLANTEN_AFMELDEN_SQL = `delete from auth.sessions where user_id ${ZONDER_CLOUDFLARE};`;

/** Een adres voor in een melding: de eerste letter en het domein (`p***@klant.nl`). */
export function maskeerAdres(adres) {
  const [naam, domein] = String(adres ?? "")
    .toLowerCase()
    .split("@");
  return naam && domein ? `${naam[0]}***@${domein}` : "***";
}

/**
 * Klantaccounts (geen inlog via Cloudflare) op een adres dat volgens toegang.json van een
 * medewerker is. Dat gebeurt als een klant medewerker wordt, of als een medewerker het klantvak
 * gebruikte vóór de aanmeld-hook er was. Zo'n account blokkeert de inlog via Cloudflare van
 * die persoon blijvend: Supabase maakt dan een tweede account zonder adres, dat niet te
 * bevestigen is. De inrichting ruimt niets op; ze meldt het, met het adres gemaskeerd en de id
 * erbij zodat de owner het account in Supabase kan vinden.
 */
export function klantenOpMedewerkeradres(gebruikers, cloudflare, toegang, app) {
  return gebruikers
    .filter(
      (g) =>
        g.email &&
        !heeftCloudflareInlog(g, cloudflare) &&
        magAanmelden(g.email, toegang, app) === "ja",
    )
    .map((g) => `${maskeerAdres(g.email)} (id ${g.id})`);
}

export const KLANT_OP_MEDEWERKERADRES =
  "Dit adres hoort volgens toegang.json bij een medewerker, maar het account is een klantaccount (per mail gemaakt, zonder inlog via Cloudflare). Zolang het bestaat kan deze persoon niet als medewerker inloggen. Er is niets gewijzigd. Wat de owner doet: overleg met de persoon, verwijder het account in Supabase (Authentication, Users; zoek op de id) en laat hem daarna inloggen via Inloggen voor medewerkers. Wat aan het klantaccount hing, moet de eigenaar van de app zo nodig eerst overzetten";

/**
 * De adressen waarop een account met een Cloudflare-inlog beoordeeld wordt: het adres
 * waarmee Cloudflare hem binnenliet (uit de identiteit). Dat is het adres waar de
 * Access-policy op let, en het enige dat de gebruiker niet zelf kan veranderen. Alleen als
 * dat nergens te vinden is, telt het adres van het account zelf.
 */
function cloudflareAdressen(g, cloudflare) {
  const uit = new Set();
  for (const adres of cloudflare?.get(g.id) ?? []) uit.add(adres);
  for (const i of g.identities ?? []) {
    if (i?.provider !== PROVIDER_CLOUDFLARE) continue;
    const adres = i.identity_data?.email ?? i.email;
    if (adres) uit.add(adres);
  }
  const lijst = klein([...uit]).filter(Boolean);
  if (lijst.length) return [...new Set(lijst)];
  return g.email ? [String(g.email).toLowerCase()] : [];
}

/** Eén oordeel over meer adressen: één "nee" is nee, anders één "onbekend" is onbekend. */
function strengsteOordeel(oordelen) {
  if (oordelen.includes("nee")) return "nee";
  return oordelen.includes("onbekend") ? "onbekend" : "ja";
}

/**
 * Trekt de toegang in van wie niet meer past: een ban (lang genoeg om "voorgoed" te
 * zijn) en afmelden van alle sessies. Zonder dat laatste loopt een bestaande sessie
 * gewoon door; refresh-tokens verlopen op het gratis plan niet. Wie al geband is,
 * blijft onaangeroerd; wie "onbekend" is (IdP-groep) wordt gemeld, niet geband.
 *
 * Wie past en nog een actieve ban heeft (eerder ingetrokken, nu weer op de lijst),
 * krijgt de ban opgeheven via `ontban`. Wie past zonder ban, blijft onaangeroerd.
 *
 * `testaccounts` (alleen bij de testdatabase, zie testaccountsVan) telt als "past":
 * een testaccount wordt nooit geband, en een eerder gebande krijgt de ban opgeheven.
 *
 * `klantportaal` (alleen de productiedatabase van een klantportaal): de groepen in
 * toegang.json zijn daar alleen de medewerkers; klanten staan er niet in en loggen in per
 * mail. Daarom wordt alleen een account met een Cloudflare-inlog beoordeeld. Een account
 * zonder is een klant: geen ban, geen afmelding en ook geen opheffing van een ban (die kan
 * de klant zelf of de app hebben gezet); het telt mee in `klanten`.
 *
 * Een account met een Cloudflare-inlog wordt beoordeeld op het adres uit die inlog
 * (`cloudflare`, een Map van gebruikers-id naar adressen, zie cloudflareIdentiteiten). Past
 * dat niet meer, dan gaat het hele account dicht, ook als hetzelfde account daarnaast per
 * mail kan inloggen. Dat is bewust: het is het account van iemand die medewerker was. Zou
 * alleen de Cloudflare-kant dichtgaan, dan hield een vertrokken medewerker een werkend
 * account over, en hing alles af van de regels in elke app. Een account met een
 * Cloudflare-inlog zonder enig adres staat in `onbekend`, als `id:<gebruikers-id>`.
 * Bij een gewone app (geen klantportaal, niet de testdatabase) blijft alleen een account met
 * het klantkenmerk van een gesloten portaal buiten schot (isOudKlant); `klanten` staat dan
 * alleen in het resultaat als er zo'n account is. Is er zo'n account, dan staat het adres van
 * elk ander account dat alleen per mail kan inloggen gemaskeerd in het resultaat.
 * `zonderAdres` noemt de accounts met een Cloudflare-inlog die zelf geen adres hebben;
 * `ookPerMail` de ingetrokken accounts die daarnaast per mail konden inloggen.
 */
export async function trekIn({
  gebruikers,
  toegang,
  app,
  ban,
  afmelden,
  ontban,
  testaccounts = [],
  klantportaal = false,
  cloudflare = null,
  nu = new Date(),
}) {
  const test = new Set(klein(testaccounts));
  const uit = {
    ingetrokken: [],
    toegelaten: [],
    onaangeroerd: 0,
    alIngetrokken: [],
    onbekend: [],
  };
  if (klantportaal) {
    uit.klanten = 0;
    // Accounts met een Cloudflare-inlog maar zonder eigen adres (zie klantportaalInstellingen
    // in supabase.mjs): zo iemand kan niet als medewerker inloggen tot de owner het oplost.
    uit.zonderAdres = [];
    // Ingetrokken accounts die daarnaast per mail konden inloggen: het hele account is dicht.
    uit.ookPerMail = [];
  }
  // Was deze gewone app een klantportaal (er is een account met het klantkenmerk), dan komt het
  // adres van een account dat alleen per mail kan inloggen nooit leesbaar in het resultaat.
  // Een app die nooit klantportaal was heeft zo'n kenmerk niet en houdt de uitvoer van versie 42.
  const wasPortaal = !klantportaal && !test.size && gebruikers.some(isOudKlant);
  for (const g of gebruikers) {
    let naam = wasPortaal && lijktKlant(g) ? maskeerAdres(g.email) : g.email;
    let oordeel;
    if (klantportaal) {
      if (!heeftCloudflareInlog(g, cloudflare)) {
        uit.klanten += 1;
        continue;
      }
      const adressen = cloudflareAdressen(g, cloudflare);
      naam = g.email || adressen[0] || `id:${g.id}`;
      if (!g.email) uit.zonderAdres.push(naam);
      oordeel = adressen.length
        ? strengsteOordeel(adressen.map((a) => magAanmelden(a, toegang, app)))
        : "onbekend";
    } else {
      if (!g.email) continue;
      // Een klant van een gesloten klantportaal (zie KLANT_KENMERK): nooit geband.
      if (!test.size && isOudKlant(g)) {
        uit.klanten = (uit.klanten ?? 0) + 1;
        continue;
      }
      oordeel = test.has(String(g.email).toLowerCase())
        ? "ja"
        : magAanmelden(g.email, toegang, app);
    }
    const geband = Boolean(g.banned_until && new Date(g.banned_until) > nu);
    if (oordeel === "ja") {
      if (geband) {
        await ontban(g.id);
        uit.toegelaten.push(naam);
      } else {
        uit.onaangeroerd += 1;
      }
      continue;
    }
    if (oordeel === "onbekend") {
      uit.onbekend.push(naam);
      continue;
    }
    if (geband) {
      uit.alIngetrokken.push(naam);
      continue;
    }
    await ban(g.id);
    await afmelden(g.id);
    uit.ingetrokken.push(naam);
    if (klantportaal && heeftMailInlog(g)) uit.ookPerMail.push(naam);
  }
  return uit;
}

/**
 * De vraag aan de database: welke accounts hebben een inlog via Cloudflare, en op welk
 * adres? Alleen lezen. De admin-lijst van Supabase geeft de identiteiten niet mee, en een
 * account dat Cloudflare zonder bevestigd adres aanmaakte terwijl er al een klantaccount op
 * dat adres bestond, heeft zelf geen adres; de identiteit heeft het wel.
 */
export const CLOUDFLARE_IDENTITEITEN_SQL = `select user_id::text as user_id, lower(coalesce(identity_data->>'email', '')) as email from auth.identities where provider = '${PROVIDER_CLOUDFLARE}';`;

/**
 * Maakt van het antwoord op CLOUDFLARE_IDENTITEITEN_SQL een Map van gebruikers-id naar
 * adressen. Een antwoord dat geen lijst rijen is, is een fout: dan wordt er niets
 * ingetrokken en niets overgeslagen, in plaats van stil iedereen voor klant aan te zien.
 */
export function cloudflareIdentiteiten(rijen) {
  if (!Array.isArray(rijen)) {
    throw new Error(
      "de vraag naar de Cloudflare-inlogs (auth.identities) gaf geen lijst terug; er is niets ingetrokken",
    );
  }
  const uit = new Map();
  for (const rij of rijen) {
    if (!rij || typeof rij.user_id !== "string") {
      throw new Error("een rij uit auth.identities heeft geen user_id; er is niets ingetrokken");
    }
    const lijst = uit.get(rij.user_id) ?? [];
    if (typeof rij.email === "string" && rij.email) lijst.push(rij.email.toLowerCase());
    uit.set(rij.user_id, lijst);
  }
  return uit;
}

export const BAN_DUUR = "876000h";

/** Zo heft Supabase een ban op (`updateUserById`). */
export const GEEN_BAN = "none";

// ---------------------------------------------------------------- aanmeld-hook (testdatabase)

/**
 * De naam van de aanmeld-hookfunctie, afgeleid van het voorvoegsel:
 * `cf-proef-` wordt `cf_proef_voor_aanmelden`, `kl-` wordt `kl_voor_aanmelden`. Het
 * patroon van het voorvoegsel zorgt dat er alleen `[a-z0-9_]` in staat.
 */
export function hookFunctie(voorvoegsel) {
  return `${valideerVoorvoegsel(voorvoegsel).replaceAll("-", "_")}voor_aanmelden`;
}

/** Een tekst als SQL-literal: enkele aanhalingstekens verdubbeld. */
export function sqlTekst(waarde) {
  return `'${String(waarde).replaceAll("'", "''")}'`;
}

function sqlLijst(lijst) {
  return `array[${lijst.map(sqlTekst).join(", ")}]::text[]`;
}

const WEIGER =
  "return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Dit adres heeft geen toegang tot deze app.'));";

/** Per gekozen groep: toelaten bij een passend domein of adres, behalve de uitgeslotenen. */
function groepRegels(t, app, inspringen = "  ") {
  return groepenVanApp(t, app).map((g) => {
    const groep = t.groepen[g];
    return [
      `-- groep ${g}`,
      `if (domein = any (${sqlLijst(klein(groep.domeinen))}) or adres = any (${sqlLijst(klein(groep.adressen))}))`,
      `   and not (adres = any (${sqlLijst(klein(groep.uitsluiten))})) then`,
      "  return '{}'::jsonb;",
      "end if;",
    ]
      .map((r) => `${inspringen}${r}`)
      .join("\n");
  });
}

/**
 * De before-user-created-hook van de testdatabase (`<vv><app>-test`). Daar staat inloggen
 * met e-mail aan, zodat testaccounts met een wachtwoord kunnen inloggen. De hook kijkt
 * naar de provider (`user.app_metadata.provider` in de invoer van de hook):
 *   - `email` (mailcode of wachtwoord) mag alleen voor de testaccounts van de app;
 *   - `custom:cloudflare` mag voor de domeinen en adressen van de gekozen groepen, met
 *     dezelfde uitsluitingen als de Access-policies (IdP-groepen tellen hier niet mee);
 *   - elke andere provider (ook anoniem, zonder provider) wordt geweigerd.
 * Zonder die controle kan iemand die een toegelaten adres kent met een zelfgekozen
 * wachtwoord een account op dat adres maken, want `mailer_autoconfirm` staat aan.
 * Productie van een gewone app heeft geen hook: daar staat inloggen met e-mail uit. Productie
 * van een klantportaal heeft eigen hooks (portaalAanmeldHookSql en portaalTokenHookSql).
 *
 * De vaste testgebruiker (TESTGEBRUIKER) staat hier bewust níet in: Testdatabase
 * verversen maakt hem met de admin-API, en die gaat niet langs deze hook (in de broncode
 * van Supabase Auth roept alleen aanmelden, uitnodigen, anoniem, OAuth, SAML en web3 de
 * hook aan, `admin/users` niet). Zijn adres is openbaar; zo kan niemand hem met een eigen
 * wachtwoord vóór zijn.
 */
export function aanmeldHookSql(toegang, app, functie) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(functie))
    throw new Error(`ongeldige functienaam "${functie}"`);
  const t = valideerToegang(toegang);
  if (!t.apps[app]) throw new Error(`app "${app}" staat niet in toegang.json`);
  const naam = `public.${functie}`;
  return `create or replace function ${naam}(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $hook$
declare
  adres text := lower(coalesce(event->'user'->>'email', ''));
  domein text := split_part(adres, '@', 2);
  aanbieder text := coalesce(event->'user'->'app_metadata'->>'provider', '');
begin
  if adres !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    ${WEIGER}
  end if;
  -- testdatabase: met e-mail (mailcode of wachtwoord) alleen de testaccounts; de vaste
  -- testgebruiker maakt Testdatabase verversen met de admin-API, buiten deze hook om
  if aanbieder = 'email' then
    if adres = any (${sqlLijst(testaccountsVan(t, app).filter((a) => a !== TESTGEBRUIKER))}) then
      return '{}'::jsonb;
    end if;
    ${WEIGER}
  end if;
  -- via Cloudflare Access: de groepen uit toegang.json, zoals in productie
  if aanbieder <> ${sqlTekst(PROVIDER_CLOUDFLARE)} then
    ${WEIGER}
  end if;
${groepRegels(t, app).join("\n")}
  ${WEIGER}
end;
$hook$;

grant execute on function ${naam}(jsonb) to supabase_auth_admin;
revoke execute on function ${naam}(jsonb) from authenticated, anon, public;
`;
}

// ---------------------------------------------------------------- hooks van een klantportaal (productie)

/**
 * De namen van de twee hookfuncties in de productiedatabase van een klantportaal, afgeleid
 * van het voorvoegsel: `vb-` geeft `vb_portaal_voor_aanmelden` en `vb_portaal_voor_token`.
 */
export function portaalHookFuncties(voorvoegsel) {
  const p = valideerVoorvoegsel(voorvoegsel).replaceAll("-", "_");
  return { aanmelden: `${p}portaal_voor_aanmelden`, token: `${p}portaal_voor_token` };
}

const weiger = (melding) =>
  `return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', ${sqlTekst(melding)}));`;

export const MELDING_MEDEWERKER =
  "Dit adres hoort bij een medewerker. Log in via Inloggen voor medewerkers.";
export const MELDING_GEEN_WACHTWOORD =
  "Inloggen met een wachtwoord kan hier niet. Vraag een inlogcode aan.";

/**
 * De before-user-created-hook van de productiedatabase van een klantportaal. Daar mag
 * iedereen per mail een account maken, behalve op een adres van een medewerker:
 *   - `custom:cloudflare`: toegelaten. De poort is daar de Access-policy van de inlogdienst,
 *     net als bij een gewone app (IdP-groepen kent alleen Cloudflare);
 *   - `email`: geweigerd voor elk domein en elk adres uit de groepen van de app, toegelaten
 *     voor ieder ander. `uitsluiten` telt hier niet: wie op het domein van het bedrijf zit maar
 *     is uitgesloten, is geen klant;
 *   - elke andere manier (ook anoniem): geweigerd.
 * Zonder deze hook kan een vreemde het adres van een toekomstige medewerker per mail
 * aanmelden. Die medewerker krijgt dan bij zijn eerste inlog via Cloudflare een tweede account
 * zonder adres en kan niet als medewerker inloggen (nagespeeld tegen Supabase Auth, 13-11-2026).
 *
 * Wat de hook niet tegenhoudt: een bestaand account van een medewerker opent ook met een
 * mailcode op zijn werkadres (de hook loopt alleen bij een nieuw account). Dat is hetzelfde
 * account met een andere sessie; de app geeft medewerkerrechten alleen aan een sessie die
 * via Cloudflare kwam. Een groep met alleen `idp_groepen` heeft geen adressen om te weigeren;
 * daarvoor waarschuwt de inrichting.
 *
 * Toegang bijwerken schrijft de functie bij elke run opnieuw, zodat hij de groepen volgt.
 *
 * De rechten volgen de documentatie van Supabase voor een hook in Postgres: de rol van Supabase
 * Auth krijgt `usage` op het schema en `execute` op de functie, en niemand anders mag hem
 * aanroepen. Die `usage` staat er uitdrukkelijk: een app die het schema public heeft
 * dichtgezet (`revoke usage on schema public from public`) zou Supabase Auth anders de hook
 * niet laten aanroepen, en dan komt niemand meer binnen. De functies lezen geen tabellen, dus
 * verdere rechten zijn niet nodig.
 */
export function portaalAanmeldHookSql(toegang, app, functie) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(functie))
    throw new Error(`ongeldige functienaam "${functie}"`);
  const t = valideerToegang(toegang);
  if (!isKlantportaal(t, app)) throw new Error(`app "${app}" is geen klantportaal`);
  const groepen = groepenVanApp(t, app).map((g) => t.groepen[g]);
  const domeinen = [...new Set(groepen.flatMap((g) => klein(g.domeinen)))];
  const adressen = [...new Set(groepen.flatMap((g) => klein(g.adressen)))];
  const naam = `public.${functie}`;
  return `create or replace function ${naam}(event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $hook$
declare
  adres text := lower(coalesce(event->'user'->>'email', ''));
  domein text := split_part(adres, '@', 2);
  aanbieder text := coalesce(event->'user'->'app_metadata'->>'provider', '');
begin
  -- via Cloudflare Access: de Access-policy van de inlogdienst is de poort
  if aanbieder = ${sqlTekst(PROVIDER_CLOUDFLARE)} then
    return '{}'::jsonb;
  end if;
  if aanbieder <> 'email' or adres !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    ${weiger("Een account maken kan hier alleen met een e-mailadres.")}
  end if;
  -- per mail: iedereen, behalve de adressen van medewerkers (de groepen uit toegang.json)
  if domein = any (${sqlLijst(domeinen)}) or adres = any (${sqlLijst(adressen)}) then
    ${weiger(MELDING_MEDEWERKER)}
  end if;
  return '{}'::jsonb;
end;
$hook$;

grant usage on schema public to supabase_auth_admin;
grant execute on function ${naam}(jsonb) to supabase_auth_admin;
revoke execute on function ${naam}(jsonb) from authenticated, anon, public;
`;
}

/** Heeft een groep van dit klantportaal alleen `idp_groepen`? Dan kan de hook hem niet weigeren. */
export function groepenZonderAdressen(t, app) {
  return groepenVanApp(t, app).filter((g) => {
    const groep = t.groepen[g];
    return !(groep.domeinen?.length || groep.adressen?.length);
  });
}

/**
 * De custom-access-token-hook van de productiedatabase van een klantportaal: geen sessie met
 * een wachtwoord. Supabase Auth heeft geen instelling die alleen het wachtwoord uitzet terwijl
 * de mailcode aan blijft, en de hook die daarvoor bedoeld is (password verification) bestaat
 * alleen op het Team- en Enterprise-plan. Deze hook loopt bij elk token dat wordt uitgegeven,
 * binnen dezelfde transactie als de nieuwe sessie (internal/tokens/service.go); weigert hij,
 * dan is er geen token en geen sessie. Hij weigert als de inlog van nu met een wachtwoord was
 * (`authentication_method`) of als de sessie ooit met een wachtwoord begon (`amr` in de
 * claims; dat vangt ook het verversen van zo'n sessie). Alle andere tokens gaan ongewijzigd
 * door: de claims komen terug zoals ze binnenkwamen, dus `amr` en de rest blijven wat de
 * regels in de database (RLS) verwachten.
 *
 * Waarom: bij een open portaal kan iemand het adres van een klant aanmelden met een eigen
 * wachtwoord. Gebruikt de klant daarna de mail die daarvan komt, dan was het wachtwoord van de
 * ander geldig. Met deze hook is een wachtwoord nooit genoeg voor een sessie.
 *
 * Een project heeft maar één zo'n hook. Heeft de app er zelf een (extra claims), dan stopt de
 * inrichting vóór de eerste wijziging. Nooit stil vervangen.
 */
export function portaalTokenHookSql(functie) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(functie))
    throw new Error(`ongeldige functienaam "${functie}"`);
  const naam = `public.${functie}`;
  return `create or replace function ${naam}(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $hook$
declare
  amr jsonb := event->'claims'->'amr';
begin
  if coalesce(event->>'authentication_method', '') = 'password' then
    ${weiger(MELDING_GEEN_WACHTWOORD)}
  end if;
  if jsonb_typeof(amr) = 'array' and exists (
    select 1 from jsonb_array_elements(amr) as a
    where a->>'method' = 'password' or (jsonb_typeof(a) = 'string' and a #>> '{}' = 'password')
  ) then
    ${weiger(MELDING_GEEN_WACHTWOORD)}
  end if;
  return jsonb_build_object('claims', event->'claims');
end;
$hook$;

grant usage on schema public to supabase_auth_admin;
grant execute on function ${naam}(jsonb) to supabase_auth_admin;
revoke execute on function ${naam}(jsonb) from authenticated, anon, public;
`;
}
