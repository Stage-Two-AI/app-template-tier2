# beheer/: inrichting van de Cloudflare-proef

Deze map gaat niet mee naar afgeleide apps (`nietMeenemen` in
`.claude/stack-manifest.json`). Een beheer-repo kan hem wel als zelfstandig pakket
kopiëren (zie "Los van de template"); de nette plek is `beheer-template`.

Nieuw sinds versie 43 is het klantportaal (zie "Klantportaal"). Gebruik je geen klantportaal,
dan hoef je niets te doen en verandert er niets.

Wat erin zit:

| Bestand | Wat het doet |
|---|---|
| `inrichten-cloudflare.mjs` | het script: inrichten, tweede doorgang, toegang bijwerken, opruimen |
| `lib/cloudflare.mjs` | Access-policies, Access-apps, workers.dev-subdomein, placeholder-Worker |
| `lib/supabase.mjs` | project, sleutels, auth-config, custom provider `custom:cloudflare`, de mails, de rem en de sessieduur van een klantportaal |
| `lib/toegang.mjs` | `toegang.json` controleren, vertalen naar policies, intrekken, de aanmeld-hook van de testdatabase, de twee hooks van een klantportaal |
| `controle-doorsteek.mjs` | kijkt van buitenaf of de deur dicht zit (en bij een klantportaal: of alleen het domein open is en inloggen per mail en de captcha aan staan); met `--app` zoekt het de adressen zelf op (de knop Controle van buitenaf) |
| `KLANTPORTAAL.md` | het klantportaal voor de bouwer en voor Stage Two: hooks, mail, de rem, Toegang bijwerken, open punten. De stappen voor de owner staan hieronder, onder "Klantportaal" |
| `toegang.json` | wie bij welke app mag |
| `package.json` | maakt van `beheer/` een zelfstandig pakket (zie "Los van de template") |

Alleen voor de tests in de template (zie "Lokaal testen"); een beheer-repo heeft ze niet nodig:

| Bestand | Wat het doet |
|---|---|
| `*.test.mjs`, `nep-wolk.mjs` | tests tegen een nagebootste API (`pnpm beheer:test`) |
| `regressie-42.json`, `regressie-42.maak.mjs`, `regressie-scenarios.mjs` | bewijs dat een app zonder `klantportaal` dezelfde aanroepen, dezelfde uitvoer en dezelfde exitcode krijgt als op versie 42 |
| `klantportaal-opzet.mjs` | gedeelde opzet voor de tests van het klantportaal |

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
van alle sessies in Supabase. In de testdatabase schrijft hij ook de aanmeld-hook
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

Gebruik je geen klantportaal, dan hoef je niets te doen en verandert er niets.

Een klantportaal is een app die open is voor klanten: een webshop of een portaal waar mensen
van buiten het bedrijf zelf inloggen. Het eigen domein van de app staat dan open voor iedereen
en klanten loggen in per mail, met een code van acht cijfers of een link. Wat dicht blijft: het
`workers.dev`-adres en de previews (achter Cloudflare, zoals altijd), en medewerkers loggen in
via Cloudflare, zoals altijd. Voor klanten staat er niets in `toegang.json`: de groepen daar
zijn bij een klantportaal alleen nog de medewerkers. Voor een gewone app verandert er niets.

**Een mens haalt de deur weg, niet de code.** App inrichten zet alles klaar en laat de deur
staan. De deur gaat alleen weg in een run waarin jij het vinkje "Deur weghalen (klantportaal
live zetten)" hebt gezet, en die run doet niets anders.

Bij een klantportaal (of een portaal dat weer dicht moet) staat na elke run bovenaan de pagina
van de run in GitHub **de samenvatting van de run**: wat er is gedaan, de waarschuwingen en
onder "Wat nu" de volgende stap. Daar verwijzen de stappen hieronder naar. Geheimen staan er
niet in. Alles voor de bouwer en voor Stage Two (de hooks, de rem, de sommen, de details van
Toegang bijwerken) staat in `KLANTPORTAAL.md`.

Twee dingen in de workflows zijn er alleen voor een klantportaal:

- Het vinkje **"Deur weghalen (klantportaal live zetten)"** bij App inrichten (in de proef:
  Proef inrichten, `-f deur_weghalen=true`; in het script `--deur-weghalen`). Zonder dat
  vinkje verandert geen enkele run iets aan de deur, en met dat vinkje verandert een run alleen
  de deur (stap 5).
