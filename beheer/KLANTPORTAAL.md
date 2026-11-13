# Klantportaal: voor de bouwer en voor Stage Two

De stappen voor de owner staan in `README.md`, onder "Klantportaal". Dit bestand is de
achtergrond: wat de inrichting precies zet, waarom, en wat er nog open staat. Elk onderwerp
staat hier één keer.

## Wat er verandert, en wat dicht blijft

| Onderdeel | Gewone app | Klantportaal |
|---|---|---|
| Het eigen domein | achter de deur (Access-app `<vv><app>`) | open, geen Access-app (na stap 5) |
| `workers.dev` en de previews per pull request | dicht (Access op de Worker) | dicht, ongewijzigd |
| Inloggen voor medewerkers | via Cloudflare (SaaS-app `<vv><app>-inlog`, de groepen) | hetzelfde, ongewijzigd |
| Inloggen per mail in productie | uit | aan: een code van acht cijfers en een link, 15 minuten geldig |
| Inloggen met een wachtwoord | kan niet (e-mail staat uit) | kan niet: een hook weigert elke sessie met een wachtwoord |
| Een account maken per mail | kan niet | iedereen, behalve op een adres of domein van een medewerker (een hook) |
| Anoniem aanmelden en de meldingsmails van Supabase | zoals het project staat | uitdrukkelijk uit |
| Zelf je adres wijzigen | n.v.t. | kan niet: dat loopt via de eigenaar van de app |
| `mailer_autoconfirm` in productie | aan | uit: elk adres moet eerst bewezen worden |
| Captcha op het inlogformulier | n.v.t. | aan (Turnstile), tenzij er uitdrukkelijk `"captcha": false` staat |
| Sessieduur | de deur vraagt na 30 dagen opnieuw | een sessie vervalt na 30 dagen zonder gebruik (Supabase Pro of hoger) |
| Terugkeeradressen van productie | het domein en de previews | alleen het domein (met een testdatabase) |
| De testdatabase | e-mail alleen voor testaccounts | hetzelfde, ongewijzigd |
| `VITE_INLOGDIENST` | `cloudflare` | `cloudflare,mailcode` in `production`; de previews houden `cloudflare` |
| Toegang bijwerken | trekt iedereen in die niet in een groep staat | trekt alleen medewerkers in; klanten nooit |

## De regels in de database

Bij een gewone app komt niemand van buiten verder dan het inlogscherm van Cloudflare. Bij een
klantportaal kan iedereen de app openen en een account maken. Wat zo iemand kan zien of doen,
bepalen alleen de regels in de database (RLS). Dit is wat de bouwer in stap 0 bevestigt:

- De app staat op versie 43 of later en heeft het inlogscherm met beide manieren, met een
  codevak van acht cijfers en de Turnstile-widget. De inrichting leest dat vóór de eerste
  wijziging uit de app-repo: `src/lib/env.ts` op `main` moet `VITE_INLOGDIENST` lezen met
  `leesInlogdiensten`. Een oudere app (of een app van de openbare template) start met
  `cloudflare,mailcode` niet meer op; dan stopt de inrichting.
- Elke tabel heeft regels die op de rol van de gebruiker letten, en een nieuw account ziet
  niets. Een recht van een medewerker hangt nooit aan iets wat een klant zelf kan krijgen,
  zoals een e-mailadres of het account zelf. Een maillogin op het adres van een medewerker
  opent namelijk hetzelfde account als zijn inlog via Cloudflare; alleen de sessie verschilt.
  De app geeft medewerkerrechten daarom alleen aan een sessie die via Cloudflare kwam en niet
  ouder is dan 12 uur (de app leest dat uit `amr` in het token; zie de migratie `klantportaal`
  en `docs/routes/klantportaal.md` in de app). De beheercode dwingt die 12 uur niet af:
  Supabase kent maar één sessieduur voor iedereen.
- De app heeft geen eigen hooks in Supabase Auth (zie "De twee hooks").

## De deur, het vinkje en het merk

- Zonder het vinkje verandert geen enkele run iets aan de deur. Ook niet als de variabelen al
  goed staan, als een eerdere run halverwege stopte, of als iemand iets met de hand zette.
