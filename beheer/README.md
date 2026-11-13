# beheer/: inrichting van de Cloudflare-proef

Deze map gaat niet mee naar afgeleide apps (`nietMeenemen` in
`.claude/stack-manifest.json`). Een beheer-repo kan hem wel als zelfstandig pakket
kopiëren (zie "Los van de template"); de nette plek is `beheer-template`.

Wat erin zit:

| Bestand | Wat het doet |
|---|---|
| `inrichten-cloudflare.mjs` | het script: inrichten, tweede doorgang, toegang bijwerken, opruimen |
| `lib/cloudflare.mjs` | Access-policies, Access-apps, workers.dev-subdomein, placeholder-Worker |
| `lib/supabase.mjs` | project, sleutels, auth-config, custom provider `custom:cloudflare`, de mails, de rem en de sessieduur van een klantportaal |
| `lib/toegang.mjs` | `toegang.json` controleren, vertalen naar policies, intrekken, de aanmeld-hook van de testdatabase, de twee hooks van een klantportaal |
| `controle-doorsteek.mjs` | kijkt van buitenaf of de deur dicht zit (en bij een klantportaal: of alleen het domein open is); met `--app` zoekt het de adressen zelf op (de knop Controle van buitenaf) |
| `toegang.json` | wie bij welke app mag |
| `package.json` | maakt van `beheer/` een zelfstandig pakket (zie "Los van de template") |
| `*.test.mjs`, `nep-wolk.mjs` | tests tegen een nagebootste API (`pnpm beheer:test`) |
| `regressie-42.*`, `regressie-scenarios.mjs` | bewijs dat een app zonder `klantportaal` exact dezelfde inrichting krijgt als op versie 42 (zie "Lokaal testen") |
| `klantportaal*.test.mjs`, `klantportaal-opzet.mjs` | het klantportaal, en per onderwerp (deur, intrekken, inlog, geheimen) de aanvallen die erop zijn geprobeerd, als tests die bewijzen dat ze mislukken |

Alles wat het script aanmaakt heeft een naam die begint met het voorvoegsel. Dat is een
verplichte instelling: `--voorvoegsel <vv->` of de omgevingsvariabele
`BEHEER_VOORVOEGSEL` (de vlag gaat voor). De proef gebruikt `cf-proef-`, een klant bijvoorbeeld `kl-`.
Het patroon is streng: een kleine letter, hoogstens vijftien kleine letters of cijfers,
en precies één streepje, aan het eind (`kl-`, niet `kl-x-`). `cf-proef-` is de enige
uitzondering; `cf-` zelf wordt geweigerd. Zo kan geen voorvoegsel met een ander
voorvoegsel beginnen, en neemt opruimen met het ene nooit iets van het andere mee.
Zonder voorvoegsel start het script niet.

Wat al bestaat met het voorvoegsel wordt hergebruikt. Opruimen raakt alleen de exacte
namen die het script voor de app en de groepen in `toegang.json` maakt; een andere naam
met het voorvoegsel blijft staan, met een waarschuwing. Bestaat er iets met dezelfde
naam zónder voorvoegsel, of staat er al een andere Access-app op de hostname, dan stopt
het script voordat het iets wijzigt. De aanmeld-hookfunctie van de testdatabase heet ook
naar het voorvoegsel (`cf_proef_voor_aanmelden`, `kl_voor_aanmelden`).

## Voorwaarden (door Christijn)

- **P1.** Zero Trust aan op het Cloudflare-account (gratis plan, teamnaam kiezen). Onder
  Integrations > Identity providers de inlogmethode one-time PIN toevoegen.
- **P2.** Een Cloudflare-API-sleutel met: Workers Scripts bewerken, Workers Routes en DNS
  bewerken op de zone `stagetwo.nl`, Access: Apps and Policies bewerken, Access:
  Organizations, Identity Providers and Groups lezen. Bewaren als `CLOUDFLARE_PROEF_TOKEN`
  in `~/.cloudflare-proef.env` en als secret in de GitHub-omgeving `proef-beheer`.
  Daarnaast twee smalle sleutels met alleen Workers Scripts bewerken: één als
  `CLOUDFLARE_API_TOKEN` in omgeving `production`, één in omgeving `preview`.
  Geen van deze sleutels krijgt een D1-, R2- of KV-groep (Workers KV Storage, Workers
  R2 Storage, D1): dan kan er geen opslag bij Cloudflare ontstaan, ook niet als iemand
  `guard:cloudflare` omzeilt. Durable Objects vallen onder Workers Scripts en worden
  alleen door die check tegengehouden. Zonder eigen domein (tijdelijke stand in
  `wrangler.jsonc`) is de zone-regel van Workers Routes en DNS niet nodig.
- **P3.** Bevestigen dat er in de Supabase-organisatie "Stage Two" ruimte is voor één
  actief project naast finance.
- **P4.** In omgeving `proef-beheer` de secrets `SUPABASE_ACCESS_TOKEN` (Management API),
  `SUPABASE_ORG_SLUG` en `BEHEER_GH_TOKEN`: een fijnmazige sleutel (of GitHub App) met
  schrijfrechten op secrets, variabelen en omgevingen van deze repo. De gewone
  `GITHUB_TOKEN` mag geen secrets of variabelen zetten.

Verder in omgeving `proef-beheer`, als variabelen (geen secrets):

| Variabele | Waarde |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | het account-id |
| `CLOUDFLARE_TEAM_DOMAIN` | de teamnaam uit P1, bijvoorbeeld `stagetwo` of `stagetwo.cloudflareaccess.com` |
| `CLOUDFLARE_IDP_IDS` | optioneel: id's van de toegestane inlogmethoden, met komma's. Leeg = alleen one-time PIN. Een gewijzigde lijst zet een volgende run ook op bestaande Access-apps (met één methode meteen doorsturen) |
| `CLOUDFLARE_GROEPEN_IDP` | optioneel: `azureAD:<id>` als een groep `idp_groepen` gebruikt |
| `SENTRY_ORG` | optioneel, samen met het secret `SENTRY_AUTH_TOKEN`: de slug van de organisatie in Sentry. Dan krijgt elke app een eigen Sentry-project en DSN (zie "Foutbewaking" hieronder) |
| `SENTRY_TEAM` | optioneel: het team in Sentry voor nieuwe projecten. Alleen nodig als de organisatie meer dan één team heeft |
| `SENTRY_URL` | optioneel: `https://de.sentry.io` voor een organisatie in de EU-regio. Leeg = `https://sentry.io` |
| `VITE_SENTRY_DSN` | alleen voor de proef, als er geen `SENTRY_AUTH_TOKEN` is: één DSN die de inrichting bij elke app zet. Bij een klant niet gebruiken: met één DSN zie je in Sentry niet uit welke app een fout komt |

Beperk de omgevingen `proef-beheer`, `production` en `preview` tot de tak `main`
(Settings > Environments > Deployment branches). Dat kan ook voor `preview`, omdat de
preview in twee delen gaat: de PR-job in `uitrollen.yml` bouwt zonder omgeving en
zonder sleutels, en `preview-uitrollen.yml` uploadt het resultaat vanaf `main`. De
omgevingen `production` en `preview` moeten bestaan voordat de inrichting draait; het
script maakt ze niet aan.

Wat de inrichting in de app-repo zet:

