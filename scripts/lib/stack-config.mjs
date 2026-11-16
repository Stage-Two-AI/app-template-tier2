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

/** Zo kort mag een reden in een lijst van het klantportaal hoogstens niet zijn. */
export const KORTSTE_REDEN = 8;

/**
 * Wat er mis is met een lijst namen met per naam een reden (de lijsten van het klantportaal).
 * Leeg als alles klopt. Dezelfde toets draait in guard:rls (via `klantportaal()`) en in de
 * databasecontrole (scripts/lib/klantportaal-database.mjs), zodat een lege reden of een naam
 * die op iets anders past dan bedoeld, ook daar rood is.
 *
 * `soort` is "naam" (een functie, view of tabel) of "openbaar" (ook `bucket:<id>`).
 */
export function problemenMetNamenMetReden(sleutel, lijst, soort = "naam") {
  if (lijst === undefined) return [];
  if (typeof lijst !== "object" || Array.isArray(lijst) || lijst === null) {
    return [`\`${sleutel}\` hoort een object te zijn met per naam een reden`];
  }
  const patroon = soort === "openbaar" ? OPENBARE_NAAM : NAAM;
  const problemen = [];
  for (const [naam, reden] of Object.entries(lijst)) {
    if (!patroon.test(naam)) {
      problemen.push(
        `${sleutel}.${naam} is geen naam die de poort kent. Schrijf de naam van een functie, view of tabel in kleine letters, zonder haakjes, aanhalingstekens of jokertekens, met het schema ervoor als het niet public is (bijvoorbeeld api.zoek_product)`,
      );
    }
    if (typeof reden !== "string" || reden.trim() === "") {
      problemen.push(`bij ${sleutel}.${naam} hoort een reden (waarom mag dit?)`);
    } else if (reden.trim().length < KORTSTE_REDEN) {
      problemen.push(
        `de reden bij ${sleutel}.${naam} is te kort ("${reden.trim()}"); schrijf in een paar woorden waarom dit mag`,
      );
    }
  }
  return problemen;
}

/** Een lijst namen met per naam een reden (de lijsten van het klantportaal). */
function namenMetReden(sleutel, voorbeeld, soort = "naam") {
  const lijst = stackConfig()[sleutel] ?? {};
  const problemen = problemenMetNamenMetReden(sleutel, lijst, soort);
  if (problemen.length > 0) {
    throw new Error(
      `stack.config.json: ${problemen.join(";\n")}.\nVoorbeeld:\n  "${sleutel}": ${voorbeeld}`,
    );
  }
  return lijst;
}

/** Een naam in de database: `naam` (in public) of `schema.naam`. */
const NAAM = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/;
/** Als NAAM, of `bucket:<id>` voor een openbare bucket in Supabase Storage. */
const OPENBARE_NAAM = /^(?:bucket:[A-Za-z0-9_.-]+|(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)$/;

/**
 * De sleutels die stack.config.json kent: die van de template en die de plugin schrijft. Een
 * sleutel die met `$` begint, is uitleg. Een andere sleutel is een tikfout, en een tikfout in een
 * schakelaar (`klantPortaal`) zet hem anders stil uit.
 */
export const BEKENDE_SLEUTELS = [
  "database",
  "gedeelde_database",
  "testdatabase",
  "testmail",
  "open_tabellen",
  "leesrollen",
  "klantportaal",
  "klantportaal_poorten",
  "klantportaal_vrije_functies",
  "klantportaal_openbaar",
];

/** Hoeveel letters `a` en `b` verschillen (toevoegen, weghalen of vervangen). */
function afstand(a, b) {
  const rij = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let vorige = rij[0];
    rij[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const bewaard = rij[j];
      rij[j] = Math.min(rij[j] + 1, rij[j - 1] + 1, vorige + (a[i - 1] === b[j - 1] ? 0 : 1));
      vorige = bewaard;
    }
  }
  return rij[b.length];
}

/**
 * De sleutels in stack.config.json die de stack niet kent, elk met de dichtstbijzijnde bekende.
 * Leeg als alles klopt.
 */
export function onbekendeSleutels(config = stackConfig()) {
  const uit = [];
  for (const sleutel of Object.keys(config)) {
    if (sleutel.startsWith("$") || BEKENDE_SLEUTELS.includes(sleutel)) continue;
    const kaal = sleutel
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    const dichtst = [...BEKENDE_SLEUTELS].sort(
      (a, b) => afstand(kaal, a.replace(/_/g, "")) - afstand(kaal, b.replace(/_/g, "")),
    )[0];
    uit.push({ sleutel, dichtst });
  }
  return uit;
}

/**
 * Is deze app een klantportaal: een app zonder deur van Cloudflare, waar klanten met een code
 * per mail inloggen? Dan is "ingelogd" iedereen op internet met een e-mailadres, en mag wie
 * alleen een e-mailadres heeft niets, tenzij het met een reden is vrijgegeven. De sluitende
 * controle staat in scripts/lib/klantportaal-database.mjs (op de database, in de
 * Kwaliteitspoort); guard-rls.mjs controleert de tekst van de migraties al eerder.
 *
 *   "klantportaal": true
 *
 * Standaard uit: dan verandert er niets. Drie lijsten horen erbij, alle drie optioneel en
 * alle drie met per naam een reden die de reviewer in de pull request ziet:
 *
 *   "klantportaal_poorten": { "is_inkoper": "medewerker van de afdeling inkoop" }
 *       eigen poorten: functies die in een policy als poort tellen. Zo'n functie is
 *       `language sql` en geeft één uitdrukking terug met public.is_medewerker() of
 *       public.is_goedgekeurde_klant() als harde eis; wat hij verder doet, is de zorg van de app.
 *   "klantportaal_vrije_functies": { "meld_storing": "mag iedereen met een account" }
 *       `security definer`-functies en views zonder security_invoker die iemand zonder
 *       goedkeuring mag gebruiken.
 *   "klantportaal_openbaar": { "producten": "de catalogus is openbaar", "bucket:logo": "het logo" }
 *       wat bezoekers ZONDER account mogen: een tabel of view (dan mag een policy `to anon`),
 *       een functie (dan mag anon hem uitvoeren), of een bucket in Storage met public = true.
 *
 * Geeft null als de app geen klantportaal is. Een klantportaal moet een eigen database hebben.
 */
