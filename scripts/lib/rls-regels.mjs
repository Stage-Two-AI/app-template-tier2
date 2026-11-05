import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Het lezen van de migraties voor de RLS-guards (guard-rls.mjs, guard-rls-tests.mjs). Los
 * van de guards, zodat de regels zelf te testen zijn (tests/unit/rls-regels.test.ts).
 *
 * Dit is tekst lezen, geen database: snel en al in de job Code, ook bij een concept-PR. De
 * echte controle op de policies die in de database staan, doet tests/rls/open-policies.test.ts
 * in de databasejob.
 */

/** Haalt SQL-commentaar weg, zodat een voorbeeld in commentaar geen alarm geeft. */
export function zonderCommentaar(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Vervangt de inhoud van functies en `do`-blokken (`$$ ... $$`, `$tag$ ... $tag$`) door een
 * spatie. Zo splitst `;` binnen een functie de tekst niet, en telt wat een functie later doet
 * niet als iets wat de migratie zelf doet.
 */
export function zonderFunctieInhoud(sql) {
  return sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, " ");
}

/** Alle migraties in volgorde, zonder commentaar, als één tekst. Null als de map ontbreekt. */
export function leesMigraties(map = "supabase/migrations") {
  let namen;
  try {
    namen = readdirSync(map)
      .filter((naam) => naam.endsWith(".sql"))
      .sort();
  } catch {
    return null;
  }
  return namen.map((naam) => zonderCommentaar(readFileSync(join(map, naam), "utf8"))).join("\n");
}

/** Een naam zonder aanhalingstekens en zonder schema, in kleine letters. */
function kaal(naam) {
  return naam.replaceAll('"', "").split(".").at(-1).toLowerCase();
}

/** Het schema van een (eventueel gekwalificeerde) naam; zonder schema is dat `public`. */
function schemaVan(naam) {
  const delen = naam.replaceAll('"', "").split(".");
  return delen.length > 1 ? delen[0].toLowerCase() : "public";
}

/** De tabellen in het schema `public`, na alle `create table` en `drop table` in volgorde. */
export function tabellenInPublic(sql) {
  const tabellen = new Set();
  const opdracht =
    /\b(create\s+table\s+(?:if\s+not\s+exists\s+)?|drop\s+table\s+(?:if\s+exists\s+)?)("?[\w.]+"?(?:\."?\w+"?)?)/gi;
  for (const m of sql.matchAll(opdracht)) {
    const naam = m[2] ?? "";
    if (/^create/i.test(m[1] ?? "")) {
      if (schemaVan(naam) === "public") tabellen.add(kaal(naam));
    } else {
      tabellen.delete(kaal(naam));
    }
  }
  return tabellen;
}

