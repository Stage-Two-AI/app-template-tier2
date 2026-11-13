# Een bestaande app een klantportaal maken

Een klantportaal is een app zonder deur van Cloudflare op het eigen domein. Medewerkers loggen
in via Cloudflare, klanten met een code of link per mail. Iedereen op internet kan dan een
account maken: de regels in de database zijn de **enige** grens. Lees eerst in
`docs/WERKWIJZE.md` (hoofdstuk 2) de alinea's vanaf "Een recht hangt nooit aan iets wat een
klant zelf kan claimen".

`/stagetwo-tier2:updaten` brengt de bestanden voor een klantportaal niet mee (ze zijn van het
project); je haalt ze hier uit de template. Het werk gaat in twee pull requests volgens
`docs/routes/verder-werken.md`: eerst de database, dan de rest.

## Stap 0: Moet dit een klantportaal worden?

Niet als alleen medewerkers de app gebruiken, en niet voor een paar pagina's die open moeten
(dat is `publiek` in `toegang.json` van de beheer-repo). Controleer in de map van de app:

```bash
cat .claude/stack-version
grep '"database"' stack.config.json
grep -v '^\s*//' wrangler.jsonc | grep custom_domain
grep -rlE 'public\.(klanten|is_medewerker|is_goedgekeurde_klant|klant_aanmelden|sessie_via_cloudflare)\b' supabase/migrations
grep -n '^\[auth.hook' supabase/config.toml
grep -rnE 'references auth\.users|owner_id|user_id|klant_id|account_id' supabase/migrations
```

| Regel | Goed | Anders |
|---|---|---|
| 1 | 43 of hoger | eerst `/stagetwo-tier2:updaten` en die pull request mergen |
| 2 | `"database": true` | stop: een klantportaal heeft een eigen database nodig |
| 3 | `"custom_domain": true` | je kunt bouwen, maar de owner geeft de app eerst een eigen domein; zeg het de bouwer |
| 4 | niets, of alleen `*_klantportaal.sql` | stop: een naam van de app botst met de template; die krijgt eerst een andere naam, in een eigen pull request |
| 5 | niets | stop: de app heeft eigen hooks in Supabase Auth; overleg met de bouwer en de owner |
| 6 | een tabel met een kolom die naar de gebruiker of klant verwijst | zonder zo'n tabel is niets "van een klant" en ziet hij na goedkeuring een lege app. Zeg dat de bouwer en vraag welke gegevens een klant moet zien, vóór je bouwt (vaak eerst een kolom erbij, met `docs/routes/databasewijziging.md`) |

Staan `src/features/auth/inlog-met-code.tsx` en `supabase/migrations/*_klantportaal.sql` er al
(de app is op versie 43 of later gemaakt), doe dan van stap 2 alleen `supabase/testrol.sql` en
van stap 3 alleen "Daarna, met de hand".

Stel de bouwer **één** vraag en bouw pas als het antwoord er is: "Wat mag een klant zien en
doen (per scherm of tabel), en welke medewerkers keuren nieuwe klanten goed?" Schrijf het op
als lijst per tabel: "alleen medewerkers", "medewerkers en goedgekeurde klanten, elk zijn eigen
rijen", of iets daartussen. Dat is je bouwtekening.

## Stap 1: De template ophalen

De template staat in de organisatie van de plugin uit `.claude/settings.json`
(`<org>/stagetwo-plugin-tier2`, dus `<org>/app-template-tier2`). Haal hem op, met alle versies:

```bash
ORG=$(node -p 'JSON.parse(require("fs").readFileSync(".claude/settings.json","utf8")).extraKnownMarketplaces["stagetwo-tier2"].source.repo.split("/")[0]')
T="${TMPDIR:-/tmp}/stagetwo-template"
rm -rf "$T" && git clone --quiet "https://github.com/$ORG/app-template-tier2" "$T"
git -C "$T" checkout --quiet "stack-v$(cat .claude/stack-version)" && git -C "$T" describe --tags
git -C "$T" tag --list 'stack-v*' | wc -l
```

