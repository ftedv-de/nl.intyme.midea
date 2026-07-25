import Homey from 'homey';
import {
  Driver as MDriver,
  Device as MDevice,
  DeviceContext as MDeviceContext,
  GetStateCommand,
  DeviceState,
  LANSecurityContext,
  CloudSecurityContext,
  SetStateCommand,
  _LOGGER,
} from 'midea-msmarthome-ac-euosk105';
import { SetIEcoCommand } from 'midea-msmarthome-ac-euosk105/dist/command/SetIEcoCommand';
import { GetIEcoCommand } from 'midea-msmarthome-ac-euosk105/dist/command/GetIEcoCommand';
import { SetJetCoolCommand } from 'midea-msmarthome-ac-euosk105/dist/command/SetJetCoolCommand';
import { GetJetCoolCommand } from 'midea-msmarthome-ac-euosk105/dist/command/GetJetCoolCommand';
import { SetOutSilentCommand } from 'midea-msmarthome-ac-euosk105/dist/command/SetOutSilentCommand';
import { GetOutSilentCommand } from 'midea-msmarthome-ac-euosk105/dist/command/GetOutSilentCommand';
import { SetSelfCleanCommand } from 'midea-msmarthome-ac-euosk105/dist/command/SetSelfCleanCommand';
import { GetSelfCleanCommand } from 'midea-msmarthome-ac-euosk105/dist/command/GetSelfCleanCommand';
import { GetPowerUsageCommand } from 'midea-msmarthome-ac-euosk105/dist/command/GetPowerUsageCommand';
import { GetGroup5Command } from 'midea-msmarthome-ac-euosk105/dist/command/GetGroup5Command';
import { SetPropertiesCommand, PROPERTY_ID } from 'midea-msmarthome-ac-euosk105/dist/command/SetPropertiesCommand';
import { FAN_SPEED, OPERATIONAL_MODE, SWING_MODE } from 'midea-msmarthome-ac-euosk105/dist/DeviceState';

const LAN_OPERATION_TIMEOUT_MS = 15000;
const LAN_OPERATION_ATTEMPTS = 2;

const LOUVER_VALUES: { [key: string]: number } = {
  auto: 0,
  p1: 1,
  p2: 25,
  p3: 50,
  p4: 75,
  p5: 100,
};

function louverIdFromRaw(raw: number | undefined | null): string {
  if (raw === null || raw === undefined || raw <= 0) return 'auto';
  if (raw <= 12) return 'p1';
  if (raw <= 37) return 'p2';
  if (raw <= 62) return 'p3';
  if (raw <= 87) return 'p4';
  return 'p5';
}

export class MideaDevice extends Homey.Device {
  public _device: MDevice;

  private _pollTimerId: NodeJS.Timeout | null = null;
  private _energyPollTimerId: NodeJS.Timeout | null = null;
  private _pollGeneration = 0;
  private _energyPollGeneration = 0;
  private _commandQueue: Promise<void> = Promise.resolve();
  private _maximumFailureCount = 5;
  private _failureCount = 0;
  private _capabilityProbed = { power: false, energy: false, humidity: false, defrost: false };
  private _lastValid = {
    realTimePower: null as number | null,
    totalEnergy: null as number | null,
    humidity: null as number | null,
  };
  private _capabilityLockedUntil: { [cap: string]: number } = {};
  private _lastOperationalMode: number | null = null;
  private _consecutiveEnergyFailures = 0;
  private _registeredCapabilityListeners = new Set<string>();

