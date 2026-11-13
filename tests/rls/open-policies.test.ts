import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vraagDatabase } from "./lib/database";
import {
  leesSchakelaar,
  problemenKlantportaalInDatabase,
  vrijgegeven,
} from "./lib/klantportaal-poort";

/**
 * De beveiligingsregels zoals ze echt in de database staan, na alle migraties. Nauwkeuriger
 * dan guard-rls.mjs (die de tekst van de migraties leest): dit ziet ook policies die in een
 * functie zijn gemaakt of later zijn weggegooid.
 *
 * Deze test is van de template en komt met elke versie mee. Uitzonderingen staan in
 * stack.config.json (`open_tabellen`, `leesrollen`, en bij een klantportaal
 * `klantportaal_poorten`, `klantportaal_vrije_functies` en `klantportaal_openbaar`), niet hier.
 */

/** open_tabellen en leesrollen uit stack.config.json; guard-rls.mjs controleert de vorm al. */
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

describe("klantportaal", () => {
  // De schakelaar, streng gelezen zoals guard:rls dat doet: een onbekende sleutel, een afwijkende
  // waarde ("true", 1) of een bestand dat geen JSON is, is hier een fout en geen overslaan.
  // Met `"klantportaal": true` volgt de sluitende controle van de app zelf. De regels staan in
  // scripts/lib/klantportaal-database.mjs en in docs/WERKWIJZE.md. Dat de controle zelf werkt,
  // ook zonder de schakelaar, bewijst tests/rls/klantportaal-controle.test.ts.
  const schakelaar = leesSchakelaar();

  it("de schakelaar in stack.config.json is te lezen", () => {
    expect(schakelaar.fout, "stack.config.json (zie de melding van guard:rls)").toBeUndefined();
  });

  it.skipIf(schakelaar.aan !== true)(
    "wie alleen een e-mailadres heeft, of geen account, mag niets: de database zoals hij na alle migraties is",
    () => {
      const portaal = schakelaar.aan === true ? schakelaar.config : {};
      // Bij elke run zichtbaar in het logboek: wat iemand zonder goedkeuring of zonder account mag.
      const vrij = vrijgegeven(portaal);
      console.log(
        vrij.length === 0
          ? "Klantportaal: er is niets vrijgegeven (klantportaal_poorten, klantportaal_vrije_functies en klantportaal_openbaar zijn leeg)."
          : `Klantportaal: vrijgegeven, met de reden uit stack.config.json:\n${vrij.map((r) => `  - ${r}`).join("\n")}`,
      );
      const problemen = problemenKlantportaalInDatabase(portaal);
      expect(problemen, "zie docs/WERKWIJZE.md, het stuk over het klantportaal").toEqual([]);
    },
  );
});