| Waar | Wat |
|---|---|
| omgeving `production`, variabele | alleen bij een klantportaal met captcha: `VITE_TURNSTILE_SITEKEY`, de openbare sleutel van de Turnstile-widget (uit `toegang.json`). De previews krijgen hem niet |
| omgevingen `production` en `preview`, variabelen | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_INLOGDIENST`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_POOLER_HOST` en `SUPABASE_TEST_POOLER_HOST` (de session pooler van productie en van de testdatabase, voor `deploy-db.yml` en de droogloop van migraties), en `VITE_SENTRY_DSN` (de DSN van het eigen Sentry-project, als die nog ontbrak) |
| omgeving `production`, variabele | `SUPABASE_PROJECT_REF`: de database waar `deploy-db.yml` op migreert. Geen geheim (hij staat ook in `VITE_SUPABASE_URL`), dus zichtbaar in de instellingen van de app |
| repo-variabelen | `PREVIEW_VITE_SUPABASE_URL`, `PREVIEW_VITE_SUPABASE_ANON_KEY`, `PREVIEW_VITE_SUPABASE_SCHEMA` (`public`), `PREVIEW_VITE_INLOGDIENST`, en `PREVIEW_VITE_SENTRY_DSN` (dezelfde DSN als hierboven) |
| omgeving `production`, secrets | `SUPABASE_DB_PASSWORD`, en met `--testdatabase` ook `SUPABASE_TEST_DB_PASSWORD` (ontbreekt dat bij een bestaande testdatabase, dan zet een volgende run een nieuw testwachtwoord; productie nooit) |
| omgeving `preview`, secret | met `--testdatabase`: `SUPABASE_TEST_DB_PASSWORD`, voor de droogloop van migraties (`droogloop.yml`). Nooit het wachtwoord van productie. Een app die het daar nog niet heeft (van vóór versie 39), krijgt bij de volgende run één keer een nieuw testwachtwoord, in production en preview |

**De project-ref was tot versie 39 een secret.** Een volgende run zet hem als variabele en
haalt het oude secret `SUPABASE_PROJECT_REF` dan eenmalig weg, met een regel in het
resultaat. Dat gebeurt alleen als `deploy-db.yml` van de app de variabele al leest (vanaf
versie 39: `vars.SUPABASE_PROJECT_REF || secrets.SUPABASE_PROJECT_REF`); staat de app nog op
een oudere versie, dan blijft het secret staan en meldt het resultaat dat. Werk de app dan
bij en draai de inrichting nog een keer. Opruimen haalt de variabele en een achtergebleven
oud secret allebei weg.

**Foutbewaking (Sentry).** Staat in de beheeromgeving het secret `SENTRY_AUTH_TOKEN` met
de variabele `SENTRY_ORG`, dan zorgt stap S van de inrichting voor één Sentry-project per
app, met de naam van de app (`<app>`, zonder voorvoegsel; de organisatie in Sentry is van de
klant). Bestaat het project, dan gebruikt hij dat; anders maakt hij het aan, in `SENTRY_TEAM`
of in het enige team van de organisatie. Zijn DSN komt als `VITE_SENTRY_DSN` in `production`
en `preview` en als `PREVIEW_VITE_SENTRY_DSN` op de repo. Daarna stuurt hij één proefmelding
rechtstreeks naar die DSN (omgeving `proef`) en kijkt hij tot twee minuten of die in Sentry
aankomt; zo niet, dan een waarschuwing in het resultaat. Een DSN die er al staat (met de hand
gezet) blijft staan: de stap vult alleen aan wat ontbreekt, en stuurt dan geen proefmelding.
Zonder sleutel staat in het resultaat dat Sentry nog niet gekoppeld is en dat fouten uit
productie dan niet in Sentry komen. Koppelen doet in de projectfase Stage Two en daarna de owner
van de beheer-repo, met zijn eigen Sentry-account, met `sentry-koppelen.mjs`
(`skills/installatie/scripts/` in de plugin): dat zet het token zonder dat iemand de waarde ziet
(gh vraagt erom), zet `SENTRY_ORG` en start App inrichten opnieuw. De sleutel is een token van
een interne integratie in Sentry (Settings, Custom Integrations, Internal Integration) met
Project: Write (aanmaken en de DSN lezen), Team: Read en Issue & Event: Read (de proefmelding terugzien).
Opruimen haalt de variabelen weg, maar laat het Sentry-project staan (met de geschiedenis van
de fouten); dat verwijder je zo nodig in Sentry.

**Testdatabase (`--testdatabase`).** Voor een app met een eigen database (`database: true`
in `stack.config.json`) maakt de inrichting een tweede Supabase-project
`<vv><app>-test`, met een eigen SaaS-app `<vv><app>-test-inlog` (dezelfde policies, dus
dezelfde mensen), de custom provider en dezelfde auth-config. De `PREVIEW_`-variabelen
wijzen dan naar dat project, zodat een preview nooit bij de productiegegevens kan. Het
script geeft `testdatabase: { project_ref, anon_key }` terug; de workflow App inrichten
in de beheer-repo opent daarmee een pull request die het blok `testdatabase` in
`stack.config.json` zet. Na die merge zet `deploy-db.yml` de migraties eerst op de
testdatabase (canary) en dan op productie. Let op: het gratis plan van Supabase staat
twee actieve projecten per organisatie toe, dus één app met testdatabase. Toegang
bijwerken trekt ook in de testdatabase in; opruimen haalt hem mee weg.

In de testdatabase staat inloggen met e-mail aan, zodat de testgebruiker van Claude
(`testgebruiker@stagetwo.nl`) en de testaccounts uit `toegang.json` er zonder Cloudflare
in kunnen. Dat gaat alleen samen met een aanmeld-hook (before-user-created) die naar de
manier van aanmelden kijkt: met e-mail (mailcode of wachtwoord) alleen een testaccount,
via Cloudflare (`custom:cloudflare`) de adressen uit de groepen, zoals in productie, en
verder niets. De testgebruiker zelf meldt zich nooit zo aan: Testdatabase verversen maakt
hem met de admin-API, die niet langs de hook gaat. Zo kan niemand hem met een eigen
wachtwoord vóór zijn. Zonder die controle kon iemand die een toegelaten adres kent met een
zelfgekozen wachtwoord een account op dat adres maken, want `mailer_autoconfirm` staat
aan. De inrichting schrijft eerst de hook en zet pas daarna e-mail aan; Toegang
bijwerken doet hetzelfde bij elke run, ook voor een testdatabase van vóór versie 34.

De PR-job in `uitrollen.yml` noemt geen omgeving en leest daarom de `PREVIEW_`-
repovariabelen (geen secrets, ze staan toch in de bundel). `PREVIEW_VITE_SENTRY_DSN` zet
het script samen met `VITE_SENTRY_DSN` (zie "Foutbewaking"). Ontbreekt `PREVIEW_VITE_SUPABASE_URL` bij een app met
database, dan meldt de PR-job dat en komt er geen preview.

De databasesecrets staan in omgeving `production`, niet op de repo: een workflow op een
PR-tak kan repo-secrets lezen, maar niet die van een omgeving die tot `main` beperkt is.
`deploy-db.yml` draait zijn migratiejob daarom in omgeving `production` en migreert met
`supabase db push --db-url`, gebouwd uit de variabele `SUPABASE_PROJECT_REF` en het secret
`SUPABASE_DB_PASSWORD`. Er komt geen access token van Supabase in de app-repo: dat geeft
rechten op alle projecten van de organisatie en blijft in de beheer-omgeving.

De directe databaseverbinding (`db.<ref>.supabase.co`) is alleen via IPv6 bereikbaar, en
de runners van GitHub hebben geen IPv6. De inrichting haalt daarom de host van de session
pooler op bij Supabase en zet die als variabele `SUPABASE_POOLER_HOST` in `production` en
`preview`. `deploy-db.yml` migreert dan via de pooler, met gebruiker `postgres.<ref>`.
Geeft Supabase geen pooler terug, dan waarschuwt de inrichting en zet je hem met de hand
(Supabase > Connect > Session pooler). Bewezen bij de doorsteek van 29-09.

