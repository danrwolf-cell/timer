import { BleManager, Device, Subscription, BleError, State } from 'react-native-ble-plx';
import { bleInstance } from './ble-instance';
import { parseCscNotification, type CscState } from './csc-parser';
import { useRideStore } from '../store/ride-store';
import { enqueueRawCscRow, flushRawCscQueue } from '../db/queries';

const CSC_SERVICE = '00001816-0000-1000-8000-00805f9b34fb';
const CSC_CHARACTERISTIC = '00002a5b-0000-1000-8000-00805f9b34fb';

// Reconnect delays in ms: 1s, 2s, 4s, 8s, cap at 16s
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];

class EnduroBleManager {
  private manager: BleManager;
  private speedDevice: Device | null = null;
  private speedSubscription: Subscription | null = null;
  private cscState: CscState | null = null;
  private cumulativeDistanceMi = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private targetDeviceId: string | null = null;
  private scanning = false;
  private destroyed = false;
  private currentRideId: number | null = null;

  constructor() {
    this.manager = bleInstance;
  }

  // Start scanning for CSC sensors. Resolves with the connected device.
  async scanAndConnect(): Promise<Device> {
    if (this.scanning) throw new Error('Already scanning');
    this.scanning = true;

    const bleState = await this.manager.state();
    if (bleState !== State.PoweredOn) {
      this.scanning = false;
      throw new Error('Bluetooth is not enabled');
    }

    return new Promise((resolve, reject) => {
      this.manager.startDeviceScan(
        [CSC_SERVICE],
        { allowDuplicates: false },
        (error, device) => {
          if (error) {
            this.scanning = false;
            reject(error);
            return;
          }
          if (device) {
            this.manager.stopDeviceScan();
            this.scanning = false;
            this.connectDevice(device.id).then(resolve).catch(reject);
          }
        }
      );
    });
  }

  async connectDevice(deviceId: string): Promise<Device> {
    this.targetDeviceId = deviceId;
    const { setSensorStatus } = useRideStore.getState();

    setSensorStatus('connecting');
    const device = await this.manager.connectToDevice(deviceId);
    await device.discoverAllServicesAndCharacteristics();

    this.speedDevice = device;
    this.reconnectAttempt = 0;
    setSensorStatus('connected');

    this.subscribeToSpeed(device);
    this.watchDisconnect(device);

    return device;
  }

  private subscribeToSpeed(device: Device): void {
    this.speedSubscription?.remove();
    this.cscState = null;

    this.speedSubscription = device.monitorCharacteristicForService(
      CSC_SERVICE,
      CSC_CHARACTERISTIC,
      (error, characteristic) => {
        if (error) {
          // Disconnect handler picks this up; don't double-process
          return;
        }
        if (!characteristic?.value) return;

        const bytes = Uint8Array.from(atob(characteristic.value), c => c.charCodeAt(0));
        const { wheelCircumferenceMm } = useRideStore.getState();

        // Decode the raw fields before parsing so we can log the decoded pair
        // unconditionally. Null-update cases (first packet, zero time delta,
        // power-cycle re-baseline) are exactly the sequences the firmware's
        // edge-handling paths need to replay against. A log of only "good"
        // notifications won't exercise those paths.
        const hasWheelData = bytes.length >= 7 && (bytes[0] & 0x01) !== 0;
        if (hasWheelData) {
          const cumulativeRevs =
            bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24);
          const wheelEventTime = bytes[5] | (bytes[6] << 8);
          const rideId = this.currentRideId;
          if (rideId !== null) {
            enqueueRawCscRow(rideId, Date.now(), cumulativeRevs, wheelEventTime);
          }
        }

        const { state, update } = parseCscNotification(bytes, this.cscState, wheelCircumferenceMm);
        this.cscState = state;

        if (update) {
          this.cumulativeDistanceMi +=
            (update.deltaRevolutions * wheelCircumferenceMm) / 1000 / 1609.34;
          useRideStore.getState().updateDistance(this.cumulativeDistanceMi, update.speedMph);
        }
      }
    );
  }

  private watchDisconnect(device: Device): void {
    device.onDisconnected((_error, _device) => {
      if (this.destroyed) return;
      this.speedSubscription?.remove();
      this.speedSubscription = null;
      useRideStore.getState().setSensorStatus('lost');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed || !this.targetDeviceId) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      if (this.destroyed || !this.targetDeviceId) return;
      try {
        await this.connectDevice(this.targetDeviceId);
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  setRideId(rideId: number | null): void {
    this.currentRideId = rideId;
  }

  resetDistance(): void {
    this.cumulativeDistanceMi = 0;
  }

  disconnect(): void {
    flushRawCscQueue();
    this.targetDeviceId = null;
    this.speedSubscription?.remove();
    this.speedSubscription = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.speedDevice?.cancelConnection().catch(() => {});
    this.speedDevice = null;
    useRideStore.getState().setSensorStatus('disconnected');
  }

  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.manager.destroy();
  }
}

// Singleton — one BLE manager for the app lifetime
export const bleMgr = new EnduroBleManager();
