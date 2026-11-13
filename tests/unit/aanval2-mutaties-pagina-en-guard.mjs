// AANVAL ronde 2, doel 6: tests die niets bewijzen (de pagina en de guard).
//
// Geen test maar een script. Haalt per keer één bescherming weg, draait de unittests
// (`pnpm test`) en zet het bestand terug. Blijven de tests groen, dan bewaakt geen unittest
// die bescherming: een overlevende.
//
//   node tests/unit/aanval2-mutaties-pagina-en-guard.mjs            alle mutaties
//   node tests/unit/aanval2-mutaties-pagina-en-guard.mjs g3 p11     alleen deze
//   node tests/unit/aanval2-mutaties-pagina-en-guard.mjs --overlevenden   alleen wat op
//                                                                   13-11-2026 overleefde
//
// Draai dit in een eigen kopie van de repo (git worktree), niet waar iemand werkt.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const REGELS = "scripts/lib/rls-regels.mjs";
const GUARD = "scripts/guard-rls.mjs";
const CONFIG = "scripts/lib/stack-config.mjs";
const OPEN = "tests/rls/open-policies.test.ts";
const POORT = "tests/rls/lib/klantportaal-poort.ts";
const MAILCODE = "src/features/auth/mailcode.ts";
const HOOK = "src/features/auth/use-mailcode.ts";
const APP = "src/features/auth/app-met-database.tsx";
const PAGINA = "src/features/auth/login-page.tsx";
const CODEPAGINA = "src/features/auth/inlog-met-code.tsx";
const DIENST = "src/features/auth/inlogdienst.ts";
const MEDEWERKER = "src/features/auth/medewerkersessie.tsx";
const ENV = "src/lib/env.ts";
const STARTFOUT = "src/lib/startfout.ts";
const CLIENT = "src/lib/supabase.ts";

const r = String.raw;

