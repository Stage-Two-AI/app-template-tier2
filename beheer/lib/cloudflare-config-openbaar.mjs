import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * `wrangler.jsonc` beschrijft hoe deze app op Cloudflare draait. Het bestand is van het
 * project, want naam en adres verschillen per app, maar een paar regels gelden voor
 * elke app uit deze template:
 *
 *   - één Worker: de servercode in `workers/app.ts` (`main`) maakt elke pagina, de
 *     gebouwde bestanden (scripts, stijl, iconen) staan ernaast. De build regelt die
 *     bestanden zelf; een onbekend adres gaat naar de server, die een echte 404 geeft
 *     (dus geen `single-page-application`);
 *   - twee standen voor de adressen:
 *       standaard: een eigen domein (`routes` met `custom_domain: true`). In deze template
 *                  staat dat domein open (een klantportaal: de database is de grens);
 *       tijdelijk: geen `routes`, zolang de klant nog geen domein heeft.
 *     In beide standen staat `workers_dev: true`, met de Access op de Worker zelf (die zet
 *     de beheer-repo) ervoor. Zonder workers.dev tonen de previews per pull request achter
 *     Access alleen "There is nothing here yet" (vastgesteld bij finance, 15-10-2026).
 *   - alleen sleutels van de lijst hieronder, op het hoogste niveau en binnen elke
 *     `env.*`. Zo komt er geen opslag van Cloudflare in (D1, R2, KV, Durable Objects,
 *     of wat Cloudflare er later bij verzint): gegevens horen in Supabase.
 *   - in `vars` alleen wat openbaar mag zijn (de lijst OPENBARE_VARS). Het bestand staat
 *     in git en de servercode kan elke variabele lezen; een geheime sleutel hoort in een
 *     Supabase Edge Function.
 *
 * `preview_urls` staat aan voor de previews per pull request. Dat geldt voor de hele
 * Worker, dus ook voor elke productieversie; daarom zet de inrichting Access op de
 * Worker zelf. Die dekt het workers.dev-adres en alle preview-adressen.
 */
/**
 * De lijst van wat MAG, per niveau. Elke sleutel heeft een controle van zijn waarde; een
 * sleutel die hier niet staat, wordt geweigerd. Zo komt er niets in wat niemand heeft
 * bekeken: geen opslag, geen koppeling met een andere Worker, geen plek waar logregels
 * heen gaan, geen tweede omgeving met een eigen naam.
 *
 * Bewust niet op de lijst: `env` (de uitrol kent geen omgevingen; de testomgeving is de
 * preview) en `keep_vars` (dat laat variabelen staan die iemand in het dashboard heeft
 * gezet, buiten git om).
 */
const isTekst = (w) => typeof w === "string" && w !== "";
const isBool = (w) => typeof w === "boolean";
const isGetal = (w) => typeof w === "number" && Number.isFinite(w);

/** Instellingen van de Workers-omgeving die niets openzetten. */
const VLAGGEN = new Set(["nodejs_compat", "nodejs_als", "global_fetch_strictly_public"]);

/** Binnen `observability`: aan of uit en hoeveel; geen `destinations` (logregels naar elders). */
const OBSERVABILITY = {
  enabled: isBool,
  head_sampling_rate: isGetal,
  logs: (w) =>
    alleenSleutels(w, {
      enabled: isBool,
      head_sampling_rate: isGetal,
      invocation_logs: isBool,
      persist: isBool,
    }),
};

/** Binnen `assets`: alleen dat een onbekend adres naar de server gaat. Geen `binding`. */
const ASSETS = { not_found_handling: (w) => w === "none" };

const TOEGESTAAN = {
  $schema: isTekst,
  name: (w) => typeof w === "string" && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(w),
  main: isTekst,
  compatibility_date: (w) => typeof w === "string" && /^\d{4}-\d{2}-\d{2}$/.test(w),
  compatibility_flags: (w) => Array.isArray(w) && w.every((vlag) => VLAGGEN.has(vlag)),
  assets: (w) => alleenSleutels(w, ASSETS),
  routes: Array.isArray,
  workers_dev: isBool,
  preview_urls: isBool,
  observability: (w) => alleenSleutels(w, OBSERVABILITY),
  vars: isObject,
};

