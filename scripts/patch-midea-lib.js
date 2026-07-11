#!/usr/bin/env node
/**
 * Patcht midea-msmarthome-ac-euosk105 fuer iECO + Anion-Sterilisierung.
 *
 * STRATEGIE (v4 - basierend auf mill1000/midea-msmart):
 * - Anion (Ion-Modus): Byte 9, Bit 0x20 im 0x40-SET-Frame.
 * - iECO: B5-Property 0x00E3 (NICHT 0x0212!) ueber 0xB0-SET / 0xB1-GET Frame.
 *   Wert ist 13 Bytes: [0x00, 0x01, switch] + 10x 0x00 Padding.
 *   Decode: data[1] ist der switch-Wert.
 * - Klassisches ECO bleibt unveraendert (Original-Verhalten).
 *
 * Frame-Pack-Format (laut mill1000/midea-msmart command.py):
 *   SET: [paramLow, paramHigh, length, value...]               (4-byte header)
 *   GET response: [paramLow, paramHigh, result, size, value...] (5-byte header)
 *
 * Wird automatisch via "postinstall" nach jedem npm install ausgefuehrt.
 * Idempotent: Mehrfache Ausfuehrung ist sicher.
 */
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'node_modules', 'midea-msmarthome-ac-euosk105', 'dist');
const MARK = '/* PATCHED:ieco-ion-v7 */';

function patch(file, transforms) {
  const p = path.join(LIB, file);
  if (!fs.existsSync(p)) {
    console.warn(`[midea-patch] ${file} nicht gefunden, ueberspringe`);
    return;
  }
  let src = fs.readFileSync(p, 'utf8');
  if (src.includes(MARK)) {
    console.log(`[midea-patch] ${file} bereits gepatcht (v7)`);
    return;
  }
  // Alte v1..v4-Markierung entfernen falls vorhanden
  const hadOldMark = /^\/\* PATCHED:ieco-ion(-v[0-9]+)? \*\//.test(src);
  src = src.replace(/^\/\* PATCHED:ieco-ion(-v[0-9]+)? \*\/\n/, '');
  let appliedAny = false;
  for (const [find, replace] of transforms) {
    if (!src.includes(find)) {
      if (hadOldMark) {
        // Transformation in einer fruehren Version bereits angewandt - ueberspringen
        console.log(`[midea-patch] ${file}: Transformation bereits aktiv (alte Version)`);
        continue;
      }
      console.error(`[midea-patch] FEHLER: Marker in ${file} nicht gefunden:\n${find.slice(0, 80)}...`);
      process.exit(1);
    }
    src = src.replace(find, replace);
    appliedAny = true;
  }
  src = MARK + '\n' + src;
  fs.writeFileSync(p, src);
  console.log(`[midea-patch] ${file} gepatcht (v7${appliedAny ? '' : ', nur Marker-Upgrade'})`);
}

