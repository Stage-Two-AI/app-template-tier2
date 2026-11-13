import { fail, pass, skip } from "./lib/changed-files.mjs";
import {
  leesMigraties,
  problemenKlantportaal,
  problemenMetOpenPolicies,
  schrijfrechtenVoorLeesrollen,
  tabellenInPublic,
} from "./lib/rls-regels.mjs";
import { bezitDatabase, klantportaal, leesRollen, openTabellen } from "./lib/stack-config.mjs";

/**
 * In een browser-app is de database je beveiliging: er is geen tussenlaag die
 * controleert of iemand mag wat hij opvraagt. Een tabel zonder row level security
 * is dus geen slordigheid maar een datalek, en het is er een die je van buiten
 * niet ziet, want de app werkt gewoon.
 *
 * Deze guard leest álle migraties (niet alleen de gewijzigde) en eist:
 *
 * 1. elke tabel in het schema `public` heeft RLS aan én minstens één policy;
 * 2. geen policy met `using (true)` of `with check (true)` voor `anon` of `public`, en voor
 *    `authenticated` (of een eigen rol) alleen op een tabel in `open_tabellen` in
 *    stack.config.json, met een reden;
 * 3. een leesrol (`leesrollen` in stack.config.json, de rol waarmee een andere app deze
 *    database leest) krijgt nergens insert, update, delete of truncate;
 * 4. alleen bij een klantportaal (`"klantportaal": true` in stack.config.json): wie alleen een
 *    e-mailadres heeft, mag niets. Elke policy voor ingelogde gebruikers heeft een poort als
 *    harde eis, en elke `security definer`-functie of view waar een ingelogde gebruiker bij
 *    kan, roept een poort aan. Zonder de schakelaar gebeurt hier niets.
 *
 * Dit is de snelle controle op de tekst van de migraties, al bij een concept-PR. De echte
 * poort voor 2 en 3 is tests/rls/open-policies.test.ts: die leest de policies en rechten uit
 * de database zelf, ook als ze in een functie zijn gemaakt.
 */
if (!bezitDatabase()) {
  skip("deze app bezit geen database, dus ook geen tabellen om te beveiligen");
}

const sql = leesMigraties();
if (sql === null) pass("nog geen migraties");

const tables = tabellenInPublic(sql);

const open = openTabellen();
const leesrollen = leesRollen();
const openProblemen = problemenMetOpenPolicies(sql, open);
const schrijvendeLeesrollen = schrijfrechtenVoorLeesrollen(sql, leesrollen);

if (openProblemen.length > 0) {
  fail("Er is een policy die iedereen alle rijen geeft (using (true)).", [
    ...openProblemen.map((p) => `- ${p}`),
    "",
    "Zo'n policy laat iedereen met die rol alle rijen zien of schrijven. Twee wegen:",
    "",
    "  - Hoort elke gebruiker alleen zijn eigen rijen te zien? Maak de policy smal:",
    "      using (auth.uid() = owner_id)",
    "  - Mag iedereen die binnen is dit echt zien (een kalender, een lijst producten)?",
    "    Zet de tabel dan met een reden in stack.config.json:",
    '      "open_tabellen": { "<tabel>": "<waarom iedereen binnen dit mag zien>" }',
    "    Dat mag alleen voor `to authenticated` of een eigen rol, nooit voor anon of public.",
  ]);
}

if (schrijvendeLeesrollen.length > 0) {
  fail("Een leesrol krijgt schrijfrechten.", [
    ...schrijvendeLeesrollen.map((p) => `- ${p}`),
    "",
    "Een rol in `leesrollen` (stack.config.json) is de rol waarmee een andere app deze",
    "database leest. Die mag alleen lezen: geef hem `select`, bij voorkeur op views in `api`.",
    "Schrijven gaat via een functie in de app die de database beheert.",
  ]);
}

const portaal = klantportaal();
if (portaal !== null) {
  const problemen = problemenKlantportaal(sql, portaal);
  if (problemen.length > 0) {
    fail("Klantportaal: iemand met alleen een e-mailadres kan hier iets.", [
      ...problemen.map((p) => `- ${p}`),
      "",
      'Deze app is een klantportaal (`"klantportaal": true` in stack.config.json). Iedereen op',
      "internet kan er per mail een account maken, dus `to authenticated` is iedereen met een",
      "e-mailadres. Zo'n account mag niets tot een medewerker het goedkeurt. De regel:",
      "",
      "  1. Elke policy voor ingelogde gebruikers heeft in elke `using` en `with check` een poort",
      "     als harde eis: `public.is_medewerker()` of `public.is_goedgekeurde_klant()`, met",
      "     `and` aan de rest vast, in elke tak van een `or`:",
      "       using (public.is_goedgekeurde_klant() and auth.uid() = owner_id)",
      "     Of zet één keer de poort op de hele tabel; de policies die er al zijn blijven dan staan:",
      '       create policy "<tabel>_poort" on public.<tabel> as restrictive for all to authenticated',
      "         using (public.is_medewerker() or public.is_goedgekeurde_klant());",
      "  2. Een `security definer`-functie die een ingelogde gebruiker mag aanroepen, roept zelf",
      "     een poort aan. Is hij voor niemand bedoeld, trek het recht dan in:",
      "       revoke all on function public.<functie>() from public, anon, authenticated;",
      "     Mag iemand zonder goedkeuring hem echt aanroepen, zet hem dan met een reden in",
      '     stack.config.json: "klantportaal_vrije_functies": { "<functie>": "<waarom>" }.',
      "     Een view krijgt `with (security_invoker = true)`, of een poort in zijn vraag.",
      "",
      "Schrijf de poort voluit, met `public.` ervoor. Meer uitleg: docs/WERKWIJZE.md.",
    ]);
  }
}

if (tables.size === 0) pass("geen tabellen in het schema public");

const problems = [];
for (const table of tables) {
  const enabled = new RegExp(
    `alter\\s+table\\s+(?:only\\s+)?(?:public\\.)?"?${table}"?\\s+enable\\s+row\\s+level\\s+security`,
    "i",
  ).test(sql);
  const hasPolicy = new RegExp(
    `create\\s+policy[\\s\\S]{0,200}?\\bon\\s+(?:public\\.)?"?${table}"?[\\s(]`,
    "i",
  ).test(sql);

  if (!enabled) problems.push(`${table}: row level security staat niet aan`);
  else if (!hasPolicy) problems.push(`${table}: RLS staat aan maar er is geen enkele policy`);
}

if (problems.length === 0) {
  pass(`${tables.size} tabel(len) gecontroleerd, allemaal met RLS en policies`);
}

fail("Er is een tabel zonder werkende beveiliging.", [
  ...problems.map((problem) => `- ${problem}`),
  "",
  "Voeg aan de migratie toe:",
  "",
  "  alter table public.<tabel> enable row level security;",
  '  create policy "<tabel>_select_own" on public.<tabel>',
  "    for select using (auth.uid() = owner_id);",
  "",
  "Let op: RLS aanzetten zonder policy betekent dat niemand er meer bij kan.",
  "Een policy zonder RLS betekent dat iedereen er bij kan. Je hebt ze allebei nodig.",
  "En schrijf er een test bij in tests/rls/ met controleerAfscherming (tests/rls/lib/afscherming.ts):",
  "die controleert dat gebruiker B niet bij de gegevens van gebruiker A komt.",
]);
