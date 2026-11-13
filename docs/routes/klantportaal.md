# Een bestaande app een klantportaal maken

Een klantportaal is een app zonder deur van Cloudflare op het eigen domein. Medewerkers loggen
in via Cloudflare (Google of Microsoft), klanten met een code van acht cijfers of een link per
mail. Zonder deur kan iedereen op internet een account maken: de regels in de database zijn
dan de **enige** grens. Lees eerst in `docs/WERKWIJZE.md` (hoofdstuk 2) de alinea's vanaf "Een
recht hangt nooit aan iets wat een klant zelf kan claimen"; deze route zet dat om in stappen.

Deze route is nodig omdat de bestanden voor een klantportaal grotendeels van het project zijn
(`src/`, `supabase/`, `tests/`, `e2e/`): `/stagetwo-tier2:updaten` brengt ze niet mee. Je haalt
ze hier zelf uit de template. Het werk gaat in twee pull requests, volgens
`docs/routes/verder-werken.md`: eerst de database, dan de rest. De gewone regels gelden
(concept-PR, preview, `pnpm check`, alle checks groen).

## Stap 0: Moet dit een klantportaal worden?

Doe het **niet** als:

- alleen medewerkers de app gebruiken: dan blijft de deur, en verandert er niets;
- er alleen een paar pagina's open moeten (een link die je naar een klant stuurt): dat is
  `publiek` in `toegang.json` van de beheer-repo (`docs/WERKWIJZE.md`, hoofdstuk 2), geen
  klantportaal.

Controleer dan, in de map van de app:

```bash
cat .claude/stack-version
grep '"database"' stack.config.json
grep -v '^\s*//' wrangler.jsonc | grep custom_domain
grep -rlE 'public\.(klanten|is_medewerker|is_goedgekeurde_klant|klant_aanmelden|sessie_via_cloudflare)\b' supabase/migrations
grep -n '^\[auth.hook' supabase/config.toml
```

1. De versie is 43 of hoger. Lager: eerst `/stagetwo-tier2:updaten`, die pull request mergen,
   dan hier verder.
2. `"database": true`. Anders stop je: een klantportaal heeft een eigen database nodig. Leg
   het de bouwer uit.
3. Een regel met `"custom_domain": true`. Geen uitvoer: je kunt bouwen, maar de owner moet de
   app een eigen domein geven voordat het portaal live kan. Zeg dat de bouwer.
4. Geen uitvoer, of alleen een bestand dat op `_klantportaal.sql` eindigt. Staat er een ander
   bestand, dan heeft de app al een tabel of functie met een naam die de template gebruikt.
   Stop en leg het de bouwer voor: die van de app krijgt eerst een andere naam, in een eigen
   pull request.
5. Geen uitvoer. Anders heeft de app eigen hooks in Supabase Auth, en een klantportaal gebruikt
   de hooks van de inrichting. Stop en overleg met de bouwer en de owner.

Staan `src/features/auth/inlog-met-code.tsx` en een bestand `supabase/migrations/*_klantportaal.sql`
er al (de app is op versie 43 of later gemaakt), dan hoef je niets te kopiëren: doe van stap 2
alleen `supabase/testrol.sql`, en van stap 3 alleen "Daarna, met de hand".

Stel de bouwer daarna **één** vraag, en bouw pas als het antwoord er is:

> Wat mag een klant zien en doen (per scherm of tabel), en welke medewerkers keuren nieuwe
> klanten goed?

Schrijf het antwoord op als een lijst: per tabel "alleen medewerkers", "medewerkers en
goedgekeurde klanten, elk zijn eigen rijen", of iets daartussen. Dat is je bouwtekening voor
stap 4 en 5.

## Stap 1: De template ophalen

De template staat in de GitHub-organisatie van de app, als `app-template-tier2` (bij de eigen
apps van Stage Two is dat `Stage-Two-AI/app-template-tier2`). Haal hem op naast de app, op de
versie van de app:

```bash
T="${TMPDIR:-/tmp}/stagetwo-template"
rm -rf "$T"
gh repo clone "$(gh repo view --json owner -q .owner.login)/app-template-tier2" "$T" -- --quiet
git -C "$T" checkout --quiet "stack-v$(cat .claude/stack-version)"
git -C "$T" describe --tags
```

Goed als: de laatste regel `stack-v<de versie van de app>` is. Begin elk volgend blok met
dezelfde regel `T="${TMPDIR:-/tmp}/stagetwo-template"`. Zegt `gh` dat de repo niet bestaat,
kijk dan welke template de plugin gebruikt: `cat ~/.claude/plugins/marketplaces/stagetwo-tier2/levering.json`
(het veld `template`); staat dat bestand er niet, dan is het `Stage-Two-AI/app-template-tier2`.

## Stap 2: Pull request 1, alleen de database

Eerst de migratie, in een eigen pull request. Twee redenen: de previews en lokaal kijken
gebruiken de testdatabase, en die krijgt een migratie pas na de merge; en de typecontrole
kent `klanten` en `is_medewerker` pas als de types zijn opgehaald.

```bash
T="${TMPDIR:-/tmp}/stagetwo-template"
git checkout main && git pull && git checkout -b klantportaal-database
ls supabase/migrations | tail -n 1
cp "$T/supabase/migrations/20261114100000_klantportaal.sql" "supabase/migrations/$(date -u +%Y%m%d%H%M%S)_klantportaal.sql"
```

Het getal voorin de nieuwe naam moet groter zijn dan dat van de laatste migratie (de regel
van `ls`). Is het dat niet, hernoem het bestand dan naar dat getal plus één.

Maak `supabase/testrol.sql` (bestaat hij al, zet dit eronder). Zo is de testgebruiker een
goedgekeurde klant: lokaal kijken en de browsertest zien dan de schermen voor klanten. Een
medewerker kan hij niet zijn: dat kan alleen via Cloudflare.

```sql
-- Klantportaal: de testgebruiker is een goedgekeurde klant.
insert into public.klanten (user_id, e_mail, goedgekeurd)
select id, email, true from auth.users where email = 'testgebruiker@stagetwo.nl'
on conflict (user_id) do update set goedgekeurd = true;
```

Kijk of de browsertest dat bestand draait: `grep -n geefTestrol e2e/global-setup.ts`. Geen
uitvoer: neem de functie `geefTestrol` en de aanroep ervan over uit
`"$T/e2e/global-setup.ts"`.

Daarna zoals in `docs/routes/databasewijziging.md`, stap 4 en 5:

```bash
pnpm check
git add supabase/ e2e/ && git commit -m "Klantportaal: tabel klanten en de poorten in de database"
git push -u origin klantportaal-database
gh pr create --draft --fill
gh pr checks --watch
pnpm db:types:uit-ci
git add src/lib/database.types.ts && git commit -m "Databasetypes bijwerken" && git push
```

Goed als: `Code` groen is, `Database en end-to-end` eerst rood op "Databasetypes lopen gelijk"
(dat is de bedoeling) en na het pushen van de types groen. `guard:rls-tests` mag waarschuwen
dat `klanten` geen A/B-test heeft; die komt in pull request 2. Vul de PR-tekst in zoals
`verder-werken.md` zegt; als preview-regel volstaat dat er niets te zien is. Zet hem op klaar
(`gh pr ready`), wacht op groen, en vraag de bouwer hem te mergen. Na de merge zet Database
bijwerken de migratie op de testdatabase en productie. Er verandert voor gebruikers niets:
niemand roept de functies nog aan.

## Stap 3: Pull request 2, de bestanden overnemen

```bash
git checkout main && git pull && git checkout -b klantportaal
```

**Nieuw** (de app heeft ze nog niet; kopiëren):