/** [naam, bestand, wat er wegvalt, zoek, vervang] */
const MUTATIES = [
  // --- de guard -------------------------------------------------------------------------
  [
    "g1",
    REGELS,
    "een restrictive policy hoeft niet `for all` te zijn om de tabel te dekken",
    r`p.cmd === "all" &&`,
    "",
  ],
  [
    "g2",
    REGELS,
    "de with check van de dekkende policy hoeft geen poort te hebben",
    "(p.check === null || poortIsHardeEis(p.check, poorten))",
    "true",
  ],
  [
    "g3",
    REGELS,
    "policies zonder `to` (public) tellen niet meer als voor ingelogden",
    r`const VOOR_INGELOGDEN = ["authenticated", "public"];`,
    r`const VOOR_INGELOGDEN = ["authenticated"];`,
  ],
  [
    "g4",
    REGELS,
    "het schema api valt buiten de controle op functies en views",
    r`const SCHEMAS = ["public", "api"];`,
    r`const SCHEMAS = ["public"];`,
  ],
  [
    "g5",
    REGELS,
    "een eigen poort die alleen zichzelf aanroept telt als poort",
    ".filter((p) => p !== behalve)",
    "",
  ],
  [
    "g6",
    REGELS,
    "is_medewerker hoeft sessie_via_cloudflare niet aan te roepen",
    r`!isMedewerker.inhoud.every((inhoud) => roeptPoortAan(inhoud, ["sessie_via_cloudflare"]))`,
    "false",
  ],
  [
    "g7",
    REGELS,
    "een eigen poort mag een andere eigen poort aanroepen in plaats van een poort van de template",
    "const eis = eigenPoort ? BASISPOORTEN : poorten;",
    "const eis = poorten;",
  ],
  [
    "g8",
    REGELS,
    "een subquery tussen haakjes wordt als voorwaarde gesplitst",
    r`omsloten && !/^\(\s*select\b/.test(binnen) && poortIsHardeEis`,
    "omsloten && poortIsHardeEis",
  ],
  [
    "g9",
    REGELS,
    "de `and` van between wordt als gewone `and` gelezen",
    r`if (w === "between") between = true;`,
    "if (false) between = true;",
  ],
  [
    "g10",
    REGELS,
    "`or` binnen case ... end splitst de voorwaarde",
    r`else if (w === "case") geval++;`,
    "",
  ],
  [
    "g11",
    REGELS,
    "een poort in een tekst ('...') telt mee",
    "return zonderTekst(zonderCommentaar(sql))",
    "return zonderCommentaar(sql)",
  ],
  [
    "g12",
    REGELS,
    "een functie in een ander schema (x.public.f, anderpublic.f) telt als aanroep van de poort",
    r`(?<![\w.])public ?\. ?${"${p}"}`,
    r`public ?\. ?${"${p}"}`,
  ],
  [
    "g13",
    REGELS,
    "alter policy ... using wordt niet gevolgd",
    r`policy.using = tussenHaakjesNa(rest, "using") ?? policy.using;`,
    "",
  ],
  [
    "g14",
    REGELS,
    "alter policy ... to wordt niet gevolgd",
    "policy.rollen = rollenUit(rest) ?? policy.rollen;",
    "",
  ],
  [
    "g15",
    REGELS,
    "alter default privileges ... revoke execute from public wordt genegeerd (strenger) / grant terug wordt niet gezien",
    "nieuweFunctiesVoorIedereen = geven;",
    "nieuweFunctiesVoorIedereen = false;",
  ],
  [
    "g16",
    REGELS,
    "open_tabellen mag bij een klantportaal",
    "for (const tabel of Object.keys(config.openTabellen ?? {})) {",
    "for (const tabel of []) {",
  ],
  [
    "g17",
    REGELS,
    "ook een gewone (permissive) policy `for all` met poort dekt de tabel",
    "p.restrictief &&\n          p.cmd",
    "p.cmd",
  ],
  [
    "g18",
    REGELS,
    "de using van de dekkende policy hoeft geen poort te hebben",
    "poortIsHardeEis(p.using, poorten) &&",
    "true &&",
  ],
  [
    "g19",
    REGELS,
    "api.klant_aanmelden (elk schema) is vrij",
    r`if (schema === "public" && naam in vrij) continue;`,
    "if (naam in vrij) continue;",
  ],
  [
    "g20",
    REGELS,
    "is_medewerker of is_goedgekeurde_klant mag ontbreken",
    r`for (const naam of ["is_medewerker", "is_goedgekeurde_klant"]) {` +
      "\n    if (!functies.has(naam)) {",
    r`for (const naam of ["is_medewerker", "is_goedgekeurde_klant"]) {` + "\n    if (false) {",
  ],
  [
    "g21",
    REGELS,
    "een eigen poort in de config hoeft niet te bestaan",
    "for (const naam of eigenPoorten) {\n    if (!functies.has(naam)) {",
    "for (const naam of eigenPoorten) {\n    if (false) {",
  ],
  [
    "g22",
    REGELS,
    "views worden niet gecontroleerd",
    "if (v.invoker || roeptPoortAan(v.inhoud, poorten)) continue;",
    "if (true) continue;",
  ],
  [
    "g23",
    REGELS,
    "security_invoker = false telt als security_invoker",
    r`/\bsecurity_invoker\b(?!\s*=\s*(?:false|off|0))/i.test(opties)`,
    r`/\bsecurity_invoker\b/i.test(opties)`,
  ],
  [
    "g24",
    REGELS,
    "alter view ... reset (security_invoker) laat de view op invoker staan",
    "view.invoker = !m[2] && ",
    "view.invoker = ",
  ],
  [
    "g25",
    REGELS,
    "een variant (overload) van een definer-functie erft security definer niet",
    "|| (!m[1] && (vorige?.definer ?? false))",
    "",
  ],
  [
    "g26",
    REGELS,
    "alter function ... security definer wordt niet gezien",
    r`if (functie && /\bsecurity\s+definer\b/i.test(m[2] ?? "")) functie.definer = true;`,
    "",
  ],
  [
    "g27",
    REGELS,
    "elke functie in public telt in een policy als poort",
    r`return aanroep !== null && poorten.includes(aanroep[1] ?? "");`,
    "return aanroep !== null;",
  ],
  [
    "g28",
    REGELS,
    "de poort hoeft in een policy niet met public. geschreven te zijn",
    r`/^public ?\. ?([a-z_0-9]+) ?\( ?\)$/.exec(kaalDeel)`,
    r`/^(?:public ?\. ?)?([a-z_0-9]+) ?\( ?\)$/.exec(kaalDeel)`,
  ],
  [
    "g29",
    REGELS,
    "van een functie met varianten hoeft maar één variant de poort aan te roepen",
    "if (!f.inhoud.every((inhoud) => roeptPoortAan(inhoud, eis, naam))) {",
    "if (!f.inhoud.some((inhoud) => roeptPoortAan(inhoud, eis, naam))) {",
  ],
  [
    "g30",
    REGELS,
    "de poort hoeft maar in één tak van een `or` te staan",
    r`return splitsOp(tekst, "or").every((tak) =>`,
    r`return splitsOp(tekst, "or").some((tak) =>`,
  ],
  [
    "g31",
    REGELS,
    "een lege voorwaarde telt als poort",
    r`if (tekst === "") return false;`,
    r`if (tekst === "") return true;`,
  ],
  [
    "g32",
    REGELS,
    "drop policy wordt niet gevolgd (strenger) / create na drop",
    'policies.delete(`${volledig(m[2] ?? "")}/${(m[1] ?? "").replaceAll(\'"\', "")}`);\n      continue;',
    "continue;",
  ],
  [
    "g33",
    REGELS,
    "revoke/grant execute op één functie wordt niet gevolgd",
    "if (functie) zet(functie);\n        }\n      }\n      continue;",
    "}\n      }\n      continue;",
  ],
  [
    "g34",
    REGELS,
    "grant execute aan authenticated telt niet (alleen public)",
    r`if (wie.includes("authenticated")) functie.viaAuthenticated = geven;`,
    "",
  ],
  [
    "g35",
    REGELS,
    "create or replace view wordt niet als view gelezen",
    r`/^create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:recursive\s+)?view\s+`,
    r`/^create\s+(?:temp(?:orary)?\s+)?(?:recursive\s+)?view\s+`,
  ],
  [
    "g36",
    REGELS,
    "procedures worden niet als functie gelezen",
    r`/^create\s+(or\s+replace\s+)?(?:function|procedure)\s+`,
    r`/^create\s+(or\s+replace\s+)?(?:function)\s+`,
  ],
  [
    "g37",
    GUARD,
    "guard-rls.mjs slaat de controle van het klantportaal over",
    "if (portaal !== null) {",
    "if (false) {",
  ],
  [
    "g38",
    GUARD,
    "guard-rls.mjs wordt niet rood bij problemen van het klantportaal",
    "  if (problemen.length > 0) {",
    "  if (false) {",
  ],
  [
    "g39",
    CONFIG,
    'een andere waarde dan true/false voor "klantportaal" geeft geen fout',
    "if (waarde !== true) {",
    "if (false) {",
  ],
  [
    "g40",
    CONFIG,
    "open_tabellen gaat niet mee naar de beoordeling van het klantportaal",
    "openTabellen: openTabellen(),",
    "openTabellen: {},",
  ],
  [
    "g41",
    CONFIG,
    "een poort of vrije functie zonder reden mag",
    'if (typeof reden !== "string" || reden.trim() === "") {\n      throw new Error(`stack.config.json: bij ${sleutel}',
    'if (typeof reden === "symbol") {\n      throw new Error(`stack.config.json: bij ${sleutel}',
  ],
  [
    "g42",
    CONFIG,
    'elke waarde behalve undefined/false zet het klantportaal UIT in plaats van een fout (bv. "ja")',
    "if (waarde === undefined || waarde === false) return null;",
    "if (waarde !== true) return null;",
  ],
  [
    "g43",
    OPEN,
    "de databasecontrole van het klantportaal wordt altijd overgeslagen",
    "it.skipIf(config.klantportaal !== true)(",
    "it.skipIf(true)(",
  ],
  [
    "g44",
    POORT,
    "de databasecontrole kijkt niet naar policies in storage",
    "where n.nspname in ('public', 'api', 'storage')",
    "where n.nspname in ('public', 'api')",
  ],
  [
    "g45",
    POORT,
    "de databasecontrole ziet een eigen rol waar authenticated lid van is niet als authenticated",
    "case when pg_has_role('authenticated', r.oid, 'member')\n                                     then 'authenticated' else r.rolname::text end",
    "r.rolname::text",
  ],
  // --- de pagina ------------------------------------------------------------------------
  [
    "p1",
    MAILCODE,
    "de link mag elk type hebben (recovery, email_change)",
    r`type: z.literal("email"),`,
    "type: z.string(),",
  ],
  [
    "p2",
    MAILCODE,
    "token_hash mag elke tekst zijn",
    r`token_hash: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),`,
    "token_hash: z.string().min(1),",
  ],
  [
    "p3",
    MAILCODE,
    "de uitleg voor een nieuwe medewerker ook voor wie alleen een link kreeg",
    "if (zelfBegonnen && onbevestigd) {",
    "if (onbevestigd) {",
  ],
  [
    "p4",
    MAILCODE,
    "het kenmerk 'hier aangevraagd' verloopt nooit",
    " && nu - op <= CODE_GELDIG_MS",
    "",
  ],
  [
    "p5",
    MAILCODE,
    "een tijdstip in de toekomst telt als 'hier aangevraagd'",
    "nu - op >= 0 && ",
    "",
  ],
  [
    "p6",
    HOOK,
    "na inloggen via de link blijft het kenmerk 'hier aangevraagd' staan",
    "if (gedeeld) wisAangevraagd(gedeeld);\n    } else {\n      maakAdresSchoon();",
    "} else {\n      maakAdresSchoon();",
  ],
  [
    "p7",
    HOOK,
    "na inloggen met de code blijft het kenmerk 'hier aangevraagd' staan",
    'if (gedeeld) wisAangevraagd(gedeeld);\n      } else {\n        stuur({ soort: "mislukt", fout: uitkomst.fout });\n      }\n    },\n    [auth, toestand.email',
    '} else {\n        stuur({ soort: "mislukt", fout: uitkomst.fout });\n      }\n    },\n    [auth, toestand.email',
  ],
  [
    "p8",
    HOOK,
    "een mislukte link blijft in de adresbalk staan",
    '} else {\n      maakAdresSchoon();\n      stuur({ soort: "link-mislukt"',
    '} else {\n      stuur({ soort: "link-mislukt"',
  ],
  [
    "p9",
    HOOK,
    "een fout uit het adres blijft in de adresbalk staan",
    "if (begin.toestand.fout) maakAdresSchoon();",
    "",
  ],
  [
    "p10",
    HOOK,
    "de waarschuwing bij de link komt nooit",
    "linkHierAangevraagd: gedeeld !== null && isHierAangevraagd(gedeeld, nu),",
    "linkHierAangevraagd: true,",
  ],
  [
    "p11",
    APP,
    "terug van Cloudflare telt als 'was al binnen' (extra scherm, geen melding)",
    "return klantportaal && session !== null && !vanDienst;",
    "return klantportaal && session !== null;",
  ],
  ["p12", APP, "'Je bent ingelogd als' komt nooit", "if (klantportaal) ingelogd();", ""],
  [
    "p13",
    APP,
    "het kenmerk 'naar de dienst gestuurd' wordt na inloggen niet gewist",
    "wisDienstInlog(kluis);\n      bewaar(kluis, BEGIN);",
    "bewaar(kluis, BEGIN);",
  ],
  [
    "p14",
    APP,
    "'Je bent ingelogd als' blijft altijd staan",
    "const klok = window.setTimeout(klaar, INGELOGD_ALS_MS);",
    "const klok = 0;",
  ],
  [
    "p15",
    MAILCODE,
    "een storing bij de link heet 'link verlopen'",
    `zichtbareFout(error) ?? storing(error) ?? fout("link")`,
    `zichtbareFout(error) ?? fout("link")`,
  ],
  [
    "p16",
    DIENST,
    "wachtwoord mag naast een andere dienst",
    r`if (diensten.length > 1 && diensten.includes("wachtwoord")) {`,
    "if (false) {",
  ],
  [
    "p17",
    DIENST,
    "een dienst mag twee keer in de lijst",
    "if (diensten.includes(dienst)) {",
    "if (false) {",
  ],
  ["p18", ENV, "de testlogin ook in een gebouwde versie", "if (!dev) return null;", ""],
  [
    "p19",
    MEDEWERKER,
    "elke sessie met amr telt als 'begon via een dienst'",
    r` && stap.method === "oauth"`,
    "",
  ],
  [
    "p20",
    MEDEWERKER,
    "'verlopen' wordt nooit getoond",
    r`return begonViaDienst(session) ? "verlopen" : "geen";`,
    r`return "geen";`,
  ],
  [
    "p21",
    STARTFOUT,
    "de startfout komt als HTML op het scherm",
    "uitleg.textContent =",
    "uitleg.innerHTML =",
  ],
  [
    "p22",
    MAILCODE,
    "de aanvraag maakt geen nieuw account (shouldCreateUser uit)",
    "shouldCreateUser: true,\n        ...(captchaToken",
    "shouldCreateUser: false,\n        ...(captchaToken",
  ],
  [
    "p23",
    MAILCODE,
    "de aanvraag stuurt geen terugkeeradres mee",
    "emailRedirectTo: terugNaar,\n        shouldCreateUser: true,\n        ...(captchaToken",
    "shouldCreateUser: true,\n        ...(captchaToken",
  ],
  [
    "p24",
    PAGINA,
    "na een fout van de dienst stuurt de pagina toch weer automatisch door (lus)",
    "if (!automatisch || gestart.current || meldingUitAdres()) return;",
    "if (!automatisch || gestart.current) return;",
  ],
  [
    "p25",
    MAILCODE,
    "het tabblad onthoudt het adres langer dan vijf minuten",
    " && oud <= ONTHOUD_ADRES_MS",
    "",
  ],
  [
    "p26",
    APP,
    "de knop op 'Je bent al ingelogd' onthoudt niet dat het tabblad naar de dienst ging",
    'if (kluis) merkDienstInlog(kluis, Date.now());\n      await startInloggen("cloudflare"',
    'await startInloggen("cloudflare"',
  ],
  [
    "p27",
    MEDEWERKER,
    "OpnieuwAlsMedewerker onthoudt niet dat het tabblad naar de dienst ging",
    "merkDienstInlog(window.sessionStorage, Date.now());",
    "",
  ],
  [
    "p28",
    CODEPAGINA,
    "de knop voor medewerkers onthoudt niet dat het tabblad naar de dienst ging",
    "merkDienstInlog(window.sessionStorage, Date.now());",
    "",
  ],
  [
    "p29",
    CLIENT,
    "de client neemt een sessie uit het fragment van het adres aan (geen pkce)",
    r`auth: { flowType: "pkce" },`,
    "auth: {},",
  ],
  [
    "p30",
    HOOK,
    "'nieuwe code' kan buiten de knop om binnen de minuut",
    "if (wachtNog(toestand.verstuurdOp, Date.now()) > 0) return;",
    "",
  ],
  [
    "p31",
    PAGINA,
    "de pagina toont de tekst van de fout van een dienst zoals mailcode.ts hem geeft (ook 'klik op de link in die mail' bij één dienst)",
    r`return fout.soort === "dienst" || fout.soort === "link" ? GEEN_TOEGANG : fout.tekst;`,
    "return fout.tekst;",
  ],
  [
    "p32",
    HOOK,
    "een aanvraag die mislukte (te vaak, geen verbinding) zet toch het kenmerk 'hier aangevraagd'",
    "if (uitkomst.ok) {\n        const gedeeld = gedeeldeOpslag();\n        if (gedeeld) merkAangevraagd(gedeeld, op);",
    "{\n        const gedeeld = gedeeldeOpslag();\n        if (gedeeld) merkAangevraagd(gedeeld, op);\n      }\n      if (uitkomst.ok) {",
  ],
  [
    "p33",
    APP,
    "bij één dienst (geen klantportaal) ook het scherm 'Je bent al ingelogd'",
    "return klantportaal && session !== null && !vanDienst;",
    "return session !== null && !vanDienst;",
  ],
  [
    "p34",
    CODEPAGINA,
    "de regel 'Werk je hier? Gebruik de knop' valt weg",
    r`{metMail && knoppen.includes("cloudflare") ? (`,
    "{false ? (",
  ],
  [
    "p35",
    MAILCODE,
    "captcha_failed wordt verzwegen (de klant denkt dat er een mail komt)",
    r`if (error.code === "captcha_failed") return fout("robot");`,
    "",
  ],
];

