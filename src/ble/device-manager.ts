import { Device, Subscription, State } from 'react-native-ble-plx';
import { bleInstance } from './ble-instance';
import { useDeviceStore } from '../store/device-store';
import type { Segment } from '../engine/pace-engine';
import {
  chunkRouteSheet,
  packRouteSheet,
  packSetWheelCircumference,
  packSimpleControl,
  packStartRide,
  parseDeviceStatus,
  RideLogAssembler,
  type RideLogRow,
  CONTROL_OPCODES,
  ENDURO_SERVICE,
  ROUTE_SHEET_CHAR,
  CONTROL_CHAR,
  DEVICE_STATUS_CHAR,
  RIDE_LOG_CHAR,
} from './device-protocol';

const LOG_PACKET_TIMEOUT_MS = 30_000;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

/**
 * Manages the phone <-> handlebar unit connection (Enduro GATT service).
 * Separate from EnduroBleManager (the direct speed-sensor path); both share
 * the same underlying native BleManager instance.
 */
class EnduroDeviceManager {
  private device: Device | null = null;
  private statusSubscription: Subscription | null = null;
  private scanning = false;

  async scanAndConnect(): Promise<Device> {
    if (this.scanning) throw new Error('Already scanning');
    this.scanning = true;
    const store = useDeviceStore.getState();
    store.setLastError(null);
    store.setConnectionState('scanning');

    const bleState = await bleInstance.state();
    if (bleState !== State.PoweredOn) {
      this.scanning = false;
      store.setConnectionState('disconnected');
      throw new Error('Bluetooth is not enabled');
    }

    return new Promise((resolve, reject) => {
      bleInstance.startDeviceScan([ENDURO_SERVICE], { allowDuplicates: false }, (error, device) => {
        if (error) {
          this.finishScan();
          useDeviceStore.getState().setConnectionState('disconnected');
          reject(error);
          return;
        }
        if (device) {
          bleInstance.stopDeviceScan();
          this.finishScan();
          this.connectDevice(device).then(resolve).catch(err => {
            useDeviceStore.getState().setConnectionState('disconnected');
            reject(err);
          });
        }
      });
    });
  }

  private finishScan(): void {
    this.scanning = false;
  }

  private async connectDevice(found: Device): Promise<Device> {
    const store = useDeviceStore.getState();
    store.setConnectionState('connecting', found.name ?? found.id);

    let device = await bleInstance.connectToDevice(found.id);
    try {
      // Bigger MTU makes the ride log pull ~20x faster. Android needs the
      // explicit request; iOS negotiates automatically. Best effort.
      device = await device.requestMTU(247);
    } catch {
      // keep default MTU
    }
    await device.discoverAllServicesAndCharacteristics();

    this.device = device;
    store.setConnectionState('connected', device.name ?? device.id);

    device.onDisconnected(() => {
      this.statusSubscription?.remove();
      this.statusSubscription = null;
      this.device = null;
      useDeviceStore.getState().setConnectionState('disconnected');
    });

    this.subscribeToStatus(device);
    return device;
  }

  private subscribeToStatus(device: Device): void {
    this.statusSubscription?.remove();
    this.statusSubscription = device.monitorCharacteristicForService(
      ENDURO_SERVICE,
      DEVICE_STATUS_CHAR,
      (error, characteristic) => {
        if (error || !characteristic?.value) return;
        try {
          useDeviceStore.getState().setStatus(parseDeviceStatus(fromBase64(characteristic.value)));
        } catch {
          // ignore malformed frame; next 1 Hz notify replaces it
        }
      }
    );
  }

  private requireDevice(): Device {
    if (!this.device) throw new Error('Not connected to a device');
    return this.device;
  }

  private async writeControl(bytes: Uint8Array): Promise<void> {
    const device = this.requireDevice();
    await device.writeCharacteristicWithResponseForService(
      ENDURO_SERVICE,
      CONTROL_CHAR,
      toBase64(bytes)
    );
  }

