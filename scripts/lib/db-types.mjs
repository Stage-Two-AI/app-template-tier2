import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { databaseModus, gedeeldeDatabase } from "./stack-config.mjs";

export const TARGET = "src/lib/database.types.ts";

export const HEADER = [
  "// GEGENEREERD BESTAND, niet met de hand aanpassen.",
  "// Opnieuw genereren na een migratie: `pnpm db:types` (met `pnpm db:start` actief).",
  "// De CI controleert of dit bestand nog gelijkloopt met het databaseschema.",
].join("\n");

/**
 * Een app met een gedeelde database heeft geen lokale Supabase om types uit te
 * halen: haar schema staat in het project van een andere app. De types komen dan
 * uit dát project, en uitsluitend uit het schema `api` — het contract. De rest van
 * die database bestaat voor deze app niet, en dat hoort ook zo.
 *
 * Daar is wel een SUPABASE_ACCESS_TOKEN voor nodig. Ontbreekt die, dan kan er niets
 * gegenereerd worden; de aanroeper beslist of dat een fout is of een reden om over
 * te slaan.
 */
export function kanGenereren() {
  if (databaseModus() !== "gedeeld") return true;
  return Boolean(process.env.SUPABASE_ACCESS_TOKEN);
}

function argumenten() {
  const basis = ["exec", "supabase", "gen", "types", "typescript"];
  if (databaseModus() === "gedeeld") {
    const gedeeld = gedeeldeDatabase();
    return [...basis, "--project-id", gedeeld.project_ref, "--schema", "api"];
  }
  return [...basis, "--local"];
}

/**
 * Maakt types op met Biome, dezelfde formatter als de rest van de code. Sinds Supabase CLI
 * 2.119 komen ze onopgemaakt uit de generator (alle kolommen van een tabel op één regel), en
 * dat leest slecht, ook in een PR-diff. De naam voor stdin ligt bewust buiten src/lib: biome.json
 * slaat src/lib/database.types.ts zelf over.
 */
export function formatteer(tekst) {
  // Biome rechtstreeks via Node, niet via `pnpm exec`: pnpm kan zelf een regel op stdout zetten
  // ("Already up to date"), en via Node werkt het ook op Windows. Fouten van Biome blijven binnen.
  const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
  return execFileSync(process.execPath, [biome, "format", "--stdin-file-path=database.types.ts"], {
    input: tekst,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Genereert de databasetypes, opgemaakt: lokaal bij een eigen database, anders uit het contract. */
export function generate() {
  const ruw = execFileSync("pnpm", argumenten(), {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return formatteer(ruw);
}

/**
 * Lopen de vastgelegde types gelijk met de gegenereerde? Beide worden eerst opgemaakt, zodat
 * alleen de inhoud telt: een bestand dat nog onopgemaakt is vastgelegd (van vóór versie 16)
 * blijft geldig tot de volgende `pnpm db:types`.
 */
export function zelfdeTypes(gegenereerd, vastgelegd) {
  const inhoud = (tekst) => stripHeader(formatteer(stripHeader(tekst)));
  try {
    return inhoud(gegenereerd) === inhoud(vastgelegd);
  } catch {
    // Het vastgelegde bestand is geen geldige TypeScript meer: dan loopt het zeker niet gelijk.
    return false;
  }
}

/** Haalt de kop met commentaarregels weg, zodat we alleen de inhoud vergelijken. */
export function stripHeader(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start]?.trim() ?? "";
    if (line === "" || line.startsWith("//")) start += 1;
    else break;
  }
  return lines.slice(start).join("\n").trim();
}

const BEGIN = "----- BEGIN GEGENEREERDE TYPES -----";
const EINDE = "----- EINDE GEGENEREERDE TYPES -----";

/**
 * Haalt de gegenereerde types uit het log van de check "Databasetypes lopen gelijk met het
 * schema" (`gh run view <id> --log-failed`). Elke regel daar begint met de job, de stap en
 * een tijdstempel; die gaan eraf. Geeft null als het blok er niet (helemaal) in staat.
 */
export function typesUitLog(log) {
  const regels = log.split("\n").map((r) => r.replace(/^[^\t]*\t[^\t]*\t\S+Z ?/, ""));
  const begin = regels.findIndex((r) => r.trimEnd() === BEGIN);
  if (begin < 0) return null;
  const einde = regels.findIndex((r, i) => i > begin && r.trimEnd() === EINDE);
  if (einde < 0) return null;
  return `${regels
    .slice(begin + 1, einde)
    .join("\n")
    .trimEnd()}\n`;
}