## De workflows draaien

De workflows draaien alleen vanaf `main` en nooit op een pull request.

**Proef inrichten** (`proef-inrichten.yml`), onder Actions > Proef inrichten > Run
workflow, of vanaf de terminal:

```sh
# 1. eerst kijken wat er zou gebeuren (de standaard)
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=true

# 2. echt inrichten
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=false

# 3. alleen voor een app van vóór versie 21: Access op de Worker zelf alsnog zetten
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=false -f tweede_doorgang=true
```

De workflow geeft `--voorvoegsel cf-proef-` mee. Alleen met dat voorvoegsel valt het
script terug op deze repo (`GITHUB_REPOSITORY`) en op `wrangler.jsonc` in de werkmap.

Stap 3 is normaal niet nodig. `workers_dev` staat in beide standen aan (anders tonen de
previews achter Access niets), dus de Access op de Worker moet er vóór de eerste uitrol
staan. Staat de Worker er nog niet, dan zet de inrichting eerst een placeholder-Worker neer die op
elk verzoek 503 "Deze app wordt ingericht." geeft, en meteen de Access op de Worker. Dat
gebeurt vóór de GitHub-variabelen, die de uitrol pas mogelijk maken. De eerste echte
uitrol (`wrangler deploy`) overschrijft de placeholder en landt zo meteen achter de
deur: er is geen moment waarop de app zonder Access op workers.dev staat. Dat werkt
ook als de inrichting in een andere repo draait dan de app.

In de standaardstand komt daarnaast de deur op het eigen domein. Stap 4 zit ook in elke
gewone run: voor een app die is ingericht voordat de placeholder bestond, zet die de
ontbrekende Access op de Worker alsnog.

Het resultaat staat in het logboek als één regel die begint met `INRICHTING`. Geheimen
staan daar nooit leesbaar in.

De workflow heeft ook het vinkje "Deur weghalen (klantportaal live zetten)"
(`-f deur_weghalen=true`, in het script `--deur-weghalen`). Dat is alleen voor een
klantportaal; zonder dat vinkje verandert geen enkele run iets aan de deur. Zie "Klantportaal".

**Proef controle van buitenaf** (`proef-controle.yml`) kijkt zonder inlog of de adressen van
een app dicht zijn (en bij een klantportaal: of alleen het domein open is). Je kiest alleen de
app; de adressen zoekt hij zelf op. Hij wijzigt niets. Zie "Controle van buitenaf".

Inloggen in productie loopt altijd via Cloudflare; in productie staat inloggen met e-mail
uit. Werkt de keten Cloudflare naar Supabase niet, dan herstellen we Cloudflare. Er is
geen tweede deur. De enige uitzondering is een app die in `toegang.json` als klantportaal
staat: zie "Klantportaal" hieronder.

**Proef toegang bijwerken** (`proef-toegang.yml`) draait vanzelf als `toegang.json` op
`main` verandert. Hij zet de policies gelijk aan het bestand, hangt ze aan de
Access-apps en trekt de toegang in van wie er niet meer in staat: een ban en afmelden
van alle sessies in Supabase. Bij een klantportaal geldt dat alleen voor medewerkers;
klanten staan niet in het bestand en blijven ongemoeid (zie "Klantportaal"). Kan hij bij een
klantportaal niet intrekken, dan gaat hij door met de andere apps en eindigt de run rood. In de testdatabase schrijft hij ook de aanmeld-hook
opnieuw, zodat die het nieuwe bestand volgt, en de testaccounts (met de testgebruiker)
blijven daar ongemoeid; een eerder geband testaccount krijgt de ban opgeheven.

## toegang.json

```json
{
  "groepen": {
    "kantoor": { "domeinen": ["klant.nl"], "uitsluiten": ["oud@klant.nl"] },
    "it": { "adressen": ["it@klant.nl"], "idp_groepen": ["<groeps-id in Entra>"] }
  },
  "apps": { "cf-proef": ["kantoor", "it"] },
  "testaccounts": { "cf-proef": ["schermtest@klant.nl"] }
}
```

Een groep zonder domeinen, adressen of IdP-groepen, een app zonder groep en een app met
een onbekende groep worden geweigerd; de melding noemt groep en veld.

`testaccounts` is optioneel: per app de adressen die in de testdatabase met e-mail en
wachtwoord mogen inloggen. Ze komen nooit in een Access-policy en nooit in productie.
`testgebruiker@stagetwo.nl` telt altijd mee, ook als hij er niet in staat.

**De lange vorm van een app.** In plaats van alleen een lijst groepen mag een app ook een
object zijn. De korte vorm blijft werken:

```json
"apps": {
  "direct": { "groepen": ["kantoor"], "publiek": ["/bekijk/*"], "gegevens_naar_test": false }
}
```

- `publiek`: paden die zonder inlog open zijn, bijvoorbeeld een link die je naar een
  klant stuurt. Elk pad begint met `/` en mag eindigen op `*`; de hele app (`/` of `/*`)
  kan niet. De inrichting maakt daarvoor één extra Access-app `<vv><app>-publiek` op het
  adres van de app (niet op de previews), met de herbruikbare policy `<vv>publiek`
  (beslissing bypass, iedereen). Die app wint van de deur, omdat hij specifieker is. De
  gebouwde bestanden (`/assets/*`) en de bestanden uit `public/` (iconen en manifest) gaan
  vanzelf mee, anders krijgt een bezoeker een lege pagina. Is de lijst leeg of weg, dan
  haalt de volgende run die app weg, en de policy als geen enkele app hem nog gebruikt.
  Toegang bijwerken doet dat ook, voor elke app die al een deur heeft. Staat er al een
  Access-app zonder voorvoegsel op zo'n pad (een omweg met de hand), dan stopt de inrichting
  tot je die weghaalt. Een groep mag niet `publiek` heten (zo heet die policy). Wat een
  publieke pagina mag tonen, staat in `docs/WERKWIJZE.md` (hoofdstuk 2). Het veld heet en
  werkt hetzelfde als `publiek` in tier 1. Eén verschil: tier 1 kent ook een site die bijna
  helemaal publiek is (`["/*"]` met `dicht`); tier 2 niet. Moet de hele app open voor
  klanten, dan is dat een klantportaal (hieronder), geen publiek pad. `publiek` en
  `klantportaal` kunnen niet samen bij één app.
- `gegevens_naar_test` (standaard `true`): met `false` zet Testdatabase verversen in de
  beheer-repo voor deze app geen gegevens en bestanden van productie meer in de
  testdatabase, maar ververst hij de testlogin wel. Handig als alle tabellen aan een
  gebruiker hangen en er toch niets te kopiëren valt.

- `klantportaal`, met `afzender`, `turnstile_sitekey`, `captcha` en `eigen_hooks`: zie het volgende hoofdstuk.

## Klantportaal

Een klantportaal is een app die open is voor klanten: een webshop of een portaal waar
honderden mensen van buiten het bedrijf zelf inloggen. In `toegang.json`:

```json
"apps": {
  "direct": {
    "groepen": ["kantoor"],
    "klantportaal": true,
    "afzender": "Voorbeeld Direct <noreply@voorbeeldapps.nl>",
    "turnstile_sitekey": "0x4AAAAAAA..."
  }
}
```

De groepen zijn dan alleen nog de medewerkers. Klanten staan nergens in het bestand: iedereen
mag per mail een account maken, en een nieuw account kan niets tot de app het goedkeurt.

