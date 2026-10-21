# <projectnaam>

> **Tier 2 van de Stage Two-stack.** Deze template hoort bij de plugin
> `stagetwo-plugin-tier2`, die Stage Two bij de start net als de template als kopie in de
> GitHub van je eigen organisatie klaarzet: de app draait op Cloudflare, en Cloudflare is het enige punt waar
> inloggen en toegang geregeld worden. De gegevens staan bij Supabase. Tier 1 (alleen
> Cloudflare, met D1 en R2) is `app-template-tier1` met de plugin `stagetwo-plugin-tier1`;
> welke variant je organisatie heeft, spreekt Stage Two bij de start met je af.

<!-- Vervang <projectnaam> en schrijf hieronder in één zin wat deze app doet,
     in gewone taal, vanuit de gebruiker. -->

## Wat je hier vindt

Dit is de werkplaats van deze applicatie. Alles wat de app doet staat hier, en elke
wijziging die ooit gemaakt is, is hier terug te vinden.

Je hoeft geen programmeur te zijn om hier te werken. Je beschrijft in gewone taal wat
je wilt, je AI-assistent maakt de wijziging, en een reeks automatische controles kijkt
mee voordat er iets live gaat. Die controles zijn je vangnet: ze zijn er zodat je kunt
experimenteren zonder iets kapot te kunnen maken.

Welke assistent je gebruikt maakt niet uit: Claude Code, Codex, Cursor, Copilot of een
andere. De afspraken staan in `AGENTS.md`, en dat bestand lezen ze allemaal. De
controles zijn voor iedereen hetzelfde.

## Beginnen

Open je assistent **in deze map**. Dat is belangrijk: alleen dan leest hij de afspraken
die bij dit project horen. Doe je het ergens anders, dan verzint hij zijn eigen werkwijze.

```
cd <deze map>
claude        # of: codex, cursor, ... wat je ook gebruikt
```

Vraag daarna gewoon wat je wilt, bijvoorbeeld "kun je een filter op datum toevoegen aan
het overzicht". De vaste route staat in `docs/routes/verder-werken.md`; je assistent
hoort die zelf te pakken. Doet hij dat niet, zeg dan: "volg de route in
docs/routes/verder-werken.md".

**Werk je met Claude Code?** Dan vraagt Claude Code bij het openen van deze map of je de
Stage Two-plugin wilt installeren. Zeg ja. Die plugin geeft je assistent vier commando's
(`/stagetwo-tier2:installatie`, `/stagetwo-tier2:nieuwe-app`, `/stagetwo-tier2:verder-werken` en `/stagetwo-tier2:updaten`),
houdt hem tegen als hij aan de gedeelde werkwijze wil zitten, en meldt het als er een
nieuwere versie van die werkwijze is; die komt als pull request (zie onderaan). Wat de
plugin precies doet en hoe je hem installeert, staat in de README van de repository
`stagetwo-plugin-tier2` in de GitHub van je eigen organisatie.
Werk je met een andere assistent, dan mis je alleen die gemakken: de afspraken en de
controles gelden voor iedereen.

## Hoe een wijziging live komt

Altijd via dezelfde vijf stappen. Ook voor een komma, en ook als Stage Two het doet.

1. **Een aftakking maken.** Je werkt aan een kopie, niet aan de live versie. Er kan dus
   niets misgaan terwijl je bezig bent.
2. **De wijziging maken**, met een test erbij die vastlegt wat er nu anders is.
3. **Een voorstel openen** (een "pull request"). Dat is de plek waar je ziet wat er
   precies verandert.
4. **De controles laten draaien.** Ze moeten allemaal groen zijn. Rood betekent: er is
   iets mis, en het gaat niet live.
5. **Op de knop Merge drukken.** Dat is het moment dat het live gaat. Er is verder geen
   knop en geen handeling nodig.

Bij stap 3 krijg je een **preview-link**: een echte, werkende versie van de app met
jouw wijziging erin, die je kunt openen en aan een collega kunt sturen. Gebruik altijd
die link om iets te laten zien, nooit een adres dat met `localhost` begint. Dat laatste
werkt alleen op de computer waar het draait.

## De controles, in gewone taal

Ze draaien vanzelf zodra je een voorstel opent. Duurt bij elkaar een paar minuten.

