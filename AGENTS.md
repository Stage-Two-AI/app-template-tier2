# <projectnaam>

<!-- Vervang <projectnaam> en de regel hieronder bij het opzetten van een project.
     Alles boven de markering hoort bij dít project en wordt bij /stagetwo-tier2:updaten
     nooit overschreven. -->

<!-- Wat deze app doet, in één zin, vanuit de gebruiker geschreven. -->

<!-- Heeft deze app een database? Dan staat de testdatabase (het Supabase-project
     waar de preview naar wijst en waar je lokaal tegenaan mag kijken) in
     stack.config.json onder `testdatabase`. Noem hier eventueel de naam van dat
     project en van het productieproject, zodat niemand ze verwart. -->

<!-- stack:begin -->
<!-- Alles hieronder komt uit de app-template en wordt bijgewerkt met
     /stagetwo-tier2:updaten, als pull request. Wijzig het niet hier; meld het bij Stage Two. -->

Dit bestand geldt voor **elke** agent die in deze repo werkt: Claude Code, Codex, Cursor,
Copilot of een mens zonder agent. Er is geen tweede set afspraken ergens anders.

## Klaar is

Een taak is klaar als: er een pull request open staat die geen concept (draft) meer is,
**álle** checks groen zijn, en de Cloudflare-preview-link in de PR staat (de workflow
`Preview uitrollen` zet hem er als reactie bij). Niet eerder. Staat er een check rood, dan
repareer je hem zelf en wacht je opnieuw; meld pas daarna "het is af", of meld wat er nog
mist als het echt niet lukt.

Het ritme (zie `docs/routes/verder-werken.md`): een PR begint als concept, waarop alleen de
snelle checks draaien en de preview wordt bijgewerkt; de gebruiker kijkt mee op het vaste
adres van de app (`actueel-...`). Is de gebruiker tevreden, dan zet je hem op klaar
(`gh pr ready`), wacht je op alle checks (`gh pr checks --watch`) en repareer je wat rood is.
Een PR met een migratie begint niet als concept. Docker is nergens voor nodig: de
databasetests draaien in GitHub, en `pnpm db:types:uit-ci` haalt de types daar op.

## Stack

Vite + React + TypeScript (strict) · Tailwind + shadcn/ui · React Router · Zod · pnpm.
Hosting: Cloudflare (alleen de gebouwde bestanden, achter Cloudflare Access). Inloggen: via Cloudflare, dat ook de inlogdienst van Supabase is. Fouten: Sentry. Achtergrond en het waarom: `docs/WERKWIJZE.md`.

**De database is een keuze, geen gegeven.** In `stack.config.json` staat `database`, en
die heeft drie standen:

| Stand | Wat dat betekent |
|---|---|
| `false` | geen database. De app draait alleen op Cloudflare; de `pnpm db:*`-commando's zijn niet van toepassing |
| `"gedeeld"` | de app gebruikt de database van een **andere** app, via haar contract (het schema `api`). Geen migraties, geen deploy naar Supabase, geen eigen RLS-tests |
| `true` | de app bezit haar eigen database. De hele laag doet mee |

De regel erachter: **precies één repo mag naar een database schrijven.** Twee repo's die
allebei migraties pushen naar hetzelfde Supabase-project lopen vast, want de toegepaste
migraties worden in de database zelf bijgehouden. Staat deze app op `"gedeeld"`, dan hoort
een schemawijziging thuis in de repo van de eigenaar, en blokkeert `guard:migrations` elke
migratie die hier terechtkomt.

Zet de stand niet op eigen houtje om; `docs/WERKWIJZE.md` beschrijft wanneer welke stand
geldt en wat er dan moet gebeuren.

**Een app met database heeft een testdatabase** (`testdatabase` in `stack.config.json`):
een tweede Supabase-project waar de Cloudflare-preview en lokaal kijken naar wijzen, en waar
migraties bij een merge als eerste op draaien. Productie raak je vanaf een preview of je
eigen computer dus nooit. Zet nooit de sleutels van productie in `.env.local`.

## Commando's

| Commando | Wat het doet |
|---|---|
| `pnpm check` | typecontrole, lint, unittests en guards in één keer |
| `pnpm build` | productiebuild |
| `pnpm test` | unittests |
| `pnpm db:types:uit-ci` | databasetypes ophalen uit de laatste run van de Kwaliteitspoort (geen Docker nodig) |
| `pnpm db:start` | lokale Supabase starten; vraagt Docker, alleen voor Stage Two |
| `pnpm env:local` | `.env.local` en `.env.test` schrijven op basis van die database |
| `pnpm env:test` | `.env.local` laten wijzen naar de testdatabase van de app (geen Docker nodig), met de testlogin erbij |
| `pnpm testlogin` | het wachtwoord van de testgebruiker ophalen uit de beheer-repo (elke nacht nieuw) en in `.env.development.local` zetten; de preview doet dit bij elke start |
| `pnpm db:reset` | lokale database opnieuw opbouwen uit alle migraties |
| `pnpm db:types` | databasetypes genereren na een migratie |
| `pnpm test:rls` | beveiligingstests (database moet draaien) |
| `pnpm test:e2e` | end-to-end test in een echte browser |