// === DeviceState.js: Felder + Getter/Setter fuer iEcoMode und anionMode ===
patch('DeviceState.js', [
  [
    'this._statusCode = 0;',
    'this._statusCode = 0;\n        this._iEcoMode = false;\n        this._anionMode = false;\n        this._jetCoolMode = false;\n        this._outSilentMode = false;\n        this._followMe = false;\n        this._realTimePower = null;\n        this._totalEnergy = null;\n        this._currentEnergy = null;\n        this._humidity = null;\n        this._defrostMode = false;\n        this._outdoorFanSpeed = null;',
  ],
  [
    'exports.DeviceState = DeviceState;',
    `Object.defineProperty(DeviceState.prototype, 'iEcoMode', {
  get: function () { return this._iEcoMode; },
  set: function (v) { this._iEcoMode = !!v; },
  enumerable: true, configurable: true,
});
Object.defineProperty(DeviceState.prototype, 'anionMode', {
  get: function () { return this._anionMode; },
  set: function (v) { this._anionMode = !!v; },
  enumerable: true, configurable: true,
});
Object.defineProperty(DeviceState.prototype, 'jetCoolMode', {
  get: function () { return this._jetCoolMode; },
  set: function (v) { this._jetCoolMode = !!v; },
  enumerable: true, configurable: true,
});
Object.defineProperty(DeviceState.prototype, 'outSilentMode', {
  get: function () { return this._outSilentMode; },
  set: function (v) { this._outSilentMode = !!v; },
  enumerable: true, configurable: true,
});
Object.defineProperty(DeviceState.prototype, 'followMe', {
  get: function () { return this._followMe; },
  set: function (v) { this._followMe = !!v; },
  enumerable: true, configurable: true,
});
Object.defineProperty(DeviceState.prototype, 'realTimePower', {
  get: function () { return this._realTimePower; },
  set: function (v) { this._realTimePower = (v === null || v === undefined) ? null : Number(v); },
  enumerable: true, configurable: true,
});
Object.defineProperty(DeviceState.prototype, 'totalEnergy', {
  get: function () { return this._totalEnergy; },
  set: function (v) { this._totalEnergy = (v === null || v === undefined) ? null : Number(v); },
  enumerable: true, configurable: true,
});
Object.defineProperty(DeviceState.prototype, 'currentEnergy', {
  get: function () { return this._currentEnergy; },
  set: function (v) { this._currentEnergy = (v === null || v === undefined) ? null : Number(v); },
  enumerable: true, configurable: true,
});
Object.defineProperty(DeviceState.prototype, 'humidity', {
  get: function () { return this._humidity; },
  set: function (v) { this._humidity = (v === null || v === undefined) ? null : Number(v); },
  enumerable: true, configurable: true,
});
Object.defineProperty(DeviceState.prototype, 'defrostMode', {
  get: function () { return this._defrostMode; },
  set: function (v) { this._defrostMode = !!v; },
  enumerable: true, configurable: true,
});
Object.defineProperty(DeviceState.prototype, 'outdoorFanSpeed', {
  get: function () { return this._outdoorFanSpeed; },
  set: function (v) { this._outdoorFanSpeed = (v === null || v === undefined) ? null : Number(v); },
  enumerable: true, configurable: true,
});
exports.DeviceState = DeviceState;`,
  ],
]);

// === SetStateCommand.js: Anion auf Byte 9 (0x20). ===
patch('command/SetStateCommand.js', [
  [
    'const ecoMode = deviceState.ecoMode ? 0x80 : 0;',
    `const ecoMode  = deviceState.ecoMode ? 0x80 : 0;
        const anionBit = deviceState.anionMode ? 0x20 : 0;
        const byte9    = ecoMode | anionBit;`,
  ],
  [
    'turboAlt,\n            ecoMode,',
    'turboAlt,\n            byte9,',
  ],
]);

// === v6 Post-Patch: Follow-Me Bit auf Byte 8 (0x80) im SetStateCommand. Idempotent. ===
(function applyFollowMeSetStatePatch() {
  const p = path.join(LIB, 'command/SetStateCommand.js');
  if (!fs.existsSync(p)) return;
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('followMeBit')) {
    console.log('[midea-patch] SetStateCommand.js: Follow-Me bereits aktiv');
    return;
  }
  // Erwartet v5-Output (turboAlt) - ersetzt durch byte8 + followMeBit
  if (!s.includes('const turboAlt = deviceState.turboMode ? 0x20 : 0;')) {
    console.warn('[midea-patch] SetStateCommand.js: turboAlt nicht gefunden - skip Follow-Me');
    return;
  }
  s = s.replace(
    'const turboAlt = deviceState.turboMode ? 0x20 : 0;',
    'const turboAlt = deviceState.turboMode ? 0x20 : 0;\n        const followMeBit = deviceState.followMe ? 0x80 : 0;\n        const byte8 = turboAlt | followMeBit;',
  );
  s = s.replace(
    'turboAlt,\n            byte9,',
    'byte8,\n            byte9,',
  );
  fs.writeFileSync(p, s);
  console.log('[midea-patch] SetStateCommand.js: Follow-Me Bit eingebaut');
})();

// === GetStateResponse.js: classic ECO bleibt, Anion zusaetzlich lesen ===
patch('command/GetStateResponse.js', [
  [
    'this.ecoMode = (data[9] & 0x10) === 0x10;',
    `this.ecoMode   = (data[9] & 0x10) === 0x10;
        this.anionMode = (data[9] & 0x20) === 0x20;`,
  ],
]);

