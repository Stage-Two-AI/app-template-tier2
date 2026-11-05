/**
 * Migraties die bestaande gegevens omzetten (een UPDATE of DELETE). Zo'n migratie zet
 * bovenin, als commentaar, per tabel hoeveel rijen hij verwacht te raken:
 *
 *   -- verwachting: public.klanten 120-140
 *   -- verwachting: orders 0-5
 *
 * Eén regel per tabel waarin de migratie rijen wijzigt of verwijdert: de tabel (zonder schema
 * is dat `public`) en een bereik `<min>-<max>`, of één getal als het precies zoveel moet zijn.
 * Het telt de rijen die de migratie in die tabel wijzigt (update) of verwijdert (delete);
 * nieuwe rijen (insert) tellen niet mee.
 *
 * - guard-migrations.mjs (job Code) eist zo'n regel voor elke tabel die een UPDATE of DELETE
 *   in een gewijzigde migratie raakt;
 * - droogloop.mjs draait de migratie op de testdatabase (een kopie van productie) en is rood
 *   als het aantal buiten het bereik valt, of als hij een tabel raakt die er niet bij staat;
 * - herstel-kopie.mjs kopieert vlak vóór de uitrol op productie de tabellen uit deze regels
 *   naar het schema `herstel`.
 *
 * Losse functies, zodat ze te testen zijn zonder database (tests/unit/verwachting.test.ts).
 */

const REGEL = /^\s*--\s*verwachting\s*:\s*(.*)$/gim;
const INHOUD = /^((?:"?[\w$]+"?\.)?"?[\w$]+"?)\s+(\d+)(?:\s*-\s*(\d+))?\s*(?:rijen)?\s*$/i;

/** Een tabelnaam als `schema.tabel`, zonder aanhalingstekens, in kleine letters. */
export function volledigeNaam(naam) {
  const delen = naam.replaceAll('"', "").toLowerCase().split(".");
  return delen.length > 1 ? `${delen[0]}.${delen[1]}` : `public.${delen[0]}`;
}

/**
 * De regels `-- verwachting:` uit een migratie. Geeft `{ regels, fouten }`: regels als
 * `{ tabel: "public.klanten", min, max }`, fouten als tekst per regel die niet klopt.
 */
export function leesVerwachting(sql) {
  const regels = [];
  const fouten = [];
  for (const m of sql.matchAll(REGEL)) {
    const tekst = (m[1] ?? "").trim();
    const d = INHOUD.exec(tekst);
    if (!d) {
      fouten.push(
        `"-- verwachting: ${tekst}" klopt niet; schrijf "-- verwachting: <tabel> <min>-<max>"`,
      );
      continue;
    }
    const min = Number(d[2]);
    const max = d[3] === undefined ? min : Number(d[3]);
    if (max < min) {
      fouten.push(`"-- verwachting: ${tekst}": het hoogste getal staat vóór het laagste`);
      continue;
    }
    regels.push({ tabel: volledigeNaam(d[1] ?? ""), min, max });
  }
  return { regels, fouten };
}

/** De migratie zonder commentaar en zonder de inhoud van functies en `do`-blokken. */
function kern(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

const NAAM = String.raw`((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)`;

/**
 * De tabellen waarin deze migratie zelf rijen wijzigt of verwijdert: `update <tabel> set` en
 * `delete from <tabel>`. Wat een functie later doet, telt niet (de inhoud van functies wordt
 * overgeslagen), en `on delete cascade` of `for update` ook niet.
 */
export function omgezetteTabellen(sql) {
  const tekst = kern(sql);
  const tabellen = new Set();
  const update = new RegExp(
    String.raw`\bupdate\s+(?:only\s+)?${NAAM}(?:\s+(?:as\s+)?\w+)?\s+set\b`,
    "gi",
  );
  const verwijder = new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${NAAM}`, "gi");
  for (const m of tekst.matchAll(update)) tabellen.add(volledigeNaam(m[1] ?? ""));
  for (const m of tekst.matchAll(verwijder)) tabellen.add(volledigeNaam(m[1] ?? ""));
  return [...tabellen];
}

/** Zet deze migratie bestaande gegevens om (een UPDATE of DELETE buiten een functie)? */
export function zetGegevensOm(sql) {
  return omgezetteTabellen(sql).length > 0;
}

/**
 * Wat er mist aan de verwachting van één migratie: tabellen met een UPDATE of DELETE zonder
 * regel, en regels die niet te lezen zijn. Leeg als alles klopt.
 */
export function problemenMetVerwachting(sql) {
  const { regels, fouten } = leesVerwachting(sql);
  const verwacht = new Set(regels.map((r) => r.tabel));
  const zonder = omgezetteTabellen(sql).filter((t) => !verwacht.has(t));
  return [
    ...fouten,
    ...zonder.map(
      (t) => `${t}: een UPDATE of DELETE zonder regel "-- verwachting: ${t} <min>-<max>"`,
    ),
  ];
}

/**
 * De uitslag van de droogloop voor één migratie, gemeten aan de verwachting.
 * `geraakt` is per tabel (`schema.tabel`) het aantal gewijzigde plus verwijderde rijen.
 * Geeft een lijst fouten; leeg is groen.
 */
export function beoordeel(regels, geraakt) {
  const fouten = [];
  const verwacht = new Map(regels.map((r) => [r.tabel, r]));
  for (const r of regels) {
    const n = geraakt[r.tabel] ?? 0;
    if (n < r.min || n > r.max) {
      fouten.push(
        `${r.tabel}: ${n} rijen geraakt, verwacht ${r.min === r.max ? r.min : `${r.min}-${r.max}`}`,
      );
    }
  }
  for (const [tabel, n] of Object.entries(geraakt)) {
    if (n > 0 && !verwacht.has(tabel)) {
      fouten.push(`${tabel}: ${n} rijen geraakt, maar deze tabel staat niet in de verwachting`);
    }
  }
  return fouten;
}

/** Voor herstel-kopie.mjs: `20261105_1432` in UTC, de datum en tijd in de naam van een kopie. */
export function stempel(datum = new Date()) {
  const iso = datum.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}_${iso.slice(11, 16).replace(":", "")}`;
}

/** Is een kopie met deze naam ouder dan het aantal dagen? Namen zonder stempel: nee. */
export function teOud(naam, nu = new Date(), dagen = 14) {
  const m = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})$/.exec(naam);
  if (!m) return false;
  const gemaakt = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
  return nu.getTime() - gemaakt > dagen * 24 * 60 * 60 * 1000;
}