- De knop **Controle van buitenaf** (in de proef: Proef controle van buitenaf,
  `proef-controle.yml`). Die kijkt zonder inlog of het domein open is en het `workers.dev`-adres
  en de previews dicht zijn, en of inloggen per mail en de captcha aan staan (stap 6). Je kiest
  alleen de app; de adressen zoekt hij zelf op. Hij wijzigt niets, krijgt alleen de sleutels
  waarmee hij die adressen kan opzoeken (zie "Controle van buitenaf" in `KLANTPORTAAL.md`) en
  draait in een eigen concurrency-groep, zodat hij nooit een wachtende Toegang bijwerken
  vervangt.

### De zeven stappen

Alles gaat via GitHub in de browser; je hebt geen eigen computer met commando's nodig.

**Stap 0. De bouwer bevestigt dat de app er klaar voor is.** Vraag de bouwer van de app deze
drie punten te bevestigen:

1. De app staat op versie 43 of later: de pull request van `/stagetwo-tier2:updaten` is gemerged.
2. Een nieuw account ziet en kan niets tot een medewerker het goedkeurt, en medewerkerrechten
   gelden alleen voor wie via Cloudflare is ingelogd (de migratie `klantportaal` in de app; zie
   "De regels in de database" in `KLANTPORTAAL.md`).
3. De app heeft in Supabase geen eigen hooks voor aanmelden, het token of het versturen van mail.

- Goed als: de bouwer alle drie bevestigt.
- Gaat het mis: sla je dit over, dan weigert stap 3 met "de app begrijpt de inlog van een
  klantportaal nog niet" of "de app heeft een eigen ... hook". Er is dan niets gewijzigd.

**Stap 1. Twee sleutels klaarzetten.** Begin hier op tijd: het domein verifiëren bij Resend is
werk in de DNS van het domein en kan uren duren voor het is doorgekomen.

| Waar | Wat je doet | Waar het heen gaat |
|---|---|---|
| Resend, Domains | het domein van de afzender toevoegen (bijvoorbeeld `klant.nl`) en de DNS-regels die Resend toont bij de beheerder van dat domein laten zetten. Wacht tot Resend "Verified" toont. Maak daarna onder API Keys een sleutel met alleen "Sending access" | secret `SMTP_WACHTWOORD` in de beheer-repo: Settings, Environments, de omgeving `beheer` (waar ook `SUPABASE_ACCESS_TOKEN` staat) |
| Cloudflare, Turnstile, Add widget | een widget maken, stand Managed. Bij "Hostname" vul je het domein van de app in, precies zoals klanten het typen (bijvoorbeeld `shop.klant.nl`). Je krijgt twee sleutels | de geheime (Secret Key) als secret `TURNSTILE_GEHEIM` in dezelfde omgeving `beheer`. De openbare (Site Key) bewaar je voor stap 2 |

- Goed als: beide secrets in de lijst van de omgeving `beheer` staan.
- Gaat het mis: verwissel je de twee sleutels van Turnstile, dan weigert stap 3 met "dezelfde
  waarde" of "Turnstile kent dit geheim niet". Er is dan niets gewijzigd.

**Stap 2. Een pull request op `toegang.json`.** Dat bestand staat bovenin de beheer-repo (in de
template is het `beheer/toegang.json`). Maak van de regel van de app de lange vorm. Voor:

```json
"apps": {
  "shop": ["kantoor"]
}
```

Na:

```json
"apps": {
  "shop": {
    "groepen": ["kantoor"],
    "klantportaal": true,
    "afzender": "Voorbeeld BV <noreply@klant.nl>",
    "turnstile_sitekey": "0x4AAAAAAA..."
  }
}
```

`afzender` is een adres op het domein uit stap 1 (de naam ervoor staat in de mail);
`turnstile_sitekey` is de openbare sleutel uit stap 1. Laat de pull request goedkeuren en merge
hem.

- Goed als: de workflow Toegang bijwerken daarna groen is. De samenvatting zegt: "de deur staat
  er nog".
- Gaat het mis: een rode check op de pull request noemt het veld dat niet klopt.

