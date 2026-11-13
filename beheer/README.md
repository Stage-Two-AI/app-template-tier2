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
| `controle-doorsteek.mjs` | kijkt van buitenaf of de deur dicht zit (en bij een klantportaal: of alleen het domein open is) |
| `toegang.json` | wie bij welke app mag |
| `package.json` | maakt van `beheer/` een zelfstandig pakket (zie "Los van de template") |
| `*.test.mjs`, `nep-wolk.mjs` | tests tegen een nagebootste API (`pnpm beheer:test`) |
| `regressie-42.*`, `regressie-scenarios.mjs` | bewijs dat een app zonder `klantportaal` exact dezelfde inrichting krijgt als op versie 42 (zie "Lokaal testen") |
| `klantportaal*.test.mjs`, `klantportaal-opzet.mjs` | het klantportaal, en per onderwerp (deur, intrekken, inlog, geheimen) de aanvallen die erop zijn geprobeerd, als tests die bewijzen dat ze mislukken |

Alles wat het script aanmaakt heeft een naam die begint met het voorvoegsel. Dat is een
verplichte instelling: `--voorvoegsel <vv->` of de omgevingsvariabele
`BEHEER_VOORVOEGSEL` (de vlag gaat voor). De proef gebruikt `cf-proef-`, Richplant `rp-`.
Het patroon is streng: een kleine letter, hoogstens vijftien kleine letters of cijfers,
en precies één streepje, aan het eind (`rp-`, niet `rp-x-`). `cf-proef-` is de enige
uitzondering; `cf-` zelf wordt geweigerd. Zo kan geen voorvoegsel met een ander
voorvoegsel beginnen, en neemt opruimen met het ene nooit iets van het andere mee.
Zonder voorvoegsel start het script niet.

Wat al bestaat met het voorvoegsel wordt hergebruikt. Opruimen raakt alleen de exacte
namen die het script voor de app en de groepen in `toegang.json` maakt; een andere naam
met het voorvoegsel blijft staan, met een waarschuwing. Bestaat er iets met dezelfde
naam zónder voorvoegsel, of staat er al een andere Access-app op de hostname, dan stopt
het script voordat het iets wijzigt. De aanmeld-hookfunctie van de testdatabase heet ook
naar het voorvoegsel (`cf_proef_voor_aanmelden`, `rp_voor_aanmelden`).

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

Beide workflows draaien alleen vanaf `main` en nooit op een pull request.

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

Inloggen in productie loopt altijd via Cloudflare; in productie staat inloggen met e-mail
uit. Werkt de keten Cloudflare naar Supabase niet, dan herstellen we Cloudflare. Er is
geen tweede deur. De enige uitzondering is een app die in `toegang.json` als klantportaal
staat: zie "Klantportaal" hieronder.

**Proef toegang bijwerken** (`proef-toegang.yml`) draait vanzelf als `toegang.json` op
`main` verandert. Hij zet de policies gelijk aan het bestand, hangt ze aan de
Access-apps en trekt de toegang in van wie er niet meer in staat: een ban en afmelden
van alle sessies in Supabase. Bij een klantportaal geldt dat alleen voor medewerkers;
klanten staan niet in het bestand en blijven ongemoeid (zie "Klantportaal"). In de testdatabase schrijft hij ook de aanmeld-hook
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

- `klantportaal`, met `afzender`, `turnstile_sitekey` en `captcha`: zie het volgende hoofdstuk.

## Klantportaal

Een klantportaal is een app die open is voor klanten: een webshop of een portaal waar
honderden mensen van buiten het bedrijf zelf inloggen. In `toegang.json`:

```json
"apps": {
  "direct": {
    "groepen": ["kantoor"],
    "klantportaal": true,
    "afzender": "Winco Direct <noreply@wincoapps.com>",
    "turnstile_sitekey": "0x4AAAAAAA..."
  }
}
```