// === v6 Post-Patch: Follow-Me Bit aus GetStateResponse lesen. Idempotent. ===
(function applyFollowMeGetStatePatch() {
  const p = path.join(LIB, 'command/GetStateResponse.js');
  if (!fs.existsSync(p)) return;
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('this.followMe')) {
    console.log('[midea-patch] GetStateResponse.js: Follow-Me bereits aktiv');
    return;
  }
  if (!s.includes('this.anionMode = (data[9] & 0x20) === 0x20;')) {
    console.warn('[midea-patch] GetStateResponse.js: anionMode-Zeile nicht gefunden');
    return;
  }
  s = s.replace(
    'this.anionMode = (data[9] & 0x20) === 0x20;',
    'this.anionMode = (data[9] & 0x20) === 0x20;\n        this.followMe  = (data[8] & 0x80) === 0x80;',
  );
  fs.writeFileSync(p, s);
  console.log('[midea-patch] GetStateResponse.js: Follow-Me Bit eingebaut');
})();

// === DeviceState.d.ts: TypeScript-Deklarationen ===
const dts = path.join(LIB, 'DeviceState.d.ts');
if (fs.existsSync(dts)) {
  let s = fs.readFileSync(dts, 'utf8');
  if (!s.includes('iEcoMode')) {
    s = s.replace(
      'set freezeProtectionMode(freezeProtectionMode: boolean);',
      `set freezeProtectionMode(freezeProtectionMode: boolean);
    get iEcoMode(): boolean;
    set iEcoMode(value: boolean);
    get anionMode(): boolean;
    set anionMode(value: boolean);
    get jetCoolMode(): boolean;
    set jetCoolMode(value: boolean);
    get outSilentMode(): boolean;
    set outSilentMode(value: boolean);
    get followMe(): boolean;
    set followMe(value: boolean);
    get realTimePower(): number | null;
    set realTimePower(value: number | null);
    get totalEnergy(): number | null;
    set totalEnergy(value: number | null);
    get currentEnergy(): number | null;
    set currentEnergy(value: number | null);
    get humidity(): number | null;
    set humidity(value: number | null);
    get defrostMode(): boolean;
    set defrostMode(value: boolean);
    get outdoorFanSpeed(): number | null;
    set outdoorFanSpeed(value: number | null);`,
    );
    fs.writeFileSync(dts, s);
    console.log('[midea-patch] DeviceState.d.ts gepatcht');
  } else if (!s.includes('jetCoolMode')) {
    s = s.replace(
      'set anionMode(value: boolean);',
      `set anionMode(value: boolean);
    get jetCoolMode(): boolean;
    set jetCoolMode(value: boolean);
    get outSilentMode(): boolean;
    set outSilentMode(value: boolean);`,
    );
    fs.writeFileSync(dts, s);
    console.log('[midea-patch] DeviceState.d.ts gepatcht (v5)');
  }
  // v6: ergaenze followMe + Sensorfelder falls fehlen
  let s2 = fs.readFileSync(dts, 'utf8');
  if (!s2.includes('followMe')) {
    s2 = s2.replace(
      'set outSilentMode(value: boolean);',
      `set outSilentMode(value: boolean);
    get followMe(): boolean;
    set followMe(value: boolean);
    get realTimePower(): number | null;
    set realTimePower(value: number | null);
    get totalEnergy(): number | null;
    set totalEnergy(value: number | null);
    get currentEnergy(): number | null;
    set currentEnergy(value: number | null);
    get humidity(): number | null;
    set humidity(value: number | null);
    get defrostMode(): boolean;
    set defrostMode(value: boolean);
    get outdoorFanSpeed(): number | null;
    set outdoorFanSpeed(value: number | null);`,
    );
    fs.writeFileSync(dts, s2);
    console.log('[midea-patch] DeviceState.d.ts gepatcht (v6 - Sensoren)');
  }
}

// === NEU: SetIEcoCommand.js + GetIEcoCommand.js fuer B5-Property 0x00E3 ===
//
// Frame-Format (Body, der an LANCommand uebergeben wird):
//   SET: [0xB0, pack_count=1, paramLow=0xE3, paramHigh=0x00, length=13,
//         0x00, 0x01, switch, 0x00 x 10]
//   GET: [0xB1, count=1, paramLow=0xE3, paramHigh=0x00]
//
// LANCommand wrappt Header (0xAA, length, deviceType, ...), CRC, Verschluesselung.
// frameType=2 fuer SET, frameType=3 fuer REQUEST.

