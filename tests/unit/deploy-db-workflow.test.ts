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
    expect(env[1]?.PROJECT_REF).toBe(
      `${EXPRESSIE} vars.SUPABASE_PROJECT_REF || secrets.SUPABASE_PROJECT_REF }}`,
    );
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

  it("leest de project-ref als variabele, met het secret als vangnet, nergens alleen als secret", () => {
    expect(tekst).not.toMatch(/\{\{\s*secrets\.SUPABASE_PROJECT_REF\s*\}\}/);
  });

  it("slaat met een melding over als wachtwoord of project-ref ontbreekt", () => {
    const controle = migratiejobs[0]?.[1].steps.find((s) => s.name === "Is alles ingericht?");
    expect(controle?.env).toEqual({
      // De project-ref is een variabele; het oude secret blijft als vangnet.
      PROJECT_REF: `${EXPRESSIE} vars.SUPABASE_PROJECT_REF || secrets.SUPABASE_PROJECT_REF }}`,
      WACHTWOORD: `${EXPRESSIE} secrets.SUPABASE_DB_PASSWORD }}`,
    });
    expect(controle?.run).toContain("::notice::");
    expect(controle?.run).toContain("skip=true");
    expect(controle?.run).toContain('-z "$WACHTWOORD"');
    expect(controle?.run).toContain('-z "$PROJECT_REF"');
  });

  it("zet in de canary voorlopige migraties van andere PR's even opzij, en daarna terug", () => {
    // Migratie op test (beheer-repo) zet de migraties van een open PR al op de testdatabase,
    // met een regel in de geschiedenis. Zonder deze stap weigert `supabase db push` daar.
    const canary = migratiejobs[0]?.[1].steps.find((s) => s.name?.startsWith("Canary"));
    const run = canary?.run ?? "";
    const adres = run.indexOf("DB_URL=$(node scripts/db-url.mjs)");
    const push = run.indexOf("supabase db push");
    const plek = (tekst: string, vanaf = 0) => run.indexOf(tekst, vanaf);

    // De versies op test die niet in supabase/migrations/ van main staan.
    const lokaal = plek("ls supabase/migrations/*.sql");
    const opTest = plek("select version from supabase_migrations.schema_migrations");
    const verschil = plek("comm -13");
    expect(lokaal).toBeGreaterThan(adres);
    expect(opTest).toBeGreaterThan(adres);
    expect(verschil).toBeGreaterThan(Math.max(lokaal, opTest));

    // Opzij: eerst bewaren in canary_opzij, dan pas weghalen uit de geschiedenis, vóór de push.
    const bewaren = plek("insert into supabase_migrations.canary_opzij");
    const weghalen = plek("delete from supabase_migrations.schema_migrations");
    expect(bewaren).toBeGreaterThan(verschil);
    expect(weghalen).toBeGreaterThan(bewaren);
    expect(push).toBeGreaterThan(weghalen);
    expect(run).toContain("::notice::Voorlopige migraties");

    // Terug: de bewaarde regels (met hun SQL) gaan terug, ook als de push mislukt, en daarna
    // telt de uitkomst van de push. Een restant van een afgebroken run gaat eerst terug.
    expect(run).toMatch(
      /insert into supabase_migrations\.schema_migrations\s+select \* from supabase_migrations\.canary_opzij/,
    );
    expect(run).toContain("drop table supabase_migrations.canary_opzij");
    expect(run).toMatch(/supabase db push --db-url "\$DB_URL" --include-all \|\| uitkomst=\$\?/);
    const aanroepen = [...run.matchAll(/^\s*terugzetten\s*$/gm)].map((m) => m.index ?? -1);
    expect(aanroepen.length).toBe(2);
    expect(aanroepen[0]).toBeLessThan(verschil);
    expect(aanroepen[1]).toBeGreaterThan(push);
    expect(plek('exit "$uitkomst"')).toBeGreaterThan(aanroepen[1] ?? 0);

    // Geen `migration repair`: dat gooit de opgeslagen SQL weg, en daarmee ziet Migratie op
    // test niet meer of een voorlopige migratie sindsdien is gewijzigd.
    expect(run).not.toContain("migration repair");
    // Alleen versies van cijfers komen in de SQL terecht.
    expect(run.match(/grep -E '\^\[0-9\]\+\$'/g)?.length).toBe(2);
  });

  it("maakt vlak vóór de migraties op productie een kopie in het schema herstel", () => {
    const stappen = migratiejobs[0]?.[1].steps ?? [];
    const kopie = stappen.findIndex((s) => s.run?.includes("node scripts/herstel-kopie.mjs"));
    const productie = stappen.findIndex((s) => s.name === "Migraties toepassen");
    const canary = stappen.findIndex((s) => s.name?.startsWith("Canary"));
    expect(kopie).toBeGreaterThan(canary);
    expect(productie).toBe(kopie + 1);
    const stap = stappen[kopie];
    expect(stap?.if).toBe("steps.check.outputs.skip != 'true'");
    expect(stap?.env).toEqual(stappen[productie]?.env);
    const run = stap?.run ?? "";
    expect(run.indexOf("node scripts/db-url.mjs --mask")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("HERSTEL_DB_URL=$(node scripts/db-url.mjs)")).toBeGreaterThan(
      run.indexOf("--mask"),
    );
    expect(run).not.toContain(EXPRESSIE);
  });
});
