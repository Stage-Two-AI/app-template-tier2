import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const LIB = resolve(__dirname, "../../scripts/lib/rls-regels.mjs");

// Elke test start een of meer processen (node, de guard). Onder belasting (alle tests tegelijk,
// of de mutaties) duurt dat langer dan de standaard vijf seconden.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Ruim: de standaardbuffer van een proces is 1 MB, en de migraties van een grote app zijn meer
 * (generale repetitie van uitgave 43: `spawnSync node ENOBUFS`).
 */
const RUIME_BUFFER = 256 * 1024 * 1024;

/** De template zelf, of de kopie ervan bij een klant; herkend zoals guard-template dat doet. */
function isDeTemplate(repo: string): boolean {
  return /\/(?:app-template-tier[12]|stack-template(?:-cloudflare|-light)?)(?:\.git)?$/.test(repo);
}

const repo =
  process.env.GITHUB_REPOSITORY ??
  (() => {
    try {
      return execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: resolve(__dirname, "../.."),
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  })();
const inDeTemplate = isDeTemplate(repo);

/** Roept een functie uit scripts/lib/rls-regels.mjs aan, zoals guard-rls.mjs dat doet. */
function roep<T>(functie: string, ...args: unknown[]): T {
  const code = `import(${JSON.stringify(pathToFileURL(LIB).href)}).then((m) => { const a = JSON.parse(process.argv.at(-1)); const r = m[a.f](...a.args); process.stdout.write(JSON.stringify(r instanceof Set ? [...r] : r)); })`;
  return JSON.parse(
    execFileSync(
      "node",
      ["--input-type=module", "-e", code, "--", JSON.stringify({ f: functie, args })],
      { encoding: "utf8", maxBuffer: RUIME_BUFFER },
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

describe("de migraties van een grote app", () => {
  it("leest meer dan 1 MB aan migraties zonder dat de buffer volloopt", () => {
    const map = mkdtempSync(join(tmpdir(), "grote-app-"));
    try {
      const regel = "insert into public.producten (naam) values ('een product met een naam');\n";
      writeFileSync(
        join(map, "1_veel.sql"),
        regel.repeat(Math.ceil((2 * 1024 * 1024) / regel.length)),
      );
      const sql = roep<string>("leesMigraties", map);
      expect(sql.length).toBeGreaterThan(2 * 1024 * 1024);
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  });
});

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
          maxBuffer: RUIME_BUFFER,
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
          maxBuffer: RUIME_BUFFER,
          env: { ...process.env, GITHUB_ACTIONS: "true" },
        },
      );
      expect(uitvoer).toContain(
        "::warning title=A/B-test per tabel::1 tabel(len) zonder A/B-test: orders",
      );
      expect(uitvoer).not.toContain("feestdagen");
      // Geen belofte over een versie die niemand heeft vastgelegd (sinds versie 39 stond er
      // "vanaf de volgende uitgave is dit rood", en dat klopte steeds niet).
      expect(uitvoer).toContain("dit wordt in een latere uitgave verplicht");
      expect(uitvoer).not.toMatch(/volgende uitgave/);
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  });
});

describe("klantportaal: de poort als harde eis (poortIsHardeEis)", () => {
  const hard = (voorwaarde: string, poorten?: string[]) =>
    roep<boolean>("poortIsHardeEis", voorwaarde, ...(poorten ? [poorten] : []));

  it("goed: de poort staat met `and` aan de rest vast, in elke tak van een `or`", () => {
    for (const voorwaarde of [
      "public.is_medewerker()",
      "(select public.is_medewerker())",
      "public.is_goedgekeurde_klant() and auth.uid() = owner_id",
      "auth.uid() = owner_id and (select public.is_goedgekeurde_klant())",
      "public.is_medewerker() or public.is_goedgekeurde_klant()",
      "(public.is_medewerker() and a) or (b and (select public.is_goedgekeurde_klant()))",
      "public.is_medewerker() and (a or b)",
      "public.is_goedgekeurde_klant() and titel = 'a or b' and prijs between 1 and 5",
      '"public"."is_medewerker"()',
      "PUBLIC.IS_MEDEWERKER() AND x",
      // Zoals de database een policy teruggeeft (tests/rls/open-policies.test.ts).
      "((( SELECT auth.uid() AS uid) = user_id) AND ( SELECT public.is_medewerker() AS is_medewerker))",
    ]) {
      expect(hard(voorwaarde), voorwaarde).toBe(true);
    }
  });

  it("fout: zonder poort, of met een poort die er niet toe doet", () => {
    for (const voorwaarde of [
      "auth.uid() = owner_id",
      "true",
      "public.is_medewerker() or true",
      "true or public.is_medewerker()",
      "public.is_medewerker() or auth.uid() = owner_id",
      "public.is_medewerker() or public.is_goedgekeurde_klant() and x or y",
      "not public.is_medewerker()",
      "public.is_medewerker() is not true",
      "public.is_medewerker() = false",
      "coalesce(public.is_medewerker(), true)",
      "auth.uid() = owner_id -- and public.is_medewerker()",
      "/* public.is_medewerker() and */ true",
      "'public.is_medewerker()' = 'x' or true",
      // Zonder schema kan een andere functie met dezelfde naam bedoeld zijn.
      "is_medewerker()",
      "anders.is_medewerker()",
      "anders.public.is_medewerker()",
      "public.is_medewerker_nep()",
      "public.is_medewerker(1)",
      "vlag between false and public.is_medewerker()",
      "case when x and public.is_medewerker() and y then false else true end",
      "((select true from t where y and public.is_medewerker() and z union select true))",
      "exists (select 1 from t where public.is_medewerker())",
      "",
    ]) {
      expect(hard(voorwaarde), voorwaarde).toBe(false);
    }
  });

  it("een eigen poort telt alleen als hij is opgegeven", () => {
    expect(hard("public.is_inkoper() and x")).toBe(false);
    expect(hard("public.is_inkoper() and x", ["is_medewerker", "is_inkoper"])).toBe(true);
  });
});

