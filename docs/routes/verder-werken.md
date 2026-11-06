# Verder werken aan deze app

Dit is de enige route waarlangs werk in deze app terechtkomt. Hij geldt voor iedereen,
ook voor een kleine tekstwijziging, want de route is precies wat het veilig maakt om
zonder programmeerkennis te bouwen.

## Stap 1: Weet wat je gaat maken

Vraag door tot je één zin kunt opschrijven die begint met "na deze wijziging kan de
gebruiker …". Lukt dat niet, dan is het verzoek nog niet scherp genoeg en is dit het
moment om het te vragen, niet halverwege.

**Lees bij de start stil het logboek mee.** In de architectuur-repo van het bedrijf staat
`docs/logboek.md`: per gemergde pull request wat er met de hand is ingesteld, welke besluiten
vielen en wat andere onderdelen raakte. Lees de laatste regels, als achtergrond bij je werk:

```bash
gh api repos/<org>/architectuur/contents/docs/logboek.md -H "Accept: application/vnd.github.raw" | tail -n 20
```

In Claude Code doet de skill verder-werken van de plugin dit al. Lees het niet voor en vat
het niet samen voor de gebruiker, tenzij hij erom vraagt of er iets in staat dat zijn vraag
direct raakt. Geen logboek of geen toegang: ga gewoon door.

Is het verzoek groter dan één zin? Knip het op. **Eén pull request = één onderwerp.**
Grote PR's zijn niet te beoordelen en er verdwijnt van alles ongemerkt in.

## Stap 2: Begin op een eigen branch

```bash
git checkout main
git pull
git checkout -b <korte-omschrijving>
```

Nooit rechtstreeks op `main` werken. Dat kan ook niet: de repo weigert het.

## Stap 3: Bouw de wijziging

Houd je aan de afspraken uit `AGENTS.md`. De belangrijkste, omdat ze het vaakst
misgaan:

- Geen `any`, geen `@ts-ignore`, geen uitroepteken om een typefout weg te drukken.
  Los de echte fout op.
- Alles wat van buiten komt, valideer je met Zod.
- Geheime sleutels horen nooit in de app. Alleen de Supabase anon key en de Sentry DSN
  mogen in een `VITE_`-variabele; die zijn expres publiek. Al het andere gaat naar een
  Edge Function.
- Nieuwe tabel? Dan RLS aan én policies én een RLS-test. Volg dan de route
  `docs/routes/databasewijziging.md`.

Raakt je wijziging de database (een tabel, kolom, index of policy)? Lees dan nu
`docs/routes/databasewijziging.md` in zijn geheel en volg die stappen erbij. Ook zo'n pull
request begint als concept: bij een wijziging in `supabase/` draaien de databasetests (zonder
browser) dan al bij elke push. In Claude
Code herinnert de plugin je eraan zodra je in `supabase/migrations/` schrijft.

**Kijk eerst lokaal, ingelogd als testgebruiker, met echte gegevens.** In de Claude-app start
de preview vanzelf (`.claude/launch.json`), tegen de testdatabase, en haalt hij de testlogin
op. Log in met de knop "Inloggen als testgebruiker" (heeft de app die knop nog niet, vul dan
in het gewone formulier het adres en wachtwoord uit `.env.development.local` in) en klik de
wijziging zelf na voordat je iets laat zien. Met een andere assistent: `docs/routes/lokaal-kijken.md`. Het is een
hulpmiddel tijdens het bouwen, niet de oplevering: die volgt hieronder. De Cloudflare-preview
van de pull request is het laatste nakijken, door de gebruiker.

**Ziet de testgebruiker niets, en heeft de app rollen?** Kijk dan eerst naar
`supabase/testrol.sql`. Dat bestand geeft `testgebruiker@stagetwo.nl` dezelfde rol als de
bouwer van de app; Testdatabase verversen voert het elke nacht uit, meteen nadat de
testgebruiker is aangemaakt of vernieuwd, met de versie van `main`. Ontbreekt het, schrijf
het dan één keer in deze pull request: zoek in `supabase/migrations/` hoe de app rollen
bijhoudt en welke rol de bouwer heeft, en vraag alleen bij twijfel. Alleen de rol van de
testgebruiker, en zo dat het vaker mag draaien. Bijvoorbeeld:

```sql
-- De testgebruiker krijgt dezelfde rol als de bouwer van de app (hier: beheerder).
insert into public.gebruikersrollen (user_id, rol)
select id, 'beheerder' from auth.users where email = 'testgebruiker@stagetwo.nl'
on conflict (user_id) do nothing;
```

De rol is er na de merge en de eerstvolgende verversing. Een app zonder rollen heeft dit
bestand niet nodig.

Verstuurt je wijziging mail (in een Edge Function)? Gebruik dan `richtMail` uit
`supabase/functions/_shared/mail.ts`. Buiten productie gaat de mail dan alleen naar het
testadres uit `stack.config.json` (`testmail`), nooit naar echte mensen.

## Stap 4: Schrijf de test erbij

Niet achteraf, en niet "later". Bij deze werkwijze zijn de tests de enige verplichte
beoordelaar van je werk, dus wat de tests niet dekken, dekt niemand.

- **Nieuwe functionaliteit?** Leg het nieuwe gedrag vast in een test.
- **Bug opgelost?** Schrijf eerst een test die de bug reproduceert, en repareer dan
  tot hij groen is. Anders komt dezelfde bug over drie maanden terug.
- **Nieuwe tabel of gewijzigde policy?** Een RLS-test in `tests/rls/` (`controleerAfscherming`).
- **Nieuw onderdeel (een eigen hoofdscherm met een eigen pad)?** Een regel in
  `src/onderdelen.ts`. De browsertest `e2e/onderdelen.spec.ts` opent het dan vanzelf en kijkt
  of het zonder fout opent en zijn kop toont; `tests/unit/onderdelen.test.ts` is rood als een
  nieuw pad in de router niet in die lijst staat.

De CI blokkeert een PR die productiecode wijzigt zonder één enkele test aan te raken.

## Stap 5: Snel controleren voor je pusht

```bash
pnpm check
```

Dat is typecontrole, lint, unittests en de guards in één keer: precies wat de snelle check
`Code` in GitHub bij elke push draait. Is `Code` rood, dan komt er geen nieuwe preview; zo
zie je het hier al, binnen een minuut. De zware check met de browser draai je pas als de
gebruiker het goed vindt (stap 7). Rood? Repareren, niet omzeilen.

## Stap 6: Open een concept-PR en laat de gebruiker meekijken

De eerste keer dat er iets te zien is:

```bash
git push -u origin <branch>
gh pr create --draft
```

Altijd als concept (draft), ook een pull request met een migratie. Zolang de PR een concept
is, draait bij elke push de snelle check `Code`; is die groen, dan zet de workflow
`Preview uitrollen` de nieuwe versie online. Is `supabase/` gewijzigd, dan draait ook
`Database en end-to-end`, maar zonder browser (Supabase, typecontrole, RLS-tests); anders
slaat die check over. De browsertest wacht tot stap 7. Zo kost een tussenstap minuten in
plaats van een volle poort, en ziet de gebruiker geen rode tussenstanden. Is `Code` rood, dan
komt er geen nieuwe preview: repareer eerst.

Vul het PR-formulier volledig in. De regel `Cloudflare-preview:` is niet optioneel: die
link is de enige geldige manier om werk te laten zien. Wacht tot `Preview uitrollen` de links
als reactie in de PR heeft gezet en plak de PR-link erin. Die reactie noemt er twee:

- **de preview van deze PR** (`pr-<nummer>-...`): precies deze wijziging;
- **het vaste adres van de app** (`actueel-...`): altijd de laatst gepushte PR. Dit adres
  verandert nooit. Geef het de gebruiker één keer; hij kan het open laten staan, ook op een
  tablet, en hoeft na een push alleen te verversen. Moedig hem aan daar zelf in te loggen
  en mee te kijken. Tip: daar krijgt hij in de testdatabase een eigen account, los van
  productie. Iemand moet dat account één keer een rol geven; die rol blijft daarna staan.

**Kijk zelf eerst.** Je hebt de wijziging lokaal al nagelopen als testgebruiker (stap 3).
Open daarna de preview in de browser in de zijbalk van de Claude-app (of, als
die er niet is, in Chrome via Claude in Chrome) en loop de wijziging na voordat je de
gebruiker vraagt te kijken. Zie je het inlogscherm van Cloudflare Access, vraag de gebruiker
dan één keer in te loggen met zijn werkaccount, in dat paneel; de browser onthoudt dat voor
alle apps. Lukt geen van beide, geef dan de link en zeg dat je hem niet zelf kon openen.