## Waar wat staat

```
src/components/ui/     losse bouwblokken (shadcn/ui, staan in deze repo, mag je aanpassen)
src/features/          schermen en functionaliteit, per onderwerp
src/lib/               database, omgeving, validatie, hulpjes
supabase/migrations/   elke databasewijziging, in volgorde
supabase/functions/    Edge Functions (Deno) voor alles met een geheime sleutel
tests/rls/             beveiligingstests
e2e/                   end-to-end tests
public/                manifest en icoontjes: de app is installeerbaar op telefoon en computer
scripts/               de guards uit de kwaliteitspoort
docs/routes/           de vaste routes, stap voor stap (zie Werkwijzen)
docs/solutions/        gedocumenteerde oplossingen van eerdere problemen (bugs, werkwijzen, patronen), per categorie, met YAML-frontmatter (module, tags, problem_type)
```

## Regels

- **Kijken mag lokaal, opleveren gaat via de Cloudflare-preview van de PR.** In de
  Claude-app start de preview (`.claude/launch.json`, `scripts/preview.mjs`) de app op
  de computer van de gebruiker, tegen de testdatabase en nooit tegen productie; gebruik
  die om je werk te controleren en om de gebruiker te laten meekijken. Zet geen
  dev-server in een terminal op, en geef nooit een `localhost`-adres als resultaat:
  `pnpm dev` weigert om die reden, het is geen storing. Andere assistenten volgen
  `docs/routes/lokaal-kijken.md`.
- **Lokaal log je in als testgebruiker** (`testgebruiker@stagetwo.nl`, de knop op het
  inlogscherm), niet via Cloudflare. Heeft de app die knop nog niet, vul dan in het gewone
  formulier het adres en wachtwoord in uit `.env.development.local`
  (`VITE_TESTLOGIN_EMAIL` en `VITE_TESTLOGIN_WACHTWOORD`). De testdatabase is een kopie van
  echte gegevens: dat wachtwoord komt nooit in git, een PR-tekst of het gesprek. Ziet de
  testgebruiker niets, dan heeft hij nog geen rol in de app; zeg dat, in plaats van om het
  inloggen heen te werken.
- **Bij een fout uit productie kijk je eerst in Sentry**, via de koppeling in claude.ai.
- **Geen `any`, geen `@ts-ignore`, geen `as unknown as`, geen non-null `!`.** Los de
  echte typefout op. Een groene build met verstopte fouten is erger dan een rode.
- **Databasetypes komen uit `pnpm db:types`**, nooit met de hand verzonnen. Klaagt
  TypeScript over een kolom, dan is het antwoord de typegeneratie, niet een `any`.
