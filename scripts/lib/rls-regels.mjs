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

// --- Klantportaal: wie alleen een mailadres heeft, mag niets ------------------------------
//
// Bij een klantportaal (`"klantportaal": true` in stack.config.json) is er geen deur van
// Cloudflare: iedereen op internet kan per mail een account maken. `to authenticated` betekent
// dan "iedereen met een e-mailadres". De regel, in twee zinnen:
//
//   1. Elke policy voor ingelogde gebruikers (`to authenticated`, of zonder `to`) heeft in
//      elke `using` en `with check` een poort als harde eis: `public.is_medewerker()` of
//      `public.is_goedgekeurde_klant()`, met `and` eraan vast in elke tak van een `or`. Eén
//      policy `as restrictive for all` met alleen die eis dekt de hele tabel.
//   2. Elke `security definer`-functie en elke view in `public` waar een ingelogde gebruiker
//      bij kan, roept zelf een poort aan of staat met een reden in
//      `klantportaal_vrije_functies`; `open_tabellen` is leeg.
//
// De tekst van de migraties (guard-rls.mjs) en de database zelf (tests/rls/open-policies.test.ts)
// gaan door dezelfde beoordeling: `beoordeelKlantportaal`.

/** De poorten van de template. Een app kan er in `klantportaal_poorten` eigen bij zetten. */
export const BASISPOORTEN = ["is_medewerker", "is_goedgekeurde_klant", "sessie_via_cloudflare"];

/** Functies van de template die een ingelogde gebruiker zonder poort mag aanroepen. */
const VRIJ_VAN_DE_TEMPLATE = {
  klant_aanmelden: "zet alleen het eigen account op de lijst, niet goedgekeurd",
};

