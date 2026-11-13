import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { vraagDatabase } from "./lib/database";
import { beoordeel, type KlantportaalConfig, leesModel } from "./lib/klantportaal-poort";

/**
 * De databasecontrole van een klantportaal, zelf getest: elke manier om de poort te omzeilen
 * die een aanvaller tot nu toe vond, wordt in een transactie op de echte database gezet, de
 * controle moet hem afkeuren, en daarna gaat alles terug. Zo draait de controle ook in de
 * template (waar de schakelaar uit staat) en in elke app met de migratie van het klantportaal,
 * en weet je dat hij niet stil groen is.
 *
 * Een geval telt als afgekeurd als de controle na het geval een probleem vindt dat er vóór het
 * geval niet was, en dat probleem over het juiste gaat (`verwacht`). Zo hindert een eigen
 * tabel van de app zonder poort de test niet.
 *
 * Deze test is van de template en komt met elke versie mee.
 */

/** De template zelf, of de kopie ervan bij een klant; herkend zoals guard-template dat doet. */
function isDeTemplate(): boolean {
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
  return /\/(?:app-template-tier[12]|stack-template(?:-cloudflare|-light)?)(?:\.git)?$/.test(repo);
}

const heeftKlantportaal =
  vraagDatabase<{ ja: boolean }>(
    "select to_regprocedure('public.is_medewerker()') is not null as ja",
  )[0]?.ja === true;

/** Een gewone start voor een klantportaal: een tabel alleen voor medewerkers, met de poort. */
const BASIS = `
create table public.kp_proef_dossiers (
  id uuid primary key default gen_random_uuid(),
  klant text not null,
  geheim text not null
);
alter table public.kp_proef_dossiers enable row level security;
grant select, insert, update, delete on public.kp_proef_dossiers to authenticated;
revoke all on public.kp_proef_dossiers from anon;
create policy "kp_proef_medewerker" on public.kp_proef_dossiers for all to authenticated
  using (public.is_medewerker()) with check (public.is_medewerker());
insert into public.kp_proef_dossiers (klant, geheim) values ('Jansen', 'geheim');
`;

type Geval = {
  naam: string;
  sql: string;
  /** Een deel van de melding die de controle moet geven. */
  verwacht: RegExp;
  config?: KlantportaalConfig;
  /** SQL die eerst als supabase_admin moet (wat een migratie zelf niet mag). */
  alsBeheerder?: string;
};