- De run met het vinkje wijzigt alleen de deur. Vóór hij iets doet, loopt hij na wat een run
  zonder vinkje nu nog zou wijzigen: de variabelen `VITE_INLOGDIENST` en
  `VITE_TURNSTILE_SITEKEY` in omgeving `production` van de app-repo, elke inloginstelling in
  Supabase behalve de twee geheimen en de sessieduur, en de Access op de Worker (hij bestaat,
  bewaakt `workers.dev` en de previews, en heeft het merk). Is er iets, dan stopt hij met
  "draai eerst App inrichten zonder vinkje en test opnieuw" en de namen van wat afwijkt. Zo is
  wat de owner achter de deur testte, wat live gaat. Geheimen schrijft die run niet: een
  vervangen `SMTP_WACHTWOORD` of `TURNSTILE_GEHEIM` gaat pas in met een run zonder vinkje, en
  wordt dan opnieuw getest.
- Of de app sinds stap 3 echt is uitgerold en of inloggen per mail werkt, kan de inrichting
  niet zien. Daarom is dat een stap voor een mens (stap 4).
- Toegang bijwerken en de tweede doorgang halen de deur nooit weg.
- Ontbreekt `SMTP_WACHTWOORD` of `TURNSTILE_GEHEIM`, dan stopt App inrichten vóór de eerste
  wijziging. De geheimen gaan alleen naar Supabase (en het geheim van Turnstile naar Turnstile
  zelf, om het te toetsen). Van een fout van Supabase op de inloginstellingen toont de
  inrichting alleen de status en de namen van de velden. De sleutel van Resend toetst de
  inrichting niet; dat doet stap 4.
- Een klantportaal vraagt een eigen domein. In de tijdelijke stand (alleen `workers.dev`)
  weigert de inrichting het.
- Een app mag niet heten zoals iets wat de inrichting voor een andere app maakt (`x-worker`,
  `x-inlog`, `x-publiek`, `x-test`, `x-test-inlog` naast een app `x`) als een van de twee een
  klantportaal is: de deur van het ene zou de Access op de Worker van het andere zijn.

**Het merk.** De inrichting van een klantportaal zet op de Access op de Worker de tekst die
Cloudflare toont aan wie daar wordt geweigerd (`custom_deny_message`): "Dit adres is alleen
voor medewerkers (klantportaal)." Dat gebeurt vóór inloggen per mail aangaat. Toegang bijwerken
leest de Access-apps toch al, en ziet aan dit merk dat een app klantportaal is, ook als
`klantportaal` al uit `toegang.json` is gehaald. App inrichten haalt het merk pas weg als het
portaal weer helemaal dicht is. Een app die nooit klantportaal was heeft het merk niet.

**De Access op de Worker.** Bij een klantportaal vergelijkt stap 4 de adressen van de Access
op de Worker met de naam van de Worker in `wrangler.jsonc`. Ontbreekt een gewenst adres
(`<worker>.<subdomein>.workers.dev` of `*-<worker>...`), dan zet de run het erbij. Hij haalt
nooit een adres weg: wat iemand er met de hand bij zette, blijft bewaakt. Geeft Cloudflare de
bestemmingen terug zonder adres (zo beschrijft de API de nieuwe Worker-bestemmingen), dan is er
niets te vergelijken: een run zonder vinkje laat de adressen met rust en zegt dat, en een run
met het vinkje stopt vóór wijzigingen met wat de owner in Cloudflare doet. Bij een gewone app
kijkt de inrichting niet naar die adressen, zoals op versie 42.

## Captcha (Turnstile)

Supabase Auth weigert elke aanvraag voor een inlogmail zonder geldig bewijs van de widget. De
geheime sleutel gaat naar Supabase, de openbare (`turnstile_sitekey`) zet de inrichting als
variabele `VITE_TURNSTILE_SITEKEY` in omgeving `production` van de app-repo; de app toont de
widget als die variabele er is. Medewerkers via Cloudflare merken er niets van, en de previews
(testdatabase) hebben geen captcha. De widget maakt de owner met de hand (stap 1): de
Cloudflare-sleutel van de beheer-repo mag geen Turnstile-widgets maken.