/** De losse opdrachten van een migratie, zonder commentaar en zonder de inhoud van functies. */
function opdrachten(sql) {
  return zonderFunctieInhoud(zonderCommentaar(sql))
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const POLICY_NAAM = String.raw`("[^"]+"|\w+)`;
const TABEL_NAAM = String.raw`((?:"?\w+"?\.)?"?\w+"?)`;

/**
 * Policies met `using (true)` of `with check (true)`: die laten iedereen met die rol alle
 * rijen zien of schrijven. In volgorde gelezen, dus een `drop policy` later haalt hem weer weg.
 *
 * Geeft per open policy terug: tabel, naam, rollen (zonder `to`-regel is dat `public`, dus
 * iedereen met de openbare sleutel).
 */
export function openPolicies(sql) {
  const policies = new Map();
  const weg = new RegExp(
    String.raw`^drop\s+policy\s+(?:if\s+exists\s+)?${POLICY_NAAM}\s+on\s+${TABEL_NAAM}`,
    "i",
  );
  const nieuw = new RegExp(
    String.raw`^create\s+policy\s+${POLICY_NAAM}\s+on\s+${TABEL_NAAM}(.*)$`,
    "i",
  );
  for (const opdracht of opdrachten(sql)) {
    const w = weg.exec(opdracht);
    if (w) {
      policies.delete(`${kaal(w[2] ?? "")}/${(w[1] ?? "").replaceAll('"', "")}`);
      continue;
    }
    const p = nieuw.exec(opdracht);
    if (!p) continue;
    const rest = p[3] ?? "";
    const tabel = kaal(p[2] ?? "");
    const naam = (p[1] ?? "").replaceAll('"', "");
    const rollen = /\bto\s+(.+?)(?=\s+(?:using|with)\b|$)/i
      .exec(rest)?.[1]
      ?.split(",")
      .map((r) => r.replaceAll('"', "").trim().toLowerCase())
      .filter(Boolean) ?? ["public"];
    const open = /\b(?:using|with\s+check)\s*\(\s*\(?\s*true\s*\)?\s*\)/i.test(rest);
    policies.set(`${tabel}/${naam}`, { tabel, naam, rollen, open });
  }
  return [...policies.values()].filter((p) => p.open);
}

/**
 * Wat er mis is met de open policies, gemeten aan de lijst `open_tabellen`:
 * - voor `anon` of `public` is `true` altijd fout (iedereen met de openbare sleutel);
 * - voor `authenticated` of een eigen rol alleen goed als de tabel in `open_tabellen` staat.
 */
export function problemenMetOpenPolicies(sql, openTabellen = {}) {
  const problemen = [];
  for (const p of openPolicies(sql)) {
    if (p.rollen.includes("anon") || p.rollen.includes("public")) {
      problemen.push(
        `${p.tabel} (policy "${p.naam}"): using (true) voor iedereen met de openbare sleutel (${p.rollen.join(", ")})`,
      );
    } else if (!(p.tabel in openTabellen)) {
      problemen.push(
        `${p.tabel} (policy "${p.naam}"): using (true) zonder regel in open_tabellen (stack.config.json)`,
      );
    }
  }
  return problemen;
}

const SCHRIJVEN = ["insert", "update", "delete", "truncate"];

/** De schrijfrechten in een rijtje rechten, zoals `select, insert` of `all privileges`. */
function schrijfrechten(rechten) {
  const tekst = rechten.toLowerCase();
  if (/\ball\b/.test(tekst)) return [...SCHRIJVEN];
  return SCHRIJVEN.filter((r) => new RegExp(String.raw`\b${r}\b`).test(tekst));
}

/**
 * Schrijfrechten voor een leesrol. Een rol waarmee een andere app deze database leest, mag
 * alleen `select`. Gelezen in volgorde: een `revoke` later haalt een recht weer weg. Ook
 * `alter default privileges ... grant` telt, want dat geeft de rol rechten op elke nieuwe tabel.
 */
export function schrijfrechtenVoorLeesrollen(sql, leesrollen = []) {
  if (leesrollen.length === 0) return [];
  const rollen = new Set(leesrollen.map((r) => r.toLowerCase()));
  const stand = new Map();
  const geef =
    /^(?:alter\s+default\s+privileges\b.*?\s)?grant\s+(.+?)\s+on\s+(.+?)\s+to\s+(.+?)(?:\s+with\s+grant\s+option)?$/i;
  const neem =
    /^(?:alter\s+default\s+privileges\b.*?\s)?revoke\s+(?:grant\s+option\s+for\s+)?(.+?)\s+on\s+(.+?)\s+from\s+(.+?)(?:\s+(?:cascade|restrict))?$/i;
  for (const opdracht of opdrachten(sql)) {
    const isGrant = !/^(?:alter\s+default\s+privileges\b.*?\s)?revoke\b/i.test(opdracht);
    const g = (isGrant ? geef : neem).exec(opdracht);
    if (!g) continue;
    const rechten = schrijfrechten(g[1] ?? "");
    if (rechten.length === 0) continue;
    const object = (g[2] ?? "").trim().toLowerCase();
    const ontvangers = (g[3] ?? "")
      .split(",")
      .map((r) => r.replaceAll('"', "").trim().toLowerCase());
    for (const rol of ontvangers) {
      if (!rollen.has(rol)) continue;
      const sleutel = `${rol} op ${object}`;
      const huidig = new Set(stand.get(sleutel) ?? []);
      for (const recht of rechten) {
        if (isGrant) huidig.add(recht);
        else huidig.delete(recht);
      }
      stand.set(sleutel, huidig);
    }
  }
  return [...stand.entries()]
    .filter(([, rechten]) => rechten.size > 0)
    .map(([sleutel, rechten]) => `${sleutel}: ${[...rechten].join(", ")}`);
}

/**
 * Welke tabellen een A/B-test hebben: een aanroep `controleerAfscherming({ tabel: "<naam>"`
 * in tests/rls/ (de hulp staat in tests/rls/lib/afscherming.ts). Alleen de naam noemen
 * telt niet; het moet die aanroep zijn.
 */
export function gedekteTabellen(testtekst) {
  // Een voorbeeld in commentaar (zoals in tests/rls/lib/afscherming.ts) telt niet.
  const tekst = testtekst.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const aanroep = /controleerAfscherming\(\s*\{[\s\S]{0,200}?\btabel:\s*["'`](\w+)["'`]/g;
  return new Set([...tekst.matchAll(aanroep)].map((m) => m[1].toLowerCase()));
}