**Stap 3. App inrichten draaien, zonder het vinkje.** Actions, App inrichten, Run workflow:
kies de app, **zet "droogloop" uit** (dat vakje staat standaard aan) en laat "Deur weghalen"
uit. Deze run toetst de geheimen, zet inloggen per mail, de captcha, de hooks en de variabelen
voor de app klaar, en laat de deur staan. Je mag hem zo vaak herhalen als je wilt.

- Goed als: de run groen is en de samenvatting zegt "de deur ... staat er nog ... Alles staat
  klaar", met onder "Wat nu" stap 4.
- Gaat het mis: de run is rood en de samenvatting begint met "gestopt zonder wijzigingen",
  gevolgd door wat er ontbreekt en wat je doet. Er is dan niets gewijzigd. Los het op en draai
  stap 3 opnieuw.

**Stap 4. De app uitrollen en achter de deur testen.**

1. Ga naar de app-repo: Actions, Uitrollen, de laatste run, Re-run all jobs. Wacht tot die
   groen is.
2. Open het domein van de app en ga door de deur van Cloudflare, zoals altijd.
3. Ga naar `https://<domein>/login`. Staat daar "Je bent al ingelogd", klik dan op Uitloggen.
   Je ziet nu de inlogpagina voor klanten: het vak E-mailadres met de knop Doorgaan, en
   daaronder de knop Inloggen voor medewerkers.
4. Vul een privéadres in (niet je werkadres: dat weigert het portaal, want het is van een
   medewerker), klik Doorgaan en vul de code van acht cijfers uit de mail in.
5. Test daarna de link. Daarvoor heb je een tweede mail nodig, want een code en een link uit
   dezelfde mail werken samen maar één keer: ga weer naar `/login`, klik Uitloggen, wacht een
   minuut (een adres krijgt hoogstens één mail per minuut), vraag opnieuw een mail aan en klik
   nu op de link in de mail en daarna op de knop Inloggen.
6. Ga nog een keer naar `/login`, klik Uitloggen en daarna Inloggen voor medewerkers.

- Goed als: je de widget van de captcha zag, beide mails binnen een minuut kwamen, de code
  werkte, de link werkte en Inloggen voor medewerkers nog werkt.
- Gaat het mis: geen mail, kijk dan bij Resend (Emails) of het domein en de sleutel kloppen.
  Zie je geen vak E-mailadres of geen widget, dan is de app nog niet opnieuw uitgerold. De deur
  staat er nog, dus er is geen haast: los het op en test opnieuw.

**Stap 5. App inrichten draaien, met het vinkje.** Dezelfde workflow: kies de app, **zet
"droogloop" uit** en zet "Deur weghalen (klantportaal live zetten)" aan. De run loopt na dat
alles nog staat zoals stap 3 het zette en haalt dan de deur weg. Verder wijzigt hij niets: wat
je in stap 4 hebt getest, is wat live gaat.

- Goed als: de run groen is en de samenvatting zegt "weggehaald". Het domein is nu open.
- Gaat het mis: de run is rood met "de deur gaat niet weg, want er staat nog iets anders te
  wijzigen", en wat. De deur staat er dan nog en er is niets gewijzigd. Dat gebeurt als er
  sinds stap 3 iets is veranderd (in `toegang.json` of in Supabase): doe stap 3 en stap 4
  opnieuw, en dan pas stap 5.

**Stap 6. De knop Controle van buitenaf.** Actions, Controle van buitenaf, Run workflow, kies
de app. Je hoeft geen adressen te typen.

- Goed als: de run groen is. De samenvatting toont per regel een vinkje: het domein is open,
  het `workers.dev`-adres, de preview en de inlog voor medewerkers eindigen bij de loginpagina
  van Cloudflare, en inloggen per mail en de captcha staan aan. Log daarna zelf nog een keer in
  per mail, in een privévenster.
- Gaat het mis: de samenvatting zegt onder "Wat nu" wat je doet. Staat er een kruis bij
  `workers.dev` of de preview en blijft dat na App inrichten (zonder vinkje) staan, zet dan de
  deur terug (hieronder).

### Als het misgaat: terug achter de deur

Werkt inloggen niet na stap 5, of wil je het portaal om een andere reden dicht:

1. Zet met een pull request de regel van de app in `toegang.json` terug naar de korte vorm
   (de "Voor" van stap 2): haal `klantportaal`, `afzender`, `turnstile_sitekey` en `captcha`
   weg. Merge hem.
