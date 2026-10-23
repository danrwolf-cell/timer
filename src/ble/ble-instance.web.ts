import type { BleManager } from 'react-native-ble-plx';

// Web build (design/preview only): react-native-ble-plx has no web backend and
// its BleManager constructor throws without the native module. Stub just
// enough that the Device screen renders and reports Bluetooth as unavailable.
export const bleInstance = {
  state: async () => 'Unsupported',
  startDeviceScan: () => {},
  stopDeviceScan: () => {},
  connectToDevice: async () => {
    throw new Error('Bluetooth is not available in the web preview');
  },
} as unknown as BleManager;
