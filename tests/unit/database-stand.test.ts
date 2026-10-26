import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * De drie standen van `database` in stack.config.json sturen de hele databaselaag
 * aan. Deze test draait de scripts zoals de CI dat doet: als los Node-proces, in
 * een map met alleen een stack.config.json. Zo testen we het echte gedrag en niet
 * een nagebootste versie ervan.
 */
const SCRIPTS = resolve(__dirname, "../../scripts");

let map: string;

beforeEach(() => {
  map = mkdtempSync(join(tmpdir(), "stack-stand-"));
});

afterEach(() => {
  rmSync(map, { recursive: true, force: true });
});

function config(inhoud: unknown): void {
  writeFileSync(join(map, "stack.config.json"), JSON.stringify(inhoud));
}

function vraag(expressie: string): string {
  const code = `import(${JSON.stringify(pathToFileURL(join(SCRIPTS, "lib/stack-config.mjs")).href)}).then((m) => console.log(${expressie}))`;
  return execFileSync("node", ["--input-type=module", "-e", code], {
    cwd: map,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function guardMigraties(): { code: number; uitvoer: string } {
  try {
    const uitvoer = execFileSync("node", [join(SCRIPTS, "guard-migrations.mjs")], {
      cwd: map,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, uitvoer };
  } catch (fout) {
    const e = fout as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, uitvoer: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("databaseModus", () => {
  it("vertaalt de drie standen naar één woord", () => {
    config({ database: false });
    expect(vraag("m.databaseModus()")).toBe("geen");
    config({ database: "gedeeld", gedeelde_database: { project_ref: "abc" } });
    expect(vraag("m.databaseModus()")).toBe("gedeeld");
    config({ database: true });
    expect(vraag("m.databaseModus()")).toBe("eigen");
  });

  it("is eigen als er geen stack.config.json is", () => {
    expect(vraag("m.databaseModus()")).toBe("eigen");
  });

  it("weigert een stand die niet bestaat", () => {
    config({ database: "ja" });
    expect(() => vraag("m.databaseModus()")).toThrow(/geen geldige stand/);
  });

  it("bezit de database alleen bij een eigen database", () => {
    config({ database: "gedeeld", gedeelde_database: { project_ref: "abc" } });
    expect(vraag("m.heeftDatabase()")).toBe("true");
    expect(vraag("m.bezitDatabase()")).toBe("false");
  });

  it("eist bij gedeeld een project-ref van de eigenaar", () => {
    config({ database: "gedeeld" });
    expect(() => vraag("m.gedeeldeDatabase()")).toThrow(/gedeelde_database/);
    config({
      database: "gedeeld",
      gedeelde_database: { eigenaar: "Klant/erp", project_ref: "abc" },
    });
    expect(vraag("JSON.stringify(m.gedeeldeDatabase())")).toBe(
      '{"eigenaar":"Klant/erp","project_ref":"abc"}',
    );
  });
});

describe("guard:migrations bij een app die de database niet bezit", () => {
  it("laat de poort falen zodra er toch migraties staan", () => {
    config({ database: "gedeeld", gedeelde_database: { project_ref: "abc" } });
    mkdirSync(join(map, "supabase/migrations"), { recursive: true });
    writeFileSync(join(map, "supabase/migrations/20260101000000_iets.sql"), "select 1;");
    const { code, uitvoer } = guardMigraties();
    expect(code).not.toBe(0);
    expect(uitvoer).toMatch(/bezit geen database/);
    expect(uitvoer).toMatch(/20260101000000_iets\.sql/);
  });

  it("slaat over zolang er geen migraties zijn", () => {
    config({ database: "gedeeld", gedeelde_database: { project_ref: "abc" } });
    const { code, uitvoer } = guardMigraties();
    expect(code).toBe(0);
    expect(uitvoer).toMatch(/gedeeld/);
  });
});

describe("testDatabase met publieke sleutel", () => {
  const ref = "abcdefghijklmnopqrst";

  it("geeft de anon key mee als die in de config staat, en null als hij ontbreekt", () => {
    config({
      database: true,
      testdatabase: { project_ref: ref, anon_key: "sb_publishable_abcdef123456" },
    });
    expect(vraag("m.testDatabase().anon_key")).toBe("sb_publishable_abcdef123456");
    config({ database: true, testdatabase: { project_ref: ref } });
    expect(vraag("m.testDatabase().anon_key")).toBe("null");
  });

  it("weigert een geheime sleutel in de config", () => {
    const geheim = "sb_secret_abcdef123456"; // guard-secrets:allow (verzonnen, om de weigering te testen)
    config({ database: true, testdatabase: { project_ref: ref, anon_key: geheim } });
    expect(() => vraag("m.testDatabase()")).toThrow(/geheime sleutel/);
  });
});
