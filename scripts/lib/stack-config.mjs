import { readFileSync } from "node:fs";

/**
 * De keuzes uit `stack.config.json`, met een standaard voor projecten die dat
 * bestand nog niet hebben. Die standaard is bewust `database: true`: een bestaand
 * project dat op deze versie van de stack overstapt, moet niet ineens zijn
 * migraties en RLS-controles kwijtraken omdat er een bestand ontbreekt.
 *
 * Voor een níeuw project zet `bin/nieuw-project.sh` hem juist op `false`, want daar
 * is "geen database tenzij" de bedoelde standaard.
 */
const STANDAARD = { database: true };

/**
 * De drie standen van `database`, vertaald naar één woord waar de rest van de
 * stack op stuurt:
 *
 *   "geen"     de app heeft geen database
 *   "gedeeld"  de app gebruikt de database van een ándere app, via haar contract
 *              (het schema `api`). Deze repo bezit dat schema niet en wijzigt het
 *              nooit: geen migraties, geen deploy, geen RLS-tests.
 *   "eigen"    de app bezit haar eigen database en dus ook het schema
 *
 * Het onderscheid tussen "gedeeld" en "eigen" is de belangrijkste regel van de
 * hele databaselaag: **precies één repo mag naar een database schrijven.** Twee
 * repo's die allebei migraties pushen naar hetzelfde Supabase-project lopen vast,
 * want Supabase houdt de toegepaste migraties bij in de database zelf en de tweede
 * repo kent de bestanden van de eerste niet.
 */
export function stackConfig() {
  try {
    const gelezen = JSON.parse(readFileSync("stack.config.json", "utf8"));
    return { ...STANDAARD, ...gelezen };
  } catch {
    return STANDAARD;
  }
}

export function databaseModus() {
  const waarde = stackConfig().database;
  if (waarde === false) return "geen";
  if (waarde === true) return "eigen";
  if (waarde === "gedeeld") return "gedeeld";
  throw new Error(
    `stack.config.json: "database" is ${JSON.stringify(waarde)}, en dat is geen geldige stand.\n` +
      'Kies uit: false (geen database), "gedeeld" (gebruikt de database van een andere app), true (eigen database).',
  );
}

/** Praat deze app met een database? Waar bij zowel "gedeeld" als "eigen". */
export function heeftDatabase() {
  return databaseModus() !== "geen";
}

/**
 * Bezit deze repo het databaseschema? Alleen waar bij "eigen". Dit is de vraag die
 * telt voor alles wat schríjft: migraties, de deploy-workflow en de RLS-guards.
 */
export function bezitDatabase() {
  return databaseModus() === "eigen";
}

/**
 * De gegevens van de gedeelde database: van wie hij is, en welk Supabase-project
 * het betreft. De project-ref is geen geheim (hij staat in de URL van elk verzoek),
 * dus die mag gewoon in de config staan.
 */
export function gedeeldeDatabase() {
  if (databaseModus() !== "gedeeld") return null;
  const config = stackConfig().gedeelde_database;
  if (!config?.project_ref) {
    throw new Error(
      'stack.config.json: bij `"database": "gedeeld"` hoort een blok `gedeelde_database`\n' +
        "met minstens `project_ref`, en bij voorkeur ook `eigenaar` (de repo die het schema bezit).\n" +
        "Voorbeeld:\n" +
        '  "gedeelde_database": { "eigenaar": "Klant-Org/erp", "project_ref": "abcdefghijklmnop" }',
    );
  }
  return { eigenaar: config.eigenaar ?? "onbekend", project_ref: config.project_ref };
}