**Een mens haalt de deur weg, niet de code.** App inrichten zet alles klaar en laat de deur
staan, hoe vaak je hem ook draait. De deur gaat alleen weg in een run waarin jij het vinkje
"Deur weghalen (klantportaal live zetten)" hebt gezet, en alleen als alles er vóór die run al
klaar voor stond.

### Van gewone app naar klantportaal: de stappen

Alles gaat via GitHub in de browser; je hebt geen eigen computer met commando's nodig.

**Stap 0. De app is er klaar voor.** De app staat op versie 43 of later (de pull request van
`/stagetwo-tier2:updaten` is gemerged) en de bouwer heeft de regels in de database nagelopen
(zie "De regels in de database zijn de enige grens" hieronder).

- Goed als: de bouwer dat bevestigt.
- Gaat het mis: sla je dit over, dan weigert stap 3 met "de app begrijpt de inlog van een
  klantportaal nog niet". Er is dan niets gewijzigd. Werk de app bij en begin opnieuw bij stap 3.

**Stap 1. Twee sleutels klaarzetten.**

| Waar | Wat je doet | Waar het heen gaat |
|---|---|---|
| Resend | het domein van de afzender verifiëren (bijvoorbeeld `voorbeeldapps.nl`) en een sleutel maken met alleen het recht om te versturen | secret `SMTP_WACHTWOORD` in de omgeving van de beheer-repo (Settings, Environments, waar ook `SUPABASE_ACCESS_TOKEN` staat) |
| Cloudflare, Turnstile, Add widget | een widget maken voor het domein van de app, stand Managed. Je krijgt twee sleutels | de geheime (Secret Key) als secret `TURNSTILE_GEHEIM` op dezelfde plek. De openbare (Site Key) bewaar je voor stap 2 |

- Goed als: beide secrets in de lijst van de omgeving staan.
- Gaat het mis: verwissel je de twee sleutels van Turnstile, dan weigert stap 3 met "dezelfde
  waarde" of "Turnstile kent dit geheim niet". Er is dan niets gewijzigd.

**Stap 2. Een pull request op `toegang.json`.** Zet bij de app `"klantportaal": true`,
`"afzender"` (een adres op het geverifieerde domein, of `"Naam <adres>"`; de naam staat in de
mail) en `"turnstile_sitekey"` (de openbare sleutel uit stap 1). Laat de pull request
goedkeuren en merge hem.

- Goed als: de workflow Toegang bijwerken daarna groen is. Hij zegt: "de deur staat er nog".
- Gaat het mis: een rode check op de pull request noemt het veld dat niet klopt.

**Stap 3. App inrichten draaien, zonder het vinkje.** Actions, App inrichten, Run workflow:
kies de app, zet "droogloop" uit en laat "Deur weghalen" uit. Deze run toetst de geheimen, zet
inloggen per mail, de captcha, de hooks en de variabelen voor de app klaar, en laat de deur
staan. Je mag hem zo vaak herhalen als je wilt; er verandert nooit iets aan de deur.

- Goed als: de run groen is en in het resultaat staat "de deur ... staat er nog ... Alles
  staat klaar".
- Gaat het mis: de run is rood en begint met "gestopt zonder wijzigingen", gevolgd door wat er
  ontbreekt en wat je doet. Er is dan niets gewijzigd. Los het op en draai stap 3 opnieuw.

**Stap 4. De app uitrollen en achter de deur testen.** Ga naar de app-repo: Actions,
Uitrollen, de laatste run, Re-run all jobs (of merge iets naar `main`). Open daarna het domein
van de app, ga door de deur zoals altijd, log uit, en log in per mail met een privéadres (niet
je werkadres: dat weigert het portaal voor medewerkers).

- Goed als: je de widget van de captcha ziet, de mail binnen een minuut komt, de code van acht
  cijfers werkt en de link in de mail ook. Controleer ook dat "Inloggen voor medewerkers" nog
  werkt.
- Gaat het mis: geen mail, kijk dan bij Resend (Logs) of het domein en de sleutel kloppen. Een
  melding over de captcha, dan is de app nog niet opnieuw uitgerold. Zie je geen inlog per
  mail, dan ook. De deur staat er nog, dus er is geen haast: los het op en test opnieuw.

**Stap 5. App inrichten draaien, met het vinkje.** Dezelfde workflow, nu met "Deur weghalen
(klantportaal live zetten)" aan. De run controleert eerst of alles uit stap 3 er nog staat, zet
dan de captcha (opnieuw) aan en haalt als allerlaatste de deur weg.

- Goed als: de run groen is en in het resultaat staat "weggehaald". Het domein is nu open.
- Gaat het mis: de run is rood met "de deur gaat niet weg, want ...". De deur staat er dan nog
  en er is niets gewijzigd. Doe wat er staat (meestal: stap 3 nog een keer) en probeer opnieuw.

**Stap 6. De knop Controle van buitenaf.** Actions, Controle van buitenaf, Run workflow, kies
de app. Je hoeft geen adressen te typen.

- Goed als: de run groen is: het domein is open, en het `workers.dev`-adres, de preview en de
  inlog voor medewerkers eindigen bij de loginpagina van Cloudflare. Log daarna zelf nog een
  keer in per mail, in een privévenster.
- Gaat het mis: staat er een kruis bij `workers.dev` of de preview, dan is er een adres open
  dat dicht hoort te zijn: draai App inrichten (zonder vinkje) en daarna de knop opnieuw.
  Blijft het kruis, zet dan de deur terug (hieronder) en meld het bij Stage Two.

### Als het misgaat: terug achter de deur

Werkt inloggen niet na stap 5, of wil je het portaal om een andere reden dicht: haal
`"klantportaal"`, `"afzender"`, `"turnstile_sitekey"` (en `"captcha"`, `"eigen_hooks"`) met een
pull request uit `toegang.json` en draai daarna App inrichten (zonder vinkje). De deur staat er
dan weer en inloggen per mail is uit. Geen klant wordt geband; zie "Terug naar een gewone app".
Tussen de pull request en App inrichten is Toegang bijwerken rood; dat is de bedoeling. Is het
probleem opgelost, dan begin je opnieuw bij stap 2.

### Wat er verandert, en wat dicht blijft

| Onderdeel | Gewone app | Klantportaal |
|---|---|---|
| Het eigen domein | achter de deur (Access-app `<vv><app>`) | open, geen Access-app (na stap 5) |
| `workers.dev` en de previews per pull request | dicht (Access op de Worker) | dicht, ongewijzigd |
| Inloggen voor medewerkers | via Cloudflare (SaaS-app `<vv><app>-inlog`, de groepen) | hetzelfde, ongewijzigd |
| Inloggen per mail in productie | uit | aan: een code van acht cijfers en een link, 15 minuten geldig |
| Inloggen met een wachtwoord | kan niet (e-mail staat uit) | kan niet: een hook weigert elke sessie met een wachtwoord |
| Een account maken per mail | kan niet | iedereen, behalve op een adres of domein van een medewerker (een hook) |
| Zelf je adres wijzigen | n.v.t. | kan niet: dat loopt via de eigenaar van de app |
| `mailer_autoconfirm` in productie | aan | uit: elk adres moet eerst bewezen worden |
| Captcha op het inlogformulier | n.v.t. | aan (Turnstile), tenzij er uitdrukkelijk `"captcha": false` staat |
| Sessieduur | de deur vraagt na 30 dagen opnieuw | een sessie vervalt na 30 dagen zonder gebruik (Supabase Pro of hoger) |
| Terugkeeradressen van productie | het domein en de previews | alleen het domein (met een testdatabase) |
| De testdatabase | e-mail alleen voor testaccounts | hetzelfde, ongewijzigd |
| `VITE_INLOGDIENST` | `cloudflare` | `cloudflare,mailcode` in `production`; de previews houden `cloudflare` |
| Toegang bijwerken | trekt iedereen in die niet in een groep staat | trekt alleen medewerkers in; klanten nooit |