  async onInit() {
    this.log(`Midea AC [${this.getName()}] initializing ...`);
    this._failureCount = 0;
    this._commandQueue = Promise.resolve();
    this._stopPolling();
    this._stopEnergyPolling();
    this._closeLanConnection();

    const settings = this.getSettings();
    this._maximumFailureCount = Number(settings.max_number_of_errors_before_device_unavailable) || 5;

    try {
      this._device = new MDevice(this._createDeviceContext());

      if (!this.getStore().token || !this.getStore().key) {
        const cloudSecurityContext = new CloudSecurityContext(this.getStore().username, this.getStore().password);
        const lanSecurityContext = await MDriver.retrieveTokenAndKeyFromCloud(this._device, cloudSecurityContext);
        await this.setStoreValue('token', lanSecurityContext.token);
        await this.setStoreValue('key', lanSecurityContext.key);
      }

      const capabilities = [
        'onoff',
        'target_temperature',
        'thermostat_mode',
        'thermostat_boost',
        'thermostat_fan_speed',
        'thermostat_eco',
        'thermostat_freeze_protection',
        'ieco',
        'ion_mode',
        'jet_cool',
        'out_silent',
        'follow_me',
        'airco_swing',
        'airco_louver',
        'self_clean',
      ];

      for (const capability of capabilities) {
        if (!this.hasCapability(capability)) await this.addCapability(capability);
        if (!this._registeredCapabilityListeners.has(capability)) {
          this.registerCapabilityListener(capability, async (value, opts) => this.onCapability(capability, value, opts));
          this._registeredCapabilityListeners.add(capability);
        }
      }

      if (this.hasCapability('thermostat_swing_mode')) {
        await this.removeCapability('thermostat_swing_mode').catch(error => this.log(`removeCapability thermostat_swing_mode: ${error}`));
      }

      await this._refreshState();
      await this.setAvailable();

      this._initializePolling(Number(settings.polling_interval) || 10);
      this._initializeEnergyPolling(Number(settings.poll_energy_interval) || 60);

      this.log(`Midea AC [${this.getName()}] initialized successfully`);
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      this.error(`Cannot initialize device[${this.getName()}]: ${message}`);
      await this.setUnavailable(`Cannot initialize device[${this.getName()}]: ${message}`);

      if (this._getStoredLanSecurityContext()) {
        this._initializePolling(Number(settings.polling_interval) || 10);
        this._initializeEnergyPolling(Number(settings.poll_energy_interval) || 60);
      }
    }
  }

  private _createDeviceContext(): MDeviceContext {
    const data = this.getData();
    const store = this.getStore();
    const deviceContext = new MDeviceContext();
    deviceContext.id = data.id;
    deviceContext.macAddress = data.macAddress;
    deviceContext.udpId = data.udpId;
    deviceContext.host = store.host || data.host;
    deviceContext.port = store.port || data.port;

    if (!deviceContext.host || !deviceContext.port) {
      throw new Error('Missing LAN host or port; repair or re-add the device');
    }

    return deviceContext;
  }

  private _getStoredLanSecurityContext(): LANSecurityContext | null {
    const store = this.getStore();
    if (typeof store.token !== 'string' || typeof store.key !== 'string' || !store.token || !store.key) return null;
    return new LANSecurityContext(store.token, store.key);
  }

  private _closeLanConnection(device = this._device) {
    if (!device) return;
    const socket = (device as unknown as { lanConnection?: { _socket?: { destroy?: () => void } } }).lanConnection?._socket;
    socket?.destroy?.();
    device.close();
  }

  private _resetLanDevice() {
    this._closeLanConnection();
    this._device = new MDevice(this._createDeviceContext());
    const context = this._getStoredLanSecurityContext();
    if (context) this._device.lanSecurityContext = context;
  }