const setIEcoJs = `"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SetIEcoCommand = void 0;
const Logger_1 = require("../Logger");
const LANCommand_1 = require("./LANCommand");
const GetStateCommand_1 = require("./GetStateCommand");
/**
 * Setzt iECO ueber B5-Property 0x00E3 im 0xB0 New-Protocol-Frame.
 * Wert-Encoding (aus mill1000/midea-msmart):
 *   bytes([ieco_frame=0, ieco_number=1, ieco_switch]) + 10x 0x00
 */
class SetIEcoCommand extends LANCommand_1.LANCommand {
    constructor(device, on) {
        // Body: [0xB0, pack_count=1, paramLow, paramHigh, length, value(13 bytes)]
        // Pack format: 4-byte header [paramLow, paramHigh, length, ...value]
        const value = Buffer.alloc(13);
        value[0] = 0x00;            // ieco_frame
        value[1] = 0x01;            // ieco_number
        value[2] = on ? 0x01 : 0x00; // ieco_switch
        // bytes 3..12 bleiben 0x00 (Padding)
        const body = Buffer.concat([
            Buffer.from([
                0xB0,
                0x01,        // pack_count = 1
                0xE3, 0x00,  // PROPERTY_ID 0x00E3 (little-endian)
                0x0D,        // length = 13
            ]),
            value,
        ]);
        super(device, body, 2 /* FRAME_TYPE.SET */);
        this._on = on;
    }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () {
            Logger_1._LOGGER.debug("SetIEcoCommand::execute(on=" + this._on + ")");
            yield _super.execute.call(this);
            // Status nach Aenderung neu holen
            return new GetStateCommand_1.GetStateCommand(this._device).execute();
        });
    }
}
exports.SetIEcoCommand = SetIEcoCommand;
`;

const setIEcoDts = `import { Device } from "../Device";
import { DeviceState } from "../DeviceState";
import { LANCommand } from './LANCommand';
export declare class SetIEcoCommand extends LANCommand {
    private _on;
    constructor(device: Device, on: boolean);
    execute(): Promise<DeviceState>;
}
`;

const getIEcoJs = `"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetIEcoCommand = void 0;
const Logger_1 = require("../Logger");
const LANCommand_1 = require("./LANCommand");
/**
 * Liest iECO ueber B5-Property 0x00E3.
 * Antwort wird vom Geraet als 0xB0/0xB1-Frame zurueck-geliefert.
 * Response-Pack-Format (laut mill1000): [paramLow, paramHigh, result_flags, size, value...]
 * data[i+5] = ieco_switch (bei value-Offset 1)
 */
class GetIEcoCommand extends LANCommand_1.LANCommand {
    constructor(device) {
        // Body: [0xB1, count=1, paramLow=0xE3, paramHigh=0x00]
        const body = Buffer.from([0xB1, 0x01, 0xE3, 0x00]);
        super(device, body, 3 /* FRAME_TYPE.REQUEST */);
    }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () {
            Logger_1._LOGGER.debug("GetIEcoCommand::execute()");
            try {
                const responses = yield _super.execute.call(this);
                if (!responses || responses.length === 0) return null;
                let data = responses[0];
                // Wie GetPropertiesResponse: erste 10 Bytes (LAN-Header) + letzte 2 (msgId, CRC) abschneiden
                data = data.subarray(10, data.length - 2);
                // Body-Format: [0xB0|0xB1, count, ...pakete]
                // Pack-Format pro Property: [paramLow, paramHigh, result, size, value(size bytes)]
                for (let i = 2; i + 4 < data.length; ) {
                    const param = data[i] | (data[i + 1] << 8);
                    const size = data[i + 3];
                    if (param === 0x00E3 && size >= 2) {
                        const valueBytes = data.subarray(i + 4, i + 4 + size);
                        Logger_1._LOGGER.debug("iECO read: value bytes = " +
                            Array.from(valueBytes).map(b => b.toString(16).padStart(2, '0')).join(' '));
                        // mill1000/midea-msmart decode: data[0]=ieco_number, data[1]=ieco_switch
                        // d.h. die Antwort enthaelt KEIN ieco_frame-Byte am Anfang.
                        return valueBytes[1] === 0x01;
                    }
                    if (size === 0) {
                        i += 4;
                        continue;
                    }
                    i += 4 + size;
                }
                return null;
            } catch (e) {
                Logger_1._LOGGER.debug("GetIEcoCommand: keine Antwort - " + e);
                return null;
            }
        });
    }
}
exports.GetIEcoCommand = GetIEcoCommand;
`;