/** Wat op 13-11-2026 alle unittests groen liet (zie het rapport van de aanval, ronde 2). */
const OVERLEVENDEN = [
  ..."g4 g5 g7 g8 g12 g14 g15 g19 g24 g25 g26 g29 g35 g36 g40 g41 g43 g44 g45 p15 p32".split(" "),
];

const args = process.argv.slice(2);
const kies = args.includes("--overlevenden") ? OVERLEVENDEN : args;
const lijst = kies.length ? MUTATIES.filter(([naam]) => kies.includes(naam)) : MUTATIES;

const uitkomsten = [];
for (const [naam, bestand, wat, zoek, vervang] of lijst) {
  const origineel = readFileSync(bestand, "utf8");
  if (!origineel.includes(zoek)) {
    uitkomsten.push([naam, bestand, wat, "NIET GEVONDEN"]);
    console.log(`${naam}\tNIET GEVONDEN\t${bestand}\t${wat}`);
    continue;
  }
  writeFileSync(
    bestand,
    origineel.replace(zoek, () => vervang),
  );
  let stand;
  try {
    // Eerst netjes opmaken: tests/unit/afgeleide-app.test.ts draait de lint over de hele repo,
    // en een mutatie die alleen op haar opmaak wordt gevangen, is niet gevangen.
    spawnSync("pnpm", ["exec", "biome", "format", "--write", bestand], { encoding: "utf8" });
    const run = spawnSync("pnpm", ["test"], { encoding: "utf8" });
    const uit = `${run.stdout}${run.stderr}`;
    const gefaald = [...uit.matchAll(/^\s*(?:FAIL|×|✗)\s+(.+)$/gm)].map((m) => m[1].trim());
    const uniek = [...new Set(gefaald.map((regel) => regel.replace(/\s+\d+ms$/, "")))];
    stand =
      run.status === 0
        ? "OVERLEEFT"
        : `gevangen (${uniek.length}): ${uniek.slice(0, 3).join(" | ") || "(zie uitvoer)"}`;
  } finally {
    writeFileSync(bestand, origineel);
  }
  uitkomsten.push([naam, bestand, wat, stand]);
  console.log(`${naam}\t${stand}\t${bestand}\t${wat}`);
}
const over = uitkomsten.filter(([, , , stand]) => stand === "OVERLEEFT");
console.log(`\n${uitkomsten.length} geprobeerd, ${over.length} overleven:`);
for (const [naam, bestand, wat] of over) console.log(`  ${naam}  ${bestand}: ${wat}`);
