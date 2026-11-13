import { readFileSync } from "node:fs";
import { BASISPOORTEN, eigenPoortKlopt, poortIsHardeEis } from "./rls-regels.mjs";

/**
 * De sluitende controle van een klantportaal: wat er na alle migraties ECHT in de database
 * staat, gelezen uit de catalogus van Postgres. De tekst van de migraties is te misleiden (een
 * tabel die later opnieuw wordt gemaakt, `disable row level security`, dynamische SQL, een
 * ander schema); de catalogus niet. guard-rls.mjs blijft de snelle eerste hulp op de tekst.
 *
 * `MODEL_SQL` leest alles in één vraag (één JSON-object), zodat dezelfde vraag ook binnen een
 * transactie te stellen is (tests/rls/klantportaal-controle.test.ts). `beoordeelDatabase`
 * beoordeelt dat model; die is zonder database te testen (tests/unit/klantportaal-database.test.ts).
 *
 * Welke schema's: elk schema waar `anon` of `authenticated` `usage` op heeft, behalve de
 * catalogus van Postgres zelf. Dat is ruimer dan wat PostgREST aanbiedt (public en
 * graphql_public), en dat is de veilige kant: een view in public kan een tabel in elk schema
 * met `usage` laten zien. Objecten van Supabase zelf (eigenaar een van SUPABASE_ROLLEN) en van
 * extensies tellen niet mee als object; policies tellen wel altijd mee, ook op tabellen van
 * Supabase (storage.objects, realtime.messages).
 *
 * Dit bestand is van de template en komt met elke versie mee.
 */

/** Rollen van Supabase zelf. Wat zij bezitten, is van Supabase en niet van de app. */
export const SUPABASE_ROLLEN = [
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_realtime_admin",
  "supabase_functions_admin",
  "supabase_replication_admin",
  "supabase_read_only_user",
  "supabase_etl_admin",
  "pgbouncer",
  "pgsodium_keyholder",
  "pgsodium_keyiduser",
  "pgsodium_keymaker",
  "dashboard_user",
];

/** De functies van het klantportaal uit de template; vergeleken met klantportaal-basis.json. */
export const BASISFUNCTIES = [
  "sessie_via_cloudflare",
  "is_medewerker",
  "is_goedgekeurde_klant",
  "klant_aanmelden",
  "klant_adres_gewijzigd",
];

/** Tabellen van Supabase waar een app zelf policies op zet; daar moet RLS aan blijven. */
const MET_POLICIES_VAN_DE_APP = ["storage.objects", "storage.buckets", "realtime.messages"];

/** Tabellen waar een eigen trigger de goedkeuring of de sessies kan omzeilen. */
const ADMINISTRATIE = ["auth.users", "auth.identities", "auth.sessions", "public.klanten"];

const lijst = (namen) => namen.map((n) => `'${n}'`).join(", ");

