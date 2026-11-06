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

**Geen `using (true)`, tenzij de tabel bewust open staat.** Een policy met `using (true)` of
`with check (true)` geeft iedereen met die rol alle rijen. Voor `anon` of zonder `to`-regel
(dan geldt hij voor iedereen met de openbare sleutel) blokkeert de poort hem altijd. Voor
`to authenticated` (of een eigen rol) alleen als de tabel met een reden in
`stack.config.json` staat:

```json
"open_tabellen": { "feestdagen": "kalender voor iedereen binnen, geen persoonsgegevens" }
```

Vraag de gebruiker of iedereen die binnen is dit echt mag zien, en zet zijn antwoord als
reden. De controle staat twee keer in de poort: `guard:rls` leest de migraties (al bij een
concept), en `tests/rls/open-policies.test.ts` leest de policies uit de database zelf.

**Een leesrol schrijft niet.** Leest een andere app deze database via een eigen rol
(bijvoorbeeld `intern_lezer` op een datalake), dan staat die rol in `stack.config.json` bij
`"leesrollen": ["intern_lezer"]`. Zo'n rol krijgt alleen `select`, bij voorkeur op views in
`api`. Elke `grant insert`, `update` of `delete` aan die rol is rood: schrijven gaat via een
functie in de app die de database beheert.

## Stap 3: Schrijf de RLS-test

Voor elke nieuwe tabel, in `tests/rls/`: log in als gebruiker A, probeer als gebruiker B
bij die gegevens te komen, verwacht leeg. De hulp `controleerAfscherming` in
`tests/rls/lib/afscherming.ts` doet dat in één aanroep (lezen, wijzigen, verwijderen, en een
uitgelogde bezoeker); het voorbeeld staat in `tests/rls/items.test.ts`:

```ts
await controleerAfscherming({
  tabel: "voorbeeld",
  maakRijAlsA: async (a) => {
    const { data, error } = await a.client
      .from("voorbeeld").insert({ owner_id: a.id }).select("id").single();
    if (error) throw error;
    return data.id;
  },
});
```

Hoort B in een rol of organisatie te zitten om het te kunnen proberen, zet hem daar dan met
`voorbereidB`, maar niet in die van A.

`guard:rls-tests` kijkt of elke tabel in `public` zo'n aanroep heeft, of met een reden in
`open_tabellen` staat (zie stap 2). In deze versie is dat nog een waarschuwing; vanaf de
volgende uitgave van Stage Two is het rood.

Die test draait in de Kwaliteitspoort (stap 4), in dezelfde eigen Supabase als je migraties.

Er is geen andere test die een fout in je policies vangt. De app ziet er van buiten
volstrekt normaal uit terwijl alle gegevens opvraagbaar zijn.

## Stap 4: Laat GitHub hem draaien

Een lokale database is niet nodig (en dus ook geen Docker). De Kwaliteitspoort start bij
elke run een eigen, lege Supabase, draait daar al je migraties vanaf niets en in volgorde,
en daarna de RLS-tests en de controle op de types. Dat is de echte test.

Ook een pull request met een migratie begint als concept. Omdat `supabase/` gewijzigd is,
draait de zware check dan al bij elke push, alleen zonder browser: Supabase, de migraties,
de controle op de types en de RLS-tests. De browsertest volgt als de PR op klaar gaat
(`gh pr ready`):

