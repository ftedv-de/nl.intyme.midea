# nl.intyme.midea — i-ECO / ION Patched Fork

Homey App für Midea Split-Klimageräte (i-ECO, ION-Serie, PortaSplit).

## Attribution

Dies ist ein Fork von **[mteutelink/nl.intyme.midea](https://github.com/mteutelink/nl.intyme.midea)** — die ursprüngliche Homey-App für Midea-Klimageräte. Alle Kern-Funktionen (LAN-Discovery, Verschlüsselungs-Handshake, Basis-Steuerung) stammen aus dem Upstream-Projekt.

**Upstream Copyright**: © Mark Teutelink und Mitwirkende
**Fork-Anpassungen**: © 2026 David Mínguez ([@minguezdo](https://github.com/minguezdo))

## Lizenz

Dieses Projekt steht unter der **[GNU General Public License v3.0](./LICENSE)** — wie das Upstream-Projekt. Alle Änderungen und Erweiterungen in diesem Fork werden ebenfalls unter GPL-3.0 veröffentlicht. Siehe [`NOTICE`](./NOTICE) für die vollständige Attribution.

## Erweiterungen gegenüber Upstream

Dieser Fork ergänzt/verbessert die Upstream-App um folgende Funktionen (Stand v1.0.27):

### Externer Thermostat (SwitchBot Meter etc.)
- Median-Outlier-Filter für Sensor-Sprünge (z. B. −25 °C-Spikes)
- Gleitender Mittelwert über 5 Messwerte gegen SwitchBot 0.5-K-Treppenstufen
- Mindest-Verweildauer über Hysterese (default 60 s) verhindert Regelungs-Ping-Pong
- Sensor-Offset-Setting (−5…+5 K) für systematische Abweichungen durch Aufstellort

### PortaSplit Swing/Louver
- Getrennte Capabilities: `airco_swing` (Oszillation an/aus) + `airco_louver` (5 Positionen + Auto)
- Auto-Aktivierung von SwingMode beim Louver-Position-Wechsel (PortaSplit-Requirement)
- Resync-Logik gegen Geräte-intern zurückgesetzte SwingModi

### Fan-Nachlauf nach Cooling
- Automatischer Ventilator-Betrieb nach Cool-Off (konfigurierbare Speed)
- Retry-Logik für den Reconnect-Zeitraum direkt nach AC-Off
- SetStateCommand statt drei einzelner onCapability-Aufrufe → weniger Roundtrips

### Weitere Modi & Sensoren
- **iECO**, **ION**, **Jet-Cool**, **Out-Silent**, **Freeze-Protection**, **Follow-Me**, **Boost**, **Eco**
- **Energy-/Humidity-Monitoring** mit Last-Known-Value-Pattern und Plausi-Checks (kein Null-Reset bei Frame-Fehlern)
- **Defrost-Alarm** (Capability wird erst registriert wenn Gerät einmal `defrostMode=true` gemeldet hat)

### UX / Flicker-Fixes
- Lock-Window (15 s) pro Capability nach manueller Bedienung — Polls überschreiben User-Wunsch nicht
- Optimistic UI-Update bei Bedienung
- Custom deutsche/englische/niederländische Übersetzungen für alle Capabilities und Flow-Cards
- Publish-Level-Validierung sauber (0 Warnings, 0 Errors)

## Build & Installation

```bash
npm install
node scripts/build-app-json.js
npx tsc --noEmit
npx homey app validate --level publish
```

Installation auf Homey Pro (im lokalen Netzwerk):

```bash
homey app install
```

## Aktuelle Version

**v1.0.27** — siehe `app.json` / `package.json`.

## Beitragen

Pull Requests sind willkommen. Da dies ein Fork ist: falls eine Änderung generisch für alle Midea-Geräte relevant ist (nicht nur PortaSplit/i-ECO/ION-Spezifika), erwäge stattdessen einen PR gegen das [Upstream-Projekt](https://github.com/mteutelink/nl.intyme.midea).

## Haftungsausschluss

Diese App ist **nicht offiziell von Midea unterstützt oder autorisiert**. Nutzung auf eigenes Risiko.
