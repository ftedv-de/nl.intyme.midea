#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const lib = path.join(root, 'node_modules', 'midea-msmarthome-ac-euosk105', 'dist', 'command');

function write(file, content) {
  const target = path.join(lib, file);
  if (!fs.existsSync(path.dirname(target))) {
    console.error(`[energy-decoder] Verzeichnis fehlt: ${path.dirname(target)}`);
    process.exit(1);
  }
  fs.writeFileSync(target, content);
  console.log(`[energy-decoder] ${file} geschrieben`);
}

const responseJs = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetPowerUsageResponse = void 0;
const Logger_1 = require("../Logger");
function normalizeMode(mode) {
    return mode === "bcd" || mode === "binary" ? mode : "auto";
}
function isValidBcdByte(byte) {
    return ((byte >> 4) & 0x0F) <= 9 && (byte & 0x0F) <= 9;
}
function isValidBcdRange(data, offset, length) {
    if (data.length < offset + length) return false;
    for (let i = offset; i < offset + length; i++) {
        if (!isValidBcdByte(data[i])) return false;
    }
    return true;
}
function bcd(byte) {
    if (!isValidBcdByte(byte)) {
        throw new Error("Invalid BCD byte 0x" + byte.toString(16).padStart(2, "0"));
    }
    return ((byte >> 4) & 0x0F) * 10 + (byte & 0x0F);
}
function parseBcdEnergy(data, offset) {
    if (data.length < offset + 4) return null;
    const value = 10000 * bcd(data[offset]) + 100 * bcd(data[offset + 1]) + bcd(data[offset + 2]) + 0.01 * bcd(data[offset + 3]);
    return Math.round(value * 100) / 100;
}
function parseBcdPower(data, offset) {
    if (data.length < offset + 3) return null;
    const value = 1000 * bcd(data[offset]) + 10 * bcd(data[offset + 1]) + 0.1 * bcd(data[offset + 2]);
    return Math.round(value * 10) / 10;
}
function parseBinaryEnergy(data, offset) {
    if (data.length < offset + 4) return null;
    return Math.round((data.readUInt32BE(offset) / 100) * 100) / 100;
}
function parseBinaryPower(data, offset) {
    if (data.length < offset + 3) return null;
    return Math.round((data.readUIntBE(offset, 3) / 10) * 10) / 10;
}
function resolveMode(payload, configuredMode) {
    const mode = normalizeMode(configuredMode);
    if (mode !== "auto") return mode;
    return isValidBcdRange(payload, 4, 4)
        && isValidBcdRange(payload, 12, 4)
        && isValidBcdRange(payload, 16, 3)
        ? "bcd"
        : "binary";
}
class GetPowerUsageResponse {
    constructor(data, decodeMode = "auto") {
        this.totalEnergy = null;
        this.currentEnergy = null;
        this.realTimePower = null;
        this.decodeMode = "auto";
        try {
            const payload = data.subarray(10, data.length - 2);
            Logger_1._LOGGER.debug("GetPowerUsageResponse raw=" + payload.toString("hex"));
            const resolvedMode = resolveMode(payload, decodeMode);
            this.decodeMode = resolvedMode;
            if (resolvedMode === "binary") {
                this.totalEnergy = parseBinaryEnergy(payload, 4);
                this.currentEnergy = parseBinaryEnergy(payload, 12);
                this.realTimePower = parseBinaryPower(payload, 16);
            } else {
                this.totalEnergy = parseBcdEnergy(payload, 4);
                this.currentEnergy = parseBcdEnergy(payload, 12);
                this.realTimePower = parseBcdPower(payload, 16);
            }
            Logger_1._LOGGER.debug("GetPowerUsageResponse [" + resolvedMode + "]: total=" + this.totalEnergy + " kWh, current=" + this.currentEnergy + " kWh, power=" + this.realTimePower + " W");
        } catch (e) {
            Logger_1._LOGGER.debug("GetPowerUsageResponse parse error: " + e);
        }
    }
}
exports.GetPowerUsageResponse = GetPowerUsageResponse;
`;

const responseDts = `export type EnergyDecodeMode = 'auto' | 'bcd' | 'binary';
export declare class GetPowerUsageResponse {
    totalEnergy: number | null;
    currentEnergy: number | null;
    realTimePower: number | null;
    decodeMode: EnergyDecodeMode;
    constructor(data: Buffer, decodeMode?: EnergyDecodeMode);
}
`;

const commandJs = `"use strict";
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
    constructor(device, decodeMode = "auto") {
        super(device, Buffer.from([0x41, 0x21, 0x01, 0x44, 0x00, 0x01]), 3);
        this._decodeMode = decodeMode;
    }
    execute() {
        const _super = Object.create(null, { execute: { get: () => super.execute } });
        return __awaiter(this, void 0, void 0, function* () {
            Logger_1._LOGGER.debug("GetPowerUsageCommand::execute()");
            try {
                const responses = yield _super.execute.call(this);
                if (!responses || responses.length === 0) return null;
                return new GetPowerUsageResponse_1.GetPowerUsageResponse(responses[0], this._decodeMode);
            } catch (e) {
                Logger_1._LOGGER.debug("GetPowerUsageCommand: keine Antwort - " + e);
                return null;
            }
        });
    }
}
exports.GetPowerUsageCommand = GetPowerUsageCommand;
`;

const commandDts = `import { Device } from "../Device";
import { LANCommand } from './LANCommand';
import { EnergyDecodeMode, GetPowerUsageResponse } from './GetPowerUsageResponse';
export declare class GetPowerUsageCommand extends LANCommand {
    constructor(device: Device, decodeMode?: EnergyDecodeMode);
    execute(): Promise<GetPowerUsageResponse | null>;
}
`;

write('GetPowerUsageResponse.js', responseJs);
write('GetPowerUsageResponse.d.ts', responseDts);
write('GetPowerUsageCommand.js', commandJs);
write('GetPowerUsageCommand.d.ts', commandDts);

const settingsPath = path.join(root, 'drivers', 'airco', 'driver.settings.compose.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const energyGroup = settings.find(item => item.type === 'group' && item.label && item.label.en === 'Energy polling');
if (!energyGroup) {
  console.error('[energy-decoder] Energy-polling-Gruppe nicht gefunden');
  process.exit(1);
}
if (!energyGroup.children.some(child => child.id === 'energy_decode_mode')) {
  energyGroup.children.push({
    id: 'energy_decode_mode',
    type: 'dropdown',
    label: {
      en: 'Energy data format',
      de: 'Format der Energiedaten',
      nl: 'Formaat energiegegevens'
    },
    hint: {
      en: 'Automatic detects BCD or binary encoding per response. Select a fixed format if automatic detection is not reliable for your model.',
      de: 'Automatisch erkennt BCD- oder Binärkodierung pro Antwort. Ein festes Format wählen, falls die automatische Erkennung bei diesem Modell nicht zuverlässig ist.',
      nl: 'Automatisch detecteert BCD- of binaire codering per antwoord. Kies een vast formaat als automatische detectie voor dit model niet betrouwbaar is.'
    },
    value: 'auto',
    values: [
      { id: 'auto', label: { en: 'Automatic', de: 'Automatisch', nl: 'Automatisch' } },
      { id: 'bcd', label: { en: 'BCD', de: 'BCD', nl: 'BCD' } },
      { id: 'binary', label: { en: 'Binary', de: 'Binär', nl: 'Binair' } }
    ]
  });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 1) + '\n');
  console.log('[energy-decoder] Device-Setting ergänzt');
} else {
  console.log('[energy-decoder] Device-Setting bereits vorhanden');
}

const devicePath = path.join(root, 'drivers', 'airco', 'device.ts');
let device = fs.readFileSync(devicePath, 'utf8');
const oldCall = 'const energy: any = await new GetPowerUsageCommand(this._device).execute();';
const newCall = `const configuredDecodeMode = this.getSetting("energy_decode_mode");
        const energyDecodeMode = (configuredDecodeMode === "bcd" || configuredDecodeMode === "binary")
          ? configuredDecodeMode
          : "auto";
        const energy: any = await new GetPowerUsageCommand(this._device, energyDecodeMode).execute();`;
if (device.includes(oldCall)) {
  device = device.replace(oldCall, newCall);
  fs.writeFileSync(devicePath, device);
  console.log('[energy-decoder] device.ts angepasst');
} else if (device.includes('new GetPowerUsageCommand(this._device, energyDecodeMode)')) {
  console.log('[energy-decoder] device.ts bereits angepasst');
} else {
  console.error('[energy-decoder] GetPowerUsageCommand-Aufruf nicht gefunden');
  process.exit(1);
}