const getIEcoDts = `import { Device } from "../Device";
import { LANCommand } from './LANCommand';
export declare class GetIEcoCommand extends LANCommand {
    constructor(device: Device);
    execute(): Promise<boolean | null>;
}
`;

function writeOrUpdate(rel, content) {
  const p = path.join(LIB, rel);
  fs.writeFileSync(p, content);
  console.log(`[midea-patch] ${rel} geschrieben`);
}

writeOrUpdate('command/SetIEcoCommand.js', setIEcoJs);
writeOrUpdate('command/SetIEcoCommand.d.ts', setIEcoDts);
writeOrUpdate('command/GetIEcoCommand.js', getIEcoJs);
writeOrUpdate('command/GetIEcoCommand.d.ts', getIEcoDts);


// === NEU v5: Generische 1-Byte B5-Property-Commands ===
//
// Jet Cool (Flash Cool): Property 0x0067, value = 1 (on) / 0 (off)
// Outdoor Silent (PortaSplit): Property 0x00CD, value = 3 (on) / 0 (off)

function makeSimplePropertyCommands(className, propertyId, onValue, offValue) {
  const paramLow = propertyId & 0xFF;
  const paramHigh = (propertyId >> 8) & 0xFF;
  const hex2 = (n) => '0x' + n.toString(16).padStart(2, '0').toUpperCase();
  const hex4 = (n) => '0x' + n.toString(16).padStart(4, '0').toUpperCase();

  const setJs = [
    '"use strict";',
    'var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {',
    '    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }',
    '    return new (P || (P = Promise))(function (resolve, reject) {',
    '        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }',
    '        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }',
    '        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }',
    '        step((generator = generator.apply(thisArg, _arguments || [])).next());',
    '    });',
    '};',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    `exports.Set${className}Command = void 0;`,
    'const Logger_1 = require("../Logger");',
    'const LANCommand_1 = require("./LANCommand");',
    'const GetStateCommand_1 = require("./GetStateCommand");',
    `class Set${className}Command extends LANCommand_1.LANCommand {`,
    '    constructor(device, on) {',
    '        const body = Buffer.from([',
    '            0xB0,',
    '            0x01,',
    `            ${hex2(paramLow)}, ${hex2(paramHigh)},`,
    '            0x01,',
    `            on ? ${hex2(onValue)} : ${hex2(offValue)},`,
    '        ]);',
    '        super(device, body, 2);',
    '        this._on = on;',
    '    }',
    '    execute() {',
    '        const _super = Object.create(null, { execute: { get: () => super.execute } });',
    '        return __awaiter(this, void 0, void 0, function* () {',
    `            Logger_1._LOGGER.debug("Set${className}Command::execute(on=" + this._on + ")");`,
    '            yield _super.execute.call(this);',
    '            return new GetStateCommand_1.GetStateCommand(this._device).execute();',
    '        });',
    '    }',
    '}',
    `exports.Set${className}Command = Set${className}Command;`,
    '',
  ].join('\n');

  const setDts = [
    'import { Device } from "../Device";',
    'import { DeviceState } from "../DeviceState";',
    'import { LANCommand } from \'./LANCommand\';',
    `export declare class Set${className}Command extends LANCommand {`,
    '    private _on;',
    '    constructor(device: Device, on: boolean);',
    '    execute(): Promise<DeviceState>;',
    '}',
    '',
  ].join('\n');

  const getJs = [
    '"use strict";',
    'var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {',
    '    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }',
    '    return new (P || (P = Promise))(function (resolve, reject) {',
    '        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }',
    '        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }',
    '        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }',
    '        step((generator = generator.apply(thisArg, _arguments || [])).next());',
    '    });',
    '};',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    `exports.Get${className}Command = void 0;`,
    'const Logger_1 = require("../Logger");',
    'const LANCommand_1 = require("./LANCommand");',
    `class Get${className}Command extends LANCommand_1.LANCommand {`,
    '    constructor(device) {',
    `        const body = Buffer.from([0xB1, 0x01, ${hex2(paramLow)}, ${hex2(paramHigh)}]);`,
    '        super(device, body, 3);',
    '    }',
    '    execute() {',
    '        const _super = Object.create(null, { execute: { get: () => super.execute } });',
    '        return __awaiter(this, void 0, void 0, function* () {',
    `            Logger_1._LOGGER.debug("Get${className}Command::execute()");`,
    '            try {',
    '                const responses = yield _super.execute.call(this);',
    '                if (!responses || responses.length === 0) return null;',
    '                let data = responses[0];',
    '                data = data.subarray(10, data.length - 2);',
    '                for (let i = 2; i + 4 < data.length; ) {',
    '                    const param = data[i] | (data[i + 1] << 8);',
    '                    const size = data[i + 3];',
    `                    if (param === ${hex4(propertyId)} && size >= 1) {`,
    `                        Logger_1._LOGGER.debug("${className} read: value=" + data[i+4].toString(16));`,
    `                        return data[i + 4] === ${hex2(onValue)};`,
    '                    }',
    '                    if (size === 0) { i += 4; continue; }',
    '                    i += 4 + size;',
    '                }',
    '                return null;',
    '            } catch (e) {',
    `                Logger_1._LOGGER.debug("Get${className}Command: keine Antwort - " + e);`,
    '                return null;',
    '            }',
    '        });',
    '    }',
    '}',
    `exports.Get${className}Command = Get${className}Command;`,
    '',
  ].join('\n');

  const getDts = [
    'import { Device } from "../Device";',
    'import { LANCommand } from \'./LANCommand\';',
    `export declare class Get${className}Command extends LANCommand {`,
    '    constructor(device: Device);',
    '    execute(): Promise<boolean | null>;',
    '}',
    '',
  ].join('\n');

  writeOrUpdate('command/Set' + className + 'Command.js', setJs);
  writeOrUpdate('command/Set' + className + 'Command.d.ts', setDts);
  writeOrUpdate('command/Get' + className + 'Command.js', getJs);
  writeOrUpdate('command/Get' + className + 'Command.d.ts', getDts);
}

