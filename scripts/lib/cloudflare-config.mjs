import { readFileSync } from "node:fs";

/**
 * `wrangler.jsonc` beschrijft hoe deze app op Cloudflare draait. Het bestand is van het
 * project, want naam en adres verschillen per app, maar een paar regels gelden voor
 * elke app in deze stack:
 *
 *   - alleen de gebouwde bestanden, geen eigen Worker-code (`main`);
 *   - diepe links vallen terug op index.html (`single-page-application`);
 *   - elk adres staat achter Access. Er zijn twee standen:
 *       standaard: een eigen domein (`routes` met `custom_domain: true`), met Access
 *                  op dat domein;
 *       tijdelijk: geen `routes`, zolang de klant nog geen domein heeft.
 *     In beide standen staat `workers_dev: true`, met de Access op de Worker zelf (zie
 *     `beheer/`) ervoor. Zonder workers.dev tonen de previews per pull request achter
 *     Access alleen "There is nothing here yet" (vastgesteld bij finance, 15-10-2026).
 *   - alleen sleutels van de lijst hieronder, op het hoogste niveau en binnen elke
 *     `env.*`. Zo komt er geen opslag van Cloudflare in (D1, R2, KV, Durable Objects,
 *     of wat Cloudflare er later bij verzint): gegevens horen in Supabase.
 *
 * `preview_urls` staat aan voor de previews per pull request. Dat geldt voor de hele
 * Worker, dus ook voor elke productieversie; daarom zet de inrichting Access op de
 * Worker zelf (zie `beheer/`). Die dekt het workers.dev-adres en alle preview-adressen.
 */
const TOEGESTAAN = new Set([
  "$schema",
  "name",
  "compatibility_date",
  "compatibility_flags",
  "assets",
  "routes",
  "workers_dev",
  "preview_urls",
  "observability",
  "vars",
  "keep_vars",
  "env",
]);

/**
 * Binnen `env.<naam>` dezelfde lijst, zonder de sleutels die alleen bovenaan horen. Ook
 * `routes` en `workers_dev` horen alleen bovenaan: in een omgeving zouden ze een tweede
 * adres openen dat de controle van de standen hieronder niet ziet.
 */
const TOEGESTAAN_IN_ENV = new Set(
  [...TOEGESTAAN].filter(
    (sleutel) => !["$schema", "env", "routes", "workers_dev"].includes(sleutel),
  ),
);

/** Bekende opslag van Cloudflare zelf; die krijgt een eigen, duidelijke melding. */
const OPSLAG = new Set([
  "kv_namespaces",
  "d1_databases",
  "r2_buckets",
  "durable_objects",
  "queues",
  "vectorize",
  "hyperdrive",
  "workflows",
  "analytics_engine_datasets",
  "secrets_store_secrets",
]);

const STANDEN =
  "`workers_dev` staat altijd aan. Er zijn twee standen: de standaardstand (een route met `custom_domain: true`) " +
  "en de tijdelijke stand, alleen zolang er nog geen eigen domein is (geen `routes`).";

/** JSON met `//`- en `/* *\/`-commentaar, zoals wrangler.jsonc dat toestaat. */
function leesJsonc(tekst) {
  let uit = "";
  let inString = false;
  for (let i = 0; i < tekst.length; i++) {
    const teken = tekst[i];
    if (inString) {
      uit += teken;
      if (teken === "\\") {
        uit += tekst[++i] ?? "";
      } else if (teken === '"') {
        inString = false;
      }
    } else if (teken === '"') {
      inString = true;
      uit += teken;
    } else if (teken === "/" && tekst[i + 1] === "/") {
      while (i < tekst.length && tekst[i] !== "\n") i++;
      uit += "\n";
    } else if (teken === "/" && tekst[i + 1] === "*") {
      i += 2;
      while (i < tekst.length && !(tekst[i] === "*" && tekst[i + 1] === "/")) i++;
      i++;
    } else {
      uit += teken;
    }
  }
  return JSON.parse(uit.replace(/,(\s*[}\]])/g, "$1"));
}

function fout(melding) {
  throw new Error(`wrangler.jsonc: ${melding}`);
}

function isObject(waarde) {
  return typeof waarde === "object" && waarde !== null && !Array.isArray(waarde);
}

