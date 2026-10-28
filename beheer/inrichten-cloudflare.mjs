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
 *
 * Het voorvoegsel is verplicht (vlag of BEHEER_VOORVOEGSEL): `cf-proef-` voor de proef,
 * `rp-` voor Richplant. Buiten de proef zijn ook `--repo` (de app-repo die de
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
 *   4   Access op de Worker zelf (vóór 3.6, zodat hij er staat vóór de eerste uitrol)
 *   T   met --testdatabase: een tweede Supabase-project `<vv><app>-test` met een eigen
 *       SaaS-app `<vv><app>-test-inlog`, provider en auth-config; de previews wijzen
 *       daarheen en het wachtwoord komt als SUPABASE_TEST_DB_PASSWORD in production.
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
 *   CLOUDFLARE_IDP_IDS (komma's) en CLOUDFLARE_GROEPEN_IDP (<type>:<id>).
 *
 * Uitvoer: één regel `INRICHTING {json}`; geheimen staan er nooit in leesbaar in, en in
 * GitHub Actions worden ze ook met ::add-mask:: uit het logboek gehouden.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { cloudflareConfig } from "../scripts/lib/cloudflare-config.mjs";
import {
  afwijkingen,
  appNamen,
  cloudflareClient,
  deurApp,
  inlogApp,
  issuerVoor,
  metGewenst,
  PROEF_VOORVOEGSEL,
  policyIdsVanApp,
  valideerVoorvoegsel,
  wachtOpDiscovery,
  workerApp,
} from "./lib/cloudflare.mjs";
import {
  afmeldSql,
  alleGebruikers,
  authInstellingen,
  callbackAdres,
  hookInstellingen,
  REGIO,
  standaardAdmin,
  supabaseBeheer,
  supabaseUrl,
  uriAllowList,
  verschil,
  verwijderProvider,
  zetProvider,
} from "./lib/supabase.mjs";
import {
  aanmeldHookSql,
  BAN_DUUR,
  GEEN_BAN,
  gewenstePolicies,
  hookFunctie,
  kaleNaamConflicten,
  koppelPolicies,
  policyIdsVoorApp,
  policyNaam,
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
const GH_VARIABELEN = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_INLOGDIENST",
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
const GH_SECRETS = ["SUPABASE_PROJECT_REF", "SUPABASE_DB_PASSWORD", "SUPABASE_TEST_DB_PASSWORD"];
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
  };
  const vlaggen = {
    "--testdatabase": "testdatabase",
    "--droogloop": "droogloop",
    "--opruimen": "opruimen",
    "--tweede-doorgang": "tweedeDoorgang",
    "--toegang": "toegang",
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
  if (!t.apps[arg.app]) {
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
  for (const naam of [namen.deur, namen.inlog, namen.testInlog, namen.worker]) {
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
  if (fouten.length) throw new Error(`gestopt zonder wijzigingen: ${fouten.join("; ")}`);

  return {
    t,
    gewenst,
    namen,
    policies,
    apps,
    idps,
    subdomein,
    team,
    hostname,
    tijdelijk,
    project: projecten.find((p) => p.name === namen.project) ?? null,
    deur: apps.find((a) => a.name === namen.deur) ?? null,
    inlog: apps.find((a) => a.name === namen.inlog) ?? null,
    testProject: projecten.find((p) => p.name === namen.test) ?? null,
    testInlog: apps.find((a) => a.name === namen.testInlog) ?? null,
    workerAccess: apps.find((a) => a.name === namen.worker) ?? null,
  };
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
 * Zet variabelen per omgeving en op de repo (alleen wat anders is) en secrets in
 * omgeving production, via stdin.
 */
async function zetGithub(d, repo, { variabelen = {}, repoVariabelen = {}, secrets = {} }) {
  const gezet = [];
  if (Object.keys(variabelen).length) {
    for (const env of OMGEVINGEN) await zetVariabelen(d, env, repo, variabelen, gezet);
  }
  if (Object.keys(repoVariabelen).length) {
    await zetVariabelen(d, null, repo, repoVariabelen, gezet);
  }
  const namen = Object.keys(secrets);
  if (namen.length) {
    const bestaand = await leesGhSecretNamen(d, SECRET_OMGEVING, repo);
    for (const naam of namen) {
      const { waarde, altijd } = secrets[naam];
      if (!waarde || (!altijd && bestaand.includes(naam))) continue;
      // Secrets gaan via stdin, nooit als argument: argumenten zijn zichtbaar in de proceslijst.
      await d.gh(["secret", "set", naam, "--env", SECRET_OMGEVING, "--repo", repo], {
        invoer: waarde,
      });
      gezet.push(`${SECRET_OMGEVING}/secret ${naam}`);
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

// ---------------------------------------------------------------- stap 4

/**
 * Stap 4. De Access op de Worker bewaakt het workers.dev-adres en de previews (in de
 * tijdelijke stand is hij de enige deur). Bestaat de Worker nog niet, dan komt er eerst
 * een placeholder, zodat die deur er staat vóór de eerste uitrol (die de placeholder
 * overschrijft).
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
  if (!anders.length) return { stap, actie: `${voor}ongewijzigd`, id: v.workerAccess.id };
  await d.cf.werkAppBij(v.workerAccess.id, metGewenst(v.workerAccess, policyIds, v.idps));
  return { stap, actie: `${voor}${anders.join(" en ")} bijgewerkt`, id: v.workerAccess.id };
}

// ---------------------------------------------------------------- de inrichting

const GEEN_DEUR = "overgeslagen: tijdelijke stand (workers.dev), de Access op de Worker is de deur";
const PLACEHOLDER_GEPLAND = "gepland: placeholder en Access op de Worker";

/** Wat stap 4 in een droogloop zou doen. */
function geplandWorker(v, workerBestaat) {
  if (workerBestaat) {
    return v.workerAccess ? `bestaat al (${v.workerAccess.id})` : `gepland: ${v.namen.worker}`;
  }
  return PLACEHOLDER_GEPLAND;
}

function geplandeStappen(arg, v, workerBestaat) {
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
      actie: `gepland: site_url https://${v.hostname}, redirects ${uriAllowList({ hostname: v.hostname, worker: arg.worker, subdomein: v.subdomein }).join(" ")}, e-mail-inlog uit`,
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
      actie: v.tijdelijk ? GEEN_DEUR : bestaat(v.deur, `${v.namen.deur} op ${v.hostname}`),
    },
    { stap: "4 Access op de Worker", actie: geplandWorker(v, workerBestaat) },
    {
      stap: "3.6 GitHub-variabelen en -secrets",
      actie: `gepland in ${arg.repo ?? "(geen repo)"}: variabelen in ${OMGEVINGEN.join(" en ")}, ${GH_PREVIEW_VARIABELEN.join(", ")} als repo-variabelen, secrets in omgeving ${SECRET_OMGEVING}`,
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
async function koppelInlog(d, v, { ref, serviceRole, saas, naam, gewenstAuth }) {
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
  const anders = verschil(await d.supabase.authConfig(ref), gewenstAuth);
  if (Object.keys(anders).length) await d.supabase.werkAuthBij(ref, anders);
  const auth = Object.keys(anders).length
    ? `bijgewerkt: ${Object.keys(anders).join(", ")}`
    : "ongewijzigd";
  return { issuer, provider, auth };
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
      secrets: { SUPABASE_TEST_DB_PASSWORD: { waarde: wachtwoord, altijd: true } },
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
  if (
    v.testProject &&
    !(await leesGhSecretNamen(d, SECRET_OMGEVING, arg.repo)).includes("SUPABASE_TEST_DB_PASSWORD")
  ) {
    // Het oude wachtwoord is niet op te vragen. Voor de testdatabase mag een nieuw: er
    // staan alleen testgegevens in, en zonder dit secret slaat deploy-db.yml de canary
    // over en gaan migraties meteen naar productie. Productie krijgt dit nooit.
    const wachtwoord = (d.wachtwoord ?? nieuwWachtwoord)();
    maskeer(wachtwoord);
    await d.supabase.zetDatabaseWachtwoord(project.ref, wachtwoord);
    await zetGithub(d, arg.repo, {
      secrets: { SUPABASE_TEST_DB_PASSWORD: { waarde: wachtwoord, altijd: true } },
    });
    stap(
      "T testdatabase: wachtwoord",
      "ontbrak in de app-repo: nieuw gezet in Supabase en als secret",
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
    resultaat.stappen = geplandeStappen(arg, v, await d.cf.workerBestaat(arg.worker));
    return resultaat;
  }
  const stap = (naam, actie) => resultaat.stappen.push({ stap: naam, actie });
  const { cf, supabase } = d;

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
      variabelen: {},
      secrets: {
        SUPABASE_PROJECT_REF: { waarde: project.ref, altijd: true },
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
  const koppeling = await koppelInlog(d, v, {
    ref: project.ref,
    serviceRole: sleutels.serviceRole,
    saas,
    naam: v.namen.inlog,
    gewenstAuth,
  });
  resultaat.issuer = koppeling.issuer;
  stap("3.3 custom provider custom:cloudflare", koppeling.provider);
  stap("3.4 auth-config", koppeling.auth);
  resultaat.uri_allow_list = gewenstAuth.uri_allow_list.split(",");

  // T de testdatabase, waar de previews naartoe gaan
  const test = arg.testdatabase
    ? await stapTestdatabase(arg, d, v, { policyIds, gewenstAuth, maskeer, stap })
    : null;
  if (test) resultaat.testdatabase = { project_ref: test.ref, anon_key: test.inGit };

  // 3.5 de deur; in de tijdelijke stand is er geen hostname en is stap 4 de deur
  let deur = v.deur;
  if (v.tijdelijk) stap("3.5 Access-app op de hostname", GEEN_DEUR);
  else if (!deur) {
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

  // 4 Access op de Worker, vóór 3.6: pas met de GitHub-variabelen kan er uitgerold
  // worden, en dan moet de deur er al staan. Zo nodig zet deze stap eerst een
  // placeholder neer, want workers.dev staat in beide standen aan.
  const w = await stapWorker(arg, d, v, policyIds);
  stap(w.stap, w.actie);

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
  // deploy-db.yml gebruikt deze voor de canary. Ontbreekt hij, dan valt die terug op productie.
  const testPooler = test
    ? await supabase.poolerHost(test.ref).catch((fout) => {
        resultaat.waarschuwingen.push(
          `de session pooler van de testdatabase was niet op te halen (${fout.message}); zet SUPABASE_TEST_POOLER_HOST in omgeving production met de hand, anders mislukt de canary in deploy-db.yml`,
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
      // Sentry staat alleen aan als de beheeromgeving een DSN heeft; anders niets.
      ...(d.sentryDsn ? { VITE_SENTRY_DSN: d.sentryDsn } : {}),
    },
    // De preview draait op de testdatabase als die er is, anders op hetzelfde project.
    // Een eigen database gebruikt schema public.
    repoVariabelen: {
      PREVIEW_VITE_SUPABASE_URL: supabaseUrl(test?.ref ?? project.ref),
      PREVIEW_VITE_SUPABASE_ANON_KEY: test?.anon ?? sleutels.anon,
      PREVIEW_VITE_SUPABASE_SCHEMA: "public",
      PREVIEW_VITE_INLOGDIENST: "cloudflare",
      ...(d.sentryDsn ? { PREVIEW_VITE_SENTRY_DSN: d.sentryDsn } : {}),
    },
    // Het wachtwoord staat er al (direct na het aanmaken van het project); hier alleen
    // nog de project-ref voor een project dat al bestond.
    secrets: {
      SUPABASE_PROJECT_REF: { waarde: project.ref, altijd: false },
    },
  });
  stap(
    "3.6 GitHub-variabelen en -secrets",
    gezet.length ? `gezet: ${gezet.join(", ")}` : "ongewijzigd",
  );
  if (!wachtwoord) {
    resultaat.waarschuwingen.push(
      "het project bestond al; SUPABASE_DB_PASSWORD is niet opnieuw gezet (alleen bij aanmaken bekend)",
    );
  }

  const weg = await verwijderOverbodig(cf, sync.overbodig);
  if (weg.length) stap("3.2 Access-policies", `overbodig verwijderd: ${weg.join(", ")}`);

  resultaat.cloudflare = {
    policies: sync.ids,
    inlog: inlog.id,
    deur: v.tijdelijk ? null : deur.id,
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
  return { app: arg.app, melding: w.actie, worker: w.id };
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
    ...namen.flatMap((n) => [n.deur, n.inlog, n.worker]),
    ...testNamen.map((n) => n.testInlog),
  ]);
  const projectNamen = new Set([...namen.map((n) => n.project), ...testNamen.map((n) => n.test)]);
  // De policies zijn herbruikbaar: een groep kan aan meer apps hangen. Bij één app gaan
  // alleen de groepen van die app mee (staat hij niet meer in toegang.json, dan elke groep),
  // en daarvan alleen wat geen andere app in toegang.json nog gebruikt.
  const groepen = Object.keys(d.toegang?.groepen ?? {});
  const kandidaten = arg.app ? (d.toegang?.apps?.[arg.app] ?? groepen) : groepen;
  const gebruiktDoor = (groep) =>
    Object.entries(d.toegang?.apps ?? {})
      .filter(([app, gekozen]) => !appsUitBestand.includes(app) && gekozen.includes(groep))
      .map(([app]) => app);
  const policyNamen = new Set(kandidaten.map((g) => policyNaam(g, vv)));

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
    const groep = kandidaten.find((g) => policyNaam(g, vv) === p.name);
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
    // De secrets in omgeving production, en een oud repo-secret van vóór die omgeving.
    for (const env of [SECRET_OMGEVING, null]) {
      const secrets = await leesGhSecretNamen(d, env, arg.repo);
      for (const naam of GH_SECRETS.filter((n) => secrets.includes(n))) {
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
 */
async function trekInOp(d, t, app, ref, { test = false } = {}) {
  const sleutels = await d.supabase.sleutels(ref);
  d.maskeer?.(sleutels.serviceRole);
  const admin = (d.maakAdmin ?? standaardAdmin)(supabaseUrl(ref), sleutels.serviceRole);
  return trekIn({
    gebruikers: await alleGebruikers(admin),
    toegang: t,
    app,
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
}

/**
 * Maakt Cloudflare gelijk aan toegang.json en trekt daarna de toegang in van wie niet
 * meer past: ban en afmelden in het Supabase-project van elke app.
 */
export async function werkToegangBij(arg, d) {
  const vv = valideerVoorvoegsel(arg.voorvoegsel);
  const t = valideerToegang(d.toegang);
  const { cf, supabase } = d;
  const policies = await cf.policies();
  const apps = await cf.apps();
  const projecten = await supabase.projecten();
  const doelApps = (arg.app ? [arg.app] : Object.keys(t.apps)).filter((app) => t.apps[app]);
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
    return {
      droogloop: true,
      acties: ["gepland: policies gelijkzetten, apps koppelen, intrekken", ...hooks],
    };
  }
  const sync = await synchroniseerPolicies(cf, t, {
    groepenIdp: d.groepenIdp,
    bestaand: policies,
    voorvoegsel: vv,
  });
  const gekoppeld = await koppelPolicies(cf, t, apps, sync.ids, vv);

  const ingetrokken = {};
  const toegelaten = {};
  const onbekend = {};
  const hooks = [];
  for (const app of doelApps) {
    const project = projectVan(app);
    if (!project) continue;
    // De testdatabase: eerst de aanmeld-hook (die het nieuwe bestand moet volgen), dan
    // pas inloggen met e-mail aan. Zo staat e-mail nooit aan zonder hook.
    const testProject = testProjectVan(app);
    if (testProject) {
      const functie = await schrijfTestHook(d, t, app, testProject.ref, vv);
      hooks.push(`aanmeld-hook public.${functie} van ${app} (test) bijgewerkt`);
      const anders = verschil(
        await supabase.authConfig(testProject.ref),
        hookInstellingen(functie),
      );
      if (Object.keys(anders).length) {
        await supabase.werkAuthBij(testProject.ref, anders);
        hooks.push(`inloggen met e-mail in ${app} (test) aangezet, alleen voor testaccounts`);
      }
    }
    // Ook in de testdatabase: wie eruit is, komt ook in de previews niet meer binnen.
    // De testaccounts daar blijven staan.
    const doelen = [
      [app, project, false],
      [`${app} (test)`, testProject, true],
    ];
    for (const [sleutel, p, test] of doelen) {
      if (!p) continue;
      const r = await trekInOp(d, t, app, p.ref, { test });
      if (r.ingetrokken.length) ingetrokken[sleutel] = r.ingetrokken;
      if (r.toegelaten.length) toegelaten[sleutel] = r.toegelaten;
      if (r.onbekend.length) onbekend[sleutel] = r.onbekend;
    }
  }
  // Pas na het intrekken: een policy die nog aan een app hangt, weigert Cloudflare te
  // verwijderen, en dat mag het intrekken van toegang nooit tegenhouden.
  const waarschuwingen = [];
  let weg = [];
  try {
    weg = await verwijderOverbodig(cf, sync.overbodig);
  } catch (fout) {
    waarschuwingen.push(`overbodige policies niet verwijderd: ${fout.message}`);
  }
  return {
    acties: [...sync.acties, ...gekoppeld, ...hooks, ...weg.map((n) => `policy ${n} verwijderd`)],
    ingetrokken,
    toegelaten,
    onbekend,
    waarschuwingen,
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
    for (const naam of ["CLOUDFLARE_PROEF_TOKEN", "SUPABASE_ACCESS_TOKEN", "GH_TOKEN"])
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
      toegang: JSON.parse(readFileSync(new URL("./toegang.json", import.meta.url), "utf8")),
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      idps: (process.env.CLOUDFLARE_IDP_IDS ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      groepenIdp: leesGroepenIdp(process.env.CLOUDFLARE_GROEPEN_IDP),
      // Optioneel: met een DSN zet de inrichting Sentry aan (zie beheer/README.md).
      sentryDsn: process.env.VITE_SENTRY_DSN?.trim() || undefined,
      maskeer,
    };
    const uitvoeren = {
      inrichten: richtIn,
      opruimen: ruimOp,
      tweedeDoorgang,
      toegang: werkToegangBij,
    }[modus];
    const resultaat = await uitvoeren(arg, d);
    process.stdout.write(uitvoerRegel({ status: "gelukt", modus, ...resultaat }, geheimen));
  } catch (fout) {
    process.stdout.write(uitvoerRegel({ status: "mislukt", modus, reden: fout.message }, geheimen));
    process.exitCode = 1;
  }
}
