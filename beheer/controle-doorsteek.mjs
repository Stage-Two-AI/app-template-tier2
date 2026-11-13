#!/usr/bin/env node
/**
 * Geautomatiseerde controles van de live doorsteek (U7 in het plan). Kijkt van buitenaf,
 * zonder cookie en zonder sleutels behalve de openbare sleutel van Supabase, of de deur dicht
 * zit. Elke controle geeft "geslaagd", "gezakt" of "overgeslagen", met het bewijs erbij
 * (status en doorverwijzing), zodat het rapport in een draaiboek kan.
 *
 *   AE2  de app en de inlogroute van Supabase leveren zonder toegang niets op
 *   AE5  de preview vraagt om inloggen (dat de preview andere gegevens ziet, toont de
 *        proef niet aan: er is maar één Supabase-project, zie KTD9)
 *   AE6  het workers.dev-adres en het versie-adres van productie zijn dicht
 *   AE8  alleen met --tabel: een tabel zonder grant is niet op te vragen met de openbare
 *        sleutel (de proef heeft daarvoor de tabel proef_zonder_grant; een echte app niet)
 *   AE9  de inlogdienst van Supabase staat zoals het hoort: bij een gewone app is inloggen
 *        per mail uit; bij een klantportaal (KP2) aan, met bevestigen van het adres, zonder
 *        anoniem aanmelden, en (KP3) met de captcha
 *
 * Van elk adres dat dicht hoort te zijn vraagt de controle de voorpagina op en een willekeurig
 * diep pad: een uitzondering op een pad (een extra Access-app met een bypass) valt zo op.
 *
 * AE1, AE3 en de koppeltest (R16) vragen een echte login en doet een mens met de hand.
 *
 * Met --klantportaal (de app staat als klantportaal in toegang.json) draait AE2 om: het
 * eigen domein hoort dan juist open te zijn (KP1). De rest blijft: de inlog voor medewerkers
 * loopt nog steeds langs de loginpagina van Access, en het workers.dev-adres, het
 * versie-adres en de preview zijn dicht. Het workers.dev-adres en een preview-adres zijn dan
 * verplicht: zonder die twee is niet te zien of alleen het domein open ging. En "dicht" is
 * dan streng: alleen een doorverwijzing naar de loginpagina van Cloudflare Access telt. Een
 * adres dat niet bestaat, niet bereikbaar is of 404 geeft bewijst niets (een typfout ziet er
 * zo uit) en is gezakt.
 *
 * De captcha (KP3) is van buitenaf alleen te zien door een code aan te vragen zonder adres en
 * zonder bewijs van de widget: staat de captcha aan, dan weigert Supabase Auth dat met
 * "captcha_failed", nog vóór hij naar het adres kijkt. Er gaat nooit een mail uit (er is geen
 * adres). Dit volgt uit de broncode van Supabase Auth en is nog niet op een echt project
 * geprobeerd.
 *
 * Als knop (de workflow Controle van buitenaf): `--app <naam> --voorvoegsel <vv->`. Dan zoekt
 * het script zelf alle adressen op die de inrichting kent (het domein uit wrangler.jsonc, het
 * workers.dev-adres, de vaste preview `actueel-<worker>`, het project en de openbare sleutel
 * van Supabase, en of de app een klantportaal is), zodat niemand iets hoeft te typen. Daarvoor
 * leest het twee dingen: bij Cloudflare het workers.dev-subdomein van het account, bij
 * Supabase de lijst projecten en de openbare sleutel van het project. De service-role-sleutel
 * haalt het niet op. Het rapport schrijft het zelf naar de samenvatting van de run
 * (GITHUB_STEP_SUMMARY), niet via een omleiding van stdout.
 *
 * Gebruik:
 *   node beheer/controle-doorsteek.mjs --voorvoegsel <vv-> --app <naam> [--wrangler <pad>]
 *   of met de hand:
 *   node beheer/controle-doorsteek.mjs --hostname cf-proef.stagetwo.nl \
 *     --project-ref <ref> --workers-dev https://cf-proef.<sub>.workers.dev/ \
 *     [--versie-url <url>] [--preview-url <url>] [--tabel proef_zonder_grant]
 *     [--klantportaal]   (dan zijn --workers-dev en --preview-url verplicht)
 *   met SUPABASE_ANON_KEY in de omgeving.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cloudflareConfig } from "../scripts/lib/cloudflare-config.mjs";
import { appNamen, cloudflareClient, valideerVoorvoegsel } from "./lib/cloudflare.mjs";
import { supabaseBeheer } from "./lib/supabase.mjs";
import { captchaVanApp, isKlantportaal, valideerToegang } from "./lib/toegang.mjs";

const ACCESS = /\.cloudflareaccess\.com\//;

/**
 * Eén verzoek zonder cookies en zonder automatisch doorverwijzen. Met `post` een POST met die
 * JSON-body; dan komt de tekst van het antwoord altijd mee (ook bij een weigering).
 */
