import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { generate, HEADER, kanGenereren, TARGET } from "./lib/db-types.mjs";
import { databaseModus } from "./lib/stack-config.mjs";

/**
 * Genereert de databasetypes uit de lokale database en schrijft ze weg met een
 * kop erboven, zodat een lezer meteen ziet dat dit bestand niet met de hand
 * bewerkt hoort te worden. De CI vergelijkt zonder die kop.
 */
if (databaseModus() === "geen") {
  console.error("✗ Deze app heeft geen database (database: false in stack.config.json).");
  process.exit(1);
}

if (!kanGenereren()) {
  console.error("✗ SUPABASE_ACCESS_TOKEN ontbreekt.");
  console.error("  Deze app gebruikt de database van een andere app, dus de types komen");
  console.error("  uit dát Supabase-project en niet uit een lokale database.");
  console.error(
    "  Zet een eigen token van Supabase in SUPABASE_ACCESS_TOKEN (Account > Access Tokens),",
  );
  console.error(
    "  of haal de types zonder token uit de laatste run van de Kwaliteitspoort: `pnpm db:types:uit-ci`.",
  );
  process.exit(1);
}

let generated;
try {
  generated = generate();
} catch (error) {
  console.error("✗ De types konden niet gegenereerd worden.");
  if (databaseModus() === "gedeeld") {
    console.error("  Klopt `gedeelde_database.project_ref` in stack.config.json, en heeft");
    console.error("  het token toegang tot dat project?");
  } else {
    console.error("  Draait de lokale database? Start hem met `pnpm db:start`.");
  }
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}

writeFileSync(TARGET, `${HEADER}\n${generated}`);
console.log(`✓ ${TARGET} bijgewerkt. Vergeet niet te committen.`);

// Meteen netjes opmaken, zodat de lint-check er niet over valt.
try {
  execFileSync("pnpm", ["exec", "biome", "format", "--write", TARGET], { stdio: "ignore" });
} catch {
  // Biome slaat dit bestand over in biome.json; niet erg als dit niets doet.
}
