#!/usr/bin/env node
/**
 * Richt één app in op Cloudflare, vanuit GitHub Actions (in de template: workflow
 * proef-inrichten; bij een klant: de beheer-repo): Cloudflare als deur en als
 * inlogdienst, Supabase als database en de koppeling daartussen. Zelfde patroon als
 * `stack-beheer/klant/scripts/inrichten.mjs`.
 *
 *   node beheer/inrichten-cloudflare.mjs --voorvoegsel <vv-> --app <naam>
 *        [--repo <org/naam>] [--wrangler <pad>] [--hostname <host>]
 *        [--testdatabase] [--droogloop | --opruimen | --tweede-doorgang | --toegang]
 *        [--deur-weghalen]   (alleen bij een klantportaal: captcha aan en de deur weg)
 *
 * Het voorvoegsel is verplicht (vlag of BEHEER_VOORVOEGSEL): `cf-proef-` voor de proef,
 * bij een klant bijvoorbeeld `kl-`. Buiten de proef zijn ook `--repo` (de app-repo die de
 * variabelen en secrets krijgt) en `--wrangler` (de wrangler.jsonc van die app, bij
 * een uitgecheckte app-repo) verplicht. Alleen de proef valt terug op de eigen repo
 * (GITHUB_REPOSITORY) en op wrangler.jsonc in de werkmap.
 *
 * Volgorde (plan U5, stap 3 en 4):
 *   3.1 Supabase-project (eu-central-1), wachten tot gezond, sleutels ophalen
 *   3.2 herbruikbare policies uit toegang.json, dan de Access SaaS-app (OIDC)
 *   3.3 custom provider custom:cloudflare in Supabase, met de issuer van de SaaS-app
 *   3.4 auth-config: site_url, uri_allow_list, e-mail-inlog uit (disable_signup blijft)
 *   3.5 Access-app op de hostname (de deur), dezelfde policies
 *       Bij een klantportaal (`"klantportaal": true` in toegang.json) juist geen deur:
 *       3.4 zet dan ook inloggen per mail aan (eigen SMTP, code en link, de rem, de captcha
 *       en twee hooks). Een deur die er nog staat blijft staan: alleen een run met
 *       --deur-weghalen haalt hem weg, als allerlaatste stap, en alleen als alles er vóór die
 *       run al klaar voor stond. Een mens haalt de deur weg, niet de code. Zie "Klantportaal"
 *       in de README
 *   4   Access op de Worker zelf (vóór 3.6, zodat hij er staat vóór de eerste uitrol)
 *   T   met --testdatabase: een tweede Supabase-project `<vv><app>-test` met een eigen
 *       SaaS-app `<vv><app>-test-inlog`, provider en auth-config; de previews wijzen
 *       daarheen en het wachtwoord komt als SUPABASE_TEST_DB_PASSWORD in production (de
 *       canary van deploy-db.yml) en preview (de droogloop van migraties, droogloop.yml).
 *       Daar staat inloggen met e-mail aan, maar alleen samen met de aanmeld-hook van
 *       de testdatabase: e-mail alleen voor testaccounts, Cloudflare voor de groepen
 *   3.6 GitHub-variabelen en -secrets per omgeving
 *
 * In de tijdelijke stand van wrangler.jsonc (geen routes; zie
 * scripts/lib/cloudflare-config.mjs) is er nog geen eigen domein. Dan is het adres
 * `<worker>.<subdomein>.workers.dev`, vervalt stap 3.5 en is de Access op de Worker
 * (stap 4) de enige deur. site_url en de redirect-lijst wijzen dan naar dat adres.
 * In beide standen staat workers.dev aan (anders werken de previews achter Access
 * niet). Bestaat de Worker nog niet, dan zet stap 4 daarom altijd eerst een
 * placeholder-Worker neer (503) en meteen de Access erop; de eerste echte uitrol
 * overschrijft de placeholder en landt zo direct achter de deur.
 *
 * Elke stap is idempotent: wat al bestaat met het voorvoegsel wordt
 * hergebruikt, wat bestaat zónder voorvoegsel laat het script stoppen vóór er iets
 * gewijzigd is. De eigen-domeinroute beheert dit script niet; die staat in wrangler.jsonc.
 *
 * Omgeving (GitHub-omgeving proef-beheer, zie beheer/README.md):
 *   CLOUDFLARE_PROEF_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_TEAM_DOMAIN,
 *   SUPABASE_ACCESS_TOKEN, SUPABASE_ORG_SLUG, GH_TOKEN (voor `gh`; in een beheer-repo
 *   het kortlevende token van de GitHub App), optioneel BEHEER_VOORVOEGSEL,
 *   CLOUDFLARE_IDP_IDS (komma's) en CLOUDFLARE_GROEPEN_IDP (<type>:<id>). Alleen voor een
 *   klantportaal: SMTP_WACHTWOORD (de sleutel van Resend) en TURNSTILE_GEHEIM (de geheime
 *   sleutel van de Turnstile-widget; alleen niet nodig met `"captcha": false`).
 *
 * Eindigt Toegang bijwerken met `fouten` in het resultaat (alleen bij een klantportaal: er is
 * niet of maar deels ingetrokken, of het portaal wacht op App inrichten), dan is de status
 * "mislukt" en de run rood, ook al is de rest gedaan.
 *
 * Uitvoer: één regel `INRICHTING {json}`; geheimen staan er nooit in leesbaar in, en in
 * GitHub Actions worden ze ook met ::add-mask:: uit het logboek gehouden. In GitHub Actions
 * komt daarnaast een leesbare samenvatting bij de run (GITHUB_STEP_SUMMARY).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { cloudflareConfig } from "../scripts/lib/cloudflare-config.mjs";
import {
  adresStand,
  afwijkingen,
  appNamen,
  cloudflareClient,
  deurApp,
  heeftPortaalMerk,
  inlogApp,
  issuerVoor,
  metGewenst,
  metPolicies,
  PORTAAL_MERK,
  PROEF_VOORVOEGSEL,
  policyIdsVanApp,
  publiekApp,
  publiekeUris,
  publiekPolicy,
  publiekPolicyNaam,
  valideerVoorvoegsel,
  wachtOpDiscovery,
  workerApp,
} from "./lib/cloudflare.mjs";
import { koppelSentry, sentryUitOmgeving } from "./lib/sentry.mjs";
import {
  afmeldSql,
  alleGebruikers,
  andereHooks,
  authInstellingen,
  CAPTCHA_LATER,
  CODE_LENGTE,
  callbackAdres,
  GEHEIME_VELDEN,
  GESLOTEN_PORTAAL,
  hookInstellingen,
  klantportaalInstellingen,
  REGIO,
  SESSIE,
  standaardAdmin,
  supabaseBeheer,
  supabaseUrl,
  toetsTurnstileGeheim,
  uriAllowList,
  verschil,
  verwijderProvider,
  wasKlantportaal,
  zetProvider,
} from "./lib/supabase.mjs";
import {
  aanmeldHookSql,
  afzenderVanApp,
  BAN_DUUR,
  CLOUDFLARE_IDENTITEITEN_SQL,
  captchaVanApp,
  cloudflareIdentiteiten,
  GEEN_BAN,
  gewenstePolicies,
  groepenVanApp,
  groepenZonderAdressen,
  hookFunctie,
  isKlantportaal,
  isTurnstileTestsleutel,
  KLANT_OP_MEDEWERKERADRES,
  KLANTEN_AFMELDEN_SQL,
  KLANTEN_MARKEREN_SQL,
  kaleNaamConflicten,
  klantenOpMedewerkeradres,
  koppelPolicies,
  PUBLIEK_GROEP,
  policyIdsVoorApp,
  policyNaam,
  portaalAanmeldHookSql,
  portaalHookFuncties,
  portaalTokenHookSql,
  publiekVanApp,
  sitekeyVanApp,
  synchroniseerPolicies,
  testaccountsVan,
  trekIn,
  valideerToegang,
  verwijderOverbodig,
} from "./lib/toegang.mjs";

export const OMGEVINGEN = ["production", "preview"];
/**
 * De databasesecrets staan in omgeving production (beperkt tot main), niet op de repo:
 * een workflow op een PR-tak kan repo-secrets lezen. deploy-db.yml migreert daarom in
 * die omgeving.
 */
export const SECRET_OMGEVING = "production";
/**
 * Het wachtwoord van de testdatabase staat ook in omgeving preview: daar draait de droogloop
 * van migraties (droogloop.yml, via workflow_run altijd in de versie van main). App inrichten
 * beperkt preview net als production tot main, dus code uit een PR komt er niet bij. Het
 * wachtwoord van productie komt nooit in preview.
 */
export const TEST_SECRET_OMGEVINGEN = [SECRET_OMGEVING, "preview"];
const GH_VARIABELEN = [
  // Alleen in omgeving production: daar migreert deploy-db.yml. Geen geheim (hij staat ook
  // in VITE_SUPABASE_URL), dus een variabele: dan is in de instellingen te zien op welke
  // database de migraties landen.
  "SUPABASE_PROJECT_REF",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_INLOGDIENST",
  // Alleen bij een klantportaal met captcha, alleen in production.
  "VITE_TURNSTILE_SITEKEY",
  "SUPABASE_POOLER_HOST",
  "SUPABASE_TEST_POOLER_HOST",
  "VITE_SENTRY_DSN",
];
/**
 * De openbare waarden voor de PR-job in uitrollen.yml. Die job noemt geen omgeving
 * (dan kan een PR nooit bij een sleutel), dus staan ze als repo-variabelen; ze komen
 * toch in de bundel.
 */
const GH_PREVIEW_VARIABELEN = [
  "PREVIEW_VITE_SUPABASE_URL",
  "PREVIEW_VITE_SUPABASE_ANON_KEY",
  "PREVIEW_VITE_SUPABASE_SCHEMA",
  "PREVIEW_VITE_INLOGDIENST",
  "PREVIEW_VITE_SENTRY_DSN",
];
const GH_SECRETS = ["SUPABASE_DB_PASSWORD", "SUPABASE_TEST_DB_PASSWORD"];
/**
 * Tot versie 39 stond de project-ref als secret in omgeving production. Opruimen haalt een
 * achtergebleven oud secret ook weg; de inrichting ruimt het op zodra de app het niet meer
 * leest (zie ruimOudeProjectRefOp).
 */
const OUDE_SECRETS = ["SUPABASE_PROJECT_REF"];
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

// ---------------------------------------------------------------- argumenten

/**
 * Leest de argumenten. `env` levert BEHEER_VOORVOEGSEL en GITHUB_REPOSITORY; de vlaggen
 * gaan voor. Alles wat niet klopt, stopt hier, vóór er iets gelezen of gewijzigd is.
 */
export function leesArgumenten(argv, env = {}) {
  const uit = {
    app: null,
    hostname: null,
    repo: null,
    wrangler: null,
    voorvoegsel: null,
    droogloop: false,
    opruimen: false,
    tweedeDoorgang: false,
    toegang: false,
    testdatabase: false,
    deurWeghalen: false,
  };
  const vlaggen = {
    "--testdatabase": "testdatabase",
    "--droogloop": "droogloop",
    "--opruimen": "opruimen",
    "--tweede-doorgang": "tweedeDoorgang",
    "--toegang": "toegang",
    "--deur-weghalen": "deurWeghalen",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (vlaggen[a]) uit[vlaggen[a]] = true;
    else if (["--app", "--hostname", "--repo", "--wrangler", "--voorvoegsel"].includes(a)) {
      const waarde = argv[i + 1];
      if (waarde === undefined || waarde.startsWith("--"))
        throw new Error(`${a} vraagt een waarde`);
      uit[a.slice(2)] = waarde;
      i += 1;
    } else throw new Error(`onbekende optie: ${a}`);
  }
  const modi = ["opruimen", "tweedeDoorgang", "toegang"].filter((m) => uit[m]);
  if (modi.length > 1) {
    throw new Error("kies één van --opruimen, --tweede-doorgang of --toegang");
  }
  if (uit.deurWeghalen && modi.length) {
    throw new Error(
      "--deur-weghalen hoort bij de gewone inrichting van een klantportaal, niet bij --opruimen, --tweede-doorgang of --toegang",
    );
  }
  const appNodig = !uit.opruimen && !uit.toegang;
  if (uit.app === null && appNodig) throw new Error("geef --app <naam> mee");
  if (uit.app !== null && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(uit.app)) {
    throw new Error("--app: alleen kleine letters, cijfers en streepjes");
  }
  if (uit.hostname !== null && !/^[a-z0-9.-]+$/.test(uit.hostname))
    throw new Error("--hostname is ongeldig");
  uit.voorvoegsel = valideerVoorvoegsel(uit.voorvoegsel ?? env.BEHEER_VOORVOEGSEL ?? null);
  if (uit.repo !== null && !REPO.test(uit.repo)) {
    throw new Error("--repo heeft de vorm <organisatie>/<naam>");
  }
  const proef = uit.voorvoegsel === PROEF_VOORVOEGSEL;
  // --toegang werkt op alle apps uit toegang.json en raakt geen app-repo.
  if (uit.repo === null && !uit.toegang) {
    if (!proef) {
      throw new Error(
        `geef --repo <organisatie>/<naam> mee: alleen de proef (voorvoegsel ${PROEF_VOORVOEGSEL}) mag terugvallen op de eigen repo (GITHUB_REPOSITORY)`,
      );
    }
    uit.repo = env.GITHUB_REPOSITORY || null;
  }
  const configNodig = !uit.opruimen && !uit.toegang;
  if (uit.wrangler === null && configNodig && !proef) {
    throw new Error(
      "geef --wrangler <pad> mee: het pad naar wrangler.jsonc van de uitgecheckte app-repo (alleen de proef leest wrangler.jsonc in de werkmap)",
    );
  }
  return uit;
}

/** Een databasewachtwoord: 32 tekens uit letters en cijfers, zonder tekens die URL's of shells verwarren. */
export function nieuwWachtwoord(bytes = randomBytes(48)) {
  const alfabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let uit = "";
  for (const b of bytes) {
    uit += alfabet[b % alfabet.length];
    if (uit.length === 32) break;
  }
  return uit;
}

// ---------------------------------------------------------------- verkennen (alleen lezen)

async function kiesIdps(d) {
  if (d.idps?.length) return [...d.idps];
  const lijst = await d.cf.identiteitsdiensten();
  const pin = lijst.filter((i) => i.type === "onetimepin").map((i) => i.id);
  if (pin.length === 0) {
    throw new Error(
      "er is geen one-time PIN-inlogmethode in Zero Trust (P1); voeg hem toe of zet CLOUDFLARE_IDP_IDS met de toegestane inlogmethoden",
    );
  }
  return pin;
}

/**
 * Leest alles wat er al staat en controleert of het script mag beginnen. Hier wordt
 * niets geschreven; elke reden om te stoppen komt hier boven, vóór de eerste wijziging.
 */