De groepen zijn dan alleen nog de medewerkers. Klanten staan nergens in het bestand: iedereen
mag per mail een account maken, en een nieuw account kan niets tot de app het goedkeurt.

**Wat er verandert, en wat dicht blijft.**

| Onderdeel | Gewone app | Klantportaal |
|---|---|---|
| Het eigen domein | achter de deur (Access-app `<vv><app>`) | open, geen Access-app |
| `workers.dev` en de previews per pull request | dicht (Access op de Worker) | dicht, ongewijzigd |
| Inloggen voor medewerkers | via Cloudflare (SaaS-app `<vv><app>-inlog`, de groepen) | hetzelfde, ongewijzigd |
| Inloggen per mail in productie | uit | aan: een code van acht cijfers en een link, 15 minuten geldig |
| Inloggen met een wachtwoord | kan niet (e-mail staat uit) | kan niet: een hook weigert elke sessie met een wachtwoord |
| Een account maken per mail | kan niet | iedereen, behalve op een adres of domein van een medewerker (een hook) |
| `mailer_autoconfirm` in productie | aan | uit: elk adres moet eerst bewezen worden |
| Captcha op het inlogformulier | n.v.t. | aan (Turnstile, vanaf de tweede run), tenzij er uitdrukkelijk `"captcha": false` staat |
| Sessieduur | de deur vraagt na 30 dagen opnieuw | een sessie vervalt na 30 dagen zonder gebruik (Supabase Pro of hoger) |
| De testdatabase | e-mail alleen voor testaccounts | hetzelfde, ongewijzigd |
| `VITE_INLOGDIENST` | `cloudflare` | `cloudflare,mailcode` in `production`; de previews houden `cloudflare` |
| Toegang bijwerken | trekt iedereen in die niet in een groep staat | trekt alleen medewerkers in; klanten nooit |

**De regels in de database zijn nu de enige grens.** Bij een gewone app komt niemand van
buiten verder dan het inlogscherm van Cloudflare. Bij een klantportaal kan iedereen ter
wereld de app openen en een account maken. Wat zo iemand kan zien of doen, bepalen alleen de
regels in de database (RLS). Zet een app dus pas als klantportaal in `toegang.json` als:

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
  codevak van acht cijfers en de Turnstile-widget. Een oudere app begrijpt
  `cloudflare,mailcode` niet.

De inrichting zet deze waarschuwing bij elke run in het resultaat.

**Wat de owner met de hand doet, in deze volgorde.**

1. Bij Resend het domein van de afzender verifiëren (bijvoorbeeld `wincoapps.com`) en een
   sleutel maken met alleen het recht om te versturen. Die sleutel als secret
   `SMTP_WACHTWOORD` in de omgeving van de beheer-repo zetten (waar ook
   `SUPABASE_ACCESS_TOKEN` staat).
2. In het Cloudflare-dashboard (Turnstile, Add widget) een widget maken voor het domein van
   de app, in de stand Managed. Je krijgt twee sleutels. De geheime (Secret Key) gaat als
   secret `TURNSTILE_GEHEIM` in de omgeving van de beheer-repo. De openbare (Site Key) komt
   in stap 3 in `toegang.json`.
3. In `toegang.json` bij de app `"klantportaal": true`, `"afzender"` en `"turnstile_sitekey"`
   zetten, via een pull request. De afzender is een adres op het geverifieerde domein, of
   `"Naam <adres>"`; de naam staat in het onderwerp en de tekst van de mail. Zonder naam is
   dat de naam van de app.
4. App inrichten draaien, eerst als droogloop (die toont wat er zou gebeuren), daarna echt.
   **Na deze eerste run staat de deur er nog, en de captcha is nog niet aan.** De rest staat
   klaar: inloggen per mail, de hooks en de variabelen voor de app (ook de sleutel van de
   widget).
