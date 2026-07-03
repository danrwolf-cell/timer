import { useCallback } from 'react';
import { deviceMgr } from './device-manager';
import { useDeviceStore } from '../store/device-store';

export function useEnduroDevice() {
  const connectionState = useDeviceStore(s => s.connectionState);
  const deviceName = useDeviceStore(s => s.deviceName);
  const status = useDeviceStore(s => s.status);
  const transfer = useDeviceStore(s => s.transfer);
  const lastError = useDeviceStore(s => s.lastError);
  const rideStartEpochMs = useDeviceStore(s => s.rideStartEpochMs);
  const setLastError = useDeviceStore(s => s.setLastError);

  const connect = useCallback(async () => {
    try {
      await deviceMgr.scanAndConnect();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : 'Connection failed');
    }
  }, [setLastError]);

  const disconnect = useCallback(() => deviceMgr.disconnect(), []);

  return {
    connectionState,
    deviceName,
    status,
    transfer,
    lastError,
    rideStartEpochMs,
    connect,
    disconnect,
    setLastError,
  };
}