### De regels in de database zijn de enige grens

Bij een gewone app komt niemand van buiten verder dan het inlogscherm van Cloudflare. Bij een
klantportaal kan iedereen ter wereld de app openen en een account maken. Wat zo iemand kan
zien of doen, bepalen alleen de regels in de database (RLS). Zet een app dus pas als
klantportaal in `toegang.json` als:

- elke tabel regels heeft die op de rol van de gebruiker letten, en een nieuw account niets
  ziet;
- een recht van een medewerker nooit hangt aan iets wat een klant zelf kan krijgen, zoals
  een e-mailadres of het account zelf. Een maillogin op het adres van een medewerker opent
  namelijk **hetzelfde account** als zijn inlog via Cloudflare; alleen de sessie verschilt.
  De app geeft medewerkerrechten daarom alleen aan een sessie die via Cloudflare kwam en niet
  ouder is dan 12 uur (de app leest dat uit `amr` in het token; zie de migratie
  `klantportaal` en `docs/routes/klantportaal.md` in de app). De beheercode dwingt die 12 uur
  niet af: Supabase kent maar één sessieduur voor iedereen;
- de app op versie 43 of later staat en het inlogscherm met beide manieren heeft, met een
  codevak van acht cijfers en de Turnstile-widget. De inrichting leest dat vóór de eerste
  wijziging uit de app-repo: `src/lib/env.ts` op `main` moet `VITE_INLOGDIENST` lezen met
  `leesInlogdiensten`. Een oudere app (of een app van de openbare template) start met
  `cloudflare,mailcode` niet meer op; dan stopt de inrichting.

De inrichting zet deze waarschuwing bij elke run in het resultaat.

### De deur en het vinkje

- Zonder het vinkje verandert geen enkele run iets aan de deur. Ook niet als de variabelen al
  goed staan, als een eerdere run halverwege stopte, of als iemand iets met de hand zette.
- Met het vinkje stopt de run vóór de eerste wijziging, met uitleg, als dit vóór de run nog
  niet zo was: `VITE_INLOGDIENST` = `cloudflare,mailcode` en de sleutel van de widget in
  omgeving `production` van de app-repo, en in Supabase inloggen per mail aan, de mail via
  Resend en de twee hooks aan. Dat is precies wat stap 3 zet.
- De deur is de allerlaatste aanroep van de run: mislukt er iets bij Supabase, Sentry of
  GitHub, dan staat de deur er nog.
- Of de app sinds stap 3 echt is uitgerold en of inloggen per mail werkt, kan de inrichting
  niet zien. Daarom is dat een stap voor een mens (stap 4), en daarom vraagt de deur een vinkje.
- De droogloop zegt bij de deur precies wat een run met en zonder vinkje zou doen.
- Toegang bijwerken en de tweede doorgang halen de deur nooit weg.

Ontbreekt `SMTP_WACHTWOORD` of `TURNSTILE_GEHEIM`, dan stopt App inrichten vóór de eerste
wijziging. De geheimen gaan alleen naar Supabase (en het geheim van Turnstile naar Turnstile
zelf, om het te toetsen) en staan nooit in het logboek of het resultaat, ook niet een stuk
ervan: van een fout van Supabase op de auth-instellingen toont de inrichting alleen de status
en de namen van de velden. De sleutel van Resend toetst de inrichting niet; dat doet stap 4.

Een klantportaal vraagt een eigen domein. In de tijdelijke stand (alleen `workers.dev`)
weigert de inrichting het: dat adres blijft altijd dicht.

**De Access op de Worker.** Stap 4 van elke run vergelijkt ook het adres van de Access op de
Worker met de naam van de Worker in `wrangler.jsonc`. Wijst hij naar een andere Worker (de
Worker is hernoemd, of iemand heeft de Access-app met de hand veranderd), dan zet de run hem
om en meldt het resultaat dat een Worker achter het oude adres nu zonder deur staat. Dat
geldt voor elke app, ook een gewone. Geeft Cloudflare de bestemmingen terug zonder adres (zo
beschrijft de API de nieuwe Worker-bestemmingen), dan is er niets te vergelijken: de run laat
het adres dan met rust en zegt dat in het resultaat. Gebruik dan de knop Controle van buitenaf.

### Captcha (Turnstile), standaard aan

Supabase Auth weigert elke aanvraag voor een inlogmail zonder geldig bewijs van de widget. De
geheime sleutel gaat naar Supabase, de openbare (`turnstile_sitekey`) zet de inrichting als
variabele `VITE_TURNSTILE_SITEKEY` in omgeving `production` van de app-repo; de app toont de
widget als die variabele er is. Medewerkers via Cloudflare merken er niets van, en de previews
(testdatabase) hebben geen captcha. De widget maak je met de hand (stap 1): de
Cloudflare-sleutel van de beheer-repo mag geen Turnstile-widgets maken.

- **Wanneer hij aangaat.** In dezelfde aanroep als het inloggen per mail (stap 3). Er is dus
  geen moment waarop inloggen per mail openstaat zonder captcha. Dat sluit niemand buiten: tot
  stap 5 staat de deur er, en achter de deur test alleen jij, met de uitgerolde app.
- **Het geheim wordt eerst getoetst.** Vóór de eerste wijziging vraagt de inrichting Turnstile
  één keer of het geheim bestaat. Een verkeerd geheim, of de openbare sleutel op de plek van
  de geheime (of andersom), stopt de run. Een `turnstile_sitekey` met de lengte van een geheim
  weigert `toegang.json` zelf al. Dat Turnstile een onbekend geheim zo meldt volgt uit de
  documentatie en is nog niet op een echte widget geprobeerd.
- **Een portaal dat al live is.** Daar verandert een run zonder vinkje niets aan de captcha;
  anders zou een nieuwe sleutel klanten buitensluiten tot de app ermee is uitgerold. Een nieuwe
  widget of een nieuw geheim gaat zo: pull request op `toegang.json` (bij een nieuwe widget),
  het secret vervangen, App inrichten zonder vinkje (zet de openbare sleutel klaar), de app
  uitrollen, en meteen daarna App inrichten met het vinkje (zet het geheim). Tussen die laatste
  twee kunnen klanten kort geen code aanvragen.
- **Uitzetten** kan alleen uitdrukkelijk, met `"captcha": false` bij de app. Dan gaat de
  captcha meteen uit, haalt de inrichting `VITE_TURNSTILE_SITEKEY` weg, en staat er bij elke
  run een waarschuwing in het resultaat. Doe dat alleen tijdelijk, bijvoorbeeld als Turnstile
  een storing heeft.

### Mail

De mail gaat via Resend over SMTP (`smtp.resend.com`, poort 465, gebruiker `resend`). Er is
één inlogmail, "Inloggen bij <naam>", in dezelfde vorm als het lokale sjabloon van de app
(`supabase/templates/inlogcode.html`): de code van acht cijfers en een link, allebei 15
minuten geldig en één keer te gebruiken. Supabase verstuurt hem in drie gevallen: een bekend
adres vraagt een code (`magic_link`), een adres zonder account (`confirmation`: de eerste keer
van een nieuwe klant, de eerste inlog van een nieuwe medewerker via Cloudflare, maar ook als
een ander dat adres opgeeft) en de herstelroute van Supabase (`recovery`; de code daaruit
werkt in hetzelfde codevak). Omdat een ander de mail kan uitlokken, staat erin wat je doet als
je er niet om vroeg: niets, niet klikken, de code aan niemand geven.