5. De app opnieuw uitrollen: iets naar `main` van de app-repo mergen, of daar de laatste run
   van de workflow Uitrollen opnieuw starten. Pas dan toont de app in productie het inloggen
   per mail en de widget van de captcha.
6. Achter de deur kijken of het werkt: open het domein, ga door de deur, log uit en log in
   per mail (code en link). De widget hoort zichtbaar te zijn. Controleer ook dat inloggen
   voor medewerkers nog werkt.
7. App inrichten nog een keer draaien. Deze tweede run zet de captcha aan en haalt daarna de
   deur weg, als allerlaatste stap. Het domein is vanaf dat moment open. Log daarna nog een
   keer per mail in, nu met de captcha aan.
8. Controleren van buitenaf: `node beheer/controle-doorsteek.mjs --klantportaal ...` met
   `--workers-dev` en `--preview-url` (bijvoorbeeld het vaste adres
   `https://actueel-<worker>.<subdomein>.workers.dev/`). Beide zijn bij een klantportaal
   verplicht: het domein hoort open te zijn, `workers.dev` en de previews dicht.

De workflow App inrichten moet beide secrets doorgeven aan het script, als `SMTP_WACHTWOORD`
en `TURNSTILE_GEHEIM` in de omgeving van de stap (in de proef doet `proef-inrichten.yml`
dat). Toegang bijwerken heeft ze niet nodig.

**Waarom de deur in twee runs weggaat.** De deur gaat pas weg in een run waarin productie
vóór de run al op de mail-inlog stond (`VITE_INLOGDIENST` = `cloudflare,mailcode`) en de
captcha niet meer wacht. De eerste
run zet die variabele pas; de app die dan in productie draait is nog gebouwd zonder
mail-inlog, en zonder deur zou een klant een open site zien waar hij niet kan inloggen. De
deur is bovendien de allerlaatste aanroep van de run: mislukt er iets bij Supabase, Sentry of
GitHub, dan staat de deur er nog. Of er tussen de twee runs echt is uitgerold, ziet de
inrichting niet (daarvoor zou de sleutel van de beheer-repo ook de workflows van de app
moeten mogen lezen); dat is stap 5 en 6 hierboven.

Ontbreekt `SMTP_WACHTWOORD` of `TURNSTILE_GEHEIM`, dan stopt App inrichten vóór de eerste
wijziging, met een melding. De geheimen gaan alleen naar Supabase en staan nooit in het
logboek of het resultaat, ook niet een stuk ervan. Een nieuwe sleutel bij Resend of
Turnstile: het secret vervangen en App inrichten opnieuw draaien.

Een klantportaal vraagt een eigen domein. In de tijdelijke stand (alleen `workers.dev`)
weigert de inrichting het: dat adres blijft altijd dicht.

**De Access op de Worker.** Stap 4 van elke run vergelijkt ook het adres van de Access op de
Worker met de naam van de Worker in `wrangler.jsonc`. Wijst hij naar een andere Worker (de
Worker is hernoemd, of iemand heeft de Access-app met de hand veranderd), dan zet de run hem
om en meldt het resultaat dat een Worker achter het oude adres nu zonder deur staat. Dat
geldt voor elke app, ook een gewone.

**Mail.** De mail gaat via Resend over SMTP (`smtp.resend.com`, poort 465, gebruiker
`resend`). Er is één mail, "Inloggen bij <naam>", in dezelfde vorm als het lokale sjabloon van
de app (`supabase/templates/inlogcode.html`): de code van acht cijfers en een link, allebei
15 minuten geldig en één keer te gebruiken. Supabase verstuurt hem in drie gevallen: een
bekend adres vraagt een code (`magic_link`), een adres zonder account (`confirmation`: de
eerste keer van een nieuwe klant, de eerste inlog van een nieuwe medewerker via Cloudflare,
maar ook als een ander dat adres opgeeft) en de herstelroute van Supabase (`recovery`; de code
daaruit werkt in hetzelfde codevak). Omdat een ander de mail kan uitlokken, staat erin wat je
doet als je er niet om vroeg: niets, niet klikken, de code aan niemand geven.

