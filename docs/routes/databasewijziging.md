# Een databasewijziging doorvoeren

De database is het enige onderdeel van deze stack dat gegevens **onherstelbaar** kan
vernietigen. Een merge-knop die `drop column` uitvoert is krachtig gereedschap. Loop
daarom deze route af, ook als de wijziging klein lijkt.

## Stap 0: bezit deze app de database wel?

Kijk in `stack.config.json`. Staat `database` op `"gedeeld"`, dan **stopt deze route hier**.
Deze app gebruikt de database van een andere app en mag het schema daarvan niet wijzigen;
`guard:migrations` blokkeert elke migratie die hier terechtkomt.

Je praat dan uitsluitend met het schema `api`, het contract van die andere app: views om te
lezen, functies om te schrijven. Mis je daar iets, dan is dat een wijziging aan het contract.
Dat is een aanvraag bij de eigenaar van die database (die staat in `gedeelde_database.eigenaar`),
geen bestand in deze repo.

Waarom zo streng: Supabase houdt in de database zelf bij welke migraties gedraaid zijn.
Zouden twee repo's daarheen pushen, dan kent de tweede de bestanden van de eerste niet en
faalt vanaf dat moment elke deploy. Precies één repo per database, altijd.

## Nooit met de hand in de Supabase-console

Niet in het dashboard klikken, niet even een kolom toevoegen "om het te proberen".
Dan loopt de repo uit de pas met de werkelijkheid en is de historie waardeloos.
Alles gaat als migratiebestand.

## Stap 1: Schrijf de migratie

Nieuw bestand in `supabase/migrations/`, met een tijdstempel voorop zodat de volgorde
vastligt:

```
supabase/migrations/20260901103000_voeg-status-toe-aan-items.sql
```

Eén migratie beschrijft één wijziging. Ze worden in volgorde uitgevoerd en nooit
achteraf aangepast: een fout herstel je met een nieuwe migratie, niet door de oude
te wijzigen (die is bij anderen al gedraaid).

## Stap 2: Elke nieuwe tabel krijgt RLS én policies

Dit is geen extra stap, dit is de beveiliging. In een browser-app is er geen server
die controleert of iemand mag wat hij opvraagt: dat doet Postgres.

```sql
create table public.voorbeeld (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.voorbeeld enable row level security;

grant select, insert, update, delete on public.voorbeeld to authenticated;

create policy "voorbeeld_select_own"
  on public.voorbeeld for select to authenticated
  using (auth.uid() = owner_id);
```

Let op het verschil:

- **RLS aan zonder policy** betekent dat niemand er meer bij kan.
- **Policy zonder RLS aan** betekent dat iedereen er bij kan.

Je hebt ze allebei nodig. De check `guard:rls` blokkeert de PR als er één ontbreekt.

En let op de **grant**, want dat is een derde slot dat mensen vergeten. Postgres
vraagt twee dingen: mag deze rol de tabel überhaupt benaderen (`grant`), en welke
rijen mag hij dan zien (`policy`). Vergeet je de grant, dan krijgt de app
`permission denied for table` terwijl je policies kloppen. Dat is niet onveilig,
maar wel stuk, en de RLS-test laat het meteen zien.

## Stap 3: Schrijf de RLS-test

Voor elke nieuwe tabel, in `tests/rls/`. Het patroon staat in `tests/rls/items.test.ts`:
log in als gebruiker A, probeer bij de gegevens van B te komen, verwacht leeg.

Die test draait in de Kwaliteitspoort (stap 4), in dezelfde eigen Supabase als je migraties.

Er is geen andere test die een fout in je policies vangt. De app ziet er van buiten
volstrekt normaal uit terwijl alle gegevens opvraagbaar zijn.

## Stap 4: Laat GitHub hem draaien

Een lokale database is niet nodig (en dus ook geen Docker). De Kwaliteitspoort start bij
elke run een eigen, lege Supabase, draait daar al je migraties vanaf niets en in volgorde,
en daarna de RLS-tests en de controle op de types. Dat is de echte test.

Een pull request met een migratie open je daarom **niet** als concept, zodat die zware
check meteen meedraait:

```bash
pnpm check
git push -u origin <branch>
gh pr create
gh pr checks --watch
```

## Stap 5: Haal de types op en commit ze

De eerste run is rood op `Databasetypes lopen gelijk met het schema`: jouw migratie
verandert het schema, en de types in de repo lopen nog achter. Dat is de bedoeling. De
check zet de nieuwe types in zijn log; haal ze op:

```bash
pnpm db:types:uit-ci
git add src/lib/database.types.ts
git commit -m "chore: databasetypes bijwerken"
git push
```

Dit werkt `src/lib/database.types.ts` bij. **Commit dat bestand.** De CI genereert
ze opnieuw en faalt als jouw versie afwijkt; zo kan de code nooit stilletjes uit de
pas lopen met de database.

(Heeft deze computer Docker, dan kan het ook lokaal: `pnpm db:start`, `pnpm db:reset`,
`pnpm env:local` en `pnpm db:types`. Voor bouwers is dat niet nodig.)

Verzin nooit zelf een type voor een tabel. Als TypeScript klaagt dat een kolom niet
bestaat, is het antwoord `pnpm db:types:uit-ci`, niet een `any`.

## Stap 6: Gaat er iets weg? Stop even

Verwijdert je migratie een tabel, een kolom of gegevens, dan blokkeert
`guard:migrations` de PR. Dat is de bedoeling. Loop dit na voordat je bevestigt:

1. Staan de back-ups aan en is de laatste recent?
2. Is dit op **productie** ook echt de bedoeling, of alleen in jouw testomgeving?
3. Kan het ook zonder dataverlies? Een kolom die je niet meer gebruikt mag ook
   gewoon blijven staan. Ongebruikte kolommen kosten niets; verdwenen gegevens zijn weg.

Weet je het zeker, zet dan deze regel exact zo in de PR-tekst:

```
Bevestigd: destructieve migratie
```

## Wat er gebeurt na de merge

1. Actions past de migratie eerst toe op de **testdatabase** (als die in
   `stack.config.json` staat). Faalt het daar, dan stopt het hier en blijft productie
   onaangeroerd. Lees dan de log van de workflow "Database bijwerken" en repareer met
   een nieuwe migratie.
2. Daarna dezelfde migratie op **productie**.
3. GitHub Actions zet de nieuwe versie op Cloudflare neer.

Migraties draaien **alleen bij een merge naar `main`**, nooit op een PR. Een PR mag
de database van niemand aanraken.
