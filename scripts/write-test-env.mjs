import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { databaseModus, testDatabase } from "./lib/stack-config.mjs";

/**
 * Schrijft .env.local zodat de app op je eigen computer met de TESTDATABASE praat:
 * hetzelfde Supabase-project als waar de Cloudflare-preview naar wijst, los van productie.
 * Dit is variant B uit docs/routes/lokaal-kijken.md; variant A (`pnpm env:local`)
 * gebruikt een lokale Supabase in Docker. De preview van de Claude-app
 * (scripts/preview.mjs) roept dit script zelf aan als er nog geen .env.local is.
 *
 * Alleen de publieke anon key komt hierin terecht. Die is expres publiek en wordt
 * door RLS beschermd. Daarna haalt `pnpm testlogin` (scripts/testlogin.mjs) de login
 * van de testgebruiker op uit de beheer-repo; lukt dat niet, dan werkt de rest gewoon. Een service role key van de testdatabase bestaat voor deze
 * route niet: er is geen .env.test, want de RLS-tests draaien lokaal of in CI, nooit
 * tegen een gedeeld project.
 */
const modus = databaseModus();

if (modus === "geen") {
  console.error("✗ Deze app heeft geen database (database: false in stack.config.json).");
  console.error(
    "  Er is dus niets in te stellen; de preview (of `STACK_ALLOW_DEV=1 pnpm dev`) werkt meteen.",
  );
  process.exit(1);
}

let test;
try {
  test = testDatabase();
} catch (fout) {
  console.error(`✗ ${fout.message}`);
  process.exit(1);
}

if (!test) {
  console.error("✗ Deze app heeft geen testdatabase ingesteld.");
  console.error("");
  console.error("  In stack.config.json ontbreekt het blok `testdatabase`. Dat is de keuze van");
  console.error("  Stage Two bij het opzetten. Twee opties:");
  console.error(
    "    - lokaal kijken met een eigen database in Docker: `pnpm db:start && pnpm env:local`",
  );
  console.error(
    "    - vraag Stage Two om een testdatabase voor deze app (docs/WERKWIJZE.md, hoofdstuk 3)",
  );
  process.exit(1);
}

if (existsSync(".env.local") && !process.argv.includes("--overschrijf")) {
  console.error("✗ Er staat al een .env.local. Die overschrijf ik niet zomaar.");
  console.error("  Wil je hem echt vervangen door de testdatabase? `pnpm env:test --overschrijf`");
  process.exit(1);
}

/**
 * De anon key staat bij voorkeur in stack.config.json (`testdatabase.anon_key`): dan is
 * er op deze computer geen login bij Supabase nodig, en zo hoort het (geen toegang tot
 * Supabase op een werkcomputer). Staat hij er niet, dan proberen we de Supabase CLI; dat
 * vraagt een eenmalige `pnpm exec supabase login`. Lukt ook dat niet, dan kan het met de
 * hand: de route beschrijft waar de sleutel in het dashboard staat.
 */
function anonKeyViaCli() {
  try {
    const raw = execFileSync(
      "pnpm",
      ["exec", "supabase", "projects", "api-keys", "--project-ref", test.project_ref, "-o", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const sleutels = JSON.parse(raw);
    const anon =
      sleutels.find((k) => k.name === "anon") ??
      sleutels.find(
        (k) => typeof k.api_key === "string" && k.api_key.startsWith("sb_publishable_"),
      );
    return anon?.api_key ?? null;
  } catch {
    return null;
  }
}

const anonKey = test.anon_key ?? anonKeyViaCli();

const schema = modus === "gedeeld" ? "api" : "public";

if (!anonKey) {
  console.error("✗ Kon de publieke sleutel van de testdatabase niet ophalen.");
  console.error("");
  console.error(
    "  Het makkelijkst: vraag Stage Two de publieke sleutel in stack.config.json te zetten",
  );
  console.error(
    "  (`testdatabase.anon_key`). Of: nog niet ingelogd bij Supabase op deze computer:",
  );
  console.error("    pnpm exec supabase login");
  console.error("  en dan dit commando opnieuw.");
  console.error("");
  console.error("  Of met de hand, in .env.local:");
  console.error(`    VITE_SUPABASE_URL=${test.url}`);
  console.error(
    "    VITE_SUPABASE_ANON_KEY=<anon / publishable key uit het Supabase-dashboard van",
  );
  console.error(
    `                            project ${test.project_ref}: Project Settings > API keys>`,
  );
  console.error(`    VITE_SUPABASE_SCHEMA=${schema}`);
  process.exit(1);
}

writeFileSync(
  ".env.local",
  [
    "# Automatisch geschreven door `pnpm env:test`. Niet committen.",
    `# Dit is de TESTDATABASE (Supabase-project ${test.project_ref}), niet productie.`,
    `VITE_SUPABASE_URL=${test.url}`,
    `VITE_SUPABASE_ANON_KEY=${anonKey}`,
    `VITE_SUPABASE_SCHEMA=${schema}`,
    "VITE_OMGEVING=test",
    "",
  ].join("\n"),
  { mode: 0o600 },
);

console.log(`✓ .env.local geschreven: de app praat nu met de testdatabase (${test.project_ref})`);

// De testlogin: zonder kan de app lokaal niet inloggen (de gewone inlog loopt via
// Cloudflare). Lukt het niet (offline, nog geen artifact), dan een waarschuwing.
const testlogin = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("./testlogin.mjs", import.meta.url))],
  {
    stdio: "inherit",
  },
);
if (testlogin.status !== 0) {
  console.warn("  ! Zonder testlogin start de app wel, maar kun je lokaal niet inloggen.");
  console.warn("    Later opnieuw proberen: `pnpm testlogin`.");
}
console.log("  Starten: de preview in de Claude-app, of `STACK_ALLOW_DEV=1 pnpm dev`");