const GEVALLEN: Geval[] = [
  {
    naam: "1.1 een tabel die later opnieuw wordt gemaakt (drop + create)",
    sql: `drop table public.kp_proef_dossiers;
      create table public.kp_proef_dossiers (id uuid primary key default gen_random_uuid(), klant text, geheim text, status text);`,
    verwacht: /public\.kp_proef_dossiers: row level security staat uit/,
  },
  {
    naam: "1.2 disable row level security",
    sql: "alter table public.kp_proef_dossiers disable row level security;",
    verwacht: /public\.kp_proef_dossiers: row level security staat uit/,
  },
  {
    naam: "1.3 een view die de poort alleen als kolom toont",
    sql: `create view public.kp_proef_lijst as
      select d.id, d.klant, d.geheim, public.is_medewerker() as mag_wijzigen from public.kp_proef_dossiers d;`,
    verwacht: /public\.kp_proef_lijst: een view zonder security_invoker/,
  },
  {
    naam: "1.4 een security definer-functie die de poort aanroept en het antwoord weggooit",
    sql: `create function public.kp_proef_overzicht() returns setof public.kp_proef_dossiers
      language plpgsql security definer set search_path = '' as $$
      begin perform public.is_medewerker(); return query select * from public.kp_proef_dossiers; end $$;`,
    verwacht: /public\.kp_proef_overzicht\(\): security definer/,
  },
  {
    naam: "1.5 een security definer-functie met de poort in een or",
    sql: `create function public.kp_proef_zoek(zoek text) returns setof public.kp_proef_dossiers
      language sql stable security definer set search_path = '' as $$
        select d.* from public.kp_proef_dossiers d where public.is_medewerker() or d.klant = zoek $$;`,
    verwacht: /public\.kp_proef_zoek\(zoek text\): security definer/,
  },
  {
    naam: "1.6 een eigen schema zonder RLS, ontsloten met een view met security_invoker",
    sql: `create schema kp_proef_intern;
      create table kp_proef_intern.notities (id int primary key, tekst text not null);
      grant usage on schema kp_proef_intern to authenticated;
      grant select on kp_proef_intern.notities to authenticated;
      create view public.kp_proef_notities with (security_invoker = true) as
        select id, tekst from kp_proef_intern.notities;`,
    verwacht: /kp_proef_intern\.notities: row level security staat uit/,
  },
  {
    naam: "1.7 een policy to anon zonder letterlijke true",
    sql: `create policy "kp_proef_volgen" on public.kp_proef_dossiers for select to anon
      using (klant is not null);`,
    verwacht: /kp_proef_volgen.*bezoekers zonder account/,
  },
  {
    naam: "1.8 de poort to authenticated dekt een policy zonder to niet voor anon",
    sql: `create policy "kp_proef_poort" on public.kp_proef_dossiers as restrictive for all to authenticated
        using (public.is_medewerker() or public.is_goedgekeurde_klant());
      create policy "kp_proef_met_naam" on public.kp_proef_dossiers for select using (klant <> '');`,
    verwacht: /kp_proef_met_naam.*bezoekers zonder account/,
  },
  {
    naam: "1.9 create or replace van is_goedgekeurde_klant() zonder de goedkeuring",
    sql: `create or replace function public.is_goedgekeurde_klant() returns boolean
      language sql stable security definer set search_path = '' as $$
        select exists (select 1 from public.klanten k where k.user_id = auth.uid()) $$;`,
    verwacht: /de basisfunctie public\.is_goedgekeurde_klant\(\) is gewijzigd/,
  },
  {
    naam: "1.10 create or replace van sessie_via_cloudflare() die altijd waar zegt",
    sql: `create or replace function public.sessie_via_cloudflare() returns boolean
      language sql stable security definer set search_path = '' as $$ select true $$;`,
    verwacht: /de basisfunctie public\.sessie_via_cloudflare\(\) is gewijzigd/,
  },
  {
    naam: "1.11 een eigen poort die de poort van de template in een or aanroept",
    config: { poorten: { kp_proef_bekend: "klanten die we kennen" } },
    sql: `create function public.kp_proef_bekend() returns boolean
      language sql stable security definer set search_path = '' as $$
        select public.is_goedgekeurde_klant()
            or exists (select 1 from public.klanten k where k.user_id = auth.uid()) $$;
      create policy "kp_proef_bekend" on public.kp_proef_dossiers for select to authenticated
        using (public.kp_proef_bekend());`,
    verwacht: /public\.kp_proef_bekend\(\): een eigen poort moet/,
  },
  {
    naam: "1.12 een security definer-functie die alleen voor anon nog uitvoerbaar is",
    sql: `create function public.kp_proef_alles() returns setof public.kp_proef_dossiers
      language sql stable security definer set search_path = '' as $$ select * from public.kp_proef_dossiers $$;
      revoke execute on function public.kp_proef_alles() from public, authenticated;
      grant execute on function public.kp_proef_alles() to anon;`,
    verwacht: /public\.kp_proef_alles\(\): bezoekers zonder account \(anon\) mogen hem uitvoeren/,
  },
  {
    naam: "1.13 een openbare bucket",
    sql: "insert into storage.buckets (id, name, public) values ('kp-proef', 'kp-proef', true);",
    verwacht: /bucket kp-proef: public = true/,
  },
  {
    naam: "1.14 een policy to anon op realtime.messages",
    sql: `create policy "kp_proef_meeluisteren" on realtime.messages for select to anon
      using (realtime.topic() = 'kp-proef');`,
    verwacht: /realtime\.messages \(policy "kp_proef_meeluisteren"\).*bezoekers zonder account/,
  },
  {
    naam: "1.20 create unlogged table",
    sql: "create unlogged table public.kp_proef_wachtrij (id int, geheim text);",
    verwacht: /public\.kp_proef_wachtrij: row level security staat uit/,
  },
  {
    naam: "1.21 select ... into",
    sql: "select * into public.kp_proef_kopie from public.kp_proef_dossiers;",
    verwacht: /public\.kp_proef_kopie: row level security staat uit/,
  },
  {
    naam: "1.22 een tabel die uit een ander schema naar public verhuist",
    sql: `create schema kp_proef_elders; create table kp_proef_elders.notities (id int, tekst text);
      alter table kp_proef_elders.notities set schema public;`,
    verwacht: /public\.notities: row level security staat uit/,
  },
  {
    naam: "1.23 een foreign table",
    alsBeheerder: `create foreign data wrapper kp_proef_fdw;
      create server kp_proef_boekhouding foreign data wrapper kp_proef_fdw;
      grant usage on foreign server kp_proef_boekhouding to postgres`,
    sql: `create foreign table public.kp_proef_extern (id int, naam text) server kp_proef_boekhouding;
      grant select on public.kp_proef_extern to authenticated;`,
    verwacht: /public\.kp_proef_extern: een foreign table/,
  },
  {
    naam: "1.24 een tabel uit dynamische SQL",
    sql: "do $$ begin execute format('create table %I.%I (id int, geheim text)', 'public', 'kp_proef_2026'); end $$;",
    verwacht: /public\.kp_proef_2026: row level security staat uit/,
  },
  {
    naam: "1.25 een tabel die opnieuw wordt gemaakt met dezelfde naam",
    sql: `drop table public.kp_proef_dossiers;
      create table public.kp_proef_dossiers (id uuid primary key, klant text, geheim text);`,
    verwacht: /public\.kp_proef_dossiers: row level security staat uit/,
  },
  {
    naam: "1.26 RLS weer uit in een latere migratie, ook met force",
    sql: "alter table public.kp_proef_dossiers no force row level security; alter table public.kp_proef_dossiers disable row level security;",
    verwacht: /public\.kp_proef_dossiers: row level security staat uit/,
  },
  {
    naam: "1.27 een materialized view",
    sql: `create materialized view public.kp_proef_telling as select klant, geheim from public.kp_proef_dossiers;
      grant select on public.kp_proef_telling to authenticated;`,
    verwacht: /public\.kp_proef_telling: een materialized view/,
  },
  // Wat de aanvaller niet probeerde, maar wat op dezelfde manier langs de poort gaat.
  {
    naam: "een policy voor een eigen rol waar authenticated lid van is",
    sql: `create role kp_proef_klant nologin; grant kp_proef_klant to authenticated;
      create policy "kp_proef_eigen_rol" on public.kp_proef_dossiers for select to kp_proef_klant using (true);`,
    verwacht: /kp_proef_eigen_rol.*geen harde eis/,
  },
  {
    naam: "een poort alleen voor select dekt geen insert",
    sql: `create policy "kp_proef_poort_lezen" on public.kp_proef_dossiers as restrictive for select to authenticated
        using (public.is_medewerker());
      create policy "kp_proef_schrijven" on public.kp_proef_dossiers for insert to authenticated with check (klant <> '');`,
    verwacht: /kp_proef_schrijven.*with check.*geen harde eis/,
  },
  {
    naam: "een view met security_invoker = false",
    sql: `create view public.kp_proef_uit with (security_invoker = false) as select * from public.kp_proef_dossiers;
      grant select on public.kp_proef_uit to authenticated;`,
    verwacht: /public\.kp_proef_uit: een view zonder security_invoker/,
  },
  {
    naam: "een tabel van authenticated zelf (de eigenaar gaat langs RLS)",
    sql: "grant create on schema public to authenticated; alter table public.kp_proef_dossiers owner to authenticated;",
    verwacht: /public\.kp_proef_dossiers: de eigenaar is anon, authenticated/,
  },
  {
    naam: "een eigen trigger op auth.users die iedereen goedkeurt",
    sql: `create function public.kp_proef_keur_goed() returns trigger language plpgsql security definer set search_path = '' as $$
        begin insert into public.klanten (user_id, e_mail, goedgekeurd) values (new.id, coalesce(new.email, ''), true); return null; end $$;
      revoke all on function public.kp_proef_keur_goed() from public, anon, authenticated;
      create trigger kp_proef_keur_goed after insert on auth.users for each row execute function public.kp_proef_keur_goed();`,
    verwacht: /de trigger kp_proef_keur_goed op auth\.users/,
  },
  {
    naam: "goedgekeurd standaard aan",
    sql: "alter table public.klanten alter column goedgekeurd set default true;",
    verwacht: /de tabel public\.klanten is gewijzigd \(de kolommen/,
  },
  {
    naam: "een klant mag zijn eigen regel invoegen",
    sql: "grant insert on public.klanten to authenticated;",
    verwacht: /de tabel public\.klanten is gewijzigd \(de rechten/,
  },
  {
    naam: "de functie achter de trigger voor iedereen",
    sql: "grant execute on function public.klant_adres_gewijzigd() to public;",
    verwacht: /de basisfunctie public\.klant_adres_gewijzigd\(\) is gewijzigd/,
  },
  {
    naam: "het zoekpad van een basisfunctie weg",
    sql: "alter function public.is_medewerker() reset search_path;",
    verwacht: /de basisfunctie public\.is_medewerker\(\) is gewijzigd \(het zoekpad/,
  },
  {
    naam: "een security definer-functie op de vrije lijst zonder vast zoekpad",
    config: { vrijeFuncties: { kp_proef_vrij: "mag iedereen met een account" } },
    sql: `create function public.kp_proef_vrij() returns int language sql security definer as $$ select 1 $$;
      revoke execute on function public.kp_proef_vrij() from public, anon;
      grant execute on function public.kp_proef_vrij() to authenticated;`,
    verwacht: /public\.kp_proef_vrij\(\): security definer zonder vast zoekpad/,
  },
  {
    naam: "een gewone functie die bezoekers zonder account mogen uitvoeren",
    sql: "create function public.kp_proef_teller() returns bigint language sql as $$ select count(*) from public.kp_proef_dossiers $$;",
    verwacht: /public\.kp_proef_teller\(\): bezoekers zonder account/,
  },
];

/**
 * Een app zoals stap 4 van docs/routes/klantportaal.md hem aantreft, met de rechten die Supabase
 * standaard geeft. Dezelfde app staat in tests/unit/rls-regels.test.ts, voor guard:rls.
 */
const VOOR_DE_ROUTE = `
create table public.bestellingen (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  bedrag numeric not null default 0
);
alter table public.bestellingen enable row level security;
grant select, insert, update, delete on public.bestellingen to authenticated;
create policy "bestellingen_eigen" on public.bestellingen for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create table public.beheerders (user_id uuid primary key);
alter table public.beheerders enable row level security;
grant select on public.beheerders to authenticated;
create policy "beheerders_zelf" on public.beheerders for select to authenticated
  using (auth.uid() = user_id);
create view public.bestellingen_overzicht as
  select user_id, count(*) as aantal from public.bestellingen group by user_id;
create function public.omzet() returns numeric language sql stable
  security definer set search_path = '' as $$ select coalesce(sum(bedrag), 0) from public.bestellingen $$;
create function public.is_beheerder() returns boolean language plpgsql stable
  security definer set search_path = '' as $$
  begin return exists (select 1 from public.beheerders b where b.user_id = auth.uid()); end $$;
`;

const metKlantportaal = describe.runIf(heeftKlantportaal || isDeTemplate());

metKlantportaal("de databasecontrole van het klantportaal keurt elke bekende omweg af", () => {
  it("de migratie van het klantportaal staat in de database", () => {
    expect(heeftKlantportaal, "public.is_medewerker() ontbreekt in de database").toBe(true);
  });

  const vooraf = heeftKlantportaal ? beoordeel(leesModel(BASIS)) : [];

  it.runIf(isDeTemplate())(
    "de template met de poort op items, en een tabel alleen voor medewerkers: niets mis",
    () => {
      const model = leesModel(`${BASIS}
        create policy "items_poort" on public.items as restrictive for all to authenticated
          using (public.is_medewerker() or public.is_goedgekeurde_klant());`);
      expect(beoordeel(model)).toEqual([]);
    },
  );

  it.runIf(isDeTemplate())(
    "het voorbeeld uit docs/routes/klantportaal.md (stap 4) brengt een nagebootste app door de controle",
    () => {
      const route = readFileSync(resolve(__dirname, "../../docs/routes/klantportaal.md"), "utf8");
      const voorbeeld = /<!-- voorbeeld-poort -->\s*```sql\n([\s\S]*?)```/.exec(route)?.[1];
      expect(voorbeeld, "het voorbeeld staat in stap 4 van de route").toBeDefined();
      const config = { poorten: { is_beheerder: "medewerker die klanten goedkeurt" } };
      const leeg = beoordeel(leesModel(), config);
      const zonder = beoordeel(leesModel(VOOR_DE_ROUTE), config).filter((p) => !leeg.includes(p));
      for (const naam of [
        /public\.omzet\(\)/,
        /public\.is_beheerder\(\)/,
        /public\.bestellingen_overzicht/,
      ]) {
        expect(
          zonder.some((p) => naam.test(p)),
          `zonder het voorbeeld is ${naam} rood; nu:\n${zonder.join("\n")}`,
        ).toBe(true);
      }
      const met = beoordeel(leesModel(`${VOOR_DE_ROUTE}\n${voorbeeld}`), config);
      expect(met.filter((p) => !leeg.includes(p))).toEqual([]);
    },
  );

  for (const geval of GEVALLEN) {
    it.runIf(heeftKlantportaal)(geval.naam, () => {
      const model = leesModel(`${BASIS}\n${geval.sql}`, geval.alsBeheerder);
      const nieuw = beoordeel(model, geval.config).filter((p) => !vooraf.includes(p));
      expect(
        nieuw.some((p) => geval.verwacht.test(p)),
        `de controle keurt dit niet (goed) af; nieuwe meldingen:\n${nieuw.join("\n")}`,
      ).toBe(true);
    });
  }

  it.runIf(heeftKlantportaal)(
    "wat bewust vrij is, blijft vrij: een functie of bucket met een reden in stack.config.json",
    () => {
      const model = leesModel(`${BASIS}
        create function public.kp_proef_open() returns int language sql security definer set search_path = '' as $$ select 1 $$;
        insert into storage.buckets (id, name, public) values ('kp-proef-logo', 'kp-proef-logo', true);`);
      const config = {
        vrijeFuncties: { kp_proef_open: "telt alleen" },
        openbaar: { "public.kp_proef_open": "telt alleen", "bucket:kp-proef-logo": "het logo" },
      };
      expect(beoordeel(model, config).filter((p) => !vooraf.includes(p))).toEqual([]);
    },
  );
});