- **Wanneer hij aangaat.** In dezelfde aanroep als het inloggen per mail (stap 3). Er is dus
  geen moment waarop inloggen per mail openstaat zonder captcha.
- **Het geheim wordt eerst getoetst.** Vóór de eerste wijziging vraagt de inrichting Turnstile
  één keer of het geheim bestaat. Een verkeerd geheim, of de openbare sleutel op de plek van
  de geheime (of andersom), stopt de run. Een `turnstile_sitekey` met de lengte van een geheim
  weigert `toegang.json` zelf al. De openbare testsleutels van Turnstile (een cijfer, een x en
  nullen) worden geweigerd, als geheim en als sitekey: daarmee slaagt elke captcha.
- **Een portaal dat al live is.** Daar verandert een run zonder vinkje niets aan de captcha;
  anders zou een nieuwe sleutel klanten buitensluiten tot de app ermee is uitgerold. Een nieuwe
  widget of een nieuw geheim gaat zo: pull request op `toegang.json` (bij een nieuwe widget),
  het secret vervangen, App inrichten zonder vinkje (zet de openbare sleutel klaar), de app
  uitrollen, en meteen daarna App inrichten met het vinkje. Op een portaal zonder deur zet het
  vinkje het geheim van de captcha; dat is de enige keer dat een run met het vinkje een geheim
  schrijft. Tussen de laatste twee stappen kunnen klanten kort geen code aanvragen.
- **Uitzetten** kan alleen uitdrukkelijk, met `"captcha": false` bij de app. Dan gaat de
  captcha uit, haalt de inrichting `VITE_TURNSTILE_SITEKEY` weg, en staat er bij elke run een
  waarschuwing in de samenvatting.

## Mail

De mail gaat via Resend over SMTP (`smtp.resend.com`, poort 465, gebruiker `resend`). Het adres
van de afzender moet passen op het patroon dat Supabase voor `smtp_admin_email` hanteert;
`toegang.json` gebruikt hetzelfde patroon. Er is één inlogmail, "Inloggen bij <naam>", in
dezelfde vorm als het lokale sjabloon van de app (`supabase/templates/inlogcode.html`): de code
van acht cijfers en een link, allebei 15 minuten geldig en één keer te gebruiken. Supabase
verstuurt hem in drie gevallen: een bekend adres vraagt een code (`magic_link`), een adres
zonder account (`confirmation`: de eerste keer van een nieuwe klant, de eerste inlog van een
nieuwe medewerker via Cloudflare, maar ook als een ander dat adres opgeeft) en de herstelroute
van Supabase (`recovery`). Omdat een ander de mail kan uitlokken, staat erin wat je doet als je
er niet om vroeg: niets, niet klikken, de code aan niemand geven.

De link gaat naar de inlogpagina van de app (`https://<domein>/login?token_hash=...&type=email`),
niet naar Supabase: de pagina logt pas in na een klik op een knop, zodat een linkscanner die
links vooraf opent de link niet verbruikt. Het domein in de link is altijd het eigen domein.

**Adres wijzigen loopt via de eigenaar van de app.** Supabase Auth laat een ingelogde
gebruiker zelf een ander adres aanvragen, buiten de hooks om. De inrichting zet daarom voor
elke mail die Supabase Auth verder kan versturen een eigen tekst zonder link en zonder code:

| Mail | Wat erin staat |
|---|---|
| adres wijzigen (`email_change`) | dat dit niet zelf kan en dat er niets is gewijzigd. Zonder link of code is de wijziging niet te bevestigen |
| controlecode (`reauthentication`) | dat die hier niet nodig is (hij hoort bij wachtwoorden, en die zijn er niet) |
| uitnodiging (`invite`, alleen uit het dashboard van Supabase) | een verwijzing naar de inlogpagina, waar de genodigde een code aanvraagt |

Daarnaast staat `mailer_secure_email_change_enabled` aan, en staan de zeven meldingsmails van
Supabase Auth (wachtwoord gewijzigd, adres gewijzigd, enzovoort) en anoniem aanmelden
uitdrukkelijk uit.

## De twee hooks