- **Invoer van buiten** (formulieren, webhooks, API's) valideer je met Zod.
- **Secrets nooit in de app-bundel.** Alleen de Supabase anon key en de Sentry DSN
  mogen in een `VITE_`-variabele; die zijn expres publiek (de anon key wordt door RLS
  beschermd, de DSN kan alleen fouten insturen). Alles met een geheime sleutel gaat
  naar een Supabase Edge Function.
- **`supabase/functions/` draait op Deno**, de rest op Node en in de browser. Imports
  zijn niet uitwisselbaar tussen die twee, en die map valt buiten `tsconfig.json`.
- **Edge Functions gaan live via de beheer-repo, niet vanaf deze computer.** Na de merge
  start je de workflow **Functies uitrollen** in de beheer-repo van de organisatie
  (`gh workflow run functies-uitrollen.yml --repo <org>/stagetwo-beheer-tier2 -f app=<naam>`); die zet
  de functies van `main` eerst op de testdatabase en dan op productie. Draai nooit zelf
  `supabase functions deploy` of `supabase secrets set`: op deze computer hoort geen
  Supabase-toegang.
- **Een machine die een functie aanroept** (server, Pi, script) logt niet in als mens. Hij
  krijgt een apparaatsleutel: `pnpm apparaat:nieuw <naam>` zet de vingerafdruk in
  `supabase/functions/_shared/apparaten.json` en toont de sleutel één keer. De functie
  controleert hem met `welkApparaat(request, ["<naam>"])` uit `_shared/apparaat.ts`, altijd met de namen van de apparaten die déze functie mogen gebruiken, en staat in
  `supabase/config.toml` op `verify_jwt = false`. Zet de sleutel zelf nooit in git of een
  chat; de gebruiker zet hem op het apparaat.
- **Mail uit een Edge Function gaat altijd via `richtMail`** uit
  `supabase/functions/_shared/mail.ts`. Buiten productie gaat hij dan alleen naar het
  testadres (`testmail` in `stack.config.json`), of nergens heen. Verstuur nooit mail om
  die functie heen.
- **Een functie proberen vóór de merge** kan met Functies uitrollen vanaf je tak
  (`-f tak=<tak>`): alleen naar de testdatabase, nooit naar productie. Zeg de gebruiker dat
  alle previews die proefversie dan ook zien (zie `docs/routes/verder-werken.md`).
- **Een sleutel van een ander systeem** (Stripe, Moneybird, een AI-dienst) in een functie
  zetten is een architectuurwijziging: dat doet de owner, niet de bouwer. Schrijf de functie
  zo dat hij een duidelijke fout geeft als de sleutel ontbreekt (zie
  `supabase/functions/voorbeeld-met-geheim/`), en zeg de gebruiker dat de owner hem moet zetten.
- **Databasewijzigingen altijd als migratie** in `supabase/migrations/`, nooit
  handmatig in de Supabase-console. Draai daarna `pnpm db:types` en commit het resultaat.
- **Gebruikt deze app een gedeelde database** (`"database": "gedeeld"`), schrijf dan hier
  géén migratie. Het schema is van een andere repo. Je praat uitsluitend met het schema
  `api`: views om te lezen, functies om te schrijven. Mis je daar iets, dan is dat een
  wijziging aan het contract en dus een aanvraag bij de eigenaar, geen bestand hier.
- **Elke nieuwe tabel krijgt RLS aan, een `grant` én policies**, plus een test in
  `tests/rls/` die controleert dat gebruiker A niet bij de gegevens van B komt.
- **Heeft de app geen database, verzin er dan geen.** Moet de app iets bewaren of op
  vaste tijden iets doen, dan is dat het signaal om `database` om te zetten (Supabase,
  met Storage voor bestanden en `pg_cron` voor terugkerende taken). Gebruik nooit
  opslag van Cloudflare zelf (D1, KV, R2, Durable Objects): Cloudflare serveert alleen
  de app en regelt de toegang. `guard:cloudflare` laat alleen de sleutels in
  `wrangler.jsonc` door die op de lijst staan en blokkeert de rest.
- **Elk adres van de app staat achter Access.** Normaal is dat het eigen domein
  (`routes` met `custom_domain: true`). Alleen zolang de klant nog geen domein heeft,
  mag de tijdelijke stand: geen `routes`. `workers_dev` staat in beide standen op `true`,
  achter de Access op de Worker zelf; zonder dat adres tonen de previews alleen "There
  is nothing here yet". Zet geen stand op eigen houtje aan of uit; `docs/WERKWIJZE.md`
  zegt wanneer hij mag.
- **Wie code wijzigt, wijzigt ook een test.** Bugfix? Eerst een test die de bug
  reproduceert, dan de reparatie.
- **Eén PR = één onderwerp.** Beschrijf wat je gewijzigd hebt en waarom.
- **Pushen naar `main` kan niet en hoeft niet:** deployen gebeurt door te mergen.
- **Niet met de hand deployen** (`wrangler deploy`, `wrangler login`, `supabase db push`, `supabase link`).
  Deployen doet GitHub Actions bij een merge; een handmatige ingreep laat de repo uit de
  pas lopen met de werkelijkheid.
- **Migraties zijn aanvullend.** Voeg een kolom toe in de ene PR en gebruik hem in de
  volgende; gooi een kolom pas weg als niets hem meer aanroept.

## Werkwijzen

Voor de vaste routes staat een stappenplan in `docs/routes/`. Lees het bestand **vóórdat**
je begint en loop de stappen in volgorde af, in plaats van te improviseren:

- `docs/routes/verder-werken.md`: iets toevoegen, wijzigen of repareren aan deze app.
  Dit is de route voor vrijwel elk verzoek, ook een kleinigheid.
- `docs/routes/databasewijziging.md`: een tabel, kolom of policy erbij of anders. Hoort
  bij verder-werken: lees hem zodra een wijziging de database raakt.
- `docs/routes/lokaal-kijken.md`: de app op je eigen computer zien terwijl je bouwt. In
  de Claude-app gaat dat vanzelf via de preview; deze route is voor andere assistenten
  en voor wie het met de hand doet.

Een compleet nieuwe applicatie begin je niet vanuit deze map: die krijgt een eigen repo,
via `/stagetwo-tier2:nieuwe-app` in een lege map.

In Claude Code geeft de Stage Two-plugin vier commando's: `/stagetwo-tier2:installatie` (een
nieuwe computer klaarzetten), `/stagetwo-tier2:nieuwe-app`, `/stagetwo-tier2:verder-werken` (verwijst naar
de routes hierboven, er is maar één tekst) en `/stagetwo-tier2:updaten` (plugin, computer en apps
bijwerken, elke wijziging aan een app als pull request van de gebruiker zelf).

## Wat je niet aanpast

`.github/workflows/`, `.claude/`, `scripts/`, `docs/WERKWIJZE.md`, `docs/routes/` en dit
bestand onder de markering komen uit de gedeelde template en worden bijgewerkt met
`/stagetwo-tier2:updaten`, als pull request. De check `guard:template` laat een PR die eraan
komt rood staan; in Claude Code houdt de hook van de Stage Two-plugin de wijziging al
bij de toetsaanslag tegen. Klopt er iets niet, meld het dan bij Stage Two: dan krijgt
elk project de verbetering, in plaats van dit project alleen.

<!-- stack:end -->
