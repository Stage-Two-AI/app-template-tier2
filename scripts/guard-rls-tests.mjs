import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fail, pass, skip } from "./lib/changed-files.mjs";
import { gedekteTabellen, leesMigraties, tabellenInPublic } from "./lib/rls-regels.mjs";
import { bezitDatabase, openTabellen } from "./lib/stack-config.mjs";

/**
 * Per tabel een A/B-test: gebruiker B ziet, wijzigt en verwijdert de rij van gebruiker A
 * niet. Elke tabel in `public` (dezelfde lijst als guard-rls.mjs) moet ofwel voorkomen in een
 * aanroep `controleerAfscherming({ tabel: "<naam>", ... })` in tests/rls/, ofwel met een
 * reden in `open_tabellen` in stack.config.json staan (iedereen binnen mag hem zien).
 *
 * guard-rls.mjs kijkt of er policies zijn; deze guard kijkt of iemand heeft nagegaan dat ze
 * ook werken. Een policy die er staat maar niets afschermt, ziet alleen een test.
 *
 * Eerst een waarschuwing, daarna rood. Bestaande apps hebben soms veel tabellen zonder
 * A/B-test; meteen rood zou daar elke pull request stilzetten. In deze uitgave meldt de guard
 * de ontbrekende tabellen (in GitHub als waarschuwing bij de run); in de volgende uitgave
 * zet de werkplaats VERPLICHT op true en is hij rood.
 */
const VERPLICHT = false;

if (!bezitDatabase()) skip("deze app bezit geen database, dus ook geen tabellen om te testen");

const sql = leesMigraties();
if (sql === null) pass("nog geen migraties");

const tabellen = tabellenInPublic(sql);
if (tabellen.size === 0) pass("geen tabellen in het schema public");

function leesTests(map) {
  let tekst = "";
  let namen = [];
  try {
    namen = readdirSync(map);
  } catch {
    return tekst;
  }
  for (const naam of namen) {
    const pad = join(map, naam);
    if (statSync(pad).isDirectory()) tekst += leesTests(pad);
    else if (/\.(?:ts|tsx|js|mjs)$/.test(naam)) tekst += `\n${readFileSync(pad, "utf8")}`;
  }
  return tekst;
}

const gedekt = gedekteTabellen(leesTests("tests/rls"));
const open = openTabellen();
const zonder = [...tabellen].filter((t) => !gedekt.has(t) && !(t in open)).sort();

if (zonder.length === 0) {
  pass(`${tabellen.size} tabel(len): elk een A/B-test of een regel in open_tabellen`);
}

const uitleg = [
  ...zonder.map((t) => `- ${t}`),
  "",
  "Een tabel die er al stond, krijgt zijn test vanzelf: /stagetwo-tier2:updaten schrijft hem in de",
  "pull request van de update. Een nieuwe tabel krijgt hem bij het bouwen.",
  "",
  "Zet per tabel een A/B-test in tests/rls/ (de hulp staat in tests/rls/lib/afscherming.ts):",
  "",
  '  it("<tabel>: B ziet de rij van A niet", async () => {',
  "    await controleerAfscherming({",
  '      tabel: "<tabel>",',
  "      maakRijAlsA: async (a) => {",
  "        const { data, error } = await a.client",
  '          .from("<tabel>").insert({ owner_id: a.id }).select("id").single();',
  "        if (error) throw error;",
  "        return data.id;",
  "      },",
  "    });",
  "  });",
  "",
  "Mag iedereen die binnen is deze tabel zien? Zet hem dan met een reden in",
  'stack.config.json: "open_tabellen": { "<tabel>": "<waarom>" }.',
];

if (VERPLICHT) fail("Tabellen zonder A/B-test (gebruiker B ziet de rij van A niet):", uitleg);

// Nog een waarschuwing: in GitHub zichtbaar bij de run, lokaal als gewone regels.
const titel = `${zonder.length} tabel(len) zonder A/B-test: ${zonder.join(", ")}`;
if (process.env.GITHUB_ACTIONS) {
  console.log(
    `::warning title=A/B-test per tabel::${titel}. Vanaf de volgende uitgave van Stage Two is dit rood.`,
  );
}
console.log(`! ${titel}`);
console.log("  Nu nog een waarschuwing; vanaf de volgende uitgave van Stage Two is dit rood.");
for (const regel of uitleg) console.log(`  ${regel}`);
process.exit(0);
