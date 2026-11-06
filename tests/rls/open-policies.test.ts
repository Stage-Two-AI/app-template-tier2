import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vraagDatabase } from "./lib/database";

/**
 * De beveiligingsregels zoals ze echt in de database staan, na alle migraties. Nauwkeuriger
 * dan guard-rls.mjs (die de tekst van de migraties leest): dit ziet ook policies die in een
 * functie zijn gemaakt of later zijn weggegooid.
 *
 * Deze test is van de template en komt met elke versie mee. Uitzonderingen staan in
 * stack.config.json (`open_tabellen`, `leesrollen`), niet hier.
 */

/** De uitzonderingen uit stack.config.json; guard-rls.mjs controleert de vorm al. */
const config = JSON.parse(readFileSync("stack.config.json", "utf8")) as {
  open_tabellen?: Record<string, string>;
  leesrollen?: string[];
};

type OpenPolicy = {
  tablename: string;
  policyname: string;
  rollen: string[];
  cmd: string;
};

const OPEN_POLICIES = `
  select tablename, policyname, roles::text[] as rollen, cmd
  from pg_policies
  where schemaname = 'public'
    and (trim(coalesce(qual, '')) in ('true', '(true)')
      or trim(coalesce(with_check, '')) in ('true', '(true)'))
  order by tablename, policyname`;

describe("policies met using (true)", () => {
  const open = config.open_tabellen ?? {};
  const policies = vraagDatabase<OpenPolicy>(OPEN_POLICIES);

  it("nooit voor anon of public (iedereen met de openbare sleutel)", () => {
    const fout = policies
      .filter((p) => p.rollen.some((rol) => rol === "anon" || rol === "public"))
      .map((p) => `${p.tablename} (policy "${p.policyname}", ${p.rollen.join(", ")})`);
    expect(fout, "policy met using (true) voor iedereen met de openbare sleutel").toEqual([]);
  });

  it("voor authenticated of een eigen rol alleen op een tabel in open_tabellen", () => {
    const fout = policies
      .filter((p) => !(p.tablename in open))
      .map((p) => `${p.tablename} (policy "${p.policyname}")`);
    expect(
      fout,
      "policy met using (true) zonder regel in open_tabellen (stack.config.json)",
    ).toEqual([]);
  });
});

type Recht = { grantee: string; schema: string; tabel: string; recht: string };

describe("leesrollen", () => {
  const leesrollen = (config.leesrollen ?? []).map((r) => r.toLowerCase());

  it.skipIf(leesrollen.length === 0)(
    "mogen alleen lezen: schrijven gaat via een functie in de app die de database beheert",
    () => {
      const lijst = leesrollen.map((r) => `'${r.replaceAll("'", "''")}'`).join(", ");
      const rechten = vraagDatabase<Recht>(`
        select grantee, table_schema as schema, table_name as tabel, privilege_type as recht
        from information_schema.role_table_grants
        where lower(grantee) in (${lijst})
          and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
        union
        select grantee, table_schema, table_name, privilege_type || ' (kolom ' || column_name || ')'
        from information_schema.column_privileges
        where lower(grantee) in (${lijst})
          and privilege_type in ('INSERT', 'UPDATE')
        order by 1, 2, 3, 4`);
      expect(
        rechten.map((r) => `${r.grantee}: ${r.recht} op ${r.schema}.${r.tabel}`),
        "een leesrol mag alleen select",
      ).toEqual([]);
    },
  );
});