export const MODEL_SQL = `
with
  supabase as (select oid from pg_roles where rolname in (${lijst(SUPABASE_ROLLEN)})),
  schemas as (
    select n.oid, n.nspname
      from pg_namespace n
     where n.nspname not in ('pg_catalog', 'information_schema')
       and n.nspname !~ '^pg_(toast|temp_)'
       and (has_schema_privilege('anon', n.oid, 'usage')
         or has_schema_privilege('authenticated', n.oid, 'usage'))
  ),
  bezoeker as (
    select r.oid
      from pg_roles r
     where pg_has_role('anon', r.oid, 'member') or pg_has_role('authenticated', r.oid, 'member')
  )
select json_build_object(
  'schemas', (select coalesce(json_agg(s.nspname order by s.nspname), '[]') from schemas s),
  'rollen', (
    select coalesce(json_agg(r.rolname order by r.rolname), '[]')
      from pg_roles r
     where r.oid in (select oid from bezoeker) and (r.rolsuper or r.rolbypassrls)
  ),
  'relaties', (
    select coalesce(json_agg(json_build_object(
             'naam', n.nspname || '.' || c.relname,
             'soort', c.relkind,
             'rls', c.relrowsecurity,
             'policies', (select count(*) from pg_policy p where p.polrelid = c.oid),
             'invoker', exists (
               select 1 from unnest(c.reloptions) o
                where lower(o) ~ '^security_invoker=(t|tr|tru|true|y|ye|yes|on|1)$'
             ),
             'anon', has_any_column_privilege('anon', c.oid, 'select,insert,update')
                  or has_table_privilege('anon', c.oid, 'delete'),
             'ingelogd', has_any_column_privilege('authenticated', c.oid, 'select,insert,update')
                  or has_table_privilege('authenticated', c.oid, 'delete'),
             'supabase', c.relowner in (select oid from supabase),
             'eigenaarBezoeker', c.relowner in (select oid from bezoeker)
           ) order by n.nspname, c.relname), '[]')
      from pg_class c
      join schemas n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm', 'f')
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
       )
  ),
  'policies', (
    select coalesce(json_agg(json_build_object(
             'tabel', n.nspname || '.' || c.relname,
             'naam', p.polname,
             'permissief', p.polpermissive,
             'cmd', case p.polcmd when '*' then 'all' when 'r' then 'select' when 'a' then 'insert'
                                  when 'w' then 'update' else 'delete' end,
             'anon', 0 = any(p.polroles) or exists (
               select 1 from unnest(p.polroles) r where r <> 0 and pg_has_role('anon', r, 'member')
             ),
             'ingelogd', 0 = any(p.polroles) or exists (
               select 1 from unnest(p.polroles) r
                where r <> 0 and pg_has_role('authenticated', r, 'member')
             ),
             'using', pg_get_expr(p.polqual, p.polrelid),
             'check', pg_get_expr(p.polwithcheck, p.polrelid)
           ) order by n.nspname, c.relname, p.polname), '[]')
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
  ),
  'functies', (
    select coalesce(json_agg(json_build_object(
             'naam', n.nspname || '.' || p.proname,
             'args', pg_get_function_identity_arguments(p.oid),
             'definer', p.prosecdef,
             'anon', has_function_privilege('anon', p.oid, 'execute'),
             'ingelogd', has_function_privilege('authenticated', p.oid, 'execute'),
             'supabase', p.proowner in (select oid from supabase),
             'zoekpad', (select c from unnest(p.proconfig) c where c like 'search\\_path=%'),
             'taal', l.lanname,
             'bron', coalesce(pg_get_function_sqlbody(p.oid), p.prosrc)
           ) order by n.nspname, p.proname, 2), '[]')
      from pg_proc p
      join schemas n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where p.prokind in ('f', 'p')
       and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
       )
  ),
  'buckets', (select coalesce(json_agg(b.id order by b.id), '[]') from storage.buckets b where b.public),
  'basis', json_build_object(
    'functies', (
      select coalesce(json_agg(json_build_object(
               'naam', p.proname,
               'args', pg_get_function_identity_arguments(p.oid),
               'hash', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
               'definer', p.prosecdef,
               'zoekpad', p.proconfig,
               'eigenaar', pg_get_userbyid(p.proowner),
               'taal', l.lanname,
               'terug', pg_get_function_result(p.oid),
               'volatiel', p.provolatile,
               'anon', has_function_privilege('anon', p.oid, 'execute'),
               'ingelogd', has_function_privilege('authenticated', p.oid, 'execute')
             ) order by p.proname, 2), '[]')
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.proname in (${lijst(BASISFUNCTIES)})
    ),
    'triggers', (
      select coalesce(json_agg(json_build_object(
               'naam', t.tgname,
               'tabel', n.nspname || '.' || c.relname,
               'definitie', pg_get_triggerdef(t.oid),
               'aan', t.tgenabled
             ) order by n.nspname, c.relname, t.tgname), '[]')
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_proc f on f.oid = t.tgfoid
       where not t.tgisinternal
         and n.nspname || '.' || c.relname in (${lijst(ADMINISTRATIE)})
         and f.proowner not in (select oid from supabase)
    ),
    'klanten', (
      select json_build_object(
               'kolommen', (
                 select coalesce(json_agg(concat_ws(' ', a.attname, format_type(a.atttypid, a.atttypmod),
                          case when a.attnotnull then 'not null' end,
                          'default ' || pg_get_expr(d.adbin, d.adrelid)) order by a.attnum), '[]')
                   from pg_attribute a
                   left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
               ),
               'rechten', (
                 select coalesce(json_agg(rol || ': ' || recht order by rol, recht), '[]')
                   from (values ('anon'), ('authenticated')) as r(rol),
                        lateral (
                          select upper(soort) as recht
                            from unnest(array['select', 'insert', 'update', 'delete', 'truncate',
                                              'references', 'trigger']) soort
                           where has_table_privilege(r.rol, c.oid, soort)
                          union all
                          select upper(soort) || '(' || a.attname || ')'
                            from unnest(array['select', 'insert', 'update', 'references']) soort,
                                 pg_attribute a
                           where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                             and not has_table_privilege(r.rol, c.oid, soort)
                             and has_column_privilege(r.rol, c.oid, a.attnum, soort)
                        ) rechten
               )
             )
        from pg_class c
       where c.oid = to_regclass('public.klanten')
    )
  )
)`;

