# Laatste Kans Groningen

Webapp voor je iPhone. Hij beoordeelt de afgeprijsde Laatste Kans Koopjes van Albert Heijn in Groningen op jouw dieet en of het een goede deal is.

## Gebruik

1. Open de app-link in Safari of in de Claude-app en log in bij Claude. Via Delen en dan "Zet op beginscherm" staat hij als icoon tussen je apps.
2. Stel bij **Dieet** je doel in, wat je niet eet, je kcal en eiwit per dag, je budget en of je een vriezer hebt.
3. Voeg producten toe op een van deze manieren:
   - **Screenshot AH-app.** Zet de AH-app in winkelmodus, open Laatste Kans Koopjes, kies je winkel en maak screenshots. Laad ze hier: Claude leest naam, prijs, korting en datum.
   - **Foto in de winkel** van producten met een kortingssticker.
   - **Typen**, bijvoorbeeld `kipfilet 500g 6,49 35%`.
4. Elk product krijgt een oordeel: **Kopen**, **Twijfel**, **Laten liggen** of **Past niet** (bevat iets wat je niet eet). Je ziet ook waarom, met eiwit per euro, prijs per kg en houdbaarheid.
5. **Koken** laat zien wat vandaag op of de vriezer in moet en geeft maaltijdideeën. Claude kan er een plan voor de komende dagen van maken.
6. **Logboek** houdt per rit en per maand bij wat je uitgaf en bespaarde.

Je gegevens staan privé in je Claude-account. Ook iemand met de link ziet ze niet. Lukt opslaan even niet, dan bewaart de app alles op je toestel en zet hij het bij je volgende bezoek alsnog in je account.

## Waarom screenshots en geen directe koppeling met AH

AH toont de Laatste Kans Koopjes per winkel alleen in de eigen app en heeft er geen openbare API voor. Er bestaat wel een onofficiële API, maar die vraagt je AH-login en doet zich voor als de AH-app. Daarom leest deze app wat jij ziet.

## Wat erin zit

| Bestand | Inhoud |
|---|---|
| `src/app.html` | De app: opmaak, beoordelingsregels, opslag en Claude-functies |
| `data/food.json` | 130 producten die vaak worden afgeprijsd, met richtwaarden voor voeding per 100 g, verpakking, richtprijs en tags (allergenen, vlees, vis, bewerkt) |
| `data/stores.json` | 23 AH-winkels in de gemeente Groningen, inclusief Haren en AH to go |
| `data/tips.json`, `data/safety.json` | Hoe AH afprijst, beste momenten, en de TGT/THT- en invriesregels van Voedingscentrum en NVWA |
| `build.py` | Voegt de data in en maakt `dist/artifact.html` (voor claude.ai) en `dist/index.html` (los te hosten) |
| `tests/` | Playwright-tests voor de beoordeling, de winkelflow, de opmaak op telefoonbreedte en het gedrag binnen claude.ai |

## Beperkingen

- De voedingswaarden zijn richtwaarden: model-schattingen in NEVO-stijl en AH-etiketwaarden uit zoekresultaten. Ze zijn niet regel voor regel in de NEVO-database gecontroleerd. Bij twijfel geldt het etiket; je kunt elke waarde in de app aanpassen.
- De winkellijst en openingstijden komen uit zoekresultaten van november 2026 en zijn niet op ah.nl zelf gecontroleerd. AH Hereweg 53 was nog niet open.
- Screenshots, foto's en plannen werken alleen binnen claude.ai, omdat daar Claude beschikbaar is. `dist/index.html` op een eigen host (GitHub Pages, Netlify) werkt zonder Claude: je typt dan zelf en de gegevens blijven in die browser.

## Ontwikkelen

```sh
python3 build.py           # data controleren en dist/ bouwen
node tests/test_app.js     # beoordeling, winkelflow, opmaak licht en donker
node tests/test_viewer.js  # opslag, synchronisatie en Claude, met een nagebootste claude.ai-omgeving
python3 make_icon.py       # beginschermicoon opnieuw tekenen
```
