import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  beoordeel,
  leesVerwachting,
  omgezetteTabellen,
  zetGegevensOm,
} from "./lib/verwachting.mjs";

/**
 * De droogloop: de migraties van een pull request op de testdatabase (een kopie van
 * productie) draaien, tellen hoeveel rijen ze per tabel raken, en alles terugdraaien.
 * Draait in .github/workflows/droogloop.yml, altijd in de versie van main; de migraties uit
 * de PR zijn daar alleen gegevens.
 *
 *   node scripts/droogloop.mjs klaarzetten   env HEAD_SHA, MAP
 *     Zet de migraties die de PR toevoegt of wijzigt in MAP (met `git show`, er draait niets
 *     uit de PR) en schrijft `nodig=true` naar GITHUB_OUTPUT als er een bij zit die gegevens
 *     omzet (UPDATE of DELETE).
 *
 *   node scripts/droogloop.mjs uitvoeren     env DROOGLOOP_DB_URL, MAP
 *     Draait de migraties uit MAP die nog niet op de testdatabase staan, in één transactie die
 *     altijd wordt teruggedraaid, en schrijft MAP/verslag.md en `geslaagd=true|false`.
 *
 * Hoe het veilig blijft: elke migratie gaat als tekst tussen dollar-quotes met een
 * willekeurige naam naar `execute` in een `do`-blok. psql ziet er dus niets in (geen `\!` of
 * andere opdrachten van psql), en een `commit` in de migratie geeft een fout in plaats van
 * dat hij iets vastlegt. Aan het eind staat `rollback`; mislukt er iets, dan sluit psql de
 * verbinding en draait Postgres alles zelf terug. Er blijft niets achter op de testdatabase,
 * ook geen regel in de migratiehistorie.
 *
 * Wat niet terug kan: een migratie die zelf naar buiten belt (bijvoorbeeld met de extensie
 * `http`), en volgnummers van sequences. Dat is hetzelfde als na de merge.
 */

const opdracht = process.argv[2];
const MAP = process.env.MAP ?? "droogloop";

function uitvoer(naam, waarde) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${naam}=${waarde}\n`);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

if (opdracht === "klaarzetten") {
  const sha = process.env.HEAD_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    console.error("✗ HEAD_SHA ontbreekt of is geen commit.");
    process.exit(1);
  }
  const basis = git(["merge-base", "origin/main", sha]).trim();
  const paden = git([
    "diff",
    "--name-only",
    "--diff-filter=AM",
    basis,
    sha,
    "--",
    "supabase/migrations",
  ])
    .split("\n")
    .filter((p) => /^supabase\/migrations\/[^/]+\.sql$/.test(p));
  mkdirSync(MAP, { recursive: true });
  let nodig = false;
  for (const pad of paden) {
    const sql = git(["show", `${sha}:${pad}`]);
    writeFileSync(join(MAP, basename(pad)), sql);
    if (zetGegevensOm(sql)) nodig = true;
  }
  console.log(
    `${paden.length} migratie(s) uit de PR klaargezet; gegevens omzetten: ${nodig ? "ja" : "nee"}`,
  );
  uitvoer("nodig", String(nodig));
  process.exit(0);
}

if (opdracht !== "uitvoeren") {
  console.error("Gebruik: node scripts/droogloop.mjs klaarzetten | uitvoeren");
  process.exit(2);
}

const adres = process.env.DROOGLOOP_DB_URL ?? "";
if (!adres) {
  console.error("✗ DROOGLOOP_DB_URL ontbreekt.");
  process.exit(1);
}

function psql(sql) {
  const r = spawnSync("psql", [adres, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: r.status === 0, uit: (r.stdout ?? "").trim(), fout: (r.stderr ?? "").trim() };
}

/** Een tekst als letterlijke waarde in SQL. */
const lit = (t) => `'${String(t).replaceAll("'", "''")}'`;
/** Een naam als `schema.tabel` als veilige naam in SQL. */
const ident = (t) =>
  t
    .split(".")
    .map((d) => `"${d.replaceAll('"', '""')}"`)
    .join(".");

const bestanden = readdirSync(MAP)
  .filter((n) => n.endsWith(".sql"))
  .sort();

