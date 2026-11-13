// TIJDELIJK, hoort bij .github/workflows/tijdelijk-e2e.yml en gaat weg voor de merge.
//
// Haalt per keer één bescherming weg uit de databasecontrole, de tekstguard, de config of de
// inlogpagina (ronde 4 van uitgave 43), draait de unittests (`pnpm test`) en zet het bestand
// terug. Blijven de tests groen, dan bewaakt geen test die bescherming. Zelfde werkwijze als
// tests/unit/aanval2-mutaties-pagina-en-guard.mjs op aanval/43-inlog-2, voor de code zoals die
// nu is.
//
//   node .github/tijdelijk/mutaties-pagina-en-guard.mjs [naam ...]   (DROOG=1: alleen passen)
//
// Draai dit in een eigen kopie van de repo (git worktree), niet waar iemand werkt.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const DB = "scripts/lib/klantportaal-database.mjs";
const REGELS = "scripts/lib/rls-regels.mjs";
const CONFIG = "scripts/lib/stack-config.mjs";
const GUARD = "scripts/guard-rls.mjs";
const HOOK = "src/features/auth/use-mailcode.ts";
const MAILCODE = "src/features/auth/mailcode.ts";
const PAGINA = "src/features/auth/login-page.tsx";
const APP = "src/features/auth/app-met-database.tsx";
const STARTFOUT = "src/lib/startfout.ts";
const ENV = "src/lib/env.ts";

