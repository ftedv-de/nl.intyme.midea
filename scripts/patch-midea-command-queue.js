#!/usr/bin/env node
/**
 * Serializes all LANCommand network executions per Midea device.
 *
 * The upstream library attaches a timeout listener for every request to the
 * shared socket and does not safely support overlapping commands. Homey's
 * normal state poll, energy poll and capability commands can otherwise run at
 * the same time, causing MaxListenersExceededWarning and corrupted response
 * handling in LANConnection/aesDecrypt.
 *
 * This patch is intentionally applied to LANCommand.prototype.execute so it
 * also covers custom commands added by patch-midea-lib.js and
 * patch-energy-decoder.js.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  'midea-msmarthome-ac-euosk105',
  'dist',
  'command',
  'LANCommand.js',
);

const marker = '/* PATCHED:midea-command-queue-v1 */';

if (!fs.existsSync(target)) {
  console.error(`[midea-command-queue] Datei nicht gefunden: ${target}`);
  process.exit(1);
}

let source = fs.readFileSync(target, 'utf8');

if (source.includes(marker)) {
  console.log('[midea-command-queue] LANCommand.js bereits gepatcht');
  process.exit(0);
}

const exportMarker = 'exports.LANCommand = LANCommand;';
if (!source.includes(exportMarker)) {
  console.error('[midea-command-queue] Export-Marker in LANCommand.js nicht gefunden');
  process.exit(1);
}

const queuePatch = `${marker}
const __mideaOriginalExecute = LANCommand.prototype.execute;
const __mideaCommandQueues = new WeakMap();
LANCommand.prototype.execute = function () {
    const device = this._device;
    if (!device || (typeof device !== "object" && typeof device !== "function")) {
        return __mideaOriginalExecute.call(this);
    }
    const previous = __mideaCommandQueues.get(device) || Promise.resolve();
    const result = previous
        .catch(function () { return undefined; })
        .then(() => __mideaOriginalExecute.call(this));
    const tail = result.then(
        function () { return undefined; },
        function () { return undefined; }
    );
    __mideaCommandQueues.set(device, tail);
    return result.finally(function () {
        if (__mideaCommandQueues.get(device) === tail) {
            __mideaCommandQueues.delete(device);
        }
    });
};
`;

source = source.replace(exportMarker, `${queuePatch}\n${exportMarker}`);
fs.writeFileSync(target, source);
console.log('[midea-command-queue] LAN-Befehle werden pro Gerät serialisiert');