/** Wat de template verwacht van de basis van het klantportaal (klantportaal-basis.json). */
export function verwachteBasis() {
  return JSON.parse(readFileSync(new URL("./klantportaal-basis.json", import.meta.url), "utf8"));
}

/** Staat `naam` (schema.object) op een lijst met namen? Een naam zonder schema is public. */
function opLijst(lijst, naam) {
  return Object.keys(lijst ?? {}).some((sleutel) =>
    sleutel.includes(".") ? sleutel === naam : `public.${sleutel}` === naam,
  );
}

const OPDRACHTEN = ["select", "insert", "update", "delete"];

/** De voorwaarde van een policy die voor deze opdracht geldt. */
function voorwaardenVoor(policy, cmd) {
  const check = policy.check ?? policy.using;
  if (cmd === "select" || cmd === "delete") return [policy.using];
  if (cmd === "insert") return [check];
  return [policy.using, check];
}

/**
 * Wat er volgens de database mis is bij een klantportaal. Leeg als alles door de poort gaat.
 *
 * `config`: { poorten, vrijeFuncties, openbaar, openTabellen } uit stack.config.json
 * (`klantportaal()` in scripts/lib/stack-config.mjs). `basis`: de verwachting uit
 * klantportaal-basis.json.
 */
export function beoordeelDatabase(model, config = {}, basis = verwachteBasis()) {
  const problemen = [];
  const eigenPoorten = Object.keys(config.poorten ?? {});
  const poorten = [...BASISPOORTEN, ...eigenPoorten.map((p) => p.split(".").at(-1))];
  const openbaar = config.openbaar ?? {};
  const vrij = config.vrijeFuncties ?? {};
  const isOpenbaar = (naam) => opLijst(openbaar, naam);

  for (const tabel of Object.keys(config.openTabellen ?? {})) {
    problemen.push(
      `open_tabellen.${tabel}: een klantportaal kent geen open tabellen, want "iedereen binnen" is daar iedereen met een e-mailadres`,
    );
  }

  for (const rol of model.rollen ?? []) {
    problemen.push(
      `rol ${rol}: anon of authenticated is lid van een rol die langs de policies heen mag (superuser of bypassrls)`,
    );
  }

  // 1. Elke relatie in een schema waar bezoekers bij kunnen.
  for (const r of model.relaties ?? []) {
    const bereikbaar = r.anon || r.ingelogd;
    if (r.eigenaarBezoeker) {
      problemen.push(
        `${r.naam}: de eigenaar is anon, authenticated of een rol waar zij lid van zijn, en een eigenaar gaat langs de policies heen`,
      );
    }
    if (r.soort === "r" || r.soort === "p") {
      if (r.supabase) {
        // Tabellen van Supabase zelf zijn van Supabase; sommige staan bewust zonder RLS
        // (realtime.subscription). Alleen die waar de app policies op zet, houden RLS aan.
        if (bereikbaar && MET_POLICIES_VAN_DE_APP.includes(r.naam) && !r.rls) {
          problemen.push(
            `${r.naam}: row level security staat uit, en bezoekers hebben er rechten op`,
          );
        }
      } else if (!r.rls) {
        problemen.push(
          `${r.naam}: row level security staat uit. Zo staat de tabel open voor iedereen met rechten erop`,
        );
      } else if (r.policies === 0) {
        problemen.push(`${r.naam}: row level security staat aan, maar er is geen enkele policy`);
      }
    } else if (r.soort === "v") {
      if (bereikbaar && !r.invoker && !opLijst(vrij, r.naam)) {
        problemen.push(
          `${r.naam}: een view zonder security_invoker gaat langs de policies heen (hij leest met de rechten van zijn eigenaar)`,
        );
      }
      if (r.anon && !r.invoker && !isOpenbaar(r.naam)) {
        problemen.push(
          `${r.naam}: een view met de rechten van zijn eigenaar, te lezen zonder account (anon)`,
        );
      }
    } else if (bereikbaar) {
      problemen.push(
        `${r.naam}: een ${r.soort === "m" ? "materialized view" : "foreign table"} kent geen row level security, en bezoekers hebben er rechten op`,
      );
    }
  }

  // 2. Elke policy die voor bezoekers geldt.
  const policies = model.policies ?? [];
  for (const p of policies) {
    if (p.permissief && p.anon && !isOpenbaar(p.tabel)) {
      problemen.push(
        `${p.tabel} (policy "${p.naam}"): geeft bezoekers zonder account (anon of public) toegang, en ${p.tabel} staat niet in klantportaal_openbaar`,
      );
    }
  }
  const dekkend = policies.filter((p) => !p.permissief && p.ingelogd);
  const gedekt = (tabel, cmd) =>
    dekkend.some(
      (r) =>
        r.tabel === tabel &&
        (r.cmd === "all" || r.cmd === cmd) &&
        voorwaardenVoor(r, cmd).every((v) => v !== null && poortIsHardeEis(v, poorten)),
    );
  for (const p of policies) {
    if (!p.permissief || !p.ingelogd) continue;
    const opdrachten = p.cmd === "all" ? OPDRACHTEN : [p.cmd];
    if (opdrachten.every((cmd) => gedekt(p.tabel, cmd))) continue;
    for (const [soort, voorwaarde] of [
      ["using", p.using],
      ["with check", p.check],
    ]) {
      if (voorwaarde !== null && !poortIsHardeEis(voorwaarde, poorten)) {
        problemen.push(
          `${p.tabel} (policy "${p.naam}"): de ${soort} geldt voor iedereen met een e-mailadres, want de poort is er geen harde eis`,
        );
      }
    }
  }

  // 3. Elke functie die bezoekers mogen uitvoeren.
  const functies = model.functies ?? [];
  for (const f of functies) {
    if (f.supabase || !(f.anon || f.ingelogd)) continue;
    const [schema, naam] = f.naam.split(".");
    if (schema === "public" && BASISFUNCTIES.includes(naam)) continue;
    const handtekening = `${f.naam}(${f.args})`;
    if (f.anon && !isOpenbaar(f.naam)) {
      problemen.push(
        `${handtekening}: bezoekers zonder account (anon) mogen hem uitvoeren, en hij staat niet in klantportaal_openbaar`,
      );
    }
    if (!f.definer) continue;
    if (f.zoekpad === null || f.zoekpad === undefined) {
      problemen.push(
        `${handtekening}: security definer zonder vast zoekpad; zet \`set search_path = ''\``,
      );
    }
    if (opLijst(config.poorten, f.naam) || opLijst(vrij, f.naam)) continue;
    problemen.push(
      `${handtekening}: security definer (hij leest met de rechten van zijn eigenaar), en iedereen met een e-mailadres mag hem uitvoeren`,
    );
  }

  // Een eigen poort moet bestaan en na te lopen zijn.
  for (const sleutel of eigenPoorten) {
    const naam = sleutel.includes(".") ? sleutel : `public.${sleutel}`;
    const varianten = functies.filter((f) => f.naam === naam && f.args === "");
    if (varianten.length === 0) {
      problemen.push(
        `klantportaal_poorten.${sleutel}: er is geen functie ${naam}() zonder argumenten`,
      );
      continue;
    }
    if (!varianten.every(eigenPoortKlopt)) {
      problemen.push(
        `${naam}(): een eigen poort moet een functie in language sql zijn die één uitdrukking teruggeeft, met public.is_medewerker() of public.is_goedgekeurde_klant() als harde eis (select public.is_medewerker() and ...). Wat de poort verder doet, is de zorg van de app`,
      );
    }
  }

  // 4. Buiten de tabellen.
  for (const bucket of model.buckets ?? []) {
    if (!(`bucket:${bucket}` in openbaar)) {
      problemen.push(
        `bucket ${bucket}: public = true, dus elk bestand is zonder account op te halen; hij staat niet in klantportaal_openbaar als "bucket:${bucket}"`,
      );
    }
  }

  // 5. De basis van het klantportaal is die van de template.
  problemen.push(...vergelijkBasis(model.basis ?? {}, basis));
  return problemen;
}

