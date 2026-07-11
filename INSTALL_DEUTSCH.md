# Midea iECO + Ion-Sterilisierung — Installation für Homey Self-Hosted Server

Diese gepatchte Version der App `nl.intyme.midea` fügt zwei Funktionen hinzu, die der Original-Entwickler nicht implementiert hat:

- **iECO** (intelligenter Inverter-Sparmodus)
- **Ion** (negative Ionen / Anionen-Sterilisierung)

Beide sind in deinen Homey-Automatisierungen als Trigger, Bedingung und Aktion verfügbar.

---

## Voraussetzungen

- Homey Self-Hosted Server läuft (Docker auf deiner Ugreen NAS)
- Windows-PC im **gleichen Netzwerk** wie die NAS
- Node.js installiert (siehe Schritt 1)

---

## Schritt 1 — Node.js installieren (einmalig)

1. Gehe auf [nodejs.org](https://nodejs.org/) und lade die **LTS-Version** (Empfehlung) für Windows herunter.
2. Installer doppelklicken → Standardoptionen → fertig.
3. Öffne die **Eingabeaufforderung** (Windows-Taste, "cmd" eingeben, Enter).
4. Prüfe mit `node -v` → muss z. B. `v20.x` o. ä. ausgeben.

## Schritt 2 — Homey-CLI installieren (einmalig)

In der Eingabeaufforderung:

```cmd
npm install -g homey
```

Dann am Homey-Self-Hosted-Server anmelden:

```cmd
homey login
```

Der Browser öffnet sich, du klickst auf „Authorize". Danach Terminal zurück.

Damit das CLI weiß, **welcher** Homey adressiert werden soll:

```cmd
homey homey list
homey homey select
```

→ Pfeiltasten, deinen Self-Hosted-Server auswählen, Enter.

> Hinweis: Falls dein Self-Hosted-Server nicht in der Liste auftaucht, prüfe, dass der Docker-Container läuft und dass das CLI denselben Athom-Account benutzt, mit dem du den Self-Hosted-Server angelegt hast.

## Schritt 3 — App-Ordner vorbereiten

1. Den ZIP, den du erhalten hast (`nl.intyme.midea-ieco-ion.zip`), an einen festen Ort entpacken, z. B. `C:\homey-apps\nl.intyme.midea`.
2. Eingabeaufforderung dort öffnen:
   ```cmd
   cd C:\homey-apps\nl.intyme.midea
   ```
3. Abhängigkeiten installieren (das wendet automatisch den Lib-Patch an):
   ```cmd
   npm install
   ```
   Du musst am Ende drei Zeilen `[midea-patch] ... gepatcht` sehen — sonst hat etwas nicht funktioniert.

## Schritt 4 — App auf Homey installieren

```cmd
homey app install
```

Das CLI baut die App, lädt sie auf deinen Self-Hosted-Server hoch und installiert sie dort dauerhaft. Vorhandene Midea-Geräte bleiben erhalten, die zwei neuen Capabilities werden **automatisch nachregistriert**.

> Falls Homey fragt, ob du die alte Version (`1.0.18`) durch die neue (`1.0.19-ieco-ion`) ersetzen willst → ja.

## Schritt 5 — In der Homey-App nutzen

1. Homey-App auf dem Handy öffnen.
2. Auf dein Midea-AC-Gerät tippen.
3. Du siehst jetzt zwei neue Schalter:
   - **iECO** (grünes Blatt-Icon)
   - **Ion (Anionen-Sterilisierung)** (blaues Atom-Icon)
4. In Flows (Automatisierungen):
   - **Wenn:** „iECO wurde eingeschaltet" / „Ion-Sterilisierung wurde eingeschaltet"
   - **Und:** „iECO ist an/aus" / „Ion ist an/aus"
   - **Dann:** „iECO einschalten" / „iECO ausschalten" / „Ion einschalten" / „Ion ausschalten"

---

## Verhalten der Modi (gegenseitiger Ausschluss)

Wie du gewünscht hast:

| Aktiv | Schaltet automatisch ab |
|---|---|
| **Boost (Turbo)** | ECO, iECO, Frostschutz |
| **ECO** (klassisch) | Boost, iECO, Frostschutz |
| **iECO** | Boost, Frostschutz |
| **Frostschutz** | ECO, iECO, Boost |
| **Ion-Sterilisierung** | – (unabhängig, kann mit allem kombiniert werden) |

Ion läuft bewusst parallel zu allen Modi, weil das Anion-Modul technisch unabhängig vom Kompressor-Betrieb arbeitet.

---

## Wenn etwas nicht klappt

### Toggles erscheinen, aber haben keinen Effekt am AC
Dann unterstützt das WLAN-Modul deiner PortaSplit zwar den Empfang, ignoriert aber Byte 9 für iECO/Ion (gerätemodellabhängig). In dem Fall:

1. `homey app run` statt `homey app install` ausführen — du siehst Live-Logs im Terminal.
2. Im Terminal die Zeile `Device::onCapability(capability='ieco', value=true)` suchen — kommt der Befehl an?
3. Danach: in der **offiziellen Midea-Smart-App** prüfen, ob iECO/Ion dort umgeschaltet wurden.
4. Wenn nicht, müssen wir auf das **Property-Tag-Protokoll** (B5 0x0212 für iECO, 0x021E für Ion) umstellen. Schick mir die Log-Ausgabe — dann erweitere ich den Patch entsprechend.

### `homey app install` schlägt fehl mit „validation error"
```cmd
homey app validate -l publish
```
gibt die genaue Fehlerstelle aus. Häufige Ursache: SVG-Icon-Format. Lösung: die mitgelieferten `assets/ieco.svg` und `assets/ion.svg` durch eigene 256×256-SVGs ersetzen oder löschen (dann nutzt Homey ein Default-Icon).

### App startet nicht mehr nach Update
```cmd
homey app uninstall nl.intyme.midea
homey app install
```

Geräte werden NICHT neu angelegt, die Gerätedaten bleiben im Homey-Userdata erhalten.

---

## Was ich technisch geändert habe (für Neugierige)

1. **`app.json`** — Version, neue Capabilities `ieco` + `ion_mode`, 4 Trigger, 2 Conditions, 4 Actions ergänzt
2. **`drivers/airco/device.ts`**
   - `registerCapabilityListener` für beide neuen Capabilities
   - `addCapability`-Block für Bestandsgeräte (du musst sie nicht neu anlegen)
   - `_updateState` liest `state.iEcoMode` und `state.anionMode`
   - `onCapability`-Switch schreibt die Werte
   - Gegenseitige Verriegelung mit Boost/Eco/Freeze
3. **`scripts/patch-midea-lib.js`** + **`package.json` postinstall** — Patcht nach jedem `npm install` die NPM-Lib `midea-msmarthome-ac-euosk105`:
   - `DeviceState.js`: Felder `_iEcoMode`, `_anionMode` + Getter/Setter
   - `SetStateCommand.js`: Byte 9 ist jetzt `classicECO | iECO | anion`
   - `GetStateResponse.js`: Liest die drei Bits getrennt (Vorher hat die Lib iECO mit ECO verwechselt!)

Protokoll-Belege:
- [midea-local AC-Message-Definition](https://github.com/midea-lan/midea-local/blob/main/midealocal/devices/ac/message.py) Zeilen 606-633 (set) und 817-820 (get)
- [wuwentao/midea_ac_lan](https://github.com/wuwentao/midea_ac_lan)
- Original-App: [mteutelink/nl.intyme.midea](https://github.com/mteutelink/nl.intyme.midea)