async function verken(arg, d, { schrijven }) {
  const t = valideerToegang(d.toegang);
  // Object.hasOwn: "constructor" of "toString" is geen app, ook al kent elk object ze.
  if (!Object.hasOwn(t.apps, arg.app)) {
    throw new Error(
      `app "${arg.app}" staat niet in beheer/toegang.json; voeg hem toe met minstens één groep`,
    );
  }
  const tijdelijk = arg.stand === "tijdelijk";
  if (tijdelijk && arg.hostname) {
    throw new Error(
      "in de tijdelijke stand (workers.dev) is er nog geen eigen domein; laat --hostname weg, of zet wrangler.jsonc eerst in de standaardstand",
    );
  }
  if (!tijdelijk && !/^[a-z0-9.-]+$/.test(arg.hostname ?? ""))
    throw new Error("de hostname ontbreekt of is ongeldig");
  if (!/^[a-z0-9-]+$/.test(arg.worker ?? ""))
    throw new Error("de Worker-naam ontbreekt (wrangler.jsonc)");
  if (schrijven && !arg.repo) {
    throw new Error(
      "geen repo bekend voor de GitHub-variabelen; geef --repo mee of draai in GitHub Actions",
    );
  }
  const vv = valideerVoorvoegsel(arg.voorvoegsel);
  const gewenst = gewenstePolicies(t, { groepenIdp: d.groepenIdp, voorvoegsel: vv });
  const namen = appNamen(arg.app, vv);
  const { cf, supabase } = d;

  const policies = await cf.policies();
  const apps = await cf.apps();
  const projecten = await supabase.projecten();
  const idps = await kiesIdps(d);
  const subdomein = await cf.workersSubdomein();
  const team = await cf.teamDomein();
  // In de tijdelijke stand is het workers.dev-adres van de Worker het enige adres.
  const hostname = tijdelijk ? `${arg.worker}.${subdomein}.workers.dev` : arg.hostname;

  const fouten = [...kaleNaamConflicten(t, policies, vv)];
  for (const naam of [namen.deur, namen.inlog, namen.testInlog, namen.worker, namen.publiek]) {
    const kaal = naam.slice(vv.length);
    if (apps.some((a) => a.name === kaal)) {
      fouten.push(`Access-app "${kaal}" bestaat al zonder voorvoegsel ${vv}`);
    }
  }
  const opHost = apps.find(
    (a) =>
      !a.name?.startsWith(vv) &&
      (a.domain === hostname || (a.destinations ?? []).some((x) => x.uri === hostname)),
  );
  if (opHost)
    fouten.push(`Access-app "${opHost.name}" (zonder voorvoegsel) bewaakt ${hostname} al`);
  // Een publiek pad dat al in een Access-app van iemand anders staat (een omweg met de
  // hand): eerst die weghalen, anders weet niemand welke app wint.
  const paden = publiekVanApp(t, arg.app);
  if (paden.length) {
    const uris = new Set(publiekeUris(hostname, paden));
    for (const a of apps) {
      if (a.name?.startsWith(vv)) continue;
      const dubbel = [a.domain, ...(a.destinations ?? []).map((x) => x.uri)].filter((u) =>
        uris.has(u),
      );
      if (dubbel.length) {
        fouten.push(
          `Access-app "${a.name}" (zonder voorvoegsel) staat al op ${[...new Set(dubbel)].join(", ")}; haal die eerst weg, de inrichting zet de publieke paden zelf`,
        );
      }
    }
  }
  for (const naam of [namen.project, namen.test]) {
    const kaal = naam.slice(vv.length);
    if (projecten.some((p) => p.name === kaal)) {
      fouten.push(`Supabase-project "${kaal}" bestaat al zonder voorvoegsel ${vv}`);
    }
  }
  // De testdatabase van app x heet zoals het project van een app x-test zou heten.
  if (arg.testdatabase && t.apps[`${arg.app}-test`]) {
    fouten.push(
      `er staat ook een app "${arg.app}-test" in toegang.json; die naam is van de testdatabase van ${arg.app}`,
    );
  }
  // Een klantportaal: alles wat ontbreekt hier al melden. Zonder mail en zonder deur zou
  // de app half ingericht achterblijven; de echte run stopt dus vóór de eerste wijziging,
  // een droogloop zet het als waarschuwing in het resultaat.
  const klantportaal = isKlantportaal(t, arg.app);
  if (arg.deurWeghalen && !klantportaal) {
    fouten.push(
      `het vinkje "Deur weghalen" (--deur-weghalen) is alleen voor een klantportaal, en ${arg.app} staat in toegang.json als gewone app. Zet het vinkje uit, of zet eerst "klantportaal": true in toegang.json (zie "Klantportaal" in beheer/README.md)`,
    );
  }
  const project = projecten.find((p) => p.name === namen.project) ?? null;
  const deur = apps.find((a) => a.name === namen.deur) ?? null;
  const workerAccess = apps.find((a) => a.name === namen.worker) ?? null;
  const testProject = projecten.find((p) => p.name === namen.test) ?? null;
  // Alleen een klantportaal leest hier meer (de auth-config, de variabelen en env.ts van de
  // app, en Turnstile); een gewone app krijgt geen enkele extra aanroep.
  const portaal = klantportaal
    ? await verkenPortaal(arg, d, {
        t,
        tijdelijk,
        project,
        deur,
        schrijven,
        hostname,
        subdomein,
        testProject,
        workerAccess,
      })
    : null;
  const gemis = portaal?.gemis ?? [];
  if (schrijven) fouten.push(...gemis);
  if (fouten.length) throw new Error(`gestopt zonder wijzigingen: ${fouten.join("; ")}`);

  return {
    t,
    klantportaal,
    portaal,
    gemis,
    gewenst,
    namen,
    policies,
    apps,
    idps,
    subdomein,
    team,
    hostname,
    tijdelijk,
    project,
    deur,
    inlog: apps.find((a) => a.name === namen.inlog) ?? null,
    testProject,
    testInlog: apps.find((a) => a.name === namen.testInlog) ?? null,
    workerAccess,
    publiek: apps.find((a) => a.name === namen.publiek) ?? null,
  };
}

// ---------------------------------------------------------------- klantportaal

export const KLANTPORTAAL_INLOGDIENST = "cloudflare,mailcode";

/**
 * Waaraan de inrichting ziet dat de app de lijst `cloudflare,mailcode` begrijpt: `src/lib/env.ts`
 * leest VITE_INLOGDIENST met leesInlogdiensten (vanaf versie 43 van de template). Een app tot
 * en met versie 42, en een app van de openbare template, keurt alleen één waarde uit een vaste
 * lijst goed en start met `cloudflare,mailcode` niet meer op. Het versienummer in
 * `.claude/stack-version` zegt dit niet: de openbare template telt anders.
 */
export const APP_KENMERK = { bestand: "src/lib/env.ts", tekst: "leesInlogdiensten" };

/**
 * De verkenning van een klantportaal, alleen lezen. Geeft wat de run nodig heeft en `gemis`:
 * elke reden waarom de echte run vóór de eerste wijziging stopt (een droogloop toont ze als
 * waarschuwing). Leest: de auth-config van productie (als het project er is), de variabelen
 * van omgeving production en `src/lib/env.ts` van de app-repo, en vraagt Turnstile of het
 * geheim klopt.
 */
async function verkenPortaal(arg, d, o) {
  const { t, tijdelijk, project, deur, schrijven } = o;
  const kp = `klantportaal ${arg.app}`;
  const gemis = [];
  const functies = portaalHookFuncties(arg.voorvoegsel);
  const captcha = captchaVanApp(t, arg.app);
  const sitekey = sitekeyVanApp(t, arg.app);
  if (tijdelijk) {
    gemis.push(
      `${kp}: een klantportaal vraagt een eigen domein. In de tijdelijke stand is het workers.dev-adres het enige adres, en dat blijft altijd dicht; zet eerst het domein in wrangler.jsonc`,
    );
  }
  if (!d.smtpWachtwoord) {
    gemis.push(
      `${kp}: het secret SMTP_WACHTWOORD ontbreekt in de beheeromgeving (de sleutel van Resend, waarmee de inlogmail wordt verstuurd). Zonder mail kan geen klant inloggen; zet het secret en draai App inrichten opnieuw`,
    );
  }
  if (captcha && !d.captchaGeheim) {
    gemis.push(
      `${kp}: de captcha staat aan (de standaard bij een klantportaal), maar het secret TURNSTILE_GEHEIM ontbreekt in de beheeromgeving (de geheime sleutel van de Turnstile-widget waarvan de openbare sleutel als turnstile_sitekey in toegang.json staat). Zet het secret, of zet uitdrukkelijk "captcha": false in toegang.json`,
    );
  } else if (captcha && d.captchaGeheim === sitekey) {
    // De twee sleutels van een widget lijken op elkaar. Staat dezelfde waarde op beide
    // plekken, dan is een van de twee verkeerd: of het geheim staat in git en in de bundel van
    // de app, of Supabase krijgt een geheim dat niet werkt.
    gemis.push(
      `${kp}: turnstile_sitekey in toegang.json en het secret TURNSTILE_GEHEIM zijn dezelfde waarde. Een widget heeft er twee: de openbare (Site Key) hoort in toegang.json, de geheime (Secret Key) alleen in het secret. Stond de geheime in toegang.json, dan staat hij nu in git: maak in Cloudflare een nieuwe (Turnstile, de widget, Rotate secret)`,
    );
  } else if (captcha && isTurnstileTestsleutel(d.captchaGeheim)) {
    // Turnstile kent de testgeheimen wel (de toets hieronder zou slagen), maar ze keuren elk
    // bewijs goed: dan staat de captcha aan en houdt hij niemand tegen.
    gemis.push(
      `${kp}: het secret TURNSTILE_GEHEIM is een openbaar testgeheim van Turnstile (een cijfer, een x en nullen). Daarmee keurt Turnstile elk bewijs goed en houdt de captcha niemand tegen. Zet de Secret Key van de echte widget (Cloudflare, Turnstile, de widget, Settings)`,
    );
  } else if (captcha) {
    if (!d.fetchFn) throw new Error("geen fetchFn om het geheim van Turnstile te toetsen");
    const reden = await toetsTurnstileGeheim(d.fetchFn, d.captchaGeheim);
    if (reden) gemis.push(`${kp}: ${reden}`);
  }

  // De app-repo: begrijpt de app de lijstwaarde, en wat stond er al in production? Een
  // droogloop zonder sleutel voor GitHub kan dat niet lezen en zegt dat.
  let variabelen = null;
  let appBegrijpt = null;
  try {
    if (!arg.repo) throw new Error("geen repo bekend");
    const env = await leesGhBestand(d, arg.repo, APP_KENMERK.bestand);
    appBegrijpt = Boolean(env?.includes(APP_KENMERK.tekst));
    variabelen = Object.fromEntries(
      (await leesGhVariabelen(d, SECRET_OMGEVING, arg.repo)).map((x) => [x.name, x.value]),
    );
  } catch (fout) {
    if (schrijven) throw fout;
  }
  if (appBegrijpt === false) {
    gemis.push(
      `${kp}: de app in ${arg.repo} begrijpt de inlog van een klantportaal nog niet (${APP_KENMERK.bestand} op main leest VITE_INLOGDIENST niet met ${APP_KENMERK.tekst}). Met ${KLANTPORTAAL_INLOGDIENST} zou de app in de browser niet meer opstarten. Werk de app eerst bij naar versie 43 of later (/stagetwo-tier2:updaten), merge dat, en draai App inrichten daarna opnieuw`,
    );
  }

  // De auth-config zoals hij nu is. Een project heeft van elke soort maar één hook; heeft de
  // app er zelf een, dan stopt de inrichting. Geen schakelaar om hem te laten staan: de
  // weigeringen van het klantportaal zitten in de hooks van de inrichting.
  const auth = project ? await d.supabase.authConfig(project.ref) : null;
  const andere = andereHooks(auth, functies);
  for (const [soort, naam] of [
    ["aanmelden", "aanmeld-hook (before user created)"],
    ["token", "token-hook (custom access token)"],
    ["mail", "hook die de mail verstuurt (send email)"],
  ]) {
    if (!andere[soort]) continue;
    gemis.push(
      `${kp}: de app heeft een eigen ${naam}: ${andere[soort]}. Een klantportaal gebruikt de hooks van de inrichting; haal de eigen hook weg of overleg met Stage Two`,
    );
  }

  // Live: geen deur op het domein en inloggen per mail staat al aan. Dan kunnen klanten erbij.
  const live = !deur && auth?.external_email_enabled === true;
  // De run met het vinkje wijzigt niets behalve de deur. Staat er nog iets anders te wijzigen,
  // dan is wat achter de deur is getest niet wat live zou gaan: stoppen, vóór de eerste
  // wijziging.
  if (arg.deurWeghalen && deur) {
    const nog = nogTeWijzigen(arg, d, { ...o, auth, variabelen, functies, captcha, sitekey });
    if (nog.length) {
      gemis.push(
        `${kp}: de deur gaat niet weg, want er staat nog iets anders te wijzigen: ${nog.join("; ")}. Een run met het vinkje wijzigt alleen de deur. Draai eerst App inrichten zonder vinkje en test opnieuw (stap 3 en 4 in beheer/README.md); zet daarna pas het vinkje`,
      );
    }
  } else if (arg.deurWeghalen && live) {
    // Een portaal dat al live is: het vinkje zet daar het geheim van de captcha opnieuw (zie
    // captchaStand). Dat mag pas als de app de bijbehorende openbare sleutel al heeft.
    const nog = variabelenNog(variabelen, sitekey);
    if (nog.length) {
      gemis.push(
        `${kp}: het portaal is live, en het vinkje zet dan het geheim van de captcha opnieuw. Dat gebeurt niet, want ${nog.join("; ")}. Draai App inrichten eerst zonder vinkje (die zet de openbare sleutel klaar), rol de app uit, en zet dan het vinkje`,
      );
    }
  }
  return { gemis, auth, variabelen, appBegrijpt, live, functies, captcha, sitekey };
}

/** De twee adressen die de Access op de Worker hoort te bewaken: workers.dev en de previews. */
function workerAdressen(arg, subdomein) {
  const basis = `${arg.worker}.${subdomein}.workers.dev`;
  return { domain: basis, destinations: [{ uri: basis }, { uri: `*-${basis}` }] };
}

/** Wat er in omgeving production van de app-repo nog niet staat zoals een klantportaal het wil. */
function variabelenNog(variabelen, sitekey) {
  if (variabelen === null) return ["de variabelen van de app-repo zijn niet te lezen"];
  const nog = [];
  if (variabelen.VITE_INLOGDIENST !== KLANTPORTAAL_INLOGDIENST)
    nog.push(
      `VITE_INLOGDIENST staat in omgeving production nog niet op ${KLANTPORTAAL_INLOGDIENST}`,
    );
  if ((variabelen.VITE_TURNSTILE_SITEKEY ?? null) !== sitekey)
    nog.push("VITE_TURNSTILE_SITEKEY in omgeving production is niet de sleutel uit toegang.json");
  return nog;
}

/**
 * Wat een gewone run (zonder vinkje) nu nog zou wijzigen aan dit klantportaal; leeg = niets,
 * en alleen dan mag de deur weg. Geheimen worden niet vergeleken (de run met het vinkje
 * schrijft ze ook niet), en de sessieduur niet: die weigert Supabase onder het Pro-plan, en dan
 * zou de deur nooit weg kunnen.
 */
function nogTeWijzigen(arg, d, o) {
  const nog = [];
  nog.push(...variabelenNog(o.variabelen, o.sitekey));
  if (!o.auth) nog.push("het Supabase-project bestaat nog niet");
  else if (d.smtpWachtwoord && (!o.captcha || d.captchaGeheim)) {
    const gewenst = portaalAuth(arg, d, { ...o, captcha: o.captcha });
    const anders = Object.keys(verschil(o.auth, gewenst)).filter(
      (veld) => !GEHEIME_VELDEN.includes(veld),
    );
    if (anders.length)
      nog.push(
        `de inloginstellingen in Supabase staan nog niet zoals de inrichting ze zet (${anders.join(", ")})`,
      );
  }
  const naam = appNamen(arg.app, arg.voorvoegsel).worker;
  if (!o.workerAccess)
    nog.push(
      `de Access op de Worker (${naam}) ontbreekt: workers.dev en de previews zijn niet bewaakt`,
    );
  else {
    const gewenst = workerAdressen(arg, o.subdomein);
    const stand = adresStand(o.workerAccess, gewenst);
    if (stand.onbekend)
      nog.push(
        `de Access op de Worker (${naam}) heeft bestemmingen zonder adres, dus de inrichting kan niet zien of ${gewenst.domain} en de previews dicht zijn. Zet in Cloudflare (Zero Trust, Access, Applications, ${naam}) de adressen ${gewenst.destinations.map((x) => x.uri).join(" en ")} als gewone bestemming (public hostname) en haal de bestemming zonder adres weg`,
      );
    else if (stand.ontbreekt.length)
      nog.push(`de Access op de Worker (${naam}) bewaakt ${stand.ontbreekt.join(" en ")} nog niet`);
    if (!heeftPortaalMerk(o.workerAccess))
      nog.push(`de Access op de Worker (${naam}) heeft het merk van een klantportaal nog niet`);
  }
  return nog;
}

