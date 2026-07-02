import { BleManager } from 'react-native-ble-plx';

// One native BleManager for the whole app. react-native-ble-plx wraps a
// single native client — constructing multiple instances risks one destroy()
// tearing down the other's subscriptions. Both the speed-sensor manager and
// the Enduro device manager share this instance.
export const bleInstance = new BleManager();