De code staat erbij omdat een link uit WhatsApp of Gmail vaak in een ingebouwde browser
opent. De link gaat naar de inlogpagina van de app
(`https://<domein>/login?token_hash=...&type=email`), niet naar Supabase: de pagina logt pas
in na een klik op een knop, zodat een linkscanner die links vooraf opent de link niet
verbruikt. Het domein in de link is altijd het eigen domein (`site_url`); een aanvrager kan de
link dus niet naar een ander toegestaan adres sturen, zoals een preview.

**Geen wachtwoorden (hook).** Supabase Auth laat bij inloggen per mail ook aanmelden met een
wachtwoord toe, en heeft geen instelling om alleen dat uit te zetten. Zonder maatregel kan
iemand het adres van een klant aanmelden met een eigen wachtwoord, wachten tot de klant op
de mail klikt die daarvan komt, en daarna met dat wachtwoord inloggen. De inrichting zet daarom in
de productiedatabase de functie `public.<vv>portaal_voor_token` en schakelt die in als
custom-access-token-hook: hij weigert elk token van een sessie die met een wachtwoord begon,
ook bij verversen. Alle andere tokens gaan ongewijzigd door, dus `amr` en de andere claims
blijven wat de regels in de database verwachten. Een project heeft maar één zo'n hook: heeft
de app er zelf een nodig, dan moet die deze weigering overnemen; de inrichting zet bij elke
run haar eigen functie terug en waarschuwt als ze een andere verving.

**Geen klantaccount op het adres van een medewerker (hook).** De functie
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

Beide hooks zijn tegen een echte Postgres gedraaid met de invoer die Supabase Auth stuurt;
dat Supabase Auth een weigering van de token-hook omzet in "geen sessie" volgt uit de
broncode (de hook loopt in dezelfde transactie als de nieuwe sessie) en is nog niet op een
echt project geprobeerd.

**De rem tegen misbruik.** Een open inlogformulier dat mails verstuurt, wordt misbruikt: om
iemand te bestoken met mails, om kosten te maken bij Resend, of om codes te raden. De
inrichting zet deze grenzen van Supabase Auth, bij elke run opnieuw:

| Instelling | Waarde | Wat het doet |
|---|---|---|
| mails per uur, het hele project samen (`rate_limit_email_sent`) | 100 | Ruim voor een drukke ochtend (een klant logt zelden opnieuw in). Een mailbom kost hoogstens 2400 mails per dag. Is de grens bereikt, dan krijgt dat uur niemand meer een inlogmail |
| tijd tussen twee mails naar hetzelfde adres (`smtp_max_frequency`) | 60 seconden | Eén adres krijgt hoogstens één mail per minuut |
| aanvragen per IP-adres (`rate_limit_otp`) | 5 per vijf minuten, na een voorraad van 30 | Supabase heeft zes tellers per IP-adres (aanmelden, code, link, herstel, opnieuw sturen, account wijzigen), elk met een eigen voorraad van 30 die meteen op mag. De waarde vult daarna aan |
| pogingen om een code of link in te wisselen, per IP-adres (`rate_limit_verify`) | 5 per vijf minuten, na een voorraad van 30 | In het kwartier dat een code geldt zijn dat 30 + 15 = 45 gokken per IP-adres, op honderd miljoen mogelijkheden |

Twee dingen om eerlijk over te zijn. De tellers per IP-adres houden één mens tegen, geen
aanvaller: door de voorraad van 30 per teller (vast in Supabase, niet in te stellen) kan één
computer zonder captcha in een paar minuten de 100 mails van het uur opmaken. Daarom staat de
captcha standaard aan. En een fout antwoord maakt een code niet ongeldig; daarom acht cijfers
in plaats van zes. Met honderd IP-adressen een dag lang raden is de kans op één goede gok
ongeveer een half procent (met zes cijfers was dat ruim een derde). De getallen staan op één
plek (`REM`, `CODE_LENGTE` en `SESSIE` in `lib/supabase.mjs`); wie ze met de hand in Supabase
verandert, ziet ze bij de volgende run terugkomen.