/** Is `waarde` een object met alleen sleutels van de lijst, elk met een goede waarde? */
function alleenSleutels(waarde, lijst) {
  return (
    isObject(waarde) &&
    Object.entries(waarde).every(
      ([sleutel, w]) => Object.hasOwn(lijst, sleutel) && lijst[sleutel](w),
    )
  );
}

/** Waar de servercode staat; `./` ervoor mag. */
const MAIN = "workers/app.ts";

/**
 * De variabelen die in `vars` mogen: dezelfde openbare waarden die ook in de bundel van de
 * browser staan (zie src/lib/env.ts). Al het andere is een geheim, of wordt het vroeg of laat.
 */
const OPENBARE_VARS = new Set([
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_SCHEMA",
  "VITE_OMGEVING",
  "VITE_INLOGDIENST",
  "VITE_SENTRY_DSN",
]);

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

/** De meldingen voor elke sleutel die niet op de lijst staat of een verkeerde waarde heeft. */
function sleutelFouten(config) {
  const fouten = [];
  for (const [sleutel, waarde] of Object.entries(config)) {
    const pad = `\`${sleutel}\``;
    if (Object.hasOwn(TOEGESTAAN, sleutel)) {
      if (!TOEGESTAAN[sleutel](waarde)) {
        fouten.push(
          sleutel === "assets"
            ? `${pad} mag alleen \`not_found_handling: "none"\` bevatten (of weg): een adres dat geen gebouwd bestand is, gaat naar de servercode, en die maakt de pagina (of een echte 404). De build regelt de bestanden zelf; een \`binding\` hoort er niet in.`
            : sleutel === "observability"
              ? `${pad} mag alleen aan of uit staan (\`enabled\`, \`head_sampling_rate\`, \`logs\`). Logregels naar een andere plek sturen (\`destinations\`) hoort er niet in.`
              : sleutel === "compatibility_flags"
                ? `${pad} mag alleen deze instellingen bevatten: ${[...VLAGGEN].join(", ")}.`
                : `${pad} heeft een waarde die hier niet past.`,
        );
      }
    } else if (sleutel === "env") {
      fouten.push(
        `${pad} hoort er niet in: de uitrol kent geen omgevingen. De testomgeving is de preview per pull request; een omgeving hier zou een tweede Worker met een eigen naam, adres of variabelen kunnen openen.`,
      );
    } else if (sleutel === "keep_vars") {
      fouten.push(
        `${pad} hoort er niet in: het laat variabelen staan die iemand buiten git om in het dashboard heeft gezet.`,
      );
    } else if (OPSLAG.has(sleutel)) {
      fouten.push(`${pad} hoort er niet in: gegevens staan in Supabase, niet bij Cloudflare.`);
    } else {
      fouten.push(
        `${pad} staat niet op de lijst van toegestane sleutels. Cloudflare maakt en serveert de pagina's en gegevens staan in Supabase; haal hem weg, en zoek met Claude in /stagetwo-tier2:verder-werken een weg zonder deze sleutel.`,
      );
    }
  }
  return fouten;
}

/** De meldingen voor elke variabele in `vars` die niet openbaar mag zijn of geen tekst is. */
function varsFouten(vars, bron = "") {
  if (vars === undefined) return [];
  if (!isObject(vars)) return [`\`vars\` hoort een object te zijn.`];
  const fouten = [];
  for (const [naam, waarde] of Object.entries(vars)) {
    if (!OPENBARE_VARS.has(naam)) {
      fouten.push(
        `\`vars.${naam}\` staat niet op de lijst van openbare variabelen (${[...OPENBARE_VARS].join(", ")}). ` +
          `${bron || "Dit bestand staat in git en de servercode kan elke variabele lezen"}; een geheime sleutel hoort in een Supabase Edge Function.`,
      );
    } else if (typeof waarde !== "string") {
      fouten.push(
        `\`vars.${naam}\` hoort een tekst te zijn. Een lijst of object kan van alles bevatten wat deze controle niet ziet.`,
      );
    }
  }
  return fouten;
}

