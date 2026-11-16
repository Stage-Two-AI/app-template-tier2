import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fail, pass, skip } from "./lib/changed-files.mjs";
import { gedekteTabellen, leesMigraties, tabellenInPublic } from "./lib/rls-regels.mjs";
import { bezitDatabase, klantportaal, openTabellen } from "./lib/stack-config.mjs";

/**
 * Per tabel een A/B-test: gebruiker B ziet, wijzigt en verwijdert de rij van gebruiker A
 * niet. Elke tabel in `public` (dezelfde lijst als guard-rls.mjs) moet ofwel voorkomen in een
 * aanroep `controleerAfscherming({ tabel: "<naam>", ... })` in tests/rls/, ofwel met een
 * reden in `open_tabellen` in stack.config.json staan (iedereen binnen mag hem zien).
 *
 * guard-rls.mjs kijkt of er policies zijn; deze guard kijkt of iemand heeft nagegaan dat ze
 * ook werken. Een policy die er staat maar niets afschermt, ziet alleen een test.
 *
 * Eerst een waarschuwing, later rood. Bestaande apps hebben soms veel tabellen zonder
 * A/B-test; meteen rood zou daar elke pull request stilzetten. Voorlopig meldt de guard de
 * ontbrekende tabellen (in GitHub als waarschuwing bij de run). In een latere uitgave zet de
 * werkplaats VERPLICHT op true en is hij rood; welke dat is, staat nog niet vast, en de tekst
 * hieronder belooft daarom geen versie.
 *
 * Bij een klantportaal (`"klantportaal": true`) is hij nu al verplicht, zonder uitzondering
 * (`open_tabellen` mag daar niet). De poort zegt of iemand binnen mag; de A/B-test bewijst dat
 * klanten elkaars rijen niet zien. Een ruime policy achter de poort (`using (id is not null)`)
 * ziet alleen deze test. Zonder de schakelaar verandert er niets.
 */
if (!bezitDatabase()) skip("deze app bezit geen database, dus ook geen tabellen om te testen");

let portaal = null;
try {
  portaal = klantportaal();
} catch (fout) {
  fail("De schakelaar klantportaal in stack.config.json klopt niet (zie ook guard:rls).", [
    ...String(fout instanceof Error ? fout.message : fout).split("\n"),
  ]);
}
const VERPLICHT = portaal !== null;

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
// Bij een klantportaal telt open_tabellen niet als uitzondering: daar is het altijd fout.
const open = portaal !== null ? {} : openTabellen();
const zonder = [...tabellen].filter((t) => !gedekt.has(t) && !(t in open)).sort();

if (zonder.length === 0) {
  pass(
    portaal !== null
      ? `${tabellen.size} tabel(len): elk een A/B-test (verplicht bij een klantportaal)`
      : `${tabellen.size} tabel(len): elk een A/B-test of een regel in open_tabellen`,
  );
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
  ...(portaal !== null
    ? [
        "Dit is een klantportaal: de test is hier verplicht, voor elke tabel. De poort zegt of",
        "iemand binnen mag; de A/B-test bewijst dat klanten elkaars rijen niet zien. Een tabel",
        "alleen voor medewerkers: laat maakRijAlsA de rij maken met admin (docs/routes/klantportaal.md,",
        "stap 6). open_tabellen mag bij een klantportaal niet.",
      ]
    : [
        "Mag iedereen die binnen is deze tabel zien? Zet hem dan met een reden in",
        'stack.config.json: "open_tabellen": { "<tabel>": "<waarom>" }.',
      ]),
];

if (VERPLICHT) fail("Tabellen zonder A/B-test (gebruiker B ziet de rij van A niet):", uitleg);

// Nog een waarschuwing: in GitHub zichtbaar bij de run, lokaal als gewone regels.
const titel = `${zonder.length} tabel(len) zonder A/B-test: ${zonder.join(", ")}`;
if (process.env.GITHUB_ACTIONS) {
  console.log(
    `::warning title=A/B-test per tabel::${titel}. Nu nog een waarschuwing; dit wordt in een latere uitgave verplicht.`,
  );
}
console.log(`! ${titel}`);
console.log("  Nu nog een waarschuwing; dit wordt in een latere uitgave verplicht.");
for (const regel of uitleg) console.log(`  ${regel}`);
process.exit(0);
