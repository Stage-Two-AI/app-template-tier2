# <projectnaam>

> **Tier 2 van de Stage Two-stack.** Deze template hoort bij de plugin
> `Stage-Two-AI/stagetwo-plugin-tier2`: de app draait op Cloudflare, en Cloudflare is het
> enige punt waar inloggen en toegang geregeld worden. De gegevens staan bij Supabase.
> Tier 1 (alleen Cloudflare, met D1 en R2) is `Stage-Two-AI/app-template-tier1` met de plugin
> `Stage-Two-AI/stagetwo-plugin-tier1`.

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
nieuwere versie van die werkwijze is; ophalen doe je dan zelf met `/stagetwo-tier2:updaten`. Wat de plugin precies doet en hoe je
hem installeert staat op [github.com/Stage-Two-AI/stagetwo-plugin-tier2](https://github.com/Stage-Two-AI/stagetwo-plugin-tier2).
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
- **Een compleet nieuwe app**: typ `/stagetwo-tier2:nieuwe-app` in een lege map. Een nieuwe app
  krijgt een eigen werkplaats, dus die kun je niet vanuit deze map beginnen.
- **Iets aan de instellingen, toegang of een rekening**: dat regelt Stage Two.

## Voor wie het naadje van de kous wil

- De volledige werkwijze en het waarom van elke keuze: [`docs/WERKWIJZE.md`](docs/WERKWIJZE.md)
- De afspraken zoals elke assistent ze leest: [`AGENTS.md`](AGENTS.md)
- De vaste routes, stap voor stap: [`docs/routes/`](docs/routes/)
- Waar deze werkplaats vandaan komt: de sectie hieronder.

## Waar deze werkplaats vandaan komt

Deze app is begonnen uit de **app-template (tier 2)** van Stage Two:
[github.com/Stage-Two-AI/app-template-tier2](https://github.com/Stage-Two-AI/app-template-tier2).
Die template is openbaar. Dat is een bewuste keuze: zo kan elke klant er zonder
toestemming of sleutel van Stage Two nieuwe apps van maken en verbeteringen uit ophalen,
ook lang nadat Stage Two vertrokken is. De template bevat alleen de bouwstenen en de
afspraken; er staan geen geheimen, sleutels of klantgegevens in, en de checks die hier
draaien lezen hun secrets uit je eigen organisatie. Onder welke voorwaarden je de
template mag gebruiken staat in het bestand `LICENSE` in die repository.

Verbetert Stage Two de werkwijze, dan krijgt deze app dat als versie erbij: een deel van
de bestanden hier (de controles, de afspraken, de routes) komt uit de template en wordt
in zijn geheel vervangen; alles wat van dit project is, blijft staan. Wat waarvan is,
staat in `.claude/stack-manifest.json`. Ophalen doe je zelf, wanneer jij wilt, met
`/stagetwo-tier2:updaten` uit de Stage Two-plugin; het komt als pull request die jij bekijkt en
goedkeurt. De versie waar deze app op staat, staat in `.claude/stack-version`.

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