/**
 * Een eigen domein: een gewone hostnaam. Geen jokerteken, geen pad, en nooit workers.dev
 * of de eigen computer: die adressen zijn geen productie.
 */
function isEigenDomein(pattern) {
  if (typeof pattern !== "string") return false;
  const naam = pattern.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(naam)) return false;
  if (naam === "workers.dev" || naam.endsWith(".workers.dev")) return false;
  if (naam === "localhost" || naam.endsWith(".localhost") || /^[0-9.]+$/.test(naam)) return false;
  return true;
}

/** Controleert een al gelezen wrangler.jsonc. Gooit bij de eerste groep fouten. */
function controleer(config) {
  if (!isObject(config)) fout("het bestand hoort één object te bevatten.");

  if (typeof config.name !== "string" || config.name === "") fout("`name` ontbreekt.");

  const fouten = [...sleutelFouten(config), ...varsFouten(config.vars)];
  if (fouten.length) fout(fouten.join("\n  "));

  if (typeof config.main !== "string" || config.main.replace(/^\.\//, "") !== MAIN) {
    fout(
      `\`main\` moet "./${MAIN}" zijn: daar staat de servercode die elke pagina maakt. Zonder \`main\` is er geen server en blijft elk adres leeg.`,
    );
  }

  const routes = config.routes ?? [];
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
  if (!isObject(domein) || domein.custom_domain !== true || !domein.pattern) {
    fout(
      `er staat geen route met \`custom_domain: true\` in, dus de app heeft geen adres. ${STANDEN}`,
    );
  }
  if (!alleenSleutels(domein, { pattern: isEigenDomein, custom_domain: (w) => w === true })) {
    fout(
      `de route "${String(domein.pattern)}" is geen eigen domein. Het hoort een gewone hostnaam te zijn (bijvoorbeeld "app.klant.nl"), zonder jokerteken of pad, en niet op workers.dev: dat adres is nooit productie. ${STANDEN}`,
    );
  }
  return { worker: config.name, stand: "standaard", hostname: domein.pattern.toLowerCase() };
}

function leesBestand(pad) {
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
  try {
    return leesJsonc(tekst);
  } catch (oorzaak) {
    fout(`het bestand ${pad} is geen geldige JSON: ${oorzaak?.message}`);
  }
}

/**
 * Leest en controleert wrangler.jsonc. Geeft de Worker-naam en de stand terug, en in de
 * standaardstand het eigen domein (in de tijdelijke stand is `hostname` null: het
 * workers.dev-adres hangt af van het subdomein van het account).
 */
export function cloudflareConfig(pad = "wrangler.jsonc") {
  return controleer(leesBestand(pad));
}

/** Leest wrangler.jsonc zonder te controleren (de controle is `cloudflareConfig`). */
export function leesWrangler(pad = "wrangler.jsonc") {
  return leesJsonc(readFileSync(pad, "utf8"));
}

/**
 * De config voor het uploaden van een preview, gemaakt uit de wrangler.jsonc van main: naam,
 * datum en variabelen komen daaruit, en alleen de al gebouwde code komt uit de pull request
 * (`main` en `assets.directory` wijzen naar de opgehaalde bestanden, `no_bundle`). De build
 * van de pull request levert zelf ook een config (dist/server/wrangler.json), maar die is
 * gemaakt uit de wrangler.jsonc van de pull request en wordt hier bewust niet gebruikt: zo
 * kan een pull request wel zijn eigen code laten zien, maar geen andere Worker kiezen en
 * niets aan de Worker koppelen.
 *
 * De naam blijft die van de app zelf: een preview is een versie van dezelfde Worker
 * (`pr-<nummer>-<worker>...workers.dev`), achter de Access op de Worker.
 */
export function previewConfig(config, { worker, assets }) {
  const uit = {
    name: config.name,
    main: worker,
    // De code is al gebouwd (pnpm build in de pull request); niet opnieuw bundelen, wel alle
    // losse stukken naast index.js meenemen.
    no_bundle: true,
    find_additional_modules: true,
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    compatibility_date: config.compatibility_date,
    ...(config.compatibility_flags ? { compatibility_flags: config.compatibility_flags } : {}),
    assets: { ...(config.assets ?? {}), directory: assets },
    workers_dev: true,
    preview_urls: true,
    ...(config.observability ? { observability: config.observability } : {}),
    ...(config.vars ? { vars: config.vars } : {}),
  };
  // Dezelfde regels als voor de gebouwde config van de uitrol, vlak voor het uploaden.
  const fouten = gebouwdFouten(uit, config, {
    main: worker,
    assets,
    routes: [],
    losseModules: true,
    configPad: undefined,
  });
  if (fouten.length) throw new Error(`preview-config: ${fouten.join("\n  ")}`);
  return uit;
}

/**
 * ---------------------------------------------------------------------------------------
 * De gebouwde config: wat er werkelijk wordt uitgerold.
 *
 * `wrangler.jsonc` is niet wat Cloudflare krijgt. De build maakt er een nieuwe config van
 * (dist/server/wrangler.json), en de plugin van Cloudflare kan daar vanuit `vite.config.ts`
 * (een bestand van het project) van alles aan toevoegen: een database, een koppeling met
 * een andere Worker, variabelen. Daarom gelden dezelfde regels voor het gebouwde bestand,
 * en rolt de uitrol precies dat gecontroleerde bestand uit.
 *
 * De gebouwde config noemt elke soort koppeling die wrangler kent, leeg. De regel is
 * daarom: een sleutel die hieronder niet met een verwachte waarde staat, moet leeg zijn.
 * Verzint Cloudflare er een soort bij, dan valt die daar vanzelf onder.
 * ---------------------------------------------------------------------------------------
 */
export const GEBOUWD = "dist/server/wrangler.json";
const DOORVERWIJZING = ".wrangler/deploy/config.json";

/** Leeg: niets, onwaar, een lege lijst, of een object met alleen lege waarden. */
function isLeeg(waarde) {
  if (waarde === undefined || waarde === null || waarde === false || waarde === "") return true;
  if (Array.isArray(waarde)) return waarde.length === 0;
  if (isObject(waarde)) return Object.values(waarde).every(isLeeg);
  return false;
}

function gelijk(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Sleutels die alleen iets zeggen over bouwen of lokaal draaien, niet over wat er draait. */
const ONSCHULDIG = new Set([
  "$schema",
  "jsx_factory",
  "jsx_fragment",
  "upload_source_maps",
  "dev",
  "python_modules",
]);

const REGELS_VOOR_MODULES = [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }];

/**
 * Controleert een config die naar Cloudflare gaat tegen wat wrangler.jsonc zegt. `verwacht`
 * zegt waar de code en de bestanden staan (voor de uitrol relatief, voor een preview een
 * volledig pad). Geeft de lijst met meldingen terug; leeg is goed.
 */
export function gebouwdFouten(config, bron, verwacht) {
  if (!isObject(config)) return ["de gebouwde config hoort één object te bevatten."];
  const assets = { directory: verwacht.assets };
  if (bron.assets?.not_found_handling) assets.not_found_handling = "none";
  const exact = {
    name: bron.name,
    topLevelName: bron.name,
    main: verwacht.main,
    compatibility_date: bron.compatibility_date,
    compatibility_flags: bron.compatibility_flags ?? [],
    workers_dev: true,
    preview_urls: bron.preview_urls,
    routes: verwacht.routes,
    assets,
    no_bundle: true,
    rules: REGELS_VOOR_MODULES,
    observability: bron.observability,
    find_additional_modules: verwacht.losseModules,
    configPath: verwacht.configPad,
    userConfigPath: verwacht.configPad,
  };
  const fouten = [];
  for (const [sleutel, waarde] of Object.entries(config)) {
    if (ONSCHULDIG.has(sleutel)) continue;
    if (sleutel === "vars") {
      fouten.push(
        ...varsFouten(
          waarde,
          "De servercode kan elke variabele lezen en de gebouwde config gaat zo naar Cloudflare",
        ),
      );
      continue;
    }
    if (Object.hasOwn(exact, sleutel)) {
      const hoort = exact[sleutel];
      // Wat wrangler.jsonc niet noemt, mag in de gebouwde config ontbreken of leeg zijn.
      const goed =
        hoort === undefined || isLeeg(hoort)
          ? isLeeg(waarde) || gelijk(waarde, hoort)
          : gelijk(waarde, hoort);
      if (!goed) {
        fouten.push(
          `\`${sleutel}\` is ${JSON.stringify(waarde)}, maar hoort ${JSON.stringify(hoort ?? null)} te zijn: dat volgt uit wrangler.jsonc. Iets in de build (vite.config.ts) heeft het veranderd.`,
        );
      }
      continue;
    }
    if (!isLeeg(waarde)) {
      fouten.push(
        OPSLAG.has(sleutel)
          ? `\`${sleutel}\` is niet leeg: gegevens staan in Supabase, niet bij Cloudflare. Het staat niet in wrangler.jsonc, dus de build (vite.config.ts) heeft het toegevoegd.`
          : `\`${sleutel}\` is niet leeg (${JSON.stringify(waarde).slice(0, 120)}). Het staat niet in wrangler.jsonc, dus de build (vite.config.ts) heeft het toegevoegd; een koppeling of instelling buiten wrangler.jsonc om hoort er niet in.`,
      );
    }
  }
  for (const sleutel of ["name", "main", "workers_dev", "no_bundle", "assets"]) {
    if (!Object.hasOwn(config, sleutel)) fouten.push(`\`${sleutel}\` ontbreekt.`);
  }
  return fouten;
}

/** Alle bestanden onder een map, als paden vanaf die map. */
function bestandenIn(map, vanaf = map, uit = []) {
  for (const naam of readdirSync(map)) {
    const pad = join(map, naam);
    if (statSync(pad).isDirectory()) bestandenIn(pad, vanaf, uit);
    else uit.push(relative(vanaf, pad).split("\\").join("/"));
  }
  return uit;
}

/**
 * De regel in public/_headers die elk adres op workers.dev (het hoofdadres en de previews)
 * uit zoekmachines houdt, ook voor de bestanden die Cloudflare zonder de servercode
 * serveert. Voor pagina's doet de servercode hetzelfde (src/lib/server/).
 */
export const HEADERS_WORKERS_DEV =
  "https://:versie.:subdomein.workers.dev/*\n  X-Robots-Tag: noindex, nofollow";

/**
 * De gebouwde bestanden die Cloudflare zonder de servercode serveert (dist/client). Daar
 * hoort niets tussen wat om de servercode heen een pagina of een regel voor zoekmachines
 * neerzet: de server maakt elke pagina en bepaalt wat een zoekmachine mag.
 */
export function bestandFouten(map = "dist/client") {
  if (!existsSync(map)) return [`de map ${map} ontbreekt; draai \`pnpm build\`.`];
  const fouten = [];
  for (const pad of bestandenIn(map)) {
    const naam = pad.split("/").at(-1) ?? pad;
    if (naam === "robots.txt") {
      fouten.push(
        `${map}/${pad}: een vast robots.txt (uit public/) geldt ook op workers.dev en de previews. De servercode maakt robots.txt zelf: dicht op elk adres dat niet het echte domein is.`,
      );
    } else if (/\.html?$/i.test(naam) || /\.data$/i.test(naam)) {
      fouten.push(
        `${map}/${pad}: een kant-en-klare pagina (uit public/ of \`prerender\`) gaat om de servercode heen, dus zonder de cacheregel, de beveiligingsheaders en noindex. De server maakt elke pagina.`,
      );
    } else if (naam === "_redirects") {
      fouten.push(`${map}/${pad}: omleidingen horen in de servercode, niet in een los bestand.`);
    }
  }
  const headers = join(map, "_headers");
  const tekst = existsSync(headers) ? readFileSync(headers, "utf8") : "";
  const regels = tekst
    .split("\n")
    .map((regel) => regel.trimEnd())
    .filter((regel) => regel.trim() !== "" && !regel.trim().startsWith("#"));
  if (regels.join("\n") !== HEADERS_WORKERS_DEV) {
    fouten.push(
      `${map}/_headers (uit public/_headers) hoort precies deze ene regel te bevatten, plus commentaar:\n    ${HEADERS_WORKERS_DEV.replace("\n", "\n    ")}\n  Die houdt workers.dev en de previews uit zoekmachines. Andere headers zet de servercode.`,
    );
  }
  return fouten;
}

/**
 * Controleert alles wat de build heeft gemaakt en wat naar Cloudflare gaat: de gebouwde
 * config, de doorverwijzing ernaartoe, en de gebouwde bestanden. Gooit met alle meldingen.
 */
export function gebouwdeConfig() {
  const fouten = [];
  for (const ander of ["wrangler.json", "wrangler.toml"]) {
    if (existsSync(ander)) {
      fouten.push(
        `${ander} bestaat naast wrangler.jsonc. Wrangler kiest dan zelf welke hij leest; er hoort er één te zijn: wrangler.jsonc.`,
      );
    }
  }
  const bron = leesBestand("wrangler.jsonc");
  controleer(bron);
  if (!existsSync(GEBOUWD)) {
    throw new Error(
      `${GEBOUWD} ontbreekt: de build heeft geen config gemaakt op de vaste plek. Draai \`pnpm build\`; staat de uitvoer ergens anders, dan is de build (vite.config.ts of react-router.config.ts) omgezet.`,
    );
  }
  let gebouwd;
  try {
    gebouwd = JSON.parse(readFileSync(GEBOUWD, "utf8"));
  } catch (oorzaak) {
    throw new Error(`${GEBOUWD} is geen geldige JSON: ${oorzaak?.message}`);
  }
  // Hetzelfde bestand kan onder twee namen bekend zijn (een koppeling in het pad); vergelijk
  // daarom waar de paden werkelijk op uitkomen.
  const echt = (pad) => {
    try {
      return realpathSync(pad);
    } catch {
      return pad;
    }
  };
  for (const sleutel of ["configPath", "userConfigPath"]) {
    if (typeof gebouwd[sleutel] === "string") gebouwd[sleutel] = echt(gebouwd[sleutel]);
  }
  fouten.push(
    ...gebouwdFouten(gebouwd, bron, {
      main: "index.js",
      assets: "../client",
      routes: bron.routes ?? [],
      losseModules: undefined,
      configPad: echt(resolve("wrangler.jsonc")),
    }).map((melding) => `${GEBOUWD}: ${melding}`),
  );
  if (existsSync(DOORVERWIJZING)) {
    let door;
    try {
      door = JSON.parse(readFileSync(DOORVERWIJZING, "utf8"));
    } catch {
      door = null;
    }
    const doel =
      isObject(door) && typeof door.configPath === "string"
        ? resolve(".wrangler/deploy", door.configPath)
        : null;
    if (doel === null || echt(doel) !== echt(resolve(GEBOUWD))) {
      fouten.push(
        `${DOORVERWIJZING} wijst niet naar ${GEBOUWD}: wrangler zou dan een andere config uitrollen dan de gecontroleerde.`,
      );
    }
    if (
      isObject(door) &&
      Object.entries(door).some(([sleutel, w]) => sleutel !== "configPath" && !isLeeg(w))
    ) {
      fouten.push(
        `${DOORVERWIJZING} noemt meer dan deze ene Worker (bijvoorbeeld \`auxiliaryWorkers\`). Een app is precies één Worker.`,
      );
    }
  }
  fouten.push(...bestandFouten());
  if (fouten.length) throw new Error(fouten.join("\n  "));
  return { worker: bron.name, config: GEBOUWD };
}