async function haal(fetchFn, url, headers = {}, post = undefined) {
  try {
    const antwoord = await fetchFn(url, {
      redirect: "manual",
      headers: post === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      ...(post === undefined ? {} : { method: "POST", body: JSON.stringify(post) }),
    });
    return {
      status: antwoord.status,
      naar: antwoord.headers.get("location") ?? "",
      body: antwoord.status < 300 || post !== undefined ? await antwoord.text() : "",
    };
  } catch (fout) {
    return { status: 0, naar: "", body: "", fout: String(fout?.message ?? fout) };
  }
}

function bewijsVan(r) {
  if (r.fout) return `niet bereikbaar (${r.fout})`;
  return r.naar ? `${r.status} naar ${r.naar}` : `${r.status}`;
}

/** Dicht = niet bereikbaar, een weigering, of een doorverwijzing naar de loginpagina. */
function isDicht(r) {
  if (r.fout) return true;
  if (r.status === 401 || r.status === 403 || r.status === 404) return true;
  return r.status >= 300 && r.status < 400 && ACCESS.test(r.naar);
}

/** De loginpagina van Cloudflare Access (van dit team, als het team bekend is). */
function naarAccessLogin(r, team) {
  if (!(r.status >= 300 && r.status < 400)) return false;
  let doel;
  try {
    doel = new URL(r.naar);
  } catch {
    return false;
  }
  const host = team ? doel.hostname === team : doel.hostname.endsWith(".cloudflareaccess.com");
  return doel.protocol === "https:" && host && doel.pathname.startsWith("/cdn-cgi/access/login");
}

/** Een willekeurig diep pad onder een adres: `<adres>controle-<hex>/<hex>`. */
function diepPad(url, willekeurig) {
  return new URL(`controle-${willekeurig()}/${willekeurig()}`, url).toString();
}

/**
 * Is dit adres dicht? Gekeken wordt naar de voorpagina en naar een willekeurig diep pad; beide
 * moeten dicht zijn. `streng` (bij een klantportaal): alleen de loginpagina van Access is
 * "dicht". Niet bereikbaar, 404 of een kale weigering is "onbekend" en telt als gezakt.
 */
async function deurControle(
  fetchFn,
  ae,
  wat,
  url,
  { streng = false, team, willekeurig = () => randomBytes(4).toString("hex") } = {},
) {
  if (!url) return { ae, wat, geslaagd: null, bewijs: "overgeslagen: geen adres opgegeven" };
  const diep = diepPad(url, willekeurig);
  const antwoorden = [
    ["voorpagina", await haal(fetchFn, url)],
    [`diep pad ${new URL(diep).pathname}`, await haal(fetchFn, diep)],
  ];
  const dicht = (r) => (streng ? naarAccessLogin(r, team) : isDicht(r));
  const bewijs = antwoorden
    .map(([naam, r]) =>
      dicht(r) || !streng
        ? `${naam}: ${bewijsVan(r)}`
        : `${naam}: ${bewijsVan(r)} (onbekend: geen doorverwijzing naar de loginpagina van Access${team ? ` op ${team}` : ""}; klopt het adres?)`,
    )
    .join("; ");
  return { ae, wat, geslaagd: antwoorden.every(([, r]) => dicht(r)), bewijs };
}

