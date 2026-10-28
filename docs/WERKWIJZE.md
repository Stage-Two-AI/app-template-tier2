# Werkwijze

*Hoort bij tier 2 van de Stage Two-stack. Welke versie deze app heeft, staat in
`.claude/stack-version`; in de template is elke versie een tag `stack-v<nummer>`. Dit bestand
komt uit de gedeelde template en wordt bijgewerkt met `/stagetwo-tier2:updaten`, als pull
request; wijzig het niet per project.*

Dit legt uit hóé er in dit project gewerkt wordt en vooral **waarom**. De korte,
gebiedende versie voor dagelijks gebruik staat in `AGENTS.md`; dit is de achtergrond
voor wie een keuze wil begrijpen of ter discussie wil stellen.

De uitgangspunten waar alles uit volgt:

- De bouwer is geen programmeur en kan code niet regel voor regel beoordelen. Elke
  keuze moet fouten daarom **mechanisch** afvangen in plaats van te vertrouwen op het
  oog van de bouwer.
- Het werk moet **overdraagbaar** zijn aan een ingehuurde programmeur. Geen
  zelfbedachte workflows, alleen bewezen industriepraktijk.
- Je moet **zonder Stage Two verder kunnen**: wat je bouwt en je gegevens zijn van jou;
  plugin en template mag je blijven gebruiken en ze blijven werken, ook zonder Stage Two.
  Zolang je bedrijf een abonnement heeft, zet Stage Two nieuwe versies van deze werkwijze in
  de kopie die Stage Two bij de start in je eigen GitHub klaarzet, nadat Stage Two ze op zijn eigen apps heeft toegepast; stopt het,
  dan blijft die kopie op de laatste versie staan. Het abonnement kost €150 per maand per
  bedrijf, ongeacht het aantal apps, exclusief btw, en is per maand opzegbaar, met een
  opzegtermijn van één kalendermaand. Het levert nieuwe versies van template en plugin, een
  nieuwe versie van de beheer-repo als dat nodig is, en vragen en meedenken, tot ongeveer een
  uur per maand (meer tijd op afspraak). De plugin meldt
  een nieuwe versie en zet met `/stagetwo-tier2:updaten` per app het update-voorstel klaar; een
  bouwer keurt het goed. Het abonnement houdt de omgeving niet bij: beheer en werking blijven
  na de overdracht bij je bedrijf. Systeembeheer, een garantie op beschikbaarheid en meer werk
  aan je apps (op verzoek, op nacalculatie tegen €120 per uur exclusief btw) vallen erbuiten.
  Dependabot, een dienst van GitHub, stelt in elke app updates van de npm-pakketten voor, als
  pull request, ook zonder abonnement. De versies van de GitHub-workflows in
  `.github/workflows/` komen met een nieuwe versie van de template, omdat die workflows van de
  template zijn; alleen een beveiligingsupdate kan Dependabot tussendoor voorstellen. Hoogt die
  alleen de versie van een GitHub Action in die workflows op, dan laat de controle op
  templatebestanden hem door. Zie [stagetwo.nl/#aanbod](https://stagetwo.nl/#aanbod).
- De afspraken hangen niet aan één AI-assistent. Met Claude Code, Codex of een andere
  agent, of zonder agent, gelden dezelfde regels en dezelfde poort.

---

## 1. Waarom deze onderdelen

| Laag | Keuze | Waarom |
|---|---|---|
| Taal | TypeScript, `strict` | vangt het gros van de fouten vóór het live gaat |
| Bouwgereedschap | Vite | snel, en het houdt de app in de browser waar hij thuishoort |
| Interface | React + shadcn/ui + Tailwind | bouwblokken in je eigen repo, geen afhankelijkheid van iemands versiebeleid |
| Database, inloggen, opslag | Supabase | neemt het moeilijkste werk weg, en het is gewoon Postgres, dus overdraagbaar |
| Validatie | Zod | controleert gegevens van buiten vóór gebruik |
| Tests | Vitest + Playwright | het vangnet |
| Fouten in productie | Sentry | anders hoor je het van je klant |
| Hosting en toegang | Cloudflare | een preview per pull request achter de login, productie op `main`; Cloudflare is ook het enige punt waar inloggen en toegang geregeld worden |

Waarom een browser-app en geen app met een eigen server: het typische project is een
intern werktuig achter een login. Geen Google nodig, maar wél de printer, de camera
voor barcodes, een PDF uit wat op het scherm staat, Excel in- en uitlezen. Dat kan
alleen in de browser; een server kan er niet bij.

**Fouten uit productie lezen: Sentry.** Elke fout die een gebruiker in productie tegenkomt,
komt in Sentry terecht. Het Sentry-account staat op naam van je organisatie, op het gratis
plan. Je assistent leest het via de koppeling met Sentry in claude.ai (Instellingen >
Koppelingen); dat werkt ook in een cloudsessie. Bij een nieuwe bouwer zet die de koppeling
aan in zijn eigen claude.ai, en logt de beheerder van het Sentry-account in op het scherm
van de bouwer, zodat het wachtwoord niet rondgaat. Bij een melding over een fout is de
eerste stap: in Sentry kijken wat er precies gebeurde. Gaat er iemand weg, trek dan alle
koppelingen in en koppel de anderen opnieuw: één los intrekken lukt waarschijnlijk niet,
omdat ze allemaal aan dezelfde Sentry-login hangen.

---

## 2. Beveiliging, en waarom dat hier zwaarder weegt

**Zonder server is de database je beveiliging.** Er is geen tussenlaag die controleert
of iemand mag wat hij opvraagt. Dat doet Postgres via row level security (RLS). Staan
die regels fout, dan kan een ingelogde gebruiker met een beetje kennis álle gegevens
opvragen, terwijl de app er van buiten volstrekt normaal uitziet.

Daarom:

> Elke tabel krijgt RLS aan én policies, en RLS-policies worden getest net als code:
> log in als gebruiker A, vraag gegevens van B op, verwacht leeg.

**Alles in een browser-app is leesbaar voor de gebruiker.** Elke `VITE_`-variabele zit
in het bestand dat de bezoeker downloadt.

- Wél in de app: de Supabase **anon key** en de **Sentry DSN**. Die zijn expres
  publiek: de anon key wordt door RLS beschermd, de DSN kan alleen fouten insturen.
- **Nooit** in de app: de **service role key**, API-sleutels van derden, wachtwoorden.
  Die horen in een Supabase Edge Function.
- `.env` staat nooit in git. `.env.example` wel, met lege waarden en per variabele een
  regel uitleg.
- Eén uitzondering op je eigen computer: de testlogin (`VITE_TESTLOGIN_*`). Die staat in
  `.env.development.local`, een bestand dat Vite alleen leest als de app op je eigen
  computer draait, nooit bij het bouwen. Als extra slot maakt `vite.config.ts` hem bij het
  bouwen ook nog leeg. Zo komt hij nooit in de gebouwde app. Omdat je daarmee bij een kopie van echte
  gegevens kunt, hoort schijfversleuteling aan te staan (hoofdstuk 3).

Twee checks bewaken dit automatisch: één die de repo doorzoekt, en één die de
gebouwde bundel doorzoekt. Die tweede is de belangrijkste van allemaal.

**Elk adres staat achter Access.** Cloudflare Access is de deur: wie niet op de lijst
staat, ziet de app niet. Dat werkt alleen als er geen adres is om omheen te gaan. Er
zijn er twee soorten: het eigen domein, met een Access-app op dat domein, en de adressen
op workers.dev (het hoofdadres en de previews per pull request), met de Access op de
Worker zelf. `wrangler.jsonc` kent twee standen, en `scripts/lib/cloudflare-config.mjs`
weigert elke andere combinatie:

| Stand | In `wrangler.jsonc` | Wanneer |
|---|---|---|
| standaard | een route met `custom_domain: true`, en `workers_dev: true` | altijd, zodra de app een eigen domein heeft |
| tijdelijk | geen `routes`, en `workers_dev: true` | alleen zolang de klant nog geen domein heeft gekozen |

`workers_dev` staat in beide standen aan. Staat hij uit, dan tonen de previews achter
Access alleen een lege pagina van Cloudflare ("There is nothing here yet"), ook met
`preview_urls: true`; dat bleek bij finance op 15-10-2026. De Access op de Worker zelf
dekt het workers.dev-adres al, dus er komt geen open deur bij.

In de tijdelijke stand draait de app alleen op `<worker>.<subdomein>.workers.dev`; een
Access-app op een hostname is er nog niet. Het is een overbrugging, geen keuze voor de
lange termijn: is het domein er, dan komt de route erbij. Dat overstappen gaat met de
inrichting in de beheer-repo: tijdens het project door Stage Two, na de overdracht door de
owner van je organisatie, of op verzoek door Stage Two.

**Geen opslag bij Cloudflare.** Gegevens staan in Supabase. `wrangler.jsonc` mag alleen
sleutels bevatten die op de lijst van `scripts/lib/cloudflare-config.mjs` staan, bovenaan
en binnen elke `env.*`. D1, R2, KV, Durable Objects, eigen Worker-code (`main`) en elke
onbekende sleutel houdt de check `guard:cloudflare` tegen, zodat zo'n PR niet kan mergen.

**Installeerbaar als app, niet offline.** Elke app is via "Zet op beginscherm" (iPhone) of
"Installeren" (Android, Chrome, Edge) als app te zetten: met een eigen icoon en zonder
adresbalk. Daarvoor zijn er drie onderdelen, allemaal van het project: het manifest
`public/manifest.webmanifest` (naam, kleur, icoontjes), de icoontjes in `public/` en een
paar regels in `index.html`. Het eigen logo van de klant vervangt de icoontjes van Stage
Two (192 en 512 pixels, en 180 voor de iPhone, met het logo binnen het middelste
tachtig procent, want Android snijdt de randen af).

Twee dingen zijn bewust zo:

- Het manifest wordt opgehaald met `crossorigin="use-credentials"`. Zonder die regel
  vraagt de browser het op zonder het inlogkoekje, houdt Access het tegen en is de app
  niet te installeren. Lokaal merk je dat niet; `tests/unit/installeerbaar.test.ts`
  bewaakt het.
- Er is geen service worker (de code die een app offline laat werken). Die bewaart oude
  versies op het toestel, waardoor een gebruiker na een update nog de oude app of oude
  gegevens kan zien. Installeren werkt zonder. Komen er ooit pushmeldingen, dan komt er
  alleen daarvoor een kleine service worker bij, die niets bewaart.

Een geïnstalleerde app op de iPhone heeft een eigen opslag, los van Safari: daar log je
één keer apart in bij Access, en daarna weer zodra de sessie van Access verloopt.

Een app van vóór versie 31 krijgt dit niet vanzelf met `/stagetwo-tier2:updaten`, omdat
`index.html` en `public/` van het project zijn. Neem dan de drie onderdelen en de test
over uit de template, als een gewone wijziging via `/stagetwo-tier2:verder-werken`.

---

## 3. Databasewijzigingen lopen via GitHub

### Eerst: hoe komt deze app aan haar gegevens?

In `stack.config.json` staat `database`, met drie standen. In een nieuw project zet het
opzetscript hem op `false`.

| Stand | Wanneer | Wat er meedoet |
|---|---|---|
| `false` | de app heeft geen blijvende gegevens | niets uit dit hoofdstuk |
| `"gedeeld"` | de gegevens bestaan al, in de database van een andere app | alleen lezen en schrijven via het contract |
| `true` | de app bezit haar eigen gegevens | migraties, RLS, typegeneratie, deploy |

**De middelste stand is de belangrijkste, en de minst bekende.** Een tweede app op
bestaande gegevens krijgt géén eigen database. Ze praat met de database van de app die
die gegevens bezit, en uitsluitend via het schema `api`: het contract. Views om te lezen,
functies om te schrijven. De onderliggende tabellen bestaan voor haar niet.

Dat is geen zuinigheid maar een harde technische grens: **precies één repo mag naar een
database schrijven.** Supabase houdt in de database zelf bij welke migraties gedraaid zijn.
Pushen twee repo's naar hetzelfde project, dan kent de tweede de bestanden van de eerste
niet, loopt de migratiehistorie uit de pas en faalt elke volgende deploy. `guard:migrations`
blokkeert daarom elke migratie in een app die de database niet bezit.

Bij `"gedeeld"` hoort een blok met de eigenaar erbij:

```json
{
  "database": "gedeeld",
  "gedeelde_database": {
    "eigenaar": "Klant-Org/erp",
    "project_ref": "abcdefghijklmnopqrst"
  }
}
```

Die project-ref is geen geheim: hij staat in de URL van elk verzoek. De typegeneratie haalt
het contract uit dat project op (`pnpm db:types`, met een `SUPABASE_ACCESS_TOKEN`), zodat
je in deze app gewoon typecontrole houdt op andermans schema.

Mis je iets in het contract, dan is dat een wijziging aan het contract: een aanvraag bij de
eigenaar van die database, geen migratie hier.

In de code is de koppeling één omgevingsvariabele: `VITE_SUPABASE_SCHEMA=api` (in
`.env.local` en in de GitHub-omgevingen van de uitrol). `src/lib/supabase.ts` leest die en praat dan met het schema
`api` in plaats van `public`; `pnpm env:local` doet bij deze stand niets, want er draait
geen lokale database. De waarden van de eigenaar zet je één keer met de hand in `.env.local`.

(In de template zelf staat hij bewust op `true`: die repo moet zijn eigen databaselaag
blijven testen, anders verrot het onderdeel dat jij straks aanzet.)

Dat is geen zuinigheid om de zuinigheid. Cloudflare rekent voor het uitserveren van
statische bestanden vrijwel niets, ongeacht het aantal apps, maar Supabase rekent per project: het plan per organisatie plus
compute per project. Twintig apps met elk een eigen database is dus een veelvoud van
twintig apps zonder. Een database die je niet nodig hebt, is de duurste regel code
die je nooit hebt geschreven.

**Zet `database` op `true` zodra één van deze waar is:**

- er zijn **gebruikersaccounts**, of gegevens die per gebruiker afgeschermd moeten worden
- gegevens hebben **relaties** die je wilt kunnen bevragen: bestellingen bij klanten,
  taken bij projecten
- **meerdere mensen** wijzigen dezelfde gegevens en mogen elkaar niet overschrijven
- je wilt **zoeken, filteren of sorteren** over meer dan een handvol records
- er is een **transactie**: twee dingen die samen moeten slagen of samen moeten falen,
  zoals een betaling en een voorraadmutatie

**Blijf op `false` als het hierbij blijft:**

- inhoud die in de repo kan staan: teksten, een portfolio, een productenlijst die jij beheert
- **bestanden** zonder onderlinge relaties: foto's, audio, uploads. Die horen in Supabase Storage,
  en dat vraagt dus wel een database
- een beetje **staat** die af en toe wordt bijgewerkt: een wachtrij, een cache, een teller.
  Daarvoor volstaat een app op tier 1
- **terugkerende taken**: die draaien met `pg_cron` in Supabase, dus ook die vragen een database

Merk je dat je in losse bestanden een database aan het namaken bent, met verwijzingen tussen bestanden
of met zoeken over inhoud, dan is dat het signaal om om te schakelen. Niet doormodderen.

**Omschakelen is één regel.** Alles wat erbij hoort staat al in de repo: de migratiemap, de
RLS-guards, de typegeneratie en de deploy-workflow. Zet `database` op `true`, maak het
Supabase-project aan, zet de drie secrets, en de hele laag hieronder wordt wakker. Andersom
kan ook, maar bedenk dat gegevens die er al in staan dan niet vanzelf meeverhuizen.

**Bij het beginnen met `/stagetwo-tier2:nieuwe-app` krijgt elke app een eigen database.** Een app
zonder database (een site, een rekenhulp) start je op tier 1; de afweging hierboven helpt vooral bij
de keuze tussen tier 1 en tier 2. De regel erachter is
één app per verzameling gegevens: gaat het over gegevens die al in een app zitten, dan
bouw je het in die app. De stand "gedeeld" (een aparte app op de database van een andere
app, bijvoorbeeld een portaal voor mensen van buiten) is een keuze van Stage Two, omdat
die een eigen beveiligingsopzet vraagt.

### De testdatabase: preview en lokaal kijken raken nooit productie

Een app met een database krijgt er bij het opzetten standaard een tweede Supabase-project
naast: de **testdatabase**. Zelfde schema, los van productie. De gegevens zijn een kopie
van productie: de workflow **Testdatabase verversen** in de beheer-repo zet ze er elke
nacht opnieuw in (alleen het schema `public`, geen gebruikers of bestanden). Wat je in
een preview invoert, is de volgende ochtend dus weer weg. Alleen voor apps die echt met Supabase praten; een app zonder database
heeft er niets aan, en een app op een gedeelde database gebruikt de testdatabase van de
eigenaar.

Wat erop draait:

- **De Cloudflare-preview van elke pull request.** Klikken, opslaan, verwijderen in een preview
  raakt nooit echte gegevens. De preview krijgt uit de repo-variabelen `PREVIEW_VITE_*` de URL en de anon key van
  het testproject, en `VITE_OMGEVING=test`; de app laat dan een balk zien dat dit de
  testomgeving is. Productie op `main` krijgt het productieproject en geen balk.
- **Lokaal kijken op je eigen computer**, zonder Docker: de preview in de Claude-app
  zet `.env.local` zelf op de testdatabase (`pnpm env:test` doet hetzelfde met de hand;
  route `docs/routes/lokaal-kijken.md`). Met de publieke sleutel in
  `stack.config.json` (`testdatabase.anon_key`) is daar geen login bij Supabase voor nodig.
  Inloggen gaat daar als testgebruiker, zie hieronder.
- **Migraties, als eerste.** Bij een merge past Actions de migraties eerst toe op de
  testdatabase (de canary) en pas daarna op productie. Faalt het op de testdatabase, dan
  blijft productie zoals hij was.

In `stack.config.json` staat welk project het is; het databasewachtwoord ervan is het
Actions-secret `SUPABASE_TEST_DB_PASSWORD`:

```json
{
  "database": true,
  "testdatabase": { "project_ref": "abcdefghijklmnopqrst" }
}
```

Ontbreekt het blok, dan is er geen testdatabase: de preview gebruikt wat er in de repo-variabelen `PREVIEW_VITE_*`
staat ingesteld en migraties gaan rechtstreeks naar productie. Dat is toegestaan, maar het
is de uitzondering en niet de standaard. Wat de testdatabase kost: een tweede project bij
Supabase, dat je kunt pauzeren als er een tijd niet gebouwd wordt.

### Lokaal kijken met echte gegevens, als testgebruiker

Gewoon inloggen loopt via Cloudflare, en daar komt een assistent niet langs. Daarom heeft
elke testdatabase een vaste **testgebruiker**, `testgebruiker@stagetwo.nl`, die met e-mail
en wachtwoord inlogt. Zo kan de assistent op je eigen computer de app openen, inloggen en
rondklikken met de gegevens uit de testdatabase, en zelf zien of zijn werk klopt.

- **Het wachtwoord** maakt de beheer-repo elke nacht opnieuw (Testdatabase verversen) en zet
  het daar een paar dagen klaar. `pnpm testlogin` haalt het op met `gh`, waarmee je al bent
  ingelogd, en zet het in `.env.development.local` (net als `.env.local` nooit in git).
  De preview in de Claude-app doet dat bij elke start,
  `pnpm env:test` ook. Wie bij de beheer-repo mag, kan het ophalen; wie uit de organisatie
  vertrekt, kan er hoogstens een dag mee verder.
- **In de app** staat dan op het inlogscherm een knop "Inloggen als testgebruiker". Die
  knop bestaat alleen in de versie op je eigen computer; in een preview of in productie
  staat hij er nooit, en het wachtwoord komt nooit in de gebouwde app. Een app van vóór
  versie 34 heeft die knop nog niet (het inlogscherm is van het project); daar staat lokaal
  het gewone formulier met e-mail en wachtwoord, en vul je het adres en wachtwoord uit
  `.env.development.local` in.
- **Een rol.** Werkt de app met rollen, dan krijgt de testgebruiker dezelfde rol als de
  bouwer, uit het bestand `supabase/testrol.sql` in deze repo. Testdatabase verversen voert
  het elke nacht uit, meteen na het aanmaken of vernieuwen van de testgebruiker. Claude
  schrijft het één keer, met de rol van de bouwer die het in de migraties vindt; een app
  zonder rollen heeft het niet nodig. Uitleg en een voorbeeld: `docs/routes/lokaal-kijken.md`.
  Een app die gegevens per persoon afschermt, laat de testgebruiker alleen zijn eigen
  testgegevens zien, en dat is goed.
- **Andere testaccounts** (bijvoorbeeld voor een tweede rol) zet je in `toegang.json` in de
  beheer-repo, onder `testaccounts`. Die gelden alleen in de testdatabase en nooit in
  productie, en Toegang bijwerken laat ze daar staan.

In de testdatabase staat inloggen met e-mail daarvoor aan, maar alleen voor de
testaccounts. Wie via Cloudflare binnenkomt, moet net als in productie in `toegang.json`
staan. Een zelfgekozen wachtwoord op het adres van een collega werkt dus niet.

### Een kopie van echte gegevens op je computer

De testdatabase is een kopie van productie. Wie lokaal met de testlogin werkt, heeft op zijn
computer dus toegang tot echte gegevens: het wachtwoord staat in `.env.development.local`.
Daarom:

- **Schijfversleuteling hoort aan te staan** op elke computer waarop gebouwd wordt:
  FileVault op een Mac, BitLocker (of Apparaatversleuteling) op Windows. Raakt de laptop
  kwijt, dan is er zonder je login niets te lezen.
- `.env.local` en `.env.development.local` staan nooit in git en gaan nooit in een chat of
  mail.
- Gaat er iemand weg: haal hem uit de GitHub-organisatie. Het wachtwoord van de testgebruiker
  is de volgende nacht al vernieuwd.

### Testmail: in test en lokaal gaat geen mail naar echte mensen

Met een kopie van echte gegevens kan een mail uit een preview of van je eigen computer bij
een echte klant belanden. Daarom stuurt de app buiten productie elke mail naar één
**testadres**, wie er ook als ontvanger staat, en krijgt het onderwerp `[test]` ervoor.
Het adres staat in `stack.config.json` als `testmail`. Het hoort bij de app, niet bij de
bouwer: de preview wordt gedeeld. Het is geen geheim. Staat er geen adres, dan gaat er
buiten productie helemaal geen mail weg.

Een Edge Function die mail verstuurt, gebruikt daarvoor altijd `richtMail` uit
`supabase/functions/_shared/mail.ts`. Functies uitrollen in de beheer-repo vertelt de
testdatabase dat het een testomgeving is en wat het testadres is.

### Zelf kijken op het vaste adres

Elke app heeft naast de preview per pull request een vast adres: `actueel-...`. Daar staat
altijd de laatst gepushte versie, achter dezelfde login als productie. Log daar gerust zelf
in en kijk mee, ook op een tablet. Je hoeft na een wijziging alleen te verversen.

Tip: op het vaste adres praat de app met de testdatabase. De eerste keer dat je daar
inlogt, krijg je in de testdatabase een eigen account, los van je account in productie. Laat
iemand dat account één keer een rol geven, net als in productie. Die rol blijft daarna
staan.

### Als er wel een database is

Het doel: je kunt het databaseschema wijzigen **zonder toegang tot de
Supabase-console**. Dat werkt via migraties plus een deploy-stap.

1. De wijziging wordt een SQL-bestand in `supabase/migrations/`.
2. Pull request openen. De CI draait: types opnieuw genereren, typecontrole, tests,
   RLS-check, destructie-check.
3. Mergen naar `main`.
4. Actions past de migratie toe: eerst op de testdatabase (als die er is), dan op productie.
5. GitHub Actions zet de nieuwe versie op Cloudflare neer.

Regels die hierbij horen en niet vrijblijvend zijn:

- **Migraties draaien alleen bij een merge naar `main`**, nooit op een pull request.
- **Back-ups staan aan** voordat deze route in gebruik wordt genomen. Dit is het enige
  onderdeel dat gegevens onherstelbaar kan vernietigen.
- **Nooit handmatig in de Supabase-console wijzigen.** Dan loopt de repo uit de pas
  met de werkelijkheid en is de historie waardeloos.
- **De gegenereerde types worden gecommit** en in de CI gecontroleerd, zodat code
  nooit stilletjes uit de pas loopt met de database.

---

### Edge Functions en apparaten

Een Edge Function is een klein stukje code dat bij Supabase draait, voor alles met een
geheime sleutel of voor machines die bij de gegevens moeten. De code staat in
`supabase/functions/` en gaat, net als de rest, via een pull request. Live zetten doet de
beheer-repo: na de merge start je daar **Functies uitrollen**. Die zet de functies van `main`
eerst op de testdatabase en dan op productie. Zo blijft de Supabase-sleutel in de beheer-repo,
en hoeft de bouwer nooit bij Supabase in te loggen.

**Machines** (een server, een Pi, een script dat elke nacht iets ophaalt) loggen niet in als
mens. Ze krijgen een eigen apparaatsleutel:

| Wat | Hoe |
|---|---|
| Een apparaat toevoegen | `pnpm apparaat:nieuw <naam>`; de sleutel verschijnt één keer, zet hem op het apparaat |
| Wat er in de repo komt | alleen de vingerafdruk, in `supabase/functions/_shared/apparaten.json`; die mag openbaar zijn |
| Intrekken | `pnpm apparaat:nieuw -- --intrekken <naam>`, pull request, merge, functies uitrollen |
| In de functie | `welkApparaat(request, ["<naam>"])` uit `_shared/apparaat.ts` met alleen de apparaten van die functie, en `verify_jwt = false` in `supabase/config.toml` |

Een apparaatsleutel geeft alleen toegang tot wat die ene functie doet. Laat de functie dus
precies doen wat het apparaat nodig heeft, en niet meer.

**Een functie proberen vóór de merge.** Normaal gaat een functie pas na de merge naar de
testdatabase. Wil je hem eerder proberen, dan kan Functies uitrollen ook vanaf een tak
draaien (`-f tak=<tak>`). Dat zet de functies van die tak alleen op de testdatabase, nooit op
productie. Let op: alle previews en iedereen die lokaal kijkt, delen die testdatabase, en
zien zolang die proefversie. Na de merge zet de gewone run alles weer gelijk met `main`.

Heeft een app veel eigen serverlogica (veel koppelingen, berekeningen of webhooks), kies dan
bij het begin liever tier 1. Daar draait de servercode lokaal mee, en hoef je niet via de
testdatabase te proberen.

**Sleutels van andere systemen** (Stripe, Moneybird, een AI-dienst) staan als geheim bij
Supabase. Die zet de owner van de organisatie: een nieuw extern systeem aansluiten is een
architectuurbesluit. Na de overdracht doet je organisatie dat zelf, bijvoorbeeld vanaf een
beheerserver (optioneel): een server waar Claude Code bij Supabase is ingelogd.

## 4. De kwaliteitspoort

Draait op elke pull request; alles groen voordat er gemerged kan worden. Wat elke
check bewaakt staat in de tabel in `README.md`.

**Concept eerst, de volle poort bij klaar.** Een pull request begint als concept (draft).
Dan draait bij elke push alleen de snelle check `Code` (een paar minuten) en wordt de preview
bijgewerkt. De zware check `Database en end-to-end` draait pas als de PR op klaar wordt gezet
(`gh pr ready`). Mergen kan alleen met de volle poort groen: een concept kan niet mergen, en
op klaar zetten start alles opnieuw. Zo wacht niemand per tussenstap op een browsertest, en
kost bouwen veel minder Actions-minuten.

**Het vaste preview-adres.** Naast de preview per pull request (`pr-<nummer>-...`) heeft
elke app één vast adres, `actueel-...`, dat altijd de laatst gepushte PR toont. Dat kan de
gebruiker open laten staan en verversen. Staan er twee PR's tegelijk open, dan toont het
vaste adres de laatste push; de PR-adressen blijven ieder hun eigen versie tonen.

Twee dingen om te begrijpen over waaróm dit zo streng staat:

**De tests zijn de reviewer.** Er is bewust geen verplichte goedkeuring van een mens
op gewone wijzigingen, zodat je je eigen werk kunt mergen zodra het groen is. De
keerzijde is dat wat de tests niet dekken, door niemand gedekt wordt. Daarom is
"schrijf de test erbij" hier geen nette gewoonte maar de kern van de afspraak.

**Een rode check zet je niet uit.** De verleiding is groot, zeker als je haast hebt en
de check "iets onbelangrijks" lijkt te vinden. Maar de check is er juist voor het
moment dat je haast hebt.

### Wat "de happy path" is

De route door de app waarop niets misgaat: inloggen → lijst openen → item toevoegen →
het staat er. Niet de randgevallen. Breekt die route, dan is de app waardeloos, dus
dat is de test die het meest telt. Hij raakt in één keer de hele keten: build,
inloggen, database, RLS en de interface.

Uitbreiden doe je **reactief**: elke keer dat er in productie iets stukgaat, komt er
een test bij die precies dat geval afdekt. Zo groeit het vangnet mee met je echte
fouten in plaats van met bedachte scenario's.

---

## 5. Git- en werkafspraken

1. **`main` is heilig.** Alles via een pull request, ook voor de bouwer.
2. **Eén PR = één onderwerp.** Grote PR's zijn niet te beoordelen en een agent
   verdwaalt erin.
3. **Lees altijd de diff voordat je merget.** Zonder de taal te kennen let je op:
   - zijn dit de bestanden die ik verwachtte?
   - hoeveel regels? ("kleine fix" met 300 regels is een rode vlag)
   - is er iets **verwijderd** waar niemand om gevraagd heeft?
   - staan er nieuwe pakketten in `package.json`?
   - raakt het aan inloggen, betalingen, omgevingsvariabelen of migraties?
   - staat er een sleutel of wachtwoord hardgecodeerd in?
4. **Klik de Cloudflare-preview aan.** Kijken gaat boven hopen. Een preview-URL van de PR
   is de enige geldige manier om werk te laten zien, nooit een dev-server op localhost. De
   assistent opent hem zelf in de browser in de zijbalk van de Claude-app; de eerste keer
   logt de gebruiker daar één keer in bij Cloudflare Access.
5. **Deployen = mergen.** Nooit met de hand op een server of in een console ingrijpen.
6. **Conventional Commits** (`feat:`, `fix:`, `chore:`).
7. **Bug gefixt? Schrijf er een test bij.** Zo groeit het vangnet mee.
8. **Scope per taak, niet per uur.** Een agent die twee uur ongestoord doorbouwt,
   levert een diff op die niet meer te beoordelen is. Dan is het vertrouwen in plaats
   van controle.

---

## 6. Wie mag wat

|  | Bouwer (iemand van de klant) | Owner (eigenaar van de organisatie bij de klant) |
|---|---|---|
| GitHub-repo | **Write** | Admin |
| Direct pushen naar `main` | **nee** | nee, geblokkeerd |
| Branch aanmaken en PR openen | **ja** | ja |
| Eigen PR mergen | **ja**, zodra alle checks groen zijn | ja, zodra alle checks groen zijn |
| Mensen toegang geven | **ja**, met een PR op `toegang.json` in de beheer-repo | ja |
| Een sleutel van een ander systeem zetten | nee | ja, zie hoofdstuk 3 |
| Supabase-console | niet nodig, zie hoofdstuk 3 | ja, voor het account en de rekening |
| Cloudflare-console | niet nodig, deployen is mergen en toegang staat in de beheer-repo | ja, voor het account en de rekening |
| Sentry | ja, meelezen | ja |

**De merge-knop is de enige knop die je nodig hebt.** Je kunt met je eigen
AI-assistent bouwen, een pull request openen en die zelf mergen, maar alleen langs de
route waar de tests over gaan.

**Er is geen enkele wijziging waarvoor je op goedkeuring van Stage Two moet wachten.**
Dat is een bewuste keuze en geen vergeetachtigheid: als je voor elke wijziging op ons
zou moeten wachten, kun je niet zonder ons verder, en dat is precies wat deze werkwijze
belooft. Een verplichte review is niet overdraagbaar.

Wat er dan wel voor zorgt dat het goed gaat: de checks blokkeren de merge als er iets
stuk is, een destructieve migratie vraagt een expliciete bevestiging in de PR-tekst, een
wijziging aan de poort zelf ook, en wie in `.github/CODEOWNERS` staat krijgt een melding
bij een wijziging aan de database, aan het inloggen of aan de poort zelf (dat blokkeert
niets maar informeert wel). Dat is de bouwer die de app heeft aangemaakt:
`/stagetwo-tier2:nieuwe-app` zet hem erin. Stage Two staat er niet in.

**Wie doet wat.** Je bouwt zelf: de bouwers zijn mensen van je eigen organisatie, met hun
eigen AI-assistent. Alle accounts (GitHub, Cloudflare, Supabase, Sentry) staan vanaf het begin op naam van je
organisatie en zijn van jou. In de projectfase richt Stage Two die accounts in en beheert
ze namens je, en begeleidt de bouwers. Bij de overdracht hoeft er dus niets te verhuizen:
je organisatie is en blijft eigenaar, en is vanaf dan zelf verantwoordelijk voor de
accounts en de rekeningen. Oplevering en overdracht zijn hetzelfde moment: het einde van
het project. Dan haalt Stage Two zijn eigen toegang weg: Stage Two houdt geen persoonlijk
account en geen beheerrechten in je organisatie, tenzij je organisatie dat wil; die toegang kan
je organisatie altijd zelf intrekken. Toegang tot je apps heeft Stage Two niet nodig.
Je apps veranderen nooit vanzelf; de plugin wel: dat is software van Stage Two die met de
rechten van de bouwer op zijn computer draait en zichzelf bijwerkt. Dat bijwerken kan uit
(vraag je assistent erom), en dan werk je de plugin zelf bij met `/stagetwo-tier2:updaten`.
Zolang het abonnement loopt, zet Stage Two nieuwe versies van deze werkwijze in de kopie in je
eigen GitHub, via de GitHub App `stagetwo-levering`. Stage Two installeert die bij de start
namens je organisatie, op alleen de twee kopieën van template en plugin ("Only select
repositories"); je organisatie kan hem altijd zelf verwijderen. Hij heeft alleen daar
schrijfrecht, niet op je apps. De plugin
op je computer werkt zichzelf bij uit die kopie. Je apps veranderen alleen via een
update-voorstel dat de plugin met `/stagetwo-tier2:updaten` klaarzet en dat een bouwer
goedkeurt. Een nieuwe versie van de beheer-repo zet Stage Two op verzoek klaar, met tijdelijke
toegang die de owner van je organisatie geeft en daarna weer intrekt. Bij opzeggen haalt
Stage Two je organisatie uit de lijst van abonnees en de App `stagetwo-levering` uit je
organisatie. Wil je na de overdracht de inrichting zelf aanpassen, dan kan dat met een beheerserver
(optioneel): een server van je organisatie met Claude Code, die Stage Two bij de overdracht
kan achterlaten.

---

## 7. Hoe de afspraken worden afgedwongen

Een afspraak die een agent moet ónthouden, breekt uiteindelijk. Een afspraak die de
tooling afdwingt, niet. Vandaar drie lagen, oplopend in sterkte:

1. **`AGENTS.md`** geeft richting. Dat is het bestand dat vrijwel elke AI-assistent
   automatisch leest aan het begin van een sessie in deze map (Claude Code via
   `CLAUDE.md`, dat niets anders doet dan `AGENTS.md` importeren). Bovenaan staat de
   "klaar is"-definitie, want daar stuurt een model het sterkst op. De vaste routes
   staan uitgeschreven in `docs/routes/`, als gewone tekst, zodat ook een assistent
   zonder skills, of een mens, ze kan volgen.
2. **De repo zelf** dwingt af, voor iedereen. `pnpm dev` weigert, tenzij je er
   expliciet `STACK_ALLOW_DEV=1` voor zet om voor jezelf te kijken (de route
   `docs/routes/lokaal-kijken.md`); in de Claude-app loopt dat via de preview
   (`.claude/launch.json`). Zo is lokaal kijken een bewuste keuze en nooit stilletjes
   de oplevering. Een PR die aan de poort of de afspraken komt, laat de
   check `guard:template` rood staan. Voor Claude
   Code komt daar de Stage Two-plugin bij (`.claude/settings.json` kondigt hem aan,
   Claude Code biedt de installatie zelf aan): een hook die een tool-aanroep
   onderschept vóór hij wordt uitgevoerd en hem blokkeert met uitleg terug aan de
   agent, `/stagetwo-tier2:verder-werken` als aansluiting op de routes, en `/stagetwo-tier2:updaten` om
   een nieuwere template op te halen. Dat is dezelfde afspraak, alleen eerder merkbaar: bij de toetsaanslag in
   plaats van bij de check. Een aansluiting voor een agent mag nooit een afspraak
   bevatten die niet in `AGENTS.md` staat; zo betekent "klaar" voor elke agent
   hetzelfde. Zonder de plugin blijft de check de grens: minder snel, even hard.
3. **CI en branch protection** is de bodem. Ook als een agent élke afspraak negeert,
   komt er niets in `main` zonder groene checks.

De eerste twee lagen bepalen hoe vaak je tegen die bodem aan loopt. De derde bepaalt
wat er gebeurt als het toch misgaat.

---

## 8. Woordenlijst

De namen zitten op verschillende verdiepingen; het zijn geen concurrenten van elkaar.

| Term | Wat het is |
|---|---|
| **TypeScript** | de taal: JavaScript met labels erbij ("dit veld is een datum") zodat fouten opvallen vóór het live gaat |
| **React** | het systeem van herbruikbare bouwblokken waarmee je de interface samenstelt. Geen taal |
| **Vite** | het bouwgereedschap: maakt van je bronbestanden iets dat een browser kan laden |
| **Cloudflare** | het platform waar het eindresultaat gehost wordt, en de deur ervoor: wie niet mag inloggen ziet de app niet |
| **Supabase** | database (Postgres) + inloggen + bestandsopslag als dienst |
| **RLS** | regels in de database die per gebruiker bepalen welke rijen hij mag zien. In een browser-app is dit je hele beveiliging |
| **Edge Function** | klein stukje code dat bij Supabase op een server draait, voor dingen met een geheime sleutel |
| **Deno** | de omgeving waarin Edge Functions draaien. Geldt voor iedereen die Supabase gebruikt, niet projectspecifiek |
| **Migratie** | een genummerd SQL-bestand dat één databasewijziging vastlegt, zodat de historie navolgbaar is |
| **Beheerserver** | optioneel: een server van je organisatie met Claude Code, waarmee je na de overdracht zelf de inrichting aanpast |
| **PR (pull request)** | het voorstel om wijzigingen naar `main` te brengen. De plek waar diff, checks en preview samenkomen |
| **Diff** | het verschil tussen oud en nieuw: precies wat er gewijzigd is |
| **CI** | de machine die bij elke PR je checks draait en nee kan zeggen |
| **Ruleset / branch protection** | de GitHub-instelling die bepaalt wie wat mag met `main` |
| **AGENTS.md** | het bestand met de afspraken dat AI-assistenten automatisch lezen. Een afspraak tussen tools, niet van één leverancier |
| **Hook** | een regel die een tool-aanroep van de agent onderschept en kan blokkeren. Afdwingen in plaats van vragen. In deze stack alleen voor Claude Code; de afspraak zelf staat in `AGENTS.md` en de check |
| **Happy path** | de route door de app waarop niets misgaat: de normale, geslaagde gang van zaken |
| **Testgebruiker** | `testgebruiker@stagetwo.nl`: het vaste account in de testdatabase waarmee de assistent (en jij) lokaal inlogt, zonder Cloudflare. `pnpm testlogin` haalt het wachtwoord op |
| **Testmail** | het ene adres (`testmail` in `stack.config.json`) waar alle mail uit test en lokaal naartoe gaat |