**Captcha (Turnstile), standaard aan.** Supabase Auth weigert dan elke aanvraag voor een
inlogmail zonder geldig bewijs van de widget. De geheime sleutel gaat naar Supabase, de
openbare (`turnstile_sitekey`) zet de inrichting als variabele `VITE_TURNSTILE_SITEKEY` in
omgeving `production` van de app-repo; de app toont de widget als die variabele er is.
Medewerkers via Cloudflare merken er niets van, en de previews (testdatabase) hebben geen
captcha. De widget maak je met de hand (stap 2 hierboven): de Cloudflare-sleutel van de
beheer-repo mag geen Turnstile-widgets maken (dat vraagt het recht Turnstile Sites Write), en
dat recht krijgt hij er niet voor bij.

De volgorde sluit niemand buiten: de inrichting zet de captcha in Supabase pas aan in een run
waarin de sleutel vóór de run al in omgeving `production` stond. De eerste run zet de
variabele en laat de captcha zoals hij was; na een uitrol van de app toont de app de widget,
en de tweede run zet de captcha aan. Zou de captcha eerder aan gaan, dan kon geen klant meer
een code aanvragen. Hetzelfde geldt voor een nieuwe widget op een draaiend portaal: de oude
blijft werken tot de app met de nieuwe sleutel is uitgerold en App inrichten nog een keer
heeft gedraaid. Bij de overgang van deur naar klantportaal valt dat samen met de twee runs
van de deur; de deur gaat niet weg zolang de captcha nog wacht.

Uitzetten kan alleen uitdrukkelijk, met `"captcha": false` bij de app. Dan gaat de captcha in
Supabase meteen uit, haalt de inrichting `VITE_TURNSTILE_SITEKEY` weg, en staat er bij elke
run een waarschuwing in het resultaat. Doe dat alleen tijdelijk, bijvoorbeeld als Turnstile
een storing heeft. Weer aanzetten gaat opnieuw in twee runs met een uitrol ertussen.

**Sessieduur.** Bij een gewone app vraagt de deur elke 30 dagen opnieuw om in te loggen. Een
klantportaal heeft geen deur; zonder grens bleef een sessie voorgoed geldig, ook die van een
vertrokken medewerker op een groep met een domein (zo iemand staat nog "in de groep" tot
iemand hem uitsluit). De inrichting zet daarom `sessions_inactivity_timeout` op 720 uur: een
sessie die 30 dagen niet is gebruikt, vervalt. Geen vaste einddatum (`sessions_timebox`): die
zou elke klant op een vaste dag uitloggen. Supabase biedt dit alleen op het Pro-plan en
hoger; weigert het project de instelling, dan loopt de inrichting door en staat het als
waarschuwing in het resultaat. De grens van 12 uur voor medewerkerrechten dwingt de app af.

**Toegang bijwerken bij een klantportaal.** In het bestand staan alleen medewerkers. Daarom
beoordeelt Toegang bijwerken alleen accounts met een inlog via Cloudflare. Of een account die
heeft, leest hij uit de database van de app (`auth.identities`); lukt dat niet, dan stopt hij
zonder iemand in te trekken.

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

**Medewerkers bij een klantportaal.** Omdat elk adres nu eerst bewezen moet worden
(`mailer_autoconfirm` uit) en Cloudflare aan Supabase niet meldt dat een adres gecontroleerd
is, merken medewerkers twee dingen (nagespeeld tegen Supabase Auth, 13-11-2026):

