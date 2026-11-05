/**
 * Welke SQL in een migratie data of beveiliging kan vernietigen. Los van guard-migrations.mjs,
 * zodat de regels zelf te testen zijn zonder git-geschiedenis.
 */

/** Haalt SQL-commentaar weg, zodat een voorbeeld in commentaar geen alarm geeft. */
export function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Een naam zonder aanhalingstekens en zonder schema `public.`, in kleine letters. */
function kaal(naam) {
  return naam
    .replaceAll('"', "")
    .replace(/^public\./i, "")
    .toLowerCase();
}

const NAAM = String.raw`(?:"[^"]+"|[\w$]+)`;
const TABEL = String.raw`(?:${NAAM}\.)?${NAAM}`;

/**
 * `drop policy` is alleen gevaarlijk als er daarna geen gelijke policy terugkomt op een tabel die
 * al bestond. Twee patronen zijn onschuldig en schrijven bouwers om een migratie herhaalbaar te
 * maken (melding 03-11-2026): de tabel wordt in dezelfde migratie aangemaakt, of direct na de drop
 * volgt een `create policy` met dezelfde naam op dezelfde tabel.
 */
function gevaarlijkeDropPolicy(sql) {
  const nieuweTabellen = new Set(
    [
      ...sql.matchAll(
        new RegExp(String.raw`\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(${TABEL})`, "gi"),
      ),
    ].map((m) => kaal(m[1])),
  );
  const nieuwePolicies = new Set(
    [
      ...sql.matchAll(
        new RegExp(String.raw`\bcreate\s+policy\s+(${NAAM})\s+on\s+(${TABEL})`, "gi"),
      ),
    ].map((m) => `${kaal(m[1])} op ${kaal(m[2])}`),
  );
  const drops = [
    ...sql.matchAll(
      new RegExp(
        String.raw`\bdrop\s+policy\s+(?:if\s+exists\s+)?(${NAAM})\s+on\s+(${TABEL})`,
        "gi",
      ),
    ),
  ];
  const losseDrops = (sql.match(/\bdrop\s+policy\b/gi) ?? []).length;
  // Een drop policy die we niet kunnen lezen, telt altijd als gevaarlijk.
  if (losseDrops > drops.length) return true;
  return drops.some((m) => {
    const tabel = kaal(m[2]);
    if (nieuweTabellen.has(tabel)) return false;
    return !nieuwePolicies.has(`${kaal(m[1])} op ${tabel}`);
  });
}

export const DESTRUCTIVE = [
  { name: "drop table", re: /\bdrop\s+table\b/i },
  { name: "drop column", re: /\bdrop\s+column\b/i },
  { name: "drop schema", re: /\bdrop\s+schema\b/i },
  { name: "drop database", re: /\bdrop\s+database\b/i },
  { name: "truncate", re: /\btruncate\b/i },
  {
    name: "delete zonder where",
    re: /\bdelete\s+from\s+[^;]*?;/i,
    guard: (m) => !/\bwhere\b/i.test(m),
  },
  { name: "drop policy", re: /\bdrop\s+policy\b/i, geheel: gevaarlijkeDropPolicy },
  { name: "row level security uitzetten", re: /\bdisable\s+row\s+level\s+security\b/i },
  { name: "type van een kolom wijzigen", re: /\balter\s+column\b[^;]*\btype\b/i },
];

/** De namen van de destructieve regels die in deze migratie voorkomen (commentaar telt niet). */
export function destructieveRegels(sqlMetCommentaar) {
  const sql = stripComments(sqlMetCommentaar);
  const gevonden = [];
  for (const rule of DESTRUCTIVE) {
    const match = rule.re.exec(sql);
    if (!match) continue;
    if (rule.guard && !rule.guard(match[0])) continue;
    if (rule.geheel && !rule.geheel(sql)) continue;
    gevonden.push(rule.name);
  }
  return gevonden;
}