2. Toegang bijwerken start vanzelf en eindigt met precies één melding, die begint met
   "`<app>`: wacht op App inrichten". Die melding hoort hierbij: het portaal is nog niet dicht.
   Staat er iets anders, lees dat dan en los het eerst op.
3. Draai App inrichten voor de app: droogloop uit, zonder vinkje. Die zet eerst de deur terug,
   zet daarna inloggen per mail uit en meldt de klanten af. Geen klant wordt geband.
4. Start Toegang bijwerken opnieuw (Actions, Toegang bijwerken, Run workflow). Die is nu groen.

Is het probleem opgelost, dan begin je opnieuw bij stap 2. De klanten hebben hun account nog.

### Wat je moet weten

- De regels in de database zijn bij een klantportaal de enige grens: iedereen ter wereld kan
  een account maken. Daarom stap 0.
- Zonder het vinkje verandert geen run iets aan de deur. Met het vinkje verandert een run
  alleen de deur.
- Klanten hebben geen wachtwoord en kunnen hun adres niet zelf wijzigen; dat loopt via de
  eigenaar van de app.
- De captcha staat standaard aan. Uitzetten kan alleen met `"captcha": false` bij de app, en
  is bedoeld voor een storing bij Turnstile.
- Toegang bijwerken trekt bij een klantportaal alleen medewerkers in, nooit klanten. Een
  portaal sluiten bant niemand. Een klantportaal komt vóór de gewone apps aan de beurt; lukt
  er daar iets niet, dan gaat hij door en eindigt de run rood. Een fout bij een gewone app
  stopt de run, zoals altijd.
- `SMTP_WACHTWOORD` en `TURNSTILE_GEHEIM` staan nooit in het logboek of de samenvatting.
- Een klantportaal vraagt een eigen domein, en hoort een testdatabase te hebben (anders
  waarschuwt elke run).
- Een nieuwe medewerker krijgt bij zijn eerste inlog via Cloudflare één keer een mail om zijn
  adres te bevestigen.
- Een gewone app merkt hier niets van: die krijgt dezelfde aanroepen als op versie 42, en het
  script schrijft voor haar geen eigen samenvatting. `"klantportaal": false` mag, en doet
  hetzelfde als het veld weglaten.
- De rest (hooks, mail, de rem, sessieduur, previews, open punten) staat in `KLANTPORTAAL.md`.

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

`regressie-42-versie.test.mjs` bewijst hetzelfde zonder vastgelegde verwachting: hij haalt de
code van versie 42 uit git naar een tijdelijke map (die hij weer weghaalt), draait daar en hier
dezelfde scenario's en legt ze naast elkaar. Voor een gewone app die nooit klantportaal was
moeten de aanroepen (in volgorde en inhoud), het resultaat, de regel op stdout en de exitcode
gelijk zijn. De scenario's: 2300 accounts, IdP-groepen, een fout halverwege, een deur die is
hernoemd, weggehaald of er nooit was, inloggen per mail dat iemand met de hand aanzette, een
Access op de Worker met een extra adres, en elke leesvraag die één keer hapert met 429 en met
500. Daarbij komt een storing op elke aanroep (elke methode, negen soorten fouten), handwerk
van de klant (eigen hooks, sjablonen, policies), 63 varianten van `toegang.json`, en het script
als proces in zes modi en negen omgevingen (stdout, stderr, exitcode, de maskers en de
samenvatting). Wat bewust verschilt, legt hij apart vast: de tekst van de melding bij een
ontbrekend voorvoegsel, bij een antwoord dat geen JSON is en bij een veld van een klantportaal
in een gewone app, de optie `--deur-weghalen`, `"klantportaal": false` (op 42 geweigerd, nu
geldig), en een app die `constructor` heet (die kwam op versie 42 door de controle heen en
bestaat nu niet). In een losse kopie van `beheer/` zonder git slaat hij zichzelf over.

`regressie-42.test.mjs` bewaakt de bestaande klanten: voor een `toegang.json` zonder
`klantportaal` moet elke aanroep naar Cloudflare, Supabase en GitHub exact gelijk zijn aan
die van versie 42, in volgorde en inhoud, ook de leesvragen. De verwachting
(`regressie-42.json`) is gemaakt met de code van versie 42 zelf; `regressie-42.maak.mjs`
zegt hoe. Wordt deze test rood, dan verandert er iets voor een gewone app: los dat op in de
code, en leg de verwachting alleen opnieuw vast als die verandering de bedoeling is.
