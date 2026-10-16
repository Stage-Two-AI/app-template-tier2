import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { TARGET, typesUitLog } from "./lib/db-types.mjs";

/**
 * De databasetypes zonder lokale database (dus zonder Docker): de Kwaliteitspoort van de
 * pull request genereert ze uit een eigen Supabase, en zet ze in het log als ze niet gelijk
 * lopen. Dit script haalt ze daar op en schrijft ze naar src/lib/database.types.ts.
 *
 *   pnpm db:types:uit-ci            de laatste run van de Kwaliteitspoort op deze branch
 *   pnpm db:types:uit-ci <run-id>   een bepaalde run
 */
function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

let runId = process.argv[2];
if (!runId) {
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const runs = JSON.parse(
    gh(
      "run",
      "list",
      "--workflow",
      "ci.yml",
      "--branch",
      branch,
      "--limit",
      "1",
      "--json",
      "databaseId,status",
    ),
  );
  if (runs.length === 0) {
    console.error(`✗ Geen run van de Kwaliteitspoort gevonden op branch ${branch}.`);
    console.error("  Push eerst, en zet de pull request op klaar (`gh pr ready`).");
    process.exit(1);
  }
  if (runs[0].status !== "completed") {
    console.error("✗ De laatste run van de Kwaliteitspoort loopt nog. Wacht tot hij klaar is:");
    console.error(`  gh run watch ${runs[0].databaseId}`);
    process.exit(1);
  }
  runId = String(runs[0].databaseId);
}

const types = typesUitLog(gh("run", "view", runId, "--log-failed"));
if (!types) {
  console.error(`✗ In run ${runId} staan geen gegenereerde types.`);
  console.error("  Dat betekent meestal dat de types al gelijk lopen, of dat de check");
  console.error("  Databasetypes niet heeft gedraaid (een concept-PR: zet hem op klaar).");
  process.exit(1);
}
writeFileSync(TARGET, types);
console.log(`✓ ${TARGET} bijgewerkt uit run ${runId}. Vergeet niet te committen.`);