describe("klantportaal: wat er mis is in de migraties (problemenKlantportaal)", () => {
  type Config = {
    poorten?: Record<string, string>;
    vrijeFuncties?: Record<string, string>;
    openbaar?: Record<string, string>;
    openTabellen?: Record<string, string>;
  };
  const problemen = (sql: string, config: Config = {}) =>
    roep<string[]>("problemenKlantportaal", lees(sql), config);

  /** De functies van de template, kort; zonder is_medewerker en is_goedgekeurde_klant is elk klantportaal rood. */
  const TEMPLATE = `
    create function public.sessie_via_cloudflare() returns boolean language sql security definer as $$ select true $$;
    create function public.is_medewerker() returns boolean language sql security definer as $$ select public.sessie_via_cloudflare() $$;
    create function public.is_goedgekeurde_klant() returns boolean language sql security definer as $$ select true $$;
    create function public.klant_aanmelden() returns void language sql security definer as $$ select 1 $$;
  `;
  const POORT = `create policy "orders_poort" on public.orders as restrictive for all to authenticated
    using (public.is_medewerker() or public.is_goedgekeurde_klant());`;
  /** Een functie die bezoekers zonder account niet mogen uitvoeren. */
  const zonderAnon = (naam: string) =>
    `revoke all on function ${naam} from public, anon; grant execute on function ${naam} to authenticated;`;

  it("de functies van de template alleen: niets mis", () => {
    expect(problemen(TEMPLATE)).toEqual([]);
  });

  it("een policy voor ingelogde gebruikers zonder poort is fout, ook zonder `to`", () => {
    const sql = `${TEMPLATE}
      create policy "eigen" on public.orders for select to authenticated using (auth.uid() = owner_id);
      create policy "iedereen" on public.orders for insert with check (auth.uid() = owner_id);
      create policy "eigen rol" on public.orders for select to verkoper using (auth.uid() = owner_id);
    `;
    expect(problemen(sql)).toEqual([
      'public.orders (policy "iedereen"): geeft bezoekers zonder account (anon of public) toegang, en public.orders staat niet in klantportaal_openbaar',
      'public.orders (policy "eigen"): de using geldt voor iedereen met een e-mailadres, want de poort is er geen harde eis',
      'public.orders (policy "iedereen"): de with check geldt voor iedereen met een e-mailadres, want de poort is er geen harde eis',
    ]);
  });

  it("een policy voor bezoekers zonder account mag alleen op een tabel in klantportaal_openbaar", () => {
    const sql = `${TEMPLATE}
      create policy "bezoeker" on public.producten for select to anon using (zichtbaar);`;
    expect(problemen(sql)).toEqual([
      'public.producten (policy "bezoeker"): geeft bezoekers zonder account (anon of public) toegang, en public.producten staat niet in klantportaal_openbaar',
    ]);
    expect(problemen(sql, { openbaar: { producten: "de catalogus" } })).toEqual([]);
    expect(problemen(sql, { openbaar: { "public.producten": "de catalogus" } })).toEqual([]);
    expect(problemen(sql, { openbaar: { "api.producten": "een andere" } })).toHaveLength(1);
    // Een poort `to authenticated` dekt anon niet; een policy zonder `to` geldt ook voor anon.
    expect(
      problemen(`${TEMPLATE}
        create policy "p" on public.orders as restrictive for all to authenticated using (public.is_medewerker());
        create policy "met naam" on public.orders for select using (klant <> '');`),
    ).toEqual([
      'public.orders (policy "met naam"): geeft bezoekers zonder account (anon of public) toegang, en public.orders staat niet in klantportaal_openbaar',
    ]);
    // Een restrictive policy voor anon geeft niets, en is dus geen probleem.
    expect(
      problemen(`${TEMPLATE}
        create policy "dicht" on public.orders as restrictive for all to anon using (false);`),
    ).toEqual([]);
  });

  it("elke voorwaarde telt: een goede using met een with check zonder poort is fout", () => {
    const sql = `${TEMPLATE}
      create policy "wijzig" on public.orders for update to authenticated
        using (public.is_goedgekeurde_klant() and auth.uid() = owner_id)
        with check (auth.uid() = owner_id);
    `;
    expect(problemen(sql)).toHaveLength(1);
    expect(problemen(sql)[0]).toContain("with check");
  });

  it("de trucs: `or true`, de poort in commentaar, of dezelfde naam in een ander schema", () => {
    for (const voorwaarde of [
      "public.is_medewerker() or true",
      "auth.uid() = owner_id /* public.is_medewerker() */",
      "auth.uid() = owner_id -- and public.is_medewerker()\n",
      "anders.is_medewerker()",
      "is_medewerker()",
    ]) {
      const sql = `${TEMPLATE}
        create schema anders;
        create function anders.is_medewerker() returns boolean language sql as $$ select true $$;
        ${zonderAnon("anders.is_medewerker()")}
        create policy "truc" on public.orders for select to authenticated using (${voorwaarde});`;
      expect(problemen(sql), voorwaarde).toHaveLength(1);
    }
  });

  it("één poort op de hele tabel (restrictive, for all) dekt de policies die er al zijn", () => {
    const eigen = `create policy "eigen" on public.orders for all to authenticated using (auth.uid() = owner_id);`;
    expect(problemen(`${TEMPLATE}${eigen}`)).toHaveLength(1);
    expect(problemen(`${TEMPLATE}${eigen}${POORT}`)).toEqual([]);
    // Een andere tabel is er niet mee gedekt.
    const andere = `create policy "eigen" on public.klachten for select to authenticated using (auth.uid() = owner_id);`;
    expect(problemen(`${TEMPLATE}${andere}${POORT}`)).toHaveLength(1);
    // Een poort per opdracht dekt alleen die opdracht.
    const lezen = `create policy "p" on public.orders as restrictive for select to authenticated using (public.is_medewerker());`;
    const leest = `create policy "leest" on public.orders for select to authenticated using (auth.uid() = owner_id);`;
    expect(problemen(`${TEMPLATE}${leest}${lezen}`)).toEqual([]);
    // Een poort voor insert gebruikt de with check, en zonder with check de using.
    const schrijft = `create policy "schrijft" on public.orders for insert to authenticated with check (auth.uid() = owner_id);`;
    expect(
      problemen(
        `${TEMPLATE}${schrijft} create policy "p" on public.orders as restrictive for insert to authenticated with check (public.is_medewerker());`,
      ),
    ).toEqual([]);
  });

  it("een poort op de tabel die geen poort is, dekt niets", () => {
    const eigen = `create policy "eigen" on public.orders for all to authenticated using (auth.uid() = owner_id);`;
    for (const nep of [
      // Niet restrictive: dan is het een extra ingang, geen poort.
      `create policy "p" on public.orders for all to authenticated using (public.is_medewerker());`,
      // Alleen voor lezen: schrijven gaat er langs.
      `create policy "p" on public.orders as restrictive for select to authenticated using (public.is_medewerker());`,
      // Alleen voor een andere rol.
      `create policy "p" on public.orders as restrictive for all to verkoper using (public.is_medewerker());`,
      `create policy "p" on public.orders as restrictive for all to authenticated using (public.is_medewerker() or true);`,
      `create policy "p" on public.orders as restrictive for all to authenticated using (true) with check (public.is_medewerker());`,
      `create policy "p" on public.orders as restrictive for all to authenticated using (public.is_medewerker()) with check (true);`,
      // Later weer weggehaald, opengezet of naar een andere rol gezet.
      `${POORT} drop policy "orders_poort" on public.orders;`,
      `${POORT} alter policy "orders_poort" on public.orders using (true);`,
      `${POORT} alter policy "orders_poort" on public.orders to verkoper;`,
    ]) {
      expect(problemen(`${TEMPLATE}${eigen}${nep}`).length, nep).toBeGreaterThan(0);
    }
  });

  it("een policy die later goed wordt gemaakt, weggaat of met zijn tabel verdwijnt, is geen probleem meer", () => {
    const fout = `create policy "eigen" on public.orders for select to authenticated using (auth.uid() = owner_id);`;
    expect(
      problemen(
        `${TEMPLATE}${fout} alter policy "eigen" on public.orders using (public.is_goedgekeurde_klant() and auth.uid() = owner_id);`,
      ),
    ).toEqual([]);
    expect(problemen(`${TEMPLATE}${fout} drop policy if exists "eigen" on public.orders;`)).toEqual(
      [],
    );
    expect(problemen(`${TEMPLATE}${fout} drop table if exists public.orders cascade;`)).toEqual([]);
    // Een policy die naar authenticated gaat, telt weer.
    const andereRol = `create policy "eigen" on public.orders for select to verkoper using (auth.uid() = owner_id);`;
    expect(
      problemen(`${TEMPLATE}${andereRol} alter policy "eigen" on public.orders to authenticated;`),
    ).toHaveLength(1);
  });

  it("tabellen: RLS aan en een policy, na de laatste create, drop of disable", () => {
    const tabel = (rest: string) => `${TEMPLATE} create table public.orders (id int); ${rest}`;
    const rls = "alter table public.orders enable row level security;";
    const policy = `create policy "p" on public.orders for select to authenticated using (public.is_medewerker());`;
    expect(problemen(tabel(`${rls}${policy}`))).toEqual([]);
    expect(problemen(tabel(policy))).toEqual([
      "public.orders: row level security staat niet aan (na de laatste create of disable)",
    ]);
    expect(problemen(tabel(rls))).toEqual([
      "public.orders: row level security staat aan, maar er is geen enkele policy",
    ]);
    for (const later of [
      "alter table public.orders disable row level security;",
      "alter table only public.orders disable row level security;",
      "drop table public.orders; create table public.orders (id int);",
      `drop table public.orders; create table public.orders (id int); ${rls}`,
    ]) {
      expect(problemen(tabel(`${rls}${policy}${later}`)).length, later).toBe(1);
    }
    for (const nieuw of [
      "create unlogged table public.wachtrij (id int);",
      "create table if not exists public.wachtrij (id int);",
      "select * into public.wachtrij from public.orders;",
      "select * into unlogged table public.wachtrij from public.orders;",
      "create table public.wachtrij as select * from public.orders;",
      "create schema intern; create table intern.wachtrij (id int); alter table intern.wachtrij set schema public;",
      "create table public.oud (id int); alter table public.oud rename to wachtrij;",
    ]) {
      expect(problemen(`${TEMPLATE}${nieuw}`), nieuw).toEqual([
        "public.wachtrij: row level security staat niet aan (na de laatste create of disable)",
      ]);
    }
    // Een tijdelijke tabel bestaat alleen tijdens de migratie; een tabel in een ander schema
    // ziet de tekst niet (de databasecontrole wel).
    expect(problemen(`${TEMPLATE} create temp table x (id int); select 1 into temp y;`)).toEqual(
      [],
    );
    expect(problemen(`${TEMPLATE} create foreign table public.extern (id int) server s;`)).toEqual([
      "public.extern: een foreign table kent geen row level security",
    ]);
    expect(problemen(`${TEMPLATE} create materialized view public.telling as select 1;`)).toEqual([
      "public.telling: een materialized view kent geen row level security",
    ]);
    expect(
      problemen(
        `${TEMPLATE} create materialized view public.telling as select 1; drop materialized view public.telling;`,
      ),
    ).toEqual([]);
  });

  it("dynamische SQL ziet de tekst niet, en zegt dat", () => {
    expect(
      roep<boolean>(
        "heeftDynamischeSql",
        "do $$ begin execute format('create table %I (id int)', 'x'); end $$;",
      ),
    ).toBe(true);
    expect(roep<boolean>("heeftDynamischeSql", "do $$ begin perform 1; end $$;")).toBe(false);
  });

  it("open_tabellen moet leeg zijn", () => {
    expect(problemen(TEMPLATE, { openTabellen: { feestdagen: "kalender" } })).toEqual([
      'open_tabellen.feestdagen: een klantportaal kent geen open tabellen, want "iedereen binnen" is daar iedereen met een e-mailadres',
    ]);
  });

  it("een security definer-functie die iemand mag aanroepen, staat op de vrije lijst: een poort erin is geen bewijs", () => {
    const naam = "public.alle_orders()";
    const functie = (inhoud: string, extra = zonderAnon(naam), soort = "function") => `${TEMPLATE}
      create ${soort} public.alle_orders() returns int language sql security definer as $$ ${inhoud} $$; ${extra}`;
    const fout =
      "public.alle_orders: security definer (hij leest met de rechten van zijn eigenaar), en iedereen met een e-mailadres mag hem uitvoeren";
    expect(problemen(functie("select count(*) from public.orders"))).toEqual([fout]);
    for (const inhoud of [
      "select count(*) from public.orders where public.is_medewerker()",
      "perform public.is_medewerker(); return 1",
      "select 1 where public.is_medewerker() or true",
    ]) {
      expect(problemen(functie(inhoud)), inhoud).toEqual([fout]);
    }
    expect(problemen(functie("select 1", zonderAnon(naam), "procedure"))).toEqual([fout]);
    // Een recht dat alleen voor anon overblijft, telt ook.
    expect(
      problemen(
        functie(
          "select 1",
          `revoke all on function ${naam} from public, authenticated; grant execute on function ${naam} to anon;`,
        ),
      ),
    ).toEqual([
      "public.alle_orders: bezoekers zonder account (anon) mogen hem uitvoeren; trek dat in (revoke execute ... from public, anon) of zet hem in klantportaal_openbaar",
      fout,
    ]);
    expect(
      problemen(
        functie("select 1", `revoke all on function ${naam} from public, anon, authenticated;`),
      ),
    ).toEqual([]);
    expect(
      problemen(functie("select 1"), { vrijeFuncties: { alle_orders: "telt alleen" } }),
    ).toEqual([]);
    // Een basisfunctie in een ander schema is geen basisfunctie.
    expect(
      problemen(
        `${TEMPLATE} create function api.klant_aanmelden() returns void language sql security definer as $$ select 1 $$; ${zonderAnon("api.klant_aanmelden()")}`,
      ),
    ).toHaveLength(1);
    // security definer later aangezet, of geërfd door een variant ernaast.
    expect(
      problemen(
        `${TEMPLATE} create function public.f() returns int language sql as $$ select 1 $$; ${zonderAnon("public.f()")} alter function public.f() security definer;`,
      ),
    ).toHaveLength(1);
    expect(
      problemen(
        `${TEMPLATE} create function public.f() returns int language sql security definer as $$ select 1 $$; create function public.f(x int) returns int language sql as $$ select x $$; ${zonderAnon("public.f()")} ${zonderAnon("public.f(int)")}`,
      ),
    ).toHaveLength(1);
  });

  it("een functie die bezoekers zonder account mogen uitvoeren, staat in klantportaal_openbaar", () => {
    const sql = `${TEMPLATE} create function public.tel() returns int language sql as $$ select 1 $$;`;
    const fout =
      "public.tel: bezoekers zonder account (anon) mogen hem uitvoeren; trek dat in (revoke execute ... from public, anon) of zet hem in klantportaal_openbaar";
    expect(problemen(sql)).toEqual([fout]);
    expect(problemen(sql, { openbaar: { tel: "telt alleen" } })).toEqual([]);
    // Alleen `public` intrekken is niet genoeg: Supabase geeft anon het recht ook rechtstreeks.
    expect(problemen(`${sql} revoke execute on function public.tel() from public;`)).toEqual([
      fout,
    ]);
    expect(problemen(`${sql} revoke execute on function public.tel() from public, anon;`)).toEqual(
      [],
    );
    // De standaardrechten voor nieuwe functies tellen ook, voor public en voor anon apart.
    const zonderStandaard =
      "alter default privileges in schema public revoke execute on functions from public, anon;";
    expect(
      problemen(
        `${TEMPLATE}${zonderStandaard} create function public.tel() returns int language sql as $$ select 1 $$;`,
      ),
    ).toEqual([]);
    expect(
      problemen(
        `${TEMPLATE} alter default privileges revoke execute on functions from public; create function public.tel() returns int language sql as $$ select 1 $$;`,
      ),
    ).toEqual([fout]);
    expect(
      problemen(
        `${TEMPLATE}${zonderStandaard} alter default privileges grant execute on functions to public; create function public.tel() returns int language sql as $$ select 1 $$;`,
      ),
    ).toEqual([fout]);
    // Rechten op alle functies in een schema.
    expect(
      problemen(`${sql} revoke execute on all functions in schema public from public, anon;`),
    ).toEqual([]);
  });

  it("een gewone functie (security invoker) en een functie achter een trigger hoeven geen poort", () => {
    const sql = `${TEMPLATE}
      create function public.tel() returns int language sql as $$ select count(*) from public.orders $$;
      ${zonderAnon("public.tel()")}
      create function public.bij_wijziging() returns trigger language plpgsql security definer as $$ begin return new; end $$;
    `;
    expect(problemen(sql)).toEqual([]);
  });

  it("een eigen poort moet bestaan, in language sql, met een poort van de template als harde eis", () => {
    const poorten = { is_inkoper: "medewerker van inkoop" };
    const policy = `create policy "inkoop" on public.orders for select to authenticated using (public.is_inkoper());`;
    const functie = (inhoud: string, taal = "sql") =>
      `create function public.is_inkoper() returns boolean language ${taal} security definer as $$ ${inhoud} $$; ${zonderAnon("public.is_inkoper()")}`;
    const goed = functie(
      "select public.is_medewerker() and exists (select 1 from public.inkopers where id = auth.uid())",
    );
    expect(problemen(`${TEMPLATE}${goed}${policy}`, { poorten })).toEqual([]);
    expect(problemen(`${TEMPLATE}${goed}${policy}`)).toHaveLength(2);
    const fout =
      "public.is_inkoper: een eigen poort moet een functie in language sql zijn die één uitdrukking teruggeeft, met public.is_medewerker() of public.is_goedgekeurde_klant() als harde eis (select public.is_medewerker() and ...). Wat de poort verder doet, is de zorg van de app";
    for (const [inhoud, taal] of [
      ["select true", "sql"],
      ["select public.is_goedgekeurde_klant() or exists (select 1 from public.klanten)", "sql"],
      ["select public.is_inkoper()", "sql"],
      ["select public.is_verkoper() and true", "sql"],
      ["select true from public.x where public.is_medewerker()", "sql"],
      ["begin return public.is_medewerker(); end", "plpgsql"],
      ["select 1; select public.is_medewerker()", "sql"],
    ]) {
      expect(
        problemen(`${TEMPLATE}${functie(inhoud ?? "", taal)}${policy}`, {
          poorten: { ...poorten, is_verkoper: "verkoop" },
        }).filter((p) => !p.startsWith("klantportaal_poorten.is_verkoper")),
        inhoud,
      ).toEqual([fout]);
    }
    expect(problemen(`${TEMPLATE}${policy}`, { poorten })).toEqual([
      "klantportaal_poorten.is_inkoper: er is geen functie public.is_inkoper()",
    ]);
  });

  it("is_medewerker() herschrijven zonder sessie_via_cloudflare() is fout", () => {
    const sql = `${TEMPLATE}
      create or replace function public.is_medewerker() returns boolean language sql security definer as $$ select true $$;`;
    expect(problemen(sql)).toEqual([
      "public.is_medewerker(): moet public.sessie_via_cloudflare() aanroepen, anders is een mailsessie ook medewerker",
    ]);
  });

  it("zonder de migratie van het klantportaal is de schakelaar rood", () => {
    expect(
      problemen("create policy x on public.orders for select to verkoper using (true);"),
    ).toEqual([
      "public.is_medewerker() ontbreekt: neem de migratie van het klantportaal over uit de template",
      "public.is_goedgekeurde_klant() ontbreekt: neem de migratie van het klantportaal over uit de template",
    ]);
  });

  it("een view gaat langs de policies heen, tenzij hij security_invoker heeft of op de vrije lijst staat", () => {
    const view = (rest: string, of = "create") =>
      `${TEMPLATE} ${of} view public.overzicht ${rest};`;
    const fout =
      "public.overzicht: een view zonder security_invoker gaat langs de policies heen (hij leest met de rechten van zijn eigenaar)";
    expect(problemen(view("as select * from public.orders"))).toEqual([fout]);
    expect(problemen(view("as select * from public.orders", "create or replace"))).toEqual([fout]);
    expect(problemen(view("with (security_invoker = false) as select 1"))).toHaveLength(1);
    // Een poort in de vraag is geen bewijs.
    expect(
      problemen(view("as select *, public.is_medewerker() as mag from public.orders")),
    ).toEqual([fout]);
    expect(
      problemen(view("with (security_invoker = true) as select * from public.orders")),
    ).toEqual([]);
    expect(
      problemen(view("as select 1"), { vrijeFuncties: { overzicht: "alleen tellingen" } }),
    ).toEqual([]);
    expect(
      problemen(`${view("as select 1")} alter view public.overzicht set (security_invoker = on);`),
    ).toEqual([]);
    expect(
      problemen(
        `${view("with (security_invoker = true) as select 1")} alter view public.overzicht reset (security_invoker);`,
      ),
    ).toEqual([fout]);
  });
});