De code staat erbij omdat een link uit WhatsApp of Gmail vaak in een ingebouwde browser
opent. De link gaat naar de inlogpagina van de app
(`https://<domein>/login?token_hash=...&type=email`), niet naar Supabase: de pagina logt pas
in na een klik op een knop, zodat een linkscanner die links vooraf opent de link niet
verbruikt. Het domein in de link is altijd het eigen domein (`site_url`).

**Adres wijzigen loopt via de eigenaar van de app.** Supabase Auth laat een ingelogde
gebruiker zelf een ander adres aanvragen, buiten de hooks om, met een mail naar het adres dat
hij zelf kiest. Met de standaardmail van Supabase (een link die bij openen al bevestigt, ook
door de linkscanner van een mailserver) kon een klant zijn account zo op het adres van een
ander zetten. De inrichting zet daarom voor elke mail die Supabase Auth verder kan versturen
een eigen tekst zonder link en zonder code:

| Mail | Wat erin staat |
|---|---|
| adres wijzigen (`email_change`) | dat dit niet zelf kan en dat er niets is gewijzigd. Zonder link of code is de wijziging niet te bevestigen |
| controlecode (`reauthentication`) | dat die hier niet nodig is (hij hoort bij wachtwoorden, en die zijn er niet) |
| uitnodiging (`invite`, alleen uit het dashboard van Supabase) | een verwijzing naar de inlogpagina, waar de genodigde een code aanvraagt |

Daarnaast staat `mailer_secure_email_change_enabled` aan: wie de code van acht cijfers zou
willen raden om een wijziging toch te bevestigen, moet er twee raden. Wil een klant een ander
adres, dan regelt de eigenaar van de app dat (in de app zelf met een eigen functie, of in
Supabase onder Authentication, Users). Verstuurt het project zijn mail via een eigen hook
(send email), dan gaan de mails buiten deze teksten om; de inrichting stopt dan tot die hook
uit staat.

### De twee hooks

**Geen wachtwoorden.** Supabase Auth laat bij inloggen per mail ook aanmelden met een
wachtwoord toe, en heeft geen instelling om alleen dat uit te zetten. Zonder maatregel kan
iemand het adres van een klant aanmelden met een eigen wachtwoord, wachten tot de klant op
de mail klikt die daarvan komt, en daarna met dat wachtwoord inloggen. De functie
`public.<vv>portaal_voor_token` (custom-access-token-hook) weigert daarom elk token van een
sessie die met een wachtwoord begon, ook bij verversen. Alle andere tokens gaan ongewijzigd
door, dus `amr` en de andere claims blijven wat de regels in de database verwachten.

**Geen klantaccount op het adres van een medewerker.** De functie
`public.<vv>portaal_voor_aanmelden` (before-user-created-hook) weigert een aanmelding per
mail voor elk domein en elk adres uit de groepen van de app. Via Cloudflare blijft de
Access-policy de poort. Zonder deze hook kan een vreemde het adres van een toekomstige
medewerker aanmelden; die medewerker krijgt dan bij zijn eerste inlog via Cloudflare een
tweede account zonder adres. Toegang bijwerken schrijft de functie bij elke run opnieuw,
zodat hij de groepen volgt. Twee grenzen:

- Een groep met alleen `idp_groepen` heeft geen adressen; de hook kan die medewerkers niet
  beschermen. De inrichting waarschuwt dan bij elke run. Zet het domein van die medewerkers
  ook in een groep van de app.
- De hook loopt alleen bij een nieuw account. Een medewerker die al een account heeft, kan
  op zijn werkadres ook een mailcode aanvragen; dat opent hetzelfde account in een sessie
  zonder medewerkerrechten (zie hierboven).

**Eigen hooks van de app.** Een project heeft van elke soort maar één hook. Staat er al een
andere aanmeld- of token-hook aan, dan stopt App inrichten vóór de eerste wijziging (de
droogloop toont het ook) en vervangt hij niets. De bouwer van de app kiest:

- de eigen hook weghalen, of
- de weigering overnemen in de eigen hook en dat aangeven met `"eigen_hooks": true` bij de app
  in `toegang.json`. De eigen token-hook moet dan elk token weigeren waarvan
  `authentication_method` `password` is of waarvan `amr` in de claims `password` bevat; de
  eigen aanmeld-hook elke aanmelding per mail (`app_metadata.provider` = `email`) op een domein
  of adres uit de groepen, en elke aanmelding die niet per mail of via `custom:cloudflare`
  komt. De SQL van de twee functies van de inrichting is het voorbeeld
  (`portaalTokenHookSql` en `portaalAanmeldHookSql` in `lib/toegang.mjs`). De inrichting laat
  de eigen hook dan staan, controleert niet wat hij doet, en zegt dat bij elke run. Let op:
  een eigen aanmeld-hook volgt de groepen niet vanzelf als `toegang.json` verandert.

In een melding staat van een hook over HTTP alleen het schema en de host, nooit het pad of
een sleutel in het adres.

**Rechten.** Beide functies geven de rol van Supabase Auth (`supabase_auth_admin`) `usage` op
het schema `public` en `execute` op de functie, en nemen `execute` af van `authenticated`,
`anon` en `public`, zoals de documentatie van Supabase voorschrijft. Zo werken ze ook in een
app die het schema `public` heeft dichtgezet. Ze lezen geen tabellen.

Beide hooks zijn tegen een echte Postgres gedraaid met de invoer die Supabase Auth stuurt,
ook met het schema dichtgezet; dat Supabase Auth een weigering van de token-hook omzet in
"geen sessie" volgt uit de broncode (de hook loopt in dezelfde transactie als de nieuwe sessie)
en is nog niet op een echt project geprobeerd.

### De rem tegen misbruik

Een open inlogformulier dat mails verstuurt, wordt misbruikt: om iemand te bestoken met
mails, om kosten te maken bij Resend, of om codes te raden. De inrichting zet deze grenzen van
Supabase Auth, bij elke run opnieuw:

| Instelling | Waarde | Wat het doet |
|---|---|---|
| mails per uur, het hele project samen (`rate_limit_email_sent`) | 100 | Ruim voor een drukke ochtend (een klant logt zelden opnieuw in). Een mailbom kost hoogstens 2400 mails per dag. Is de grens bereikt, dan krijgt dat uur niemand meer een inlogmail |
| tijd tussen twee mails naar hetzelfde adres (`smtp_max_frequency`) | 60 seconden | Eén adres krijgt hoogstens één mail per minuut |
| aanvragen per IP-adres (`rate_limit_otp`) | 5 per vijf minuten, na een voorraad van 30 | Supabase heeft zes tellers per IP-adres (aanmelden, code, link, herstel, opnieuw sturen, account wijzigen), elk met een eigen voorraad van 30 die meteen op mag. De waarde vult daarna aan |
| pogingen om een code of link in te wisselen, per IP-adres (`rate_limit_verify`) | 5 per vijf minuten, na een voorraad van 30 | 1470 gokken per IP-adres per dag (30 uit de voorraad, daarna 5 per vijf minuten), op honderd miljoen mogelijkheden |

Vier dingen om eerlijk over te zijn:

- **De tellers per IP-adres houden één mens tegen, geen aanvaller.** Door de voorraad van 30
  per teller (vast in Supabase, niet in te stellen) kan één computer zonder captcha in een paar
  minuten de 100 mails van het uur opmaken. Daarom staat de captcha standaard aan.