Goed als: `describe` de versie van de app geeft (`stack-v<n>`) en de laatste regel meer dan 1
(stap 3 vergelijkt met eerdere versies). Mislukt het klonen: `gh repo clone "$ORG/app-template-tier2" "$T"`.
Begin elk volgend blok met de regel `T=...`.

## Stap 2: Pull request 1, alleen de database

Eerst de migratie apart: de testdatabase krijgt hem pas na de merge, en de typecontrole kent
`klanten` pas als de types zijn opgehaald.

```bash
T="${TMPDIR:-/tmp}/stagetwo-template"
git checkout main && git pull && git checkout -b klantportaal-database
ls supabase/migrations | tail -n 1
cp "$T/supabase/migrations/20261114100000_klantportaal.sql" "supabase/migrations/$(date -u +%Y%m%d%H%M%S)_klantportaal.sql"
grep -n geefTestrol e2e/global-setup.ts
```

Het getal voorin de nieuwe naam moet groter zijn dan dat van de laatste migratie (de regel van
`ls`); anders dat getal plus één. Geeft `grep` niets, neem dan `geefTestrol` en de aanroep ervan
over uit `"$T/e2e/global-setup.ts"`. Zet onder in `supabase/testrol.sql` (of maak hem), zodat de
testgebruiker een goedgekeurde klant is (medewerker kan hij niet zijn, dat kan alleen via
Cloudflare):

```sql
-- Klantportaal: de testgebruiker is een goedgekeurde klant.
insert into public.klanten (user_id, e_mail, goedgekeurd)
select id, email, true from auth.users where email = 'testgebruiker@stagetwo.nl'
on conflict (user_id) do update set goedgekeurd = true;
```

```bash
pnpm check
git add supabase/ e2e/ && git commit -m "Klantportaal: tabel klanten en de poorten in de database"
git push -u origin klantportaal-database && gh pr create --draft --fill
gh pr checks --watch
pnpm db:types:uit-ci && pnpm check
git add src/lib/database.types.ts && git commit -m "Databasetypes bijwerken" && git push
```

De Kwaliteitspoort draait ook op een concept, omdat de PR `supabase/` raakt. `gh pr checks
--watch` wacht tot hij klaar is: `Database en end-to-end` is dan rood op "Databasetypes lopen
gelijk met het schema". Dat hoort zo: de nieuwe types staan in zijn log, en
`pnpm db:types:uit-ci` haalt ze op. Zegt dat "loopt nog", wacht; zegt het "geen gegenereerde
types", zet de PR op klaar (`gh pr ready`), wacht en probeer opnieuw. Rood op `typecheck` daarna:
eigen code die over **alle** tabellen gaat (een `Record` of lijst met een sleutel per tabel uit
`Database["public"]["Tables"]`) mist `klanten`; zet die erbij.

Goed als: alle checks groen (`guard:rls-tests` mag waarschuwen over `klanten`). PR-tekst zoals in
`verder-werken.md` (preview: niets te zien), op klaar, groen, en de bouwer merget. Voor
gebruikers verandert er niets.

## Stap 3: Pull request 2, de bestanden overnemen

```bash
T="${TMPDIR:-/tmp}/stagetwo-template"
git checkout main && git pull && git checkout -b klantportaal
node "$T/scripts/klantportaal-overnemen.mjs" --template "$T"
```

Dit kijkt alleen. Een update raakt `src/` nooit, dus de eigen code kan van een veel oudere
versie zijn dan de app; het script vergelijkt elk bestand daarom met de template op **elke**
eerdere versie. Per bestand: `nieuw`, `samenvoegen` (gelijk of weinig anders dan de
dichtstbijzijnde versie, die de basis wordt) of `MET DE HAND` (veel van de template ontbreekt:
een oudere of eigen indeling). Bovenaan: heeft de app `src/features/auth/app-met-database.tsx`,
en waar staan de routes. Onderaan: **weg A** of **weg B**.

