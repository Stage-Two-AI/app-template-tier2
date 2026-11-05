import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const LIB = resolve(__dirname, "../../scripts/lib/rls-regels.mjs");

/** Roept een functie uit scripts/lib/rls-regels.mjs aan, zoals guard-rls.mjs dat doet. */
function roep<T>(functie: string, ...args: unknown[]): T {
  const code = `import(${JSON.stringify(pathToFileURL(LIB).href)}).then((m) => { const a = JSON.parse(process.argv.at(-1)); const r = m[a.f](...a.args); process.stdout.write(JSON.stringify(r instanceof Set ? [...r] : r)); })`;
  return JSON.parse(
    execFileSync(
      "node",
      ["--input-type=module", "-e", code, "--", JSON.stringify({ f: functie, args })],
      { encoding: "utf8" },
    ),
  ) as T;
}

/** Zoals guard-rls.mjs de migraties leest: zonder commentaar. */
const lees = (sql: string) => roep<string>("zonderCommentaar", sql);

type Policy = { tabel: string; naam: string; rollen: string[]; open: boolean };
const tabellenInPublic = (sql: string) => roep<string[]>("tabellenInPublic", sql);
const openPolicies = (sql: string) => roep<Policy[]>("openPolicies", sql);
const problemenMetOpenPolicies = (sql: string, open: Record<string, string>) =>
  roep<string[]>("problemenMetOpenPolicies", sql, open);
const schrijfrechtenVoorLeesrollen = (sql: string, rollen: string[]) =>
  roep<string[]>("schrijfrechtenVoorLeesrollen", sql, rollen);

describe("tabellenInPublic", () => {
  it("volgt create en drop in volgorde, alleen in public", () => {
    const sql = lees(`
      create table public.a (id int);
      create table if not exists "b" (id int);
      create table api.c (id int);
      create table "public"."d" (id int);
      drop table if exists public.a;
    `);
    expect(tabellenInPublic(sql).sort()).toEqual(["b", "d"]);
  });
});

describe("open policies (using (true))", () => {
  it("vindt using (true) en with check (true), met de rollen", () => {
    const sql = lees(`
      create policy "alles" on public.x for all to authenticated using (true) with check (true);
      create policy lezen on y for select using (true);
      create policy "eigen" on z for select to authenticated using (auth.uid() = owner_id);
      create policy "schrijven" on w for insert to anon, authenticated with check ( true );
    `);
    expect(openPolicies(sql)).toEqual([
      { tabel: "x", naam: "alles", rollen: ["authenticated"], open: true },
      { tabel: "y", naam: "lezen", rollen: ["public"], open: true },
      { tabel: "w", naam: "schrijven", rollen: ["anon", "authenticated"], open: true },
    ]);
  });

  it("een drop policy later haalt hem weer weg", () => {
    const sql = lees(`
      create policy "alles" on public.x for all to authenticated using (true);
      drop policy if exists "alles" on public.x;
      create policy "alles" on public.x for all to authenticated using (auth.uid() = owner_id);
    `);
    expect(openPolicies(sql)).toEqual([]);
  });

  it("splitst niet binnen een functie, en telt de inhoud van een functie niet", () => {
    const sql = lees(`
      create function f() returns void language plpgsql as $$
      begin
        perform 1; -- create policy "nep" on x using (true);
      end $$;
      create policy "echt" on public.x for select to authenticated using (true);
    `);
    expect(openPolicies(sql).map((p) => p.naam)).toEqual(["echt"]);
  });

  it("anon en public zijn altijd fout, ook als de tabel in open_tabellen staat", () => {
    const sql = lees(`
      create policy "a" on public.x for select to anon using (true);
      create policy "b" on public.x for select using (true);
    `);
    const problemen = problemenMetOpenPolicies(sql, { x: "kalender" });
    expect(problemen).toHaveLength(2);
    expect(problemen[0]).toContain("openbare sleutel");
  });

  it("authenticated alleen goed met een regel in open_tabellen", () => {
    const sql = lees(`create policy "a" on public.x for select to authenticated using (true);`);
    expect(problemenMetOpenPolicies(sql, {})).toEqual([
      'x (policy "a"): using (true) zonder regel in open_tabellen (stack.config.json)',
    ]);
    expect(problemenMetOpenPolicies(sql, { x: "kalender voor iedereen binnen" })).toEqual([]);
  });

  it("de policies van de template zijn niet open", () => {
    const sql = lees(`
      create policy "items_select_own" on public.items for select to authenticated
        using (auth.uid() = owner_id);
      create policy "items_insert_own" on public.items for insert to authenticated
        with check (auth.uid() = owner_id);
    `);
    expect(openPolicies(sql)).toEqual([]);
  });
});