| Wat er gecontroleerd wordt | Waarom |
|---|---|
| Klopt de code met zichzelf | de meeste fouten vallen hier al door de mand |
| Is de opmaak netjes | zodat je kunt zien wat er echt verandert |
| Doen de bestaande functies het nog | voorkomt dat een nieuwe wens iets ouds sloopt |
| Bouwt de app echt | een app die niet bouwt, gaat ook niet live |
| Staat er geen wachtwoord of sleutel in | dit is de gevaarlijkste fout die er bestaat |
| Zijn er geen fouten weggemoffeld | een groene controle mag niet gekocht zijn |
| Is elke tabel afgeschermd | anders kan iemand bij gegevens van een ander |
| Zit er een test bij je wijziging | anders kijkt er niemand meer mee |
| Gaan er geen gegevens verloren | verwijderen kan alleen als je het bewust bevestigt |
| Zijn de gedeelde afspraken ongemoeid | anders heeft dit project stilletjes andere regels dan de rest |
| Klopt de app nog met de database | voorkomt fouten die pas live zichtbaar zouden zijn |
| Werkt de belangrijkste route nog | inloggen, iets toevoegen, het terugzien |

**Staat er iets rood?** Vraag je assistent wat er misgaat en om het op te lossen. Zet
een controle nooit uit om verder te kunnen. Ze staan er juist voor de momenten dat je
haast hebt.

## Als je iets nodig hebt

- **Een wijziging aan deze app**: gewoon vragen; de route staat in
  `docs/routes/verder-werken.md`.
- **Iemand toegang geven**: dat mag je zelf, in `toegang.json` van de beheer-repo van je
  organisatie; je assistent weet hoe.
- **Een sleutel van een ander systeem** (Stripe, Moneybird, een AI-dienst): die zet de owner
  van je organisatie, niet de bouwer.
- **Een compleet nieuwe app**: typ `/stagetwo-tier2:nieuwe-app` in een lege map. Een nieuwe app
  krijgt een eigen werkplaats, dus die kun je niet vanuit deze map beginnen.
- **Iets aan de accounts, het domein of een rekening** (GitHub, Cloudflare, Supabase,
  Sentry): die staan op naam van je organisatie en zijn van jou; de owner van je organisatie
  regelt ze. In de projectfase richt Stage Two ze namens je in en helpt daarbij.

## Voor wie het naadje van de kous wil

- De volledige werkwijze en het waarom van elke keuze: [`docs/WERKWIJZE.md`](docs/WERKWIJZE.md)
- De afspraken zoals elke assistent ze leest: [`AGENTS.md`](AGENTS.md)
- De vaste routes, stap voor stap: [`docs/routes/`](docs/routes/)
- Waar deze werkplaats vandaan komt: de sectie hieronder.

## Waar deze werkplaats vandaan komt

Deze app is begonnen uit de **app-template (tier 2)** van Stage Two. Bij de start zet Stage
Two daarvan een eigen kopie klaar in de GitHub van je organisatie: de repository
`app-template-tier2`, met daarnaast `stagetwo-plugin-tier2` voor de plugin. De template bevat alleen de bouwstenen en de
afspraken; er staan geen geheimen, sleutels of klantgegevens in, en de checks die hier
draaien lezen hun secrets uit je eigen organisatie.

Wat je bouwt en je gegevens zijn van jou. Plugin en template mag je blijven gebruiken en ze
blijven werken, ook zonder Stage Two (zie `LICENSE-STAGE-TWO`). Zolang je bedrijf een
abonnement bij Stage Two heeft, zet Stage Two nieuwe versies van template en plugin in die
kopie in je eigen GitHub. Stage Two past elke versie eerst toe op de eigen apps van Stage Two.
Stopt het abonnement, dan blijft die kopie op de laatste versie staan; er komt alleen niets
nieuws bij.

