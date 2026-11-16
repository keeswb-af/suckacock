# Laatste Kans Groningen

App voor je iPhone. Hij haalt de Laatste Kans Koopjes van jouw Albert Heijn in Groningen live op en beoordeelt elk koopje op je dieet en op prijs.

Er zijn twee versies, met dezelfde schermen en dezelfde beoordeling:

| | Live (Scriptable) | Web (claude.ai) |
|---|---|---|
| Koopjes | Live van AH, per winkel, met voedingswaarden van het etiket | Screenshot uit de AH-app, foto of typen |
| Draait in | De gratis iPhone-app [Scriptable](https://apps.apple.com/nl/app/scriptable/id1405459188) | Safari of de Claude-app |
| Extra | Widget op je beginscherm | Claude leest screenshots en maakt een kookplan |
| Gegevens | iCloud Drive, map Scriptable | Privé in je Claude-account |

## Live installeren

1. Installeer Scriptable uit de App Store.
2. Open in Scriptable een nieuw script (+), plak de inhoud van [`dist/installer.js`](dist/installer.js) en tik op afspelen. De claude.ai-versie heeft onder Info een knop die deze code kopieert.
3. Open het script **Laatste Kans**. Tik bovenaan op **Kies je AH** en vink een of meer winkels aan, of tik op **Alle winkels**. Stel bij **Dieet** je doel in, wat je niet eet en je kcal en eiwit per dag.
4. De koopjes van al je winkels komen in één lijst; elke kaart zegt bij welke winkel. Met de keuzelijst **Toon** zie je er één tegelijk; hetzelfde product bij meerdere winkels staat op één kaart met de prijzen elders eronder. **Past bij mij** verbergt wat niet bij je dieet past. **Vernieuw koopjes** haalt alles opnieuw op; AH zet de hele dag nieuwe koopjes klaar en de korting loopt op richting de avond.
5. Tik op **Inloggen bij AH** en log in met je AH-account. AH geeft de koopjes alleen aan ingelogde gebruikers (zonder login antwoordt AH met "Subgraph errors redacted"). Dat hoeft één keer; de sleutel staat in de iOS-sleutelhanger.
6. Widget: lang drukken op je beginscherm, +, Scriptable, en kies het script Laatste Kans. De widget toont wat je vandaag moet halen, hoeveel koopjes bij je dieet passen en de beste paar.
7. Bijwerken: **Info** en dan **Script bijwerken**.

## Hoe het werkt

- **Vandaag halen** (bovenaan Winkel) zegt per dag wat je moet kopen. De app maakt een dagmenu van goedkope basisproducten (havermout, melk, kwark, eieren, kip, vis, rijst, groente) dat past bij je kcal en eiwit per dag en bij wat je niet eet, en zet alleen op de lijst wat je niet in huis hebt. Kies bij **Halen bij** AH, Jumbo, Lidl of per product de goedkoopste.
  - **Gekocht** en **Heb ik** zetten iets in je voorraad. Elke dag trekt de app af wat het menu van die dag gebruikt. Ben je een dag niet in de app geweest, dan telt het menu van die dag als gegeten.
  - Koopjes gaan voor: een koopje in je mandje of voorraad neemt een plek in het menu in (eerst wat vandaag op moet), en een koopje in Gevonden dat per gram eiwit, per kcal of per kilo goedkoper is dan het basisproduct, staat bij **Koopjes voor je plan**.
  - **Voor morgen alvast** toont wat morgen op is, zodat je het in één keer meeneemt. Onder **Menu van vandaag** haal je met × een product uit je menu.
  - Het menu wisselt per weekdag: vis op donderdag, sardientjes op dinsdag en zaterdag, 100 g kippenlever op zaterdag (veel vitamine A, daarom niet vaker). Koolhydraatarm en keto krijgen eieren en vet in plaats van brood, havermout en rijst.
- **Nu kopen of wachten.** Elke keer dat de app of de widget de koopjes ophaalt, onthoudt hij per winkel en per product de korting, de prijs en de voorraad. Zo leert hij hoe de korting oploopt (bijvoorbeeld 25% → 40% rond 15:00 → 70% rond 19:00) en hoe vaak een product al op is voordat de volgende stap komt. Op elke kaart staat dan **Nu kopen**, **Wachten loont** of **Gok**, met de reden en op hoeveel gevallen het is gebaseerd. Heeft hij te weinig gegevens over dat product, dan kijkt hij naar dezelfde soort producten in die winkel, daarna in al je winkels. De metingen van de laatste week worden volledig bewaard; oudere worden samengevat zodat de geschiedenis maanden kan beslaan. Onder **Logboek** staat per winkel het patroon dat de app tot nu toe heeft gezien. Hoe vaker de app of de widget kijkt, hoe beter: zet de widget op je beginscherm.
- Elk product krijgt **Kopen**, **Twijfel**, **Laten liggen** of **Past niet** (bevat iets wat je niet eet). Je ziet waarom: eiwit per euro, prijs per kg, koolhydraten per pak, houdbaarheid en of het de vriezer in kan.
- **Koken** laat zien wat vandaag op of de vriezer in moet en geeft maaltijdideeën met wat je kocht.
- **Logboek** houdt per rit en per maand bij wat je uitgaf en bespaarde.

Het live ophalen gebruikt dezelfde, niet-officiële koppeling als de AH-app (`api.ah.nl`, GraphQL-query `bargainItems`). De verzoeken zijn opgebouwd zoals in de open-source client [appie-go](https://github.com/gwillem/appie-go). Eerst probeert het script een anoniem token; vraagt AH om een login, dan opent het het AH-inlogscherm. Een webpagina kan dit niet: browsers en claude.ai blokkeren aanroepen naar andere servers. Scriptable mag het wel.

## Wat erin zit

| Bestand | Inhoud |
|---|---|
| `src/page.html` | Opmaak en schermen |
| `src/engine.js` | Beoordeling, productherkenning, omzetten van AH-koopjes en etiketwaarden |
| `src/ui.js` | Schermlogica, opslag, Claude-functies en de koppeling met Scriptable |
| `src/scriptable.js` | Het Scriptable-script: AH-login, winkel opzoeken, koopjes en voeding ophalen, app tonen, widget |
| `data/food.json` | 130 producten die vaak worden afgeprijsd, met richtwaarden voor voeding, verpakking, richtprijs en tags |
| `data/stores.json` | 23 AH-winkels in de gemeente Groningen, inclusief Haren en AH to go |
| `data/staples.json` | 21 basisproducten met voedingswaarden en prijzen bij AH, Jumbo en Lidl, en het dagmenu per maaltijd |
| `data/tips.json`, `data/safety.json` | Hoe AH afprijst en de TGT/THT- en invriesregels van Voedingscentrum en NVWA |
| `build.py` | Bouwt `dist/artifact.html` (claude.ai), `dist/index.html` (los te hosten), `dist/LaatsteKans.js` (Scriptable) en `dist/installer.js` |
| `tests/` | Tests voor de beoordeling, de schermen, de claude.ai-opslag en het Scriptable-script tegen een nagebootste AH |

## Beperkingen

- De koppeling met AH is niet officieel. Als AH haar verandert, werkt live ophalen niet meer tot het script is aangepast. Het script is getest tegen een nagebootste AH en een nagebootst Scriptable, nog niet tegen de echte.
- Producten die niet in de tabel staan, krijgen hun voedingswaarden van het AH-etiket. Allergenen haalt het script niet bij AH op; die leidt de app af uit de productnaam. Heb je een allergie, check dan het etiket. Voor wie iets niet eet, geeft de app zulke producten daarom hooguit **Twijfel**.
- De voedingswaarden in de tabel zijn richtwaarden en niet regel voor regel gecontroleerd in NEVO.
- De winkellijst en openingstijden komen uit zoekresultaten van november 2026 en zijn niet op ah.nl zelf gecontroleerd.
- De prijzen van basisproducten komen uit de open prijsdata van [checkjebon.nl](https://github.com/supermarkt/checkjebon) van 16 november 2026 en worden niet live bijgewerkt. Werk `data/staples.json` af en toe bij. De voorraad is een schatting: de app weet niet wat je echt eet, alleen wat het menu zegt.

## Ontwikkelen

```sh
python3 build.py                 # data controleren en dist/ bouwen
node tests/test_app.js           # beoordeling, schermen, opmaak licht en donker
node tests/test_viewer.js        # opslag en Claude binnen een nagebootste claude.ai
node tests/test_scriptable.js    # Scriptable-script tegen een nagebootste AH
python3 make_icon.py             # beginschermicoon opnieuw tekenen
```
