#!/usr/bin/env node
/**
 * Merged .homeycompose/* JSON-Dateien in app.json zusammen.
 *
 * Simuliert die "homey app build"-Schritte, die bei manueller Installation
 * (homey app install) sonst nicht laufen:
 *   - .homeycompose/flow/{actions,conditions,triggers}/*.json -> app.json["flow"]
 *   - .homeycompose/capabilities/*.json -> app.json["capabilities"]
 *
 * Idempotent. Behaelt bestehende Eintraege (kein Duplikat, Compose-Version wins).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const appJsonPath = path.join(ROOT, 'app.json');
const composeDir = path.join(ROOT, '.homeycompose');

const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));

function mergeArrayById(target, source) {
  const byId = new Map(target.map(x => [x.id, x]));
  for (const item of source) byId.set(item.id, item);
  return Array.from(byId.values());
}

// === FLOW ===
appJson.flow = appJson.flow || {};
for (const kind of ['triggers', 'conditions', 'actions']) {
  const dir = path.join(composeDir, 'flow', kind);
  if (!fs.existsSync(dir)) continue;
  const cards = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const card = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // Homey-compose-Konvention: Dateiname = id wenn nicht im Card-JSON gesetzt
      if (!card.id) card.id = path.basename(f, '.json');
      return card;
    });
  // Entferne ID-lose Karten aus app.json (Altlast aus vorherigen Builds vor dem ID-Fix)
  const existing = (appJson.flow[kind] || []).filter(x => x && x.id);
  appJson.flow[kind] = mergeArrayById(existing, cards);
  console.log(`[build] ${kind}: ${appJson.flow[kind].length} cards (${cards.length} aus compose)`);
}

// === CAPABILITIES ===
appJson.capabilities = appJson.capabilities || {};
const capDir = path.join(composeDir, 'capabilities');
if (fs.existsSync(capDir)) {
  for (const f of fs.readdirSync(capDir).filter(x => x.endsWith('.json'))) {
    const id = path.basename(f, '.json');
    appJson.capabilities[id] = JSON.parse(fs.readFileSync(path.join(capDir, f), 'utf8'));
  }
  console.log(`[build] capabilities aus compose gemerged`);
}

// === DRIVER SETTINGS ===
// Lese drivers/<driver>/driver.settings.compose.json und merge in app.json.drivers[i].settings
if (Array.isArray(appJson.drivers)) {
  for (const drv of appJson.drivers) {
    const driverDir = path.join(ROOT, 'drivers', drv.id);
    const settingsFile = path.join(driverDir, 'driver.settings.compose.json');
    if (fs.existsSync(settingsFile)) {
      drv.settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      console.log(`[build] driver '${drv.id}': ${drv.settings.length} settings/groups aus compose`);
    }
    // Driver-Capabilities aus driver.compose.json mergen (falls vorhanden)
    const composeFile = path.join(driverDir, 'driver.compose.json');
    if (fs.existsSync(composeFile)) {
      const composed = JSON.parse(fs.readFileSync(composeFile, 'utf8'));
      if (Array.isArray(composed.capabilities)) {
        // Vereinigung der Capability-Listen (compose wins)
        const existing = new Set(drv.capabilities || []);
        for (const cap of composed.capabilities) existing.add(cap);
        drv.capabilities = Array.from(existing);
        console.log(`[build] driver '${drv.id}': capabilities = ${drv.capabilities.length}`);
      }
      if (composed.capabilitiesOptions) {
        drv.capabilitiesOptions = Object.assign({}, drv.capabilitiesOptions || {}, composed.capabilitiesOptions);
      }
    }
  }
}

fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n');
console.log('[build] app.json geschrieben');
