# Lokaal kijken: de app op je eigen computer zien terwijl je bouwt

Deze route is voor één ding: tijdens het bouwen **zelf** zien wat je gemaakt hebt,
zonder eerst een pull request te openen en op de preview te wachten. Je assistent
past een bestand aan, en de browser op je eigen computer ververst meteen.

Wat het niet is: het resultaat. Een adres dat met `localhost` begint werkt alleen op
de computer waar het draait, en het bewijst niet dat de gebouwde versie werkt. Werk
laten zien, laten beoordelen en live zetten gaat altijd via de route
`docs/routes/verder-werken.md` en de Cloudflare-preview van de pull request. Deze route
verandert daar niets aan; hij komt ervóór.

## In de Claude-app: dit gaat vanzelf

Werk je in het tabblad Code van de Claude-app, dan hoef je deze route niet te volgen.
De app start de preview zelf, volgens `.claude/launch.json`: dat draait
`scripts/preview.mjs`, en dat regelt de pakketten, zet `.env.local` op de testdatabase
(zie hieronder), haalt de testlogin op en start de app. Je ziet hem in het venster naast
het gesprek, en de assistent kijkt daar zelf ook mee om zijn werk te controleren: hij logt
in als testgebruiker en klikt rond met de gegevens uit de testdatabase. De preview weigert te
starten als `.env.local` naar een andere database wijst dan de testdatabase of een
lokale Supabase.

De rest van deze route is voor andere assistenten (Codex, Cursor, …) en voor wie het met
de hand doet.

## Wat je nodig hebt

Eenmalig op de computer waar je werkt. Je assistent kan dit voor je controleren en
installeren; vraag hem "controleer of ik lokaal kan kijken".

| Wat | Waarvoor | Hoe je ziet of het er is |
|---|---|---|
| **git** | de code ophalen en je wijzigingen bijhouden | `git --version` |
| **Node** (versie 22 of nieuwer) | de app bouwen en draaien | `node --version` |
| **pnpm** | de pakketten van de app beheren | `pnpm --version`, anders `npm install -g pnpm` |
| **je AI-assistent** (Claude Code, Codex, Cursor, …) | de wijzigingen maken | die heb je al als je dit leest |

Daarna de code op je computer zetten en de pakketten ophalen:

```bash
git clone <adres van deze repo>
cd <map>
pnpm install
```

Lukt dit niet binnen tien minuten, vraag het dan aan Stage Two in plaats van door te
worstelen. Dit is inrichting, geen bouwen.

## Welke database

De app heeft gegevens nodig om iets te laten zien. Kijk eerst in `stack.config.json`
naar `database`:

- **`false`**: geen database. Sla dit hoofdstuk over en ga naar "Starten".
- **`true`** of **`"gedeeld"`**: de app op je computer gebruikt de testdatabase van deze
  app, zie hieronder. Docker is niet nodig.

### De testdatabase van deze app

Dezelfde database als waar de Cloudflare-preview naar wijst: een apart Supabase-project, los
van productie. De gegevens erin zijn een kopie van productie, elke nacht ververst. Zo zie je
hoe een scherm eruitziet met echte gegevens, zonder dat je productie kunt raken.

Welk project dat is, staat in `stack.config.json` onder `testdatabase`. Staat dat blok
er niet, dan heeft deze app geen testdatabase: vraag Stage Two.

```bash
pnpm env:test      # schrijft .env.local met de testdatabase erin
```

Staat de publieke sleutel van de testdatabase in `stack.config.json`
(`testdatabase.anon_key`), dan is dat alles. Staat hij er niet, dan vraagt dit de eerste
keer om een login bij Supabase op deze computer (`pnpm exec supabase login`, opent de
browser); vraag Stage Two liever de sleutel in de config te zetten, want een
werkcomputer hoort geen toegang tot Supabase te hebben. Lukt het niet, dan zegt het script
precies wat je met de hand in `.env.local` zet: de URL van het testproject, de publieke
anon-sleutel (Supabase dashboard > Project Settings > API keys > anon / public) en het
schema (`public`, of `api` als deze app op `"gedeeld"` staat).

`.env.local` staat in `.gitignore` en blijft op je computer. Commit hem nooit. Staat er
al een `.env.local`, dan overschrijft het script die alleen met `--overschrijf`.

De anon-sleutel is expres publiek en wordt door RLS beschermd; de service-role-sleutel
van welk project dan ook hoort hier nooit in.

### Inloggen als testgebruiker

Gewoon inloggen loopt via Cloudflare, en dat werkt op je eigen computer niet. Daarom heeft
de testdatabase een vaste testgebruiker, `testgebruiker@stagetwo.nl`. Het wachtwoord wordt
elke nacht vernieuwd en staat klaar in de beheer-repo van je organisatie.

```bash
pnpm testlogin     # haalt het wachtwoord op met gh en zet het in .env.development.local
```

`pnpm env:test` en de preview in de Claude-app doen dit zelf. Het komt in
`.env.development.local`, samen met `VITE_INLOGDIENST=wachtwoord`. Dat bestand staat net als
`.env.local` in `.gitignore`, alleen jij kunt het lezen, en Vite gebruikt het alleen als de
app op je eigen computer draait, nooit bij het bouwen. `.env.local` zelf blijft zoals hij
was.

Op het inlogscherm staat daarna een knop **Inloggen als testgebruiker**. Die knop is er
alleen op je eigen computer; in een preview of in productie nooit. Een app van vóór versie
34 heeft die knop nog niet. Daar staat lokaal het gewone formulier met e-mail en
wachtwoord: vul daar het adres (`VITE_TESTLOGIN_EMAIL`) en het wachtwoord
(`VITE_TESTLOGIN_WACHTWOORD`) uit `.env.development.local` in.

