import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { databaseModus, gedeeldeDatabase } from "./lib/stack-config.mjs";

/**
 * Schrijft .env.local (voor de app) en .env.test (voor de RLS-tests) op basis van
 * de draaiende lokale Supabase. Beide bestanden staan in .gitignore.
 *
 * De service role key komt alleen in .env.test terecht, nooit in een VITE_-variabele:
 * die zou anders in de bundel belanden.
 */
const modus = databaseModus();

if (modus === "geen") {
  console.error("✗ Deze app heeft geen database (database: false in stack.config.json).");
  console.error("  Er is dus niets om omgevingsvariabelen voor te schrijven.");
  process.exit(1);
}

/**
 * Een gedeelde database draait niet lokaal: hij is van een andere app. Er valt hier
 * dus niets te genereren. De waarden komen uit het Supabase-project van de eigenaar
 * en worden één keer met de hand in .env.local gezet.
 */
if (modus === "gedeeld") {
  const gedeeld = gedeeldeDatabase();
  console.error("✗ Deze app gebruikt de database van een andere app en heeft er zelf geen.");
  console.error(`  Eigenaar: ${gedeeld.eigenaar} (Supabase-project ${gedeeld.project_ref})`);
  console.error("");
  console.error("  Zet .env.local één keer met de hand op basis van .env.example:");
  console.error("    VITE_SUPABASE_URL      de URL van het project van de eigenaar");
  console.error("    VITE_SUPABASE_ANON_KEY de publieke sleutel van dat project");
  console.error("    VITE_SUPABASE_SCHEMA=api");
  process.exit(1);
}

let raw;
try {
  raw = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], { encoding: "utf8" });
} catch {
  console.error("✗ Kon de status van de lokale Supabase niet ophalen.");
  console.error("  Start hem eerst met `pnpm db:start`.");
  process.exit(1);
}

const values = new Map();
for (const line of raw.split("\n")) {
  const match = /^([A-Z_]+)="?([^"]*)"?$/.exec(line.trim());
  if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2]);
}

const apiUrl = values.get("API_URL");
const anonKey = values.get("ANON_KEY");
const serviceRoleKey = values.get("SERVICE_ROLE_KEY");
// Het adres van de lokale database (postgres:postgres op 127.0.0.1, geen geheim). Voor de
// tests die de policies en rechten in de database zelf lezen (tests/rls/open-policies.test.ts)
// en voor supabase/testrol.sql in de browsertest.
const dbUrl = values.get("DB_URL") ?? "";

if (!apiUrl || !anonKey || !serviceRoleKey) {
  console.error("✗ De statusuitvoer bevatte niet alle verwachte waarden.");
  process.exit(1);
}

writeFileSync(
  ".env.local",
  `# Automatisch geschreven door \`pnpm env:local\`. Niet committen.\nVITE_SUPABASE_URL=${apiUrl}\nVITE_SUPABASE_ANON_KEY=${anonKey}\nVITE_SUPABASE_SCHEMA=public\n`,
);

const testEnv = [
  "# Automatisch geschreven door `pnpm env:local`. Niet committen.",
  "# Alleen voor de RLS-tests en de end-to-end test: deze sleutel gaat langs alle",
  "# beveiliging heen en hoort dus nooit in een VITE_-variabele.",
  `SUPABASE_URL=${apiUrl}`,
  `SUPABASE_ANON_KEY=${anonKey}`,
  `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`, // guard-secrets:allow
  `SUPABASE_DB_URL=${dbUrl}`,
  "",
].join("\n");

writeFileSync(".env.test", testEnv);

console.log("✓ .env.local en .env.test geschreven op basis van de lokale Supabase");