// Wat staat er al op de testdatabase? Een migratie die er al staat (bijvoorbeeld met de hand
// gezet), draait niet nog een keer.
const historie = psql(
  "select coalesce(json_agg(version), '[]') from supabase_migrations.schema_migrations;",
);
const toegepast = new Set(historie.ok ? JSON.parse(historie.uit || "[]") : []);
const migraties = bestanden
  .map((naam) => ({
    naam,
    versie: naam.split("_")[0] ?? naam,
    sql: readFileSync(join(MAP, naam), "utf8"),
  }))
  .filter((m) => {
    if (!toegepast.has(m.versie)) return true;
    console.log(`i ${m.naam} staat al op de testdatabase en draait niet opnieuw`);
    return false;
  });

const omzetten = migraties.filter((m) => zetGegevensOm(m.sql));
if (omzetten.length === 0) {
  writeFileSync(
    join(MAP, "verslag.md"),
    "Geen migratie die bestaande gegevens omzet; niets te oefenen.\n",
  );
  uitvoer("geslaagd", "true");
  uitvoer("samenvatting", "niets te oefenen");
  process.exit(0);
}

// De tabellen om voorbeelden van te laten zien, met hun primaire sleutel (om voor en na naast
// elkaar te zetten). Alleen tabellen die nu al bestaan.
const tabellen = [
  ...new Set(
    omzetten.flatMap((m) => [
      ...leesVerwachting(m.sql).regels.map((r) => r.tabel),
      ...omgezetteTabellen(m.sql),
    ]),
  ),
].sort();
const sleutels = {};
const sleutelVraag = psql(
  `select coalesce(json_object_agg(t, k), '{}') from (
     select n.nspname || '.' || c.relname as t, json_agg(a.attname order by a.attnum) as k
     from pg_index i
     join pg_class c on c.oid = i.indrelid
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
     where i.indisprimary and (n.nspname || '.' || c.relname) in (${tabellen.map(lit).join(", ") || "''"})
     group by 1) s;`,
);
if (sleutelVraag.ok) Object.assign(sleutels, JSON.parse(sleutelVraag.uit || "{}"));

const merk = randomBytes(8).toString("hex");
const xid = "(pg_current_xact_id()::text::bigint % 4294967296)::text";
const delen = [
  "begin;",
  "set local statement_timeout = '10min';",
  // Kort wachten op een slot: de preview gebruikt dezelfde database.
  "set local lock_timeout = '15s';",
  "create temp table _droog_stand (stap int, tabel text, geraakt bigint) on commit drop;",
];
tabellen.forEach((t, i) => {
  if (sleutels[t])
    delen.push(`create temp table _voor_${i} on commit drop as select * from ${ident(t)};`);
});
migraties.forEach((m, i) => {
  delen.push(`do $d_${merk}$ begin execute $m_${merk}$\n${m.sql}\n$m_${merk}$; end $d_${merk}$;`);
  delen.push(
    `insert into _droog_stand select ${i}, schemaname || '.' || relname, n_tup_upd + n_tup_del
     from pg_stat_xact_user_tables where schemaname not like 'pg\\_%';`,
  );
});
const voorbeelden = tabellen.map((t, i) => {
  const k = sleutels[t];
  const na = `(select coalesce(json_agg(to_jsonb(n)), '[]') from (select * from ${ident(t)} n where n.xmin::text = ${xid} limit 5) n)`;
  if (!k) return `${lit(t)}, json_build_object('na', ${na})`;
  const gelijk = k.map((c) => `n.${ident(c)} = v.${ident(c)}`).join(" and ");
  const voor = `(select coalesce(json_agg(to_jsonb(v)), '[]') from (select v.* from _voor_${i} v join ${ident(t)} n on ${gelijk} where n.xmin::text = ${xid} limit 5) v)`;
  const weg = `(select coalesce(json_agg(to_jsonb(v)), '[]') from (select v.* from _voor_${i} v where not exists (select 1 from ${ident(t)} n where ${gelijk}) limit 5) v)`;
  return `${lit(t)}, json_build_object('voor', ${voor}, 'na', ${na}, 'weg', ${weg})`;
});
delen.push(
  `select 'UITSLAG:' || json_build_object(
     'stand', (select coalesce(json_agg(s), '[]') from _droog_stand s),
     'voorbeelden', json_build_object(${voorbeelden.join(", ")}))::text;`,
);
delen.push("rollback;");

const run = psql(delen.join("\n"));