// Jet Cool: Property 0x0067, on=1, off=0 (default-encode bool->1)
makeSimplePropertyCommands('JetCool', 0x0067, 0x01, 0x00);
// Outdoor Silent: Property 0x00CD, on=3, off=0 (laut mill1000: data[0] == 3)
makeSimplePropertyCommands('OutSilent', 0x00CD, 0x03, 0x00);



// === v6: GetPowerUsageResponse.js KOMPLETT NEU - parst BCD + gibt Objekt zurueck ===
//
// Frame: 0x41 0x21 0x01 0x44 (Anfrage Energie/Power)
// Response-Layout (nach Abzug LAN-Header subarray(10, len-2)):
//   data[4..7]   = Total Energy BCD (4 Bytes) -> totalEnergy kWh
//   data[12..15] = Current Energy BCD (4 Bytes) -> currentEnergy kWh
//   data[16..18] = RealTime Power BCD (3 Bytes) -> realTimePower W
//
// BCD decode: (high nibble) * 10 + (low nibble)
const getPowerUsageResponseJs = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetPowerUsageResponse = void 0;
const Logger_1 = require("../Logger");
function bcd(byte) {
    return ((byte >> 4) & 0x0F) * 10 + (byte & 0x0F);
}
function parseEnergy(d, off) {
    if (d.length < off + 4) return null;
    const v = 10000 * bcd(d[off]) + 100 * bcd(d[off + 1]) + 1 * bcd(d[off + 2]) + 0.01 * bcd(d[off + 3]);
    return Math.round(v * 100) / 100;
}
function parsePower(d, off) {
    if (d.length < off + 3) return null;
    const v = 1000 * bcd(d[off]) + 10 * bcd(d[off + 1]) + 0.1 * bcd(d[off + 2]);
    return Math.round(v * 10) / 10;
}
class GetPowerUsageResponse {
    constructor(data) {
        try {
            const payload = data.subarray(10, data.length - 2);
            this.totalEnergy = parseEnergy(payload, 4);
            this.currentEnergy = parseEnergy(payload, 12);
            this.realTimePower = parsePower(payload, 16);
            Logger_1._LOGGER.debug("GetPowerUsageResponse: total=" + this.totalEnergy + " kWh, current=" + this.currentEnergy + " kWh, power=" + this.realTimePower + " W");
        } catch (e) {
            Logger_1._LOGGER.debug("GetPowerUsageResponse parse error: " + e);
            this.totalEnergy = null;
            this.currentEnergy = null;
            this.realTimePower = null;
        }
    }
}
exports.GetPowerUsageResponse = GetPowerUsageResponse;
`;
const getPowerUsageResponseDts = `export declare class GetPowerUsageResponse {
    totalEnergy: number | null;
    currentEnergy: number | null;
    realTimePower: number | null;
    constructor(data: Buffer);
}
`;
writeOrUpdate('command/GetPowerUsageResponse.js', getPowerUsageResponseJs);
writeOrUpdate('command/GetPowerUsageResponse.d.ts', getPowerUsageResponseDts);

// === v6: GetPowerUsageCommand.d.ts - Rueckgabetyp anpassen ===
const getPowerUsageCommandDts = `import { Device } from "../Device";
import { LANCommand } from './LANCommand';
import { GetPowerUsageResponse } from './GetPowerUsageResponse';
export declare class GetPowerUsageCommand extends LANCommand {
    constructor(device: Device);
    execute(): Promise<GetPowerUsageResponse | null>;
}
`;
writeOrUpdate('command/GetPowerUsageCommand.d.ts', getPowerUsageCommandDts);

// === v6: GetPowerUsageCommand.js KOMPLETT NEU - gibt Response-Objekt zurueck statt void ===
const getPowerUsageCommandJs = `"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetPowerUsageCommand = void 0;
const Logger_1 = require("../Logger");
const GetPowerUsageResponse_1 = require("./GetPowerUsageResponse");
const LANCommand_1 = require("./LANCommand");
class GetPowerUsageCommand extends LANCommand_1.LANCommand {
    constructor(device) {
        super(device, Buffer.from([0x41, 0x21, 0x01, 0x44, 0x00, 0x01]), 3);
    }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () {
            Logger_1._LOGGER.debug("GetPowerUsageCommand::execute()");
            try {
                const responses = yield _super.execute.call(this);
                if (!responses || responses.length === 0) return null;
                return new GetPowerUsageResponse_1.GetPowerUsageResponse(responses[0]);
            } catch (e) {
                Logger_1._LOGGER.debug("GetPowerUsageCommand: keine Antwort - " + e);
                return null;
            }
        });
    }
}
exports.GetPowerUsageCommand = GetPowerUsageCommand;
`;
writeOrUpdate('command/GetPowerUsageCommand.js', getPowerUsageCommandJs);

// === v6: GetGroup5Command + Response (Frame 0x41 0x21 0x01 0x45) ===
//   payload[4]  = Humidity (0..100 %)
//   payload[8]  = OutdoorFanSpeed-Raw -> rpm = 8 * value
//   payload[10] = Defrost-Bool (0/1)
const getGroup5ResponseJs = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetGroup5Response = void 0;
const Logger_1 = require("../Logger");
class GetGroup5Response {
    constructor(data) {
        try {
            const payload = data.subarray(10, data.length - 2);
            const hRaw = payload.length > 4 ? payload[4] : 0;
            this.humidity = (hRaw > 0 && hRaw <= 100) ? hRaw : null;
            this.outdoorFanSpeed = payload.length > 8 ? (8 * payload[8]) : null;
            this.defrostMode = payload.length > 10 ? !!(payload[10] & 0x01) : false;
            Logger_1._LOGGER.debug("GetGroup5Response: humidity=" + this.humidity + " %, fan=" + this.outdoorFanSpeed + " rpm, defrost=" + this.defrostMode);
        } catch (e) {
            Logger_1._LOGGER.debug("GetGroup5Response parse error: " + e);
            this.humidity = null;
            this.outdoorFanSpeed = null;
            this.defrostMode = false;
        }
    }
}
exports.GetGroup5Response = GetGroup5Response;
`;
const getGroup5ResponseDts = `export declare class GetGroup5Response {
    humidity: number | null;
    outdoorFanSpeed: number | null;
    defrostMode: boolean;
    constructor(data: Buffer);
}
`;
const getGroup5CommandJs = `"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetGroup5Command = void 0;
const Logger_1 = require("../Logger");
const GetGroup5Response_1 = require("./GetGroup5Response");
const LANCommand_1 = require("./LANCommand");
class GetGroup5Command extends LANCommand_1.LANCommand {
    constructor(device) {
        super(device, Buffer.from([0x41, 0x21, 0x01, 0x45, 0x00, 0x01]), 3);
    }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () {
            Logger_1._LOGGER.debug("GetGroup5Command::execute()");
            try {
                const responses = yield _super.execute.call(this);
                if (!responses || responses.length === 0) return null;
                return new GetGroup5Response_1.GetGroup5Response(responses[0]);
            } catch (e) {
                Logger_1._LOGGER.debug("GetGroup5Command: keine Antwort - " + e);
                return null;
            }
        });
    }
}
exports.GetGroup5Command = GetGroup5Command;
`;
const getGroup5CommandDts = `import { Device } from "../Device";
import { LANCommand } from './LANCommand';
import { GetGroup5Response } from './GetGroup5Response';
export declare class GetGroup5Command extends LANCommand {
    constructor(device: Device);
    execute(): Promise<GetGroup5Response | null>;
}
`;
writeOrUpdate('command/GetGroup5Response.js', getGroup5ResponseJs);
writeOrUpdate('command/GetGroup5Response.d.ts', getGroup5ResponseDts);
writeOrUpdate('command/GetGroup5Command.js', getGroup5CommandJs);
writeOrUpdate('command/GetGroup5Command.d.ts', getGroup5CommandDts);

