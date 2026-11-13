import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { vraagDatabase } from "./database";

/**
 * De poort van een klantportaal, gelezen uit de database zelf: de policies, de functies en de
 * views zoals ze er na alle migraties staan, en wie erbij mag. Nauwkeuriger dan guard-rls.mjs
 * (die de tekst van de migraties leest): dit ziet ook wat in een functie is gemaakt, en de
 * rechten zoals ze echt zijn. De beoordeling is dezelfde: `beoordeelKlantportaal` in
 * scripts/lib/rls-regels.mjs.
 *
 * Deze hulp is van de template en komt met elke versie mee.
 */
export type KlantportaalConfig = {
  poorten?: Record<string, string>;
  vrijeFuncties?: Record<string, string>;
  openTabellen?: Record<string, string>;
};

/** Zoals de app zelf: de schema's `public` en `api`, en de bestanden in `storage`. */
const POLICIES = `
  select n.nspname || '.' || c.relname as tabel,
         p.polname as naam,
         case when p.polroles = '{0}' then array['public']
              -- Een eigen rol waar authenticated lid van is, geldt ook voor elke ingelogde.
              else array(select case when pg_has_role('authenticated', r.oid, 'member')
                                     then 'authenticated' else r.rolname::text end
                           from pg_roles r where r.oid = any(p.polroles))
         end as rollen,
         not p.polpermissive as restrictief,
         case p.polcmd when '*' then 'all' when 'r' then 'select' when 'a' then 'insert'
                       when 'w' then 'update' else 'delete' end as cmd,
         pg_get_expr(p.polqual, p.polrelid) as using,
         pg_get_expr(p.polwithcheck, p.polrelid) as "check"
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'api', 'storage')
   order by 1, 2`;

/** Alleen wat een ingelogde gebruiker echt mag uitvoeren; functies van extensies tellen niet. */
const FUNCTIES = `
  select n.nspname || '.' || p.proname as naam,
         p.prosecdef as definer,
         true as uitvoerbaar,
         array[coalesce(pg_get_function_sqlbody(p.oid), p.prosrc)] as inhoud
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'api')
     and p.prokind in ('f', 'p')
     and p.prorettype not in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
     and has_function_privilege('authenticated', p.oid, 'execute')
     and not exists (
       select 1 from pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
     )
   order by 1`;

/** Een materialized view kent geen security_invoker: daar helpt alleen het recht intrekken. */
const VIEWS = `
  select n.nspname || '.' || c.relname as naam,
         c.relkind = 'v' and coalesce(c.reloptions::text[] && array['security_invoker=true', 'security_invoker=on', 'security_invoker=1'], false) as invoker,
         case when c.relkind = 'v' then pg_get_viewdef(c.oid) else '' end as inhoud
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'api')
     and c.relkind in ('v', 'm')
     and has_table_privilege('authenticated', c.oid, 'select')
     and not exists (
       select 1 from pg_depend d
        where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
     )
   order by 1`;

const REGELS = resolve(__dirname, "../../../scripts/lib/rls-regels.mjs");

/** Wat er in de database mis is voor een klantportaal; leeg als alles door de poort gaat. */
export function problemenKlantportaalInDatabase(config: KlantportaalConfig = {}): string[] {
  const zoekpad = { zoekpad: "" };
  const model = {
    policies: vraagDatabase(POLICIES, zoekpad),
    functies: vraagDatabase(FUNCTIES, zoekpad),
    views: vraagDatabase(VIEWS, zoekpad),
  };
  const code = `import(${JSON.stringify(pathToFileURL(REGELS).href)}).then((m) => { let invoer = ""; process.stdin.on("data", (stuk) => { invoer += stuk; }); process.stdin.on("end", () => { const a = JSON.parse(invoer); process.stdout.write(JSON.stringify(m.beoordeelKlantportaal(a.model, a.config))); }); })`;
  const uitvoer = execFileSync("node", ["--input-type=module", "-e", code], {
    encoding: "utf8",
    input: JSON.stringify({ model, config }),
  });
  return JSON.parse(uitvoer) as string[];
}