/** Een rij kort genoeg voor een PR-reactie. */
function kort(rij) {
  const ingekort = Object.fromEntries(
    Object.entries(rij).map(([k, v]) => [
      k,
      typeof v === "string" && v.length > 60 ? `${v.slice(0, 57)}...` : v,
    ]),
  );
  const tekst = JSON.stringify(ingekort);
  return tekst.length > 400 ? `${tekst.slice(0, 397)}...` : tekst;
}

const regels = [
  "<!-- droogloop -->",
  "**Droogloop op de testdatabase** (kopie van productie, daarna teruggedraaid)",
  "",
];
let geslaagd = run.ok;
let samenvatting = "";

if (!run.ok) {
  const fout = run.fout.split("\n").slice(0, 12).join("\n");
  regels.push(
    "De migraties liepen vast in de droogloop op de testdatabase; na de merge zou Database bijwerken hier ook vastlopen. Een migratie hoort ook geen `begin` of `commit` te bevatten.",
    "",
    "```",
    fout,
    "```",
  );
  samenvatting = "de migraties lopen vast op de testdatabase";
} else {
  const uitslag = JSON.parse(run.uit.slice(run.uit.indexOf("UITSLAG:") + "UITSLAG:".length));
  const perStap = new Map();
  for (const r of uitslag.stand ?? []) {
    if (!perStap.has(r.stap)) perStap.set(r.stap, {});
    perStap.get(r.stap)[r.tabel] = Number(r.geraakt);
  }
  const fouten = [];
  migraties.forEach((m, i) => {
    const nu = perStap.get(i) ?? {};
    const vorig = perStap.get(i - 1) ?? {};
    const geraakt = {};
    for (const [t, n] of Object.entries(nu)) {
      const verschil = n - (vorig[t] ?? 0);
      if (verschil > 0) geraakt[t] = verschil;
    }
    if (!zetGegevensOm(m.sql)) return;
    const { regels: verwacht } = leesVerwachting(m.sql);
    const migratieFouten = beoordeel(verwacht, geraakt);
    fouten.push(...migratieFouten.map((f) => `${m.naam}: ${f}`));
    regels.push(
      `**${m.naam}** ${migratieFouten.length === 0 ? "✓ binnen de verwachting" : "✗ buiten de verwachting"}`,
      "",
    );
    regels.push("| Tabel | Geraakt | Verwacht |", "|---|---|---|");
    const alle = [...new Set([...verwacht.map((r) => r.tabel), ...Object.keys(geraakt)])].sort();
    for (const t of alle) {
      const r = verwacht.find((v) => v.tabel === t);
      regels.push(
        `| ${t} | ${geraakt[t] ?? 0} | ${r ? (r.min === r.max ? r.min : `${r.min}-${r.max}`) : "niet genoemd"} |`,
      );
    }
    regels.push("");
    for (const f of migratieFouten) regels.push(`- ✗ ${f}`);
    if (migratieFouten.length > 0) regels.push("");
  });
  for (const [t, v] of Object.entries(uitslag.voorbeelden ?? {})) {
    const blok = [];
    for (const [soort, kop] of [
      ["voor", "Voor"],
      ["na", "Na"],
      ["weg", "Verwijderd"],
    ]) {
      const rijen = v[soort] ?? [];
      if (rijen.length === 0) continue;
      blok.push(`${kop}:`, ...rijen.map((r) => `  ${kort(r)}`));
    }
    if (blok.length === 0) continue;
    regels.push(
      `<details><summary>Vijf voorbeelden uit ${t}</summary>`,
      "",
      "```",
      ...blok,
      "```",
      "",
      "</details>",
      "",
    );
  }
  regels.push(
    "Na de merge zet Database bijwerken vlak vóór deze migratie een kopie van de geraakte tabellen in het schema `herstel` (veertien dagen bewaard). De weg terug staat in `docs/routes/databasewijziging.md`.",
  );
  geslaagd = fouten.length === 0;
  samenvatting = geslaagd ? "binnen de verwachting" : fouten[0];
}

writeFileSync(join(MAP, "verslag.md"), `${regels.join("\n")}\n`);
console.log(regels.join("\n"));
uitvoer("geslaagd", String(geslaagd));
uitvoer("samenvatting", samenvatting.replaceAll("\n", " ").slice(0, 130));
process.exit(0);