- **Een code raden.** Een fout antwoord maakt een code niet ongeldig; daarom acht cijfers in
  plaats van zes. Met 1470 gokken per IP-adres per dag en honderd IP-adressen is de kans op één
  goede gok ongeveer 0,15 procent per dag (met zes cijfers was dat ruim 13 procent).
- **De aanname over IPv6.** Die som klopt alleen als "een IP-adres" ook echt één aanvaller is.
  In de broncode telt Supabase Auth per letterlijk adres, en één gewone internetaansluiting met
  IPv6 heeft er miljarden. Telt het platform van Supabase zulke adressen niet samen, dan haalt
  één aanvaller met 65.000 adressen een kans van ruim de helft per dag. Wij weten niet hoe het
  platform dat doet. Vraag dit bij Supabase na vóór een klant live gaat, en kies anders voor
  een code van tien cijfers (`CODE_LENGTE`, samen met het codevak in de app).
- **Een ingelogde klant kan zelf mails uitlokken.** Adres wijzigen en de controlecode vragen
  geen captcha. Eén account kan zo ruim honderd mails per uur laten versturen (één per minuut
  per soort, naar zijn eigen en een zelfgekozen adres) en daarmee de mailgrens van dat uur
  opmaken; andere klanten krijgen dan dat uur geen inlogmail. In die mails staat niets
  bruikbaars, en de afzender is een bekend account dat de eigenaar van de app kan blokkeren
  (Supabase, Authentication, Users). Zie je dit in de logs van Resend, doe dat dan.

De getallen staan op één plek (`REM`, `CODE_LENGTE`, `GOKKEN_PER_DAG` en `SESSIE` in
`lib/supabase.mjs`); wie ze met de hand in Supabase verandert, ziet ze bij de volgende run
terugkomen.

### Sessieduur

Bij een gewone app vraagt de deur elke 30 dagen opnieuw om in te loggen. Een klantportaal
heeft geen deur; zonder grens bleef een sessie voorgoed geldig, ook die van een vertrokken
medewerker op een groep met een domein (zo iemand staat nog "in de groep" tot iemand hem
uitsluit). De inrichting zet daarom `sessions_inactivity_timeout` op 720 uur: een sessie die
30 dagen niet is gebruikt, vervalt. Geen vaste einddatum (`sessions_timebox`): die zou elke
klant op een vaste dag uitloggen. Supabase biedt dit alleen op het Pro-plan en hoger; weigert
het project de instelling, dan loopt de inrichting door en staat het als waarschuwing in het
resultaat. De grens van 12 uur voor medewerkerrechten dwingt de app af.

### De previews horen bij de testdatabase

Een preview van een pull request draait code die nog niet is nagekeken. Bij een gewone app
staan de previews op de lijst van adressen waar productie na het inloggen naar terug mag,
omdat een app zonder testdatabase zijn previews bij productie laat inloggen. Bij een
klantportaal met een testdatabase haalt de inrichting ze van de lijst van productie: daar
staat alleen nog het eigen domein, en de previews loggen in bij de testdatabase. Zo kan een
preview nooit een medewerker bij productie laten inloggen en het token ontvangen. Heeft een
klantportaal geen testdatabase, dan blijven de previews op de lijst (anders werkt geen
preview meer) en waarschuwt elke run: geef de app een testdatabase.

### Toegang bijwerken bij een klantportaal

In het bestand staan alleen medewerkers. Daarom beoordeelt Toegang bijwerken alleen accounts
met een inlog via Cloudflare. Of een account die heeft, leest hij uit de database van de app
(`auth.identities`).

- Een account zonder Cloudflare-inlog is een klant: geen ban, geen afmelding. Een klant die
  de app of de owner zelf heeft geblokkeerd, blijft geblokkeerd. Het resultaat noemt het
  aantal overgeslagen klanten.
- Een medewerker die uit `toegang.json` gaat, wordt net als altijd geband en afgemeld.
- Een account dat via Cloudflare én per mail kan inloggen gaat helemaal dicht zodra de
  medewerker uit het bestand is, ook de klantkant. Dat is bewust: alleen de Cloudflare-kant
  sluiten zou een vertrokken medewerker een werkend account laten houden. Het resultaat
  noemt zo'n account apart. Moet zo iemand daarna klant kunnen zijn, verwijder dan zijn
  account in Supabase (Authentication, Users); hij logt daarna per mail in en begint als
  nieuwe klant. Alleen de ban opheffen helpt niet: de volgende run zet hem terug.
- Beoordeeld wordt het adres waarmee Cloudflare iemand binnenliet, niet een adres dat hij
  zelf op zijn account zette.
- Zelf een inlog van een account afhalen staat uit (`security_manual_linking_enabled`), zodat
  een medewerker zijn Cloudflare-inlog niet kan loskoppelen om als klant door te gaan.
- De aanmeld-hook van productie wordt opnieuw geschreven, zodat hij de groepen volgt.
- **Lukt het bij een klantportaal niet** (de leesvraag naar de database mislukt
  bijvoorbeeld), dan trekt hij bij die app niemand in, gaat hij door met de andere apps, en
  eindigt de run rood met de reden. Los het op en start Toegang bijwerken opnieuw.

**Een klantaccount op het adres van een medewerker.** Wordt een klant medewerker (zijn adres
komt in een groep), of gebruikte een medewerker het klantvak voordat de hook er was, dan
bestaat er een klantaccount op een adres van een medewerker. Zolang dat account bestaat kan
die persoon niet als medewerker inloggen: Supabase maakt bij zijn inlog via Cloudflare een
tweede account zonder adres, dat niet te bevestigen is. Toegang bijwerken en App inrichten
melden zulke accounts bij elke run en in de droogloop, met het adres gemaskeerd
(`j***@klant.nl`) en de id van het account erbij. Ze ruimen niets op. Wat de owner doet:
overleg met de persoon, laat de eigenaar van de app zo nodig overzetten wat aan het
klantaccount hing, verwijder het account in Supabase (Authentication, Users; zoek op de id) en
laat de persoon daarna inloggen via "Inloggen voor medewerkers". Heeft hij dat al geprobeerd,
verwijder dan ook het account zonder adres dat daarbij ontstond; Toegang bijwerken meldt dat
apart.

**Medewerkers bij een klantportaal.** Omdat elk adres nu eerst bewezen moet worden
(`mailer_autoconfirm` uit) en Cloudflare aan Supabase niet meldt dat een adres gecontroleerd
is, merken medewerkers dit (nagespeeld tegen Supabase Auth, 13-11-2026):

- Wie al een account had, merkt niets.
- Een nieuwe medewerker krijgt bij zijn eerste inlog via Cloudflare één keer de melding dat
  zijn adres bevestigd moet worden, en de inlogmail. Na de code of de link in die
  mail werkt inloggen voor medewerkers gewoon.

### Terug naar een gewone app

Haal `klantportaal`, `afzender`, `turnstile_sitekey` (en `captcha`, `eigen_hooks`) weg en draai
daarna App inrichten. **Een portaal sluiten bant geen klanten.**

1. Zodra het bestand op `main` staat, draait Toegang bijwerken. Die ziet een app die volgens
   het bestand gewoon is, maar waar inloggen per mail nog aan staat en geen deur is. Hij
   beoordeelt de medewerkers zoals altijd (wie uit het bestand is, wordt ingetrokken), laat de
   klanten met rust, en **eindigt rood** met de uitleg: draai App inrichten. Was het een
   vergissing (iemand schreef de korte vorm), zet dan `"klantportaal": true` terug; er is
   geen klant geraakt.
