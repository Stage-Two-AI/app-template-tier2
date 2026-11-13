# beheer/: inrichting van de Cloudflare-proef

Deze map gaat niet mee naar afgeleide apps (`nietMeenemen` in
`.claude/stack-manifest.json`). Een beheer-repo kan hem wel als zelfstandig pakket
kopiëren (zie "Los van de template"); de nette plek is `beheer-template`.

Wat erin zit:

| Bestand | Wat het doet |
|---|---|
| `inrichten-cloudflare.mjs` | het script: inrichten, tweede doorgang, toegang bijwerken, opruimen |
| `lib/cloudflare.mjs` | Access-policies, Access-apps, workers.dev-subdomein, placeholder-Worker |
| `lib/supabase.mjs` | project, sleutels, auth-config, custom provider `custom:cloudflare`, de inlogmail en de rem van een klantportaal |
| `lib/toegang.mjs` | `toegang.json` controleren, vertalen naar policies, intrekken, de aanmeld-hook van de testdatabase |
| `controle-doorsteek.mjs` | kijkt van buitenaf of de deur dicht zit (en bij een klantportaal: of alleen het domein open is) |
| `toegang.json` | wie bij welke app mag |
| `package.json` | maakt van `beheer/` een zelfstandig pakket (zie "Los van de template") |
| `*.test.mjs`, `nep-wolk.mjs` | tests tegen een nagebootste API (`pnpm beheer:test`) |
| `regressie-42.*`, `regressie-scenarios.mjs` | bewijs dat een app zonder `klantportaal` exact dezelfde inrichting krijgt als op versie 42 (zie "Lokaal testen") |

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

- `klantportaal`, met `afzender` en `captcha`: zie het volgende hoofdstuk.

## Klantportaal

Een klantportaal is een app die open is voor klanten: een webshop of een portaal waar
honderden mensen van buiten het bedrijf zelf inloggen. Eén regel in `toegang.json`:

```json
"apps": {
  "direct": {
    "groepen": ["kantoor"],
    "klantportaal": true,
    "afzender": "Winco Direct <noreply@wincoapps.com>"
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
| Inloggen per mail in productie | uit | aan: een link en een code van zes cijfers, 15 minuten geldig |
| `mailer_autoconfirm` in productie | aan | uit: elk adres moet eerst bewezen worden |
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
  een e-mailadres. Medewerkerrechten horen alleen te gelden in een sessie die via Cloudflare
  binnenkwam; wie per mail inlogt op het adres van een medewerker is gewoon klant;
- de app op versie 43 of later staat en het inlogscherm met beide manieren heeft
  (`docs/routes/klantportaal.md` in de app). Een oudere app begrijpt
  `cloudflare,mailcode` niet.

De inrichting zet deze waarschuwing bij elke run in het resultaat.

**Wat de owner doet, in deze volgorde.**

1. Bij Resend het domein van de afzender verifiëren (bijvoorbeeld `wincoapps.com`) en een
   sleutel maken met alleen het recht om te versturen.
2. Die sleutel als secret `SMTP_WACHTWOORD` in de omgeving van de beheer-repo zetten (waar
   ook `SUPABASE_ACCESS_TOKEN` staat). De workflow App inrichten moet hem doorgeven aan het
   script, als `SMTP_WACHTWOORD` in de omgeving van de stap.
3. In `toegang.json` bij de app `"klantportaal": true` en `"afzender"` zetten, via een pull
   request. De afzender is een adres op het geverifieerde domein, of `"Naam <adres>"`; de
   naam staat in het onderwerp en de tekst van de mail. Zonder naam is dat de naam van de app.
4. App inrichten draaien, eerst als droogloop. Die toont wat er met de deur en de mail zou
   gebeuren. Daarna echt.
5. Controleren van buitenaf: `node beheer/controle-doorsteek.mjs --klantportaal ...` (het
   domein open, `workers.dev` en de previews dicht). Daarna zelf inloggen per mail en als
   medewerker.

Ontbreekt `SMTP_WACHTWOORD`, dan stopt App inrichten vóór de eerste wijziging, met een
melding. Zo blijft er nooit een app achter zonder deur en zonder mail. De volgorde in de run
is daarop gebouwd: eerst de inlogmail aan bij Supabase, dan de Access op de Worker
nalopen, en als allerlaatste de deur van het domein weg. Mislukt een stap, dan staat de deur
er nog. Het wachtwoord gaat alleen naar Supabase en staat nooit in het logboek of het
resultaat. Een nieuwe sleutel bij Resend: het secret vervangen en App inrichten opnieuw
draaien.

Een klantportaal vraagt een eigen domein. In de tijdelijke stand (alleen `workers.dev`)
weigert de inrichting het: dat adres blijft altijd dicht.

**Mail.** De mail gaat via Resend over SMTP (`smtp.resend.com`, poort 465, gebruiker
`resend`). Supabase stuurt dezelfde mail naar een nieuw en naar een bekend adres: de code om
over te typen en een link, allebei 15 minuten geldig en één keer te gebruiken. De code staat
erbij omdat een link uit WhatsApp of Gmail vaak in een ingebouwde browser opent, waarna de
klant in zijn gewone browser niet is ingelogd.

**De rem tegen misbruik.** Een open inlogformulier dat mails verstuurt, wordt misbruikt: om
iemand te bestoken met mails, om kosten te maken bij Resend, of om codes te raden. De
inrichting zet daarom deze grenzen van Supabase Auth, bij elke run opnieuw:

| Instelling | Waarde | Waarom dit getal |
|---|---|---|
| mails per uur, het hele project samen (`rate_limit_email_sent`) | 100 | Een klant logt zelden opnieuw in (een sessie blijft staan), dus 100 is ruim voor een drukke ochtend. Een mailbom kost hoogstens 2400 mails per dag |
| tijd tussen twee mails naar hetzelfde adres (`smtp_max_frequency`) | 60 seconden | Eén adres krijgt hoogstens één mail per minuut |
| aanvragen per vijf minuten per IP-adres (`rate_limit_otp`) | 15 | Eén mens heeft er één of twee nodig; een kantoor achter één internetadres kan ermee vooruit |
| pogingen om een code of link in te wisselen, per vijf minuten per IP-adres (`rate_limit_verify`) | 15 | In het kwartier dat een code geldt zijn dat 45 gokken per IP-adres, op een miljoen mogelijkheden |

De keerzijde van de eerste grens: is hij bereikt, dan krijgt dat uur niemand meer een
inlogmail, ook een echte klant niet. Gebeurt dat, zet dan de captcha aan. De getallen staan
op één plek (`REM` in `lib/supabase.mjs`); wie ze met de hand in Supabase verandert, ziet ze
bij de volgende run terugkomen.

**Captcha (Turnstile), een schakelaar.** Met `"captcha": true` bij de app zet de inrichting
de captcha van Supabase Auth aan met Turnstile van Cloudflare. Dan weigert Supabase elke
aanvraag voor een inlogmail zonder geldig bewijs van de widget. Nodig: een Turnstile-widget
voor het domein (Cloudflare-dashboard), de geheime sleutel als secret `TURNSTILE_GEHEIM` in
de omgeving van de beheer-repo (ook doorgegeven aan het script), en de widget in het
inlogscherm van de app. Zet de schakelaar pas om als de app de widget toont: zonder widget
kan geen klant meer inloggen per mail. Medewerkers via Cloudflare merken er niets van. Staat
`captcha` aan en ontbreekt het secret, dan stopt de inrichting vóór de eerste wijziging.

**Toegang bijwerken bij een klantportaal.** In het bestand staan alleen medewerkers. Daarom
beoordeelt Toegang bijwerken alleen accounts met een inlog via Cloudflare. Of een account die
heeft, leest hij uit de database van de app (`auth.identities`); lukt dat niet, dan stopt hij
zonder iemand in te trekken.

- Een account zonder Cloudflare-inlog is een klant: geen ban, geen afmelding. Een klant die
  de app of de owner zelf heeft geblokkeerd, blijft geblokkeerd. Het resultaat noemt het
  aantal overgeslagen klanten.
- Een medewerker die uit `toegang.json` gaat, wordt net als altijd geband en afgemeld.
- Een account dat via Cloudflare én per mail kan inloggen (een medewerker die ook eens de
  klantinlog gebruikte) gaat helemaal dicht zodra de medewerker uit het bestand is. Dat is
  bewust: alleen de Cloudflare-kant sluiten zou een vertrokken medewerker een werkend
  account laten houden. Moet zo iemand daarna klant kunnen zijn, verwijder dan zijn account
  in Supabase (Authentication, Users); hij logt daarna per mail in en begint als nieuwe
  klant. Alleen de ban opheffen helpt niet: de volgende run zet hem terug.
- Beoordeeld wordt het adres waarmee Cloudflare iemand binnenliet, niet een adres dat hij
  zelf op zijn account zette.

**Medewerkers bij een klantportaal.** Omdat elk adres nu eerst bewezen moet worden
(`mailer_autoconfirm` uit) en Cloudflare aan Supabase niet meldt dat een adres gecontroleerd
is, merken medewerkers twee dingen. Dit volgt uit de broncode van Supabase Auth en is nog
niet op een echt project geprobeerd:

- Wie al een account had, merkt niets.
- Een nieuwe medewerker krijgt bij zijn eerste inlog via Cloudflare één keer de melding dat
  zijn adres bevestigd moet worden, en een mail. Na de link of de code in die mail werkt
  inloggen voor medewerkers gewoon.
- **Een medewerker die eerst als klant inlogde.** Maakt een medewerker eerst per mail een
  klantaccount op zijn werkadres en logt hij daarna pas via Cloudflare in, dan maakt
  Supabase een tweede account zonder adres, dat niet te bevestigen is. Hij kan dan niet als
  medewerker inloggen. Toegang bijwerken meldt zulke accounts als waarschuwing. Oplossing:
  verwijder in Supabase (Authentication, Users) het account zonder adres én het klantaccount
  op dat adres, en laat de medewerker daarna eerst via "Inloggen voor medewerkers" inloggen.
  Voorkomen: medewerkers loggen de eerste keer altijd als medewerker in.

**Terug naar een deur.** Haal `klantportaal` en `afzender` weg en draai App inrichten: de
deur komt terug en inloggen per mail gaat uit. Let op wat er daarvóór al gebeurt: zodra het
bestand op `main` staat, draait Toegang bijwerken, en voor een gewone app is iedereen die
niet in een groep staat een vreemde. Alle klanten worden dan geband en afgemeld. Zet je de
app later weer op klantportaal, dan blijven die bans staan; opheffen kan alleen per account
in Supabase. Doe dit dus alleen als het portaal echt dicht moet. De instellingen voor SMTP
en de mailsjablonen blijven in Supabase staan; zonder inloggen per mail doen ze niets.

**Van een deur naar een klantportaal** gaat altijd via App inrichten. Toegang bijwerken haalt
de deur niet weg; staat hij er nog, dan zegt het resultaat dat.

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

`regressie-42.test.mjs` bewaakt de bestaande klanten: voor een `toegang.json` zonder
`klantportaal` moet elke aanroep naar Cloudflare, Supabase en GitHub exact gelijk zijn aan
die van versie 42, in volgorde en inhoud, ook de leesvragen. De verwachting
(`regressie-42.json`) is gemaakt met de code van versie 42 zelf; `regressie-42.maak.mjs`
zegt hoe. Wordt deze test rood, dan verandert er iets voor een gewone app: los dat op in de
code, en leg de verwachting alleen opnieuw vast als die verandering de bedoeling is.