/**
 * Bij een klantportaal: het eigen domein is zonder inlog bereikbaar. Geslaagd bij een
 * gewone pagina (2xx), of een doorverwijzing die niet naar Cloudflare Access gaat. Een
 * loginpagina van Access, een weigering of een onbereikbaar adres betekent dat er nog een
 * deur staat (of dat de app er niet is): dan kan geen klant erbij.
 */
async function openControle(fetchFn, url) {
  const r = await haal(fetchFn, url);
  const naarAccess = ACCESS.test(r.naar);
  const open =
    !r.fout &&
    !naarAccess &&
    ((r.status >= 200 && r.status < 300) || (r.status >= 300 && r.status < 400));
  return {
    ae: "KP1",
    wat: "klantportaal: het domein is open zonder login",
    geslaagd: open,
    bewijs: naarAccess ? `${bewijsVan(r)} (er staat nog een deur van Access)` : bewijsVan(r),
  };
}

/** Bij een klantportaal mag een adres dat dicht hoort te zijn niet ontbreken. */
function verplichtDicht(r, klantportaal, vlag) {
  if (!klantportaal || r.geslaagd !== null) return r;
  return {
    ...r,
    geslaagd: false,
    bewijs: `niet opgegeven; bij een klantportaal verplicht (${vlag}), want daar moet de deur blijven`,
  };
}

/**
 * Loopt de inlogroute van Supabase na zoals een browser zonder Access-sessie dat zou
 * doen, stap voor stap. Gezakt zodra er een doorverwijzing met een code of token terug
 * naar de app komt; geslaagd als de route eindigt bij de loginpagina van Access.
 */
