import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView, Alert,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from './types';
import { useEnduroDevice } from '../ble/use-enduro-device';
import { deviceMgr } from '../ble/device-manager';
import { getSegments } from '../db/queries';
import { importDeviceRideLog } from '../db/import-ride';
import type { Segment } from '../engine/pace-engine';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Device'>;
  route: RouteProp<RootStackParamList, 'Device'>;
};

// Companion surface for the handlebar unit: connect, push the route sheet,
// drive the ride, pull the log back. Deliberately lean — the device's own
// display is the product; this screen is the remote control and data path.
export function DeviceScreen({ navigation, route }: Props) {
  const { routeId } = route.params;
  const {
    connectionState, deviceName, status, transfer, lastError,
    rideStartEpochMs, connect, disconnect, setLastError,
  } = useEnduroDevice();
  const [segments, setSegments] = useState<Segment[]>([]);
  const [circumferenceText, setCircumferenceText] = useState('2183');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const segs = getSegments(routeId);
    if (segs.length === 0) {
      Alert.alert('Empty route', 'This route has no segments.');
      navigation.goBack();
      return;
    }
    setSegments(segs);
  }, [routeId]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setLastError(null);
    try {
      await action();
    } catch (e) {
      setLastError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  function pushRoute() {
    run('push', () => deviceMgr.pushRoute(segments));
  }

  function startRide() {
    const mm = parseInt(circumferenceText, 10);
    if (isNaN(mm) || mm < 1500 || mm > 3000) {
      Alert.alert('Enter a wheel circumference between 1500–3000 mm');
      return;
    }
    run('start', async () => {
      await deviceMgr.setWheelCircumference(mm);
      await deviceMgr.startRide();
    });
  }

  function pullLog() {
    run('pull', async () => {
      const rows = await deviceMgr.pullRideLog();
      if (rows.length === 0) {
        Alert.alert('No ride log', 'The device has no logged rows.');
        return;
      }
      // Anchor: START_RIDE epoch if this phone started the ride; otherwise
      // approximate from "now minus the last device-relative timestamp".
      const anchor = rideStartEpochMs ?? Date.now() - rows[rows.length - 1].wallClockMs;
      const rideId = importDeviceRideLog({
        routeId,
        segments,
        wheelCircumferenceMm: parseInt(circumferenceText, 10) || 2183,
        rideStartEpochMs: anchor,
        deviceName,
        rows,
      });
      await deviceMgr.clearRideLog();
      navigation.navigate('PostRide', { rideId });
    });
  }

  const connected = connectionState === 'connected';
  const riding = status?.rideState === 'riding';
  const logReady = status?.rideState === 'log_ready';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Handlebar Unit</Text>

        {/* Connection */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {connected ? `Connected — ${deviceName}` : 'Not connected'}
          </Text>
          {lastError ? <Text style={styles.error}>{lastError}</Text> : null}
          <TouchableOpacity
            style={[styles.button, connectionState === 'scanning' && styles.disabled]}
            disabled={connectionState === 'scanning' || connectionState === 'connecting'}
            onPress={connected ? disconnect : connect}
          >
            <Text style={styles.buttonText}>
              {connected ? 'Disconnect'
                : connectionState === 'scanning' ? 'Scanning…'
                : connectionState === 'connecting' ? 'Connecting…'
                : 'Scan for Device'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Live status */}
        {connected && status && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Status</Text>
            <View style={styles.statusGrid}>
              <StatusItem label="Sensor" value={status.sensorStatus.toUpperCase()} />
              <StatusItem label="Ride" value={status.rideState.replace('_', ' ').toUpperCase()} />
              <StatusItem
                label="Battery"
                value={status.batteryPct !== null ? `${status.batteryPct}%` : '—'}
              />
              <StatusItem label="Route" value={status.routeLoaded ? 'LOADED' : 'NONE'} />
              {riding && (
                <>
                  <StatusItem
                    label="Deviation"
                    value={`${status.deviationSeconds >= 0 ? '+' : ''}${status.deviationSeconds}s`}
                  />
                  <StatusItem label="Distance" value={`${status.cumulativeDistanceMi.toFixed(2)} mi`} />
                  <StatusItem label="Segment" value={String(status.segmentIndex + 1)} />
                  <StatusItem label="Free" value={status.inFreeSection ? 'YES' : 'NO'} />
                </>
              )}
            </View>
          </View>
        )}

        {/* Route push */}
        {connected && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Route Sheet</Text>
            <Text style={styles.cardBody}>{segments.length} segments</Text>
            <TouchableOpacity
              style={[styles.button, busy !== null && styles.disabled]}
              disabled={busy !== null}
              onPress={pushRoute}
            >
              <Text style={styles.buttonText}>
                {busy === 'push' && transfer
                  ? `Pushing… ${Math.round(transfer.progress * 100)}%`
                  : 'Push Route to Device'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Ride control */}
        {connected && status?.routeLoaded && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Ride</Text>
            {!riding && (
              <>
                <Text style={styles.cardBody}>Wheel circumference (mm)</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="number-pad"
                  value={circumferenceText}
                  onChangeText={setCircumferenceText}
                />
                <TouchableOpacity
                  style={[styles.goButton, busy !== null && styles.disabled]}
                  disabled={busy !== null}
                  onPress={startRide}
                >
                  <Text style={styles.goText}>START RIDE</Text>
                </TouchableOpacity>
              </>
            )}
            {riding && (
              <>
                <TouchableOpacity
                  style={[styles.button, busy !== null && styles.disabled]}
                  disabled={busy !== null}
                  onPress={() => run('reset', () => deviceMgr.manualReset())}
                >
                  <Text style={styles.buttonText}>Manual Reset</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.stopButton, busy !== null && styles.disabled]}
                  disabled={busy !== null}
                  onPress={() => run('end', () => deviceMgr.endRide())}
                >
                  <Text style={styles.goText}>END RIDE</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {/* Log pull */}
        {connected && logReady && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Ride Log Ready</Text>
            <Text style={styles.cardBody}>
              Pull the raw log to replay it through the phone engine and see
              the deviation chart. The log lives in device RAM — pull it
              before powering the unit off.
            </Text>
            <TouchableOpacity
              style={[styles.goButton, busy !== null && styles.disabled]}
              disabled={busy !== null}
              onPress={pullLog}
            >
              <Text style={styles.goText}>
                {busy === 'pull' && transfer
                  ? `Pulling… ${transfer.progress > 0 ? Math.round(transfer.progress * 100) + '%' : ''}`
                  : 'PULL RIDE LOG'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statusItem}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={styles.statusValue}>{value}</Text>
    </View>
  );
}

const C = { bg: '#0f0f0f', card: '#1a1a1a', accent: '#f0a500', text: '#fff', muted: '#888' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingTop: 60, paddingBottom: 60 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', marginBottom: 24 },
  card: { backgroundColor: C.card, borderRadius: 14, padding: 20, marginBottom: 16 },
  cardTitle: { color: C.accent, fontSize: 16, fontWeight: '700', marginBottom: 12 },
  cardBody: { color: C.text, fontSize: 15, lineHeight: 22, marginBottom: 12 },
  error: { color: '#e74c3c', marginBottom: 12 },
  button: { backgroundColor: C.accent, padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 4 },
  buttonText: { color: '#000', fontWeight: '800', fontSize: 15 },
  disabled: { opacity: 0.5 },
  input: {
    backgroundColor: '#2a2a2a', color: C.text, borderRadius: 8,
    padding: 12, fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 12,
  },
  goButton: { backgroundColor: '#2ecc71', padding: 18, borderRadius: 12, alignItems: 'center' },
  stopButton: { backgroundColor: '#e74c3c', padding: 18, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  goText: { color: '#000', fontWeight: '900', fontSize: 20, letterSpacing: 2 },
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  statusItem: { width: '46%' },
  statusLabel: { color: C.muted, fontSize: 12, letterSpacing: 1 },
  statusValue: { color: C.text, fontSize: 18, fontWeight: '700', marginTop: 2 },
});
