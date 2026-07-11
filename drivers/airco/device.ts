import Homey from 'homey';
import { Driver as MDriver, Device as MDevice, DeviceContext as MDeviceContext, GetStateCommand, DeviceState, LANSecurityContext, CloudSecurityContext,  SetStateCommand, _LOGGER } from 'midea-msmarthome-ac-euosk105';
import { SetIEcoCommand } from 'midea-msmarthome-ac-euosk105/dist/command/SetIEcoCommand';
import { GetIEcoCommand } from 'midea-msmarthome-ac-euosk105/dist/command/GetIEcoCommand';
import { SetJetCoolCommand } from 'midea-msmarthome-ac-euosk105/dist/command/SetJetCoolCommand';
import { GetJetCoolCommand } from 'midea-msmarthome-ac-euosk105/dist/command/GetJetCoolCommand';
import { SetOutSilentCommand } from 'midea-msmarthome-ac-euosk105/dist/command/SetOutSilentCommand';
import { GetOutSilentCommand } from 'midea-msmarthome-ac-euosk105/dist/command/GetOutSilentCommand';
import { GetPowerUsageCommand } from 'midea-msmarthome-ac-euosk105/dist/command/GetPowerUsageCommand';
import { GetGroup5Command } from 'midea-msmarthome-ac-euosk105/dist/command/GetGroup5Command';
import { SetPropertiesCommand, PROPERTY_ID } from 'midea-msmarthome-ac-euosk105/dist/command/SetPropertiesCommand';
import { FAN_SPEED, OPERATIONAL_MODE, SWING_MODE } from 'midea-msmarthome-ac-euosk105/dist/DeviceState';

// Mapping: 5 sichtbare Louver-Positionen -> SWING_ANGLE raw value (siehe Library)
const LOUVER_VALUES: { [key: string]: number } = {
  "auto": 0,
  "p1":   1,
  "p2":   25,
  "p3":   50,
  "p4":   75,
  "p5":   100,
};
function louverIdFromRaw(raw: number | undefined | null): string {
  if (raw === null || raw === undefined) return "auto";
  if (raw <= 0) return "auto";
  if (raw <= 12) return "p1";
  if (raw <= 37) return "p2";
  if (raw <= 62) return "p3";
  if (raw <= 87) return "p4";
  return "p5";
}

export class MideaDevice extends Homey.Device {
  public _device: MDevice;
  private _intervalId: any;
  private _updatingState: boolean = false;
  private _maximumFailureCount:number = 5;
  private _failureCount: number = 0;
  // Fan-Nachlauf-Steuerung (vermeidet Trigger-Loop)
  private _fanAfterCoolingTimer: any = null;
  private _fanAfterCoolingActive: boolean = false;
  private _lastOperationalMode: number | null = null;
  // Suppress automatic fan-aftercooling logic for the next onCapability call
  // (used when applying presets so cooling -> off via preset does not trigger fan-aftercooling)
  private _suppressFanAfter: boolean = false;
  // Energy-Polling (separates langsameres Intervall)
  private _energyIntervalId: any = null;
  private _energyPollingActive: boolean = false;
  // Auto-Discovery: nur einmal versuchen, Capabilities zu registrieren wenn echter Wert kommt
  private _capabilityProbed = { power: false, energy: false, humidity: false, defrost: false };
  // Last-Known-Value Tracking - verhindert Null-Reset wenn ein einzelner Poll fehlschlaegt
  private _lastValid = { realTimePower: null as number | null, totalEnergy: null as number | null, humidity: null as number | null };
  private _consecutiveEnergyFailures: number = 0;
  // External Thermostat
  private _externalRoomTemp: number | null = null;
  private _externalRoomTempTimestamp: number = 0;
  private _externalThermostatTimer: any = null;
  private _externalThermostatLastAction: number = 0;
  // Outlier-Filter fuer externe Temperatur (3 letzte Werte, Median)
  private _externalTempHistory: number[] = [];
  /** Zeitpunkt, seit dem die geglaettete externe Temperatur ueber der Hysterese liegt (fuer Mindest-Verweildauer). */
  private _externalConsistentSince: number = 0;
  private _lastSwingResyncAt: number = 0;
  /** Letzte Richtung (+1=zu warm, -1=zu kalt, 0=innerhalb Hysterese) fuer Verweildauer-Reset bei Richtungswechsel. */
  private _externalLastDirection: number = 0;
  // Lock-Window: kurz nach manueller Bedienung wird das naechste Poll-Update fuer die betreffende Capability ignoriert
  // (verhindert UI-Flicker durch verzoegerte AC-Antwort)
  private _capabilityLockedUntil: { [cap: string]: number } = {};
  
  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Midea AC [' + this.getName() + '] initializing ...');
    this._failureCount = 0;

