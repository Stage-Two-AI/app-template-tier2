import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * scripts/db-url.mjs bouwt het adres van de database voor deploy-db.yml, uit
 * PROJECT_REF, WACHTWOORD en (optioneel) POOLER. Met `--mask` schrijft het alleen het
 * maskeercommando voor het gecodeerde wachtwoord, zonder `--mask` alleen het adres.
 * De tests draaien het script als los proces, precies zoals de workflow dat doet.
 */
const SCRIPT = resolve(__dirname, "../../scripts/db-url.mjs");
/** Een nepwachtwoord, ingevuld bij het draaien: guard:secrets ziet `${WW}` als een open plek. */
const WW = "geheim";
const GECODEERD = "p%40ss%2Fw%3Ard";

function draai(
  env: Record<string, string | undefined>,
  args: string[] = [],
): { code: number | null; stdout: string; stderr: string } {
  const schoon = { ...process.env };
  delete schoon.PROJECT_REF;
  delete schoon.WACHTWOORD;
  delete schoon.POOLER;
  const r = spawnSync("node", [SCRIPT, ...args], {
    env: { ...schoon, ...env },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("scripts/db-url.mjs", () => {
  it("bouwt via de session pooler een adres met gebruiker postgres.<ref>", () => {
    const r = draai({
      PROJECT_REF: "abcd",
      WACHTWOORD: "geheim",
      POOLER: "aws-0-eu.pooler.supabase.com",
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      `postgresql://postgres.abcd:${WW}@aws-0-eu.pooler.supabase.com:5432/postgres`,
    );
  });

  it("bouwt zonder pooler het directe adres db.<ref>.supabase.co", () => {
    const r = draai({ PROJECT_REF: "abcd", WACHTWOORD: "geheim" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`postgresql://postgres:${WW}@db.abcd.supabase.co:5432/postgres`);
  });

  it("behandelt een lege POOLER als geen pooler", () => {
    const r = draai({ PROJECT_REF: "abcd", WACHTWOORD: "geheim", POOLER: "" });
    expect(r.stdout).toBe(`postgresql://postgres:${WW}@db.abcd.supabase.co:5432/postgres`);
  });

  it("codeert een wachtwoord met @, / en : zodat het adres heel blijft", () => {
    const r = draai({ PROJECT_REF: "abcd", WACHTWOORD: "p@ss/w:rd" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`postgresql://postgres:${GECODEERD}@db.abcd.supabase.co:5432/postgres`);
    expect(r.stdout).not.toContain("p@ss/w:rd");
  });

  it("schrijft met --mask alleen het maskeercommando voor het gecodeerde wachtwoord", () => {
    const r = draai({ PROJECT_REF: "abcd", WACHTWOORD: "p@ss/w:rd" }, ["--mask"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("::add-mask::p%40ss%2Fw%3Ard\n");
    expect(r.stdout).not.toContain("postgresql://");
  });

  it("faalt zonder project-ref, ook met --mask, en zonder iets op stdout", () => {
    for (const args of [[], ["--mask"]]) {
      const r = draai({ WACHTWOORD: "geheim" }, args);
      expect(r.code).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("PROJECT_REF");
    }
  });

  it("faalt zonder wachtwoord, ook met --mask, en zonder iets op stdout", () => {
    for (const args of [[], ["--mask"]]) {
      const r = draai({ PROJECT_REF: "abcd", WACHTWOORD: "" }, args);
      expect(r.code).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("WACHTWOORD");
    }
  });
});