async function inlogrouteControle(fetchFn, { projectRef, hostname }) {
  const terug = `https://${hostname}/`;
  let url =
    `https://${projectRef}.supabase.co/auth/v1/authorize?provider=custom%3Acloudflare` +
    `&redirect_to=${encodeURIComponent(terug)}`;
  const stappen = [];
  for (let i = 0; i < 6; i++) {
    const r = await haal(fetchFn, url);
    stappen.push(bewijsVan(r));
    if (!r.naar) break;
    if (r.naar.startsWith(terug) && /[?#&](code|access_token)=/.test(r.naar)) {
      return {
        ae: "AE2",
        wat: "inlogroute Supabase zonder toegang",
        geslaagd: false,
        bewijs: `kreeg een code terug: ${stappen.join(" -> ")}`,
      };
    }
    if (ACCESS.test(r.naar) && r.naar.includes("/cdn-cgi/access/login")) {
      return {
        ae: "AE2",
        wat: "inlogroute Supabase zonder toegang",
        geslaagd: true,
        bewijs: stappen.join(" -> "),
      };
    }
    url = new URL(r.naar, url).toString();
  }
  return {
    ae: "AE2",
    wat: "inlogroute Supabase zonder toegang",
    geslaagd: false,
    bewijs: `eindigde niet bij de loginpagina van Access: ${stappen.join(" -> ")}`,
  };
}

async function tabelControle(fetchFn, { projectRef, anonKey, tabelZonderGrant }) {
  const url = `https://${projectRef}.supabase.co/rest/v1/${tabelZonderGrant}?select=*&limit=1`;
  const r = await haal(fetchFn, url, { apikey: anonKey, Authorization: `Bearer ${anonKey}` });
  const dicht = r.fout || r.status === 401 || r.status === 403 || r.status === 404;
  return {
    ae: "AE8",
    wat: `tabel ${tabelZonderGrant} zonder grant`,
    geslaagd: Boolean(dicht),
    bewijs: bewijsVan(r),
  };
}

/**
 * De openbare instellingen van de inlogdienst (`/auth/v1/settings`, met de openbare sleutel).
 * Een gewone app: inloggen per mail staat uit. Een klantportaal: aan, een adres moet eerst
 * bevestigd worden, en anoniem aanmelden staat uit. Zonder dit keurde de controle een
 * klantportaal goed waar geen klant kan inloggen.
 */
async function instellingenControle(fetchFn, { projectRef, anonKey, klantportaal }) {
  const ae = klantportaal ? "KP2" : "AE9";
  const wat = klantportaal
    ? "klantportaal: inloggen per mail staat aan, met bevestigen van het adres"
    : "inloggen per mail staat uit";
  const r = await haal(fetchFn, `https://${projectRef}.supabase.co/auth/v1/settings`, {
    apikey: anonKey,
  });
  let s = null;
  try {
    s = JSON.parse(r.body);
  } catch {
    s = null;
  }
  if (r.status !== 200 || typeof s?.external?.email !== "boolean") {
    return {
      ae,
      wat,
      geslaagd: false,
      bewijs: `${bewijsVan(r)} (de instellingen waren niet te lezen)`,
    };
  }
  const stand = `e-mail ${s.external.email ? "aan" : "uit"}, bevestigen ${s.mailer_autoconfirm ? "uit" : "aan"}, anoniem ${s.external.anonymous_users ? "aan" : "uit"}`;
  const goed = klantportaal
    ? s.external.email === true &&
      s.mailer_autoconfirm === false &&
      s.external.anonymous_users !== true
    : s.external.email === false;
  return { ae, wat, geslaagd: goed, bewijs: stand };
}

/**
 * Staat de captcha aan? Een aanvraag voor een code zonder adres en zonder bewijs van de widget:
 * met de captcha aan weigert Supabase Auth met `captcha_failed`. Zonder adres gaat er nooit
 * een mail uit. `verwacht` false: de captcha staat volgens toegang.json uit; dan overgeslagen.
 */
async function captchaControle(fetchFn, { projectRef, anonKey, verwacht }) {
  const ae = "KP3";
  const wat = "klantportaal: de captcha staat aan";
  if (verwacht === false) {
    return {
      ae,
      wat,
      geslaagd: null,
      bewijs: 'overgeslagen: in toegang.json staat "captcha": false (alleen tijdelijk bedoeld)',
    };
  }
  const r = await haal(
    fetchFn,
    `https://${projectRef}.supabase.co/auth/v1/otp`,
    { apikey: anonKey },
    {},
  );
  const aan = r.status === 400 && /captcha_failed|captcha protection/.test(r.body);
  return {
    ae,
    wat,
    geslaagd: aan,
    bewijs: aan
      ? `${r.status}: een aanvraag zonder bewijs van de widget wordt geweigerd`
      : `${bewijsVan(r)} (geen weigering van de captcha: staat hij aan in Supabase?)`,
  };
}

export async function controleer({
  fetchFn = globalThis.fetch,
  hostname,
  projectRef,
  anonKey,
  workersDev,
  versieUrl,
  previewUrl,
  // Alleen met een naam: de proef heeft de tabel proef_zonder_grant, een echte app niet.
  tabelZonderGrant,
  klantportaal = false,
  // Bij een klantportaal: staat de captcha volgens toegang.json aan (de standaard)?
  captcha = true,
  // Het teamdomein van Access (`<team>.cloudflareaccess.com`), als de inrichting het kent.
  team,
  willekeurig,
}) {
  const streng = { streng: klantportaal, team, willekeurig };
  return [
    klantportaal
      ? await openControle(fetchFn, `https://${hostname}/`)
      : await deurControle(fetchFn, "AE2", "app zonder login", `https://${hostname}/`, {
          willekeurig,
        }),
    await inlogrouteControle(fetchFn, { projectRef, hostname }),
    verplichtDicht(
      await deurControle(fetchFn, "AE6", "workers.dev-adres", workersDev, streng),
      klantportaal,
      "--workers-dev",
    ),
    await deurControle(fetchFn, "AE6", "versie-adres van productie", versieUrl, streng),
    verplichtDicht(
      await deurControle(fetchFn, "AE5", "preview zonder login", previewUrl, streng),
      klantportaal,
      "--preview-url",
    ),
    await instellingenControle(fetchFn, { projectRef, anonKey, klantportaal }),
    ...(klantportaal
      ? [await captchaControle(fetchFn, { projectRef, anonKey, verwacht: captcha })]
      : []),
    ...(tabelZonderGrant
      ? [await tabelControle(fetchFn, { projectRef, anonKey, tabelZonderGrant })]
      : []),
  ];
}

/**
 * De adressen voor de knop: alles wat de inrichting zelf kent, opgezocht in plaats van
 * getypt. `d` heeft `cf` en `supabase` (zie inrichten-cloudflare.mjs) en `toegang`; `arg` heeft
 * app, voorvoegsel, hostname, worker en stand (uit wrangler.jsonc). Alleen lezen.
 */
export async function adressenVoor(arg, d) {
  const t = valideerToegang(d.toegang);
  if (!Object.hasOwn(t.apps, arg.app))
    throw new Error(`app "${arg.app}" staat niet in beheer/toegang.json`);
  const vv = valideerVoorvoegsel(arg.voorvoegsel);
  const subdomein = await d.cf.workersSubdomein();
  const team = await d.cf.teamDomein();
  const naam = appNamen(arg.app, vv).project;
  const project = (await d.supabase.projecten()).find((p) => p.name === naam);
  if (!project) throw new Error(`Supabase-project ${naam} bestaat niet; draai eerst App inrichten`);
  // Alleen de openbare sleutel: de service role heeft deze controle nergens voor nodig.
  const anonKey = await d.supabase.openbareSleutel(project.ref);
  const basis = `${arg.worker}.${subdomein}.workers.dev`;
  const tijdelijk = arg.stand === "tijdelijk";
  return {
    hostname: tijdelijk ? basis : arg.hostname,
    projectRef: project.ref,
    anonKey,
    // In de tijdelijke stand is workers.dev het adres van de app zelf.
    workersDev: tijdelijk ? undefined : `https://${basis}/`,
    previewUrl: `https://actueel-${basis}/`,
    klantportaal: isKlantportaal(t, arg.app),
    captcha: captchaVanApp(t, arg.app),
    team,
  };
}

/**
 * Het rapport als tekst (Markdown): de tabel, en eronder wat de owner nu doet. Dezelfde tekst
 * gaat naar stdout en naar de samenvatting van de run.
 */
export function rapportTekst(kop, rapport, { klantportaal = false } = {}) {
  const gezakt = rapport.filter((r) => r.geslaagd === false);
  const watNu = [];
  if (!gezakt.length) {
    watNu.push(
      klantportaal
        ? "Alles klopt: alleen het domein is open. Log zelf nog een keer in per mail, in een privévenster."
        : "Alles klopt: elk adres is dicht.",
    );
  } else {
    if (gezakt.some((r) => r.ae === "KP1"))
      watNu.push(
        "Het domein is niet open: staat de deur er nog (stap 5 is dan nog niet gedaan), of is de app niet uitgerold?",
      );
    if (gezakt.some((r) => ["AE2", "AE5", "AE6"].includes(r.ae)))
      watNu.push(
        'Er is een adres open dat dicht hoort te zijn. Draai App inrichten (zonder vinkje, droogloop uit) en daarna deze controle opnieuw. Blijft het kruis bij een klantportaal, zet dan de deur terug: zie "Als het misgaat: terug achter de deur" in beheer/README.md.',
      );
    if (gezakt.some((r) => ["KP2", "KP3", "AE9"].includes(r.ae)))
      watNu.push(
        "De inlogdienst van Supabase staat niet zoals de inrichting hem zet. Draai App inrichten (zonder vinkje, droogloop uit) en daarna deze controle opnieuw.",
      );
    if (gezakt.some((r) => r.ae === "AE8"))
      watNu.push("Een tabel zonder grant is op te vragen: kijk de rechten in de database na.");
  }
  return [
    `## ${kop}`,
    "",
    gezakt.length
      ? `**Gezakt:** ${gezakt.length} van de ${rapport.length} controles.`
      : "Geslaagd.",
    "",
    "| Code | Controle | Uitkomst | Bewijs |",
    "|---|---|---|---|",
    ...rapport.map(regel),
    "",
    "**Wat nu**",
    "",
    ...watNu.map((x, i) => `${i + 1}. ${x}`),
    "",
  ].join("\n");
}

function regel(r) {
  const teken = r.geslaagd === null ? "-" : r.geslaagd ? "✓" : "✗";
  return `| ${r.ae} | ${r.wat} | ${teken} | ${r.bewijs.replaceAll("|", "\\|")} |`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      voorvoegsel: { type: "string" },
      wrangler: { type: "string" },
      hostname: { type: "string" },
      "project-ref": { type: "string" },
      "workers-dev": { type: "string" },
      "versie-url": { type: "string" },
      "preview-url": { type: "string" },
      tabel: { type: "string" },
      klantportaal: { type: "boolean" },
    },
  });
  let invoer;
  if (values.app) {
    // De knop: alles opzoeken met de sleutels van de beheeromgeving.
    const eis = (naam) => {
      if (!process.env[naam]) {
        console.error(`${naam} ontbreekt in de omgeving.`);
        process.exit(2);
      }
      return process.env[naam];
    };
    const config = cloudflareConfig(values.wrangler ?? "wrangler.jsonc");
    try {
      invoer = await adressenVoor(
        {
          app: values.app,
          voorvoegsel: values.voorvoegsel ?? process.env.BEHEER_VOORVOEGSEL,
          hostname: config.hostname,
          worker: config.worker,
          stand: config.stand,
        },
        {
          cf: cloudflareClient({
            token: eis("CLOUDFLARE_PROEF_TOKEN"),
            accountId: eis("CLOUDFLARE_ACCOUNT_ID"),
            teamDomein: process.env.CLOUDFLARE_TEAM_DOMAIN || undefined,
          }),
          supabase: supabaseBeheer({
            token: eis("SUPABASE_ACCESS_TOKEN"),
            orgSlug: eis("SUPABASE_ORG_SLUG"),
          }),
          toegang: JSON.parse(readFileSync(new URL("./toegang.json", import.meta.url), "utf8")),
        },
      );
    } catch (fout) {
      console.error(`De adressen waren niet op te zoeken: ${fout.message}`);
      process.exit(2);
    }
  } else {
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!values.hostname || !values["project-ref"] || !anonKey) {
      console.error(
        "Nodig: --app en --voorvoegsel (de knop), of --hostname, --project-ref en SUPABASE_ANON_KEY in de omgeving.",
      );
      process.exit(2);
    }
    invoer = {
      hostname: values.hostname,
      projectRef: values["project-ref"],
      anonKey,
      workersDev: values["workers-dev"],
      previewUrl: values["preview-url"],
      klantportaal: values.klantportaal,
    };
  }
  const rapport = await controleer({
    ...invoer,
    versieUrl: values["versie-url"],
    tabelZonderGrant: values.tabel,
  });
  const kop = `Controle van buitenaf: ${values.app ?? invoer.hostname}${invoer.klantportaal ? " (klantportaal)" : ""}`;
  const tekst = rapportTekst(kop, rapport, invoer);
  console.log(tekst);
  // De samenvatting van de run schrijft het script zelf; er staat geen sleutel in.
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${tekst}\n`);
    } catch {
      // Het rapport staat ook op stdout.
    }
  }
  process.exit(rapport.some((r) => r.geslaagd === false) ? 1 : 0);
}