Lukt het niet, dan zegt het script waarom. De gewone oorzaken:

| Melding | Wat je doet |
|---|---|
| geen beheer-repo gevonden | je hebt geen toegang tot de beheer-repo; vraag de owner van je organisatie. Heet hij anders, zet dan `STAGETWO_BEHEER_REPO=<naam>` |
| geen geldige `testlogin-<app>` | Testdatabase verversen heeft nog niet gedraaid voor deze app; start die workflow in de beheer-repo, of vraag Stage Two |
| inloggen als testgebruiker lukt niet | het wachtwoord is die nacht vernieuwd; draai `pnpm testlogin` opnieuw |
| je ziet geen gegevens | de app heeft rollen en de testgebruiker nog geen; zie hieronder, `supabase/testrol.sql` |

### De rol van de testgebruiker: `supabase/testrol.sql`

Werkt de app met rollen (beheerder, medewerker, klant), dan ziet de testgebruiker pas iets
als hij een rol heeft. Die rol komt uit één bestand in deze repo, `supabase/testrol.sql`. Het
geeft `testgebruiker@stagetwo.nl` dezelfde rol als de bouwer van de app, en verder niets.
Een app zonder rollen heeft dit bestand niet nodig; de template levert het ook niet mee.

Een voorbeeld, voor een app die rollen bijhoudt in een tabel `gebruikersrollen`:

```sql
-- De testgebruiker krijgt dezelfde rol als de bouwer van de app (hier: beheerder).
insert into public.gebruikersrollen (user_id, rol)
select id, 'beheerder' from auth.users where email = 'testgebruiker@stagetwo.nl'
on conflict (user_id) do nothing;
```

Testdatabase verversen in de beheer-repo voert het bestand elke nacht uit, op de
testdatabase, meteen nadat de testgebruiker is aangemaakt of vernieuwd. Het neemt de versie
van `main`, dus het werkt vanaf de eerste nacht na de merge (of eerder, als je die workflow
in de beheer-repo met de hand start). Schrijf het daarom zo dat het vaker mag draaien
(`on conflict do nothing`). Ontbreekt het bestand, dan slaat het verversen het over; zit er
een fout in, dan staat dat in het logboek van die run.

Claude schrijft dit bestand één keer, met de rol van de bouwer: het zoekt in
`supabase/migrations/` hoe de app rollen bijhoudt en welke rol de bouwer heeft, en vraagt
alleen bij twijfel. Daarna hoeft niemand de testgebruiker nog een rol te geven.

### Echte gegevens op je computer

Met de testlogin kun je bij een kopie van echte gegevens. Zorg daarom dat
schijfversleuteling aan staat (FileVault op een Mac, BitLocker op Windows), en zet
`.env.local` en `.env.development.local` nooit in git, een chat of een mail.

Mail uit de app gaat lokaal nooit naar echte mensen: alleen naar het testadres uit
`stack.config.json` (`testmail`), of nergens heen als dat leeg is.

## Starten

```bash
STACK_ALLOW_DEV=1 pnpm dev
```

De app draait nu op http://localhost:5173 en ververst vanzelf bij elke wijziging
die je assistent maakt. Stoppen: `Ctrl+C` in het venster waar hij draait.

Dat `STACK_ALLOW_DEV=1` ervoor is geen vergissing en geen omweg: zonder die variabele
weigert `pnpm dev`, en in Claude Code houdt de hook van de Stage Two-plugin het
commando tegen. Zo blijft
lokaal kijken een bewuste keuze van jou en wordt het nooit stilletjes de manier waarop
een assistent werk "oplevert".

## Voor de assistent

- In de Claude-app gebruik je de preview (`.claude/launch.json`), geen dev-server in
  Bash. De rest van deze lijst geldt voor andere assistenten.
- Zet de dev-server alleen op als de gebruiker daarom vraagt of als je hem hebt
  voorgesteld en de gebruiker ja zegt. Nooit uit jezelf als vervanging van de preview.
- Start hem op de achtergrond en laat hem draaien terwijl je bouwt; de gebruiker kijkt
  in de browser mee. Meld het adres één keer, niet bij elke wijziging.
- Een lokale dev-server is **nooit** het antwoord op "is het klaar?". Klaar is: PR open,
  checks groen, preview-link in de beschrijving (zie `docs/routes/verder-werken.md`,
  stap 8). Geef nooit een `localhost`-adres als opgeleverd resultaat.
- Kom je een `.env.local` tegen die naar productie wijst, stop dan en
  zeg het. Dat is een fout die je niet stil repareert.
- Controleer je eigen werk ingelogd als testgebruiker: de knop op het inlogscherm, of in een
  app zonder die knop het gewone formulier, met het adres en wachtwoord uit
  `.env.development.local`. Lees die waarden zelf uit het bestand en typ ze in het
  formulier; zet ze niet in het gesprek. Zie je niets en heeft de app rollen, kijk dan
  eerst naar `supabase/testrol.sql` (zie hierboven). Ontbreekt het, schrijf het dan in je
  pull request met de rol van de bouwer, en zeg de gebruiker dat de testgebruiker die rol
  krijgt na de merge en de eerstvolgende verversing. Verzin geen omweg langs het inloggen.
- Zet het wachtwoord van de testgebruiker nooit in een bestand dat in git komt, in een
  PR-tekst of in het gesprek, en verplaats het niet naar `.env.local`.