**Geen wachtwoorden.** Supabase Auth laat bij inloggen per mail ook aanmelden met een
wachtwoord toe, en heeft geen instelling om alleen dat uit te zetten. Zonder maatregel kan
iemand het adres van een klant aanmelden met een eigen wachtwoord, wachten tot de klant op de
mail klikt die daarvan komt, en daarna met dat wachtwoord inloggen. De functie
`public.<vv>portaal_voor_token` (custom-access-token-hook) weigert daarom elk token van een
sessie die met een wachtwoord begon, ook bij verversen. Alle andere tokens gaan ongewijzigd
door.

**Geen klantaccount op het adres van een medewerker.** De functie
`public.<vv>portaal_voor_aanmelden` (before-user-created-hook) weigert een aanmelding per mail
voor elk domein en elk adres uit de groepen van de app. Via Cloudflare blijft de Access-policy
de poort. Toegang bijwerken schrijft de functie bij elke run opnieuw, zodat hij de groepen
volgt. Twee grenzen:

- Een groep met alleen `idp_groepen` heeft geen adressen; de hook kan die medewerkers niet
  beschermen. De inrichting waarschuwt dan bij elke run. Zet het domein van die medewerkers
  ook in een groep van de app.
- De hook loopt alleen bij een nieuw account. Een medewerker die al een account heeft, kan op
  zijn werkadres ook een mailcode aanvragen; dat opent hetzelfde account in een sessie zonder
  medewerkerrechten.

**Een app met eigen hooks.** Een project heeft van elke soort maar één hook. Heeft de app een
eigen aanmeld-, token- of send-email-hook, dan stopt de inrichting van een klantportaal vóór
de eerste wijziging (de droogloop toont het ook): een klantportaal gebruikt de hooks van de
inrichting. Er is geen schakelaar om de eigen hook te laten staan. Haal hem weg, of overleg met
Stage Two. In de melding staat van een hook over HTTP alleen het schema en de host.

**Rechten.** Beide functies geven de rol van Supabase Auth (`supabase_auth_admin`) `usage` op
het schema `public` en `execute` op de functie, en nemen `execute` af van `authenticated`,
`anon` en `public`. Zo werken ze ook in een app die het schema `public` heeft dichtgezet. Ze
lezen geen tabellen. Beide zijn tegen een echte Postgres gedraaid met de invoer die Supabase
Auth stuurt.

## De rem tegen misbruik

| Instelling | Waarde | Wat het doet |
|---|---|---|
| mails per uur, het hele project samen (`rate_limit_email_sent`) | 100 | Een mailbom kost hoogstens 2400 mails per dag. Is de grens bereikt, dan krijgt dat uur niemand meer een inlogmail |
| tijd tussen twee mails naar hetzelfde adres (`smtp_max_frequency`) | 60 seconden | Eén adres krijgt hoogstens één mail per minuut |
| aanvragen per IP-adres (`rate_limit_otp`) | 5 per vijf minuten, na een voorraad van 30 | Supabase heeft zes tellers per IP-adres, elk met een eigen voorraad van 30 die meteen op mag |
| pogingen om een code of link in te wisselen, per IP-adres (`rate_limit_verify`) | 5 per vijf minuten, na een voorraad van 30 | 1470 gokken per IP-adres per dag, op honderd miljoen mogelijkheden |

- **De tellers per IP-adres houden één mens tegen, geen aanvaller.** Door de voorraad van 30
  per teller (vast in Supabase) kan één computer zonder captcha in een paar minuten de 100
  mails van het uur opmaken. Daarom staat de captcha standaard aan.
- **Een code raden.** Een fout antwoord maakt een code niet ongeldig; daarom acht cijfers in
  plaats van zes. Met 1470 gokken per IP-adres per dag en honderd IP-adressen is de kans op één
  goede gok ongeveer 0,15 procent per dag (met zes cijfers was dat ruim 13 procent). Zie "Open
  punten vóór de eerste klant" voor de aanname over IPv6.
- **Een ingelogde klant kan zelf mails uitlokken.** Adres wijzigen en de controlecode vragen
  geen captcha. Eén account kan zo ruim honderd mails per uur laten versturen en daarmee de
  mailgrens van dat uur opmaken. In die mails staat niets bruikbaars, en de afzender is een
  bekend account dat de eigenaar van de app kan blokkeren (Supabase, Authentication, Users).