**Weg A** (geen `MET DE HAND`): draai het opnieuw met `--overnemen`. Bij `CONFLICT` staan de
plekken tussen `<<<<<<< app` en `>>>>>>> template`: neem het deel van de template en zet erin wat
de app zelf toevoegde (eigen routes, variabelen, functies in `config.toml`).

**Weg B**: **stop**, en leg de bouwer eerst in gewone taal uit wat er verandert, bijvoorbeeld:
"Je app regelt de schermen nu in `src/App.tsx`. De template doet dat in een ander bestand, met
de nieuwe inlogpagina. Ik neem die bestanden over en zet jouw schermen erin terug; daarna kijken
we samen in de preview of alles er nog is." Na zijn akkoord: `--overnemen`. Elk bestand
`MET DE HAND` is dan de versie van de template; wat de app erin had, toont
`git show HEAD:<pad>`. Zet alleen de eigen routes en imports terug. De routes gaan uit de
bestanden die het script noemde (meestal `src/App.tsx`) naar
`src/features/auth/app-met-database.tsx`, in de plaats van het voorbeeld `ItemsPage`:

```tsx
// Vóór, in src/App.tsx (met een eigen hook: const { session } = useAuth()):
import { BestellingenPage } from "@/features/bestellingen/bestellingen-page";
<Route path="/" element={session ? <BestellingenPage session={session} /> : <Navigate to="/login" replace />} />
// Na, in app-met-database.tsx (session komt daar uit useSession; import en route van ItemsPage zijn weg):
import { BestellingenPage } from "@/features/bestellingen/bestellingen-page";
<Route path="/" element={session ? <BestellingenPage session={session} /> : <Navigate to="/login" replace />} />
```

`src/App.tsx` wordt die van de template, `src/main.tsx` laadt voortaan `src/start.tsx`, en wat de
app zelf in `main.tsx` deed (een eigen import, een aanroep vóór het renderen) gaat naar
`src/start.tsx`.

**Daarna, met de hand**, bij beide wegen:

```bash
node "$T/scripts/klantportaal-overnemen.mjs" --nakijken
grep -rln '^<<<<<<<' src tests e2e supabase playwright.config.ts .env.example .gitignore
```

1. `--nakijken` meldt elk pad uit de router van de laatste commit dat nu weg is; zet het terug.
   De typecontrole ziet dat niet. De `grep` toont niets meer.
2. `app-met-database.test.tsx` en `app-klantportaal.test.tsx` bootsen de startpagina van de
   template na (`vi.mock("@/features/items/items-page", ...)`). Heeft de app op `/` een eigen
   scherm, boots dat dan na, bijvoorbeeld
   `vi.mock("@/features/bestellingen/bestellingen-page", () => ({ BestellingenPage: () => <p>Startpagina</p> }));`.
3. Geen tabel `items` in de app: haal in `tests/rls/klantportaal.test.ts` de blokken weg die met
   `describe("de poort van een klantportaal` beginnen (tot het volgende `describe(`), en de
   imports die daardoor ongebruikt zijn. Dat doen nu `tests/rls/open-policies.test.ts` (met de
   schakelaar) en jouw tests uit stap 6.
4. `supabase/config.toml` krijgt `enable_confirmations = true`: een eigen test die met `signUp`
   een gebruiker maakt en meteen inlogt, werkt niet meer. Gebruik `maakActor`.

