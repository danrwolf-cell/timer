import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView, Alert,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from './types';
import { useEnduroDevice } from '../ble/use-enduro-device';
import { deviceMgr } from '../ble/device-manager';
import {
  getSegments, getRouteStartConfig, setRouteStartConfig, setRouteClockOffset,
} from '../db/queries';
import { riderStartEpochSeconds } from '../ble/device-protocol';
import {
  parseTimeOfDay, resolveTimeOfDay, formatTimeOfDay, formatCountdown,
  clockOffsetMs, eventNowMs, eventTimeToPhoneEpochMs, formatOffset,
} from '../lib/time';
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
  const [keyTimeText, setKeyTimeText] = useState('08:00:00');
  const [rowText, setRowText] = useState('1');
  // Saved (absolute) key time. Held on the phone so it can be entered hours
  // ahead of the start; the device only learns about it at ARM time.
  const [keyTimeEpochMs, setKeyTimeEpochMs] = useState<number | null>(null);
  const [savedRow, setSavedRow] = useState<number | null>(null);
  // Signed ms the timekeeper's clock reads ahead of this phone.
  const [offsetMs, setOffsetMs] = useState(0);
  const [eventClockText, setEventClockText] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  // One auto-sync per connection. Reset on disconnect so a later reconnect
  // syncs again.
  const autoSyncedRef = useRef(false);
  const [autoSyncNote, setAutoSyncNote] = useState<string | null>(null);

  useEffect(() => {
    const segs = getSegments(routeId);
    if (segs.length === 0) {
      Alert.alert('Empty route', 'This route has no segments.');
      navigation.goBack();
      return;
    }
    setSegments(segs);

    const cfg = getRouteStartConfig(routeId);
    if (cfg.keyTimeEpochMs !== null) {
      setKeyTimeEpochMs(cfg.keyTimeEpochMs);
      setKeyTimeText(formatTimeOfDay(cfg.keyTimeEpochMs));
    }
    if (cfg.riderRow !== null) {
      setSavedRow(cfg.riderRow);
      setRowText(String(cfg.riderRow));
    }
    setOffsetMs(cfg.clockOffsetMs);
  }, [routeId]);

  // Drives the in-app countdown. Runs regardless of the device connection so
  // the key time keeps ticking on the phone until the race is sent over.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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

  // On connect, hand the unit everything it needs in one go: the route sheet,
  // the wheel circumference, and the armed row start. Everything was already
  // set up on the phone before the unit was even switched on.
  useEffect(() => {
    if (connectionState !== 'connected') {
      autoSyncedRef.current = false;
      setAutoSyncNote(null);
      return;
    }
    if (autoSyncedRef.current) return;
    if (segments.length === 0 || !status) return;

    // Never clobber a ride already under way. A mid-ride BLE dropout and
    // reconnect must not re-push the route or re-arm the start.
    if (status.rideState !== 'idle') {
      autoSyncedRef.current = true;
      setAutoSyncNote('Ride already under way on the unit — left it alone.');
      return;
    }

    autoSyncedRef.current = true;
    const mm = parseInt(circumferenceText, 10);
    const armable = keyTimeEpochMs !== null && savedRow !== null;

    run('sync', async () => {
      await deviceMgr.pushRoute(segments);
      if (!isNaN(mm) && mm >= 1500 && mm <= 3000) {
        await deviceMgr.setWheelCircumference(mm);
      }
      if (keyTimeEpochMs !== null && savedRow !== null) {
        await deviceMgr.armRowStart(
          eventTimeToPhoneEpochMs(keyTimeEpochMs, offsetMs),
          savedRow
        );
      }
      setAutoSyncNote(
        armable
          ? 'Route pushed and row start armed.'
          : 'Route pushed. Set a key time and row to arm the start.'
      );
    });
  }, [connectionState, status, segments, keyTimeEpochMs, savedRow, offsetMs, circumferenceText]);

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

  // Key time is entered as local HH:MM:SS (seconds matter — officials call it
  // to the second) and resolved against today's date.
  // Watch-setting technique: the rider types a time they are ABOUT to see on
  // the official clock, then taps at the instant it reads that. Typing the
  // current reading and tapping after would bake in their reaction time.
  function syncEventClock() {
    const parsed = parseTimeOfDay(eventClockText);
    if (parsed === null) {
      Alert.alert('Enter the event clock time as HH:MM:SS, then tap SYNC when it reads that');
      return;
    }
    const offset = clockOffsetMs(resolveTimeOfDay(parsed), Date.now());
    setRouteClockOffset(routeId, offset);
    setOffsetMs(offset);
    setEventClockText('');
  }

  function clearEventClockSync() {
    setRouteClockOffset(routeId, 0);
    setOffsetMs(0);
  }

  function saveKeyTime() {
    const parsed = parseTimeOfDay(keyTimeText);
    if (parsed === null) {
      Alert.alert('Enter the official key time as HH:MM:SS (24-hour)');
      return;
    }
    const row = parseInt(rowText, 10);
    if (isNaN(row) || row < 0 || row > 255) {
      Alert.alert('Enter a row between 0 and 255');
      return;
    }
    const epochMs = resolveTimeOfDay(parsed);
    setRouteStartConfig(routeId, epochMs, row);
    setKeyTimeEpochMs(epochMs);
    setSavedRow(row);
    setKeyTimeText(formatTimeOfDay(epochMs));
  }

  function armRowStart() {
    const mm = parseInt(circumferenceText, 10);
    if (isNaN(mm) || mm < 1500 || mm > 3000) {
      Alert.alert('Enter a wheel circumference between 1500\u20133000 mm');
      return;
    }
    if (keyTimeEpochMs === null || savedRow === null) {
      Alert.alert('Save the key time and row first');
      return;
    }
    // The device runs on the phone's clock, so send the key time already
    // converted out of event time.
    const keyTimePhoneMs = eventTimeToPhoneEpochMs(keyTimeEpochMs, offsetMs);
    run('arm', async () => {
      await deviceMgr.setWheelCircumference(mm);
      await deviceMgr.armRowStart(keyTimePhoneMs, savedRow);
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
  // keyTimeEpochMs is EVENT-clock time. The rider's start is that plus their
  // row, still on the event clock; converting through the offset gives the
  // phone-clock instant, which is what the countdown and the device need.
  const myStartEventMs =
    keyTimeEpochMs !== null && savedRow !== null
      ? riderStartEpochSeconds(keyTimeEpochMs / 1000, savedRow) * 1000
      : null;
  const myStartPhoneMs =
    myStartEventMs !== null ? eventTimeToPhoneEpochMs(myStartEventMs, offsetMs) : null;
  const secondsToStart =
    myStartPhoneMs !== null ? (myStartPhoneMs - nowMs) / 1000 : null;
  const countingDown = status?.rideState === 'countdown';
  const logReady = status?.rideState === 'log_ready';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Handlebar Unit</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Event Clock and Start</Text>

          <View style={styles.syncBlock}>
            <Text style={styles.startLabel}>EVENT CLOCK NOW</Text>
            <Text style={styles.eventClock}>
              {formatTimeOfDay(eventNowMs(nowMs, offsetMs))}
            </Text>
            <Text style={styles.startLabel}>
              {offsetMs === 0
                ? 'not synced \u2014 using this phone\u2019s clock'
                : `offset ${formatOffset(offsetMs)} vs phone`}
            </Text>
          </View>

          <Text style={styles.cardBody}>
            Sync: type a time you are about to see on the official clock, then
            tap SYNC the instant it reads that.
          </Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            placeholder="07:35:00"
            placeholderTextColor="#666"
            value={eventClockText}
            onChangeText={setEventClockText}
          />
          <View style={styles.syncRow}>
            <TouchableOpacity style={[styles.button, styles.syncButton]} onPress={syncEventClock}>
              <Text style={styles.buttonText}>SYNC</Text>
            </TouchableOpacity>
            {offsetMs !== 0 && (
              <TouchableOpacity
                style={[styles.button, styles.syncButton]}
                onPress={clearEventClockSync}
              >
                <Text style={styles.buttonText}>Clear</Text>
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.cardBody}>Official key time (HH:MM:SS, event clock)</Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            placeholder="09:00:00"
            placeholderTextColor="#666"
            value={keyTimeText}
            onChangeText={setKeyTimeText}
          />
          <Text style={styles.cardBody}>Your row</Text>
          <TextInput
            style={styles.input}
            keyboardType="number-pad"
            value={rowText}
            onChangeText={setRowText}
          />
          <TouchableOpacity style={styles.button} onPress={saveKeyTime}>
            <Text style={styles.buttonText}>Save key time and row</Text>
          </TouchableOpacity>

          {myStartEventMs !== null && secondsToStart !== null && (
            <View style={styles.startBlock}>
              <Text style={styles.startLabel}>
                Row {savedRow} starts {formatTimeOfDay(myStartEventMs)} event time
              </Text>
              <Text style={styles.startCountdown}>
                {secondsToStart > 0 ? formatCountdown(secondsToStart) : 'PASSED'}
              </Text>
              <Text style={styles.startLabel}>
                {secondsToStart > 0 ? 'to your start' : 'key time already passed today'}
              </Text>
            </View>
          )}
        </View>


        {/* Connection */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {connected ? `Connected — ${deviceName}` : 'Not connected'}
          </Text>
          {lastError ? <Text style={styles.error}>{lastError}</Text> : null}
          {busy === 'sync' ? (
            <Text style={styles.hint}>Sending route and start time…</Text>
          ) : autoSyncNote ? (
            <Text style={styles.hint}>{autoSyncNote}</Text>
          ) : null}
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
            {!riding && !countingDown && (
              <>
                <Text style={styles.cardBody}>Wheel circumference (mm)</Text>
                <TextInput
                  style={styles.input}
                  keyboardType="number-pad"
                  value={circumferenceText}
                  onChangeText={setCircumferenceText}
                />
                <TouchableOpacity
                  style={[
                    styles.goButton,
                    (busy !== null || myStartEventMs === null) && styles.disabled,
                  ]}
                  disabled={busy !== null || myStartEventMs === null}
                  onPress={armRowStart}
                >
                  <Text style={styles.goText}>ARM ROW START ON DEVICE</Text>
                </TouchableOpacity>
                {myStartEventMs === null && (
                  <Text style={styles.hint}>
                    Set the key time and row above first.
                  </Text>
                )}
                <TouchableOpacity
                  style={[styles.button, busy !== null && styles.disabled]}
                  disabled={busy !== null}
                  onPress={startRide}
                >
                  <Text style={styles.buttonText}>Start now (no countdown)</Text>
                </TouchableOpacity>
              </>
            )}
            {countingDown && (
              <Text style={styles.cardBody}>
                Counting down on the device. RESET on the unit re-anchors the
                start if the official says go at a different moment.
              </Text>
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
  hint: { color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 8 },
  cardBody: { color: C.text, fontSize: 15, lineHeight: 22, marginBottom: 12 },
  error: { color: '#e74c3c', marginBottom: 12 },
  button: { backgroundColor: C.accent, padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 4 },
  buttonText: { color: '#000', fontWeight: '800', fontSize: 15 },
  disabled: { opacity: 0.5 },
  input: {
    backgroundColor: '#2a2a2a', color: C.text, borderRadius: 8,
    padding: 12, fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 12,
  },
  syncBlock: {
    alignItems: 'center', paddingVertical: 12, marginBottom: 12,
    backgroundColor: '#2a2a2a', borderRadius: 8,
  },
  eventClock: {
    color: C.accent, fontSize: 34, fontWeight: '900',
    fontVariant: ['tabular-nums'], letterSpacing: 1,
  },
  syncRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  syncButton: { flex: 1 },
  startBlock: {
    alignItems: 'center', paddingVertical: 14, marginBottom: 12,
    backgroundColor: '#2a2a2a', borderRadius: 8,
  },
  startLabel: { color: C.muted, fontSize: 13 },
  startCountdown: {
    color: C.text, fontSize: 44, fontWeight: '900',
    fontVariant: ['tabular-nums'], letterSpacing: 1,
  },
  goButton: { backgroundColor: '#2ecc71', padding: 18, borderRadius: 12, alignItems: 'center' },
  stopButton: { backgroundColor: '#e74c3c', padding: 18, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  goText: { color: '#000', fontWeight: '900', fontSize: 20, letterSpacing: 2 },
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  statusItem: { width: '46%' },
  statusLabel: { color: C.muted, fontSize: 12, letterSpacing: 1 },
  statusValue: { color: C.text, fontSize: 18, fontWeight: '700', marginTop: 2 },
});