De getallen staan op één plek (`REM`, `CODE_LENGTE`, `GOKKEN_PER_DAG` en `SESSIE` in
`lib/supabase.mjs`); wie ze met de hand in Supabase verandert, ziet ze bij de volgende run
terugkomen.

## Sessieduur

Een klantportaal heeft geen deur die elke 30 dagen opnieuw vraagt in te loggen. De inrichting
zet daarom `sessions_inactivity_timeout` op 720 uur: een sessie die 30 dagen niet is gebruikt,
vervalt. Supabase biedt dit alleen op het Pro-plan en hoger; weigert het project de instelling,
dan loopt de inrichting door en staat het als waarschuwing in de samenvatting. De grens van 12
uur voor medewerkerrechten dwingt de app af.

## De previews horen bij de testdatabase

Een preview van een pull request draait code die nog niet is nagekeken. Bij een klantportaal
met een testdatabase haalt de inrichting de previews van de lijst van adressen waar productie
na het inloggen naar terug mag: daar staat alleen nog het eigen domein, en de previews loggen
in bij de testdatabase. Heeft een klantportaal geen testdatabase, dan blijven de previews op de
lijst (anders werkt geen preview meer) en waarschuwt elke run: geef de app een testdatabase.

## Toegang bijwerken bij een klantportaal

In het bestand staan alleen medewerkers. Daarom beoordeelt Toegang bijwerken alleen accounts
met een inlog via Cloudflare. Of een account die heeft, leest hij uit de database van de app
(`auth.identities`).

- Een account zonder Cloudflare-inlog is een klant: geen ban, geen afmelding. Het resultaat
  noemt alleen het aantal; adressen van klanten staan nooit leesbaar in de uitvoer.
- Een medewerker die uit `toegang.json` gaat, wordt net als altijd geband en afgemeld. Dat
  gebeurt eerst; pas daarna komen de testdatabase en de aanmeld-hook. Mislukt een van die
  delen, dan is de rest toch gedaan en eindigt de run rood met de reden.
- Een klantportaal komt vóór de gewone apps aan de beurt. Een fout bij een gewone app stopt de
  run (zoals op versie 42); bij het klantportaal is dan al ingetrokken.
- Een account dat via Cloudflare én per mail kan inloggen gaat helemaal dicht zodra de
  medewerker uit het bestand is, ook de klantkant. Dat is bewust. Moet zo iemand daarna klant
  kunnen zijn, verwijder dan zijn account in Supabase (Authentication, Users); hij logt daarna
  per mail in en begint als nieuwe klant.
- Beoordeeld wordt het adres waarmee Cloudflare iemand binnenliet, niet een adres dat hij
  zelf op zijn account zette. Zelf een inlog van een account afhalen staat uit.

### Een klantaccount op het adres van een medewerker

Wordt een klant medewerker (zijn adres komt in een groep), of gebruikte een medewerker het
klantvak voordat de hook er was, dan bestaat er een klantaccount op een adres van een
medewerker. Zolang dat account bestaat kan die persoon niet als medewerker inloggen: Supabase
maakt bij zijn inlog via Cloudflare een tweede account zonder adres. Toegang bijwerken en App
inrichten melden zulke accounts bij elke run, met het adres gemaskeerd (`j***@klant.nl`) en de
id van het account erbij. Ze ruimen niets op. Wat de owner doet: overleg met de persoon, laat
de eigenaar van de app zo nodig overzetten wat aan het klantaccount hing, verwijder het account
in Supabase (Authentication, Users; zoek op de id) en laat de persoon daarna inloggen via
"Inloggen voor medewerkers". Heeft hij dat al geprobeerd, verwijder dan ook het account zonder
adres dat daarbij ontstond; Toegang bijwerken meldt dat apart.

### Medewerkers bij een klantportaal

Omdat elk adres eerst bewezen moet worden en Cloudflare aan Supabase niet meldt dat een adres
gecontroleerd is: wie al een account had, merkt niets. Een nieuwe medewerker krijgt bij zijn
eerste inlog via Cloudflare één keer de melding dat zijn adres bevestigd moet worden, en de
inlogmail. Daarna werkt inloggen voor medewerkers gewoon.

## Terug naar een gewone app