Dan `pnpm check`. Rood op "Cannot find module": een bestand dat de app uit een oudere versie
mist (bijvoorbeeld in `src/components/ui/`); neem het over uit `"$T/<pad>"`. Rood op een test van
de template: vergelijk met `"$T/<pad>"`. Commit ("Klantportaal: inlogpagina en tests uit de
template"), open de concept-PR, en laat de bouwer in de preview nakijken of alle schermen er nog
zijn (bij weg B nadrukkelijk).

## Stap 4: De schakelaar en de regels in de database

Zet in `stack.config.json` `"klantportaal": true` en `"open_tabellen": {}`, verder niets. Nu is
`pnpm guard:rls` rood, met een regel per policy, functie of view die openstaat voor iedereen met
een e-mailadres. Los alles op in **één nieuwe migratie**
(`supabase/migrations/<tijdstempel>_klantportaal-poort.sql`) tot hij groen is.

Een **poort** is `public.is_medewerker()` (via Cloudflare, hoogstens twaalf uur geleden) of
`public.is_goedgekeurde_klant()`, als harde eis in elke regel voor ingelogde gebruikers. Schrijf
hem als `(select public.is_medewerker())`: dan rekent Postgres hem één keer per vraag uit in
plaats van per rij. Per geval:

| Geval | Wat je schrijft |
|---|---|
| tabel voor medewerkers en klanten | `create policy "<tabel>_poort" on public.<tabel> as restrictive for all to authenticated using ((select public.is_medewerker()) or (select public.is_goedgekeurde_klant()));` De bestaande policies (bijvoorbeeld "alleen je eigen rijen") blijven gelden. Bij `restrictive for all` geldt de `using` ook bij schrijven |
| medewerkers zien alle rijen | erbij: `create policy "<tabel>_medewerker" on public.<tabel> for select to authenticated using ((select public.is_medewerker()));` |
| tabel alleen voor medewerkers | `create policy "<tabel>_poort" on public.<tabel> as restrictive for all to authenticated using ((select public.is_medewerker()));` (schermen: stap 5, tests: stap 6) |
| bestanden (`storage.objects`) | dezelfde poort als de eerste regel, `on storage.objects` |
| tabel in `open_tabellen` | `drop policy "<naam>" on public.<tabel>;` en opnieuw, met de poort in plaats van `true` |
| `security definer`-functie | de poort in de functie zelf (`create or replace function`), of `revoke all on function public.<naam>() from public, anon, authenticated;`, of alleen als de bouwer zegt dat iemand zonder goedkeuring hem mag gebruiken: `"klantportaal_vrije_functies": { "<naam>": "<waarom>" }` |
| view | `alter view public.<naam> set (security_invoker = true);` |
| eigen rollenfunctie (`is_beheerder()`) | laat hem `public.is_medewerker()` aanroepen en zet hem in `"klantportaal_poorten": { "is_beheerder": "<waarom>" }` |
| niet elke medewerker mag goedkeuren | `create policy "klanten_goedkeuren_beheer" on public.klanten as restrictive for update to authenticated using ((select public.is_beheerder()));` |

**Edge functions** (`supabase/functions/`) ziet de guard niet. Loop elke functie na die een
geheim gebruikt op een waarde die de gebruiker zelf meestuurt, of die rijen van de gebruiker
leest of schrijft. Zo'n functie vraagt eerst met het token van de aanroeper (`authorization`, de
header `Authorization`, zie `supabase/functions/voorbeeld-met-geheim/`) of hij mag:

```ts
// Klantportaal: alleen een medewerker of een goedgekeurde klant mag verder.
const poort = async (naam: string) => {
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/${naam}`, {
    method: "POST",
    headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "", Authorization: authorization, "content-type": "application/json" },
    body: "{}",
  });
  return r.ok && (await r.json()) === true;
};
if (!(await poort("is_medewerker")) && !(await poort("is_goedgekeurde_klant"))) {
  return new Response(JSON.stringify({ error: "Geen toegang" }), { status: 403 });
}
```

Alleen voor medewerkers: laat de tweede `poort(...)` weg. Een functie voor een machine
(`welkApparaat`) heeft dit niet nodig.

Niet te onderhandelen (`docs/WERKWIJZE.md`): geen recht aan een e-mailadres of domein
(`auth.jwt() ->> 'email'`), `user_metadata` of een vaste `user_id`. Goed als: `pnpm guard:rls`
en `pnpm check` groen.

## Stap 5: De app zelf

Stap 3 nam vier voorbeelden uit de template over, in `src/features/auth/`, elk met uitleg
bovenin (de teksten mag je aanpassen):

1. **`portaaltoegang.tsx`, de omhulling.** Zet in `app-met-database.tsx` alle routes behalve
   `/login` binnen één route zonder pad; ze blijven verder zoals ze zijn, en geneste routes
   (`/klanten/:id/*`) en de vangroute (`*`) vallen er vanzelf onder:

   ```tsx
   <Route path="/login" element={<Inlogroute session={session} ingelogd={ingelogd} />} />
   <Route element={<PortaalRoute session={session} />}>
     {/* alle andere routes, ongewijzigd, ook <Route path="*" ... /> */}
   </Route>
   ```

   Een medewerker en een goedgekeurde klant zien de app; een nieuw account meldt zich aan en
   ziet `wacht-op-goedkeuring.tsx`; een medewerker wiens twaalf uur om zijn, krijgt de knop om
   opnieuw in te loggen. Zet in `app-met-database.test.tsx` en `app-klantportaal.test.tsx` bij de
   nagebootste Supabase `rpc: vi.fn(async () => ({ data: true, error: null })),` naast `auth`.
2. **`klanten-goedkeuren.tsx`.** Geef `KlantenGoedkeurenPage` een route binnen de omhulling
   (bijvoorbeeld `/klanten-goedkeuren`) en een link voor medewerkers.
3. **`alleen-medewerker.tsx`.** Elk scherm (of deel) alleen voor medewerkers komt in
   `<AlleenMedewerker session={session}>...</AlleenMedewerker>`: na twaalf uur de knop om opnieuw
   in te loggen, voor een klant "Geen toegang".
4. **Onderdelen en de browsertest.** De browsertest logt in als de testgebruiker, een
   goedgekeurde **klant**, en ziet schermen voor medewerkers nooit. Leg de bouwer per scherm de
   keuze voor: alleen voor medewerkers (pad in `GEEN_ONDERDEEL` in `src/onderdelen.ts`; de
   medewerker test het zelf in de Cloudflare-preview; zo hoort het bij `/klanten-goedkeuren`), of
   ook voor klanten met hun eigen rijen (geen `AlleenMedewerker`, de poort voor beide, het pad
   blijft in `ONDERDELEN`).
5. Vervang in `e2e/klantportaal.spec.ts` elke `"Mijn lijst"` door
   `"Je account wacht op goedkeuring"`, behalve in de test "een verkeerde code geeft een nette
   melding en geen toegang": die logt in als de testgebruiker en ziet de kop van de startpagina
   (de regel met `pad: "/"` in `src/onderdelen.ts`).

Bied een klant **niet** aan zijn e-mailadres te wijzigen. Rood op `lint` om de volgorde van
imports: `pnpm lint:fix`. Lokaal kijken (de preview in de Claude-app) doe je als de
testgebruiker, een klant; de schermen voor medewerkers zie je in de Cloudflare-preview.

## Stap 6: De tests

Met de schakelaar aan is elke testgebruiker van `maakActor` (dus ook A en B in
`controleerAfscherming`) vanzelf een goedgekeurde klant; de bestaande A/B-tests blijven werken.

1. Eigen hulpen die zelf gebruikers maken: `grep -rln "auth.admin.createUser\|signInWithPassword" tests/rls`.
   Roep daar na het maken `await keurGoedAlsKlant({ id, email })` aan (uit `./lib/afscherming`),
   behalve in de bestanden van de template (`lib/afscherming.ts`, `lib/sessies.ts`,
   `klantportaal.test.ts`).
2. Een tabel alleen voor medewerkers: laat `maakRijAlsA` de rij maken met `admin` (die gaat
   langs de regels heen); B, een klant, mag er dan niet bij.
3. Per tabel waar klanten in schrijven: een account zonder goedkeuring
   (`await maakActor("vreemde", { goedgekeurd: false })`) krijgt bij `select` `[]` en bij
   `insert` een fout. Ruim op met `verwijderActor`.

Deze tests en de browsertest draaien in GitHub (lokaal alleen met Docker; voor de bouwer niet
nodig).

## Stap 7: Vóór het mergen van pull request 2

**De poort geldt in productie zodra pull request 2 is gemerged**, ook achter de deur en vóór de
owner iets doet. Dan is alleen medewerker wie via Cloudflare inlogde, hoogstens twaalf uur
geleden, met een account dat in Supabase **alleen** de inlogmanieren `custom:cloudflare` en
`email` heeft. Wie ooit rechtstreeks met Google of Microsoft in Supabase inlogde, ziet daarna
niets meer. De agent kan productie niet lezen: vraag de owner deze leesvraag te draaien in
Supabase (het project van productie, SQL Editor):

```sql
select u.email, array_agg(i.provider order by i.provider) as inlogmanieren
  from auth.users u join auth.identities i on i.user_id = u.id
 group by u.id, u.email