/** Vervangt tekst tussen enkele aanhalingstekens door `''`: wat in een tekst staat, telt niet. */
export function zonderTekst(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Zonder commentaar, tekst en dubbele aanhalingstekens, in kleine letters, met enkele spaties. */
function genormaliseerd(sql) {
  return zonderTekst(zonderCommentaar(sql))
    .replaceAll('"', "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Haalt haakjes weg die de hele uitdrukking omsluiten. */
function zonderBuitensteHaakjes(tekst) {
  let uit = tekst.trim();
  while (uit.startsWith("(") && sluitHaakje(uit, 0) === uit.length - 1) {
    uit = uit.slice(1, -1).trim();
  }
  return uit;
}

/** De plek van het haakje dat het haakje op `begin` sluit, of -1. */
function sluitHaakje(tekst, begin) {
  let diepte = 0;
  for (let i = begin; i < tekst.length; i++) {
    if (tekst[i] === "(") diepte++;
    else if (tekst[i] === ")") {
      diepte--;
      if (diepte === 0) return i;
    }
  }
  return -1;
}

/**
 * Splitst een voorwaarde op `or` of `and` op het hoogste niveau: niet binnen haakjes, niet
 * binnen `case ... end`, en niet de `and` die bij `between` hoort.
 */
function splitsOp(tekst, woord) {
  const delen = [];
  let diepte = 0;
  let geval = 0;
  let between = false;
  let begin = 0;
  const woorden = /[()[\]]|\b[a-z_]+\b/g;
  for (const m of tekst.matchAll(woorden)) {
    const w = m[0];
    if (w === "(" || w === "[") diepte++;
    else if (w === ")" || w === "]") diepte--;
    else if (w === "case") geval++;
    else if (w === "end" && geval > 0) geval--;
    else if (diepte === 0 && geval === 0) {
      if (w === "between") between = true;
      else if (w === "and" && between) between = false;
      else if (w === woord) {
        delen.push(tekst.slice(begin, m.index));
        begin = m.index + w.length;
      }
    }
  }
  delen.push(tekst.slice(begin));
  return delen.map((d) => d.trim());
}

function isPoort(factor, poorten) {
  let kaalDeel = zonderBuitensteHaakjes(factor);
  // `(select public.is_medewerker())`, en zoals de database het teruggeeft:
  // `( SELECT public.is_medewerker() AS is_medewerker)`.
  const gekozen = /^select (.+?)(?: as [a-z_0-9]+)?$/.exec(kaalDeel);
  if (gekozen) kaalDeel = zonderBuitensteHaakjes(gekozen[1] ?? "");
  const aanroep = /^public ?\. ?([a-z_0-9]+) ?\( ?\)$/.exec(kaalDeel);
  return aanroep !== null && poorten.includes(aanroep[1] ?? "");
}

/**
 * Is de poort een harde eis in deze voorwaarde? Dat is zo als de voorwaarde zonder poort nooit
 * waar kan zijn: in elke tak van een `or` staat een poort, met `and` aan de rest vast.
 * `public.is_medewerker() or true`, een poort in commentaar of in een tekst, `not`, of een
 * functie met dezelfde naam in een ander schema tellen niet.
 */
export function poortIsHardeEis(voorwaarde, poorten = BASISPOORTEN) {
  const tekst = zonderBuitensteHaakjes(genormaliseerd(voorwaarde));
  if (tekst === "") return false;
  // Een subquery is geen voorwaarde om op te splitsen: alleen `select <poort>` telt.
  if (tekst.startsWith("select ")) return isPoort(tekst, poorten);
  return splitsOp(tekst, "or").every((tak) =>
    splitsOp(tak, "and").some((factor) => {
      if (isPoort(factor, poorten)) return true;
      const binnen = factor.trim();
      const omsloten = binnen.startsWith("(") && sluitHaakje(binnen, 0) === binnen.length - 1;
      return omsloten && !/^\(\s*select\b/.test(binnen) && poortIsHardeEis(binnen, poorten);
    }),
  );
}

/** Roept deze tekst (de inhoud van een functie of view) een poort aan? */
function roeptPoortAan(inhoud, poorten, behalve = "") {
  const tekst = genormaliseerd(inhoud);
  return poorten
    .filter((p) => p !== behalve)
    .some((p) => new RegExp(String.raw`(?<![\w.])public ?\. ?${p} ?\( ?\)`).test(tekst));
}

/**
 * De migraties als losse opdrachten, met de inhoud van functies apart bewaard. In de tekst
 * van een opdracht staat op de plek van zo'n inhoud `§<nummer>§`.
 */
function opdrachtenMetInhoud(sql) {
  const inhoud = [];
  const tekst = zonderCommentaar(sql).replace(
    /\$([A-Za-z_]\w*)?\$([\s\S]*?)\$\1\$/g,
    (_, __, lijf) => {
      inhoud.push(lijf);
      return ` §${inhoud.length - 1}§ `;
    },
  );
  const opdrachten = zonderTekst(tekst)
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { opdrachten, inhoud };
}

/** De uitdrukking tussen haakjes na `sleutelwoord` (bijvoorbeeld `using`), of null. */
function tussenHaakjesNa(tekst, sleutelwoord) {
  const m = new RegExp(String.raw`\b${sleutelwoord}\s*\(`, "i").exec(tekst);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const dicht = sluitHaakje(tekst, open);
  return dicht < 0 ? tekst.slice(open + 1) : tekst.slice(open + 1, dicht);
}

function volledig(naam) {
  return `${schemaVan(naam)}.${kaal(naam)}`;
}

function rollenUit(rest) {
  return (
    /\bto\s+(.+?)(?=\s+(?:using|with)\b|$)/i
      .exec(rest)?.[1]
      ?.split(",")
      .map((r) => r.replaceAll('"', "").trim().toLowerCase())
      .filter(Boolean) ?? null
  );
}

/**
 * Wat de migraties over policies, functies en views zeggen, in volgorde gelezen (een `drop`
 * of `alter` later telt). Dit is het model dat `beoordeelKlantportaal` beoordeelt.
 */
export function modelUitMigraties(sql) {
  const { opdrachten, inhoud } = opdrachtenMetInhoud(sql);
  const policies = new Map();
  const functies = new Map();
  const views = new Map();
  let nieuweFunctiesVoorIedereen = true;
  const lijf = (tekst) =>
    [...tekst.matchAll(/§(\d+)§/g)].map((m) => inhoud[Number(m[1])] ?? "").join("\n");

  for (const opdracht of opdrachten) {
    let m = new RegExp(
      String.raw`^create\s+policy\s+${POLICY_NAAM}\s+on\s+${TABEL_NAAM}(.*)$`,
      "i",
    ).exec(opdracht);
    if (m) {
      const rest = m[3] ?? "";
      const tabel = volledig(m[2] ?? "");
      const naam = (m[1] ?? "").replaceAll('"', "");
      policies.set(`${tabel}/${naam}`, {
        tabel,
        naam,
        rollen: rollenUit(rest) ?? ["public"],
        restrictief: /^\s*as\s+restrictive\b/i.test(rest),
        cmd: /\bfor\s+(all|select|insert|update|delete)\b/i.exec(rest)?.[1]?.toLowerCase() ?? "all",
        using: tussenHaakjesNa(rest, "using"),
        check: tussenHaakjesNa(rest, String.raw`with\s+check`),
      });
      continue;
    }
    m = new RegExp(
      String.raw`^alter\s+policy\s+${POLICY_NAAM}\s+on\s+${TABEL_NAAM}(.*)$`,
      "i",
    ).exec(opdracht);
    if (m) {
      const tabel = volledig(m[2] ?? "");
      const naam = (m[1] ?? "").replaceAll('"', "");
      const rest = m[3] ?? "";
      const policy = policies.get(`${tabel}/${naam}`);
      if (!policy) continue;
      const nieuweNaam = new RegExp(String.raw`^\s*rename\s+to\s+${POLICY_NAAM}`, "i").exec(rest);
      if (nieuweNaam) {
        policies.delete(`${tabel}/${naam}`);
        policy.naam = (nieuweNaam[1] ?? "").replaceAll('"', "");
        policies.set(`${tabel}/${policy.naam}`, policy);
        continue;
      }
      policy.rollen = rollenUit(rest) ?? policy.rollen;
      policy.using = tussenHaakjesNa(rest, "using") ?? policy.using;
      policy.check = tussenHaakjesNa(rest, String.raw`with\s+check`) ?? policy.check;
      continue;
    }
    m = new RegExp(
      String.raw`^drop\s+policy\s+(?:if\s+exists\s+)?${POLICY_NAAM}\s+on\s+${TABEL_NAAM}`,
      "i",
    ).exec(opdracht);
    if (m) {
      policies.delete(`${volledig(m[2] ?? "")}/${(m[1] ?? "").replaceAll('"', "")}`);
      continue;
    }

    m =
      /^create\s+(or\s+replace\s+)?(?:function|procedure)\s+((?:"?\w+"?\.)?"?\w+"?)\s*\((.*)$/i.exec(
        opdracht,
      );
    if (m) {
      const naam = volledig(m[2] ?? "");
      const rest = m[3] ?? "";
      const vorige = functies.get(naam);
      const eigenInhoud = /§\d+§/.test(rest) ? lijf(rest) : rest;
      functies.set(naam, {
        naam,
        definer: /\bsecurity\s+definer\b/i.test(rest) || (!m[1] && (vorige?.definer ?? false)),
        trigger: /\breturns\s+(?:event_)?trigger\b/i.test(rest),
        // Rechten blijven bij `create or replace` staan; een nieuwe functie mag iedereen uitvoeren.
        viaPublic: vorige?.viaPublic ?? nieuweFunctiesVoorIedereen,
        viaAuthenticated: vorige?.viaAuthenticated ?? true,
        // Zonder $$ staat de inhoud in de opdracht zelf (`return ...`, `begin atomic`). Met
        // `or replace` vervangt de nieuwe inhoud de oude; anders is het een variant ernaast.
        inhoud: m[1] ? [eigenInhoud] : [...(vorige?.inhoud ?? []), eigenInhoud],
      });
      continue;
    }
    m = /^alter\s+(?:function|procedure|routine)\s+((?:"?\w+"?\.)?"?\w+"?)(.*)$/i.exec(opdracht);
    if (m) {
      const functie = functies.get(volledig(m[1] ?? ""));
      if (functie && /\bsecurity\s+definer\b/i.test(m[2] ?? "")) functie.definer = true;
      if (functie && /\bsecurity\s+invoker\b/i.test(m[2] ?? "")) functie.definer = false;
      continue;
    }
    m = /^drop\s+(?:function|procedure|routine)\s+(?:if\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)/i.exec(
      opdracht,
    );
    if (m) {
      functies.delete(volledig(m[1] ?? ""));
      continue;
    }

    // Rechten op functies. `execute` of `all`, op één functie of op alle in een schema.
    m =
      /^(alter\s+default\s+privileges\b.*?\s)?(grant|revoke)\s+(?:grant\s+option\s+for\s+)?(.+?)\s+on\s+(.+?)\s+(?:to|from)\s+(.+?)(?:\s+(?:cascade|restrict|with\s+grant\s+option))?$/i.exec(
        opdracht,
      );
    if (m && /\b(?:execute|all)\b/i.test(m[3] ?? "")) {
      const geven = (m[2] ?? "").toLowerCase() === "grant";
      const object = (m[4] ?? "").trim();
      const wie = (m[5] ?? "").split(",").map((r) => r.replaceAll('"', "").trim().toLowerCase());
      const zet = (functie) => {
        if (wie.includes("public")) functie.viaPublic = geven;
        if (wie.includes("authenticated")) functie.viaAuthenticated = geven;
      };
      if (m[1]) {
        if (/^(?:functions|routines)$/i.test(object) && wie.includes("public")) {
          nieuweFunctiesVoorIedereen = geven;
        }
      } else if (/^all\s+(?:functions|routines|procedures)\s+in\s+schema\b/i.test(object)) {
        const schemas = object
          .replace(/^.*\bin\s+schema\s+/i, "")
          .split(",")
          .map((s) => s.replaceAll('"', "").trim().toLowerCase());
        for (const functie of functies.values()) {
          if (schemas.includes(functie.naam.split(".")[0])) zet(functie);
        }
      } else if (/^(?:function|procedure|routine)\s/i.test(object)) {
        const namen = object
          .replace(/^(?:function|procedure|routine)\s+/i, "")
          .replace(/\([^)]*\)/g, "")
          .split(",");
        for (const naam of namen) {
          const functie = functies.get(volledig(naam.trim()));
          if (functie) zet(functie);
        }
      }
      continue;
    }

    m =
      /^create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:recursive\s+)?view\s+((?:"?\w+"?\.)?"?\w+"?)(.*)$/i.exec(
        opdracht,
      );
    if (m) {
      const rest = m[2] ?? "";
      const vraag = /\bas\b([\s\S]*)$/i.exec(rest)?.[1] ?? "";
      const opties = /^\s*(?:\([^)]*\)\s*)?with\s*\(([^)]*)\)/i.exec(rest)?.[1] ?? "";
      views.set(volledig(m[1] ?? ""), {
        naam: volledig(m[1] ?? ""),
        invoker: /\bsecurity_invoker\b(?!\s*=\s*(?:false|off|0))/i.test(opties),
        inhoud: vraag,
      });
      continue;
    }
    m = /^alter\s+view\s+(?:if\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)\s+(re)?set\s*\(([^)]*)\)/i.exec(
      opdracht,
    );
    if (m) {
      const view = views.get(volledig(m[1] ?? ""));
      if (view && /\bsecurity_invoker\b/i.test(m[3] ?? "")) {
        view.invoker = !m[2] && !/\bsecurity_invoker\s*=\s*(?:false|off|0)/i.test(m[3] ?? "");
      }
      continue;
    }
    m = /^drop\s+view\s+(?:if\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)/i.exec(opdracht);
    if (m) views.delete(volledig(m[1] ?? ""));
  }

  return {
    policies: [...policies.values()],
    functies: [...functies.values()]
      .filter((f) => !f.trigger)
      .map((f) => ({
        naam: f.naam,
        definer: f.definer,
        uitvoerbaar: f.viaPublic || f.viaAuthenticated,
        inhoud: f.inhoud,
      })),
    views: [...views.values()],
  };
}