/** [naam, bestand, wat er wegvalt, zoek, vervang] */
const MUTATIES = [
  // --- de databasecontrole (de beoordeling; de vraag zelf bewaakt tests/rls/) --------------
  [
    "d1",
    DB,
    "storage/realtime mogen RLS uit",
    "MET_POLICIES_VAN_DE_APP.includes(r.naam) && !r.rls",
    "false",
  ],
  [
    "d2",
    DB,
    "een eigenaar die bezoeker is, telt niet",
    "if (r.eigenaarBezoeker) {",
    "if (false) {",
  ],
  ["d3", DB, "een eigen tabel zonder RLS telt niet", "} else if (!r.rls) {", "} else if (false) {"],
  [
    "d4",
    DB,
    "een eigen tabel zonder policy telt niet",
    "} else if (r.policies === 0) {",
    "} else if (false) {",
  ],
  [
    "d5",
    DB,
    "een view zonder security_invoker telt niet",
    "if (bereikbaar && !r.invoker && !opLijst(vrij, r.naam)) {",
    "if (false) {",
  ],
  [
    "d6",
    DB,
    "een view met eigenaarsrechten voor anon telt niet",
    "if (r.anon && !r.invoker && !isOpenbaar(r.naam)) {",
    "if (false) {",
  ],
  [
    "d7",
    DB,
    "materialized view en foreign table tellen niet",
    "} else if (bereikbaar) {",
    "} else if (false) {",
  ],
  [
    "d8",
    DB,
    "een policy voor anon telt niet",
    "if (p.permissief && p.anon && !isOpenbaar(p.tabel)) {",
    "if (false) {",
  ],
  [
    "d9",
    DB,
    "een poort voor een andere rol dekt ook authenticated",
    "policies.filter((p) => !p.permissief && p.ingelogd)",
    "policies.filter((p) => !p.permissief)",
  ],
  [
    "d10",
    DB,
    "een poort voor één opdracht dekt alle opdrachten",
    '(r.cmd === "all" || r.cmd === cmd) &&',
    "true &&",
  ],
  [
    "d11",
    DB,
    "een poort met alleen een goede using dekt ook insert",
    'if (cmd === "insert") return [check];',
    'if (cmd === "insert") return [policy.using];',
  ],
  [
    "d12",
    DB,
    "een functie voor anon telt niet",
    "if (f.anon && !isOpenbaar(f.naam)) {",
    "if (false) {",
  ],
  [
    "d13",
    DB,
    "een definer-functie zonder zoekpad telt niet",
    "if (f.zoekpad === null || f.zoekpad === undefined) {",
    "if (false) {",
  ],
  [
    "d14",
    DB,
    "elke definer-functie is vrij",
    "if (opLijst(config.poorten, f.naam) || opLijst(vrij, f.naam)) continue;",
    "continue;",
  ],
  [
    "d15",
    DB,
    "een eigen poort hoeft niet na te lopen te zijn",
    "if (!varianten.every(eigenPoortKlopt)) {",
    "if (false) {",
  ],
  [
    "d16",
    DB,
    "een openbare bucket telt niet",
    "if (!(`bucket:${bucket}` in openbaar)) {",
    "if (false) {",
  ],
  [
    "d17",
    DB,
    "een gewijzigde basisfunctie telt niet",
    "const anders = Object.keys(VELDEN).filter(",
    "const anders = [].filter(",
  ],
  [
    "d18",
    DB,
    "een eigen trigger op de administratie telt niet",
    "if (!(verwacht.triggers ?? []).some(",
    "if (false && !(verwacht.triggers ?? []).some(",
  ],
  [
    "d19",
    DB,
    "rollen met bypassrls tellen niet",
    "for (const rol of model.rollen ?? []) {",
    "for (const rol of []) {",
  ],
  [
    "d20",
    DB,
    "een naam in de lijst geldt in elk schema",
    'sleutel.includes(".") ? sleutel === naam : `public.${sleutel}` === naam',
    'naam.endsWith(sleutel.split(".").at(-1) ?? "")',
  ],
  [
    "d21",
    DB,
    "een basisfunctie in een ander schema telt als basisfunctie",
    'if (schema === "public" && BASISFUNCTIES.includes(naam)) continue;',
    "if (BASISFUNCTIES.includes(naam)) continue;",
  ],
  [
    "d22",
    DB,
    "een functie alleen voor anon telt niet",
    "if (f.supabase || !(f.anon || f.ingelogd)) continue;",
    "if (f.supabase || !f.ingelogd) continue;",
  ],
  [
    "d23",
    DB,
    "de tabel klanten wordt niet vergeleken",
    'for (const [veld, uitleg] of [\n      ["kolommen"',
    'for (const [veld, uitleg] of [] && [\n      ["kolommen"',
  ],
  [
    "d24",
    DB,
    "een ontbrekende eigen poort telt niet",
    "if (varianten.length === 0) {",
    "if (false) {",
  ],
  // --- de tekstguard -----------------------------------------------------------------------
  [
    "t1",
    REGELS,
    "een eigen poort met from/where telt",
    "/\\b(?:from|where|union|intersect|except|limit|offset|group|having|order|into)\\b/.test(",
    "/^$/.test(",
  ],
  [
    "t2",
    REGELS,
    "een eigen poort in plpgsql telt",
    'if (functie.taal !== "sql") return false;',
    "",
  ],
  [
    "t3",
    REGELS,
    "een eigen poort mag een andere eigen poort aanroepen (g7)",
    "return poortIsHardeEis(uitdrukking, BASISPOORTEN);",
    'return poortIsHardeEis(uitdrukking, [...BASISPOORTEN, "is_verkoper"]);',
  ],
  [
    "t4",
    REGELS,
    "drop table laat de policies staan",
    'for (const naam of namenNa(m[1] ?? "")) {\n        tabellen.delete(naam);\n        for (const [sleutel, policy] of [...policies.entries()]) {\n          if (policy.tabel === naam) policies.delete(sleutel);\n        }',
    'for (const naam of namenNa(m[1] ?? "")) {\n        tabellen.delete(naam);',
  ],
  [
    "t5",
    REGELS,
    "disable row level security wordt niet gevolgd",
    "if (tabel && /\\bdisable\\s+row\\s+level\\s+security\\b/i.test(rest)) tabel.rls = false;",
    "",
  ],
  [
    "t6",
    REGELS,
    "set schema wordt niet gevolgd",
    "if (schema) verplaatsTabel(",
    "if (false) verplaatsTabel(",
  ],
  [
    "t7",
    REGELS,
    "select into maakt geen tabel",
    "if (m && !/\\binto\\s+(?:temp|temporary)\\b/i.test(opdracht)) {",
    "if (false) {",
  ],
  [
    "t8",
    REGELS,
    "create unlogged table wordt niet gezien",
    "(temp|temporary|unlogged|foreign)?",
    "(temp|temporary|foreign)?",
  ],
  [
    "t9",
    REGELS,
    "revoke ... from anon wordt niet gevolgd",
    'if (wie.includes("anon")) functie.viaAnon = geven;',
    "",
  ],
  [
    "t10",
    REGELS,
    "een policy voor anon telt niet in de tekst",
    "p.rollen.some((rol) => ANON.includes(rol))",
    "false",
  ],
  [
    "t11",
    REGELS,
    "een poort voor een andere rol dekt ook authenticated",
    "(p) => p.restrictief && p.rollen.some((rol) => INGELOGD.includes(rol)),",
    "(p) => p.restrictief,",
  ],
  [
    "t12",
    REGELS,
    "views worden niet gecontroleerd",
    "if (v.invoker || opLijst(vrij, v.naam)) continue;",
    "if (true) continue;",
  ],
  [
    "t13",
    REGELS,
    "een functie voor anon telt niet in de tekst",
    "if (f.anon && !opLijst(openbaar, f.naam)) {",
    "if (false) {",
  ],
  [
    "t14",
    REGELS,
    "alter default privileges ... from anon wordt niet gevolgd",
    "nieuweFunctiesVoorAnon = geven;",
    "nieuweFunctiesVoorAnon = true;",
  ],
  [
    "t15",
    REGELS,
    "is_medewerker mag sessie_via_cloudflare uit een ander schema aanroepen (g12)",
    "/(?<![\\w.])public ?\\. ?sessie_via_cloudflare ?\\( ?\\)/",
    "/public ?\\. ?sessie_via_cloudflare ?\\( ?\\)/",
  ],
  [
    "t16",
    REGELS,
    "een basisfunctie in een ander schema is vrij in de tekst (g19)",
    'if (schema === "public" && BASISFUNCTIES.includes(naam)) continue;',
    "if (BASISFUNCTIES.includes(naam)) continue;",
  ],
  [
    "t17",
    REGELS,
    "dynamische SQL wordt niet gemeld",
    "if (/^do\\b/i.test(opdracht) && /\\bexecute\\b/i.test(lijf(opdracht))) dynamisch = true;",
    "",
  ],
  // --- de config en de guard ---------------------------------------------------------------
  [
    "c1",
    CONFIG,
    "een onbekende sleutel is goed",
    'if (sleutel.startsWith("$") || BEKENDE_SLEUTELS.includes(sleutel)) continue;',
    "continue;",
  ],
  [
    "c2",
    CONFIG,
    "de schakelaar mag zonder eigen database",
    'if (modus !== "eigen") {',
    "if (false) {",
  ],
  [
    "c3",
    CONFIG,
    "een openbare naam mag alles zijn",
    "const OPENBARE_NAAM = /^(?:bucket:[A-Za-z0-9_.-]+|",
    "const OPENBARE_NAAM = /^(?:.*|bucket:[A-Za-z0-9_.-]+|",
  ],
  [
    "c4",
    GUARD,
    "de guard meldt onbekende sleutels niet",
    "if (onbekend.length > 0) {",
    "if (false) {",
  ],
  [
    "c5",
    GUARD,
    "de guard zegt niet dat de sluitende controle op de database draait",
    "      ...SLUITEND,\n    ]);",
    "    ]);",
  ],
  // --- de pagina ---------------------------------------------------------------------------
  [
    "q1",
    HOOK,
    "een stil geweigerde aanvraag telt als aangevraagd (p32)",
    "if (gedeeld && uitkomst.verstuurd) {",
    "if (gedeeld) {",
  ],
  [
    "q2",
    HOOK,
    "'ander e-mailadres' laat de aanvraag staan",
    'if (gedeeld) wisAangevraagd(gedeeld);\n    stuur({ soort: "ander-adres" });',
    'stuur({ soort: "ander-adres" });',
  ],
  [
    "q3",
    PAGINA,
    "alleen mailcode onthoudt de aanvraag niet",
    "if (gedeeld) merkAangevraagd(gedeeld, await adresVingerafdruk(adres.data), Date.now());",
    "",
  ],
  [
    "q4",
    APP,
    "bij alleen mailcode geen adres na het inloggen",
    'const toonAdres = klantportaal || inlogdiensten.includes("mailcode");',
    "const toonAdres = klantportaal;",
  ],
  [
    "q5",
    APP,
    "een weigering na de knop voor medewerkers wordt verzwegen",
    "klantportaal && vanDienst && session !== null",
    "false",
  ],
  [
    "q6",
    APP,
    "na uitloggen en opnieuw inloggen blijft 'al ingelogd' staan",
    "if (!session) setWasAlBinnen(false);",
    "",
  ],
  [
    "q7",
    APP,
    "de melding blijft ook op een ander scherm",
    "else if (pathname !== pad) klaar();",
    "",
  ],
  [
    "q8",
    APP,
    "een ander adres dan aangevraagd krijgt geen nadruk",
    "if (actief) setAnders(vinger !== aangevraagd);",
    "if (actief) setAnders(false);",
  ],
  [
    "q9",
    APP,
    "de aanvraag blijft na het inloggen staan",
    "if (gedeeld) wisAangevraagd(gedeeld);\n    setNetIngelogd",
    "setNetIngelogd",
  ],
  [
    "q10",
    MAILCODE,
    "een aanvraag verloopt nooit",
    "return oud >= 0 && oud <= CODE_GELDIG_MS ? bewaard.data : null;",
    "return bewaard.data;",
  ],
  [
    "q11",
    MAILCODE,
    "een stille weigering telt als verstuurd",
    "{ ok: true, verstuurd: false }",
    "{ ok: true, verstuurd: true }",
  ],
  [
    "q12",
    MAILCODE,
    "de vingerafdruk maakt het adres niet gelijk (hoofdletters, spaties)",
    "leesAdres(adres) ?? adres.trim().toLowerCase()",
    "adres",
  ],
  [
    "q13",
    STARTFOUT,
    "de fout gaat niet naar de console",
    "  console.error(fout);\n  if (!doel) return;",
    "  if (!doel) return;",
  ],
  [
    "q14",
    STARTFOUT,
    "het startscherm toont de hele melding",
    "fout instanceof Omgevingsfout && fout.namen.length > 0",
    "false",
  ],
  ["q15", ENV, "de namen komen niet uit het pad", 'typeof issue.path[0] === "string"', "false"],
  [
    "q16",
    APP,
    "de weigering blijft in de adresbalk",
    '    window.history.replaceState(null, "", window.location.pathname);\n    const kluis = tabblad();\n    if (kluis) wisDienstInlog(kluis);\n  }, [begin.weigering]);',
    "    const kluis = tabblad();\n    if (kluis) wisDienstInlog(kluis);\n  }, [begin.weigering]);",
  ],
];