/** De meldingen voor elke sleutel die niet op de lijst staat, met het pad erbij. */
function sleutelFouten(object, toegestaan, padVoorvoegsel) {
  const fouten = [];
  for (const sleutel of Object.keys(object)) {
    if (toegestaan.has(sleutel)) continue;
    const pad = `\`${padVoorvoegsel}${sleutel}\``;
    if (sleutel === "main") {
      fouten.push(
        `${pad} hoort er niet in: deze stack serveert alleen de gebouwde bestanden, zonder Worker-code.`,
      );
    } else if (OPSLAG.has(sleutel)) {
      fouten.push(`${pad} hoort er niet in: gegevens staan in Supabase, niet bij Cloudflare.`);
    } else {
      fouten.push(
        `${pad} staat niet op de lijst van toegestane sleutels. Deze stack serveert alleen de gebouwde bestanden en gegevens staan in Supabase; is deze sleutel echt nodig, meld het dan bij Stage Two.`,
      );
    }
  }
  return fouten;
}

/**
 * Leest en controleert wrangler.jsonc. Geeft de Worker-naam en de stand terug, en in de
 * standaardstand het eigen domein (in de tijdelijke stand is `hostname` null: het
 * workers.dev-adres hangt af van het subdomein van het account).
 */
export function cloudflareConfig(pad = "wrangler.jsonc") {
  let tekst;
  try {
    tekst = readFileSync(pad, "utf8");
  } catch (oorzaak) {
    const ontbreekt = oorzaak?.code === "ENOENT";
    fout(
      ontbreekt
        ? `het bestand ${pad} ontbreekt. Elke app in deze stack draait op Cloudflare en heeft het nodig.`
        : `het bestand ${pad} is niet te lezen (${oorzaak?.code ?? oorzaak?.message}).`,
    );
  }
  let config;
  try {
    config = leesJsonc(tekst);
  } catch (oorzaak) {
    fout(`het bestand ${pad} is geen geldige JSON: ${oorzaak?.message}`);
  }
  if (!isObject(config)) fout("het bestand hoort één object te bevatten.");

  if (typeof config.name !== "string" || config.name === "") fout("`name` ontbreekt.");

  const fouten = sleutelFouten(config, TOEGESTAAN, "");
  if (config.env !== undefined) {
    if (!isObject(config.env)) fouten.push("`env` hoort een object met omgevingen te zijn.");
    else {
      for (const [naam, omgeving] of Object.entries(config.env)) {
        if (!isObject(omgeving)) fouten.push(`\`env.${naam}\` hoort een object te zijn.`);
        else fouten.push(...sleutelFouten(omgeving, TOEGESTAAN_IN_ENV, `env.${naam}.`));
      }
    }
  }
  if (fouten.length) fout(fouten.join("\n  "));

  if (config.assets?.not_found_handling !== "single-page-application") {
    fout(
      '`assets.not_found_handling` moet "single-page-application" zijn, anders werken diepe links niet.',
    );
  }

  const routes = config.routes ?? [];
  if (!Array.isArray(routes)) fout("`routes` hoort een lijst te zijn.");
  if (config.workers_dev !== true) {
    fout(
      config.workers_dev === false
        ? `\`workers_dev\` staat uit. Dan tonen de previews per pull request achter Access alleen "There is nothing here yet". Zet hem op true; de Access op de Worker bewaakt dat adres. ${STANDEN}`
        : `\`workers_dev\` ontbreekt; zet hem expliciet op true, zodat de previews werken. ${STANDEN}`,
    );
  }
  if (routes.length === 0) return { worker: config.name, stand: "tijdelijk", hostname: null };
  if (routes.length > 1) {
    fout(
      `er staan ${routes.length} routes in, maar de standaardstand heeft precies één route: het eigen domein. ` +
        `Access beschermt alleen dat domein, dus elke extra route (een tweede domein of een zone-route) staat open. ${STANDEN}`,
    );
  }
  const domein = routes[0];
  if (domein?.custom_domain !== true || typeof domein.pattern !== "string" || !domein.pattern) {
    fout(
      `er staat geen route met \`custom_domain: true\` in, dus de app heeft geen adres. ${STANDEN}`,
    );
  }
  return { worker: config.name, stand: "standaard", hostname: domein.pattern };
}