const VELDEN = {
  hash: "de tekst van de functie",
  definer: "security definer",
  zoekpad: "het zoekpad (set search_path)",
  eigenaar: "de eigenaar",
  taal: "de taal",
  terug: "wat hij teruggeeft",
  volatiel: "stable of volatile",
  anon: "wie hem mag uitvoeren (anon)",
  ingelogd: "wie hem mag uitvoeren (authenticated)",
};

/** De basisfuncties, de trigger en de tabel klanten, vergeleken met wat de template verwacht. */
export function vergelijkBasis(gevonden, verwacht) {
  const problemen = [];
  const herstel =
    "Neem de migratie van het klantportaal ongewijzigd over uit de template; wil de app iets anders, maak dan een eigen functie en zet die in klantportaal_poorten";
  for (const [naam, eis] of Object.entries(verwacht.functies ?? {})) {
    const f = (gevonden.functies ?? []).find((g) => g.naam === naam && g.args === "");
    if (!f) {
      problemen.push(`de basisfunctie public.${naam}() ontbreekt. ${herstel}`);
      continue;
    }
    const anders = Object.keys(VELDEN).filter(
      (veld) => JSON.stringify(f[veld] ?? null) !== JSON.stringify(eis[veld] ?? null),
    );
    if (anders.length > 0) {
      problemen.push(
        `de basisfunctie public.${naam}() is gewijzigd (${anders.map((v) => VELDEN[v]).join(", ")}). ${herstel}`,
      );
    }
  }
  const triggers = gevonden.triggers ?? [];
  for (const eis of verwacht.triggers ?? []) {
    const t = triggers.find((g) => g.naam === eis.naam && g.tabel === eis.tabel);
    if (!t) problemen.push(`de trigger ${eis.naam} op ${eis.tabel} ontbreekt. ${herstel}`);
    else if (t.definitie !== eis.definitie || t.aan !== eis.aan) {
      problemen.push(
        `de trigger ${eis.naam} op ${eis.tabel} is gewijzigd of staat uit (nu: ${t.definitie}; ${t.aan === "D" ? "uit" : `aan, ${t.aan}`}). ${herstel}`,
      );
    }
  }
  for (const t of triggers) {
    if (!(verwacht.triggers ?? []).some((e) => e.naam === t.naam && e.tabel === t.tabel)) {
      problemen.push(
        `de trigger ${t.naam} op ${t.tabel}: een eigen trigger op de administratie van het klantportaal kan de goedkeuring of het uitloggen omzeilen`,
      );
    }
  }
  if (!gevonden.klanten) {
    problemen.push(`de tabel public.klanten ontbreekt. ${herstel}`);
  } else {
    for (const [veld, uitleg] of [
      ["kolommen", "de kolommen of hun standaardwaarden"],
      ["rechten", "de rechten (grant en revoke)"],
    ]) {
      if (JSON.stringify(gevonden.klanten[veld]) !== JSON.stringify(verwacht.klanten?.[veld])) {
        problemen.push(`de tabel public.klanten is gewijzigd (${uitleg}). ${herstel}`);
      }
    }
  }
  return problemen;
}

/**
 * De basisfuncties zoals de migraties ze achterlaten, voor de unittest die bewaakt dat
 * klantportaal-basis.json klopt met de migratie van de template. Per functie de laatste
 * `create [or replace] function public.<naam>()`: de hash van de tekst tussen de dollartekens
 * (precies wat Postgres als `prosrc` bewaart), en wat er in de kop staat.
 */
export function basisUitMigraties(sql, hash) {
  const uit = {};
  const opdracht =
    /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(\s*\)([\s\S]*?)\bas\s+\$(\w*)\$([\s\S]*?)\$\3\$/gi;
  for (const m of sql.matchAll(opdracht)) {
    const naam = m[1] ?? "";
    if (!BASISFUNCTIES.includes(naam)) continue;
    const kop = (m[2] ?? "").toLowerCase();
    uit[naam] = {
      hash: hash(m[4] ?? ""),
      definer: /\bsecurity\s+definer\b/.test(kop),
      zoekpad: /\bset\s+search_path\s*=\s*''/.test(kop) ? ['search_path=""'] : null,
      taal: /\blanguage\s+(\w+)/.exec(kop)?.[1] ?? null,
    };
  }
  return uit;
}
