#!/usr/bin/env node
/**
 * Geautomatiseerde controles van de live doorsteek (U7 in het plan). Kijkt van buitenaf,
 * zonder cookie en zonder sleutels behalve de publieke anon-sleutel, of de deur dicht
 * zit. Elke controle geeft "geslaagd", "gezakt" of "overgeslagen", met het bewijs erbij
 * (status en doorverwijzing), zodat het rapport in een draaiboek kan.
 *
 *   AE2  de app en de inlogroute van Supabase leveren zonder toegang niets op
 *   AE5  de preview vraagt om inloggen (dat de preview andere gegevens ziet, toont de
 *        proef niet aan: er is maar één Supabase-project, zie KTD9)
 *   AE6  het workers.dev-adres en het versie-adres van productie zijn dicht
 *   AE8  een tabel zonder grant is niet op te vragen met de anon-sleutel
 *
 * AE1, AE3 en de koppeltest (R16) vragen een echte login en doet Christijn met de hand.
 *
 * Met --klantportaal (de app staat als klantportaal in toegang.json) draait AE2 om: het
 * eigen domein hoort dan juist open te zijn (KP1). De rest blijft: de inlog voor medewerkers
 * loopt nog steeds langs de loginpagina van Access, en het workers.dev-adres, het
 * versie-adres en de preview zijn dicht. Het workers.dev-adres en een preview-adres zijn dan
 * verplicht (--workers-dev en --preview-url, bijvoorbeeld het vaste adres
 * https://actueel-<worker>.<sub>.workers.dev/): zonder die twee is niet te zien of alleen het
 * domein open ging. Een preview heeft een eigen adres; dat workers.dev dicht is, zegt daar
 * niets over.
 *
 * Gebruik:
 *   node beheer/controle-doorsteek.mjs --hostname cf-proef.stagetwo.nl \
 *     --project-ref <ref> --workers-dev https://cf-proef.<sub>.workers.dev/ \
 *     [--versie-url <url>] [--preview-url <url>] [--tabel proef_zonder_grant]
 *     [--klantportaal]   (dan zijn --workers-dev en --preview-url verplicht)
 *   met SUPABASE_ANON_KEY in de omgeving.
 */
import { parseArgs } from "node:util";

const ACCESS = /\.cloudflareaccess\.com\//;

/** Eén verzoek zonder cookies en zonder automatisch doorverwijzen. */
async function haal(fetchFn, url, headers = {}) {
  try {
    const antwoord = await fetchFn(url, { redirect: "manual", headers });
    return {
      status: antwoord.status,
      naar: antwoord.headers.get("location") ?? "",
      body: antwoord.status < 300 ? await antwoord.text() : "",
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

async function deurControle(fetchFn, ae, wat, url) {
  if (!url) return { ae, wat, geslaagd: null, bewijs: "overgeslagen: geen adres opgegeven" };
  const r = await haal(fetchFn, url);
  return { ae, wat, geslaagd: isDicht(r), bewijs: bewijsVan(r) };
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

export async function controleer({
  fetchFn = globalThis.fetch,
  hostname,
  projectRef,
  anonKey,
  workersDev,
  versieUrl,
  previewUrl,
  tabelZonderGrant = "proef_zonder_grant",
  klantportaal = false,
}) {
  return [
    klantportaal
      ? await openControle(fetchFn, `https://${hostname}/`)
      : await deurControle(fetchFn, "AE2", "app zonder login", `https://${hostname}/`),
    await inlogrouteControle(fetchFn, { projectRef, hostname }),
    verplichtDicht(
      await deurControle(fetchFn, "AE6", "workers.dev-adres", workersDev),
      klantportaal,
      "--workers-dev",
    ),
    await deurControle(fetchFn, "AE6", "versie-adres van productie", versieUrl),
    verplichtDicht(
      await deurControle(fetchFn, "AE5", "preview zonder login", previewUrl),
      klantportaal,
      "--preview-url",
    ),
    await tabelControle(fetchFn, { projectRef, anonKey, tabelZonderGrant }),
  ];
}

function regel(r) {
  const teken = r.geslaagd === null ? "-" : r.geslaagd ? "✓" : "✗";
  return `| ${r.ae} | ${r.wat} | ${teken} | ${r.bewijs.replaceAll("|", "\\|")} |`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      hostname: { type: "string" },
      "project-ref": { type: "string" },
      "workers-dev": { type: "string" },
      "versie-url": { type: "string" },
      "preview-url": { type: "string" },
      tabel: { type: "string" },
      klantportaal: { type: "boolean" },
    },
  });
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!values.hostname || !values["project-ref"] || !anonKey) {
    console.error("Nodig: --hostname, --project-ref en SUPABASE_ANON_KEY in de omgeving.");
    process.exit(2);
  }
  const rapport = await controleer({
    hostname: values.hostname,
    projectRef: values["project-ref"],
    anonKey,
    workersDev: values["workers-dev"],
    versieUrl: values["versie-url"],
    previewUrl: values["preview-url"],
    tabelZonderGrant: values.tabel,
    klantportaal: values.klantportaal,
  });
  console.log("| AE | Controle | Uitkomst | Bewijs |\n|---|---|---|---|");
  for (const r of rapport) console.log(regel(r));
  process.exit(rapport.some((r) => r.geslaagd === false) ? 1 : 0);
}
