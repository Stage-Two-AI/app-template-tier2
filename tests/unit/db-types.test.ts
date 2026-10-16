import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Sinds versie 16 maakt de stack de gegenereerde databasetypes op met Biome, en vergelijkt de
 * CI opgemaakt met opgemaakt. Deze test draait de echte functies als los Node-proces, met de
 * Biome uit deze repo, zoals de CI dat ook doet.
 */
const WORTEL = resolve(__dirname, "../..");
const LIB = resolve(WORTEL, "scripts/lib/db-types.mjs");

function roep(functie: string, ...args: string[]): string {
  const code = `import(${JSON.stringify(LIB)}).then((m) => process.stdout.write(String(m.${functie}(...JSON.parse(process.argv[1])))))`;
  return execFileSync("node", ["--input-type=module", "-e", code, JSON.stringify(args)], {
    cwd: WORTEL,
    encoding: "utf8",
  });
}

// Zo schrijft Supabase CLI 2.119 de types: namen tussen aanhalingstekens, kolommen op één regel.
const ONOPGEMAAKT = `export type Database = {
  "public": {
          Tables: {
            "planten": {
                  Row: {
                    "id": string,"naam": string,"potmaat": number | null
                  }
            }
          }
        }
}
`;

describe("databasetypes opmaken (versie 16)", () => {
  it("zet elke kolom op een eigen regel, zonder overbodige aanhalingstekens", () => {
    const opgemaakt = roep("formatteer", ONOPGEMAAKT);
    expect(opgemaakt).toContain("  public: {");
    expect(opgemaakt).toMatch(/^ +naam: string;$/m);
    expect(opgemaakt).toMatch(/^ +potmaat: number \| null;$/m);
  });

  it("is stabiel: twee keer opmaken geeft hetzelfde", () => {
    const een = roep("formatteer", ONOPGEMAAKT);
    expect(roep("formatteer", een)).toBe(een);
  });

  it("vindt een onopgemaakt vastgelegd bestand gelijk aan de opgemaakte versie", () => {
    const kop = "// GEGENEREERD BESTAND, niet met de hand aanpassen.\n";
    const opgemaakt = roep("formatteer", ONOPGEMAAKT);
    expect(roep("zelfdeTypes", opgemaakt, kop + ONOPGEMAAKT)).toBe("true");
  });

  it("ziet een andere kolom wél als verschil", () => {
    const anders = ONOPGEMAAKT.replace('"potmaat"', '"klaarweek"');
    expect(roep("zelfdeTypes", roep("formatteer", ONOPGEMAAKT), anders)).toBe("false");
  });

  it("vindt een vastgelegd bestand dat geen geldige TypeScript is nooit gelijk", () => {
    expect(roep("zelfdeTypes", roep("formatteer", ONOPGEMAAKT), "export type = {")).toBe("false");
  });
});

describe("types uit het CI-log halen (versie 21, zonder Docker)", () => {
  const T = "2026-10-16T10:00:00.1234567Z";
  const log = [
    `Database en end-to-end\tDatabasetypes lopen gelijk\t${T} ✗ loopt niet gelijk`,
    `Database en end-to-end\tDatabasetypes lopen gelijk\t${T} ----- BEGIN GEGENEREERDE TYPES -----`,
    `Database en end-to-end\tDatabasetypes lopen gelijk\t${T} // kop`,
    `Database en end-to-end\tDatabasetypes lopen gelijk\t${T} export type Database = {`,
    `Database en end-to-end\tDatabasetypes lopen gelijk\t${T}   public: {};`,
    `Database en end-to-end\tDatabasetypes lopen gelijk\t${T} };`,
    `Database en end-to-end\tDatabasetypes lopen gelijk\t${T} ----- EINDE GEGENEREERDE TYPES -----`,
  ].join("\n");

  it("haalt het blok eruit, zonder job, stap en tijdstempel, met inspringing", () => {
    expect(roep("typesUitLog", log)).toBe("// kop\nexport type Database = {\n  public: {};\n};\n");
  });

  it("geeft niets als het einde ontbreekt (een afgebroken log)", () => {
    const afgebroken = log.split("\n").slice(0, -1).join("\n");
    expect(roep("typesUitLog", afgebroken)).toBe("null");
  });
});