De stappen voor de owner staan in de README ("Als het misgaat: terug achter de deur"). Wat er
gebeurt:

1. Zodra `klantportaal` uit het bestand is, draait Toegang bijwerken. Die ziet aan het merk dat
   de app nog als klantportaal is ingericht, met of zonder deur. Hij beoordeelt de medewerkers
   zoals altijd, laat de klanten met rust, en eindigt rood met één melding: "wacht op App
   inrichten". Was het een vergissing, zet dan `"klantportaal": true` terug; er is geen klant
   geraakt.
2. App inrichten zegt in de droogloop en in de samenvatting dat het klantportaal dichtgaat. De
   echte run zet eerst de deur terug, zet daarna inloggen per mail uit, geeft elk klantaccount
   (een account zonder inlog via Cloudflare) het kenmerk `klantportaal_klant`, meldt de klanten
   af en haalt als laatste het merk weg. Niemand wordt geband. Stopt de run halverwege, dan
   staat de deur er al en maakt de volgende run het af.
3. Daarna is het een gewone app. Toegang bijwerken slaat accounts met dat kenmerk voorgoed
   over en trekt verder in zoals altijd. Wordt de app later weer een klantportaal, dan kunnen
   dezelfde klanten weer inloggen.

Een gesloten portaal blijft in een veilige stand: de instellingen voor SMTP, de hooks en de
sessieduur blijven staan (zonder inloggen per mail doen ze niets), de mail voor adres wijzigen
krijgt een vaste tekst zonder code, en zelf een inlog loskoppelen en anoniem aanmelden blijven
uit. App inrichten herhaalt het markeren bij elke run van zo'n app.

## Een gewone app merkt hier niets van

Een app die niet als klantportaal in `toegang.json` staat en het ook nooit was, krijgt dezelfde
aanroepen in dezelfde volgorde, hetzelfde resultaat, dezelfde regel op stdout en dezelfde
exitcode als op versie 42, ook als een leesvraag hapert, als zijn deur ontbreekt of hernoemd
is, als iemand inloggen per mail met de hand aanzette, of als de Access op de Worker met de
hand is veranderd. Alles wat nieuw is (controles, de rem, leesvragen, waarschuwingen, een rode
eindstatus) geldt alleen voor een app die klantportaal is, of die het aantoonbaar was: aan het
merk, aan het kenmerk op de klantaccounts, of aan de sporen in de inloginstellingen die App
inrichten op versie 42 ook al las. Merk en sporen tellen alleen als ze exact zijn wat de
inrichting zelf zet: een hook die aan staat met precies `pg-functions://postgres/public/<functie>`,
of de mail zonder controlecode met precies dat onderwerp en die tekst. Een eigen hook van de
klant met een naam die erop lijkt (in een ander schema, of met iets ervoor of erachter) telt
niet. `regressie-42-versie.test.mjs` bewijst dat tegen de code van versie 42 zelf; wat bewust
verschilt (alleen tekst, `--deur-weghalen`, `"klantportaal": false`, en een app die
`constructor` heet) staat onder "Lokaal testen" in de README. Het script schrijft zijn eigen
samenvatting van de run alleen als er in `toegang.json` een klantportaal staat of als een
portaal dicht moet, en maskeert `SMTP_WACHTWOORD` en `TURNSTILE_GEHEIM` alleen dan; voor een
gewone app schrijft de workflow de samenvatting, zoals op 42.

## Controle van buitenaf

De workflow Controle van buitenaf (in de proef `proef-controle.yml`) draait
`controle-doorsteek.mjs --app <naam>`. Het script zoekt zelf op wat de inrichting kent: het
domein (uit `wrangler.jsonc`), het `workers.dev`-adres, de vaste preview
(`actueel-<worker>...`), het project en de openbare sleutel van Supabase, en of de app een
klantportaal is. Het wijzigt niets.

- **Welke sleutels, en waarom.** De Cloudflare-sleutel, om het `workers.dev`-subdomein van het
  account te lezen (daaruit volgen het `workers.dev`-adres en de preview). Het access token en
  de organisatie van Supabase, om het project van de app te vinden en zijn openbare sleutel te
  lezen. De service-role-sleutel haalt het script niet op, en het krijgt geen sleutel voor
  GitHub, geen `SMTP_WACHTWOORD` en geen `TURNSTILE_GEHEIM`.