```bash
T="${TMPDIR:-/tmp}/stagetwo-template"
for pad in \
  supabase/templates/inlogcode.html \
  src/features/auth/inlog-met-code.tsx src/features/auth/inlog-met-code.test.tsx \
  src/features/auth/mailcode.ts src/features/auth/mailcode.test.ts \
  src/features/auth/use-mailcode.ts \
  src/features/auth/robotcontrole.ts src/features/auth/robotcontrole.test.ts \
  src/features/auth/medewerkersessie.tsx src/features/auth/medewerkersessie.test.tsx \
  src/features/auth/app-klantportaal.test.tsx \
  src/lib/startfout.ts src/lib/startfout.test.ts src/main.test.ts \
  tests/lib/mailvanger.ts tests/rls/lib/sessies.ts tests/rls/lib/inlogdienst-nep.ts \
  tests/rls/klantportaal.test.ts tests/rls/inlogmail.test.ts \
  tests/unit/klantportaal-lokaal.test.ts e2e/klantportaal.spec.ts; do
  if [ -e "$pad" ]; then echo "STAAT ER AL: $pad"; else mkdir -p "$(dirname "$pad")" && cp "$T/$pad" "$pad" && echo "nieuw: $pad"; fi
done
```

Goed als: elke regel `nieuw:` is. Bij `STAAT ER AL` heeft de app een eigen bestand met die
naam: vergelijk het met dat van de template (`diff <pad> "$T/<pad>"`) en neem de versie van de
template over, met wat de app er zelf in had.

**Samenvoegen** (de app heeft een eigen versie; de wijzigingen van de template komen erbij met
een samenvoeging in drie richtingen, met versie 42 als basis):

```bash
T="${TMPDIR:-/tmp}/stagetwo-template"
voeg_samen() { # <pad in de app> <pad in de template> <pad op versie 42>
  if [ ! -e "$1" ]; then mkdir -p "$(dirname "$1")" && cp "$T/$2" "$1" && echo "nieuw: $1"; return; fi
  git -C "$T" show "stack-v42:$3" > "$1.basis"
  if git merge-file -L app -L versie-42 -L template "$1" "$1.basis" "$T/$2"; then echo "samengevoegd: $1"; else echo "CONFLICT: $1"; fi
  rm -f "$1.basis"
}
for pad in \
  src/lib/env.ts src/lib/env.test.ts \
  src/features/auth/inlogdienst.ts src/features/auth/inlogdienst.test.ts \
  src/features/auth/login-page.tsx src/features/auth/login-page.test.tsx \
  src/features/auth/app-met-database.tsx src/features/auth/app-met-database.test.tsx \
  playwright.config.ts supabase/config.toml .env.example .gitignore; do
  voeg_samen "$pad" "$pad" "$pad"
done
# De app start voortaan in src/start.tsx; wat de app zelf in src/main.tsx had, gaat mee.
cp src/main.tsx src/start.tsx && voeg_samen src/start.tsx src/start.tsx src/main.tsx
cp "$T/src/main.tsx" src/main.tsx
grep -rln '^<<<<<<<' src tests e2e supabase playwright.config.ts .env.example .gitignore
```

Goed als: de laatste regel niets toont. Een `CONFLICT` betekent dat de app en de template
dezelfde regels wijzigden; de plekken staan tussen `<<<<<<< app` en `>>>>>>> template`. Neem
het deel van de template, en zet er weer in wat de app zelf toevoegde (eigen routes, eigen
variabelen, eigen functies in `config.toml`). Wat er per bestand bij moet komen, zodat je weet
waar je op let:

| Bestand | Wat de template toevoegt |
|---|---|
| `src/lib/env.ts` | `VITE_INLOGDIENST` als tekst die `leesInlogdiensten` leest (een lijst met komma's), de export `inlogdiensten`, en `VITE_TURNSTILE_SITEKEY`. Het woord `leesInlogdiensten` moet in dit bestand staan: daaraan ziet de inrichting dat de app een klantportaal aankan |
| `src/features/auth/inlogdienst.ts` | de functie `leesInlogdiensten` |
| `src/features/auth/login-page.tsx` | bij meer dan één dienst de pagina `InlogMetCode`; een vaste tekst bij een fout in plaats van de tekst uit het adres |
| `src/features/auth/app-met-database.tsx` | de route `/login` met `Inlogroute` (de pagina "Je bent al ingelogd" met de knop voor medewerkers) en bovenin de melding "Je bent ingelogd als ...". De eigen routes van de app blijven |
| `src/start.tsx`, `src/main.tsx` | `main.tsx` laadt `start.tsx` en toont een fout bij het starten op het scherm |
| `playwright.config.ts` | een tweede build als klantportaal op poort 4174 en het project `klantportaal` |
| `supabase/config.toml` | `site_url` op poort 4174, de terugkeeradressen, ruimere remmen voor de tests, `enable_confirmations = true`, `otp_length = 8`, `otp_expiry = 900`, de drie mailsjablonen en het blok `[auth.external.keycloak]` (de nagebootste inlogdienst van de tests) |
| `.env.example`, `.gitignore` | `VITE_TURNSTILE_SITEKEY` en `dist-klantportaal/` |

Let op `enable_confirmations = true`: een eigen test die met `signUp` een gebruiker maakt en
meteen inlogt, werkt daarna niet meer. Maak testgebruikers zoals `tests/rls/lib/afscherming.ts`
(`admin.auth.admin.createUser` met `email_confirm: true`).

**Daarna, met de hand.** Drie bestanden van de template gaan uit van de voorbeeldtabel `items`
en de voorbeeldpagina "Mijn lijst"; die heeft de app niet:

1. `tests/rls/klantportaal.test.ts`: verwijder de twee blokken die met
   `describe("de poort van een klantportaal: wie alleen een mailadres heeft, mag niets"` en
   `describe("de poort van een klantportaal, gelezen uit de database zelf"` beginnen, tot
   aan `describe("een klant wijzigt zijn e-mailadres niet zelf"`. Haal daarna `metPoortOp`
   en de regel met `problemenKlantportaalInDatabase` uit de imports bovenin. Wat die blokken
   lieten zien, doen met de schakelaar `tests/rls/open-policies.test.ts` en jouw tests uit
   stap 6.
2. `src/features/auth/app-klantportaal.test.tsx`: vervang de regel
   `vi.mock("@/features/items/items-page", ...)` door de regel waarmee
   `src/features/auth/app-met-database.test.tsx` de startpagina van de app nabootst (die
   met `<p>Startpagina</p>`).
3. `e2e/klantportaal.spec.ts`: dat bestand verwacht na het inloggen de kop "Mijn lijst". Dat
   pas je aan in stap 5, als het scherm "wacht op goedkeuring" er is.

```bash
pnpm check
```

Goed als: alles groen. Rood op `typecheck` met "Cannot find module": een bestand dat de app
uit een oudere versie mist (bijvoorbeeld een onderdeel in `src/components/ui/`); neem het over
uit `"$T/<pad>"`. Rood op een test van de template: kijk of het een conflict was dat je
verkeerd hebt opgelost (vergelijk met `"$T/<pad>"`).

Commit dit als één stap ("Klantportaal: inlogpagina en tests uit de template") en open de
concept-PR (`git push -u origin klantportaal`, `gh pr create --draft`).

## Stap 4: De schakelaar en de regels in de database

Zet in `stack.config.json` (zonder iets anders te wijzigen):

```json
"klantportaal": true,
"open_tabellen": {}
```

```bash
pnpm guard:rls
```

Nu is hij rood, met een regel per policy, functie of view die openstaat voor iedereen met een
e-mailadres. Los ze op met **één nieuwe migratie** (`supabase/migrations/<tijdstempel>_klantportaal-poort.sql`,
tijdstempel zoals in stap 2) en draai `pnpm guard:rls` tot hij groen is.

Een **poort** is een van twee functies uit de migratie van stap 2: `public.is_medewerker()`
(ingelogd via Cloudflare, hoogstens twaalf uur geleden) of `public.is_goedgekeurde_klant()`
(een medewerker heeft dit account goedgekeurd). Elke regel voor ingelogde gebruikers moet er
een als harde eis hebben.

- **Een tabel.** De snelste veilige weg is één poort op de hele tabel; de policies die er al
  stonden (bijvoorbeeld "alleen je eigen rijen") blijven gelden:

  ```sql
  create policy "<tabel>_poort" on public.<tabel> as restrictive for all to authenticated
    using (public.is_medewerker() or public.is_goedgekeurde_klant());
  ```

  Is een tabel volgens de bouwer alleen voor medewerkers, dan staat er alleen
  `using (public.is_medewerker())`. Moeten medewerkers alle rijen van klanten zien, zet er
  dan een policy bij: `create policy "<tabel>_medewerker" on public.<tabel> for select to authenticated using (public.is_medewerker());`.
- **Bestanden.** Heeft de app policies op `storage.objects`, dan krijgt die tabel dezelfde
  poort: `create policy "bestanden_poort" on storage.objects as restrictive for all to authenticated using (public.is_medewerker() or public.is_goedgekeurde_klant());`.
- **Een tabel die in `open_tabellen` stond.** Haal de policy met `using (true)` weg
  (`drop policy "<naam>" on public.<tabel>;`) en maak hem opnieuw met de poort in plaats van
  `true`.
- **Een `security definer`-functie.** Drie wegen: zet de poort in de functie zelf, met
  `create or replace function` in je nieuwe migratie (bijvoorbeeld
  `... where public.is_medewerker()` in de vraag); of trek het
  recht in als een ingelogde gebruiker hem niet hoort aan te roepen
  (`revoke all on function public.<naam>() from public, anon, authenticated;`); of, als iemand
  zonder goedkeuring hem echt mag gebruiken, zet hem met een reden in `stack.config.json`:
  `"klantportaal_vrije_functies": { "<naam>": "<waarom>" }`. Vraag de bouwer bij die laatste.
- **Een view.** `alter view public.<naam> set (security_invoker = true);`: dan gelden de
  policies van de tabellen eronder.
- **Een eigen rollenfunctie** (de app kent soorten medewerkers, zoals `is_beheerder()`). Laat
  hem `public.is_medewerker()` aanroepen (`select public.is_medewerker() and exists (...)`) en
  zet hem met een reden in `stack.config.json`:
  `"klantportaal_poorten": { "is_beheerder": "medewerker met beheerrechten" }`.
- **Niet elke medewerker mag goedkeuren** (antwoord uit stap 0)? Dan beperkt een policy op
  `klanten` het tot die rollenfunctie:
  `create policy "klanten_goedkeuren_beheer" on public.klanten as restrictive for update to authenticated using (public.is_beheerder());`.

De regel uit `docs/WERKWIJZE.md`, en die is niet te onderhandelen: een recht hangt nooit aan
iets wat een klant zelf kan claimen. Dus nooit een e-mailadres of domein
(`auth.jwt() ->> 'email'`), nooit `user_metadata`, nooit een vaste `user_id` van een
medewerker. Medewerkerrechten alleen via `public.is_medewerker()`; die eist een verse sessie
via Cloudflare (twaalf uur).

Goed als: `pnpm guard:rls` groen is en `pnpm check` ook (de A/B-tests komen in stap 6; die
draaien niet lokaal).

## Stap 5: De app zelf

Vier dingen, alles in de eigen code van de app:

1. **Na het inloggen aanmelden.** Wie geen medewerker is, roept `klant_aanmelden()` aan; die
   zet het account op de lijst, niet goedgekeurd. Maak `src/features/auth/portaaltoegang.tsx`
   met deze kern (plus een test met een nagebootste `supabase.rpc`):

   ```ts
   export type Toegang = "medewerker" | "klant" | "wacht" | "verlopen";

   /** Wat de database over deze sessie zegt. Een nieuw account meldt zich aan als klant. */
   export async function bepaalToegang(session: Session): Promise<Toegang> {
     const medewerker = await supabase.rpc("is_medewerker");
     if (medewerker.data === true) return "medewerker";
     // Via Cloudflare binnen, maar de twaalf uur zijn om: opnieuw inloggen, geen klant.
     if (begonViaDienst(session)) return "verlopen";
     await supabase.rpc("klant_aanmelden");
     const klant = await supabase.rpc("is_goedgekeurde_klant");
     return klant.data === true ? "klant" : "wacht";
   }
   ```

   `begonViaDienst` en `OpnieuwAlsMedewerker` komen uit `@/features/auth/medewerkersessie`.
   Daarbij een component `Portaaltoegang` met `session` en `children`: roept
   `bepaalToegang(session)` aan in een `useEffect` met `[session]`, toont zolang "Bezig met
   laden…", bij `verlopen` `<OpnieuwAlsMedewerker />`, bij `wacht` het scherm uit punt 2, en
   anders de `children`. Zet in `src/features/auth/app-met-database.tsx` het element van elke
   route behalve `/login` erin, bijvoorbeeld
   `<Portaaltoegang session={session}><StartPage session={session} /></Portaaltoegang>`.
   Zonder `verlopen` zou een medewerker wiens twaalf uur om zijn als klant op de wachtlijst
   komen; dat geldt ook al voordat het portaal live is. De tests in
   `app-met-database.test.tsx` en `app-klantportaal.test.tsx` bootsen Supabase na zonder
   `rpc`; zet daar `rpc: vi.fn(async () => ({ data: true, error: null }))` naast `auth`.
   Rood op `lint` om de volgorde van imports: `pnpm lint:fix`.
2. **Het scherm "wacht op goedkeuring"** bij `wacht`: een kop (bijvoorbeeld "Je account
   wacht op goedkeuring"), een zin dat een medewerker het bekijkt, en een knop Uitloggen.
   Vervang nu in `e2e/klantportaal.spec.ts` elke `"Mijn lijst"` door die kop, behalve in de
   test "een verkeerde code geeft een nette melding en geen toegang": die logt in als de
   testgebruiker (goedgekeurd via `supabase/testrol.sql`) en ziet de kop van de startpagina
   (de regel met `pad: "/"` in `src/onderdelen.ts`).
3. **Een scherm voor medewerkers om klanten goed te keuren**: de lijst
   `supabase.from("klanten").select("user_id, e_mail, goedgekeurd, aangemeld_op")` en een knop
   die `.update({ goedgekeurd: true }).eq("user_id", id)` doet (en een knop om het weer op
   `false` te zetten). Alleen een medewerker ziet en wijzigt die tabel; dat regelt de
   database al.
4. **Elk scherm voor medewerkers** gebruikt `useMedewerkersessie(session)` en
   `OpnieuwAlsMedewerker` uit `src/features/auth/medewerkersessie.tsx` (het voorbeeld staat
   bovenin dat bestand): na twaalf uur ziet de medewerker "Log opnieuw in als medewerker" in
   plaats van een leeg scherm. De browsertest kan niet als medewerker inloggen (dat kan alleen
   via Cloudflare); zet het pad van zo'n scherm daarom in `GEEN_ONDERDEEL` in
   `src/onderdelen.ts`, niet in `ONDERDELEN`.

Bied een klant **niet** aan om zijn e-mailadres te wijzigen: dat loopt via een medewerker
(Supabase, Authentication, Users), en de inrichting zet die mail dicht.

Kijken: lokaal (de preview in de Claude-app) ben je de testgebruiker, een goedgekeurde klant.
De schermen voor medewerkers zie je in de Cloudflare-preview van de pull request, waar je via
Cloudflare inlogt. Inloggen met een code per mail is lokaal en in de preview niet te zien; dat
test de browsertest (`e2e/klantportaal.spec.ts`).

## Stap 6: De tests

De A/B-tests per tabel (`controleerAfscherming`) maken accounts met een wachtwoord. Die zijn
geen goedgekeurde klant, dus met de poort mag A niets meer maken: de test wordt rood. Maak
`tests/rls/lib/goedkeuren.ts`:

```ts
import { type Actor, admin } from "./afscherming";

/** Maakt van een testaccount een goedgekeurde klant van het klantportaal. */
export async function keurGoedAlsKlant(actor: Actor): Promise<void> {
  const { error } = await admin
    .from("klanten")
    .upsert({ user_id: actor.id, e_mail: actor.email, goedgekeurd: true });
  if (error) throw new Error(`Goedkeuren als klant mislukt: ${error.message}`);
}
```

Zet in elke `controleerAfscherming` `voorbereidB: keurGoedAlsKlant` en roep in `maakRijAlsA`
eerst `await keurGoedAlsKlant(a);` aan. Doe hetzelfde in elke andere test in `tests/rls/` die
met `maakActor` een gebruiker maakt die iets moet kunnen. Zet er per tabel waar klanten in
schrijven één test bij dat een account zónder goedkeuring niets leest en niets schrijft
(`maakActor`, dan `select` geeft `[]` en `insert` geeft een fout).

De RLS-tests en de browsertest draaien in de Kwaliteitspoort, in GitHub. Lokaal kan dat alleen
met Docker (`pnpm db:start`, `pnpm env:local`, `pnpm test:rls`, `pnpm test:e2e`); voor de
bouwer is dat niet nodig.

## Stap 7: Klaar, en de overdracht aan de owner

De pull request is klaar als `pnpm check` groen is, de PR op klaar staat (`gh pr ready`), alle
checks groen zijn (ook `Database en end-to-end`, met `tests/rls/klantportaal.test.ts`,
`tests/rls/open-policies.test.ts` en `e2e/klantportaal.spec.ts`) en de bouwer hem heeft
gemerged. Rood: lees de melding (`gh run view <run-id> --log-failed`) en repareer.

Daarna is de app klaar, maar nog steeds achter de deur. Het portaal open zetten doet de
**owner** van de beheer-repo, in de zeven stappen van het hoofdstuk "Klantportaal" in de
README van de beheer-repo (`https://github.com/<org>/stagetwo-beheer-tier2#klantportaal`;
heet die repo nog `stagetwo-beheer`, dan daar). In het kort: hij bevestigt met de bouwer dat
de app klaar is, zet de mail (Resend) en de controle tegen robots (Turnstile) klaar als
geheimen, maakt van de app een
klantportaal in `toegang.json`, draait App inrichten, rolt de app opnieuw uit, test zelf
inloggen per mail en als medewerker **achter de deur**, en haalt pas dan de deur weg met een
run met het uitdrukkelijke vinkje "Deur weghalen". Tot slot de knop Controle van buitenaf.

Geef de bouwer voor de owner mee: dat de app op versie 43 of later staat, dat een nieuw
account niets ziet tot een medewerker het goedkeurt, dat medewerkerrechten alleen via
Cloudflare gaan, en dat de app geen eigen hooks in Supabase Auth heeft (stap 0 van de owner).
Wat de bouwer niet zelf kan en dus aan de owner vraagt: Resend en het domein van de afzender,
de Turnstile-widget, de geheimen `SMTP_WACHTWOORD` en `TURNSTILE_GEHEIM`, `toegang.json`, App
inrichten en het weghalen van de deur. De variabelen `VITE_INLOGDIENST` en
`VITE_TURNSTILE_SITEKEY` zet de inrichting; zet ze niet zelf.

## Wat je niet doet

- Geen eigen hooks in Supabase Auth (aanmelden, token, mail): de inrichting zet haar eigen, en
  stopt als de app er al een heeft.
- Geen inloggen met een wachtwoord voor klanten, en geen eigen inlogscherm naast dat van de
  template.
- Niets openzetten "om het te laten werken": geen `using (true)`, geen `open_tabellen`, geen
  poort weglaten omdat een test anders rood is. Rood betekent dat iemand zonder goedkeuring
  ergens bij kan, of dat je test geen goedgekeurde klant gebruikt (stap 6).
- De schakelaar `"klantportaal": true` niet uitzetten om `guard:rls` groen te krijgen.
- Geen recht aan een e-mailadres, domein, `user_metadata` of vaste `user_id` hangen.
- Niets aan de deur, `wrangler.jsonc`, `toegang.json` of de variabelen in GitHub veranderen:
  dat doet de inrichting, op verzoek van de owner.
