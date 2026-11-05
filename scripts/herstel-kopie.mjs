import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  leesVerwachting,
  omgezetteTabellen,
  stempel,
  teOud,
  zetGegevensOm,
} from "./lib/verwachting.mjs";

/**
 * Terug kunnen na een migratie die gegevens omzet, zonder point-in-time-recovery (dat is bij
 * Supabase een dure optie). Vlak vóór `supabase db push` op productie (deploy-db.yml):
 *
 * 1. kijkt welke migraties nog niet op productie staan en bestaande gegevens omzetten
 *    (UPDATE of DELETE);
 * 2. kopieert de tabellen die ze raken (uit de regels `-- verwachting:` en de UPDATE- en
 *    DELETE-opdrachten zelf) naar het schema `herstel`, als `herstel.<tabel>_<jjjjmmdd>_<uumm>`;
 * 3. ruimt kopieën in `herstel` op die ouder zijn dan veertien dagen.
 *
 * De weg terug staat in docs/routes/databasewijziging.md: één `insert ... select` (of
 * `update ... from`) uit de kopie. Het schema `herstel` is niet bereikbaar via de API: geen
 * rechten voor anon of authenticated, en het staat niet in de schema's die Supabase openzet.
 *
 * Leest het adres van de database uit HERSTEL_DB_URL. Draait met psql, dat op de runners
 * van GitHub staat.
 */
const adres = process.env.HERSTEL_DB_URL ?? "";
if (!adres) {
  console.error("✗ HERSTEL_DB_URL ontbreekt.");
  process.exit(1);
}

function psql(sql) {
  const r = spawnSync("psql", [adres, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stderr);
    throw new Error("psql gaf een fout");
  }
  return (r.stdout ?? "").trim();
}

const lit = (t) => `'${String(t).replaceAll("'", "''")}'`;
const ident = (t) =>
  t
    .split(".")
    .map((d) => `"${d.replaceAll('"', '""')}"`)
    .join(".");

const MAP = "supabase/migrations";
let bestanden = [];
try {
  bestanden = readdirSync(MAP)
    .filter((n) => n.endsWith(".sql"))
    .sort();
} catch {}

// Welke migraties staan al op productie? (Een nieuw project heeft nog geen historie.)
const heeftHistorie =
  psql("select to_regclass('supabase_migrations.schema_migrations') is not null;") === "t";
const toegepast = new Set(
  heeftHistorie
    ? JSON.parse(
        psql(
          "select coalesce(jsonb_agg(version), '[]') from supabase_migrations.schema_migrations;",
        ) || "[]",
      )
    : [],
);

const tabellen = new Set();
for (const naam of bestanden) {
  if (toegepast.has(naam.split("_")[0])) continue;
  const sql = readFileSync(join(MAP, naam), "utf8");
  if (!zetGegevensOm(sql)) continue;
  for (const r of leesVerwachting(sql).regels) tabellen.add(r.tabel);
  for (const t of omgezetteTabellen(sql)) tabellen.add(t);
}

const opdrachten = [
  "create schema if not exists herstel;",
  "comment on schema herstel is 'Kopieën van tabellen vlak vóór een migratie die gegevens omzet. Na veertien dagen opgeruimd door deploy-db.yml.';",
  // Alleen de beheerder kan erbij; nooit via de API.
  `do $$ declare r text; begin
     foreach r in array array['anon', 'authenticated', 'public'] loop
       if r = 'public' or exists (select 1 from pg_roles where rolname = r) then
         execute format('revoke all on schema herstel from %s', r);
       end if;
     end loop;
   end $$;`,
];
const nu = stempel();
for (const t of [...tabellen].sort()) {
  const kaal = t.split(".")[1] ?? t;
  const kopie = `herstel.${kaal.slice(0, 49)}_${nu}`;
  // Een tabel die nog niet bestaat (de migratie maakt hem zelf), valt niets van te kopiëren.
  opdrachten.push(`do $$ begin
     if to_regclass(${lit(ident(t))}) is not null and to_regclass(${lit(ident(kopie))}) is null then
       execute ${lit(`create table ${ident(kopie)} as table ${ident(t)}`)};
       execute ${lit(`comment on table ${ident(kopie)} is ${lit(`kopie van ${t} vlak vóór de migratie, ${nu} UTC`)}`)};
       raise notice 'kopie gemaakt: %', ${lit(kopie)};
     end if;
   end $$;`);
}
opdrachten.push(
  "select coalesce(jsonb_agg(tablename), '[]') from pg_tables where schemaname = 'herstel';",
);

const bestaand = JSON.parse(psql(opdrachten.join("\n")).split("\n").at(-1) || "[]");
const weg = bestaand.filter((naam) => teOud(naam));
if (weg.length > 0) {
  psql(weg.map((naam) => `drop table if exists ${ident(`herstel.${naam}`)};`).join("\n"));
}

if (tabellen.size === 0) console.log("✓ geen migratie die gegevens omzet; geen kopie nodig");
else console.log(`✓ kopie in schema herstel (${nu} UTC) van: ${[...tabellen].sort().join(", ")}`);
if (weg.length > 0) console.log(`✓ ${weg.length} kopie(ën) ouder dan veertien dagen opgeruimd`);
