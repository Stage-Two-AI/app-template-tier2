import { readFileSync, writeFileSync } from "node:fs";
import { leesMigraties, openPolicies } from "./lib/rls-regels.mjs";
import { openTabellen } from "./lib/stack-config.mjs";

/**
 * Eenmalig bij het bijwerken van een bestaande app naar de versie waarin de poort open
 * policies (`using (true)`) controleert: neemt de tabellen die nu al zo'n policy hebben op in
 * `open_tabellen` in stack.config.json, met de reden "bestond al vóór versie <n>, nog
 * nalopen". Anders wordt de update-PR zelf rood. Daarna vult /stagetwo-tier2:updaten in de
 * update-PR per tabel de echte reden in, uit de migratie en de code; de bouwer hoeft niets.
 *
 * Een open policy voor `anon` of `public` neemt dit script niet op: die blijft rood, want
 * daarmee ziet iedereen met de openbare sleutel alles. Die noemt het script apart.
 *
 * Gebruik: `node scripts/open-tabellen-opnemen.mjs` (schrijft stack.config.json bij).
 */
const sql = leesMigraties();
if (sql === null) {
  console.log("✓ geen migraties, niets op te nemen");
  process.exit(0);
}

let versie = "deze versie";
try {
  versie = `versie ${readFileSync(".claude/stack-version", "utf8").trim()}`;
} catch {}

/** Waarvoor een policy geldt (`for select`, ...); zonder `for` is het alles. */
function opdrachtVan(naam) {
  const kop = new RegExp(
    `create\\s+policy\\s+"?${naam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s+on\\s+[^;]*?\\bfor\\s+(select|insert|update|delete|all)\\b`,
    "i",
  );
  return (kop.exec(sql)?.[1] ?? "all").toLowerCase();
}

const bestaand = openTabellen();
const erbij = {};
const nooit = [];
for (const p of openPolicies(sql)) {
  if (p.rollen.includes("anon") || p.rollen.includes("public")) {
    nooit.push(
      `${p.tabel} (policy "${p.naam}", ${p.rollen.join(", ")}, for ${opdrachtVan(p.naam)})`,
    );
  } else if (!(p.tabel in bestaand)) {
    erbij[p.tabel] = `bestond al vóór ${versie}, nog nalopen`;
  }
}

if (Object.keys(erbij).length > 0) {
  const config = JSON.parse(readFileSync("stack.config.json", "utf8"));
  config.open_tabellen = { ...(config.open_tabellen ?? {}), ...erbij };
  writeFileSync("stack.config.json", `${JSON.stringify(config, null, 2)}\n`);
  console.log(`✓ ${Object.keys(erbij).length} tabel(len) opgenomen in open_tabellen:`);
  for (const tabel of Object.keys(erbij)) console.log(`  - ${tabel}`);
} else {
  console.log("✓ geen nieuwe open tabellen om op te nemen");
}

if (nooit.length > 0) {
  console.log("");
  console.log("! Deze policies staan open voor iedereen met de openbare sleutel en blijven rood:");
  for (const regel of nooit) console.log(`  - ${regel}`);
  console.log(
    "  Maak ze smal (to authenticated, en liefst een eigen voorwaarde) in een nieuwe migratie.",
  );
}