```bash
pnpm check
git push -u origin <branch>
gh pr create --draft
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

Types ophalen uit de API van de testdatabase (`supabase gen types --project-id`) is geen
alternatief: dat geeft een andere opmaak dan de CI, en dan blijft de check rood. Gebruik
alleen als tussenstap, en draai daarna altijd `pnpm db:types:uit-ci`.

Verzin nooit zelf een type voor een tabel. Als TypeScript klaagt dat een kolom niet
bestaat, is het antwoord `pnpm db:types:uit-ci`, niet een `any`.

## Stap 6: Zet je migratie bestaande gegevens om? Zeg wat je verwacht

Een migratie met een `update` of `delete` verandert gegevens die er al zijn. Zet dan bovenin
per tabel die hij raakt een regel met het aantal rijen dat je verwacht, als bereik:

```sql
-- verwachting: public.klanten 120-140
-- verwachting: public.orders 0-5
update public.klanten set status = 'archief' where laatst_actief < '2025-01-01';
delete from public.orders where status = 'concept' and klant_id is null;
```

Het formaat: `-- verwachting: <tabel> <min>-<max>` (of één getal als het precies zoveel moet
zijn). Het telt de rijen die de migratie in die tabel wijzigt of verwijdert; nieuwe rijen
tellen niet. Tel het eerst met een `select count(*)` met hetzelfde filter op de testdatabase
(een kopie van productie), en neem een ruim maar eerlijk bereik. Hangt het aantal af van de
dag waarop de migratie draait (`now()`, `current_date`), dan valt dat hier vaak al op.

Wat de poort ermee doet:

1. `guard:migrations` is rood als een `update` of `delete` geen regel heeft.
2. De workflow **Droogloop migraties** draait de migraties van de PR op de testdatabase, telt
   per tabel hoeveel rijen ze raken, en draait alles weer terug. Buiten het bereik, of een
   tabel die er niet bij staat: de status `Droogloop migraties` op de PR is rood. Die status is
   een verplichte controle en staat op elke PR; zonder migratie die gegevens omzet is hij
   vanzelf groen ("niets te oefenen"). Ontbreken de sleutels voor de testdatabase, dan kan de
   PR toch door met de regel `Bevestigd: droogloop zonder testdatabase` in de PR-tekst
   ("Re-run failed jobs" is genoeg); de owner zet de sleutels met App inrichten. De tellingen
   en vijf voorbeelden voor en na staan als reactie in de PR. De gebruiker hoeft die niet te
   beoordelen; het is het verslag voor als er later iets uitgezocht moet worden.
3. Na de merge zet **Database bijwerken** vlak vóór de migratie op productie een kopie van de
   geraakte tabellen in het schema `herstel`, als `herstel.<tabel>_<jjjjmmdd>_<uumm>` (tijd in
   UTC). Kopieën ouder dan veertien dagen gaan vanzelf weg.

Zet in de PR-tekst wat de weg terug is. Ging er iets mis, dan haal je de oude waarden met één
migratie terug uit de kopie, bijvoorbeeld:

```sql
-- terug naar de stand van vóór de migratie, voor de rijen die hij raakte
update public.klanten k set status = h.status
from herstel.klanten_20261105_1432 h
where h.id = k.id and k.status is distinct from h.status;
-- of verwijderde rijen terugzetten
insert into public.orders select * from herstel.orders_20261105_1432 h
where not exists (select 1 from public.orders o where o.id = h.id);
```

## Stap 7: Gaat er iets weg? Stop even

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

Zet een migratie gegevens om (stap 6), dan komt er vlak vóór stap 2 hieronder eerst een kopie
van de geraakte tabellen in het schema `herstel`.

1. Actions past de migratie eerst toe op de **testdatabase** (als die in
   `stack.config.json` staat). Faalt het daar, dan stopt het hier en blijft productie
   onaangeroerd. Lees dan de log van de workflow "Database bijwerken" en repareer met
   een nieuwe migratie.
2. Daarna dezelfde migratie op **productie**. Op welk Supabase-project dat is, staat in de
   instellingen van de repo: variabele `SUPABASE_PROJECT_REF` in omgeving `production`
   (Settings > Environments). Een app die nog niet opnieuw is ingericht, heeft hem nog als
   secret; dat werkt ook.
3. GitHub Actions zet de nieuwe versie op Cloudflare neer.

Migraties draaien **alleen bij een merge naar `main`**, nooit op een PR. Een PR mag
de database van niemand aanraken.