/**
 * De testdatabase: een tweede Supabase-project, los van productie, waar de
 * Cloudflare-preview naar wijst en waar je lokaal tegenaan mag kijken. Alleen zinvol
 * als de app met een database praat. Optioneel: ontbreekt het blok, dan is er
 * geen testdatabase en gebruikt de preview wat er in de GitHub-omgeving `preview` staat.
 *
 *   "testdatabase": { "project_ref": "abcdefghijklmnopqrst", "anon_key": "sb_publishable_..." }
 *
 * De project-ref is geen geheim (hij staat in de URL van elk verzoek), en de anon key
 * (publishable key) evenmin: die zit al in de bundel van elke preview en wordt door RLS
 * beschermd. Staat hij hier, dan kan de preview op de computer van de gebruiker zonder
 * login bij Supabase met de testdatabase praten (`scripts/preview.mjs`). Het
 * databasewachtwoord van dit project is dat wél; dat staat als Actions-secret
 * SUPABASE_TEST_DB_PASSWORD en wordt alleen gebruikt om migraties er als eerste
 * op te draaien (de canary in deploy-db.yml).
 */
export function testDatabase() {
  if (!heeftDatabase()) return null;
  const config = stackConfig().testdatabase;
  if (!config) return null;
  if (!/^[a-z]{20}$/.test(config.project_ref ?? "")) {
    throw new Error(
      "stack.config.json: het blok `testdatabase` hoort een `project_ref` te hebben van twintig\n" +
        "kleine letters, zoals in de URL van het Supabase-project (https://<ref>.supabase.co).\n" +
        'Voorbeeld:\n  "testdatabase": { "project_ref": "abcdefghijklmnopqrst" }',
    );
  }
  const anonKey = config.anon_key ?? null;
  if (
    anonKey !== null &&
    !/^(?:sb_publishable_[\w-]{10,}|eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{5,})$/.test(anonKey)
  ) {
    throw new Error(
      "stack.config.json: `testdatabase.anon_key` hoort de publieke sleutel van het testproject te zijn\n" +
        "(sb_publishable_... of de anon-JWT). Een geheime sleutel (sb_secret_..., service_role) hoort\n" +
        "hier nooit; die staat alleen als secret in GitHub.",
    );
  }
  return {
    project_ref: config.project_ref,
    url: `https://${config.project_ref}.supabase.co`,
    anon_key: anonKey,
  };
}

/**
 * Tabellen die bewust open staan voor iedereen die binnen is: een policy met `using (true)`
 * of `with check (true)` voor `authenticated` (of een eigen rol) mag daar, en de A/B-test
 * per tabel (guard-rls-tests.mjs) hoeft daar niet. Per tabel een reden, zodat de keuze
 * zichtbaar in de repo staat en de reviewer hem in de PR ziet:
 *
 *   "open_tabellen": { "feestdagen": "kalender voor iedereen binnen, geen persoonsgegevens" }
 *
 * Een open policy voor `anon` of `public` (iedereen met de openbare sleutel) mag nooit, ook
 * niet als de tabel hier staat.
 */
export function openTabellen() {
  const lijst = stackConfig().open_tabellen ?? {};
  if (typeof lijst !== "object" || Array.isArray(lijst) || lijst === null) {
    throw new Error(
      "stack.config.json: `open_tabellen` hoort een object te zijn met per tabel een reden.\n" +
        'Voorbeeld:\n  "open_tabellen": { "feestdagen": "kalender voor iedereen binnen" }',
    );
  }
  for (const [tabel, reden] of Object.entries(lijst)) {
    if (typeof reden !== "string" || reden.trim() === "") {
      throw new Error(
        `stack.config.json: bij open_tabellen.${tabel} hoort een reden (waarom mag iedereen binnen dit zien?).`,
      );
    }
  }
  return lijst;
}

/**
 * Rollen waarmee een ándere app deze database leest (bijvoorbeeld `intern_lezer` op een
 * datalake). Zo'n rol mag alleen lezen: elke `grant insert|update|delete` aan een rol in
 * deze lijst is rood in de poort. Schrijven gaat via een functie in de app die de database
 * beheert.
 *
 *   "leesrollen": ["intern_lezer"]
 */
export function leesRollen() {
  const lijst = stackConfig().leesrollen ?? [];
  if (!Array.isArray(lijst) || lijst.some((r) => typeof r !== "string" || !/^\w+$/.test(r))) {
    throw new Error(
      'stack.config.json: `leesrollen` hoort een lijst namen van rollen te zijn, bijvoorbeeld ["intern_lezer"].',
    );
  }
  return lijst.map((r) => r.toLowerCase());
}
