# Verder werken aan deze app

Dit is de enige route waarlangs werk in deze app terechtkomt. Hij geldt voor iedereen,
ook voor een kleine tekstwijziging, want de route is precies wat het veilig maakt om
zonder programmeerkennis te bouwen.

## Stap 1: Weet wat je gaat maken

Vraag door tot je één zin kunt opschrijven die begint met "na deze wijziging kan de
gebruiker …". Lukt dat niet, dan is het verzoek nog niet scherp genoeg en is dit het
moment om het te vragen, niet halverwege.

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
`docs/routes/databasewijziging.md` in zijn geheel en volg die stappen erbij; zo'n pull
request open je niet als concept, zodat de databasetests meteen meedraaien. In Claude
Code herinnert de plugin je eraan zodra je in `supabase/migrations/` schrijft.

Wil je tussendoor zien wat je gemaakt hebt? In de Claude-app start de preview vanzelf
(`.claude/launch.json`), tegen de testdatabase; gebruik die ook om je eigen werk te
controleren. Met een andere assistent: `docs/routes/lokaal-kijken.md`. Het is een
hulpmiddel tijdens het bouwen, niet de oplevering: die volgt hieronder.

## Stap 4: Schrijf de test erbij

Niet achteraf, en niet "later". Bij deze werkwijze zijn de tests de enige verplichte
beoordelaar van je werk, dus wat de tests niet dekken, dekt niemand.

- **Nieuwe functionaliteit?** Leg het nieuwe gedrag vast in een test.
- **Bug opgelost?** Schrijf eerst een test die de bug reproduceert, en repareer dan
  tot hij groen is. Anders komt dezelfde bug over drie maanden terug.
- **Nieuwe tabel of gewijzigde policy?** Een RLS-test in `tests/rls/`.

De CI blokkeert een PR die productiecode wijzigt zonder één enkele test aan te raken.

## Stap 5: Draai de poort lokaal

```bash
pnpm check
```

Dat is typecontrole, lint, unittests en de guards in één keer. Alles groen? Door. Rood?
Repareren, niet omzeilen.

## Stap 6: Open een concept-PR en laat de gebruiker meekijken

De eerste keer dat er iets te zien is:

```bash
git push -u origin <branch>
gh pr create --draft
```

Altijd als concept (draft), behalve een pull request met een migratie: die open je
meteen gewoon (zie `docs/routes/databasewijziging.md`). Zolang de PR een concept is, draait bij elke push alleen de
snelle check `Code`, en de workflow `Preview uitrollen` zet de nieuwe versie online. De zware
check `Database en end-to-end` wacht tot stap 7. Zo kost een tussenstap minuten in plaats van
een volle poort, en ziet de gebruiker geen rode tussenstanden.

Vul het PR-formulier volledig in. De regel `Cloudflare-preview:` is niet optioneel: die
link is de enige geldige manier om werk te laten zien. Wacht tot `Preview uitrollen` de links
als reactie in de PR heeft gezet en plak de PR-link erin. Die reactie noemt er twee:

- **de preview van deze PR** (`pr-<nummer>-...`): precies deze wijziging;
- **het vaste adres van de app** (`actueel-...`): altijd de laatst gepushte PR. Dit adres
  verandert nooit. Geef het de gebruiker één keer; hij kan het open laten staan, ook op een
  tablet, en hoeft na een push alleen te verversen.

**Kijk zelf eerst.** Open de preview in de browser in de zijbalk van de Claude-app (of, als
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

Zegt de gebruiker dat het goed is ("prima", "zo laten", "zet maar live"), dan:

```bash
gh pr ready        # nu draait de volledige poort, ook Database en end-to-end
gh pr checks --watch
```

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
gaan eerst naar de testdatabase en dan naar productie. Een preview van een PR ziet een nieuwe
functie dus pas na de merge; zeg dat erbij als de gebruiker hem in de preview wil proberen.

## Als een check rood staat

| Check | Wat het betekent |
|---|---|
| `typecheck` | de code klopt niet met zichzelf of met het databaseschema. Haal de types op met `pnpm db:types:uit-ci` als je net een migratie hebt gemaakt |
| `lint` | opmaak of stijl. `pnpm lint:fix` lost het meeste vanzelf op |
| `test` | gedrag is stuk, of de test klopt niet meer. Kijk eerst welke van de twee |
| `guard:tests` | je wijzigde code zonder test. Voeg er een toe |
| `guard:secrets` | er staat mogelijk een sleutel in de code of in de bundel. **Altijd zelf naar kijken**, dit is de gevaarlijkste |
| `guard:rls` | er is een tabel zonder beveiliging |
| `guard:migrations` | je migratie kan data vernietigen; lees de melding en bevestig bewust |
| `guard:template` | je wijzigde een bestand van de gedeelde template. Draai het terug en meld het bij Stage Two; wil je de nieuwste versie van de template, dan is dat `/stagetwo-tier2:updaten` |
| `guard:cloudflare` | `wrangler.jsonc` vraagt om opslag van Cloudflare (D1, R2, KV, Durable Objects), Worker-code of een sleutel die niet op de lijst staat. Gegevens horen in Supabase: haal de sleutel weg |
| `db:types:check` | de gegenereerde types lopen achter. `pnpm db:types:uit-ci` haalt ze uit deze run; committen en pushen |
| Database en end-to-end | migraties, RLS-tests of de browsertest in een eigen Supabase in GitHub. Bij een concept-PR staat deze check op overgeslagen: dat is de bedoeling, hij draait bij `gh pr ready` |

**Een regel in de PR-tekst toegevoegd** (`Geen tests nodig: ...`, `Bevestigd: ...`) terwijl
de pull request al open staat? Een aangepaste PR-tekst start de controles niet vanzelf opnieuw,
zodat de previewlink plakken of een vinkje zetten geen nieuwe run kost. Start de rode job
daarna zelf opnieuw: `gh run rerun <run-id> --failed`.

Een rode check omzeilen door hem uit te zetten is nooit het antwoord. De check is
er niet om jou te hinderen, maar omdat er verder niemand meekijkt.
