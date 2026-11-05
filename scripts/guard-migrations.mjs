import { readdirSync, readFileSync } from "node:fs";
import {
  changedFiles,
  fail,
  herstartNaPrTekst,
  pass,
  pullRequestBody,
  skip,
} from "./lib/changed-files.mjs";
import { destructieveRegels } from "./lib/destructief.mjs";
import { bezitDatabase, databaseModus } from "./lib/stack-config.mjs";
import { problemenMetVerwachting } from "./lib/verwachting.mjs";

/**
 * De migratiepijplijn is het enige onderdeel van deze stack dat data onherstelbaar
 * kan vernietigen: een merge-knop die `drop column` op productie uitvoert. Deze
 * guard zorgt dat dat nooit per ongeluk gebeurt.
 *
 * Bevestigen doe je met de regel `Bevestigd: destructieve migratie` in de PR-tekst.
 *
 * Daarnaast: een migratie die bestaande gegevens omzet (UPDATE of DELETE) zet bovenin per
 * geraakte tabel hoeveel rijen hij verwacht (`-- verwachting: <tabel> <min>-<max>`, zie
 * scripts/lib/verwachting.mjs). Ontbreekt die regel, dan is deze guard rood; de droogloop op
 * de testdatabase toetst daarna of het aantal klopt.
 */
/**
 * Migratiebestanden die in de repo staan, los van wat er in deze PR gewijzigd is.
 * Voor de eigendomsvraag hieronder telt de aanwezigheid, niet de diff.
 */
function migratiesInRepo() {
  try {
    return readdirSync("supabase/migrations").filter((naam) => naam.endsWith(".sql"));
  } catch {
    return [];
  }
}

/**
 * Eén schrijver per database. Een app die de database van een ander gebruikt
 * (`"gedeeld"`) of er helemaal geen heeft (`false`), hoort geen migraties te
 * bevatten. Gebeurt dat toch, dan zouden twee repo's naar dezelfde database gaan
 * pushen, en dat loopt onherroepelijk vast: Supabase houdt de toegepaste migraties
 * bij in de database zelf, en de tweede repo kent de bestanden van de eerste niet.
 */
const modus = databaseModus();
if (!bezitDatabase()) {
  const aanwezig = migratiesInRepo();
  if (aanwezig.length > 0) {
    fail("Deze app bezit geen database, maar er staan wél migraties in de repo.", [
      ...aanwezig.map((naam) => `- supabase/migrations/${naam}`),
      "",
      modus === "gedeeld"
        ? 'Deze app staat op `"database": "gedeeld"`: ze gebruikt de database van een'
        : 'Deze app staat op `"database": false`: ze heeft helemaal geen database.',
      modus === "gedeeld" ? "andere app en mag het schema daarvan niet wijzigen." : "",
      "",
      "Wat je wél doet:",
      "  - hoort de wijziging bij het schema? Doe hem in de repo die de database bezit.",
      "  - heeft deze app echt een eigen database nodig? Dan is dat een beslissing van",
      "    Stage Two, niet een bestand erbij. Vraag het Stage Two.",
      "",
      "Verwijder deze bestanden om de poort weer groen te krijgen.",
    ]);
  }
  skip(`deze app bezit geen database (database: ${modus === "gedeeld" ? '"gedeeld"' : "false"})`);
}

const CONFIRMATION = /^\s*Bevestigd:\s*destructieve migratie\s*$/im;

const files = changedFiles();
if (files === null) skip("geen basis om mee te vergelijken");

const migrations = files.filter((file) => /^supabase\/migrations\/.*\.sql$/.test(file));
if (migrations.length === 0) pass("geen migraties gewijzigd");

const findings = [];
const zonderVerwachting = [];
for (const file of migrations) {
  let sql;
  try {
    sql = readFileSync(file, "utf8");
  } catch {
    continue; // bestand is hernoemd of verwijderd
  }
  for (const naam of destructieveRegels(sql)) findings.push(`${file}: ${naam}`);
  for (const probleem of problemenMetVerwachting(sql))
    zonderVerwachting.push(`${file}: ${probleem}`);
}

if (zonderVerwachting.length > 0) {
  fail("Een migratie die gegevens omzet, zegt niet hoeveel rijen ze verwacht te raken.", [
    ...zonderVerwachting.map((regel) => `- ${regel}`),
    "",
    "Zet bovenin de migratie per tabel met een UPDATE of DELETE een regel, met een bereik:",
    "",
    "  -- verwachting: public.klanten 120-140",
    "",
    "Tel het op de testdatabase (een kopie van productie) met een select met hetzelfde filter,",
    "en neem een ruim maar eerlijk bereik. De droogloop draait de migratie op de testdatabase",
    "en is rood als het aantal erbuiten valt. Zie docs/routes/databasewijziging.md.",
  ]);
}

if (findings.length === 0) pass(`${migrations.length} migratie(s) gewijzigd, niets destructiefs`);

if (CONFIRMATION.test(pullRequestBody())) {
  console.log("✓ destructieve migratie, expliciet bevestigd in de PR-tekst:");
  for (const finding of findings) console.log(`  - ${finding}`);
  process.exit(0);
}

fail("Deze PR bevat een migratie die data of beveiliging kan vernietigen.", [
  ...findings.map((finding) => `- ${finding}`),
  "",
  "Controleer eerst:",
  "  - staan de back-ups aan en is de laatste back-up recent?",
  "  - is dit op productie ook echt de bedoeling, of alleen in jouw testomgeving?",
  "  - kan het ook zonder dataverlies (kolom leeg laten in plaats van weggooien)?",
  "",
  "Weet je het zeker? Zet dan deze regel exact zo in de PR-tekst:",
  "",
  "Bevestigd: destructieve migratie",
  ...herstartNaPrTekst,
]);