describe("leesrollen schrijven niet", () => {
  it("vindt insert, update, delete en all voor een leesrol", () => {
    const sql = lees(`
      grant select on api.voorraad to intern_lezer;
      grant select, insert, update on public.verrijking to intern_lezer;
      grant all on table public.notities to intern_lezer, authenticated;
      grant update (status) on public.orders to "intern_lezer";
      grant insert on public.x to authenticated;
    `);
    expect(schrijfrechtenVoorLeesrollen(sql, ["intern_lezer"])).toEqual([
      "intern_lezer op public.verrijking: insert, update",
      "intern_lezer op table public.notities: insert, update, delete, truncate",
      "intern_lezer op public.orders: update",
    ]);
  });

  it("alleen select, of een recht dat later is ingetrokken, is goed", () => {
    const sql = lees(`
      grant select on all tables in schema api to intern_lezer;
      grant execute on function public.boek(uuid) to intern_lezer;
      grant insert, update on public.verrijking to intern_lezer;
      revoke insert, update on public.verrijking from intern_lezer;
    `);
    expect(schrijfrechtenVoorLeesrollen(sql, ["intern_lezer"])).toEqual([]);
  });

  it("telt ook standaardrechten voor nieuwe tabellen", () => {
    const sql = lees(`
      alter default privileges in schema public grant insert on tables to intern_lezer;
    `);
    expect(schrijfrechtenVoorLeesrollen(sql, ["intern_lezer"])).toEqual([
      "intern_lezer op tables: insert",
    ]);
  });

  it("zonder leesrollen is er niets te controleren", () => {
    expect(schrijfrechtenVoorLeesrollen("grant all on x to y", [])).toEqual([]);
  });
});

describe("scripts/open-tabellen-opnemen.mjs", () => {
  it("neemt bestaande open tabellen op met een reden, maar anon nooit", () => {
    const map = mkdtempSync(join(tmpdir(), "open-tabellen-"));
    try {
      mkdirSync(join(map, "supabase/migrations"), { recursive: true });
      mkdirSync(join(map, ".claude"));
      writeFileSync(join(map, ".claude/stack-version"), "39\n");
      writeFileSync(
        join(map, "stack.config.json"),
        JSON.stringify({ database: true, open_tabellen: { al: "stond er al" } }),
      );
      writeFileSync(
        join(map, "supabase/migrations/1_x.sql"),
        [
          'create policy "a" on public.feestdagen for select to authenticated using (true);',
          'create policy "b" on public.al for select to authenticated using (true);',
          'create policy "c" on public.prijzen for select to anon using (true);',
        ].join("\n"),
      );
      const uitvoer = execFileSync(
        "node",
        [resolve(__dirname, "../../scripts/open-tabellen-opnemen.mjs")],
        {
          cwd: map,
          encoding: "utf8",
        },
      );
      const config = JSON.parse(readFileSync(join(map, "stack.config.json"), "utf8"));
      expect(config.open_tabellen).toEqual({
        al: "stond er al",
        feestdagen: "bestond al vóór versie 39, nog nalopen",
      });
      expect(uitvoer).toContain("prijzen");
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  });
});

describe("gedekteTabellen (guard:rls-tests)", () => {
  const gedekt = (tekst: string) => roep<string[]>("gedekteTabellen", tekst).sort();

  it("telt alleen een aanroep van controleerAfscherming met tabel", () => {
    const tekst = `
      await controleerAfscherming({
        tabel: "notities",
        maakRijAlsA: async (a) => 1,
      });
      await controleerAfscherming({ tabel: 'Orders', maakRijAlsA });
      // alleen de naam noemen telt niet: from("klanten")
      // controleerAfscherming({ tabel: "uitgecommentarieerd" })
      /* controleerAfscherming({
       *   tabel: "voorbeeld",
       */
    `;
    expect(gedekt(tekst)).toEqual(["notities", "orders"]);
  });
});

describe("scripts/guard-rls-tests.mjs", () => {
  it("waarschuwt bij een tabel zonder A/B-test, maar is (nog) niet rood", () => {
    const map = mkdtempSync(join(tmpdir(), "rls-tests-"));
    try {
      mkdirSync(join(map, "supabase/migrations"), { recursive: true });
      mkdirSync(join(map, "tests/rls"), { recursive: true });
      writeFileSync(
        join(map, "stack.config.json"),
        JSON.stringify({ database: true, open_tabellen: { feestdagen: "kalender" } }),
      );
      writeFileSync(
        join(map, "supabase/migrations/1_x.sql"),
        "create table public.notities (id int); create table public.feestdagen (id int); create table public.orders (id int);",
      );
      writeFileSync(
        join(map, "tests/rls/notities.test.ts"),
        'await controleerAfscherming({ tabel: "notities", maakRijAlsA });',
      );
      const uitvoer = execFileSync(
        "node",
        [resolve(__dirname, "../../scripts/guard-rls-tests.mjs")],
        {
          cwd: map,
          encoding: "utf8",
          env: { ...process.env, GITHUB_ACTIONS: "true" },
        },
      );
      expect(uitvoer).toContain(
        "::warning title=A/B-test per tabel::1 tabel(len) zonder A/B-test: orders",
      );
      expect(uitvoer).not.toContain("feestdagen");
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  });
});
