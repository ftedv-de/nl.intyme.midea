import Homey from 'homey';
import { Driver as MDriver, Device as MDevice, DeviceContext as MDeviceContext, GetStateCommand, DeviceState, LANSecurityContext, CloudSecurityContext, SetStateCommand, _LOGGER } from 'midea-msmarthome-ac-euosk105';
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
  private _intervalId: any;
  private _energyIntervalId: any = null;
  private _updatingState = false;
  private _energyPollingActive = false;
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
  private _lastSwingResyncAt = 0;
  private _consecutiveEnergyFailures = 0;

  async onInit() {
    this.log(`Midea AC [${this.getName()}] initializing ...`);
    this._failureCount = 0;

    try {
      const deviceContext: MDeviceContext = new MDeviceContext();
      deviceContext.id = this.getData().id;
      deviceContext.macAddress = this.getData().macAddress;
      deviceContext.udpId = this.getData().udpId;
      deviceContext.host = this.getStore().host;
      deviceContext.port = this.getStore().port;
      this._device = new MDevice(deviceContext);

      if (!this.getStore().token || !this.getStore().key) {
        const cloudSecurityContext = new CloudSecurityContext(this.getStore().username, this.getStore().password);
        const lanSecurityContext = await MDriver.retrieveTokenAndKeyFromCloud(this._device, cloudSecurityContext);
        await this.setStoreValue('token', lanSecurityContext.token);
        await this.setStoreValue('key', lanSecurityContext.key);
      }

      await this._device.authenticate(new LANSecurityContext(this.getStore().token, this.getStore().key));

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
        this.registerCapabilityListener(capability, async (value, opts) => this.onCapability(capability, value, opts));
      }

      if (this.hasCapability('thermostat_swing_mode')) {
        await this.removeCapability('thermostat_swing_mode').catch(error => this.log(`removeCapability thermostat_swing_mode: ${error}`));
      }

      await this._refreshState();
      await this.setAvailable();

      const settings = this.getSettings();
      this._maximumFailureCount = Number(settings.max_number_of_errors_before_device_unavailable) || 5;
      this._initializePolling(Number(settings.polling_interval) || 10);
      this._initializeEnergyPolling(Number(settings.poll_energy_interval) || 60);

      this.log(`Midea AC [${this.getName()}] initialized successfully`);
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      this.error(`Cannot initialize device[${this.getName()}]: ${message}`);
      await this.setUnavailable(`Cannot initialize device[${this.getName()}]: ${message}`);
    }
  }

  private _initializePolling(intervalSeconds: number) {
    if (this._intervalId) this.homey.clearInterval(this._intervalId);
    this._intervalId = this.homey.setInterval(async () => {
      try {
        await this._refreshState();
      } catch (error) {
        this.error(error);
      }
    }, intervalSeconds * 1000);
  }

  private _initializeEnergyPolling(intervalSeconds: number) {
    if (this._energyIntervalId) this.homey.clearInterval(this._energyIntervalId);
    if (intervalSeconds <= 0) return;
    this.homey.setTimeout(() => this._pollEnergyAndGroup5().catch(error => this.log(`Initial energy poll failed: ${error}`)), 3000);
    this._energyIntervalId = this.homey.setInterval(() => this._pollEnergyAndGroup5().catch(error => this.log(`Energy poll failed: ${error}`)), intervalSeconds * 1000);
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
    if (this._energyPollingActive) return;
    this._energyPollingActive = true;
    let anySuccess = false;

    try {
      try {
        const energy: any = await new GetPowerUsageCommand(this._device).execute();
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
        const group5: any = await new GetGroup5Command(this._device).execute();
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
    } finally {
      this._energyPollingActive = false;
    }
  }

  private async _refreshState() {
    if (this._updatingState) return;

    try {
      const state = await new GetStateCommand(this._device).execute();
      let iEcoState: boolean | null = null;
      let jetCoolState: boolean | null = null;
      let outSilentState: boolean | null = null;
      let selfCleanState: boolean | null = null;

      try { iEcoState = await new GetIEcoCommand(this._device).execute(); } catch (error) { this.log(error); }
      try { jetCoolState = await new GetJetCoolCommand(this._device).execute(); } catch (error) { this.log(error); }
      try { outSilentState = await new GetOutSilentCommand(this._device).execute(); } catch (error) { this.log(error); }
      try { selfCleanState = await new GetSelfCleanCommand(this._device).execute(); } catch (error) { this.log(error); }

      this._updateState(state, iEcoState, jetCoolState, outSilentState, selfCleanState);
      this._failureCount = 0;
    } catch (error) {
      this._failureCount++;
      if (this._failureCount >= this._maximumFailureCount) throw error;
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
    }

    const louverPosition = louverIdFromRaw((state as any).verticalSwingAngle);
    const swingActive = state.swingMode !== SWING_MODE.OFF;
    set('airco_swing', swingActive || louverPosition !== 'auto');
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
    this.log(`Device::onCapability(${capability}, ${JSON.stringify(value)})`);
    this._updatingState = true;

    try {
      this._setCapIfChanged(capability, value, true);
      this._lockCapability(capability);
      let state = await new GetStateCommand(this._device).execute();

      switch (capability) {
        case 'onoff': state.powerOn = value; break;
        case 'target_temperature': state.targetTemperature = value; break;
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
        case 'thermostat_boost': state.turboMode = !!value; break;
        case 'thermostat_eco': state.ecoMode = !!value; break;
        case 'thermostat_freeze_protection': state.freezeProtectionMode = !!value; break;
        case 'thermostat_fan_speed':
          if (value === 'auto') state.fanSpeed = state.operationalMode === OPERATIONAL_MODE.AUTO ? FAN_SPEED.FIXED : FAN_SPEED.AUTO;
          if (value === 'silent') state.fanSpeed = FAN_SPEED.SILENT;
          if (value === 'low') state.fanSpeed = FAN_SPEED.LOW;
          if (value === 'medium') state.fanSpeed = FAN_SPEED.MEDIUM;
          if (value === 'high') state.fanSpeed = FAN_SPEED.HIGH;
          if (value === 'full') state.fanSpeed = FAN_SPEED.FULL;
          break;
        case 'airco_swing': state.swingMode = value ? SWING_MODE.HORIZONTAL : SWING_MODE.OFF; break;
        case 'airco_louver': {
          const raw = LOUVER_VALUES[value] ?? 0;
          if (raw !== 0 && state.swingMode === SWING_MODE.OFF) state.swingMode = SWING_MODE.HORIZONTAL;
          await new SetPropertiesCommand(this._device, PROPERTY_ID.SWING_UD_ANGLE, raw).execute();
          break;
        }
        case 'ieco':
          await new SetIEcoCommand(this._device, !!value).execute();
          return;
        case 'jet_cool':
          await new SetJetCoolCommand(this._device, !!value).execute();
          return;
        case 'out_silent':
          await new SetOutSilentCommand(this._device, !!value).execute();
          return;
        case 'self_clean':
          await new SetSelfCleanCommand(this._device, !!value).execute();
          this._lockCapability('self_clean', 15000);
          return;
        case 'ion_mode': (state as any).anionMode = !!value; break;
        case 'follow_me': (state as any).followMe = !!value; break;
        default: return;
      }

      state = await new SetStateCommand(this._device, state).execute();
      this._updateState(state);
    } catch (error) {
      this.error(error);
      await this._refreshState();
      throw new Error(`Error during adjustment of settings from device [${this.getName()}]`);
    } finally {
      this._updatingState = false;
    }
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
    if (this._intervalId) this.homey.clearInterval(this._intervalId);
    if (this._energyIntervalId) this.homey.clearInterval(this._energyIntervalId);
  }
}

module.exports = MideaDevice;