- **Wat hij bekijkt.** Van elk adres dat dicht hoort te zijn de voorpagina en een willekeurig
  diep pad. Bij een klantportaal is "dicht" streng: alleen een doorverwijzing naar de
  loginpagina van Cloudflare Access (van het eigen team) telt; een adres dat niet bestaat of
  404 geeft, is gezakt. Het domein hoort dan open te zijn. Uit de openbare instellingen van de
  inlogdienst (`/auth/v1/settings`) leest hij of inloggen per mail staat zoals het hoort (bij
  een gewone app uit). De captcha ziet hij door een code aan te vragen zonder adres en zonder
  bewijs van de widget: met de captcha aan weigert Supabase Auth dat. Er gaat geen mail uit.
- **Het rapport** schrijft het script zelf naar de samenvatting van de run, met onder "Wat nu"
  wat de owner doet. De workflow heeft een eigen concurrency-groep.

## Open punten vóór de eerste klant

Deze punten volgen uit documentatie of broncode en zijn nog niet op een echt account geprobeerd.
Loop ze na in de proef vóór de eerste klant live gaat.

- **IPv6 en de code van acht cijfers.** De som bij "De rem" klopt alleen als "een IP-adres" ook
  echt één aanvaller is. In de broncode telt Supabase Auth per letterlijk adres, en één gewone
  aansluiting met IPv6 heeft er miljarden. Telt het platform van Supabase zulke adressen niet
  samen, dan haalt één aanvaller met 65.000 adressen een kans van ruim de helft per dag. Vraag
  dit bij Supabase na, en kies anders voor een code van tien cijfers (`CODE_LENGTE`, samen met
  het codevak in de app).
- **Het merk.** Dat Cloudflare `custom_deny_message` in de lijst Access-apps teruggeeft, en een
  lege tekst accepteert om hem weg te halen. De nep-wolk neemt beide aan; de openbare
  documentatie noemt het veld wel, maar zegt niets over wissen met een lege tekst. Wat er
  misgaat als de echte API anders is:
  - Geeft de lijst het veld niet terug, dan ziet Toegang bijwerken niet meer dat een app
    klantportaal is (geweest) zodra `klantportaal` uit `toegang.json` is gehaald. Draait Toegang
    bijwerken dan vóór App inrichten, dan worden de klanten (accounts zonder inlog via
    Cloudflare) geband en afgemeld, in plaats van de rode melding "wacht op App inrichten".
  - Negeert Cloudflare een lege tekst, dan blijft het merk staan nadat App inrichten het
    portaal heeft gesloten. Toegang bijwerken behandelt de app dan als een portaal dat nog
    dicht moet: hij eindigt rood met "wacht op App inrichten", en een vreemde met alleen een
    mailaccount wordt niet meer ingetrokken.

  Een gewone app die nooit klantportaal was merkt van geen van beide iets (getest). Nagaan in
  de proef: na stap 3 de lijst Access-apps lezen en kijken of het merk erin staat; na het
  sluiten (terug achter de deur) opnieuw, en kijken of het weg is.
- **Het vinkje.** De run met het vinkje vergelijkt de inloginstellingen die Supabase teruggeeft
  met wat de inrichting zet. Geeft de echte API een veld anders terug dan het is gezet
  (bijvoorbeeld een getal als tekst), dan weigert het vinkje en noemt het dat veld. Doe stap 3
  tot en met 5 een keer in de proef.
- **De token-hook.** Dat Supabase Auth een weigering van de token-hook omzet in "geen sessie"
  volgt uit de broncode (de hook loopt in dezelfde transactie als de nieuwe sessie).
- **Turnstile.** Dat siteverify een onbekend geheim meldt als `invalid-input-secret`.
- **De captcha van buitenaf.** Dat een aanvraag zonder adres en zonder bewijs `captcha_failed`
  geeft, en dat de openbare sleutel zonder `reveal` op te halen is.
- **De meldingsmails en anoniem aanmelden.** Dat elk project de velden
  `mailer_notifications_*_enabled` en `external_anonymous_users_enabled` accepteert (ze staan in
  het schema van de Management API).