having bool_or(i.provider not in ('custom:cloudflare', 'email'))
 order by u.email;
```

Goed als: geen rijen. Staat er een medewerker in, merge dan niet. De owner bekijkt eerst die
rijen (`select * from auth.identities where user_id = '<id>' and provider not in ('custom:cloudflare', 'email');`)
en haalt ze dan met hetzelfde filter weg (`delete from ...`); het account en zijn gegevens
blijven. Twijfelt hij, dan beslissen bouwer en owner samen en blijft de PR open.

Zeg de bouwer in gewone taal wat er na de merge verandert: "Iedereen logt nog steeds in via
Cloudflare. Wie al lang ingelogd was, ziet één keer 'Log opnieuw in als medewerker' en klikt op
de knop; dat geldt daarna elke twaalf uur. Klanten kunnen pas erin als de owner de deur
weghaalt."

Klaar als `pnpm check` groen is, de PR op klaar staat, alle checks groen zijn (ook `Database en
end-to-end`) en de bouwer hem heeft gemerged. Rood: `gh run view <run-id> --log-failed`, en
repareer.

## Stap 8: De overdracht aan de owner

Het portaal open zetten doet de **owner**, met het hoofdstuk "Klantportaal" in de README van de
beheer-repo (`https://github.com/<org>/stagetwo-beheer-tier2#klantportaal`, of
`stagetwo-beheer`): mail (Resend) en Turnstile klaarzetten, de app een klantportaal maken in
`toegang.json`, App inrichten, testen achter de deur, en pas dan de deur weghalen met het vinkje
"Deur weghalen". App inrichten stopt als `stack.config.json` op `main` van de app geen
`"klantportaal": true` heeft. Geef de bouwer mee voor de owner: versie 43 of later, deze route
gevolgd en gemerged, een nieuw account ziet niets tot een medewerker het goedkeurt,
medewerkerrechten alleen via Cloudflare, geen eigen hooks in Supabase Auth. `VITE_INLOGDIENST`
en `VITE_TURNSTILE_SITEKEY` zet de inrichting, niet jij.

## Wat je niet doet

- Geen eigen hooks in Supabase Auth, geen wachtwoord voor klanten, geen eigen inlogscherm.
- Niets openzetten "om het te laten werken": geen `using (true)`, geen `open_tabellen`, geen
  poort weglaten omdat een test rood is, de schakelaar niet uitzetten. Rood betekent dat iemand
  zonder goedkeuring ergens bij kan, of dat een test geen goedgekeurde klant gebruikt (stap 6).
- Geen recht aan een e-mailadres, domein, `user_metadata` of vaste `user_id`.
- Niets aan de deur, `wrangler.jsonc`, `toegang.json` of de variabelen in GitHub: dat doet de
  inrichting, op verzoek van de owner.