export function klantportaal() {
  const waarde = stackConfig().klantportaal;
  if (waarde === undefined || waarde === false) return null;
  if (waarde !== true) {
    throw new Error(
      `stack.config.json: "klantportaal" is ${JSON.stringify(waarde)}; kies true of false.`,
    );
  }
  const modus = databaseModus();
  if (modus !== "eigen") {
    throw new Error(
      `stack.config.json: "klantportaal": true hoort bij een eigen database ("database": true), maar hier staat "database": ${JSON.stringify(stackConfig().database)}.\n` +
        "Een klantportaal leunt op de regels in zijn eigen database; zonder eigen database is er niets dat de poort bewaakt.",
    );
  }
  return {
    poorten: namenMetReden("klantportaal_poorten", '{ "is_inkoper": "medewerker van inkoop" }'),
    vrijeFuncties: namenMetReden(
      "klantportaal_vrije_functies",
      '{ "meld_storing": "mag iedereen met een account" }',
    ),
    openbaar: namenMetReden(
      "klantportaal_openbaar",
      '{ "producten": "de catalogus is voor iedereen", "bucket:logo": "het logo" }',
      "openbaar",
    ),
    openTabellen: openTabellen(),
  };
}

/**
 * De schakelaar zoals de RLS-tests hem lezen: streng, zonder stil overslaan. Een onbekende
 * sleutel, een afwijkende waarde (`"true"`, 1), een lijst die niet klopt of een bestand dat geen
 * JSON is, is een fout (die gooit deze functie). Zonder bestand of zonder de schakelaar:
 * `{ aan: false }`, precies zoals een gewone app.
 */
export function klantportaalStreng() {
  let tekst;
  try {
    tekst = readFileSync("stack.config.json", "utf8");
  } catch (fout) {
    if (fout?.code === "ENOENT") return { aan: false };
    throw new Error(`stack.config.json is niet te lezen: ${fout?.message ?? fout}`);
  }
  let config;
  try {
    config = JSON.parse(tekst);
  } catch (fout) {
    throw new Error(`stack.config.json is geen geldige JSON: ${fout?.message ?? fout}`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("stack.config.json hoort één object te zijn, met per keuze een sleutel.");
  }
  const onbekend = onbekendeSleutels(config);
  if (onbekend.length > 0) {
    throw new Error(
      `stack.config.json heeft een sleutel die de stack niet kent: ${onbekend
        .map(({ sleutel, dichtst }) => `"${sleutel}" (bedoel je "${dichtst}"?)`)
        .join(", ")}. Een tikfout zet een schakelaar anders stil uit.`,
    );
  }
  const portaal = klantportaal();
  return portaal === null ? { aan: false } : { aan: true, config: portaal };
}

/** Een naam uit een lijst van het klantportaal, voluit: `public.x` voor `x`, `bucket:` blijft. */
export function voluit(naam) {
  return naam.startsWith("bucket:") || naam.includes(".") ? naam : `public.${naam}`;
}

/** De lijsten waarmee een klantportaal iets vrijgeeft, met hun sleutel in stack.config.json. */
export const VRIJGEEF_LIJSTEN = [
  "klantportaal_poorten",
  "klantportaal_vrije_functies",
  "klantportaal_openbaar",
];

/**
 * De namen die een pull request vrijgeeft: in een lijst van het klantportaal in `nu`, en niet
 * in die lijst in `basis` (stack.config.json op de basisbranch). Stond de schakelaar op de basis
 * nog uit, dan telt alles wat nu op een lijst staat als nieuw: wie eerst namen zet en later de
 * schakelaar aan, bevestigt ze dan alsnog. Zonder de schakelaar nu: niets.
 */
export function nieuwVrijgegeven(nu, basis) {
  if (nu?.klantportaal !== true) return [];
  const basisAan = basis?.klantportaal === true;
  const uit = [];
  for (const sleutel of VRIJGEEF_LIJSTEN) {
    const lijst = nu[sleutel];
    if (typeof lijst !== "object" || lijst === null || Array.isArray(lijst)) continue;
    const eerder = basisAan ? Object.keys(basis?.[sleutel] ?? {}).map(voluit) : [];
    for (const [naam, reden] of Object.entries(lijst)) {
      if (!eerder.includes(voluit(naam))) uit.push({ lijst: sleutel, naam, reden });
    }
  }
  return uit;
}

/** De regel in de PR-tekst die bevestigt dat `naam` bewust is vrijgegeven. */
export function bevestigingVrijgeven(naam) {
  return `Bevestigd: klantportaal vrijgegeven: ${naam}`;
}

/** Staat de bevestiging voor `naam` (of dezelfde naam voluit) in de PR-tekst? */
export function vrijgevenBevestigd(naam, prTekst) {
  const regels = prTekst.split(/\r?\n/).map((r) => r.trim());
  return regels.some((regel) => {
    const m = /^Bevestigd:\s*klantportaal vrijgegeven:\s*(\S+)\s*$/i.exec(regel);
    return m !== null && voluit(m[1] ?? "") === voluit(naam);
  });
}