const alleen = process.argv.slice(2);
const regels = ["| mutatie | bestand | wat valt weg | uitkomst |", "|---|---|---|---|"];
for (const [naam, bestand, wat, zoek, vervang] of MUTATIES) {
  if (alleen.length > 0 && !alleen.includes(naam)) continue;
  const origineel = readFileSync(bestand, "utf8");
  if (!origineel.includes(zoek)) {
    regels.push(`| ${naam} | ${bestand} | ${wat} | MUTATIE PAST NIET |`);
    console.log(`${naam}\tPAST NIET`);
    continue;
  }
  if (process.env.DROOG) {
    console.log(`${naam}\tpast`);
    continue;
  }
  writeFileSync(
    bestand,
    origineel.replace(zoek, () => vervang),
  );
  let stand;
  try {
    // Eerst opmaken: de nabootstest draait de lint over de repo, en een mutatie die alleen op
    // haar opmaak wordt gevangen, is niet gevangen.
    spawnSync("pnpm", ["exec", "biome", "format", "--write", bestand], { encoding: "utf8" });
    const run = spawnSync("pnpm", ["test"], { encoding: "utf8" });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: kleurcodes beginnen met ESC
    const uit = `${run.stdout}${run.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
    const gefaald = [
      ...new Set(
        [...uit.matchAll(/^\s*(?:×|✗)\s+(.+?)(?:\s+\d+\s*ms)?$/gm)].map((m) => m[1].trim()),
      ),
    ];
    stand =
      run.status === 0
        ? "**OVERLEEFT**"
        : `gevangen (${gefaald.length}): ${gefaald.slice(0, 2).join(" / ").slice(0, 160)}`;
  } finally {
    writeFileSync(bestand, origineel);
  }
  regels.push(`| ${naam} | ${bestand} | ${wat} | ${stand} |`);
  console.log(`${naam}\t${stand}`);
}
const tabel = regels.join("\n");
console.log(tabel);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Mutaties op pagina en guard\n\n${tabel}\n`);
}