    try {
      const deviceContext: MDeviceContext = new MDeviceContext();
      deviceContext.id = this.getData().id;
      deviceContext.macAddress = this.getData().macAddress;
      deviceContext.udpId = this.getData().udpId;
      deviceContext.host = this.getStore().host;
      deviceContext.port = this.getStore().port;
      this._device = new MDevice(deviceContext);

      // RETRIEVE TOKEN AND KEY FROM USERNAME PASSWORD IF NOT ADDED DURING PAIRING
      if (!this.getStore().token || !this.getStore().key) {
        let cloudSecurityContext: CloudSecurityContext =  new CloudSecurityContext(this.getStore().username, this.getStore().password);
        let lanSecurityContext: LANSecurityContext = await MDriver.retrieveTokenAndKeyFromCloud(this._device, cloudSecurityContext);
        this.setStoreValue("token",  lanSecurityContext.token);
        this.setStoreValue("key",  lanSecurityContext.key);
      }
      await this._device.authenticate(new LANSecurityContext(this.getStore().token, this.getStore().key));

      // REGISTER CAPABILITY LISTENERS
      this.registerCapabilityListener("onoff", async (value, opts) => { return this.onCapability("onoff", value, opts); });
      this.registerCapabilityListener("target_temperature", async (value, opts) => { return this.onCapability("target_temperature", value, opts); });
      this.registerCapabilityListener("thermostat_mode", async (value, opts) => { return this.onCapability("thermostat_mode", value, opts); });
      this.registerCapabilityListener("thermostat_boost", async (value, opts) => { return this.onCapability("thermostat_boost", value, opts); });
      this.registerCapabilityListener("thermostat_fan_speed", async (value, opts) => { return this.onCapability("thermostat_fan_speed", value, opts); });
      // thermostat_swing_mode wurde durch airco_swing/airco_louver ersetzt - nur registrieren falls noch vorhanden (Bestandsgeraet vor Remove)
      if (this.hasCapability("thermostat_swing_mode")) {
        this.registerCapabilityListener("thermostat_swing_mode", async (value, opts) => { return this.onCapability("thermostat_swing_mode", value, opts); });
      }
      this.registerCapabilityListener("thermostat_eco", async (value, opts) => { return this.onCapability("thermostat_eco", value, opts); });
      this.registerCapabilityListener("thermostat_freeze_protection", async (value, opts) => { return this.onCapability("thermostat_freeze_protection", value, opts); });
      if (this.hasCapability("ieco"))       this.registerCapabilityListener("ieco",       async (value, opts) => { return this.onCapability("ieco",       value, opts); });
      if (this.hasCapability("ion_mode"))   this.registerCapabilityListener("ion_mode",   async (value, opts) => { return this.onCapability("ion_mode",   value, opts); });
      if (this.hasCapability("jet_cool"))   this.registerCapabilityListener("jet_cool",   async (value, opts) => { return this.onCapability("jet_cool",   value, opts); });
      if (this.hasCapability("out_silent")) this.registerCapabilityListener("out_silent", async (value, opts) => { return this.onCapability("out_silent", value, opts); });
      if (this.hasCapability("follow_me")) this.registerCapabilityListener("follow_me", async (value, opts) => { return this.onCapability("follow_me", value, opts); });
      if (this.hasCapability("airco_swing"))  this.registerCapabilityListener("airco_swing",  async (value, opts) => { return this.onCapability("airco_swing",  value, opts); });
      if (this.hasCapability("airco_louver")) this.registerCapabilityListener("airco_louver", async (value, opts) => { return this.onCapability("airco_louver", value, opts); });
      // Bestandsgeraete: neue Capabilities ggf. nachregistrieren
      if (!this.hasCapability("ieco"))       { await this.addCapability("ieco");       this.registerCapabilityListener("ieco",       async (value, opts) => { return this.onCapability("ieco",       value, opts); }); }
      if (!this.hasCapability("ion_mode"))   { await this.addCapability("ion_mode");   this.registerCapabilityListener("ion_mode",   async (value, opts) => { return this.onCapability("ion_mode",   value, opts); }); }
      if (!this.hasCapability("jet_cool"))   { await this.addCapability("jet_cool");   this.registerCapabilityListener("jet_cool",   async (value, opts) => { return this.onCapability("jet_cool",   value, opts); }); }
      if (!this.hasCapability("out_silent")) { await this.addCapability("out_silent"); this.registerCapabilityListener("out_silent", async (value, opts) => { return this.onCapability("out_silent", value, opts); }); }
      if (!this.hasCapability("follow_me"))  { await this.addCapability("follow_me");  this.registerCapabilityListener("follow_me",  async (value, opts) => { return this.onCapability("follow_me",  value, opts); }); }
      if (!this.hasCapability("airco_swing"))  { await this.addCapability("airco_swing");  this.registerCapabilityListener("airco_swing",  async (value, opts) => { return this.onCapability("airco_swing",  value, opts); }); }
      if (!this.hasCapability("airco_louver")) { await this.addCapability("airco_louver"); this.registerCapabilityListener("airco_louver", async (value, opts) => { return this.onCapability("airco_louver", value, opts); }); }
      // Alte Swing-Mode Picker-Capability bei Bestandsgeraeten entfernen
      if (this.hasCapability("thermostat_swing_mode")) {
        await this.removeCapability("thermostat_swing_mode").catch(e => this.log("removeCapability thermostat_swing_mode: " + e));
      }


      // INITIALLY UPDATE STATE AND SET DEVICE TO AVAILABLE
      await this._refreshState();
      this.setAvailable();       

      // INITIALIZE POLLING
      const settings = this.getSettings();
      this._maximumFailureCount = +settings.max_number_of_errors_before_device_unavailable;
      this._initializePolling(settings.polling_interval);
      // Energy-Polling separat (default 60s, langsamer als Hauptpolling)
      const energyInterval = (typeof settings.poll_energy_interval === "number" && settings.poll_energy_interval > 0)
        ? settings.poll_energy_interval
        : 60;
      this._initializeEnergyPolling(energyInterval);

      this.log('Midea AC [' + this.getName() + '] initialized successfully'); 
    } catch (err) {
      this.error("Cannot initialize device[" + this.getName() + "]: " + (err instanceof Error ? err.message : JSON.stringify(err)));
      this.setUnavailable("Cannot initialize device[" + this.getName() + "]: " + (err instanceof Error ? err.message : JSON.stringify(err)));
    }
  }

  private _initializePolling(pollingInterval: number) {
    // CLEAR POLLING
    if (this._intervalId) this.homey.clearInterval(this._intervalId);

    // SET POLLER
    this._intervalId = this.homey.setInterval(async () => {
      try {
        await this._refreshState();
      } catch (err) {
        this.homey.clearInterval(this._intervalId);
        this.error("Error during polling: " + (err instanceof Error ? err.message : JSON.stringify(err)));
        this.setUnavailable("Device [" + this.getName() + "] is unavailable; failure count: " + this._failureCount);
      }
    }, pollingInterval * 1000);
  }

  /**
   * Separates Polling fuer Stromverbrauch + Group5-Sensoren (Humidity/Defrost).
   * Default 60s, langsamer als Hauptpolling - schont AC und reduziert Frame-Last.
   */
  private _initializeEnergyPolling(intervalSeconds: number) {
    if (this._energyIntervalId) this.homey.clearInterval(this._energyIntervalId);
    if (!intervalSeconds || intervalSeconds <= 0) {
      this.log("Energy-Polling deaktiviert");
      return;
    }
    this.homey.setTimeout(() => this._pollEnergyAndGroup5().catch(e => this.log("Initial Energy-Poll fehlgeschlagen: " + e)), 3000);
    this._energyIntervalId = this.homey.setInterval(async () => {
      try { await this._pollEnergyAndGroup5(); }
      catch (err) { this.log("Energy-Poll-Fehler (nicht-kritisch): " + (err instanceof Error ? err.message : JSON.stringify(err))); }
    }, intervalSeconds * 1000);
    this.log("Energy-Polling alle " + intervalSeconds + "s aktiv");
  }

  /**
   * Holt Stromverbrauch (0x44-Frame) + Group5-Sensoren (0x45-Frame).
   * Registriert Capabilities erst nach erfolgreichem Poll mit echten Werten (Auto-Discovery).
   */
  private async _pollEnergyAndGroup5(): Promise<void> {
    if (this._energyPollingActive) { this.log("Energy-Poll laeuft bereits, ueberspringe"); return; }
    this._energyPollingActive = true;
    let anySuccess = false;
    try {
      // ----- POWER / ENERGY -----
      try {
        const energy: any = await new GetPowerUsageCommand(this._device).execute();
        if (energy) {
          // realTimePower: 0..20000 W
          if (Number.isFinite(energy.realTimePower) && energy.realTimePower >= 0 && energy.realTimePower <= 20000) {
            this._lastValid.realTimePower = energy.realTimePower;
            if (!this._capabilityProbed.power) {
              this._capabilityProbed.power = true;
              if (!this.hasCapability("measure_power")) await this.addCapability("measure_power").catch(e => this.error("add measure_power: " + e));
            }
            this._setCapIfChanged("measure_power", energy.realTimePower);
            anySuccess = true;
          }
          // totalEnergy: 0..1Mio kWh + Monotonie (darf nicht sinken)
          if (Number.isFinite(energy.totalEnergy) && energy.totalEnergy > 0 && energy.totalEnergy < 1000000) {
            const last = this._lastValid.totalEnergy;
            // Akzeptiere nur wenn >= letzter Wert (kleine Toleranz fuer Rundung)
            if (last === null || energy.totalEnergy >= last - 0.01) {
              this._lastValid.totalEnergy = energy.totalEnergy;
              if (!this._capabilityProbed.energy) {
                this._capabilityProbed.energy = true;
                if (!this.hasCapability("meter_power")) await this.addCapability("meter_power").catch(e => this.error("add meter_power: " + e));
              }
              this._setCapIfChanged("meter_power", energy.totalEnergy);
              anySuccess = true;
            } else {
              this.log("Energy-Wert sinkt unplausibel (" + last + " -> " + energy.totalEnergy + "), ignoriere");
            }
          }
        }
      } catch (e) { this.log("Energy-Poll fehlgeschlagen: " + (e instanceof Error ? e.message : e)); }

      // ----- GROUP 5 (Humidity / Defrost) -----
      try {
        const g5: any = await new GetGroup5Command(this._device).execute();
        if (g5) {
          // humidity: 1..100 %
          if (Number.isFinite(g5.humidity) && g5.humidity >= 1 && g5.humidity <= 100) {
            this._lastValid.humidity = g5.humidity;
            if (!this._capabilityProbed.humidity) {
              this._capabilityProbed.humidity = true;
              if (!this.hasCapability("measure_humidity")) await this.addCapability("measure_humidity").catch(e => this.error("add measure_humidity: " + e));
            }
            this._setCapIfChanged("measure_humidity", g5.humidity);
            anySuccess = true;
          }
          // Defrost: Capability erst registrieren wenn EINMAL true kam (sonst falsche Sensor-Anzeige)
          if (g5.defrostMode === true) {
            if (!this._capabilityProbed.defrost) {
              this._capabilityProbed.defrost = true;
              if (!this.hasCapability("alarm_defrost")) await this.addCapability("alarm_defrost").catch(e => this.error("add alarm_defrost: " + e));
            }
            this._setCapIfChanged("alarm_defrost", true);
            anySuccess = true;
          } else if (g5.defrostMode === false && this._capabilityProbed.defrost) {
            this._setCapIfChanged("alarm_defrost", false);
            anySuccess = true;
          }
        }
      } catch (e) { this.log("Group5-Poll fehlgeschlagen: " + (e instanceof Error ? e.message : e)); }

      // Failure-Counter: warnen wenn 5x in Folge nichts kam (aber Capabilities NICHT auf null setzen)
      if (anySuccess) {
        this._consecutiveEnergyFailures = 0;
      } else {
        this._consecutiveEnergyFailures++;
        if (this._consecutiveEnergyFailures === 5) {
          this.log("Warnung: 5 aufeinanderfolgende Energy/G5-Polls ohne gueltige Daten - Werte werden eingefroren");
        }
      }
    } finally { this._energyPollingActive = false; }
  }

  /**
   * _refreshState is called when the device state has to be updated.
   */
  private async _refreshState() {
    if (this._updatingState) {
      this.log("Skipping state refresh because another update is in progress");
      return;
    }

    try {
      // EXECUTE THE GETSTATECOMMAND TO RETREIVE THE STATE AND REFRESH HOMEY'S DEVICE STATE
      const state: DeviceState = await new GetStateCommand(this._device).execute();
      // ZUSAETZLICH B5-Properties separat abfragen (eigene Frames)
      let iEcoState: boolean | null = null;
      let jetCoolState: boolean | null = null;
      let outSilentState: boolean | null = null;
      try { iEcoState      = await new GetIEcoCommand(this._device).execute(); }
      catch (e) { this.log("iECO-Property nicht abrufbar: " + (e instanceof Error ? e.message : e)); }
      try { jetCoolState   = await new GetJetCoolCommand(this._device).execute(); }
      catch (e) { this.log("JetCool-Property nicht abrufbar: " + (e instanceof Error ? e.message : e)); }
      try { outSilentState = await new GetOutSilentCommand(this._device).execute(); }
      catch (e) { this.log("OutSilent-Property nicht abrufbar: " + (e instanceof Error ? e.message : e)); }
      this._updateState(state, iEcoState, jetCoolState, outSilentState);

      // AT THS STAGE REFRESHING HAS BEEN SUCCESFUL, WHICH RESETS THE FAILURE COUNT
      this._failureCount = 0;
    } catch (err) {
      // AN ERROR HAS OCCURED; INCREASE FAILURE COUNT AND CHECK IF THE MAXIMUM NUMBER OF ERRORS HAS BEEN REACHED
      // IF SO, STOP POLLING AND SET DEVICE UNAVAILABLE ELSE, LOG THE ERROR AND RETRY
      this._failureCount++;   
      this.error("Error during polling of device [" + this.getName() + "]; failure count = " + this._failureCount + " : " + (err instanceof Error ? err.message : JSON.stringify(err)));
      if (this._failureCount < this._maximumFailureCount) {
        this.log("Retrying");
      } else { 
        throw new Error("Device [" + this.getName() + "] is failing multiple times; failure count: " + this._failureCount);
      }
    }
  }

  /**
   * _updateState is called when the device state has been retreived ia the local API and the Homey's device state needs to be updated.
   * @param {DeviceState} state The new state
   */
  private _updateState(state: DeviceState, iEcoState: boolean | null = null, jetCoolState: boolean | null = null, outSilentState: boolean | null = null) {
    // Fan-Nachlauf: _lastOperationalMode auch beim Poll aktualisieren (nicht nur bei onCapability)
    // Wichtig damit Auto-Nachlauf auch nach App-Neustart funktioniert
    if (state.powerOn) this._lastOperationalMode = state.operationalMode;
    this.log("state = " + JSON.stringify(state) + ")");
    const set = (cap: string, val: any) => this._setCapIfChanged(cap, val);
    set("onoff", state.powerOn);
    if (state.powerOn) {
      switch (state.operationalMode) {
        case OPERATIONAL_MODE.AUTO: set("thermostat_mode", "auto"); break;
        case OPERATIONAL_MODE.COOL: set("thermostat_mode", "cool"); break;
        case OPERATIONAL_MODE.HEAT: set("thermostat_mode", "heat"); break;
        case OPERATIONAL_MODE.DRY: set("thermostat_mode", "dry"); break;
        case OPERATIONAL_MODE.FAN: set("thermostat_mode", "fan"); break;
      }
    } else {
      set("thermostat_mode", "off");
    }
    set("thermostat_boost", state.turboMode);
    if (state.operationalMode == OPERATIONAL_MODE.FAN) {
      set("target_temperature", state.indoorTemperature);
    } else {
      set("target_temperature", state.targetTemperature);
    }
    set("measure_temperature", state.indoorTemperature);
    if (state.outdoorTemperature != null && state.outdoorTemperature < 60) {
      set("measure_temperature.outside", state.outdoorTemperature);
    } else {
      this.log("Ignoring invalid outdoor temperature:", state.outdoorTemperature);
    }
    switch (state.fanSpeed) {
      case FAN_SPEED.AUTO: set("thermostat_fan_speed", "auto"); break;
      case FAN_SPEED.FIXED: set("thermostat_fan_speed", "auto"); break;
      case FAN_SPEED.SILENT: set("thermostat_fan_speed", "silent"); break;
      case FAN_SPEED.LOW: set("thermostat_fan_speed", "low"); break;
      case FAN_SPEED.MEDIUM: set("thermostat_fan_speed", "medium"); break;
      case FAN_SPEED.HIGH: set("thermostat_fan_speed", "high"); break;
      case FAN_SPEED.FULL: set("thermostat_fan_speed", "full"); break;
    }
    // PortaSplit: swingMode != OFF -> Oszillation an; Louver-Position aus verticalSwingAngle ableiten
    // Wichtig: wenn Louver != auto ist, MUSS swing dauerhaft an bleiben (sonst faehrt Lamelle nicht in Position).
    // Falls das Geraet swingMode zurueckgesetzt hat, aber User Louver-Position gewaehlt hat, resynchronisieren wir.
    const louverPos = louverIdFromRaw((state as any).verticalSwingAngle);
    const swingActive = state.swingMode !== SWING_MODE.OFF;
    if (louverPos !== "auto" && !swingActive) {
      // Louver ist aktiv gesetzt, aber Geraet meldet swing=off - resync noetig
      this.log("Swing-Resync: Louver=" + louverPos + " aber swingMode=OFF, sende swingMode=HORIZONTAL");
      // Best-effort re-arm ohne await (in Poll-Kontext)
      this._resyncSwingIfNeeded().catch(e => this.error("Swing-Resync fehlgeschlagen: " + e));
      set("airco_swing", true); // UI trotzdem als aktiv anzeigen
    } else {
      set("airco_swing", swingActive);
    }
    set("airco_louver", louverPos);
    set("thermostat_eco", state.ecoMode);
    set("thermostat_freeze_protection", state.freezeProtectionMode);
    set("ion_mode", (state as any).anionMode === true);
    if ((state as any).followMe === true || (state as any).followMe === false) {
      set("follow_me", (state as any).followMe === true);
    }
    if (iEcoState !== null)     set("ieco", iEcoState);
    if (jetCoolState !== null)  set("jet_cool", jetCoolState);
    if (outSilentState !== null) set("out_silent", outSilentState);
  }


  /** Wird aufgerufen wenn Louver aktiv ist aber Geraet swingMode=OFF meldet.
   *  Sendet SetStateCommand mit swingMode=HORIZONTAL um Sync herzustellen. */
  private async _resyncSwingIfNeeded(): Promise<void> {
    // Rate-Limit: max 1x pro Minute damit wir nicht in Loops laufen
    const now = Date.now();
    if (this._lastSwingResyncAt && now - this._lastSwingResyncAt < 60000) return;
    this._lastSwingResyncAt = now;
    if (this._updatingState) return; // laeuft grade eine onCapability
    try {
      const st = await new GetStateCommand(this._device).execute();
      if ((st as any).verticalSwingAngle && (st as any).verticalSwingAngle !== 0 && st.swingMode === SWING_MODE.OFF) {
        st.swingMode = SWING_MODE.HORIZONTAL;
        const nst = await new SetStateCommand(this._device, st).execute();
        this._updateState(nst);
        this.log("Swing-Resync erfolgreich - swingMode=HORIZONTAL gesetzt");
      }
    } catch (e) {
      this.error("Swing-Resync-Fehler: " + (e instanceof Error ? e.message : e));
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Midea AC [' + this.getName() + '] has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {

    if (changedKeys.includes("polling_interval")) {
      this._initializePolling(+newSettings.polling_interval);
    }
    if (changedKeys.includes("debug_level")) {
      _LOGGER.level = newSettings.debug_level.toString();
    }
    if (changedKeys.includes("max_number_of_errors_before_device_unavailable")) {
      this._maximumFailureCount = +newSettings.max_number_of_errors_before_device_unavailable;
      this.onInit();
    }
    if (changedKeys.includes("poll_energy_interval")) {
      const v = (typeof newSettings.poll_energy_interval === "number" && +newSettings.poll_energy_interval > 0) ? +newSettings.poll_energy_interval : 60;
      this._initializeEnergyPolling(v);
    }
    if (changedKeys.includes("ext_thermostat_enabled") && !newSettings.ext_thermostat_enabled) {
      // Bei Deaktivierung: External-State zuruecksetzen
      this._externalRoomTemp = null;
      this._externalRoomTempTimestamp = 0;
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('Midea AC [' + this.getName() + '] was renamed to "' + name + '"');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.homey.clearInterval(this._intervalId);
    if (this._energyIntervalId) this.homey.clearInterval(this._energyIntervalId);
    if (this._externalThermostatTimer) this.homey.clearTimeout(this._externalThermostatTimer);
    this.log('Midea AC [' + this.getName() + '] has been deleted');
  }

  /**
   * Setzt eine Capability nur dann, wenn sich der Wert tatsaechlich aendert.
   * Vermeidet UI-Flicker durch redundante Updates.
   */
  private _setCapIfChanged(capability: string, value: any, force: boolean = false): boolean {
    if (!this.hasCapability(capability)) return false;
    // Lock-Window: 5s nach manueller Bedienung dieser Cap werden Poll-Overrides ignoriert
    if (!force) {
      const lockUntil = this._capabilityLockedUntil[capability];
      if (lockUntil && Date.now() < lockUntil) return false;
    }
    const current = this.getCapabilityValue(capability);
    if (current === value) return false;
    this.setCapabilityValue(capability, value).catch(e => this.error(e));
    return true;
  }
  /** Sperrt eine Capability fuer ms Millisekunden vor Poll-Overrides */
  private _lockCapability(capability: string, ms: number = 5000) {
    this._capabilityLockedUntil[capability] = Date.now() + ms;
  }

  /**
   * Optimistic Mutex-Helper: setzt einen anderen Capability auf false (lokal + per B5-Command
   * wenn noetig), aber nur falls noetig - kein Refresh-Loop, keine Race.
   */
  private async _disableForMutex(capability: string) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) !== true) return;
    this._setCapIfChanged(capability, false);
    try {
      if (capability === "ieco") await new SetIEcoCommand(this._device, false).execute();
      else if (capability === "jet_cool") await new SetJetCoolCommand(this._device, false).execute();
    } catch (e) { this.error("Mutex-Disable " + capability + " fehlgeschlagen: " + e); }
  }

  async onCapability(capability: string, value: any, opts: any) {
    this.log("Device::onCapability(capability='" + capability + "', value='", value, "')");
    try {
      this._updatingState = true;
      // Optimistic update: UI sofort auf Zielwert (force=true, ignoriert Lock) + Lock-Window setzen
      this._setCapIfChanged(capability, value, true);
      this._lockCapability(capability, 5000);
      let state: DeviceState = await new GetStateCommand(this._device).execute();

      switch (capability) {
        case "onoff": state.powerOn = value; break;
        case "target_temperature": state.targetTemperature = value; break;
        case "thermostat_mode": {
          switch (value) {
            case "auto": state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.AUTO; break;
            case "cool": state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.COOL; break;
            case "heat": state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.HEAT; break;
            case "dry": state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.DRY; break;
            case "fan": state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.FAN; break;
            case "off": state.powerOn = false; break; /* this behaves exactly the same as the onoff button */
            default:
              this.log("Value '" + value + "' for capability 'thermostat_mode' does not exist");
              break;
          }
          break;
        }
        case "thermostat_boost":  {
          if (value) {
            state.ecoMode = false; this._setCapIfChanged("thermostat_eco", false);
            state.freezeProtectionMode = false; this._setCapIfChanged("thermostat_freeze_protection", false);
            await this._disableForMutex("ieco");
            await this._disableForMutex("jet_cool");
          }
          state.turboMode = value; break;
        }
        case "thermostat_eco": {
          if (value) {
            state.operationalMode = OPERATIONAL_MODE.COOL;
            this._setCapIfChanged("thermostat_mode", "cool");
            state.turboMode = false; this._setCapIfChanged("thermostat_boost", false);
            state.freezeProtectionMode = false; this._setCapIfChanged("thermostat_freeze_protection", false);
            await this._disableForMutex("ieco");
            await this._disableForMutex("jet_cool");
          }
          state.ecoMode = value;
          break;
        }
        case "thermostat_freeze_protection": {
          if (value) {
            state.operationalMode = OPERATIONAL_MODE.HEAT;
            this._setCapIfChanged("thermostat_mode", "heat");
            state.ecoMode = false; this._setCapIfChanged("thermostat_eco", false);
            state.turboMode = false; this._setCapIfChanged("thermostat_boost", false);
            await this._disableForMutex("ieco");
            await this._disableForMutex("jet_cool");
          }
          state.freezeProtectionMode = value;
          break;
        }
        case "thermostat_fan_speed": {
          switch (value) {
            case "auto": {
              if (state.operationalMode == OPERATIONAL_MODE.AUTO) {
                state.fanSpeed = FAN_SPEED.FIXED; /* this is the default setting when thermostat_mode in 'auto' */
              } else {
                state.fanSpeed = FAN_SPEED.AUTO; /* only available in thermostat_mode 'heat' or 'cool' */
              }
              break;
            }
            case "silent": state.fanSpeed = FAN_SPEED.SILENT; break;
            case "low": state.fanSpeed = FAN_SPEED.LOW; break;
            case "medium": state.fanSpeed = FAN_SPEED.MEDIUM; break;
            case "high": state.fanSpeed = FAN_SPEED.HIGH; break;
            case "full": state.fanSpeed = FAN_SPEED.FULL; break;
            default:
              this.log("Value '" + value + "' for capability 'thermostat_fan_speed' does not exist");
              break;
          }
          break;
        }
        case "airco_swing": {
          // PortaSplit: Horizontal-Oszillation an/aus
          state.swingMode = value ? SWING_MODE.HORIZONTAL : SWING_MODE.OFF;
          // Laengeres Lock (15s) damit Polls den User-Wunsch nicht zu frueh ueberschreiben
          this._lockCapability("airco_swing", 15000);
          break;
        }
        case "airco_louver": {
          // PortaSplit: vertikaler Lamellenwinkel (Tilt/Ausfahren) via PROPERTY 0x09
          const raw = LOUVER_VALUES[value] !== undefined ? LOUVER_VALUES[value] : 0;
          // Wenn Louver-Position != auto (0), muss swingMode aktiv sein damit die AC die Position anfaehrt.
          // Bei "auto" schalten wir Swing NICHT automatisch aus - user-Wille zaehlt.
          if (raw !== 0 && state.swingMode === SWING_MODE.OFF) {
            state.swingMode = SWING_MODE.HORIZONTAL;
            this._setCapIfChanged("airco_swing", true, true);
            this._lockCapability("airco_swing", 15000);
          }
          try {
            await new SetPropertiesCommand(this._device, PROPERTY_ID.SWING_UD_ANGLE, raw).execute();
            (state as any).verticalSwingAngle = raw;
            // Lock verticalSwingAngle-basierte Cap fuer laengere Zeit
            this._lockCapability("airco_louver", 15000);
          } catch (e) { this.error("airco_louver set failed: " + (e instanceof Error ? e.message : e)); }
          // Fall through - SetStateCommand danach setzt swingMode auf Geraet
          break;
        }
        case "ieco": {
          if (value) {
            // Mutex-Aenderungen muessen im 0x40-Frame mitgeschrieben werden, sonst springt
            // die UI nach dem naechsten Polling-Refresh zurueck.
            state.turboMode = false; this._setCapIfChanged("thermostat_boost", false);
            state.freezeProtectionMode = false; this._setCapIfChanged("thermostat_freeze_protection", false);
            state.ecoMode = false; this._setCapIfChanged("thermostat_eco", false);
            await this._disableForMutex("jet_cool");
            try { await new SetStateCommand(this._device, state).execute(); } catch (e) { this.error(e); }
          }
          // iECO ueber eigenes B5-Property 0x00E3
          await new SetIEcoCommand(this._device, !!value).execute();
          this._updatingState = false;
          return;
        }
        case "ion_mode": {
          // Ion ist unabhaengig - kein Konflikt mit anderen Modi
          (state as any).anionMode = !!value;
          break;
        }
        case "jet_cool": {
          if (value) {
            state.turboMode = false; this._setCapIfChanged("thermostat_boost", false);
            state.ecoMode = false; this._setCapIfChanged("thermostat_eco", false);
            state.freezeProtectionMode = false; this._setCapIfChanged("thermostat_freeze_protection", false);
            await this._disableForMutex("ieco");
            try { await new SetStateCommand(this._device, state).execute(); } catch (e) { this.error(e); }
          }
          await new SetJetCoolCommand(this._device, !!value).execute();
          this._updatingState = false;
          return;
        }
        case "out_silent": {
          await new SetOutSilentCommand(this._device, !!value).execute();
          this._updatingState = false;
          return;
        }
        case "follow_me": {
          (state as any).followMe = !!value;
          break;
        }
        default:
          this.log("Capability '" + capability + "' does not exist");
          break;
      }

      state = await new SetStateCommand(this._device, state).execute();
      this._updateState(state);

      // Fan-Nachlauf-Trigger: wenn AC von COOL auf AUS geht und Setting aktiv ist.
      // Kein Loop dank _suppressFanAfter. _lastOperationalMode wurde vor SetStateCommand gesetzt (GetStateCommand + _updateState).
      const goingOff =
        (capability === "onoff" && value === false) ||
        (capability === "thermostat_mode" && value === "off");
      if (goingOff && !this._suppressFanAfter) {
        // Robust: sowohl Instance-Var als auch aktuelle Capability pruefen
        const wasCooling =
          this._lastOperationalMode === OPERATIONAL_MODE.COOL ||
          this.getCapabilityValue("thermostat_mode") === "cool";
        this.log("Off-Trigger: wasCooling=" + wasCooling + " (lastOpMode=" + this._lastOperationalMode + ")");
        if (wasCooling) this._scheduleFanAfterCooling();
      }
      this._lastOperationalMode = state.powerOn ? state.operationalMode : null;
      this._suppressFanAfter = false;
    } catch(err) {
      this.error(err);
      await this._refreshState(); // Revert UI to correct state
      throw new Error("Error during adjustment of settings from device [" + this.getName() + "]"); 
    } finally {
      this._updatingState = false;
    }
  }

  /**
   * Preset-Definitionen: Standardwerte, koennen via Device-Settings (presets_json) ueberschrieben werden.
   */
  private _getDefaultPresets(): { [key: string]: any } {
    return {
      cooling_home:  { mode: "cool", temp: 23, fan: "auto",   eco: false, ieco: true,  boost: false },
      cooling_away:  { mode: "cool", temp: 26, fan: "silent", eco: true,  ieco: true,  boost: false },
      cooling_night: { mode: "cool", temp: 24, fan: "silent", out_silent: true, eco: false, ieco: true },
      heating_home:  { mode: "heat", temp: 21, fan: "auto",   eco: false, boost: false },
      heating_away:  { mode: "heat", temp: 17, fan: "low",    eco: false, boost: false },
      fan_only:      { mode: "fan",  fan: "medium" },
      off:           { mode: "off" }
    };
  }

  private _getPresets(): { [key: string]: any } {
    const defaults = this._getDefaultPresets();
    const raw = this.getSetting("presets_json");
    if (typeof raw === "string" && raw.trim().length > 0) {
      try {
        const custom = JSON.parse(raw);
        return Object.assign({}, defaults, custom);
      } catch (e) {
        this.error("presets_json ungueltig, nutze Defaults: " + (e instanceof Error ? e.message : e));
      }
    }
    return defaults;
  }

  /**
   * Wendet ein Preset an - nutzt onCapability, daher gelten alle Mutex-Regeln automatisch.
   */
  public async applyPreset(presetId: string): Promise<void> {
    const presets = this._getPresets();
    const preset = presets[presetId];
    if (!preset) {
      throw new Error("Preset '" + presetId + "' nicht definiert");
    }
    this.log("Wende Preset '" + presetId + "' an: " + JSON.stringify(preset));
    this._suppressFanAfter = true;

    if (preset.mode === "off") {
      await this.onCapability("onoff", false, null);
      this._suppressFanAfter = false;
      return;
    }
    if (preset.mode) {
      await this.onCapability("thermostat_mode", preset.mode, null);
    }
    if (typeof preset.temp === "number" && preset.mode !== "fan") {
      await this.onCapability("target_temperature", preset.temp, null);
    }
    if (preset.fan) {
      await this.onCapability("thermostat_fan_speed", preset.fan, null);
    }
    if (preset.swing !== undefined) {
      // Backward-Compat: alte Preset-Werte ("off"/"horizontal"/etc.) auf neuen airco_swing boolean mappen
      const wantOn = preset.swing === true || (typeof preset.swing === "string" && preset.swing !== "off");
      if (this.hasCapability("airco_swing")) await this.onCapability("airco_swing", wantOn, null);
    }
    if (preset.louver !== undefined && this.hasCapability("airco_louver")) {
      await this.onCapability("airco_louver", preset.louver, null);
    }
    if (preset.boost !== undefined) await this.onCapability("thermostat_boost", !!preset.boost, null);
    if (preset.eco !== undefined)   await this.onCapability("thermostat_eco", !!preset.eco, null);
    if (preset.freeze !== undefined) await this.onCapability("thermostat_freeze_protection", !!preset.freeze, null);
    if (preset.ieco !== undefined && this.hasCapability("ieco")) await this.onCapability("ieco", !!preset.ieco, null);
    if (preset.jet_cool !== undefined && this.hasCapability("jet_cool")) await this.onCapability("jet_cool", !!preset.jet_cool, null);
    if (preset.out_silent !== undefined && this.hasCapability("out_silent")) await this.onCapability("out_silent", !!preset.out_silent, null);
    if (preset.ion !== undefined && this.hasCapability("ion_mode")) await this.onCapability("ion_mode", !!preset.ion, null);

    this._suppressFanAfter = false;
  }

  /**
   * Fan-Nachlauf nach beendetem Cooling-Lauf: startet Fan-Modus fuer X Minuten und schaltet
   * danach automatisch aus. Vermeidet Schimmel/Restfeuchte im Innengeraet.
   * Kein Loop: interner Flag + _suppressFanAfter beim eigenen Off.
   */
  private _scheduleFanAfterCooling() {
    const enabled = this.getSetting("fan_aftercooling_enabled");
    if (!enabled) return;
    const minutesRaw = this.getSetting("fan_aftercooling_minutes");
    const minutes = (typeof minutesRaw === "number" && minutesRaw > 0) ? minutesRaw : 30;
    const fanSpeedSetting = this.getSetting("fan_aftercooling_speed") || "low";
    // Auto-Trigger nach Cool->Off: AC ist bereits aus
    this.runFanAftercooling(minutes, fanSpeedSetting, true).catch((e) =>
      this.error("Auto-Fan-Nachlauf fehlgeschlagen: " + (e instanceof Error ? e.message : e))
    );
  }

  /**
   * Oeffentliche Methode fuer Flow-Action "Luefter-Nachlauf starten".
   * Schaltet die AC in den Fan-Modus, laesst sie 'minutes' Minuten laufen und schaltet dann aus.
   * Wenn die AC gerade kuehlt/heizt, wird sie zuerst in Fan umgeschaltet.
   *
   * @param minutes Dauer in Minuten (>0)
   * @param speed   silent|low|medium|high|auto
   * @param acAlreadyOff true wenn AC bereits aus (Auto-Trigger), false wenn manuell via Flow.
   */
  public async runFanAftercooling(minutes: number, speed: string, acAlreadyOff: boolean = false): Promise<void> {
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error("Ungueltige Dauer fuer Fan-Nachlauf: " + minutes);
    }
    const validSpeeds = ["silent", "low", "medium", "high", "auto"];
    if (!validSpeeds.includes(speed)) {
      this.log("Ungueltige Speed '" + speed + "', nutze 'low'");
      speed = "low";
    }

    if (this._fanAfterCoolingActive) {
      this.log("Fan-Nachlauf laeuft bereits - breche alten ab und starte neu");
      this.cancelFanAftercooling();
    }

    this.log("Starte Fan-Nachlauf: " + minutes + " Min, Speed=" + speed + ", acAlreadyOff=" + acAlreadyOff);
    this._fanAfterCoolingActive = true;

    // Auto-Trigger: 5s warten (AC braucht Zeit zum Herunterfahren + Netzwerk-Reconnect), manuell: sofort
    const startDelayMs = acAlreadyOff ? 5000 : 0;

    this.homey.setTimeout(async () => {
      try {
        if (acAlreadyOff && this.getCapabilityValue("onoff") === true) {
          this.log("Fan-Nachlauf abgebrochen - User hat Geraet manuell eingeschaltet");
          this._fanAfterCoolingActive = false;
          return;
        }
        this._suppressFanAfter = true;

        // Robuste Sequenz: einzelne SetStateCommand statt 3x onCapability
        // Wichtig: Retry beim ersten On-Kommando, weil AC nach Off gerade Reconnect macht
        const doStart = async (): Promise<void> => {
          const st: DeviceState = await new GetStateCommand(this._device).execute();
          st.powerOn = true;
          st.operationalMode = OPERATIONAL_MODE.FAN;
          switch (speed) {
            case "silent": st.fanSpeed = FAN_SPEED.SILENT; break;
            case "low":    st.fanSpeed = FAN_SPEED.LOW; break;
            case "medium": st.fanSpeed = FAN_SPEED.MEDIUM; break;
            case "high":   st.fanSpeed = FAN_SPEED.HIGH; break;
            case "auto":   st.fanSpeed = FAN_SPEED.AUTO; break;
            default:       st.fanSpeed = FAN_SPEED.LOW;
          }
          const newSt = await new SetStateCommand(this._device, st).execute();
          this._updateState(newSt);
        };

        let attempt = 0;
        const maxAttempts = 3;
        while (attempt < maxAttempts) {
          try {
            await doStart();
            this.log("Fan-Nachlauf gestartet nach " + (attempt + 1) + " Versuch(en)");
            break;
          } catch (e) {
            attempt++;
            if (attempt >= maxAttempts) throw e;
            this.log("Fan-Nachlauf Start-Versuch " + attempt + " fehlgeschlagen, retry in 3s: " + (e instanceof Error ? e.message : e));
            await new Promise(r => this.homey.setTimeout(r, 3000));
          }
        }
        this._suppressFanAfter = false;

        if (this._fanAfterCoolingTimer) this.homey.clearTimeout(this._fanAfterCoolingTimer);
        this._fanAfterCoolingTimer = this.homey.setTimeout(async () => {
          try {
            const curMode = this.getCapabilityValue("thermostat_mode");
            if (curMode === "fan" && this.getCapabilityValue("onoff") === true) {
              this.log("Fan-Nachlauf beendet - schalte Geraet aus");
              this._suppressFanAfter = true;
              await this.onCapability("onoff", false, null);
              this._suppressFanAfter = false;
            } else {
              this.log("Fan-Nachlauf-Auto-Off uebersprungen - Modus veraendert: " + curMode);
            }
          } catch (e) {
            this.error("Fan-Nachlauf-Auto-Off fehlgeschlagen: " + (e instanceof Error ? e.message : e));
          } finally {
            this._fanAfterCoolingActive = false;
            this._fanAfterCoolingTimer = null;
          }
        }, minutes * 60 * 1000);
      } catch (e) {
        this.error("Fan-Nachlauf-Start fehlgeschlagen: " + (e instanceof Error ? e.message : e));
        this._fanAfterCoolingActive = false;
      }
    }, startDelayMs);
  }

  /**
   * Bricht einen laufenden Fan-Nachlauf-Timer ab. AC-Zustand bleibt unveraendert.
   */
  public cancelFanAftercooling(): void {
    if (this._fanAfterCoolingTimer) {
      this.homey.clearTimeout(this._fanAfterCoolingTimer);
      this._fanAfterCoolingTimer = null;
    }
    if (this._fanAfterCoolingActive) {
      this.log("Fan-Nachlauf abgebrochen via cancelFanAftercooling");
    }
    this._fanAfterCoolingActive = false;
  }

  /**
   * Public Flow-Action: meldet eine externe Raumtemperatur (z.B. aus separatem Thermostat).
   * Der Driver merkt sich den Wert + Zeitstempel und passt periodisch die an die AC gesendete
   * target_temperature an, damit der AC sich an dieser Temperatur orientiert.
   */
  public async reportExternalRoomTemperature(temperatureC: number): Promise<void> {
    // 0) Sensor-Offset (Setting, -5..+5 Grad) anwenden
    const settings = this.getSettings();
    const offset = (typeof settings.ext_thermostat_offset === "number") ? +settings.ext_thermostat_offset : 0;
    const rawIn = temperatureC;
    temperatureC = temperatureC + offset;

    // 1) Basis-Plausi: Innenraum-Sinnbereich 0..50 Grad C (externer Sensor liefert manchmal -25 als Fehlerwert)
    if (!Number.isFinite(temperatureC) || temperatureC < 0 || temperatureC > 50) {
      this.log("Externe Raumtemperatur ausserhalb Plausi-Range (" + temperatureC + " Grad C, roh=" + rawIn + ") - ignoriert");
      return;
    }
    // 2) Outlier-Reject: > 5 Grad Sprung gegenueber Median der letzten Werte
    if (this._externalTempHistory.length >= 2) {
      const sorted = [...this._externalTempHistory].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (Math.abs(temperatureC - median) > 5) {
        this.log("Externe Raumtemperatur " + temperatureC + " weicht > 5 Grad vom Median " + median + " ab - verworfen");
        return;
      }
    }
    // 3) History pflegen (Ringpuffer 5 Werte fuer gleitenden Mittelwert)
    this._externalTempHistory.push(temperatureC);
    if (this._externalTempHistory.length > 5) this._externalTempHistory.shift();

    // 4) Gleitender Mittelwert - glaettet SwitchBot 0.5-Grad-Treppenstufen
    const sum = this._externalTempHistory.reduce((a, b) => a + b, 0);
    const avg = Math.round((sum / this._externalTempHistory.length) * 10) / 10; // 1 Nachkommastelle

    this._externalRoomTemp = avg;
    this._externalRoomTempTimestamp = Date.now();
    this.log("Externe Raumtemperatur akzeptiert: roh=" + rawIn + (offset ? " (offset " + offset + ")" : "") +
             ", geglaettet=" + avg + " Grad C (n=" + this._externalTempHistory.length + ")");
    this._evaluateExternalThermostat().catch(e =>
      this.error("External-Thermostat-Auswertung fehlgeschlagen: " + (e instanceof Error ? e.message : e))
    );
  }

  /**
   * Vergleicht externe Raumtemperatur mit User-Sollwert + Hysterese und passt die an die AC
   * gesendete target_temperature an. Mindestabstand zwischen Aktionen = 60s (Anti-Oszillation).
   */
  private async _evaluateExternalThermostat(): Promise<void> {
    const settings = this.getSettings();
    if (!settings.ext_thermostat_enabled) return;
    if (this._externalRoomTemp === null) return;

    const timeoutMin = (typeof settings.ext_thermostat_timeout === "number" && +settings.ext_thermostat_timeout > 0)
      ? +settings.ext_thermostat_timeout : 30;
    const ageMs = Date.now() - this._externalRoomTempTimestamp;
    if (ageMs > timeoutMin * 60 * 1000) {
      this.log("Externe Raumtemperatur veraltet (" + Math.round(ageMs / 60000) + " Min) - ignoriere");
      return;
    }

    if (Date.now() - this._externalThermostatLastAction < 60 * 1000) return;

    const onoff = this.getCapabilityValue("onoff");
    const mode  = this.getCapabilityValue("thermostat_mode");
    if (!onoff || mode === "off" || mode === "fan" || mode === "dry") return;

    const userSetpoint = (typeof settings.ext_thermostat_setpoint === "number" && +settings.ext_thermostat_setpoint > 0)
      ? +settings.ext_thermostat_setpoint : this.getCapabilityValue("target_temperature");
    const hysteresis = (typeof settings.ext_thermostat_hysteresis === "number" && +settings.ext_thermostat_hysteresis > 0)
      ? +settings.ext_thermostat_hysteresis : 0.5;

    const diff = this._externalRoomTemp - userSetpoint;

    // Mindest-Verweildauer: Richtung erst als "stabil" werten, wenn sie sich seit dwellMs nicht geaendert hat
    const dwellSec = (typeof settings.ext_thermostat_dwell === "number" && +settings.ext_thermostat_dwell >= 0)
      ? +settings.ext_thermostat_dwell : 60;
    let direction = 0;
    if (diff > hysteresis) direction = 1;
    else if (diff < -hysteresis) direction = -1;

    // Bei Richtungswechsel oder erstem Verlassen der Hysterese: Timer starten
    if (direction !== this._externalLastDirection) {
      this._externalLastDirection = direction;
      this._externalConsistentSince = direction === 0 ? 0 : Date.now();
      if (direction !== 0) {
        this.log("External-Thermostat: Richtung " + (direction > 0 ? "zu warm" : "zu kalt") +
                 " erkannt, warte auf " + dwellSec + "s Verweildauer");
      }
      return;
    }

    // Innerhalb Hysterese - nichts zu tun
    if (direction === 0) return;

    // Noch nicht lange genug in dieser Richtung? Warten.
    if (dwellSec > 0 && Date.now() - this._externalConsistentSince < dwellSec * 1000) return;

    let newTarget: number | null = null;
    const currentTarget = this.getCapabilityValue("target_temperature") || userSetpoint;

    if (mode === "cool" || mode === "auto") {
      if (direction > 0 && currentTarget > 16) newTarget = Math.max(16, currentTarget - 1);
      else if (direction < 0 && currentTarget < 30) newTarget = Math.min(30, currentTarget + 1);
    } else if (mode === "heat") {
      if (direction < 0 && currentTarget < 30) newTarget = Math.min(30, currentTarget + 1);
      else if (direction > 0 && currentTarget > 16) newTarget = Math.max(16, currentTarget - 1);
    }

    if (newTarget !== null && newTarget !== currentTarget) {
      this.log("External-Thermostat: ext=" + this._externalRoomTemp + ", soll=" + userSetpoint +
               ", diff=" + diff.toFixed(2) + ", verweildauer_ok, AC-Soll " + currentTarget + " -> " + newTarget);
      this._externalThermostatLastAction = Date.now();
      // Timer nach Aktion neu starten
      this._externalConsistentSince = Date.now();
      try { await this.onCapability("target_temperature", newTarget, null); }
      catch (e) { this.error("External-Thermostat onCapability: " + (e instanceof Error ? e.message : e)); }
    }
  }

  /**
   * Public Flow-Action: Follow Me ein/aus.
   */
  public async setFollowMe(value: boolean): Promise<void> {
    if (!this.hasCapability("follow_me")) await this.addCapability("follow_me").catch(() => {});
    await this.onCapability("follow_me", !!value, null);
  }
}

module.exports = MideaDevice;

