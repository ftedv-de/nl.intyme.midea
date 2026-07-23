#!/usr/bin/env node
/**
 * Patcht midea-msmarthome-ac-euosk105 fuer erweiterte Midea-Funktionen.
 *
 * Enthalten:
 * - iECO, Ion, JetCool, Outdoor Silent, Follow Me
 * - Energie/Leistung und Group-5-Sensoren
 * - Self Clean / Active Clean (Property 0x0039)
 * - reparierter SetPropertiesCommand
 *
 * Wird automatisch via postinstall ausgefuehrt.
 */
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'node_modules', 'midea-msmarthome-ac-euosk105', 'dist');
const MARK = '/* PATCHED:ieco-ion-v8 */';

function patch(file, transforms) {
  const p = path.join(LIB, file);
  if (!fs.existsSync(p)) {
    console.warn(`[midea-patch] ${file} nicht gefunden, ueberspringe`);
    return;
  }
  let src = fs.readFileSync(p, 'utf8');
  if (src.includes(MARK)) {
    console.log(`[midea-patch] ${file} bereits gepatcht (v8)`);
    return;
  }
  const hadOldMark = /^\/\* PATCHED:ieco-ion(-v[0-9]+)? \*\//.test(src);
  src = src.replace(/^\/\* PATCHED:ieco-ion(-v[0-9]+)? \*\/\n/, '');
  let appliedAny = false;
  for (const [find, replace] of transforms) {
    if (!src.includes(find)) {
      if (hadOldMark) {
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
  console.log(`[midea-patch] ${file} gepatcht (v8${appliedAny ? '' : ', nur Marker-Upgrade'})`);
}

function writeOrUpdate(rel, content) {
  const p = path.join(LIB, rel);
  fs.writeFileSync(p, content);
  console.log(`[midea-patch] ${rel} geschrieben`);
}

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

(function applyFollowMeSetStatePatch() {
  const p = path.join(LIB, 'command/SetStateCommand.js');
  if (!fs.existsSync(p)) return;
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('followMeBit')) return;
  if (!s.includes('const turboAlt = deviceState.turboMode ? 0x20 : 0;')) return;
  s = s.replace(
    'const turboAlt = deviceState.turboMode ? 0x20 : 0;',
    'const turboAlt = deviceState.turboMode ? 0x20 : 0;\n        const followMeBit = deviceState.followMe ? 0x80 : 0;\n        const byte8 = turboAlt | followMeBit;',
  );
  s = s.replace('turboAlt,\n            byte9,', 'byte8,\n            byte9,');
  fs.writeFileSync(p, s);
})();

patch('command/GetStateResponse.js', [
  [
    'this.ecoMode = (data[9] & 0x10) === 0x10;',
    `this.ecoMode   = (data[9] & 0x10) === 0x10;
        this.anionMode = (data[9] & 0x20) === 0x20;`,
  ],
]);

(function applyFollowMeGetStatePatch() {
  const p = path.join(LIB, 'command/GetStateResponse.js');
  if (!fs.existsSync(p)) return;
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('this.followMe')) return;
  if (!s.includes('this.anionMode = (data[9] & 0x20) === 0x20;')) return;
  s = s.replace(
    'this.anionMode = (data[9] & 0x20) === 0x20;',
    'this.anionMode = (data[9] & 0x20) === 0x20;\n        this.followMe  = (data[8] & 0x80) === 0x80;',
  );
  fs.writeFileSync(p, s);
})();

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
  }
}

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
const LANCommand_1 = require("./LANCommand");
const GetStateCommand_1 = require("./GetStateCommand");
class SetIEcoCommand extends LANCommand_1.LANCommand {
    constructor(device, on) {
        const value = Buffer.alloc(13);
        value[0] = 0x00;
        value[1] = 0x01;
        value[2] = on ? 0x01 : 0x00;
        const body = Buffer.concat([Buffer.from([0xB0, 0x01, 0xE3, 0x00, 0x0D]), value]);
        super(device, body, 2);
        this._on = on;
    }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () {
            yield _super.execute.call(this);
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
const LANCommand_1 = require("./LANCommand");
class GetIEcoCommand extends LANCommand_1.LANCommand {
    constructor(device) { super(device, Buffer.from([0xB1, 0x01, 0xE3, 0x00]), 3); }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const responses = yield _super.execute.call(this);
                if (!responses || responses.length === 0) return null;
                const data = responses[0].subarray(10, responses[0].length - 2);
                for (let i = 2; i + 4 < data.length;) {
                    const param = data[i] | (data[i + 1] << 8);
                    const size = data[i + 3];
                    if (param === 0x00E3 && size >= 2) return data[i + 5] === 0x01;
                    i += size === 0 ? 4 : 4 + size;
                }
                return null;
            } catch (e) { return null; }
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
writeOrUpdate('command/SetIEcoCommand.js', setIEcoJs);
writeOrUpdate('command/SetIEcoCommand.d.ts', setIEcoDts);
writeOrUpdate('command/GetIEcoCommand.js', getIEcoJs);
writeOrUpdate('command/GetIEcoCommand.d.ts', getIEcoDts);

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
    'const LANCommand_1 = require("./LANCommand");',
    'const GetStateCommand_1 = require("./GetStateCommand");',
    `class Set${className}Command extends LANCommand_1.LANCommand {`,
    '    constructor(device, on) {',
    `        const body = Buffer.from([0xB0, 0x01, ${hex2(paramLow)}, ${hex2(paramHigh)}, 0x01, on ? ${hex2(onValue)} : ${hex2(offValue)}]);`,
    '        super(device, body, 2);',
    '        this._on = on;',
    '    }',
    '    execute() {',
    '        const _super = Object.create(null, { execute: { get: () => super.execute } });',
    '        return __awaiter(this, void 0, void 0, function* () {',
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
    'const LANCommand_1 = require("./LANCommand");',
    `class Get${className}Command extends LANCommand_1.LANCommand {`,
    '    constructor(device) {',
    `        super(device, Buffer.from([0xB1, 0x01, ${hex2(paramLow)}, ${hex2(paramHigh)}]), 3);`,
    '    }',
    '    execute() {',
    '        const _super = Object.create(null, { execute: { get: () => super.execute } });',
    '        return __awaiter(this, void 0, void 0, function* () {',
    '            try {',
    '                const responses = yield _super.execute.call(this);',
    '                if (!responses || responses.length === 0) return null;',
    '                const data = responses[0].subarray(10, responses[0].length - 2);',
    '                for (let i = 2; i + 4 < data.length;) {',
    '                    const param = data[i] | (data[i + 1] << 8);',
    '                    const size = data[i + 3];',
    `                    if (param === ${hex4(propertyId)} && size >= 1) return data[i + 4] === ${hex2(onValue)};`,
    '                    i += size === 0 ? 4 : 4 + size;',
    '                }',
    '                return null;',
    '            } catch (e) { return null; }',
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

makeSimplePropertyCommands('JetCool', 0x0067, 0x01, 0x00);
makeSimplePropertyCommands('OutSilent', 0x00CD, 0x03, 0x00);
makeSimplePropertyCommands('SelfClean', 0x0039, 0x01, 0x00);

const getPowerUsageResponseJs = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetPowerUsageResponse = void 0;
const Logger_1 = require("../Logger");
function bcd(byte) {
    const high = (byte >> 4) & 0x0F;
    const low = byte & 0x0F;
    if (high > 9 || low > 9) throw new Error("Invalid BCD byte 0x" + byte.toString(16).padStart(2, "0"));
    return high * 10 + low;
}
function parseEnergy(d, off) {
    if (d.length < off + 4) return null;
    const v = 10000 * bcd(d[off]) + 100 * bcd(d[off + 1]) + bcd(d[off + 2]) + 0.01 * bcd(d[off + 3]);
    return Math.round(v * 100) / 100;
}
function parsePower(d, off) {
    if (d.length < off + 3) return null;
    const v = 1000 * bcd(d[off]) + 10 * bcd(d[off + 1]) + 0.1 * bcd(d[off + 2]);
    return Math.round(v * 10) / 10;
}
class GetPowerUsageResponse {
    constructor(data) {
        const payload = data.subarray(10, data.length - 2);
        Logger_1._LOGGER.debug("GetPowerUsageResponse raw=" + payload.toString("hex"));
        try { this.totalEnergy = parseEnergy(payload, 4); } catch (e) { this.totalEnergy = null; Logger_1._LOGGER.debug("total energy parse error: " + e); }
        try { this.currentEnergy = parseEnergy(payload, 12); } catch (e) { this.currentEnergy = null; Logger_1._LOGGER.debug("current energy parse error: " + e); }
        try { this.realTimePower = parsePower(payload, 16); } catch (e) { this.realTimePower = null; Logger_1._LOGGER.debug("power parse error: " + e); }
        Logger_1._LOGGER.debug("GetPowerUsageResponse: total=" + this.totalEnergy + " kWh, current=" + this.currentEnergy + " kWh, power=" + this.realTimePower + " W");
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

const getPowerUsageCommandDts = `import { Device } from "../Device";
import { LANCommand } from './LANCommand';
import { GetPowerUsageResponse } from './GetPowerUsageResponse';
export declare class GetPowerUsageCommand extends LANCommand {
    constructor(device: Device);
    execute(): Promise<GetPowerUsageResponse | null>;
}
`;
writeOrUpdate('command/GetPowerUsageCommand.d.ts', getPowerUsageCommandDts);

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
const GetPowerUsageResponse_1 = require("./GetPowerUsageResponse");
const LANCommand_1 = require("./LANCommand");
class GetPowerUsageCommand extends LANCommand_1.LANCommand {
    constructor(device) { super(device, Buffer.from([0x41, 0x21, 0x01, 0x44, 0x00, 0x01]), 3); }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const responses = yield _super.execute.call(this);
                if (!responses || responses.length === 0) return null;
                return new GetPowerUsageResponse_1.GetPowerUsageResponse(responses[0]);
            } catch (e) { return null; }
        });
    }
}
exports.GetPowerUsageCommand = GetPowerUsageCommand;
`;
writeOrUpdate('command/GetPowerUsageCommand.js', getPowerUsageCommandJs);

const getGroup5ResponseJs = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetGroup5Response = void 0;
class GetGroup5Response {
    constructor(data) {
        try {
            const payload = data.subarray(10, data.length - 2);
            const hRaw = payload.length > 4 ? payload[4] : 0;
            this.humidity = hRaw > 0 && hRaw <= 100 ? hRaw : null;
            this.outdoorFanSpeed = payload.length > 8 ? 8 * payload[8] : null;
            this.defrostMode = payload.length > 10 ? !!(payload[10] & 0x01) : false;
        } catch (e) {
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
const GetGroup5Response_1 = require("./GetGroup5Response");
const LANCommand_1 = require("./LANCommand");
class GetGroup5Command extends LANCommand_1.LANCommand {
    constructor(device) { super(device, Buffer.from([0x41, 0x21, 0x01, 0x45, 0x00, 0x01]), 3); }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const responses = yield _super.execute.call(this);
                if (!responses || responses.length === 0) return null;
                return new GetGroup5Response_1.GetGroup5Response(responses[0]);
            } catch (e) { return null; }
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
        const buf = Buffer.alloc(6);
        buf[0] = 0xB0;
        buf[1] = 0x01;
        buf.writeUInt16LE(propertyId, 2);
        buf[4] = 0x01;
        buf[5] = value & 0xFF;
        super(device, buf, 2);
    }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () { yield _super.execute.call(this); });
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

console.log('[midea-patch] fertig (v8) - SelfClean + sicherer Energie-Decoder');
