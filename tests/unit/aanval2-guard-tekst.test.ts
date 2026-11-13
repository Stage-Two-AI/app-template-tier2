import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AANVAL ronde 2, doel 1 (alleen de tekst van de migraties) en doel 2 (de schakelaar).
 *
 * Elke test SLAAGT als de aanval lukt: de echte `scripts/guard-rls.mjs` is groen op iets wat
 * bij een klantportaal open staat. Wat de database zelf ervan vindt en of het via de API echt
 * lekt, staat in tests/rls/aanval2-guard.test.ts (draait alleen met een lokale Supabase).
 */

const REPO = resolve(__dirname, "../..");

const BASIS = `
create policy "items_poort" on public.items as restrictive for all to authenticated
  using (public.is_medewerker() or public.is_goedgekeurde_klant());
create table public.dossiers (id uuid primary key, klant text not null, geheim text not null);
alter table public.dossiers enable row level security;
grant select on public.dossiers to authenticated;
create policy "dossiers_medewerker" on public.dossiers for all to authenticated
  using (public.is_medewerker()) with check (public.is_medewerker());
`;

function guardRls(
  config: Record<string, unknown>,
  migraties: Record<string, string> = {},
): { code: number | null; uit: string } {
  const map = mkdtempSync(join(tmpdir(), "aanval2-tekst-"));
  try {
    mkdirSync(join(map, "supabase/migrations"), { recursive: true });
    for (const naam of readdirSync(join(REPO, "supabase/migrations"))) {
      cpSync(join(REPO, "supabase/migrations", naam), join(map, "supabase/migrations", naam));
    }
    for (const [naam, sql] of Object.entries(migraties)) {
      writeFileSync(join(map, "supabase/migrations", naam), sql);
    }
    writeFileSync(join(map, "stack.config.json"), JSON.stringify(config));
    const r = spawnSync("node", [join(REPO, "scripts/guard-rls.mjs")], {
      cwd: map,
      encoding: "utf8",
    });
    return { code: r.status, uit: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(map, { recursive: true, force: true });
  }
}

const PORTAAL = { database: true, klantportaal: true, open_tabellen: {} };
const metAanval = (sql: string) =>
  guardRls(PORTAAL, { "20261201000000_basis.sql": BASIS, "20261202000000_aanval.sql": sql });

describe("opzet", () => {
  it("met de schakelaar aan is de guard groen op de basis en rood op een policy zonder poort", () => {
    expect(metAanval("select 1;").code).toBe(0);
    const rood = metAanval(
      `create policy "dossiers_eigen" on public.dossiers for select to authenticated using (klant = 'x');`,
    );
    expect(rood.code).toBe(1);
    expect(rood.uit).toContain("Klantportaal");
  });
});

describe("AANVAL2 doel 1: een tabel zonder RLS die de guard niet als tabel ziet", () => {
  // De databasecontrole kijkt nergens of RLS aan staat (zie aanval2-guard.test.ts, 1.1 en 1.2),
  // dus wat de tekstguard hier mist, vangt niets anders.
  const gevallen: [string, string][] = [
    [
      "1.20 `create unlogged table`",
      "create unlogged table public.dossiers_wachtrij (id int, geheim text);",
    ],
    ["1.21 `select ... into`", "select * into public.dossiers_kopie from public.dossiers;"],
    [
      "1.22 een tabel die uit een ander schema naar public verhuist",
      "create schema intern; create table intern.notities (id int, tekst text); alter table intern.notities set schema public;",
    ],
    [
      "1.23 een foreign table",
      "create foreign table public.extern_klanten (id int, naam text) server boekhouding;",
    ],
    [
      "1.24 een tabel uit dynamische SQL",
      "do $$ begin execute format('create table %I.%I (id int, geheim text)', 'public', 'dossiers_2026'); end $$;",
    ],
    [
      "1.25 een tabel die opnieuw wordt gemaakt: de oude `enable row level security` telt nog",
      "drop table public.dossiers; create table public.dossiers (id uuid primary key, klant text, geheim text);",
    ],
    [
      "1.26 RLS weer uit in een latere migratie",
      "alter table public.dossiers disable row level security;",
    ],
    [
      "1.27 een materialized view (de tekstguard kent hem niet; de databasecontrole wel, als authenticated erbij kan)",
      "create materialized view public.dossiers_telling as select klant, geheim from public.dossiers;",
    ],
  ];
  for (const [naam, sql] of gevallen) {
    it(`${naam}: GELUKT ALS guard:rls groen blijft`, () => {
      const uitkomst = metAanval(sql);
      expect(uitkomst.code, uitkomst.uit).toBe(0);
    });
  }

  it("1.28 GELUKT ALS: een functie in klantportaal_vrije_functies mag alles teruggeven, als er maar een reden bij staat", () => {
    const uitkomst = guardRls(
      { ...PORTAAL, klantportaal_vrije_functies: { alle_dossiers: "nodig voor het overzicht" } },
      {
        "20261201000000_basis.sql": BASIS,
        "20261202000000_aanval.sql":
          "create function public.alle_dossiers() returns setof public.dossiers language sql security definer set search_path = '' as $$ select * from public.dossiers $$;",
      },
    );
    expect(uitkomst.code, uitkomst.uit).toBe(0);
  });
});

describe("AANVAL2 doel 2: de schakelaar zelf", () => {
  // De template zoals hij is: `items` met "alleen je eigen rijen", zonder poort. Bij een
  // klantportaal schrijft iedereen met een mailadres daar zijn eigen rijen in.
  it("2.1 GELUKT ALS: zonder de schakelaar is alles groen, ook als de app als klantportaal is ingericht", () => {
    const uitkomst = guardRls({ database: true, open_tabellen: {} });
    expect(uitkomst.code, uitkomst.uit).toBe(0);
    expect(guardRls(PORTAAL).code, "met de schakelaar is dezelfde app rood").toBe(1);
  });

  it("2.2 GELUKT ALS: een tikfout in de naam van de schakelaar zet hem stil uit", () => {
    for (const sleutel of ["klantPortaal", "klant_portaal", "klantportaal ", "Klantportaal"]) {
      const uitkomst = guardRls({ database: true, open_tabellen: {}, [sleutel]: true });
      expect(uitkomst.code, `${sleutel}: ${uitkomst.uit}`).toBe(0);
    }
  });

  it('2.3 GELUKT ALS: met "database": "gedeeld" slaat de guard alles over, ook met de schakelaar aan', () => {
    const uitkomst = guardRls({ database: "gedeeld", klantportaal: true });
    expect(uitkomst.code, uitkomst.uit).toBe(0);
  });

  it("2.4 GELUKT ALS: de controle op de database slaat zichzelf over zolang de schakelaar uit staat", () => {
    const test = readFileSync(join(REPO, "tests/rls/open-policies.test.ts"), "utf8");
    expect(test).toContain("it.skipIf(config.klantportaal !== true)");
  });
});
