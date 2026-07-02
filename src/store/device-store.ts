import { create } from 'zustand';
import type { DeviceStatus } from '../ble/device-protocol';

export type DeviceConnectionState = 'disconnected' | 'scanning' | 'connecting' | 'connected';

export interface DeviceTransfer {
  kind: 'route' | 'log';
  /** 0..1 */
  progress: number;
}

export interface DeviceState {
  connectionState: DeviceConnectionState;
  deviceName: string | null;
  status: DeviceStatus | null;
  transfer: DeviceTransfer | null;
  lastError: string | null;
  /** Epoch ms anchor sent with START_RIDE; converts device ms to wall clock. */
  rideStartEpochMs: number | null;

  setConnectionState: (state: DeviceConnectionState, name?: string | null) => void;
  setStatus: (status: DeviceStatus | null) => void;
  setTransfer: (transfer: DeviceTransfer | null) => void;
  setLastError: (error: string | null) => void;
  setRideStartEpochMs: (epochMs: number | null) => void;
}

export const useDeviceStore = create<DeviceState>(set => ({
  connectionState: 'disconnected',
  deviceName: null,
  status: null,
  transfer: null,
  lastError: null,
  rideStartEpochMs: null,

  setConnectionState: (connectionState, name) =>
    set(prev => ({
      connectionState,
      deviceName: name !== undefined ? name : prev.deviceName,
      ...(connectionState === 'disconnected' ? { status: null, transfer: null } : {}),
    })),
  setStatus: status => set({ status }),
  setTransfer: transfer => set({ transfer }),
  setLastError: lastError => set({ lastError }),
  setRideStartEpochMs: rideStartEpochMs => set({ rideStartEpochMs }),
}));