Het abonnement kost €150 per maand per bedrijf, ongeacht het aantal apps, exclusief btw. Het
loopt vanaf de oplevering, het moment waarop Stage Two de omgeving aan je bedrijf overdraagt,
en is per maand opzegbaar, met een opzegtermijn van één kalendermaand. Daarin zitten nieuwe
versies van template en plugin, een nieuwe versie als een leverancier iets verandert, een
nieuwe versie van de beheer-repo als dat nodig is, en vragen en meedenken, tot ongeveer een
uur per maand (meer tijd op afspraak). Het abonnement
houdt de omgeving niet bij: beheer en werking blijven na de overdracht bij je bedrijf. Niet in
het abonnement zitten systeembeheer, een garantie op beschikbaarheid en meer werk aan je
apps; dat laatste doet Stage Two op verzoek, op nacalculatie tegen €120 per uur exclusief
btw. Dependabot, een dienst van GitHub, stelt in elke app updates van de npm-pakketten voor,
ook zonder abonnement, als pull request die een bouwer goedkeurt; de versies van de
GitHub-workflows komen met een nieuwe versie van de template; alleen een beveiligingsupdate kan
Dependabot tussendoor voorstellen. Hoogt die alleen de versie van een GitHub Action op, dan laat
de controle op templatebestanden hem door.

Na de overdracht heeft Stage Two zelf geen toegang tot je apps en geen eigen account of
beheerrechten in de GitHub-organisatie van je bedrijf, tenzij je bedrijf dat wil; die toegang
kan je bedrijf altijd zelf intrekken. Voor het abonnement is die toegang niet nodig. Je apps veranderen nooit vanzelf. De plugin wel: dat is software van Stage Two die op
de computers van je bouwers draait met hun rechten en zichzelf bijwerkt uit de kopie. Wil je
dat zelf bepalen, vraag je assistent dan om het uit te zetten; daarna werk je de plugin bij
met `/stagetwo-tier2:updaten`. In de Claude-app werken dan ook andere plugins op die computer
zich niet meer vanzelf bij. Nieuwe versies komen binnen via de GitHub App
`stagetwo-levering`. Stage Two
installeert die bij de start namens je bedrijf, op alleen de twee kopieën, `app-template-tier2`
en `stagetwo-plugin-tier2` ("Only select repositories"); je bedrijf kan hem altijd zelf
verwijderen. Die app heeft alleen daar schrijfrecht, niet op je apps. Heeft de beheer-repo een nieuwe
versie nodig, dan vraag je Stage Two erom; de owner geeft Stage Two daarvoor tijdelijk toegang
en haalt die daarna weer weg. Zeg je op, dan haalt Stage Two je bedrijf uit de lijst van
abonnees en haalt het de App `stagetwo-levering` uit je organisatie. Meer staat op
[stagetwo.nl/#aanbod](https://stagetwo.nl/#aanbod).

Onder welke voorwaarden je de onderdelen van Stage Two mag gebruiken, staat in het bestand
`LICENSE-STAGE-TWO`; de licentie van de eigen code van deze app staat in `LICENSE`.

Een nieuwe versie raakt twee dingen, en die gaan apart:

- **Het gereedschap op je computer.** De plugin werkt zichzelf bij uit de kopie in je eigen
  GitHub (dat kan uit, zie hierboven).
- **Je apps.** Die veranderen alleen via een voorstel dat een bouwer goedkeurt. Is er een
  nieuwe versie, dan meldt de plugin dat bij het openen van een sessie. Met
  `/stagetwo-tier2:updaten` zet de plugin voor deze app het update-voorstel klaar, als pull
  request: een deel van de bestanden hier (de controles, de afspraken, de routes) komt uit de
  template en wordt in zijn geheel vervangen; alles wat van dit project is, blijft staan. Wat
  waarvan is, staat in `.claude/stack-manifest.json`. De bouwer keurt het voorstel goed of
  laat het liggen.

De versie waar deze app op staat, staat in `.claude/stack-version`.

## De app op je eigen computer zien terwijl je bouwt (optioneel)

Wil je niet op de preview-link wachten om te zien wat je assistent net gemaakt heeft?
In de Claude-app hoef je daar niets voor te doen: je assistent start de app op je eigen
computer en toont hem in het venster naast het gesprek. Hij kijkt daar zelf ook mee om
zijn werk te controleren. De app praat dan met de testdatabase, nooit met de echte
gegevens. Werk je met een andere assistent, dan staat de route in
`docs/routes/lokaal-kijken.md`, inclusief wat er op je computer geïnstalleerd moet zijn
(git, Node, pnpm) en welke database je daarvoor gebruikt.

Het is een hulpmiddel tijdens het bouwen, niet de manier om werk te laten zien of live
te zetten: dat blijft de preview-link van het voorstel. Daarom start de app buiten de
Claude-app alleen met `STACK_ALLOW_DEV=1` ervoor; zonder die variabele weigert
`pnpm dev`, en dat is geen storing.