/**
 * Deze twee lezen de migraties en docs/WERKWIJZE.md van de template: de migratie van het
 * klantportaal en het voorbeeld items. Een app heeft eigen tabellen (en vaak nog geen
 * klantportaal), dus daar slaan ze over; anders was elke update-PR rood (uitgave 43).
 */
describe.runIf(inDeTemplate)("klantportaal: de template zelf", () => {
  const migraties = () =>
    roep<string>("leesMigraties", resolve(__dirname, "../../supabase/migrations"));
  const problemen = (sql: string) => roep<string[]>("problemenKlantportaal", sql, {});

  it("de tabel klanten en de functies van het klantportaal gaan door de poort; het voorbeeld items nog niet", () => {
    const gevonden = problemen(migraties());
    expect(gevonden.length).toBeGreaterThan(0);
    for (const probleem of gevonden) expect(probleem).toMatch(/^public\.items \(policy "/);
  });

  it("met de ene poort uit docs/WERKWIJZE.md klopt ook het voorbeeld", () => {
    const werkwijze = readFileSync(resolve(__dirname, "../../docs/WERKWIJZE.md"), "utf8");
    const poort = /create policy "items_poort"[\s\S]*?;/.exec(werkwijze)?.[0];
    expect(poort, "het voorbeeld van de poort staat in docs/WERKWIJZE.md").toBeDefined();
    expect(problemen(`${migraties()}\n${poort}`)).toEqual([]);
  });
});

describe("scripts/guard-rls.mjs: de schakelaar klantportaal", () => {
  type Geval = { config: Record<string, unknown>; sql: string | null };
  const RLS = "alter table public.a enable row level security;";
  const EIGEN =
    "create policy a_eigen on public.a for all to authenticated using (auth.uid() = owner_id);";
  const GEVALLEN: Record<string, Geval> = {
    "geen migraties": { config: { database: true }, sql: null },
    "geen database": { config: { database: false }, sql: "create table public.a (id int);" },
    "tabel zonder rls": { config: { database: true }, sql: "create table public.a (id int);" },
    "rls zonder policy": {
      config: { database: true },
      sql: `create table public.a (id int); ${RLS}`,
    },
    "eigen rijen": {
      config: { database: true },
      sql: `create table public.a (id int, owner_id uuid); ${RLS} ${EIGEN}`,
    },
    "open zonder reden": {
      config: { database: true },
      sql: `create table public.a (id int); ${RLS} create policy a_open on public.a for select to authenticated using (true);`,
    },
    "open met reden": {
      config: { database: true, open_tabellen: { a: "kalender" } },
      sql: `create table public.a (id int); ${RLS} create policy a_open on public.a for select to authenticated using (true);`,
    },
    "leesrol schrijft": {
      config: { database: true, leesrollen: ["lezer"] },
      sql: `create table public.a (id int); ${RLS} create policy a_eigen on public.a for select to authenticated using (auth.uid() = id); grant insert on public.a to lezer;`,
    },
    "definer zonder poort en view": {
      config: { database: true },
      sql: `create table public.a (id int, owner_id uuid); ${RLS} ${EIGEN} create function public.alles() returns setof public.a language sql security definer as $$ select * from public.a $$; create view public.v as select * from public.a;`,
    },
    "alleen functies": {
      config: { database: true },
      sql: "create function public.f() returns int language sql as $$ select 1 $$;",
    },
  };

  /**
   * Het oordeel van guard-rls.mjs zoals het vóór de schakelaar was (uitgave 42), per geval: een
   * vingerafdruk van de afsluitcode en alles wat de guard schreef. Opgenomen met de guard van
   * toen; zolang een app de schakelaar niet zet, moet dit exact gelijk blijven.
   */
  const ZOALS_VOORHEEN: Record<string, string> = {
    "geen migraties": "99f8343138605c98",
    "geen database": "e169ee2b6919bcf2",
    "tabel zonder rls": "f5502d31eff5b47e",
    "rls zonder policy": "78a823f66ee5334f",
    "eigen rijen": "b54a1aed5f373dde",
    "open zonder reden": "ab6fcba28e3e2c33",
    "open met reden": "b54a1aed5f373dde",
    "leesrol schrijft": "502b83eda5a32a9f",
    "definer zonder poort en view": "b54a1aed5f373dde",
    "alleen functies": "5278943b9e6a32b2",
  };

  function draai(geval: Geval, extra: Record<string, unknown> = {}) {
    const map = mkdtempSync(join(tmpdir(), "guard-rls-"));
    try {
      writeFileSync(join(map, "stack.config.json"), JSON.stringify({ ...geval.config, ...extra }));
      if (geval.sql !== null) {
        mkdirSync(join(map, "supabase/migrations"), { recursive: true });
        writeFileSync(join(map, "supabase/migrations/1_x.sql"), geval.sql);
      }
      const uitkomst = spawnSync("node", [resolve(__dirname, "../../scripts/guard-rls.mjs")], {
        cwd: map,
        encoding: "utf8",
        maxBuffer: RUIME_BUFFER,
      });
      const alles = JSON.stringify([uitkomst.status, uitkomst.stdout, uitkomst.stderr]);
      return {
        status: uitkomst.status,
        fout: uitkomst.stderr,
        vingerafdruk: createHash("sha256").update(alles).digest("hex").slice(0, 16),
      };
    } finally {
      rmSync(map, { recursive: true, force: true });
    }
  }

  it("zonder de schakelaar oordeelt de guard exact zoals voorheen", () => {
    for (const [naam, geval] of Object.entries(GEVALLEN)) {
      for (const extra of [
        {},
        { klantportaal: false },
        // De lijsten alleen doen niets: de schakelaar moet aan staan.
        { klantportaal_poorten: { x: "y" }, klantportaal_vrije_functies: { z: "y" } },
      ]) {
        expect(draai(geval, extra).vingerafdruk, `${naam} ${JSON.stringify(extra)}`).toBe(
          ZOALS_VOORHEEN[naam],
        );
      }
    }
  });

  it("met de schakelaar is wat voorheen groen was rood, met de regel erbij", () => {
    for (const naam of ["eigen rijen", "open met reden", "definer zonder poort en view"]) {
      const geval = GEVALLEN[naam];
      if (!geval) throw new Error(`Geval ${naam} ontbreekt.`);
      expect(draai(geval).status, naam).toBe(0);
      const aan = draai(geval, { klantportaal: true });
      expect(aan.status, naam).toBe(1);
      expect(aan.fout).toContain("Klantportaal: iemand met alleen een e-mailadres kan hier iets.");
      expect(aan.fout).toContain("as restrictive for all to authenticated");
    }
  });

  it("met de schakelaar en de poort op de tabel is de guard groen", () => {
    const sql = `
      create function public.sessie_via_cloudflare() returns boolean language sql security definer as $$ select true $$;
      create function public.is_medewerker() returns boolean language sql security definer as $$ select public.sessie_via_cloudflare() $$;
      create function public.is_goedgekeurde_klant() returns boolean language sql security definer as $$ select true $$;
      create table public.a (id int, owner_id uuid); ${RLS} ${EIGEN}
      create policy a_poort on public.a as restrictive for all to authenticated
        using (public.is_medewerker() or public.is_goedgekeurde_klant());`;
    expect(draai({ config: { database: true }, sql }, { klantportaal: true }).status).toBe(0);
  });

  it("een tikfout in een sleutel is rood, met de bedoelde sleutel erbij", () => {
    for (const sleutel of ["klantPortaal", "klant_portaal", "klantportaal ", "Klantportaal"]) {
      const uitkomst = draai(GEVALLEN["eigen rijen"] as Geval, { [sleutel]: true });
      expect(uitkomst.status, sleutel).toBe(1);
      expect(uitkomst.fout).toContain(`"${sleutel}": bedoel je "klantportaal"?`);
    }
    const ander = draai(GEVALLEN["geen database"] as Geval, { open_tabelen: {} });
    expect(ander.status).toBe(1);
    expect(ander.fout).toContain('"open_tabelen": bedoel je "open_tabellen"?');
  });

  it("alle sleutels die apps nu kennen, en uitleg met $, zijn goed", () => {
    const config = {
      $beschrijving: ["uitleg"],
      $opmerking: "eigen uitleg",
      testmail: "test@voorbeeld.nl",
      open_tabellen: {},
      leesrollen: [],
      testdatabase: { project_ref: "abcdefghijklmnopqrst", anon_key: "sb_publishable_abcdefghijk" },
      klantportaal: false,
      klantportaal_poorten: {},
      klantportaal_vrije_functies: {},
      klantportaal_openbaar: {},
    };
    expect(draai(GEVALLEN["eigen rijen"] as Geval, config).vingerafdruk).toBe(
      ZOALS_VOORHEEN["eigen rijen"],
    );
    const gedeeld = draai(
      { config: { database: "gedeeld" }, sql: null },
      { gedeelde_database: { eigenaar: "Klant/erp", project_ref: "abcdefghijklmnopqrst" } },
    );
    expect(gedeeld.status).toBe(0);
  });

  it("de schakelaar zonder eigen database is rood", () => {
    for (const database of ["gedeeld", false]) {
      const uitkomst = draai({ config: { database }, sql: null }, { klantportaal: true });
      expect(uitkomst.status, String(database)).toBe(1);
      expect(uitkomst.fout).toContain('"klantportaal": true hoort bij een eigen database');
    }
  });

  it("met de schakelaar zegt de guard dat de sluitende controle op de database draait", () => {
    const rood = draai(GEVALLEN["eigen rijen"] as Geval, { klantportaal: true });
    expect(rood.fout).toContain(
      "Dit is een snelle controle op de tekst. De sluitende controle draait in de Kwaliteitspoort",
    );
  });

  it("met de schakelaar en een namen-lijst met een fout is de guard rood", () => {
    // Een app die met de schakelaar groen is; alleen de lijst maakt hem rood.
    const groen = {
      config: { database: true },
      sql: `
        create function public.sessie_via_cloudflare() returns boolean language sql security definer as $$ select true $$;
        create function public.is_medewerker() returns boolean language sql security definer as $$ select public.sessie_via_cloudflare() $$;
        create function public.is_goedgekeurde_klant() returns boolean language sql security definer as $$ select true $$;`,
    };
    expect(draai(groen, { klantportaal: true }).status).toBe(0);
    for (const [sleutel, waarde, melding] of [
      ["klantportaal_poorten", { "is_inkoper()": "x" }, "is geen naam die de poort kent"],
      [
        "klantportaal_vrije_functies",
        { f: "" },
        "bij klantportaal_vrije_functies.f hoort een reden",
      ],
      [
        "klantportaal_vrije_functies",
        { f: "  " },
        "bij klantportaal_vrije_functies.f hoort een reden",
      ],
      ["klantportaal_openbaar", { "bucket:": "x" }, "is geen naam die de poort kent"],
      ["klantportaal_openbaar", [], "hoort een object te zijn"],
      [
        "open_tabellen",
        { feestdagen: "kalender" },
        "open_tabellen.feestdagen: een klantportaal kent geen open tabellen",
      ],
    ] as const) {
      const uitkomst = draai(groen, { klantportaal: true, [sleutel]: waarde });
      expect(uitkomst.status, sleutel).toBe(1);
      expect(uitkomst.fout, sleutel).toContain(melding);
    }
  });

  it("zegt het als de schakelaar geen true of false is", () => {
    const uitkomst = draai(GEVALLEN["eigen rijen"] as Geval, { klantportaal: "ja" });
    expect(uitkomst.status).not.toBe(0);
    expect(uitkomst.fout).toContain("kies true of false");
  });
});