const VOOR_INGELOGDEN = ["authenticated", "public"];
const SCHEMAS = ["public", "api"];

/**
 * Wat er bij een klantportaal mis is. `model` komt uit de migraties (`modelUitMigraties`) of
 * uit de database zelf (tests/rls/lib/klantportaal-poort.ts); `config` is wat
 * `klantportaal()` uit stack.config.json leest, met `open_tabellen` erbij.
 */
export function beoordeelKlantportaal(model, config = {}) {
  const eigenPoorten = Object.keys(config.poorten ?? {});
  const poorten = [...BASISPOORTEN, ...eigenPoorten];
  const vrij = { ...VRIJ_VAN_DE_TEMPLATE, ...(config.vrijeFuncties ?? {}) };
  const problemen = [];

  for (const tabel of Object.keys(config.openTabellen ?? {})) {
    problemen.push(
      `open_tabellen.${tabel}: een klantportaal kent geen open tabellen, want "iedereen binnen" is daar iedereen met een e-mailadres`,
    );
  }

  const voorIngelogden = model.policies.filter((p) =>
    p.rollen.some((rol) => VOOR_INGELOGDEN.includes(rol)),
  );
  const gedekt = new Set(
    voorIngelogden
      .filter(
        (p) =>
          p.restrictief &&
          p.cmd === "all" &&
          p.using !== null &&
          poortIsHardeEis(p.using, poorten) &&
          (p.check === null || poortIsHardeEis(p.check, poorten)),
      )
      .map((p) => p.tabel),
  );
  for (const p of voorIngelogden) {
    if (p.restrictief || gedekt.has(p.tabel)) continue;
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

  const functies = new Map();
  for (const f of model.functies) {
    const [schema, naam] = f.naam.split(".");
    if (!SCHEMAS.includes(schema)) continue;
    if (schema === "public") functies.set(naam, f);
    const basis = schema === "public" && BASISPOORTEN.includes(naam);
    if (basis || !f.definer || !f.uitvoerbaar) continue;
    if (schema === "public" && naam in vrij) continue;
    const eigenPoort = schema === "public" && eigenPoorten.includes(naam);
    const eis = eigenPoort ? BASISPOORTEN : poorten;
    if (!f.inhoud.every((inhoud) => roeptPoortAan(inhoud, eis, naam))) {
      problemen.push(
        eigenPoort
          ? `${f.naam}: staat in klantportaal_poorten maar roept zelf geen poort van de template aan`
          : `${f.naam}: security definer, aan te roepen door iedereen met een e-mailadres, en roept geen poort aan`,
      );
    }
  }
  for (const naam of ["is_medewerker", "is_goedgekeurde_klant"]) {
    if (!functies.has(naam)) {
      problemen.push(
        `public.${naam}() ontbreekt: neem de migratie van het klantportaal over uit de template`,
      );
    }
  }
  const isMedewerker = functies.get("is_medewerker");
  if (
    isMedewerker &&
    !isMedewerker.inhoud.every((inhoud) => roeptPoortAan(inhoud, ["sessie_via_cloudflare"]))
  ) {
    problemen.push(
      "public.is_medewerker(): moet public.sessie_via_cloudflare() aanroepen, anders is een mailsessie ook medewerker",
    );
  }
  for (const naam of eigenPoorten) {
    if (!functies.has(naam)) {
      problemen.push(`klantportaal_poorten.${naam}: er is geen functie public.${naam}()`);
    }
  }

  for (const v of model.views) {
    if (!SCHEMAS.includes(v.naam.split(".")[0])) continue;
    if (v.invoker || roeptPoortAan(v.inhoud, poorten)) continue;
    problemen.push(
      `${v.naam}: een view zonder security_invoker gaat langs de policies heen en roept geen poort aan`,
    );
  }
  return problemen;
}

/** De controle op de tekst van de migraties, voor guard-rls.mjs. */
export function problemenKlantportaal(sql, config = {}) {
  return beoordeelKlantportaal(modelUitMigraties(sql), config);
}