// === v7: SetPropertiesCommand.js reparieren - library ist kaputt (kopiert GetProperties) ===
// Format laut mill1000 / midea-msmart:
//   Frame: 0xB0 <count> <prop_low> <prop_high> <length> <value...>
// Wir setzen jeweils eine einzelne Property mit 1 Byte Value (passt fuer SWING_*_ANGLE).
const setPropertiesCommandJs = `"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SetPropertiesCommand = exports.PROPERTY_ID = void 0;
const Logger_1 = require("../Logger");
const LANCommand_1 = require("./LANCommand");
var PROPERTY_ID;
(function (PROPERTY_ID) {
    PROPERTY_ID[PROPERTY_ID["SWING_UD_ANGLE"] = 9] = "SWING_UD_ANGLE";
    PROPERTY_ID[PROPERTY_ID["SWING_LR_ANGLE"] = 10] = "SWING_LR_ANGLE";
    PROPERTY_ID[PROPERTY_ID["SELF_CLEAN"] = 57] = "SELF_CLEAN";
    PROPERTY_ID[PROPERTY_ID["BREEZELESS"] = 24] = "BREEZELESS";
    PROPERTY_ID[PROPERTY_ID["INDIRECT_WIND"] = 66] = "INDIRECT_WIND";
})(PROPERTY_ID || (exports.PROPERTY_ID = PROPERTY_ID = {}));
class SetPropertiesCommand extends LANCommand_1.LANCommand {
    constructor(device, propertyId, value) {
        // 0xB0 <count=1> <propLow> <propHigh> <valueLength=1> <value>
        const buf = Buffer.alloc(6);
        buf[0] = 0xB0;
        buf[1] = 0x01;
        buf.writeUInt16LE(propertyId, 2);
        buf[4] = 0x01;
        buf[5] = value & 0xFF;
        super(device, buf, 2 /* FRAME_TYPE.SET */);
    }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () {
            Logger_1._LOGGER.debug("SetPropertiesCommand::execute()");
            yield _super.execute.call(this);
        });
    }
}
exports.SetPropertiesCommand = SetPropertiesCommand;
`;
const setPropertiesCommandDts = `import { Device } from "../Device";
import { LANCommand } from './LANCommand';
export declare enum PROPERTY_ID {
    SWING_UD_ANGLE = 9,
    SWING_LR_ANGLE = 10,
    SELF_CLEAN = 57,
    BREEZELESS = 24,
    INDIRECT_WIND = 66
}
export declare class SetPropertiesCommand extends LANCommand {
    constructor(device: Device, propertyId: number, value: number);
    execute(): Promise<void>;
}
`;
writeOrUpdate('command/SetPropertiesCommand.js', setPropertiesCommandJs);
writeOrUpdate('command/SetPropertiesCommand.d.ts', setPropertiesCommandDts);

console.log('[midea-patch] fertig (v7) - iECO + Ion + JetCool + OutSilent + Energy + Group5 + FollowMe + SetProperties-Fix');