- Wie al een account had, merkt niets.
- Een nieuwe medewerker krijgt bij zijn eerste inlog via Cloudflare één keer de melding dat
  zijn adres bevestigd moet worden, en de inlogmail. Na de code of de link in die
  mail werkt inloggen voor medewerkers gewoon.
- **Een medewerker die eerst als klant inlogde.** De aanmeld-hook voorkomt dat voor elk adres
  en domein uit de groepen. Het kan nog bij een groep met alleen `idp_groepen`, of bij een
  account van vóór de hook: logt zo iemand daarna via Cloudflare in, dan maakt Supabase een
  tweede account zonder adres, dat niet te bevestigen is. Toegang bijwerken meldt zulke
  accounts als waarschuwing. Oplossing: verwijder in Supabase (Authentication, Users) het
  account zonder adres én het klantaccount op dat adres, en laat de medewerker daarna via
  "Inloggen voor medewerkers" inloggen.

**Terug naar een gewone app.** Haal `klantportaal`, `afzender`, `turnstile_sitekey` en
`captcha` weg en draai daarna App inrichten: de deur komt terug en inloggen per mail gaat
uit. De volgorde beschermt tegen een vergissing:

1. Zodra het bestand op `main` staat, draait Toegang bijwerken. Die ziet een gewone app
   zonder deur waar inloggen per mail nog aan staat, **trekt bij die app niemand in**, en
   zegt in het resultaat: draai eerst App inrichten. Was het een vergissing (iemand schreef
   de korte vorm), zet dan `"klantportaal": true` terug; er is niets gebeurd.
2. Pas nadat App inrichten de deur heeft teruggezet, is het een gewone app. Bij de
   eerstvolgende run van Toegang bijwerken is iedereen die niet in een groep staat een
   vreemde: alle klanten worden dan geband en afgemeld. Die bans blijven staan als de app
   later weer een klantportaal wordt; opheffen kan alleen per account in Supabase. Doe dit
   dus alleen als het portaal echt dicht moet.

De instellingen voor SMTP, de mailsjablonen, de hooks en de sessieduur blijven in Supabase
staan; zonder inloggen per mail doen ze niets.

Hoe Toegang bijwerken dat ziet, zonder een gewone app iets extra's te vragen: ontbreekt de
deur van een gewone app in de lijst Access-apps die hij toch al leest, en zou hij iemand
intrekken, dan leest hij eerst één keer de auth-instellingen van productie. Staat inloggen
per mail aan, of wijst het adres van de app naar een eigen domein, dan wacht hij. Alleen een
app in de tijdelijke stand (geen deur, adres op `workers.dev`) krijgt zo, op het moment dat er
iemand in te trekken valt, één leesvraag meer dan op versie 42. Een gewone app met een deur
krijgt er geen.

**Van een deur naar een klantportaal** gaat altijd via App inrichten, in twee runs (zie de
stappen hierboven). Toegang bijwerken haalt de deur niet weg; staat hij er nog, dan zegt het
resultaat dat.

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
node beheer/inrichten-cloudflare.mjs --voorvoegsel rp- --app richplant \
  --repo Richplant-BV/richplant-start --wrangler app/wrangler.jsonc --droogloop
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
zwaardere scenario's (2300 accounts, IdP-groepen, een fout halverwege) en legt ze naast
elkaar. In een losse kopie van `beheer/` zonder git slaat hij zichzelf over.

`regressie-42.test.mjs` bewaakt de bestaande klanten: voor een `toegang.json` zonder
`klantportaal` moet elke aanroep naar Cloudflare, Supabase en GitHub exact gelijk zijn aan
die van versie 42, in volgorde en inhoud, ook de leesvragen. De verwachting
(`regressie-42.json`) is gemaakt met de code van versie 42 zelf; `regressie-42.maak.mjs`
zegt hoe. Wordt deze test rood, dan verandert er iets voor een gewone app: los dat op in de
code, en leg de verwachting alleen opnieuw vast als die verandering de bedoeling is.