/**
 * Wat deze run met de captcha doet. Standaard gaat hij aan in dezelfde aanroep als het
 * inloggen per mail: zolang de deur er staat (of de app nieuw is) kan geen klant erbij, dus
 * sluit dat niemand buiten en is er geen moment waarop inloggen per mail zonder captcha open
 * staat. Alleen op een portaal dat al live is blijft de captcha zonder vinkje zoals hij is:
 * een nieuwe sleutel of een nieuw geheim zou klanten buitensluiten tot de app ermee is
 * uitgerold. Daar zet alleen een run met het vinkje hem (opnieuw) aan.
 */
function captchaStand(arg, v) {
  if (!v.portaal.captcha) return false;
  return v.portaal.live && !arg.deurWeghalen ? CAPTCHA_LATER : true;
}

/**
 * De auth-instellingen van productie bij een klantportaal: de gewone (authInstellingen) met die
 * van het klantportaal eroverheen. Met een testdatabase staat op de lijst van terugkeeradressen
 * alleen het domein: de previews draaien code uit pull requests en horen bij de testdatabase;
 * staan ze op de lijst van productie, dan kan zo'n preview een medewerker bij productie laten
 * inloggen en het token ontvangen.
 */
function portaalAuth(arg, d, { t, hostname, subdomein, testProject, functies, captcha }) {
  return {
    ...authInstellingen({ hostname, worker: arg.worker, subdomein }),
    ...(arg.testdatabase || testProject ? { uri_allow_list: `https://${hostname}/**` } : {}),
    ...klantportaalInstellingen({
      afzender: afzenderVanApp(t, arg.app),
      smtpWachtwoord: d.smtpWachtwoord,
      captcha,
      captchaGeheim: d.captchaGeheim,
      hooks: functies,
    }),
  };
}

export const PREVIEWS_OP_PRODUCTIE =
  "er is geen testdatabase, dus de previews van pull requests loggen in bij productie en staan daar op de lijst van terugkeeradressen. Bij een klantportaal hoort dat niet: een preview draait code uit een pull request. Geef de app een testdatabase (App inrichten met testdatabase); daarna haalt de inrichting de previews van de lijst van productie";

/**
 * De auth-instellingen van productie: de gewone (authInstellingen), en bij een klantportaal
 * die van het klantportaal eroverheen. De testdatabase krijgt altijd alleen de gewone.
 */
function productieAuth(arg, d, v, basis) {
  if (!v.klantportaal) return basis;
  return portaalAuth(arg, d, {
    t: v.t,
    hostname: v.hostname,
    subdomein: v.subdomein,
    testProject: v.testProject,
    functies: v.portaal.functies,
    captcha: captchaStand(arg, v),
  });
}

/**
 * De twee hookfuncties van een klantportaal in de productiedatabase schrijven (zie
 * portaalAanmeldHookSql en portaalTokenHookSql). Altijd vóór de auth-config ze aanzet.
 */
async function schrijfPortaalHooks(d, t, app, ref, voorvoegsel, { alleenAanmelden = false } = {}) {
  const functies = portaalHookFuncties(voorvoegsel);
  await d.supabase.voerSqlUit(ref, portaalAanmeldHookSql(t, app, functies.aanmelden));
  if (!alleenAanmelden) await d.supabase.voerSqlUit(ref, portaalTokenHookSql(functies.token));
  return functies;
}

export const CAPTCHA_UIT =
  'de captcha staat uit ("captcha": false in toegang.json). Zonder captcha kan één computer in een paar minuten de mailgrens van het hele uur opmaken, waarna geen klant meer een inlogmail krijgt, en mails laten sturen naar adressen van anderen. Zet hem alleen tijdelijk uit';

/** De waarschuwingen die bij elke run van een klantportaal horen. */
function portaalWaarschuwingen(arg, v) {
  const uit = [];
  if (!captchaVanApp(v.t, arg.app)) uit.push(`klantportaal ${arg.app}: ${CAPTCHA_UIT}`);
  const zonder = groepenZonderAdressen(v.t, arg.app);
  if (zonder.length) {
    uit.push(
      `klantportaal ${arg.app}: groep ${zonder.join(", ")} werkt alleen op idp_groepen. De aanmeld-hook kent van die medewerkers geen adres en kan dus niet tegenhouden dat iemand zo'n adres per mail aanmeldt vóór de medewerker zelf via Cloudflare inlogt (die krijgt dan een account zonder adres). Zet het domein of de adressen van die medewerkers ook in een groep van deze app`,
    );
  }
  if (!(arg.testdatabase || v.testProject))
    uit.push(`klantportaal ${arg.app}: ${PREVIEWS_OP_PRODUCTIE}`);
  if (v.portaal.live && !arg.deurWeghalen && v.portaal.captcha) {
    uit.push(
      v.portaal.auth?.security_captcha_enabled === true
        ? `klantportaal ${arg.app} is live: deze run verandert niets aan de captcha. Heb je een nieuwe widget of een nieuw geheim, rol dan eerst de app uit met de nieuwe sleutel en draai App inrichten daarna met het vinkje "Deur weghalen"; die zet het nieuwe geheim`
        : `klantportaal ${arg.app} is live en de captcha staat UIT in Supabase. Deze run zet hem niet aan (dan zou geen klant meer een code kunnen aanvragen als de app de widget nog niet toont). Controleer dat de app in productie de widget toont en draai App inrichten met het vinkje "Deur weghalen"; die zet de captcha aan`,
    );
  }
  return uit;
}

/**
 * Klantaccounts op een adres van een medewerker (zie klantenOpMedewerkeradres), voor App
 * inrichten: leest de gebruikers en hun Cloudflare-inlogs, wijzigt niets.
 */
async function leesKlantenOpMedewerkeradres(d, t, app, ref) {
  const sleutels = await d.supabase.sleutels(ref);
  d.maskeer?.(sleutels.serviceRole);
  const admin = (d.maakAdmin ?? standaardAdmin)(supabaseUrl(ref), sleutels.serviceRole);
  const gebruikers = await alleGebruikers(admin);
  const cloudflare = cloudflareIdentiteiten(
    await d.supabase.voerSqlUit(ref, CLOUDFLARE_IDENTITEITEN_SQL),
  );
  return klantenOpMedewerkeradres(gebruikers, cloudflare, t, app);
}

function meldKlantenOpMedewerkeradres(sleutel, lijst) {
  return lijst.map((wie) => `${sleutel}: ${wie}. ${KLANT_OP_MEDEWERKERADRES}`);
}

/**
 * De meldingen over klantaccounts op een adres van een medewerker, voor App inrichten. Het is
 * alleen een melding: lukt het lezen niet, dan loopt de inrichting door en zegt ze dat.
 */
async function klantenOpMedewerkeradresMeldingen(d, t, app, ref) {
  try {
    return meldKlantenOpMedewerkeradres(app, await leesKlantenOpMedewerkeradres(d, t, app, ref));
  } catch (fout) {
    return [
      `${app}: niet nagegaan of er klantaccounts op een adres van een medewerker staan (${fout.message}). Toegang bijwerken kijkt daar bij elke run ook naar`,
    ];
  }
}

const KLANTPORTAAL_OPEN =
  "klantportaal: het domein staat open voor iedereen; workers.dev en de previews blijven dicht";

// ---------------------------------------------------------------- publieke paden

function urisVanApp(a) {
  return (a?.destinations ?? []).map((x) => x.uri);
}

/**
 * Zorgt dat de bypass-policy van de publieke paden bestaat; geeft zijn id. Met `droog`
 * schrijft hij niets en is het id een plaatshouder als de policy er nog niet is.
 */
async function zorgVoorPubliekPolicy(d, policies, vv, { droog, acties }) {
  const naam = publiekPolicyNaam(vv);
  const er = policies.find((p) => p.name === naam);
  if (er) {
    const gewenst = publiekPolicy(naam);
    const anders =
      er.decision !== gewenst.decision ||
      JSON.stringify(er.include ?? []) !== JSON.stringify(gewenst.include);
    if (anders && !droog) {
      await d.cf.werkPolicyBij(er.id, gewenst);
      acties.push(`policy ${naam} bijgewerkt (iedereen, zonder inlog)`);
    }
    return er.id;
  }
  if (droog) {
    acties.push(`gepland: policy ${naam} (iedereen, zonder inlog)`);
    return "<publiek>";
  }
  const nieuw = await d.cf.maakPolicy(publiekPolicy(naam));
  policies.push(nieuw);
  acties.push(`policy ${naam} aangemaakt (iedereen, zonder inlog)`);
  return nieuw.id;
}

/**
 * De publieke paden van één app gelijk aan toegang.json: de Access-app `<vv><app>-publiek`
 * aanmaken, bijwerken of (bij een lege lijst) weghalen. `hostname` is het adres van de app:
 * het eigen domein, of in de tijdelijke stand het workers.dev-adres. Geeft een lijst acties.
 */
async function zetPubliekePaden(d, { t, app, vv, hostname, apps, policies, droog }) {
  const naam = appNamen(app, vv).publiek;
  const paden = publiekVanApp(t, app);
  const er = apps.find((a) => a.name === naam);
  const acties = [];
  if (!paden.length) {
    if (er) {
      if (!droog) await d.cf.verwijderApp(er.id);
      acties.push(
        `${droog ? "gepland: " : ""}${naam} ${droog ? "weghalen" : "weggehaald"} (geen publieke paden meer)`,
      );
    }
    return acties;
  }
  const policyId = await zorgVoorPubliekPolicy(d, policies, vv, { droog, acties });
  const body = publiekApp({ naam, hostname, paden, policyId });
  const lijst = paden.join(" ");
  if (!er) {
    if (droog)
      acties.push(
        `gepland: ${naam} op ${hostname}, open zonder inlog: ${lijst} (en de gebouwde bestanden)`,
      );
    else {
      const nieuw = await d.cf.maakApp(body);
      apps.push(nieuw);
      acties.push(`${naam} aangemaakt (${nieuw.id}), open zonder inlog: ${lijst}`);
    }
    return acties;
  }
  const zelfde =
    JSON.stringify(urisVanApp(er)) === JSON.stringify(urisVanApp(body)) &&
    JSON.stringify(policyIdsVanApp(er)) === JSON.stringify([policyId]);
  if (zelfde) {
    acties.push(`${naam} ongewijzigd (${er.id}): ${lijst}`);
    return acties;
  }
  if (droog) acties.push(`gepland: ${naam} bijwerken: ${lijst}`);
  else {
    await d.cf.werkAppBij(er.id, {
      ...metPolicies(er, [policyId]),
      domain: body.domain,
      destinations: body.destinations,
    });
    acties.push(`${naam} bijgewerkt (${er.id}): ${lijst}`);
  }
  return acties;
}

/** Heeft geen enkele app nog publieke paden, dan de bypass-policy weg. */
async function ruimPubliekPolicyOp(d, t, policies, vv, { droog }) {
  const naam = publiekPolicyNaam(vv);
  const er = policies.find((p) => p.name === naam);
  if (!er || Object.keys(t.apps).some((app) => publiekVanApp(t, app).length)) return [];
  if (!droog) await d.cf.verwijderPolicy(er.id);
  return [
    `${droog ? "gepland: " : ""}policy ${naam} ${droog ? "weghalen" : "weggehaald"} (geen publieke paden meer)`,
  ];
}

// ---------------------------------------------------------------- GitHub

function leesJsonLijst(tekst) {
  const lijst = JSON.parse(tekst || "[]");
  return Array.isArray(lijst) ? lijst : [];
}

/** `--env <omgeving>`, of niets voor de repo zelf (env === null). */
function envArgs(env) {
  return env ? ["--env", env] : [];
}

/** De variabelen van één GitHub-omgeving (of van de repo bij env null), als `{ name, value }`. */
async function leesGhVariabelen(d, env, repo) {
  return leesJsonLijst(
    await d.gh(["variable", "list", ...envArgs(env), "--repo", repo, "--json", "name,value"]),
  );
}

/** De namen van de secrets van een omgeving of de repo (de waarden geeft GitHub nooit terug). */
async function leesGhSecretNamen(d, env, repo) {
  return leesJsonLijst(
    await d.gh(["secret", "list", ...envArgs(env), "--repo", repo, "--json", "name"]),
  ).map((s) => s.name);
}

async function zetVariabelen(d, env, repo, variabelen, gezet) {
  const huidig = Object.fromEntries(
    (await leesGhVariabelen(d, env, repo)).map((v) => [v.name, v.value]),
  );
  for (const [naam, waarde] of Object.entries(variabelen)) {
    if (huidig[naam] === waarde) continue;
    await d.gh(["variable", "set", naam, ...envArgs(env), "--repo", repo], { invoer: waarde });
    gezet.push(`${env ?? "repo"}/${naam}`);
  }
}

/**
 * Zet variabelen per omgeving en op de repo (alleen wat anders is) en secrets, via stdin.
 * `productieVariabelen` komen alleen in production. Een secret staat in omgeving production,
 * of in de omgevingen uit zijn `omgevingen`.
 */
async function zetGithub(
  d,
  repo,
  { variabelen = {}, productieVariabelen = {}, repoVariabelen = {}, secrets = {} },
) {
  const gezet = [];
  for (const env of OMGEVINGEN) {
    const hier = { ...variabelen, ...(env === SECRET_OMGEVING ? productieVariabelen : {}) };
    if (Object.keys(hier).length) await zetVariabelen(d, env, repo, hier, gezet);
  }
  if (Object.keys(repoVariabelen).length) {
    await zetVariabelen(d, null, repo, repoVariabelen, gezet);
  }
  const bestaand = {};
  for (const [naam, { waarde, altijd, omgevingen = [SECRET_OMGEVING] }] of Object.entries(
    secrets,
  )) {
    if (!waarde) continue;
    for (const env of omgevingen) {
      bestaand[env] ??= await leesGhSecretNamen(d, env, repo);
      if (!altijd && bestaand[env].includes(naam)) continue;
      // Secrets gaan via stdin, nooit als argument: argumenten zijn zichtbaar in de proceslijst.
      await d.gh(["secret", "set", naam, "--env", env, "--repo", repo], { invoer: waarde });
      gezet.push(`${env}/secret ${naam}`);
    }
  }
  return gezet;
}