2. App inrichten zegt in de droogloop en in het resultaat dat het klantportaal dichtgaat.
   De echte run zet inloggen per mail uit, geeft elk klantaccount (een account zonder inlog
   via Cloudflare) het kenmerk `klantportaal_klant` en meldt de klanten af, en zet de deur
   terug. Niemand wordt geband.
3. Daarna is het een gewone app. Toegang bijwerken slaat accounts met dat kenmerk voorgoed
   over (het resultaat noemt het aantal) en trekt verder in zoals altijd. Wordt de app later
   weer een klantportaal, dan kunnen dezelfde klanten weer inloggen.

De instellingen voor SMTP, de mailsjablonen, de hooks en de sessieduur blijven in Supabase
staan; zonder inloggen per mail doen ze niets. App inrichten herhaalt het markeren bij elke
run van zo'n app (één vraag aan de database), zodat een run die halverwege stopte het de
volgende keer afmaakt. Stond de deur er nog toen het portaal werd teruggedraaid (het was nog
niet live), dan zijn accounts die per mail zijn gemaakt gewone vreemden en trekt Toegang
bijwerken ze in tot App inrichten heeft gedraaid; draai die dus eerst.

**Wat een gewone app hiervan merkt: niets.** Een app die nooit klantportaal was, krijgt
exact dezelfde aanroepen als op versie 42, ook als zijn deur ontbreekt of in Cloudflare een
andere naam heeft gekregen: Toegang bijwerken trekt dan gewoon in. Er is één uitzondering van
één leesvraag (de auth-instellingen van productie): als de deur ontbreekt én er een account
ingetrokken zou worden dat alleen per mail kan inloggen en geen kenmerk heeft. Zo ziet een
klant eruit, en dan kijkt hij eerst of inloggen per mail aan staat (of het sluiten halverwege
bleef steken). Een app die via Cloudflare inlogt heeft zulke accounts niet. Een gewone app met
een deur krijgt die leesvraag nooit.

### Controle van buitenaf

De workflow Controle van buitenaf (in de proef `proef-controle.yml`) draait
`controle-doorsteek.mjs --app <naam>`. Het script zoekt zelf op wat de inrichting kent: het
domein (uit `wrangler.jsonc`), het `workers.dev`-adres, de vaste preview
(`actueel-<worker>...`), het project en de openbare sleutel van Supabase, en of de app een
klantportaal is. Het wijzigt niets.

Bij een klantportaal hoort het domein open te zijn en de rest dicht, en "dicht" is daar
streng: alleen een doorverwijzing naar de loginpagina van Cloudflare Access (van het eigen
team) telt. Een adres dat niet bestaat, niet bereikbaar is of 404 geeft, bewijst niets en is
gezakt. Bij een gewone app is de controle zoals hij was.

## Alleen IT mag toegang.json wijzigen (bij een klant)

`.github/CODEOWNERS` wijst `/beheer/toegang.json` aan een eigenaar toe. Op zichzelf
blokkeert dat niets. Zo maakt de klant de review verplicht:

1. Vervang in `.github/CODEOWNERS` `@StageTwoAI` op de regel van `toegang.json` door het
   IT-team van de klant, bijvoorbeeld `@klant-org/it`.
2. Settings > Rules > Rulesets > New branch ruleset, doel: de standaardtak (`main`).
3. Zet aan: "Require a pull request before merging" en daaronder "Require review from
   Code Owners".
4. Bypass-lijst leeg laten, ruleset op Active.

Vanaf dan kan een wijziging aan `toegang.json` alleen gemerged worden met een
goedkeuring van IT. Andere bestanden hebben geen eigenaar met verplichte review, dus
de rest van het werk loopt gewoon door.

## Opruimen

Verwijdert wat het script met het voorvoegsel (hier `cf-proef-`) voor de app en de
groepen in `toegang.json` maakte, in omgekeerde volgorde: Access
op de Worker, de GitHub-variabelen en -secrets die het script zette (ook een oud
databasesecret op de repo zelf), de Access-app op de
hostname, de custom provider, de SaaS-app, het Worker-script, de policies en als
laatste het Supabase-project. Het Worker-script gaat alleen weg met de exacte naam uit
`wrangler.jsonc`; staat hij er niet (meer), dan is dat geen fout. Alles zonder voorvoegsel blijft staan, en ook een naam
met het voorvoegsel die niet uit die app of groepen volgt (daar komt een waarschuwing).
Eerst kijken:

```sh
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=true -f opruimen=true
```

Dan echt:

```sh
gh workflow run proef-inrichten.yml --ref main -f app=cf-proef -f droogloop=false -f opruimen=true
```

Zonder `wrangler.jsonc` (bijvoorbeeld opruimen zonder uitgecheckte app-repo) blijft
elk Worker-script staan; verwijder het dan in het Cloudflare-dashboard (Workers & Pages
> cf-proef > Settings > Delete).

## Los van de template (beheer-repo)

`beheer/` draait ook zonder de rest van de template, bijvoorbeeld in de beheer-repo van
een klant die een app-repo in een andere repo of organisatie inricht. Kopieer daarvoor:

- de map `beheer/` (met `package.json`);
- het bestand `scripts/lib/cloudflare-config.mjs`, **op hetzelfde relatieve pad**
  (`../scripts/lib/cloudflare-config.mjs` vanuit `beheer/`). Het script importeert daar
  de controle van `wrangler.jsonc` vandaan.

Daarna:

```sh
cd beheer
pnpm install
pnpm test
```

Buiten de proef zijn `--voorvoegsel` (of `BEHEER_VOORVOEGSEL`), `--repo` en `--wrangler`
verplicht. Draait het script in GitHub Actions zonder `--repo`, dan stopt het: alleen de
proef mag terugvallen op `GITHUB_REPOSITORY`. `--wrangler` wijst naar de
`wrangler.jsonc` van de uitgecheckte app-repo. Bijvoorbeeld:

```sh
node beheer/inrichten-cloudflare.mjs --voorvoegsel kl- --app shop \
  --repo klant-org/shop-start --wrangler app/wrangler.jsonc --droogloop
```

`gh` gebruikt `GH_TOKEN`. In een beheer-repo is dat het kortlevende token van de GitHub
App van de klant (`actions/create-github-app-token`), met rechten op secrets,
variabelen, omgevingen en inhoud van de app-repo; zie
`klant/.github/workflows/app-inrichten.yml` in beheer-template.

## Lokaal testen

```sh
pnpm beheer:test
```

De tests praten met een nagebootste Cloudflare, Supabase en GitHub; er gaat niets
over het netwerk.

`regressie-42-versie.test.mjs` doet hetzelfde zonder vastgelegde verwachting: hij haalt de
code van versie 42 uit git naar een tijdelijke map (die hij weer weghaalt), draait daar en hier
zwaardere scenario's (2300 accounts, IdP-groepen, een fout halverwege, en een gewone app
waarvan de deur is hernoemd, is weggehaald of er nooit was terwijl er iemand in te trekken is)
en legt ze naast elkaar. In een losse kopie van `beheer/` zonder git slaat hij zichzelf over.

`regressie-42.test.mjs` bewaakt de bestaande klanten: voor een `toegang.json` zonder
`klantportaal` moet elke aanroep naar Cloudflare, Supabase en GitHub exact gelijk zijn aan
die van versie 42, in volgorde en inhoud, ook de leesvragen. De verwachting
(`regressie-42.json`) is gemaakt met de code van versie 42 zelf; `regressie-42.maak.mjs`
zegt hoe. Wordt deze test rood, dan verandert er iets voor een gewone app: los dat op in de
code, en leg de verwachting alleen opnieuw vast als die verandering de bedoeling is.
