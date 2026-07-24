#!/usr/bin/env node
/**
 * Hardens the upstream Midea LAN transport.
 *
 * Fixes three related problems:
 * - serializes LANCommand executions per device because the shared socket does
 *   not support overlapping request/response pairs safely;
 * - removes request-specific data/timeout listeners after either one fires;
 * - normalizes decoded packets to Buffer and rejects malformed AES payloads.
 *
 * Applied automatically through package.json postinstall.
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(
  __dirname,
  '..',
  'node_modules',
  'midea-msmarthome-ac-euosk105',
  'dist',
);

function readTarget(relativePath) {
  const target = path.join(dist, relativePath);
  if (!fs.existsSync(target)) {
    console.error(`[midea-transport] Datei nicht gefunden: ${target}`);
    process.exit(1);
  }
  return { target, source: fs.readFileSync(target, 'utf8') };
}

function replaceRequired(source, find, replacement, description) {
  if (!source.includes(find)) {
    console.error(`[midea-transport] Patch-Stelle nicht gefunden: ${description}`);
    process.exit(1);
  }
  return source.replace(find, replacement);
}

// ---------------------------------------------------------------------------
// 1. Serialize all LANCommand executions per Midea device.
// ---------------------------------------------------------------------------
{
  const marker = '/* PATCHED:midea-command-queue-v2 */';
  const { target, source: original } = readTarget(path.join('command', 'LANCommand.js'));
  let source = original;

  if (!source.includes(marker)) {
    const exportMarker = 'exports.LANCommand = LANCommand;';
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

    source = replaceRequired(
      source,
      exportMarker,
      `${queuePatch}\n${exportMarker}`,
      'LANCommand export',
    );
    fs.writeFileSync(target, source);
    console.log('[midea-transport] LAN-Befehle werden pro Gerät serialisiert');
  } else {
    console.log('[midea-transport] LANCommand-Queue bereits gepatcht');
  }
}

// ---------------------------------------------------------------------------
// 2. Fix listener cleanup and malformed response handling in LANConnection.
// ---------------------------------------------------------------------------
{
  const marker = '/* PATCHED:midea-lan-transport-v2 */';
  const { target, source: original } = readTarget('LANConnection.js');
  let source = original;

  if (!source.includes(marker)) {
    const oldRequestBlock = `                    socket.write(message, (error) => {
                        if (error) {
                            Logger_1._LOGGER.error(\`Send Error: \${error}\`);
                            this._disconnect();
                            reject(error instanceof Error ? error : new Error(String(error)));
                        }
                        socket.once('data', (response) => {
                            Logger_1._LOGGER.http(\`Received response: \${response.toString('hex')}\`);
                            if (response.length === 0) {
                                Logger_1._LOGGER.error(\`Server Closed Socket\`);
                                this._disconnect();
                                reject(new Error("Server closed the socket unexpectedly"));
                            }
                            resolve(response);
                        });
                        socket.once('timeout', () => {
                            Logger_1._LOGGER.debug('Socket timed out');
                            this._disconnect();
                            resolve(Buffer.alloc(0));
                        });
                    });`;

    const newRequestBlock = `                    socket.write(message, (error) => {
                        if (error) {
                            Logger_1._LOGGER.error(\`Send Error: \${error}\`);
                            this._disconnect();
                            reject(error instanceof Error ? error : new Error(String(error)));
                            return;
                        }
                        let settled = false;
                        const cleanup = () => {
                            socket.removeListener('data', onData);
                            socket.removeListener('timeout', onTimeout);
                        };
                        const onData = (rawResponse) => {
                            if (settled) return;
                            settled = true;
                            cleanup();
                            const response = Buffer.isBuffer(rawResponse)
                                ? rawResponse
                                : Buffer.from(rawResponse);
                            Logger_1._LOGGER.http(\`Received response: \${response.toString('hex')}\`);
                            if (response.length === 0) {
                                Logger_1._LOGGER.error(\`Server Closed Socket\`);
                                this._disconnect();
                                reject(new Error("Server closed the socket unexpectedly"));
                                return;
                            }
                            resolve(response);
                        };
                        const onTimeout = () => {
                            if (settled) return;
                            settled = true;
                            cleanup();
                            Logger_1._LOGGER.debug('Socket timed out');
                            this._disconnect();
                            resolve(Buffer.alloc(0));
                        };
                        socket.once('data', onData);
                        socket.once('timeout', onTimeout);
                    });`;

    source = replaceRequired(
      source,
      oldRequestBlock,
      newRequestBlock,
      'LANConnection request listeners',
    );

    const oldDecodeBlock = `                        decodedResponses.forEach(response => {
                            if (response.length > 40 + 16) {
                                response = Security_1.Security.aesDecrypt(response.slice(40, -16));
                            }
                            if (response.length > 10) {
                                packets.push(response);
                            }
                        });`;

    const newDecodeBlock = `                        decodedResponses.forEach(decodedResponse => {
                            let response = Buffer.isBuffer(decodedResponse)
                                ? decodedResponse
                                : Buffer.from(decodedResponse);
                            if (response.length > 40 + 16) {
                                const encryptedPayload = response.subarray(40, response.length - 16);
                                if (encryptedPayload.length === 0 || encryptedPayload.length % 16 !== 0) {
                                    Logger_1._LOGGER.warn(\`Ignoring malformed encrypted response: \${encryptedPayload.length} bytes\`);
                                    return;
                                }
                                try {
                                    response = Security_1.Security.aesDecrypt(encryptedPayload);
                                }
                                catch (error) {
                                    Logger_1._LOGGER.warn(\`Ignoring undecodable encrypted response: \${error instanceof Error ? error.message : error}\`);
                                    return;
                                }
                            }
                            if (response.length > 10) {
                                packets.push(response);
                            }
                        });`;

    source = replaceRequired(
      source,
      oldDecodeBlock,
      newDecodeBlock,
      'LANConnection decoded response handling',
    );

    source = `${marker}\n${source}`;
    fs.writeFileSync(target, source);
    console.log('[midea-transport] Socket-Listener und Response-Decoding gepatcht');
  } else {
    console.log('[midea-transport] LANConnection bereits gepatcht');
  }
}