/** De standaard-`gh`: een kindproces met GH_TOKEN uit de omgeving; invoer via stdin. */
export function standaardGh(env = process.env) {
  return (args, { invoer } = {}) =>
    new Promise((resolve, reject) => {
      const kind = spawn("gh", args, { env: { ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let uit = "";
      let fout = "";
      kind.stdout.on("data", (c) => {
        uit += c;
      });
      kind.stderr.on("data", (c) => {
        fout += c;
      });
      kind.on("error", reject);
      kind.on("close", (code) =>
        code === 0
          ? resolve(uit)
          : reject(
              new Error(
                `gh ${args.slice(0, 3).join(" ")} gaf ${code}: ${fout.trim().slice(0, 300)}`,
              ),
            ),
      );
      kind.stdin.end(invoer ?? "");
    });
}

/**
 * Eenmalig opruimen: tot versie 39 stond de project-ref als secret in omgeving production;
 * nu is het een variabele. Het oude secret gaat pas weg als deploy-db.yml van de app de
 * variabele leest (vanaf versie 39: `vars.SUPABASE_PROJECT_REF || secrets...`). Een app op
 * een oudere versie leest alleen het secret; zonder zou hij geen migraties meer draaien.
 * Geeft `{ stap?, waarschuwing? }` voor het resultaat.
 */
export async function ruimOudeProjectRefOp(d, repo) {
  const secrets = await leesGhSecretNamen(d, SECRET_OMGEVING, repo);
  if (!secrets.includes("SUPABASE_PROJECT_REF")) return {};
  const workflow = await leesGhBestand(d, repo, ".github/workflows/deploy-db.yml");
  if (!workflow?.includes("vars.SUPABASE_PROJECT_REF")) {
    return {
      waarschuwing:
        "het oude secret SUPABASE_PROJECT_REF blijft voorlopig in omgeving production: deploy-db.yml van de app leest de nieuwe variabele nog niet. Werk de app bij naar versie 39 of later (/stagetwo-tier2:updaten) en draai App inrichten daarna nog een keer; dan ruimt die het op",
    };
  }
  await d.gh([
    "secret",
    "delete",
    "SUPABASE_PROJECT_REF",
    "--env",
    SECRET_OMGEVING,
    "--repo",
    repo,
  ]);
  return {
    stap: "opgeruimd: de project-ref staat nu als variabele SUPABASE_PROJECT_REF in omgeving production",
  };
}

/** Een bestand op de standaardtak van een repo, als tekst; null als het er niet is. */
async function leesGhBestand(d, repo, pad) {
  try {
    const inhoud = await d.gh(["api", `repos/${repo}/contents/${pad}`, "-q", ".content"]);
    return Buffer.from(String(inhoud).replace(/\s/g, ""), "base64").toString("utf8");
  } catch (fout) {
    if (/404|Not Found/.test(fout.message)) return null;
    throw fout;
  }
}

// ---------------------------------------------------------------- foutbewaking (Sentry)

export const SENTRY_NIET_GEKOPPELD =
  "Sentry nog niet gekoppeld, dus fouten uit productie komen niet in Sentry. Koppelen doet in de projectfase Stage Two en daarna de owner van de beheer-repo, met zijn eigen Sentry-account: sentry-koppelen.mjs uit de plugin (skills/installatie/scripts) zet SENTRY_AUTH_TOKEN en SENTRY_ORG in de omgeving beheer en start App inrichten opnieuw";

/**
 * Stap S. Met een Sentry-sleutel in de beheeromgeving (`d.sentry`): het project van deze
 * app en zijn eigen DSN, met een proefmelding (zie lib/sentry.mjs). Zonder sleutel: de oude
 * weg van de proef (één DSN uit de beheeromgeving, `d.sentryDsn`), of een duidelijke regel.
 * Geeft `{ actie, dsn?, waarschuwing? }`; met `dsn` zet 3.6 hem in production, preview en
 * als PREVIEW_VITE_SENTRY_DSN.
 */
async function stapSentry(arg, d, { droog }) {
  const huidig = droog
    ? undefined
    : ((await leesGhVariabelen(d, SECRET_OMGEVING, arg.repo)).find(
        (v) => v.name === "VITE_SENTRY_DSN",
      )?.value ?? null);
  if (d.sentry) {
    const k = await koppelSentry(d.sentry, {
      app: arg.app,
      huidig,
      droog,
      slaap: d.slaap,
      pogingen: d.sentryPogingen,
      wachtMs: d.sentryWachtMs,
    });
    return { actie: k.actie, dsn: k.nieuw ? k.dsn : null, waarschuwing: k.waarschuwing };
  }
  if (d.sentryDsn) {
    return {
      actie: "DSN uit de beheeromgeving (VITE_SENTRY_DSN), dezelfde voor elke app",
      dsn: d.sentryDsn,
    };
  }
  if (huidig)
    return {
      actie: "staat aan (de DSN stond er al); zonder SENTRY_AUTH_TOKEN niet verder gecontroleerd",
    };
  return { actie: droog ? `gepland: niets. ${SENTRY_NIET_GEKOPPELD}` : SENTRY_NIET_GEKOPPELD };
}

// ---------------------------------------------------------------- stap 4

/**
 * Stap 4. De Access op de Worker bewaakt het workers.dev-adres en de previews (in de
 * tijdelijke stand is hij de enige deur). Bestaat de Worker nog niet, dan komt er eerst
 * een placeholder, zodat die deur er staat vóór de eerste uitrol (die de placeholder
 * overschrijft).
 *
 * Een gewone app: precies als op versie 42 (alleen policies en inlogmethoden). Bij een
 * klantportaal komt daar bij: het merk (PORTAAL_MERK), en een gewenst adres dat ontbreekt
 * wordt toegevoegd. Nooit vervangen: een adres dat iemand er met de hand bij zette, blijft
 * bewaakt. Heeft een gewone app het merk nog (het portaal is net gesloten), dan gaat het weg.
 */
async function stapWorker(arg, d, v, policyIds) {
  const stap = "4 Access op de Worker";
  let placeholder = false;
  if (!(await d.cf.workerBestaat(arg.worker))) {
    await d.cf.maakPlaceholder(arg.worker);
    placeholder = true;
  }
  if (!v.workerAccess) {
    const nieuw = await d.cf.maakApp(
      workerApp({
        naam: v.namen.worker,
        worker: arg.worker,
        subdomein: v.subdomein,
        policyIds,
        idps: v.idps,
        merk: v.klantportaal,
      }),
    );
    return {
      stap,
      actie: placeholder ? "placeholder neergezet, Access aangemaakt" : "aangemaakt",
      id: nieuw.id,
    };
  }
  const voor = placeholder ? "placeholder neergezet, Access " : "";
  const anders = afwijkingen(v.workerAccess, policyIds, v.idps);
  const extra = {};
  let waarschuwing = null;
  if (v.klantportaal) {
    const gewenst = workerAdressen(arg, v.subdomein);
    const stand = adresStand(v.workerAccess, gewenst);
    if (stand.onbekend) waarschuwing = workerAdresOnbekend(v, gewenst);
    else if (stand.ontbreekt.length) {
      anders.push("adres");
      extra.destinations = [
        ...(v.workerAccess.destinations ?? []),
        ...stand.ontbreekt.map((uri) => ({ type: "public", uri })),
      ];
      if (!v.workerAccess.domain) extra.domain = gewenst.domain;
      waarschuwing = `de Access op de Worker bewaakte ${stand.ontbreekt.join(" en ")} niet; dat adres is erbij gezet. Wat hij al bewaakte, bewaakt hij nog`;
    }
    if (!heeftPortaalMerk(v.workerAccess)) {
      anders.push("merk klantportaal");
      extra.custom_deny_message = PORTAAL_MERK;
    }
  } else if (heeftPortaalMerk(v.workerAccess)) {
    // Het portaal is in deze run gesloten (de deur staat er, inloggen per mail is uit, de
    // klanten hebben het kenmerk): nu pas mag het merk weg.
    anders.push("merk klantportaal weggehaald");
    extra.custom_deny_message = "";
  }
  if (!anders.length) {
    return {
      stap,
      actie: `${voor}ongewijzigd`,
      id: v.workerAccess.id,
      ...(waarschuwing ? { waarschuwing } : {}),
    };
  }
  await d.cf.werkAppBij(v.workerAccess.id, {
    ...metGewenst(v.workerAccess, policyIds, v.idps),
    ...extra,
  });
  return {
    stap,
    actie: `${voor}${anders.join(" en ")} bijgewerkt`,
    id: v.workerAccess.id,
    ...(waarschuwing ? { waarschuwing } : {}),
  };
}

/** De melding als de Access op de Worker bestemmingen zonder adres heeft (zie adresStand). */
function workerAdresOnbekend(v, gewenst) {
  return `de Access op de Worker (${v.namen.worker}) heeft bestemmingen zonder adres (zo geeft Cloudflare de nieuwe Worker-bestemmingen terug). De inrichting kan dan niet zien of hij ${gewenst.domain} en de previews bewaakt, en heeft het adres daarom niet aangeraakt. Een run met het vinkje Deur weghalen stopt hierop`;
}

// ---------------------------------------------------------------- de inrichting

const GEEN_DEUR = "overgeslagen: tijdelijke stand (workers.dev), de Access op de Worker is de deur";
const PLACEHOLDER_GEPLAND = "gepland: placeholder en Access op de Worker";

/** Wat stap 4 in een droogloop zou doen. */
function geplandWorker(arg, v, workerBestaat) {
  if (!workerBestaat) return PLACEHOLDER_GEPLAND;
  if (!v.workerAccess) return `gepland: ${v.namen.worker}`;
  const basis = `bestaat al (${v.workerAccess.id})`;
  if (!v.klantportaal) return basis;
  const stand = adresStand(v.workerAccess, workerAdressen(arg, v.subdomein));
  if (stand.onbekend)
    return `${basis}; het adres is niet te controleren (bestemmingen zonder adres) en blijft zoals het is`;
  return stand.ontbreekt.length
    ? `${basis}; gepland: ${stand.ontbreekt.join(" en ")} erbij zetten`
    : basis;
}

/** Wat 3.4 bij een klantportaal zou zetten, zonder een geheim te noemen. */
function geplandeMail(arg, v) {
  const a = afzenderVanApp(v.t, arg.app);
  const f = v.portaal.functies;
  const stand = captchaStand(arg, v);
  const captcha =
    stand === false
      ? "UIT"
      : stand === CAPTCHA_LATER
        ? "blijft zoals hij is (het portaal is live; alleen een run met het vinkje Deur weghalen zet een nieuw geheim)"
        : "aan (Turnstile)";
  return `klantportaal: inloggen per mail aan (code van ${CODE_LENGTE} cijfers en link, 15 minuten geldig), mail via Resend van ${a.naam} <${a.adres}>, adressen eerst bevestigen (mailer_autoconfirm uit), adres wijzigen niet zelf te bevestigen, de rem op het inlogformulier, captcha ${captcha}, hooks public.${f.aanmelden} (geen aanmelding per mail op een adres van een medewerker) en public.${f.token} (geen sessie met een wachtwoord), sessies vervallen na ${SESSIE.sessions_inactivity_timeout / 24} dagen zonder gebruik (als het plan van Supabase dat toelaat)`;
}

export const VINKJE = 'het vinkje "Deur weghalen (klantportaal live zetten)"';

/** Wat 3.5 bij een klantportaal zou doen, met en zonder het vinkje. */
function geplandeDeurWeg(arg, v) {
  if (!v.deur) return `geen deur. ${KLANTPORTAAL_OPEN} (${v.hostname})`;
  if (!arg.deurWeghalen) {
    return `${v.namen.deur} (${v.deur.id}) blijft staan. Een run zonder ${VINKJE} verandert nooit iets aan de deur en is veilig te herhalen. Een run met het vinkje haalt alleen de deur weg en wijzigt verder niets`;
  }
  return v.gemis.length
    ? `${v.namen.deur} (${v.deur.id}) blijft staan: de echte run stopt vóór de eerste wijziging (zie de waarschuwingen)`
    : `gepland: ${v.namen.deur} (${v.deur.id}) weghalen; verder wijzigt deze run niets. ${KLANTPORTAAL_OPEN} (${v.hostname})`;
}

/** De regel voor een gewone app die klantportaal was: het portaal gaat dicht. */
function portaalDicht(arg, v) {
  return `HET KLANTPORTAAL VAN ${arg.app} GAAT DICHT: in toegang.json staat ${arg.app} als gewone app. De deur komt terug op https://${v.hostname} en inloggen per mail gaat uit. Klanten kunnen daarna niet meer inloggen. Ze worden afgemeld en krijgen een kenmerk, zodat Toegang bijwerken ze nooit bant; hun accounts blijven bestaan. Is dit een vergissing, zet dan "klantportaal": true terug in toegang.json vóór je App inrichten echt draait`;
}

function geplandeStappen(arg, v, workerBestaat, publiekGepland = [], sentryGepland = "") {
  const bestaat = (x, tekst) => (x ? `bestaat al (${x.id ?? x.ref})` : `gepland: ${tekst}`);
  const policiesErAl = v.gewenst.every((g) => v.policies.some((p) => p.name === g.body.name));
  return [
    { stap: "3.1 Supabase-project", actie: bestaat(v.project, `${v.namen.project} in ${REGIO}`) },
    {
      stap: "3.2 Access-policies",
      actie: policiesErAl
        ? "bestaat al (bijwerken waar nodig)"
        : `gepland: ${v.gewenst.map((g) => g.body.name).join(", ")}`,
    },
    {
      stap: "3.2 Access SaaS-app (OIDC)",
      actie: bestaat(v.inlog, `${v.namen.inlog}, inlogmethoden ${v.idps.join(", ")}`),
    },
    { stap: "3.3 custom provider custom:cloudflare", actie: "gepland: aanmaken of gelijkzetten" },
    {
      stap: "3.4 auth-config",
      actie: `gepland: site_url https://${v.hostname}, redirects ${uriAllowList({ hostname: v.hostname, worker: arg.worker, subdomein: v.subdomein }).join(" ")}, ${v.klantportaal ? geplandeMail(arg, v) : "e-mail-inlog uit"}`,
    },
    ...(arg.testdatabase
      ? [
          {
            stap: "T testdatabase",
            actie: bestaat(
              v.testProject,
              `${v.namen.test} in ${REGIO}, SaaS-app ${v.namen.testInlog}; de previews wijzen daarheen`,
            ),
          },
          {
            stap: "T testdatabase: aanmeld-hook",
            actie: `gepland: public.${hookFunctie(arg.voorvoegsel)} en inloggen met e-mail, alleen voor testaccounts (${testaccountsVan(v.t, arg.app).join(", ")})`,
          },
        ]
      : []),
    {
      stap: "3.5 Access-app op de hostname",
      actie: v.tijdelijk
        ? GEEN_DEUR
        : v.klantportaal
          ? geplandeDeurWeg(arg, v)
          : bestaat(v.deur, `${v.namen.deur} op ${v.hostname}`),
    },
    ...(publiekGepland.length
      ? [{ stap: "3.5b publieke paden", actie: publiekGepland.join("; ") }]
      : []),
    { stap: "4 Access op de Worker", actie: geplandWorker(arg, v, workerBestaat) },
    { stap: "S foutmeldingen (Sentry)", actie: sentryGepland },
    {
      stap: "3.6 GitHub-variabelen en -secrets",
      actie: `gepland in ${arg.repo ?? "(geen repo)"}: variabelen in ${OMGEVINGEN.join(" en ")} (SUPABASE_PROJECT_REF alleen in ${SECRET_OMGEVING}), ${GH_PREVIEW_VARIABELEN.join(", ")} als repo-variabelen, secrets in omgeving ${SECRET_OMGEVING}`,
    },
  ];
}

/** 3.2 voor één Supabase-project: de SaaS-app (OIDC) aanmaken, of de policies gelijkzetten. */
async function stapInlogApp(d, { bestaand, naam, ref, policyIds, idps, maskeer }) {
  if (!bestaand) {
    const inlog = await d.cf.maakApp(
      inlogApp({ naam, callback: callbackAdres(ref), policyIds, idps }),
    );
    const clientSecret = inlog?.saas_app?.client_secret ?? null;
    maskeer(clientSecret);
    return { inlog, clientSecret, actie: `aangemaakt (${inlog.id})` };
  }
  const anders = afwijkingen(bestaand, policyIds, idps);
  if (anders.length) {
    await d.cf.werkAppBij(bestaand.id, metGewenst(bestaand, policyIds, idps));
    return {
      inlog: bestaand,
      clientSecret: null,
      actie: `hergebruikt, ${anders.join(" en ")} bijgewerkt (${bestaand.id})`,
    };
  }
  return { inlog: bestaand, clientSecret: null, actie: `hergebruikt (${bestaand.id})` };
}

/**
 * 3.3 en 3.4 voor één Supabase-project: de custom provider met de issuer van zijn
 * SaaS-app, daarna de auth-config.
 */
async function koppelInlog(d, v, { ref, serviceRole, saas, naam, gewenstAuth, voorWijziging }) {
  // NAGAAN (U7): client_id staat in `saas_app.client_id` van het antwoord.
  const clientId = saas.inlog?.saas_app?.client_id;
  if (!clientId) throw new Error(`de SaaS-app ${naam} heeft geen client_id in saas_app`);
  const issuer = issuerVoor(v.team, clientId);
  // Een net aangemaakte SaaS-app is pas na een paar minuten bereikbaar; zonder te
  // wachten weigert Supabase de provider, en dan is het geheim weg.
  await (d.wachtOpDiscovery ?? wachtOpDiscovery)(issuer);
  const admin = (d.maakAdmin ?? standaardAdmin)(supabaseUrl(ref), serviceRole);
  const provider = await zetProvider(admin.customProviders, {
    issuer,
    clientId,
    clientSecret: saas.clientSecret,
  });
  const vorig = await d.supabase.authConfig(ref);
  // Alleen bij productie van een gewone app: was dit een klantportaal, dan komt hier eerst de
  // deur terug en komen er instellingen bij (zie sluitPortaal). Anders verandert er niets.
  const erbij = (await voorWijziging?.(vorig)) ?? {};
  const anders = verschil(vorig, { ...gewenstAuth, ...erbij });
  if (Object.keys(anders).length) await d.supabase.werkAuthBij(ref, anders);
  const auth = Object.keys(anders).length
    ? `bijgewerkt: ${Object.keys(anders).join(", ")}`
    : "ongewijzigd";
  return { issuer, provider, auth, vorig };
}

/**
 * Stap T: de testdatabase. Een eigen Supabase-project met een eigen SaaS-app, zodat
 * een preview nooit bij productie kan; dezelfde policies, dus dezelfde mensen. De
 * migraties zet deploy-db.yml erop zodra `testdatabase` in stack.config.json staat
 * (App inrichten opent daarvoor een pull request op de app-repo).
 */
async function stapTestdatabase(arg, d, v, { policyIds, gewenstAuth, maskeer, stap }) {
  let project = v.testProject;
  if (project) stap("T testdatabase: project", `hergebruikt (${project.ref})`);
  else {
    const wachtwoord = (d.wachtwoord ?? nieuwWachtwoord)();
    maskeer(wachtwoord);
    project = await d.supabase.maakProject(v.namen.test, wachtwoord);
    stap("T testdatabase: project", `aangemaakt (${project.ref}, ${REGIO})`);
    // Net als bij productie: meteen bewaren, het wachtwoord is alleen nu bekend.
    await zetGithub(d, arg.repo, {
      secrets: {
        SUPABASE_TEST_DB_PASSWORD: {
          waarde: wachtwoord,
          altijd: true,
          omgevingen: TEST_SECRET_OMGEVINGEN,
        },
      },
    });
  }
  await d.supabase.wachtTotGezond(project.ref);
  const sleutels = await d.supabase.sleutels(project.ref);
  maskeer(sleutels.serviceRole);
  const saas = await stapInlogApp(d, {
    bestaand: v.testInlog,
    naam: v.namen.testInlog,
    ref: project.ref,
    policyIds,
    idps: v.idps,
    maskeer,
  });
  stap("T testdatabase: SaaS-app (OIDC)", saas.actie);
  // Eerst de aanmeld-hook, dan pas inloggen met e-mail aan (in de auth-config hieronder):
  // e-mail mag nooit aan staan zonder hook, want mailer_autoconfirm staat aan.
  const functie = await schrijfTestHook(d, v.t, arg.app, project.ref, arg.voorvoegsel);
  stap(
    "T testdatabase: aanmeld-hook",
    `public.${functie} geschreven; e-mail alleen voor testaccounts, Cloudflare voor de groepen`,
  );
  const k = await koppelInlog(d, v, {
    ref: project.ref,
    serviceRole: sleutels.serviceRole,
    saas,
    naam: v.namen.testInlog,
    gewenstAuth: { ...gewenstAuth, ...hookInstellingen(functie) },
  });
  stap("T testdatabase: provider en auth-config", `${k.provider}; auth-config ${k.auth}`);
  const zonderWachtwoord = [];
  if (v.testProject) {
    for (const env of TEST_SECRET_OMGEVINGEN) {
      const namen = await leesGhSecretNamen(d, env, arg.repo);
      if (!namen.includes("SUPABASE_TEST_DB_PASSWORD")) zonderWachtwoord.push(env);
    }
  }
  if (zonderWachtwoord.length) {
    // Het oude wachtwoord is niet op te vragen. Voor de testdatabase mag een nieuw: zonder
    // dit secret slaat deploy-db.yml de canary over (en gaan migraties meteen naar
    // productie), en kan de droogloop in preview niet draaien. Een app van vóór versie 39
    // heeft het nog niet in preview; dan komt er één keer een nieuw, in beide omgevingen.
    // Productie krijgt dit nooit.
    const wachtwoord = (d.wachtwoord ?? nieuwWachtwoord)();
    maskeer(wachtwoord);
    await d.supabase.zetDatabaseWachtwoord(project.ref, wachtwoord);
    await zetGithub(d, arg.repo, {
      secrets: {
        SUPABASE_TEST_DB_PASSWORD: {
          waarde: wachtwoord,
          altijd: true,
          omgevingen: TEST_SECRET_OMGEVINGEN,
        },
      },
    });
    stap(
      "T testdatabase: wachtwoord",
      `ontbrak in omgeving ${zonderWachtwoord.join(" en ")}: nieuw gezet in Supabase en als secret in ${TEST_SECRET_OMGEVINGEN.join(" en ")}`,
    );
  }
  // Voor stack.config.json (in git) de publishable key: de anon-JWT valt over guard:secrets.
  return { ref: project.ref, anon: sleutels.anon, inGit: sleutels.publishable ?? sleutels.anon };
}

/**
 * De hele inrichting.
 `d` (diensten) is injecteerbaar voor de tests:
 *   cf, supabase, maakAdmin(url, serviceRole), gh(args, {invoer}), toegang, accountId,
 *   idps?, groepenIdp?, wachtwoord?, maskeer(waarde)
 */
export async function richtIn(arg, d) {
  const maskeer = d.maskeer ?? (() => {});
  const v = await verken(arg, d, { schrijven: !arg.droogloop });
  const resultaat = {
    app: arg.app,
    hostname: v.hostname,
    droogloop: Boolean(arg.droogloop),
    stappen: [],
    waarschuwingen: [],
  };
  if (arg.droogloop) {
    const publiekGepland = await zetPubliekePaden(d, {
      t: v.t,
      app: arg.app,
      vv: arg.voorvoegsel,
      hostname: v.hostname,
      apps: [...v.apps],
      policies: [...v.policies],
      droog: true,
    });
    resultaat.stappen = geplandeStappen(
      arg,
      v,
      await d.cf.workerBestaat(arg.worker),
      publiekGepland,
      (await stapSentry(arg, d, { droog: true })).actie,
    );
    for (const g of v.gemis) resultaat.waarschuwingen.push(`de echte run stopt hierop: ${g}`);
    if (v.klantportaal) {
      resultaat.waarschuwingen.push(...portaalWaarschuwingen(arg, v));
      if (v.portaal.appBegrijpt === null) {
        resultaat.waarschuwingen.push(
          `klantportaal ${arg.app}: de app-repo was in deze droogloop niet te lezen, dus er is niet nagegaan of de app de inlog van een klantportaal begrijpt en wat er al in omgeving production staat. De echte run doet dat wel, vóór de eerste wijziging`,
        );
      }
      if (v.project) {
        resultaat.waarschuwingen.push(
          ...(await klantenOpMedewerkeradresMeldingen(d, v.t, arg.app, v.project.ref)),
        );
      }
    } else if (heeftPortaalMerk(v.workerAccess)) {
      // Een gewone app met het merk van een klantportaal: het portaal gaat in de echte run
      // dicht. Het merk staat in de lijst Access-apps die de verkenning toch al leest; een app
      // die nooit klantportaal was heeft het niet en krijgt hier geen woord meer dan op 42.
      resultaat.waarschuwingen.push(portaalDicht(arg, v));
    }
    return resultaat;
  }
  const stap = (naam, actie) => resultaat.stappen.push({ stap: naam, actie });
  const { cf, supabase } = d;

  // De run met het vinkje, bij een klantportaal waar de deur nog staat: alleen de deur gaat
  // weg. De verkenning heeft nagelopen dat er verder niets te wijzigen is (nogTeWijzigen);
  // wat de owner achter de deur heeft getest, is dus wat nu live gaat. Geen geheim wordt
  // opnieuw geschreven.
  if (v.klantportaal && arg.deurWeghalen && v.deur) {
    await cf.verwijderApp(v.deur.id);
    stap(
      "3.5 Access-app op de hostname",
      `weggehaald (${v.deur.id}). ${KLANTPORTAAL_OPEN}. Verder is er niets gewijzigd`,
    );
    resultaat.waarschuwingen.push(
      `de deur ${v.namen.deur} is weg: https://${v.hostname} is nu open, en iedereen kan per mail een account maken. De regels in de database (RLS) zijn de enige grens`,
    );
    resultaat.watNu = [
      `Start de workflow Controle van buitenaf voor ${arg.app} (stap 6 in beheer/README.md).`,
      `Log daarna zelf een keer in per mail op https://${v.hostname}, in een privévenster.`,
      `Werkt inloggen niet: zie "Als het misgaat: terug achter de deur" in beheer/README.md.`,
    ];
    resultaat.supabase = { ref: v.project.ref, url: supabaseUrl(v.project.ref) };
    resultaat.cloudflare = { deur: null, worker: v.workerAccess.id };
    return resultaat;
  }

  // 3.1 Supabase-project
  let project = v.project;
  let wachtwoord = null;
  if (project) stap("3.1 Supabase-project", `hergebruikt (${project.ref})`);
  else {
    wachtwoord = (d.wachtwoord ?? nieuwWachtwoord)();
    maskeer(wachtwoord);
    project = await supabase.maakProject(v.namen.project, wachtwoord);
    stap("3.1 Supabase-project", `aangemaakt (${project.ref}, ${REGIO})`);
    // Het wachtwoord is alleen nu bekend: meteen bewaren, vóór een latere stap kan
    // mislukken. Anders is het voorgoed weg en moet het in het dashboard opnieuw.
    await zetGithub(d, arg.repo, {
      productieVariabelen: { SUPABASE_PROJECT_REF: project.ref },
      secrets: {
        SUPABASE_DB_PASSWORD: { waarde: wachtwoord, altijd: true },
      },
    });
  }
  await supabase.wachtTotGezond(project.ref);
  const sleutels = await supabase.sleutels(project.ref);
  maskeer(sleutels.serviceRole);
  resultaat.supabase = { ref: project.ref, url: supabaseUrl(project.ref) };

  // 3.2 policies en de SaaS-app
  const sync = await synchroniseerPolicies(cf, v.t, {
    groepenIdp: d.groepenIdp,
    bestaand: v.policies,
    voorvoegsel: arg.voorvoegsel,
  });
  stap("3.2 Access-policies", sync.acties.length ? sync.acties.join("; ") : "ongewijzigd");
  const policyIds = policyIdsVoorApp(v.t, arg.app, sync.ids);
  const saas = await stapInlogApp(d, {
    bestaand: v.inlog,
    naam: v.namen.inlog,
    ref: project.ref,
    policyIds,
    idps: v.idps,
    maskeer,
  });
  const inlog = saas.inlog;
  stap("3.2 Access SaaS-app (OIDC)", saas.actie);

  // 3.3 custom provider en 3.4 auth-config
  const gewenstAuth = authInstellingen({
    hostname: v.hostname,
    worker: arg.worker,
    subdomein: v.subdomein,
  });
  for (const geheim of [d.smtpWachtwoord, d.captchaGeheim]) {
    if (v.klantportaal && geheim) maskeer(geheim);
  }
  const sitekey = v.klantportaal ? v.portaal.sitekey : null;
  // Klantportaal: stap 4 komt hier al, vóór inloggen per mail aangaat. Dan staat het merk op
  // de Access op de Worker voordat er één klantaccount kan bestaan, en ziet Toegang bijwerken
  // altijd dat accounts zonder inlog via Cloudflare klanten zijn. Een gewone app houdt stap 4
  // op de plek van versie 42 (na 3.5b).
  let w = v.klantportaal ? await stapWorker(arg, d, v, policyIds) : null;
  // Klantportaal: eerst de twee hookfuncties in de database, dan pas zet 3.4 ze aan. Een hook
  // die naar een functie wijst die er niet is, laat elke inlog mislukken.
  if (v.klantportaal) {
    const f = await schrijfPortaalHooks(d, v.t, arg.app, project.ref, arg.voorvoegsel);
    stap(
      "3.4 hooks van het klantportaal",
      `public.${f.aanmelden} (geen aanmelding per mail op een adres van een medewerker) en public.${f.token} (geen sessie met een wachtwoord) geschreven`,
    );
  }
  const productie = productieAuth(arg, d, v, gewenstAuth);
  let deur = v.deur;
  // Een gewone app die klantportaal was (het merk op de Access op de Worker, of de sporen in de
  // auth-config die deze run toch al leest): het portaal gaat dicht. De deur komt EERST terug,
  // vóór de auth-config verandert. Mislukt er daarna iets, dan staat het domein nooit zonder
  // deur. Een app die nooit klantportaal was komt hier niet: geen aanroep meer of eerder dan
  // op versie 42.
  let sluit = false;
  let deurTerug = false;
  async function sluitPortaal(vorig) {
    sluit =
      heeftPortaalMerk(v.workerAccess) ||
      wasKlantportaal(vorig, portaalHookFuncties(arg.voorvoegsel));
    if (!sluit) return {};
    if (!v.tijdelijk && !deur) {
      deur = await cf.maakApp(
        deurApp({ naam: v.namen.deur, hostname: v.hostname, policyIds, idps: v.idps }),
      );
      deurTerug = true;
    }
    return GESLOTEN_PORTAAL;
  }
  const koppeling = await koppelInlog(d, v, {
    ref: project.ref,
    serviceRole: sleutels.serviceRole,
    saas,
    naam: v.namen.inlog,
    // Bij een klantportaal komt hier inloggen per mail bij; de testdatabase hieronder
    // krijgt altijd de gewone instellingen (gewenstAuth).
    gewenstAuth: productie,
    voorWijziging: v.klantportaal ? undefined : sluitPortaal,
  });
  resultaat.issuer = koppeling.issuer;
  stap("3.3 custom provider custom:cloudflare", koppeling.provider);
  stap("3.4 auth-config", koppeling.auth);
  // Een gewone app die klantportaal was: het portaal is nu dicht (inloggen per mail staat uit).
  // De klanten krijgen het klantkenmerk en worden afgemeld; geband wordt er niemand. Dat
  // herhaalt elke run van zo'n app (één vraag meer), zodat een run die hier halverwege stopte
  // het de volgende keer alsnog doet. Een app die nooit klantportaal was, komt hier niet.
  if (sluit) {
    const rijen = await supabase.voerSqlUit(project.ref, KLANTEN_MARKEREN_SQL);
    await supabase.voerSqlUit(project.ref, KLANTEN_AFMELDEN_SQL);
    const aantal = Array.isArray(rijen) ? `${rijen.length} ` : "";
    stap(
      "3.4 klanten van het gesloten klantportaal",
      `${aantal}klantaccounts (zonder inlog via Cloudflare) gemarkeerd en afgemeld; niemand geband. Toegang bijwerken laat ze met rust`,
    );
    if (koppeling.vorig?.external_email_enabled === true || heeftPortaalMerk(v.workerAccess)) {
      resultaat.waarschuwingen.push(portaalDicht(arg, v));
      resultaat.watNu = [
        `Het klantportaal van ${arg.app} is dicht: de deur staat er, inloggen per mail is uit en geen klant is geband.`,
        "Start Toegang bijwerken opnieuw (Actions, Toegang bijwerken, Run workflow); die is nu groen.",
        `Was dit om iets te herstellen: begin daarna opnieuw bij stap 2 in beheer/README.md.`,
      ];
    }
  }
  if (v.klantportaal) {
    // De sessieduur apart: Supabase biedt hem alleen op Pro en hoger. Weigert hij, dan staat
    // de rest er al.
    if (Object.keys(verschil(koppeling.vorig, SESSIE)).length) {
      const dagen = SESSIE.sessions_inactivity_timeout / 24;
      try {
        await supabase.werkAuthBij(project.ref, SESSIE);
        stap("3.4 sessieduur", `sessies vervallen na ${dagen} dagen zonder gebruik`);
      } catch (fout) {
        stap("3.4 sessieduur", "niet gezet (zie de waarschuwingen)");
        resultaat.waarschuwingen.push(
          `de sessieduur is niet begrensd: Supabase weigerde sessions_inactivity_timeout (${fout.message}). Dat kan alleen op het Pro-plan of hoger. Een sessie blijft nu geldig tot iemand uitlogt; de app begrenst medewerkerrechten zelf op 12 uur na de inlog via Cloudflare`,
        );
      }
    } else stap("3.4 sessieduur", "ongewijzigd");
    resultaat.waarschuwingen.push(...portaalWaarschuwingen(arg, v));
    const stand = captchaStand(arg, v);
    stap(
      "3.4 captcha",
      stand === true
        ? "aan (Turnstile); het geheim is vooraf bij Turnstile getoetst"
        : stand === false
          ? "UIT"
          : `niet aangeraakt: het portaal is live (nu ${v.portaal.auth?.security_captcha_enabled === true ? "aan" : "UIT"})`,
    );
    resultaat.waarschuwingen.push(
      ...(await klantenOpMedewerkeradresMeldingen(d, v.t, arg.app, project.ref)),
    );
  }
  resultaat.uri_allow_list = productie.uri_allow_list.split(",");

  // T de testdatabase, waar de previews naartoe gaan
  const test = arg.testdatabase
    ? await stapTestdatabase(arg, d, v, { policyIds, gewenstAuth, maskeer, stap })
    : null;
  if (test) resultaat.testdatabase = { project_ref: test.ref, anon_key: test.inGit };

  // 3.5 de deur; in de tijdelijke stand is er geen hostname en is stap 4 de deur
  if (v.tijdelijk) stap("3.5 Access-app op de hostname", GEEN_DEUR);
  else if (v.klantportaal) {
    // Geen deur. Een deur die er nog staat haalt alleen de run met het vinkje weg (zie boven).
  } else if (deurTerug) {
    stap(
      "3.5 Access-app op de hostname",
      `aangemaakt (${deur.id}), vóór de auth-config: een klantportaal dat sluit krijgt eerst zijn deur terug`,
    );
  } else if (!deur) {
    deur = await cf.maakApp(
      deurApp({ naam: v.namen.deur, hostname: v.hostname, policyIds, idps: v.idps }),
    );
    stap("3.5 Access-app op de hostname", `aangemaakt (${deur.id})`);
  } else if (afwijkingen(deur, policyIds, v.idps).length) {
    const anders = afwijkingen(deur, policyIds, v.idps);
    await cf.werkAppBij(deur.id, metGewenst(deur, policyIds, v.idps));
    stap(
      "3.5 Access-app op de hostname",
      `hergebruikt, ${anders.join(" en ")} bijgewerkt (${deur.id})`,
    );
  } else stap("3.5 Access-app op de hostname", `hergebruikt (${deur.id})`);

  // 3.5b de publieke paden: een eigen Access-app met de bypass-policy, op hetzelfde adres
  const publiek = await zetPubliekePaden(d, {
    t: v.t,
    app: arg.app,
    vv: arg.voorvoegsel,
    hostname: v.hostname,
    apps: [...v.apps],
    policies: [...v.policies],
    droog: false,
  });
  if (publiek.length) stap("3.5b publieke paden", publiek.join("; "));

  // 4 Access op de Worker, vóór 3.6: pas met de GitHub-variabelen kan er uitgerold
  // worden, en dan moet de deur er al staan. Zo nodig zet deze stap eerst een
  // placeholder neer, want workers.dev staat in beide standen aan.
  w ??= await stapWorker(arg, d, v, policyIds);
  stap(w.stap, w.actie);
  if (w.waarschuwing) resultaat.waarschuwingen.push(w.waarschuwing);

  // S foutmeldingen: een eigen Sentry-project en DSN per app, vóór 3.6 zodat de DSN mee kan
  const sentry = await stapSentry(arg, d, { droog: false });
  stap("S foutmeldingen (Sentry)", sentry.actie);
  if (sentry.waarschuwing) resultaat.waarschuwingen.push(sentry.waarschuwing);

  // 3.6 GitHub
  // Zonder pooler loopt de rest door; alleen deploy-db heeft hem nodig.
  const pooler = await supabase.poolerHost(project.ref).catch((fout) => {
    resultaat.waarschuwingen.push(
      `de session pooler van Supabase was niet op te halen (${fout.message}); zet SUPABASE_POOLER_HOST in omgeving production met de hand (Supabase > Connect > Session pooler), anders kan deploy-db.yml niet migreren`,
    );
    return null;
  });
  if (!pooler && !resultaat.waarschuwingen.some((w) => w.includes("session pooler"))) {
    resultaat.waarschuwingen.push(
      "Supabase gaf geen session pooler terug; zet SUPABASE_POOLER_HOST in omgeving production met de hand (Supabase > Connect > Session pooler), anders kan deploy-db.yml niet migreren",
    );
  }
  // De testdatabase kan op een andere pooler staan dan productie (aws-0 tegenover aws-1);
  // deploy-db.yml gebruikt deze voor de canary (production), droogloop.yml voor de droogloop
  // van migraties (preview). Ontbreekt hij, dan vallen die terug op die van productie.
  const testPooler = test
    ? await supabase.poolerHost(test.ref).catch((fout) => {
        resultaat.waarschuwingen.push(
          `de session pooler van de testdatabase was niet op te halen (${fout.message}); zet SUPABASE_TEST_POOLER_HOST in de omgevingen production en preview met de hand, anders mislukken de canary in deploy-db.yml en de droogloop van migraties`,
        );
        return null;
      })
    : null;
  const gezet = await zetGithub(d, arg.repo, {
    variabelen: {
      VITE_SUPABASE_URL: supabaseUrl(project.ref),
      VITE_SUPABASE_ANON_KEY: sleutels.anon,
      VITE_INLOGDIENST: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: d.accountId,
      ...(pooler ? { SUPABASE_POOLER_HOST: pooler } : {}),
      ...(testPooler ? { SUPABASE_TEST_POOLER_HOST: testPooler } : {}),
      // Sentry: de DSN van stap S, alleen als die nieuw is; een bestaande blijft staan.
      ...(sentry.dsn ? { VITE_SENTRY_DSN: sentry.dsn } : {}),
    },
    // De preview draait op de testdatabase als die er is, anders op hetzelfde project.
    // Een eigen database gebruikt schema public.
    repoVariabelen: {
      PREVIEW_VITE_SUPABASE_URL: supabaseUrl(test?.ref ?? project.ref),
      PREVIEW_VITE_SUPABASE_ANON_KEY: test?.anon ?? sleutels.anon,
      PREVIEW_VITE_SUPABASE_SCHEMA: "public",
      PREVIEW_VITE_INLOGDIENST: "cloudflare",
      ...(sentry.dsn ? { PREVIEW_VITE_SENTRY_DSN: sentry.dsn } : {}),
    },
    // De project-ref alleen in production, waar deploy-db.yml migreert; het wachtwoord
    // staat er al (direct na het aanmaken van het project). Bij een klantportaal toont
    // productie ook het inloggen per mail; de previews draaien op de testdatabase, waar
    // e-mail alleen voor testaccounts is, en houden alleen Cloudflare.
    productieVariabelen: {
      SUPABASE_PROJECT_REF: project.ref,
      ...(v.klantportaal ? { VITE_INLOGDIENST: KLANTPORTAAL_INLOGDIENST } : {}),
      // De openbare sleutel van de Turnstile-widget, alleen waar de captcha aan staat.
      ...(sitekey ? { VITE_TURNSTILE_SITEKEY: sitekey } : {}),
    },
  });
  // Captcha uitgezet: dan mag de app de widget ook niet meer tonen.
  if (v.klantportaal && !sitekey) {
    if (Object.hasOwn(v.portaal.variabelen ?? {}, "VITE_TURNSTILE_SITEKEY")) {
      await d.gh([
        "variable",
        "delete",
        "VITE_TURNSTILE_SITEKEY",
        "--env",
        SECRET_OMGEVING,
        "--repo",
        arg.repo,
      ]);
      gezet.push(`${SECRET_OMGEVING}/VITE_TURNSTILE_SITEKEY weggehaald`);
    }
  }
  stap(
    "3.6 GitHub-variabelen en -secrets",
    gezet.length ? `gezet: ${gezet.join(", ")}` : "ongewijzigd",
  );
  const oud = await ruimOudeProjectRefOp(d, arg.repo);
  if (oud.stap) stap("3.6 oud secret SUPABASE_PROJECT_REF", oud.stap);
  if (oud.waarschuwing) resultaat.waarschuwingen.push(oud.waarschuwing);
  if (!wachtwoord) {
    resultaat.waarschuwingen.push(
      "het project bestond al; SUPABASE_DB_PASSWORD is niet opnieuw gezet (alleen bij aanmaken bekend)",
    );
  }

  const weg = await verwijderOverbodig(cf, sync.overbodig);
  if (weg.length) stap("3.2 Access-policies", `overbodig verwijderd: ${weg.join(", ")}`);

  // 3.5 bij een klantportaal: de deur. Een mens haalt hem weg, niet de code: alleen een run met
  // --deur-weghalen doet dat, en die run doet niets anders (zie boven). Deze run raakt de deur
  // niet aan.
  if (v.klantportaal) {
    if (!deur) {
      stap("3.5 Access-app op de hostname", `geen deur. ${KLANTPORTAAL_OPEN}`);
      resultaat.watNu = [
        `Het klantportaal van ${arg.app} is live; deze run heeft de instellingen bijgewerkt.`,
        "Start de workflow Controle van buitenaf als je wilt nalopen dat alleen het domein open is.",
      ];
    } else {
      stap(
        "3.5 Access-app op de hostname",
        `blijft staan (${deur.id}): alleen een run met ${VINKJE} haalt hem weg`,
      );
      resultaat.waarschuwingen.push(
        `de deur ${v.namen.deur} staat er nog, en klanten kunnen er dus nog niet in. Alles staat klaar. Deze run zonder vinkje kun je zo vaak herhalen als je wilt`,
      );
      resultaat.watNu = [
        "Rol de app uit: ga naar de app-repo, Actions, Uitrollen, de laatste run, Re-run all jobs (stap 4 in beheer/README.md).",
        `Test achter de deur: open https://${v.hostname}, log uit in de app en log in per mail met een privéadres.`,
        `Werkt dat, draai App inrichten voor ${arg.app} dan nog een keer met ${VINKJE} en droogloop uit (stap 5).`,
      ];
    }
    resultaat.waarschuwingen.push(
      deur
        ? `${arg.app} wordt een klantportaal: zodra de deur weg is, is https://${v.hostname} voor iedereen bereikbaar. Iedereen met de openbare sleutel van Supabase kan nu al per mail een account maken (de inlogdienst van Supabase staat open). De regels in de database (RLS) zijn de enige grens; zie "Klantportaal" in beheer/README.md`
        : `${arg.app} is een klantportaal: https://${v.hostname} is voor iedereen bereikbaar en iedereen kan per mail een account maken. De regels in de database (RLS) zijn de enige grens; zie "Klantportaal" in beheer/README.md`,
    );
  }

  resultaat.cloudflare = {
    policies: sync.ids,
    inlog: inlog.id,
    deur: v.tijdelijk ? null : v.klantportaal ? (deur?.id ?? null) : deur.id,
    worker: w.id,
  };
  return resultaat;
}

/**
 * Alleen stap 4. Nodig voor apps die zijn ingericht vóór de placeholder in beide
 * standen bestond.
 */
export async function tweedeDoorgang(arg, d) {
  const v = await verken(arg, d, { schrijven: false });
  const ids = {};
  for (const { groep, body } of v.gewenst) {
    const p = v.policies.find((x) => x.name === body.name);
    if (!p) throw new Error(`policy ${body.name} ontbreekt; draai eerst de inrichting zelf`);
    ids[groep] = p.id;
  }
  const policyIds = policyIdsVoorApp(v.t, arg.app, ids);
  if (arg.droogloop) {
    const bestaat = await d.cf.workerBestaat(arg.worker);
    const melding = bestaat ? "gepland: Access op de Worker" : PLACEHOLDER_GEPLAND;
    return { app: arg.app, melding };
  }
  const w = await stapWorker(arg, d, v, policyIds);
  return {
    app: arg.app,
    melding: w.actie,
    worker: w.id,
    ...(w.waarschuwing ? { waarschuwingen: [w.waarschuwing] } : {}),
  };
}

// ---------------------------------------------------------------- opruimen

/**
 * Verwijdert wat dit script voor deze app(s) met dit voorvoegsel maakt, in omgekeerde
 * volgorde van de inrichting, en meldt wat er stond. Dat zijn alleen de exacte namen:
 * voor de Access-apps en het Supabase-project die uit appNamen (de app van --app, of
 * anders elke app in toegang.json), voor de policies het voorvoegsel plus een groep in
 * toegang.json. Met --app zijn dat alleen de groepen van die app, en een policy die een
 * andere app in toegang.json nog gebruikt of die nog aan een blijvende Access-app hangt,
 * blijft staan, met een waarschuwing. Een andere naam met het voorvoegsel ervoor blijft
 * staan, met een waarschuwing; alles zonder voorvoegsel ook. Het Worker-script gaat alleen weg met de
 * exacte naam uit wrangler.jsonc (`arg.worker`), na de Access-apps; zonder die naam blijft
 * elk script staan. De eigen-domeinroute hoort bij de Worker en gaat met hem mee.
 */
export async function ruimOp(arg, d) {
  const vv = valideerVoorvoegsel(arg.voorvoegsel);
  const { cf, supabase } = d;
  const appsUitBestand = arg.app ? [arg.app] : Object.keys(d.toegang?.apps ?? {});
  const namen = appsUitBestand.map((app) => appNamen(app, vv));
  // De testdatabase hoort bij de app, behalve als er echt een app <app>-test bestaat:
  // dan is die naam van die app en blijft hij buiten een opruiming van alleen <app>.
  const eigenTest = (app) => !d.toegang?.apps?.[`${app}-test`] || !arg.app;
  const testNamen = appsUitBestand.filter(eigenTest).map((app) => appNamen(app, vv));
  const appNamenSet = new Set([
    ...namen.flatMap((n) => [n.deur, n.inlog, n.worker, n.publiek]),
    ...testNamen.map((n) => n.testInlog),
  ]);
  const projectNamen = new Set([...namen.map((n) => n.project), ...testNamen.map((n) => n.test)]);
  // De policies zijn herbruikbaar: een groep kan aan meer apps hangen. Bij één app gaan
  // alleen de groepen van die app mee (staat hij niet meer in toegang.json, dan elke groep),
  // en daarvan alleen wat geen andere app in toegang.json nog gebruikt.
  const groepen = Object.keys(d.toegang?.groepen ?? {});
  const kandidaten =
    arg.app && d.toegang?.apps?.[arg.app] ? groepenVanApp(d.toegang, arg.app) : groepen;
  const andereApps = Object.keys(d.toegang?.apps ?? {}).filter(
    (app) => !appsUitBestand.includes(app),
  );
  // De bypass-policy van de publieke paden telt als groep "publiek": hij gaat mee, tenzij een
  // andere app in toegang.json nog publieke paden heeft.
  const gebruiktDoor = (groep) =>
    andereApps.filter((app) =>
      groep === PUBLIEK_GROEP
        ? publiekVanApp(d.toegang, app).length > 0
        : groepenVanApp(d.toegang, app).includes(groep),
    );
  const policyNamen = new Set([...kandidaten, PUBLIEK_GROEP].map((g) => policyNaam(g, vv)));

  const alleApps = await cf.apps();
  const allePolicies = await cf.policies();
  const alleProjecten = await supabase.projecten();
  const apps = alleApps.filter((a) => appNamenSet.has(a.name));
  // Hangt een policy nog aan een Access-app die blijft staan, dan blijft hij ook staan.
  const hangtAan = (policy) =>
    alleApps
      .filter((a) => !apps.includes(a) && policyIdsVanApp(a).includes(policy.id))
      .map((a) => a.name);
  const blijvendePolicies = [];
  const policies = allePolicies.filter((p) => {
    if (!policyNamen.has(p.name)) return false;
    const groep = [...kandidaten, PUBLIEK_GROEP].find((g) => policyNaam(g, vv) === p.name);
    const andereApps = gebruiktDoor(groep);
    const door = andereApps.length ? andereApps : hangtAan(p).map((naam) => `Access-app ${naam}`);
    if (door.length) blijvendePolicies.push({ policy: p, door });
    return door.length === 0;
  });
  const projecten = alleProjecten.filter((p) => projectNamen.has(p.name));
  const workerApps = apps.filter((a) => namen.some((n) => n.worker === a.name));
  const saasApps = apps.filter((a) => !workerApps.includes(a) && a.type === "saas");
  const deurApps = apps.filter((a) => !workerApps.includes(a) && !saasApps.includes(a));
  const verwijderd = [];
  const waarschuwingen = [];
  const droog = Boolean(arg.droogloop);

  const blijft = [
    ...alleApps.filter((a) => a.name?.startsWith(vv) && !apps.includes(a)),
    ...allePolicies.filter(
      (p) =>
        p.name?.startsWith(vv) &&
        !policies.includes(p) &&
        !blijvendePolicies.some((b) => b.policy === p),
    ),
    ...alleProjecten.filter((p) => p.name?.startsWith(vv) && !projecten.includes(p)),
  ].map((x) => x.name);
  if (blijft.length) {
    waarschuwingen.push(
      `blijft staan (begint met ${vv}, maar hoort niet bij ${appsUitBestand.join(", ") || "een app"} of de groepen in toegang.json): ${blijft.join(", ")}`,
    );
  }

  for (const { policy, door } of blijvendePolicies) {
    waarschuwingen.push(
      `Access-policy ${policy.name} blijft staan (gebruikt door ${door.join(", ")})`,
    );
  }

  // Eerst het script, dan pas de deur ervoor: zo staat de app geen moment zonder Access.
  // Alleen de exacte naam uit de config; een 404 is "was er niet".
  if (arg.worker) {
    const weg = droog ? await cf.workerBestaat(arg.worker) : await cf.verwijderWorker(arg.worker);
    if (weg) verwijderd.push({ soort: "Worker-script", naam: arg.worker });
  }
  for (const a of workerApps) {
    if (!droog) await cf.verwijderApp(a.id);
    verwijderd.push({ soort: "Access op de Worker", naam: a.name });
  }

  if (arg.repo) {
    const namen = [];
    for (const env of OMGEVINGEN) {
      const huidig = (await leesGhVariabelen(d, env, arg.repo)).map((x) => x.name);
      for (const naam of GH_VARIABELEN.filter((n) => huidig.includes(n))) {
        if (!droog) await d.gh(["variable", "delete", naam, "--env", env, "--repo", arg.repo]);
        namen.push(`${env}/${naam}`);
      }
    }
    const repoVars = (await leesGhVariabelen(d, null, arg.repo)).map((x) => x.name);
    for (const naam of GH_PREVIEW_VARIABELEN.filter((n) => repoVars.includes(n))) {
      if (!droog) await d.gh(["variable", "delete", naam, "--repo", arg.repo]);
      namen.push(`repo/${naam}`);
    }
    // De secrets in production (en het testwachtwoord in preview), en een oud repo-secret
    // van vóór die omgevingen.
    for (const env of [...TEST_SECRET_OMGEVINGEN, null]) {
      const secrets = await leesGhSecretNamen(d, env, arg.repo);
      for (const naam of [...GH_SECRETS, ...OUDE_SECRETS].filter((n) => secrets.includes(n))) {
        if (!droog) await d.gh(["secret", "delete", naam, ...envArgs(env), "--repo", arg.repo]);
        namen.push(`${env ?? "repo"}/secret ${naam}`);
      }
    }
    if (namen.length) verwijderd.push({ soort: "GitHub", naam: namen.join(", ") });
  }

  for (const a of deurApps) {
    if (!droog) await cf.verwijderApp(a.id);
    verwijderd.push({ soort: "Access-app op de hostname", naam: a.name });
  }

  for (const p of projecten) {
    const sleutels = await supabase.sleutels(p.ref);
    const admin = (d.maakAdmin ?? standaardAdmin)(supabaseUrl(p.ref), sleutels.serviceRole);
    if (droog) {
      verwijderd.push({
        soort: "custom provider",
        naam: `${p.name}: custom:cloudflare (indien aanwezig)`,
      });
    } else if (await verwijderProvider(admin.customProviders)) {
      verwijderd.push({ soort: "custom provider", naam: `${p.name}: custom:cloudflare` });
    }
  }

  for (const a of saasApps) {
    if (!droog) await cf.verwijderApp(a.id);
    verwijderd.push({ soort: "Access SaaS-app", naam: a.name });
  }
  for (const p of policies) {
    if (!droog) await cf.verwijderPolicy(p.id);
    verwijderd.push({ soort: "Access-policy", naam: p.name });
  }
  for (const p of projecten) {
    if (!droog) await supabase.verwijderProject(p.ref);
    verwijderd.push({ soort: "Supabase-project", naam: `${p.name} (${p.ref})` });
  }
  return { droogloop: droog, verwijderd, waarschuwingen };
}

// ---------------------------------------------------------------- toegang bijwerken (U6)

/**
 * De aanmeld-hook van de testdatabase: de functie schrijven (altijd, want toegang.json
 * kan veranderd zijn). Geeft de naam van de functie. De auth-config (hook aan en
 * inloggen met e-mail aan) zet de aanroeper pas daarna.
 */
async function schrijfTestHook(d, t, app, ref, voorvoegsel) {
  const functie = hookFunctie(voorvoegsel);
  await d.supabase.voerSqlUit(ref, aanmeldHookSql(t, app, functie));
  return functie;
}

/**
 * Ban en afmelden in één Supabase-project voor wie niet (meer) bij de app mag. In de
 * testdatabase (`test: true`) blijven de testaccounts en de testgebruiker buiten schot.
 *
 * `alsPortaal`: de app is volgens toegang.json een klantportaal, of hij is het volgens het merk
 * op zijn Access op de Worker nog (`klantportaal` is uit het bestand gehaald en App inrichten
 * heeft het portaal nog niet gesloten). Dan worden alleen accounts met een inlog via Cloudflare
 * beoordeeld en ingetrokken (een vertrokken medewerker ontsnapt nooit); accounts zonder zijn
 * klanten en blijven ongemoeid. Een gewone app zonder merk krijgt precies de aanroepen van
 * versie 42: geen leesvraag erbij, wat er ook met zijn deur of zijn instellingen is gebeurd.
 */
async function trekInOp(d, t, app, ref, { test = false, alsPortaal = false } = {}) {
  const sleutels = await d.supabase.sleutels(ref);
  d.maskeer?.(sleutels.serviceRole);
  const admin = (d.maakAdmin ?? standaardAdmin)(supabaseUrl(ref), sleutels.serviceRole);
  // Alleen de productiedatabase van een klantportaal heeft klanten; de testdatabase kent
  // per mail alleen testaccounts en blijft zoals hij was.
  const klantportaal = !test && alsPortaal;
  const gebruikers = await alleGebruikers(admin);
  // NAGAAN (U7): dat POST /database/query de rijen als lijst objecten teruggeeft. Is dat
  // anders, dan stopt cloudflareIdentiteiten en wordt er bij deze app niets ingetrokken.
  const cloudflare = klantportaal
    ? cloudflareIdentiteiten(await d.supabase.voerSqlUit(ref, CLOUDFLARE_IDENTITEITEN_SQL))
    : null;
  const r = await trekIn({
    gebruikers,
    toegang: t,
    app,
    ...(klantportaal ? { klantportaal: true, cloudflare } : {}),
    testaccounts: test ? testaccountsVan(t, app) : [],
    ban: async (id) => {
      const { error } = await admin.updateUserById(id, { ban_duration: BAN_DUUR });
      if (error) throw new Error(`Supabase updateUserById: ${error.message ?? error}`);
    },
    afmelden: (id) => d.supabase.voerSqlUit(ref, afmeldSql(id)),
    ontban: async (id) => {
      const { error } = await admin.updateUserById(id, { ban_duration: GEEN_BAN });
      if (error) throw new Error(`Supabase updateUserById: ${error.message ?? error}`);
    },
  });
  if (klantportaal && isKlantportaal(t, app))
    r.klantOpMedewerkeradres = klantenOpMedewerkeradres(gebruikers, cloudflare, t, app);
  return r;
}

/**
 * De publieke paden van elke app die al is ingericht (er staat een deur of een Access op
 * de Worker), op het adres van die deur: het eigen domein, of anders het workers.dev-adres.
 * Daarna de bypass-policy weg als geen app hem nog gebruikt.
 */
async function publiekePadenVoorAlle(d, t, vv, { apps, policies, droog }) {
  const acties = [];
  const lijst = [...apps];
  const pols = [...policies];
  for (const app of Object.keys(t.apps)) {
    const namen = appNamen(app, vv);
    const deur =
      lijst.find((a) => a.name === namen.deur) ?? lijst.find((a) => a.name === namen.worker);
    if (!deur?.domain) {
      if (publiekVanApp(t, app).length) {
        acties.push(`publieke paden van ${app} wachten op App inrichten (er is nog geen deur)`);
      }
      continue;
    }
    acties.push(
      ...(await zetPubliekePaden(d, {
        t,
        app,
        vv,
        hostname: deur.domain,
        apps: lijst,
        policies: pols,
        droog,
      })),
    );
  }
  acties.push(...(await ruimPubliekPolicyOp(d, t, pols, vv, { droog })));
  return acties;
}

/**
 * Toegang bijwerken haalt bij een klantportaal de deur niet weg: dat doet alleen App inrichten
 * met het vinkje. Staat de deur er nog, dan zegt deze regel dat.
 */
function klantportaalRegels(t, vv, apps) {
  return Object.keys(t.apps)
    .filter((app) => isKlantportaal(t, app))
    .filter((app) => apps.some((a) => a.name === appNamen(app, vv).deur))
    .map(
      (app) =>
        `klantportaal ${app}: de deur ${appNamen(app, vv).deur} staat er nog. Toegang bijwerken haalt hem niet weg; dat doet alleen App inrichten met ${VINKJE}`,
    );
}

/**
 * Het resultaat van Toegang bijwerken eindigt rood als er `fouten` in staan: bij een
 * klantportaal (of een app die het volgens het merk nog is) is niet of maar deels ingetrokken,
 * of het portaal wacht op App inrichten. Een gewone app zet nooit iets in `fouten`: die is
 * groen of stopt met een fout, precies als op versie 42. De rest van het resultaat blijft
 * erbij, zodat te zien is wat wel is gedaan.
 */
export function eindstatus(modus, resultaat) {
  const fouten = resultaat?.fouten ?? [];
  return fouten.length
    ? { status: "mislukt", modus, reden: fouten.join("; "), ...resultaat }
    : { status: "gelukt", modus, ...resultaat };
}

/** De ene melding waarmee Toegang bijwerken rood eindigt zolang een portaal half gesloten is. */
export function wachtOpInrichten(app, klanten) {
  const aantal = klanten === null ? "de" : `de ${klanten}`;
  return `${app}: wacht op App inrichten. In toegang.json staat ${app} als gewone app, maar ${app} is nog ingericht als klantportaal. Medewerkers zijn gewoon beoordeeld en zo nodig ingetrokken; ${aantal} klantaccounts zijn met rust gelaten en geen klant is geband. Draai App inrichten voor ${app} (droogloop uit, zonder vinkje): dat zet de deur terug als die weg was, zet inloggen per mail uit en meldt de klanten af. Is dit een vergissing, zet dan "klantportaal": true terug in toegang.json. Deze melding blijft tot een van de twee is gedaan`;
}

/**
 * Maakt Cloudflare gelijk aan toegang.json en trekt daarna de toegang in van wie niet
 * meer past: ban en afmelden in het Supabase-project van elke app. Bij een klantportaal
 * alleen van medewerkers (accounts met een Cloudflare-inlog); klanten blijven ongemoeid.
 * Mislukt het bij een klantportaal, dan gaat hij door met de andere apps en staat de reden in
 * `fouten`; de run eindigt dan rood (eindstatus).
 */
export async function werkToegangBij(arg, d) {
  const vv = valideerVoorvoegsel(arg.voorvoegsel);
  const t = valideerToegang(d.toegang);
  const { cf, supabase } = d;
  const policies = await cf.policies();
  const apps = await cf.apps();
  const projecten = await supabase.projecten();
  const doelApps = (arg.app ? [arg.app] : Object.keys(t.apps)).filter((app) =>
    Object.hasOwn(t.apps, app),
  );
  // Het merk van een klantportaal, uit de lijst Access-apps die hierboven toch al is gelezen.
  const merkVan = (app) => heeftPortaalMerk(apps.find((a) => a.name === appNamen(app, vv).worker));
  const alsPortaal = (app) => isKlantportaal(t, app) || merkVan(app);
  const projectVan = (app) => projecten.find((p) => p.name === appNamen(app, vv).project);
  const testProjectVan = (app) => projecten.find((p) => p.name === appNamen(app, vv).test);
  if (arg.droogloop) {
    gewenstePolicies(t, { groepenIdp: d.groepenIdp, voorvoegsel: vv });
    const conflicten = kaleNaamConflicten(t, policies, vv);
    if (conflicten.length) throw new Error(`gestopt zonder wijzigingen: ${conflicten.join("; ")}`);
    const hooks = [];
    for (const app of doelApps) {
      if (projectVan(app) && testProjectVan(app)) {
        hooks.push(
          `gepland: aanmeld-hook van ${app} (test) schrijven, inloggen met e-mail alleen voor testaccounts`,
        );
      }
    }
    const publiek = await publiekePadenVoorAlle(d, t, vv, { apps, policies, droog: true });
    // Alleen bij een klantportaal: klantaccounts op een adres van een medewerker, ook in de
    // droogloop (alleen lezen).
    const waarschuwingen = [];
    for (const app of doelApps.filter((a) => isKlantportaal(t, a) && projectVan(a))) {
      waarschuwingen.push(
        ...(await klantenOpMedewerkeradresMeldingen(d, t, app, projectVan(app).ref)),
      );
    }
    return {
      droogloop: true,
      acties: [
        "gepland: policies gelijkzetten, apps koppelen, intrekken",
        ...publiek,
        ...klantportaalRegels(t, vv, apps),
        ...hooks,
      ],
      ...(waarschuwingen.length ? { waarschuwingen } : {}),
    };
  }
  const sync = await synchroniseerPolicies(cf, t, {
    groepenIdp: d.groepenIdp,
    bestaand: policies,
    voorvoegsel: vv,
  });
  const gekoppeld = await koppelPolicies(cf, t, apps, sync.ids, vv);
  const publiek = await publiekePadenVoorAlle(d, t, vv, { apps, policies, droog: false });

  const ingetrokken = {};
  const toegelaten = {};
  const onbekend = {};
  const klanten = {};
  const waarschuwingen = [];
  // Redenen om rood te eindigen; alleen een klantportaal (of een app met het merk) zet hier iets.
  const fouten = [];
  // De volgende stap voor de owner, in de samenvatting van de run; alleen bij een klantportaal.
  const watNu = Object.keys(t.apps)
    .filter((app) => isKlantportaal(t, app))
    .filter((app) => apps.some((a) => a.name === appNamen(app, vv).deur))
    .map(
      (app) =>
        `Klantportaal ${app}: de deur staat er nog. Draai App inrichten voor ${app} zonder vinkje (stap 3 in beheer/README.md); is dat al gedaan en getest, dan met ${VINKJE} (stap 5).`,
    );
  const hooks = [];
  // Klantportalen eerst. Een fout bij een gewone app stopt de run (zoals op versie 42); staat
  // er een klantportaal achter in het bestand, dan is daar dan al ingetrokken. Tussen gewone
  // apps onderling blijft de volgorde die van het bestand.
  const volgorde = [...doelApps.filter(alsPortaal), ...doelApps.filter((a) => !alsPortaal(a))];
  for (const app of volgorde) {
    const project = projectVan(app);
    if (!project) continue;
    if (alsPortaal(app)) await werkPortaalBij(app, project);
    else await werkGewoneAppBij(app, project);
  }
  /**
   * De testdatabase: eerst de aanmeld-hook (die het nieuwe bestand moet volgen), dan pas
   * inloggen met e-mail aan. Zo staat e-mail nooit aan zonder hook.
   */
  async function werkTestHookBij(app, testProject) {
    const functie = await schrijfTestHook(d, t, app, testProject.ref, vv);
    hooks.push(`aanmeld-hook public.${functie} van ${app} (test) bijgewerkt`);
    const anders = verschil(await supabase.authConfig(testProject.ref), hookInstellingen(functie));
    if (Object.keys(anders).length) {
      await supabase.werkAuthBij(testProject.ref, anders);
      hooks.push(`inloggen met e-mail in ${app} (test) aangezet, alleen voor testaccounts`);
    }
  }
  async function trekInBij(app, sleutel, p, test) {
    const r = await trekInOp(d, t, app, p.ref, { test, alsPortaal: alsPortaal(app) });
    if (r.ingetrokken.length) ingetrokken[sleutel] = r.ingetrokken;
    if (r.toegelaten.length) toegelaten[sleutel] = r.toegelaten;
    if (r.onbekend.length) onbekend[sleutel] = r.onbekend;
    if (r.klanten !== undefined) klanten[sleutel] = r.klanten;
    waarschuwingen.push(...meldKlantenOpMedewerkeradres(sleutel, r.klantOpMedewerkeradres ?? []));
    for (const naam of r.zonderAdres ?? []) {
      waarschuwingen.push(
        `${sleutel}: ${naam} heeft via Cloudflare een account zonder adres gekregen, omdat er al een klantaccount op dat adres bestond. Zo kan hij niet als medewerker inloggen; zie "Een klantaccount op het adres van een medewerker" in beheer/KLANTPORTAAL.md`,
      );
    }
    for (const naam of r.ookPerMail ?? []) {
      waarschuwingen.push(
        `${sleutel}: ${naam} is ingetrokken als medewerker en kon met hetzelfde account ook per mail inloggen. Het hele account is dicht, ook de klantkant; dat is bewust. Moet deze persoon klant blijven, zie "Toegang bijwerken bij een klantportaal" in beheer/KLANTPORTAAL.md`,
      );
    }
    return r;
  }
  /** Een gewone app: de aanroepen en de volgorde van versie 42. Een fout stopt de run. */
  async function werkGewoneAppBij(app, project) {
    const testProject = testProjectVan(app);
    if (testProject) await werkTestHookBij(app, testProject);
    await trekInBij(app, app, project, false);
    // Ook in de testdatabase: wie eruit is, komt ook in de previews niet meer binnen.
    // De testaccounts daar blijven staan.
    if (testProject) await trekInBij(app, `${app} (test)`, testProject, true);
  }
  /**
   * Een klantportaal (of een app die het volgens het merk nog is). Eerst intrekken in
   * productie; pas daarna de testdatabase en de aanmeld-hook. Elk deel vangt zijn eigen fout:
   * een hook die niet te schrijven is houdt het intrekken van een vertrokken medewerker nooit
   * tegen, en een fout hier houdt de andere apps niet tegen. De run eindigt dan rood.
   */
  async function werkPortaalBij(app, project) {
    const testProject = testProjectVan(app);
    const deel = async (wat, werk) => {
      try {
        await werk();
      } catch (fout) {
        fouten.push(
          `${app}: ${wat} is niet (helemaal) gelukt: ${fout.message}. De rest van deze run is gewoon gedaan. Los dit op en start Toegang bijwerken opnieuw`,
        );
      }
    };
    let klantenHier = null;
    await deel("het intrekken", async () => {
      klantenHier = (await trekInBij(app, app, project, false)).klanten ?? 0;
    });
    if (!isKlantportaal(t, app)) {
      fouten.push(wachtOpInrichten(app, klantenHier));
      watNu.push(`Draai App inrichten voor ${app}: droogloop uit, zonder vinkje.`);
    }
    if (testProject) {
      await deel("het bijwerken van de testdatabase", async () => {
        await werkTestHookBij(app, testProject);
        await trekInBij(app, `${app} (test)`, testProject, true);
      });
    }
    // De aanmeld-hook van productie volgt de groepen (wie medewerker is). Alleen de functie;
    // aanzetten doet App inrichten.
    if (isKlantportaal(t, app)) {
      await deel("het bijwerken van de aanmeld-hook", async () => {
        const f = await schrijfPortaalHooks(d, t, app, project.ref, vv, { alleenAanmelden: true });
        hooks.push(`aanmeld-hook public.${f.aanmelden} van klantportaal ${app} bijgewerkt`);
      });
    }
  }
  // Pas na het intrekken: een policy die nog aan een app hangt, weigert Cloudflare te
  // verwijderen, en dat mag het intrekken van toegang nooit tegenhouden.
  let weg = [];
  try {
    weg = await verwijderOverbodig(cf, sync.overbodig);
  } catch (fout) {
    waarschuwingen.push(`overbodige policies niet verwijderd: ${fout.message}`);
  }
  return {
    acties: [
      ...sync.acties,
      ...gekoppeld,
      ...publiek,
      ...klantportaalRegels(t, vv, apps),
      ...hooks,
      ...weg.map((n) => `policy ${n} verwijderd`),
    ],
    ingetrokken,
    toegelaten,
    onbekend,
    // Hoeveel accounts als klant zijn overgeslagen: bij een klantportaal, of bij een gewone
    // app die klantportaal was (accounts met het klantkenmerk).
    ...(Object.keys(klanten).length ? { klanten } : {}),
    waarschuwingen,
    // Alleen als er iets misging: dan eindigt de run rood (zie eindstatus).
    ...(fouten.length ? { fouten } : {}),
    ...(watNu.length ? { watNu } : {}),
  };
}

// ---------------------------------------------------------------- uitvoer

/** Eén regel `INRICHTING {json}`, met elk bekend geheim vervangen door ***. */
export function uitvoerRegel(object, geheimen = []) {
  let tekst = JSON.stringify(object);
  for (const g of geheimen) {
    if (typeof g !== "string" || g.length < 4) continue;
    tekst = tekst.replaceAll(g, "***").replaceAll(JSON.stringify(g).slice(1, -1), "***");
  }
  return `INRICHTING ${tekst}\n`;
}

const TITELS = {
  inrichten: "App inrichten",
  toegang: "Toegang bijwerken",
  opruimen: "Opruimen",
  tweedeDoorgang: "Tweede doorgang",
};

/**
 * De samenvatting van de run voor de owner, in gewone taal (Markdown): wat er is gedaan, de
 * waarschuwingen en, bij een klantportaal, wat de volgende stap is. Alles komt uit het
 * resultaat dat ook in de regel INRICHTING staat. Adressen staan er niet in: van het
 * intrekken alleen aantallen.
 */
export function samenvatting(modus, eind) {
  const r = [];
  const lijst = (kop, regels, teken = "-") => {
    if (!regels?.length) return;
    r.push("", `**${kop}**`, "");
    regels.forEach((x, i) => {
      r.push(`${teken === "1" ? `${i + 1}.` : "-"} ${String(x).replaceAll("\n", " ")}`);
    });
  };
  const waar = eind.app ? `: ${eind.app}` : "";
  r.push(
    `## ${TITELS[modus] ?? modus}${waar}${eind.droogloop ? " (droogloop, er is niets gewijzigd)" : ""}`,
  );
  r.push("", eind.status === "gelukt" ? "Gelukt." : `**Mislukt.** ${eind.reden ?? ""}`);
  lijst(eind.droogloop ? "Wat een echte run zou doen" : "Wat er is gedaan", [
    ...(eind.stappen ?? []).map((x) => `${x.stap}: ${x.actie}`),
    ...(eind.acties ?? []),
    ...(eind.verwijderd ?? []).map((x) => `${x.soort} ${x.naam} verwijderd`),
    ...(eind.melding ? [eind.melding] : []),
  ]);
  const tel = (kop, per) =>
    Object.entries(per ?? {}).map(
      ([app, x]) => `${app}: ${Array.isArray(x) ? x.length : x} ${kop}`,
    );
  lijst("Toegang", [
    ...tel("ingetrokken (geband en afgemeld)", eind.ingetrokken),
    ...tel("weer toegelaten", eind.toegelaten),
    ...tel("niet te beoordelen (groep van de identiteitsdienst)", eind.onbekend),
    ...tel("klantaccounts overgeslagen", eind.klanten),
  ]);
  lijst("Waarschuwingen", eind.waarschuwingen);
  lijst("Wat nu", eind.watNu, "1");
  return `${r.join("\n")}\n`;
}

/**
 * Schrijft de samenvatting naar het bestand dat GitHub Actions toont bij de run
 * (GITHUB_STEP_SUMMARY), met elk bekend geheim vervangen. Buiten GitHub Actions gebeurt er
 * niets. Het is een bestand erbij, geen aanroep: lukt het schrijven niet, dan verandert dat
 * niets aan de run.
 */
export function schrijfSamenvatting(tekst, geheimen = [], env = process.env) {
  if (!env.GITHUB_STEP_SUMMARY) return false;
  let uit = tekst;
  for (const g of geheimen) {
    if (typeof g === "string" && g.length >= 4) uit = uit.replaceAll(g, "***");
  }
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, uit);
    return true;
  } catch {
    return false;
  }
}

function eis(naam) {
  const w = process.env[naam];
  if (!w) throw new Error(`${naam} ontbreekt; zie beheer/README.md (voorwaarden P1 tot en met P4)`);
  return w;
}

function leesGroepenIdp(waarde) {
  if (!waarde) return undefined;
  const [type, id] = waarde.split(":");
  if (!type || !id)
    throw new Error("CLOUDFLARE_GROEPEN_IDP heeft de vorm <type>:<id>, bijvoorbeeld azureAD:<id>");
  return { type, id };
}

if (
  process.argv[1] &&
  new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname
) {
  const geheimen = [];
  const maskeer = (waarde) => {
    if (!waarde) return;
    geheimen.push(waarde);
    if (process.env.GITHUB_ACTIONS) process.stdout.write(`::add-mask::${waarde}\n`);
  };
  let modus = "inrichten";
  try {
    const arg = leesArgumenten(process.argv.slice(2), process.env);
    modus = ["opruimen", "tweedeDoorgang", "toegang"].find((m) => arg[m]) ?? "inrichten";
    let config = null;
    try {
      // Buiten de proef dwingt leesArgumenten --wrangler af; de proef leest zijn eigen.
      config = cloudflareConfig(arg.wrangler ?? "wrangler.jsonc");
    } catch (fout) {
      if (!["opruimen", "toegang"].includes(modus)) throw fout;
    }
    arg.hostname ??= config?.hostname ?? null;
    arg.worker = config?.worker ?? null;
    arg.stand = config?.stand ?? null;
    for (const naam of [
      "CLOUDFLARE_PROEF_TOKEN",
      "SUPABASE_ACCESS_TOKEN",
      "GH_TOKEN",
      "SENTRY_AUTH_TOKEN",
      "SMTP_WACHTWOORD",
      "TURNSTILE_GEHEIM",
    ])
      maskeer(process.env[naam]);
    const ghNodig = !arg.droogloop && ["inrichten", "opruimen"].includes(modus);
    if (ghNodig) eis("GH_TOKEN");
    const d = {
      cf: cloudflareClient({
        token: eis("CLOUDFLARE_PROEF_TOKEN"),
        accountId: eis("CLOUDFLARE_ACCOUNT_ID"),
        teamDomein: process.env.CLOUDFLARE_TEAM_DOMAIN || undefined,
      }),
      supabase: supabaseBeheer({
        token: eis("SUPABASE_ACCESS_TOKEN"),
        orgSlug: eis("SUPABASE_ORG_SLUG"),
      }),
      maakAdmin: standaardAdmin,
      gh: standaardGh(),
      // Alleen een klantportaal gebruikt dit: de toets van het geheim bij Turnstile.
      fetchFn: fetch,
      toegang: JSON.parse(readFileSync(new URL("./toegang.json", import.meta.url), "utf8")),
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      idps: (process.env.CLOUDFLARE_IDP_IDS ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      groepenIdp: leesGroepenIdp(process.env.CLOUDFLARE_GROEPEN_IDP),
      // Optioneel: met SENTRY_AUTH_TOKEN en SENTRY_ORG krijgt elke app een eigen
      // Sentry-project en DSN. Zonder sleutel nog de oude weg van de proef: één DSN
      // (VITE_SENTRY_DSN) voor elke app. Zie beheer/README.md.
      sentry: modus === "inrichten" ? sentryUitOmgeving(process.env) : null,
      sentryDsn: process.env.VITE_SENTRY_DSN?.trim() || undefined,
      // Alleen nodig voor een klantportaal: de sleutel van Resend voor de inlogmail, en de
      // geheime sleutel van Turnstile als `captcha` aan staat. Zie "Klantportaal" in de README.
      smtpWachtwoord: process.env.SMTP_WACHTWOORD?.trim() || undefined,
      captchaGeheim: process.env.TURNSTILE_GEHEIM?.trim() || undefined,
      maskeer,
    };
    const uitvoeren = {
      inrichten: richtIn,
      opruimen: ruimOp,
      tweedeDoorgang,
      toegang: werkToegangBij,
    }[modus];
    const resultaat = await uitvoeren(arg, d);
    const eind = eindstatus(modus, resultaat);
    process.stdout.write(uitvoerRegel(eind, geheimen));
    schrijfSamenvatting(samenvatting(modus, eind), geheimen);
    if (eind.status !== "gelukt") process.exitCode = 1;
  } catch (fout) {
    const eind = { status: "mislukt", modus, reden: fout.message };
    process.stdout.write(uitvoerRegel(eind, geheimen));
    schrijfSamenvatting(samenvatting(modus, eind), geheimen);
    process.exitCode = 1;
  }
}