De preview draait achter dezelfde login als productie en gebruikt de testdatabase. Een
wijziging aan `wrangler.jsonc` uit deze PR zie je daar pas na de merge.

**Push per afgerond stukje, niet per kleine wijziging.** Kleine stappen bekijk je in de
preview van de Claude-app zelf (die ververst direct); elke push kost een run in GitHub.

Zet nooit een dev-server op localhost op om iets te tonen. Die kan de klant niet
openen en hij bewijst niet dat de gebouwde versie werkt. Lokaal kijken voor jezelf
(`docs/routes/lokaal-kijken.md`) is iets anders dan werk laten zien.

## Stap 7: Op klaar zetten, wachten en repareren

Zegt de gebruiker dat het goed is ("prima", "zo laten", "zet maar live"), dan gaat de pull
request op klaar. Vul eerst zelf het kopje **Voor de architectuur** in de PR-tekst in, zonder
de gebruiker iets te vragen: haal het uit het gesprek en de wijziging
(`gh pr edit <nummer> --body-file <bestand>`). Drie regels: wat er met de hand is ingesteld
(wat en waar, bijvoorbeeld een geheim dat de owner zette of een instelling in een dashboard),
of hier een besluit viel (welk, in één zin), en of dit een ander onderdeel of een andere app
raakt (welk). Niets van toepassing: `nee`. Na de merge komt het in het logboek van de
architectuur-repo. Daarna:

```bash
pnpm check         # typecontrole, lint, unittests en guards in één keer, eerst lokaal
gh pr ready        # nu draait de volledige poort, ook Database en end-to-end
gh pr checks --watch
```

Is `pnpm check` rood, repareer en push dat eerst; pas als hij groen is gaat de PR op klaar.

De RLS-tests, de databasetypes en de browsertest draaien in GitHub, met een eigen Supabase.
Op je eigen computer is daar niets voor nodig (geen Docker).

Wacht zelf tot alle checks klaar zijn. Wordt er een rood, lees dan de melding
(`gh run view <run-id> --log-failed`), repareer het, push, en wacht opnieuw. Vraag de
gebruiker nooit wat hij met een rode check moet; dat is jouw werk. Alleen als het echt niet
lukt, of als een melding om een besluit vraagt (zoals `guard:migrations` of
`guard:secrets`), leg je het hem uit, met jouw advies.

## Stap 8: Klaar is klaar

Een taak is klaar als, en alleen als:

1. de pull request open staat en geen concept meer is,
2. **alle** checks groen zijn, en
3. de Cloudflare-preview-link in de beschrijving staat en werkt.

Niet eerder. Meld niet "het is af" bij een rode check, een concept-PR of een ontbrekende
preview; meld dan wat er nog mist.

## Na de merge: Edge Functions live zetten

Raakte de wijziging `supabase/functions/`, dan gaan de functies niet vanzelf live. Start na de
merge de workflow in de beheer-repo van de organisatie en wacht op het resultaat:

```bash
gh workflow run functies-uitrollen.yml --repo <org>/stagetwo-beheer-tier2 -f app=<naam van deze repo>
gh run watch --repo <org>/stagetwo-beheer-tier2 "$(gh run list --repo <org>/stagetwo-beheer-tier2 --workflow functies-uitrollen.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

Heet de beheer-repo bij deze organisatie nog `stagetwo-beheer` of `stack-beheer`, gebruik dan die naam. De functies
gaan eerst naar de testdatabase en dan naar productie.

### Een functie proberen vóór de merge

Wil je een gewijzigde Edge Function proberen terwijl de pull request nog open staat, start
Functies uitrollen dan vanaf je tak:

```bash
gh workflow run functies-uitrollen.yml --repo <org>/stagetwo-beheer-tier2 -f app=<naam van deze repo> -f tak=<jouw tak>
```

Dat zet de functies van die tak alleen op de testdatabase, nooit op productie. Lokaal en in
de preview praat de app daarna met die proefversie. Zeg erbij: alle previews en iedereen die
lokaal kijkt, delen de testdatabase en zien zolang ook de proefversie. Na de merge zet de
gewone run (vanaf `main`) alles weer gelijk.

## Een fout uit productie

Meldt de gebruiker een fout, of zie je er een? Kijk dan eerst in Sentry wat er precies
gebeurde: welke melding, op welk scherm, bij hoeveel mensen. Je leest Sentry via de
koppeling in claude.ai. Staat die niet aan, vraag de gebruiker hem aan te zetten
(Instellingen > Koppelingen > Sentry); de beheerder van het Sentry-account logt dan één keer
in. Daarna volg je deze route vanaf stap 1, met eerst een test die de fout laat zien.

## Als een check rood staat

| Check | Wat het betekent |
|---|---|
| `typecheck` | de code klopt niet met zichzelf of met het databaseschema. Haal de types op met `pnpm db:types:uit-ci` als je net een migratie hebt gemaakt |
| Typecontrole edge functions (deno check) | een functie in `supabase/functions/` klopt niet met zichzelf. Die draait op Deno en valt buiten `pnpm typecheck`; de fout staat in het log van de job Code |
| `lint` | opmaak of stijl. `pnpm lint:fix` lost het meeste vanzelf op |
| `test` | gedrag is stuk, of de test klopt niet meer. Kijk eerst welke van de twee |
| `guard:tests` | je wijzigde code zonder test. Voeg er een toe |
| `guard:secrets` | er staat mogelijk een sleutel in de code of in de bundel. **Altijd zelf naar kijken**, dit is de gevaarlijkste |
| `guard:rls` | er is een tabel zonder beveiliging, een policy met `using (true)` buiten `open_tabellen`, of een leesrol die mag schrijven |
| `guard:rls-tests` | een tabel heeft geen A/B-test in `tests/rls/` (`controleerAfscherming`) en staat niet in `open_tabellen`. In deze versie nog een waarschuwing, vanaf de volgende uitgave rood. Voor een tabel die er al stond, schrijft `/stagetwo-tier2:updaten` de test in de update-PR; een nieuwe tabel krijgt hem van jou |
| `guard:migrations` | je migratie kan data vernietigen (lees de melding en bevestig bewust), of een `update`/`delete` mist de regel `-- verwachting:` |
| Droogloop migraties | verplicht op elke PR; zonder migratie die gegevens omzet staat hij vanzelf op groen ("niets te oefenen"). Rood: je migratie raakt op de testdatabase meer, minder of andere rijen dan de regels `-- verwachting:` zeggen. Lees de reactie in de PR: klopt de migratie niet, repareer hem; klopt alleen het bereik niet, pas het aan. Zegt hij dat de sleutels voor de testdatabase ontbreken, dan is dat geen fout van jou en hoef je niet te wachten: zet de regel `Bevestigd: droogloop zonder testdatabase` in de PR-tekst en kies bij de run "Re-run failed jobs". De sleutels zet de owner van de beheer-repo met App inrichten (of `/stagetwo-tier2:updaten`, als jij dat mag starten) |
| `guard:template` | je wijzigde een bestand van de gedeelde template. Draai het terug en meld het bij Stage Two; wil je de nieuwste versie van de template, dan is dat `/stagetwo-tier2:updaten` |
| `guard:cloudflare` | `wrangler.jsonc` vraagt om opslag van Cloudflare (D1, R2, KV, Durable Objects), Worker-code of een sleutel die niet op de lijst staat. Gegevens horen in Supabase: haal de sleutel weg |
| `db:types:check` | de gegenereerde types lopen achter. `pnpm db:types:uit-ci` haalt ze uit deze run; committen en pushen |
| Database en end-to-end | migraties, RLS-tests of de browsertest in een eigen Supabase in GitHub. Start pas als `Code` groen is. Bij een concept-PR zonder wijziging in `supabase/` staat hij op overgeslagen, en bij een concept mét zo'n wijziging draait hij zonder browser: dat is de bedoeling, alles draait bij `gh pr ready` |

**Een regel in de PR-tekst toegevoegd** (`Geen tests nodig: ...`, `Bevestigd: ...`) terwijl
de pull request al open staat? Een aangepaste PR-tekst start de controles niet vanzelf opnieuw,
zodat de previewlink plakken of een vinkje zetten geen nieuwe run kost. Start de rode job
daarna zelf opnieuw: `gh run rerun <run-id> --failed`.

Een rode check omzeilen door hem uit te zetten is nooit het antwoord. De check is
er niet om jou te hinderen, maar omdat er verder niemand meekijkt.