  /** Push a route sheet. Resolves when every chunk is acknowledged. */
  async pushRoute(segments: Segment[]): Promise<void> {
    const device = this.requireDevice();
    const store = useDeviceStore.getState();
    const payload = packRouteSheet(segments);
    const packets = chunkRouteSheet(payload, device.mtu ?? 23);

    store.setTransfer({ kind: 'route', progress: 0 });
    try {
      for (let i = 0; i < packets.length; i++) {
        await device.writeCharacteristicWithResponseForService(
          ENDURO_SERVICE,
          ROUTE_SHEET_CHAR,
          toBase64(packets[i])
        );
        store.setTransfer({ kind: 'route', progress: (i + 1) / packets.length });
      }
    } finally {
      store.setTransfer(null);
    }
  }

  async startRide(): Promise<void> {
    const epochMs = Date.now();
    await this.writeControl(packStartRide(epochMs / 1000));
    useDeviceStore.getState().setRideStartEpochMs(epochMs);
  }

  async endRide(): Promise<void> {
    await this.writeControl(packSimpleControl(CONTROL_OPCODES.END_RIDE));
  }

  async manualReset(): Promise<void> {
    await this.writeControl(packSimpleControl(CONTROL_OPCODES.MANUAL_RESET));
  }

  async setWheelCircumference(mm: number): Promise<void> {
    await this.writeControl(packSetWheelCircumference(mm));
  }

  async clearRideLog(): Promise<void> {
    await this.writeControl(packSimpleControl(CONTROL_OPCODES.CLEAR_RIDE_LOG));
  }

  /**
   * Pull the ride log: subscribe to RIDE_LOG, send REQUEST_RIDE_LOG, collect
   * DATA packets until a CRC-verified END. Rows carry device-relative ms —
   * anchor with rideStartEpochMs from the store.
   */
  async pullRideLog(): Promise<RideLogRow[]> {
    const device = this.requireDevice();
    const store = useDeviceStore.getState();
    const assembler = new RideLogAssembler();
    store.setTransfer({ kind: 'log', progress: 0 });

    return new Promise<RideLogRow[]>((resolve, reject) => {
      let subscription: Subscription | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const finish = (error: Error | null) => {
        if (timeout) clearTimeout(timeout);
        subscription?.remove();
        useDeviceStore.getState().setTransfer(null);
        if (error) reject(error);
        else resolve(assembler.rows);
      };

      const armTimeout = () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(
          () => finish(new Error('Ride log transfer timed out')),
          LOG_PACKET_TIMEOUT_MS
        );
      };

      subscription = device.monitorCharacteristicForService(
        ENDURO_SERVICE,
        RIDE_LOG_CHAR,
        (error, characteristic) => {
          if (error) {
            finish(new Error(`Ride log transfer failed: ${error.message}`));
            return;
          }
          if (!characteristic?.value) return;
          armTimeout();
          const result = assembler.addPacket(fromBase64(characteristic.value));
          if (result === 'done') {
            finish(null);
          } else if (result === 'error') {
            finish(new Error(assembler.error ?? 'Ride log transfer failed'));
          } else {
            // No total known until END; show row count as coarse progress
            useDeviceStore.getState().setTransfer({
              kind: 'log',
              progress: Math.min(0.99, assembler.rows.length / 7200),
            });
          }
        }
      );

      armTimeout();
      this.writeControl(packSimpleControl(CONTROL_OPCODES.REQUEST_RIDE_LOG)).catch(err =>
        finish(err instanceof Error ? err : new Error(String(err)))
      );
    });
  }

  disconnect(): void {
    this.statusSubscription?.remove();
    this.statusSubscription = null;
    this.device?.cancelConnection().catch(() => {});
    this.device = null;
    useDeviceStore.getState().setConnectionState('disconnected');
  }
}

// Singleton — one device connection for the app lifetime
export const deviceMgr = new EnduroDeviceManager();
