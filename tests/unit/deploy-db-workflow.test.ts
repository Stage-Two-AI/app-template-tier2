import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * De migratie-workflow krijgt alleen de gegevens van de eigen database: project-ref en
 * wachtwoord, in omgeving `production` (die tot `main` beperkt is). Een
 * `SUPABASE_ACCESS_TOKEN` geeft rechten op alle Supabase-projecten van de organisatie
 * en hoort daarom alleen in de beheer-repo (KTD12).
 */
const PAD = join(resolve(__dirname, "../../.github/workflows"), "deploy-db.yml");
const tekst = readFileSync(PAD, "utf8");

type Stap = { name?: string; run?: string; if?: string; env?: Record<string, string> };
type Job = { environment?: string | { name: string }; steps: Stap[] };
const workflow = parse(tekst) as { on: Record<string, unknown>; jobs: Record<string, Job> };

/** Het begin van een GitHub-expressie, zoals hij in de YAML staat. */
const EXPRESSIE = ["$", "{{"].join("");

const migratiejobs = Object.entries(workflow.jobs).filter(([, j]) =>
  j.steps.some((s) => /supabase db push/.test(s.run ?? "")),
);

describe("deploy-db.yml", () => {
  it("gebruikt nergens SUPABASE_ACCESS_TOKEN of supabase link", () => {
    expect(tekst).not.toContain("SUPABASE_ACCESS_TOKEN");
    expect(tekst).not.toMatch(/supabase\s+link/);
    expect(tekst).not.toContain("--linked");
  });

  it("draait alleen bij een push op main", () => {
    expect(workflow.on).toEqual({ push: { branches: ["main"] } });
  });

  it("migreert in omgeving production", () => {
    expect(migratiejobs.length).toBeGreaterThan(0);
    for (const [, j] of migratiejobs) {
      const naam = typeof j.environment === "string" ? j.environment : j.environment?.name;
      expect(naam).toBe("production");
    }
  });

  it("migreert met --db-url, voor productie en voor de testdatabase", () => {
    const pushes = migratiejobs
      .flatMap(([, j]) => j.steps)
      .filter((s) => /supabase db push/.test(s.run ?? ""));
    expect(pushes.length).toBe(2);
    for (const s of pushes) {
      expect(s.run).toMatch(/supabase db push --db-url "\$DB_URL"/);
      expect(s.run ?? "", s.name).not.toContain(EXPRESSIE);
    }
    const env = pushes.map((s) => s.env ?? {});
    expect(env.map((e) => e.WACHTWOORD)).toEqual([
      `${EXPRESSIE} secrets.SUPABASE_TEST_DB_PASSWORD }}`,
      `${EXPRESSIE} secrets.SUPABASE_DB_PASSWORD }}`,
    ]);
    expect(env[1]?.PROJECT_REF).toBe(`${EXPRESSIE} secrets.SUPABASE_PROJECT_REF }}`);
    expect(env[0]?.POOLER).toBe(
      `${EXPRESSIE} vars.SUPABASE_TEST_POOLER_HOST || vars.SUPABASE_POOLER_HOST }}`,
    );
    expect(env[1]?.POOLER).toBe(`${EXPRESSIE} vars.SUPABASE_POOLER_HOST }}`);
  });

  it("bouwt het adres met scripts/db-url.mjs, en maskeert het gecodeerde wachtwoord eerst", () => {
    const pushes = migratiejobs
      .flatMap(([, j]) => j.steps)
      .filter((s) => /supabase db push/.test(s.run ?? ""));
    for (const s of pushes) {
      const run = s.run ?? "";
      const masker = run.indexOf("node scripts/db-url.mjs --mask");
      const adres = run.indexOf("DB_URL=$(node scripts/db-url.mjs)");
      expect(masker, s.name).toBeGreaterThanOrEqual(0);
      expect(adres, s.name).toBeGreaterThan(masker);
      expect(run.indexOf("supabase ", adres), s.name).toBeGreaterThan(adres);
      // Het adres wordt nergens meer met de hand in de workflow gebouwd.
      expect(run, s.name).not.toContain("postgresql://");
      expect(run, s.name).not.toContain("encodeURIComponent");
    }
  });

  it("slaat met een melding over als wachtwoord of project-ref ontbreekt", () => {
    const controle = migratiejobs[0]?.[1].steps.find((s) => s.name === "Zijn de secrets al gezet?");
    expect(controle?.env).toEqual({
      PROJECT_REF: `${EXPRESSIE} secrets.SUPABASE_PROJECT_REF }}`,
      WACHTWOORD: `${EXPRESSIE} secrets.SUPABASE_DB_PASSWORD }}`,
    });
    expect(controle?.run).toContain("::notice::");
    expect(controle?.run).toContain("skip=true");
    expect(controle?.run).toContain('-z "$WACHTWOORD"');
    expect(controle?.run).toContain('-z "$PROJECT_REF"');
  });
});
