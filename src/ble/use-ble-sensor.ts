import { useState, useCallback } from 'react';
import { bleMgr } from './ble-manager';
import { useRideStore } from '../store/ride-store';

export function useBleSensor() {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sensorStatus = useRideStore(s => s.sensorStatus);

  const scan = useCallback(async () => {
    setError(null);
    setScanning(true);
    try {
      await bleMgr.scanAndConnect();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
    } finally {
      setScanning(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    bleMgr.disconnect();
  }, []);

  const resetDistance = useCallback(() => {
    bleMgr.resetDistance();
  }, []);

  return { scanning, error, sensorStatus, scan, disconnect, resetDistance };
}