  private _initializePolling(intervalSeconds: number) {
    this._stopPolling();
    const generation = this._pollGeneration;
    const intervalMs = Math.max(1, intervalSeconds) * 1000;

    const poll = async () => {
      this._pollTimerId = null;
      try {
        await this._refreshState();
      } catch (error) {
        this.error(`State poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (generation === this._pollGeneration) {
        this._pollTimerId = this.homey.setTimeout(poll, intervalMs);
      }
    };

    this._pollTimerId = this.homey.setTimeout(poll, intervalMs);
  }

  private _stopPolling() {
    this._pollGeneration++;
    if (this._pollTimerId) {
      this.homey.clearTimeout(this._pollTimerId);
      this._pollTimerId = null;
    }
  }

  private _initializeEnergyPolling(intervalSeconds: number) {
    this._stopEnergyPolling();
    if (intervalSeconds <= 0) return;

    const generation = this._energyPollGeneration;
    const intervalMs = intervalSeconds * 1000;

    const poll = async () => {
      this._energyPollTimerId = null;
      try {
        await this._pollEnergyAndGroup5();
      } catch (error) {
        this.log(`Energy poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (generation === this._energyPollGeneration) {
        this._energyPollTimerId = this.homey.setTimeout(poll, intervalMs);
      }
    };

    this._energyPollTimerId = this.homey.setTimeout(poll, 3000);
  }

  private _stopEnergyPolling() {
    this._energyPollGeneration++;
    if (this._energyPollTimerId) {
      this.homey.clearTimeout(this._energyPollTimerId);
      this._energyPollTimerId = null;
    }
  }

  private _isPlausibleEnergyValue(value: number): boolean {
    if (!Number.isFinite(value) || value < 0 || value > 100000) return false;
    const last = this._lastValid.totalEnergy;
    if (last === null) return true;
    if (value >= last - 0.01 && value - last <= 100) return true;

    const currentCapability = this.hasCapability('meter_power') ? this.getCapabilityValue('meter_power') : null;
    if (typeof currentCapability === 'number' && currentCapability > 100000 && value < 100000) {
      this.log(`Recovering invalid stored energy value ${currentCapability} kWh with ${value} kWh`);
      return true;
    }

    return false;
  }

  private async _pollEnergyAndGroup5(): Promise<void> {
    return this._runExclusive(async () => {
      let anySuccess = false;

      try {
        const configuredDecodeMode = this.getSetting('energy_decode_mode');
        const energyDecodeMode = configuredDecodeMode === 'bcd' || configuredDecodeMode === 'binary'
          ? configuredDecodeMode
          : 'auto';
        const energy: any = await this._withLanTimeout(
          'get power usage',
          device => new GetPowerUsageCommand(device, energyDecodeMode).execute(),
        );

        if (energy) {
          if (Number.isFinite(energy.realTimePower) && energy.realTimePower >= 0 && energy.realTimePower <= 20000) {
            this._lastValid.realTimePower = energy.realTimePower;
            if (!this.hasCapability('measure_power')) await this.addCapability('measure_power');
            this._capabilityProbed.power = true;
            this._setCapIfChanged('measure_power', energy.realTimePower);
            anySuccess = true;
          }

          if (this._isPlausibleEnergyValue(energy.totalEnergy)) {
            this._lastValid.totalEnergy = energy.totalEnergy;
            if (!this.hasCapability('meter_power')) await this.addCapability('meter_power');
            this._capabilityProbed.energy = true;
            this._setCapIfChanged('meter_power', energy.totalEnergy, true);
            anySuccess = true;
          } else if (Number.isFinite(energy.totalEnergy)) {
            this.log(`Ignoring implausible energy value ${energy.totalEnergy} kWh`);
          }
        }
      } catch (error) {
        this.log(`Energy poll failed: ${error instanceof Error ? error.message : error}`);
      }

      try {
        const group5: any = await this._withLanTimeout(
          'get group5',
          device => new GetGroup5Command(device).execute(),
        );

        if (group5) {
          if (Number.isFinite(group5.humidity) && group5.humidity >= 1 && group5.humidity <= 100) {
            this._lastValid.humidity = group5.humidity;
            if (!this.hasCapability('measure_humidity')) await this.addCapability('measure_humidity');
            this._capabilityProbed.humidity = true;
            this._setCapIfChanged('measure_humidity', group5.humidity);
            anySuccess = true;
          }

          if (group5.defrostMode === true) {
            if (!this.hasCapability('alarm_defrost')) await this.addCapability('alarm_defrost');
            this._capabilityProbed.defrost = true;
            this._setCapIfChanged('alarm_defrost', true);
            anySuccess = true;
          } else if (this._capabilityProbed.defrost) {
            this._setCapIfChanged('alarm_defrost', false);
          }
        }
      } catch (error) {
        this.log(`Group5 poll failed: ${error instanceof Error ? error.message : error}`);
      }

      this._consecutiveEnergyFailures = anySuccess ? 0 : this._consecutiveEnergyFailures + 1;
    });
  }

  private async _refreshState() {
    return this._runExclusive(() => this._refreshStateUnsafe());
  }

  private async _refreshStateUnsafe() {
    try {
      const state = await this._withLanTimeout('get state', device => new GetStateCommand(device).execute());
      let iEcoState: boolean | null = null;
      let jetCoolState: boolean | null = null;
      let outSilentState: boolean | null = null;
      let selfCleanState: boolean | null = null;

      try { iEcoState = await this._withLanTimeout('get iECO', device => new GetIEcoCommand(device).execute()); } catch (error) { this.log(error); }
      try { jetCoolState = await this._withLanTimeout('get jet cool', device => new GetJetCoolCommand(device).execute()); } catch (error) { this.log(error); }
      try { outSilentState = await this._withLanTimeout('get outdoor silent', device => new GetOutSilentCommand(device).execute()); } catch (error) { this.log(error); }
      try { selfCleanState = await this._withLanTimeout('get self clean', device => new GetSelfCleanCommand(device).execute()); } catch (error) { this.log(error); }

      this._updateState(state, iEcoState, jetCoolState, outSilentState, selfCleanState);
      this._failureCount = 0;
      if (!this.getAvailable()) await this.setAvailable();
      return state;
    } catch (error) {
      this._failureCount++;
      if (this._failureCount >= this._maximumFailureCount) {
        await this.setUnavailable(`Device [${this.getName()}] is unavailable; failure count: ${this._failureCount}`);
      }
      throw error;
    }
  }

  private _updateState(
    state: DeviceState,
    iEcoState: boolean | null = null,
    jetCoolState: boolean | null = null,
    outSilentState: boolean | null = null,
    selfCleanState: boolean | null = null,
  ) {
    if (state.powerOn) this._lastOperationalMode = state.operationalMode;
    const set = (capability: string, value: any) => this._setCapIfChanged(capability, value);

    set('onoff', state.powerOn);
    if (state.powerOn) {
      switch (state.operationalMode) {
        case OPERATIONAL_MODE.AUTO: set('thermostat_mode', 'auto'); break;
        case OPERATIONAL_MODE.COOL: set('thermostat_mode', 'cool'); break;
        case OPERATIONAL_MODE.HEAT: set('thermostat_mode', 'heat'); break;
        case OPERATIONAL_MODE.DRY: set('thermostat_mode', 'dry'); break;
        case OPERATIONAL_MODE.FAN: set('thermostat_mode', 'fan'); break;
        default: break;
      }
    } else {
      set('thermostat_mode', 'off');
    }

    set('thermostat_boost', state.turboMode);
    set('target_temperature', state.operationalMode === OPERATIONAL_MODE.FAN ? state.indoorTemperature : state.targetTemperature);
    set('measure_temperature', state.indoorTemperature);
    if (state.outdoorTemperature !== null && state.outdoorTemperature < 60) set('measure_temperature.outside', state.outdoorTemperature);

    switch (state.fanSpeed) {
      case FAN_SPEED.AUTO:
      case FAN_SPEED.FIXED: set('thermostat_fan_speed', 'auto'); break;
      case FAN_SPEED.SILENT: set('thermostat_fan_speed', 'silent'); break;
      case FAN_SPEED.LOW: set('thermostat_fan_speed', 'low'); break;
      case FAN_SPEED.MEDIUM: set('thermostat_fan_speed', 'medium'); break;
      case FAN_SPEED.HIGH: set('thermostat_fan_speed', 'high'); break;
      case FAN_SPEED.FULL: set('thermostat_fan_speed', 'full'); break;
      default: break;
    }

    const louverPosition = louverIdFromRaw((state as any).verticalSwingAngle);
    const swingActive = state.swingMode !== SWING_MODE.OFF;
    set('airco_swing', swingActive);
    set('airco_louver', louverPosition);
    set('thermostat_eco', state.ecoMode);
    set('thermostat_freeze_protection', state.freezeProtectionMode);
    set('ion_mode', (state as any).anionMode === true);

    if (typeof (state as any).followMe === 'boolean') set('follow_me', (state as any).followMe);
    if (iEcoState !== null) set('ieco', iEcoState);
    if (jetCoolState !== null) set('jet_cool', jetCoolState);
    if (outSilentState !== null) set('out_silent', outSilentState);
    if (selfCleanState !== null) set('self_clean', selfCleanState);
  }

  private _setCapIfChanged(capability: string, value: any, force = false): boolean {
    if (!this.hasCapability(capability)) return false;
    if (!force) {
      const lockedUntil = this._capabilityLockedUntil[capability];
      if (lockedUntil && Date.now() < lockedUntil) return false;
    }
    if (this.getCapabilityValue(capability) === value) return false;
    this.setCapabilityValue(capability, value).catch(error => this.error(error));
    return true;
  }

  private _lockCapability(capability: string, milliseconds = 5000) {
    this._capabilityLockedUntil[capability] = Date.now() + milliseconds;
  }

  async onCapability(capability: string, value: any, opts: any) {
    return this._runExclusive(async () => {
      this.log(`Device::onCapability(${capability}, ${JSON.stringify(value)})`);

      try {
        this._setCapIfChanged(capability, value, true);
        this._lockCapability(capability);

        let state = await this._withLanTimeout(
          'get state before capability update',
          device => new GetStateCommand(device).execute(),
        );

        switch (capability) {
          case 'onoff':
            state.powerOn = Boolean(value);
            if (state.powerOn && this._lastOperationalMode !== null) state.operationalMode = this._lastOperationalMode;
            break;
          case 'target_temperature': state.targetTemperature = Number(value); break;
          case 'thermostat_mode':
            if (value === 'off') state.powerOn = false;
            else {
              state.powerOn = true;
              if (value === 'auto') state.operationalMode = OPERATIONAL_MODE.AUTO;
              if (value === 'cool') state.operationalMode = OPERATIONAL_MODE.COOL;
              if (value === 'heat') state.operationalMode = OPERATIONAL_MODE.HEAT;
              if (value === 'dry') state.operationalMode = OPERATIONAL_MODE.DRY;
              if (value === 'fan') state.operationalMode = OPERATIONAL_MODE.FAN;
            }
            break;
          case 'thermostat_boost': state.turboMode = Boolean(value); break;
          case 'thermostat_eco': state.ecoMode = Boolean(value); break;
          case 'thermostat_freeze_protection': state.freezeProtectionMode = Boolean(value); break;
          case 'thermostat_fan_speed':
            if (value === 'auto') state.fanSpeed = state.operationalMode === OPERATIONAL_MODE.AUTO ? FAN_SPEED.FIXED : FAN_SPEED.AUTO;
            if (value === 'silent') state.fanSpeed = FAN_SPEED.SILENT;
            if (value === 'low') state.fanSpeed = FAN_SPEED.LOW;
            if (value === 'medium') state.fanSpeed = FAN_SPEED.MEDIUM;
            if (value === 'high') state.fanSpeed = FAN_SPEED.HIGH;
            if (value === 'full') state.fanSpeed = FAN_SPEED.FULL;
            break;
          case 'airco_swing':
            state.swingMode = value ? SWING_MODE.VERTICAL : SWING_MODE.OFF;
            break;
          case 'airco_louver': {
            const raw = LOUVER_VALUES[value] ?? 0;
            await this._withLanTimeout(
              'set louver position',
              device => new SetPropertiesCommand(device, PROPERTY_ID.SWING_UD_ANGLE, raw).execute(),
            );
            this._lockCapability('airco_louver');
            await this._refreshStateUnsafe();
            return;
          }
          case 'ieco':
            await this._withLanTimeout('set iECO', device => new SetIEcoCommand(device, Boolean(value)).execute());
            await this._refreshStateUnsafe();
            return;
          case 'jet_cool':
            await this._withLanTimeout('set jet cool', device => new SetJetCoolCommand(device, Boolean(value)).execute());
            await this._refreshStateUnsafe();
            return;
          case 'out_silent':
            await this._withLanTimeout('set outdoor silent', device => new SetOutSilentCommand(device, Boolean(value)).execute());
            await this._refreshStateUnsafe();
            return;
          case 'self_clean':
            await this._withLanTimeout('set self clean', device => new SetSelfCleanCommand(device, Boolean(value)).execute());
            this._lockCapability('self_clean', 15000);
            await this._refreshStateUnsafe();
            return;
          case 'ion_mode': (state as any).anionMode = Boolean(value); break;
          case 'follow_me': (state as any).followMe = Boolean(value); break;
          default: return;
        }

        state = await this._withLanTimeout(
          `set ${capability}`,
          device => new SetStateCommand(device, state).execute(),
        );
        this._updateState(state);
      } catch (error) {
        this.error(`Error applying capability '${capability}': ${error instanceof Error ? error.message : String(error)}`);
        try {
          await this._refreshStateUnsafe();
        } catch (refreshError) {
          this.error(`Refresh after capability error failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
        }
        throw new Error(`Error during adjustment of settings from device [${this.getName()}]`);
      }
    });
  }

  private async _runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this._commandQueue.catch((): undefined => undefined).then(operation);
    this._commandQueue = run.then((): undefined => undefined, (): undefined => undefined);
    return run;
  }

  private async _withLanTimeout<T>(label: string, operation: (device: MDevice) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= LAN_OPERATION_ATTEMPTS; attempt++) {
      const attemptDevice = this._device;
      let timer: NodeJS.Timeout | undefined;

      try {
        const result = await Promise.race([
          (async () => {
            const context = this._getStoredLanSecurityContext();
            if (!context) throw new Error('Missing LAN token or key');
            await attemptDevice.authenticate(context);
            return operation(attemptDevice);
          })(),
          new Promise<T>((_resolve, reject) => {
            timer = this.homey.setTimeout(() => {
              this._closeLanConnection(attemptDevice);
              reject(new Error(`${label} timed out after ${LAN_OPERATION_TIMEOUT_MS}ms`));
            }, LAN_OPERATION_TIMEOUT_MS);
          }),
        ]);

        this._resetLanDevice();
        return result;
      } catch (error) {
        lastError = error;
        this._closeLanConnection(attemptDevice);
        this._resetLanDevice();
        this.error(`LAN ${label} failed on attempt ${attempt}/${LAN_OPERATION_ATTEMPTS}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (timer) this.homey.clearTimeout(timer);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async onSettings({ newSettings, changedKeys }: { oldSettings: any; newSettings: any; changedKeys: string[] }) {
    if (changedKeys.includes('polling_interval')) this._initializePolling(Number(newSettings.polling_interval) || 10);
    if (changedKeys.includes('poll_energy_interval')) this._initializeEnergyPolling(Number(newSettings.poll_energy_interval) || 60);
    if (changedKeys.includes('debug_level')) _LOGGER.level = String(newSettings.debug_level);
    if (changedKeys.includes('max_number_of_errors_before_device_unavailable')) {
      this._maximumFailureCount = Number(newSettings.max_number_of_errors_before_device_unavailable) || 5;
    }
  }

  async onDeleted() {
    this._stopPolling();
    this._stopEnergyPolling();
    this._closeLanConnection();
  }
}

module.exports = MideaDevice;
