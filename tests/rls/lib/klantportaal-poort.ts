import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * De sluitende controle van een klantportaal: de database zelf, na alle migraties. De vraag aan
 * de catalogus van Postgres en de beoordeling staan in scripts/lib/klantportaal-database.mjs;
 * dit bestand stelt de vraag aan de lokale database en geeft de problemen terug.
 *
 * Deze hulp is van de template en komt met elke versie mee.
 */
export type KlantportaalConfig = {
  poorten?: Record<string, string>;
  vrijeFuncties?: Record<string, string>;
  openbaar?: Record<string, string>;
  openTabellen?: Record<string, string>;
};

const MODULE = pathToFileURL(
  resolve(__dirname, "../../../scripts/lib/klantportaal-database.mjs"),
).href;

/** Draait een stukje JavaScript met de module erbij; invoer en uitvoer als JSON. */
function metModule<T>(code: string, invoer: unknown): T {
  const script = `import(${JSON.stringify(MODULE)}).then((m) => { let invoer = ""; process.stdin.on("data", (stuk) => { invoer += stuk; }); process.stdin.on("end", () => { const a = JSON.parse(invoer); process.stdout.write(JSON.stringify(${code})); }); })`;
  return JSON.parse(
    execFileSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf8",
      // Ruim: de inhoud van alle functies van een grote app is meer dan de standaard 1 MB.
      maxBuffer: 256 * 1024 * 1024,
      input: JSON.stringify(invoer),
    }),
  ) as T;
}

function adresVanDeDatabase(): string {
  const adres = import.meta.env.SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL;
  if (!adres) {
    throw new Error(
      "SUPABASE_DB_URL ontbreekt. Draai `pnpm db:start` en daarna `pnpm env:local` voordat je de RLS-tests draait.",
    );
  }
  if (!/@(?:127\.0\.0\.1|localhost):/.test(adres)) {
    throw new Error(
      "SUPABASE_DB_URL wijst niet naar de lokale database; deze tests draaien alleen lokaal.",
    );
  }
  return adres;
}

/**
 * Leest het model uit de database. Met `voor` gebeurt dat in een transactie die na afloop
 * wordt teruggedraaid: eerst `voor` (zoals een migratie, als de gebruiker uit het adres), dan
 * de vraag. Met `alsBeheerder` gaat eerst die SQL als supabase_admin (voor wat een migratie
 * niet mag, zoals een foreign data wrapper maken); daarna gaat de transactie verder als postgres.
 */
export function leesModel(voor = "", alsBeheerder = ""): unknown {
  const adres = adresVanDeDatabase();
  const vraag = metModule<string>("m.MODEL_SQL", {});
  let verbinding = adres;
  let begin = "";
  if (alsBeheerder) {
    const beheerder = new URL(adres);
    beheerder.username = "supabase_admin";
    verbinding = beheerder.toString();
    begin = `${alsBeheerder};\nset local role postgres;`;
  }
  const script = [
    "\\set ON_ERROR_STOP 1",
    "begin;",
    begin,
    voor,
    ";",
    "set local search_path = '';",
    `select (${vraag})::text;`,
    "rollback;",
  ].join("\n");
  const uitvoer = execFileSync("psql", [verbinding, "-X", "-q", "-A", "-t"], {
    encoding: "utf8",
    input: script,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const regels = uitvoer.trim().split("\n").filter(Boolean);
  return JSON.parse(regels.at(-1) ?? "{}");
}

/** Wat er in de database mis is voor een klantportaal; leeg als alles door de poort gaat. */
export function beoordeel(model: unknown, config: KlantportaalConfig = {}): string[] {
  return metModule<string[]>("m.beoordeelDatabase(a.model, a.config)", { model, config });
}

/** Wat er in de database mis is voor een klantportaal; leeg als alles door de poort gaat. */
export function problemenKlantportaalInDatabase(config: KlantportaalConfig = {}): string[] {
  return beoordeel(leesModel(), config);
}
