import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, AppState } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from './types';
import { useRideStore } from '../store/ride-store';
import { SensorStatusBar } from '../components/SensorStatusBar';
import { distanceToNextEvent, detectSegment } from '../engine/pace-engine';
import { appendRideLog, insertRide, flushRawCscQueue } from '../db/queries';
import { bleMgr } from '../ble/ble-manager';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'LiveRide'> };

const LOG_INTERVAL_MS = 5000;

export function LiveRideScreen({ navigation }: Props) {
  const {
    deviationSeconds, currentSpeedMph, sensorStatus,
    segments, segmentIndex, cumulativeDistanceMi,
    inFreeSection, startTime, manualReset, endRide,
    routeId, wheelCircumferenceMm,
  } = useRideStore();

  const rideIdRef = useRef<number | null>(null);
  const logTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Create ride record on mount
  useEffect(() => {
    if (routeId && startTime) {
      rideIdRef.current = insertRide(
        routeId,
        new Date(startTime).toISOString(),
        wheelCircumferenceMm
      );
      bleMgr.setRideId(rideIdRef.current);
    }

    // Log deviation every 5s
    logTimerRef.current = setInterval(() => {
      if (rideIdRef.current) {
        appendRideLog(
          rideIdRef.current,
          new Date().toISOString(),
          useRideStore.getState().cumulativeDistanceMi,
          useRideStore.getState().deviationSeconds
        );
      }
    }, LOG_INTERVAL_MS);

    return () => {
      if (logTimerRef.current) clearInterval(logTimerRef.current);
      flushRawCscQueue();
      bleMgr.setRideId(null);
    };
  }, []);

  function finishRide() {
    if (logTimerRef.current) clearInterval(logTimerRef.current);
    endRide();
    if (rideIdRef.current) {
      navigation.replace('PostRide', { rideId: rideIdRef.current });
    } else {
      navigation.replace('RouteLibrary');
    }
  }

  const position = detectSegment(segments, cumulativeDistanceMi);
  const distToNext = distanceToNextEvent(segments, position);
  const currentSeg = segments[segmentIndex];
  const requiredSpeed = currentSeg?.speed ?? null;
  const absDeviation = Math.abs(Math.round(deviationSeconds));
  const isLate = deviationSeconds > 0;
  const isEarly = deviationSeconds < 0;
  const onTime = Math.abs(deviationSeconds) < 3;

  const heroColor = onTime ? '#2ecc71' : isLate ? '#e74c3c' : '#3498db';
  const heroLabel = onTime ? 'ON TIME' : isLate ? 'LATE' : 'EARLY';

  const sensorLost = sensorStatus === 'lost';
  const approaching = distToNext !== null && distToNext < 0.2 && !inFreeSection;

  return (
    <View style={styles.container}>
      {/* SENSOR LOST takes full priority */}
      {sensorLost && (
        <View style={styles.sensorLostOverlay}>
          <Text style={styles.sensorLostText}>SENSOR{'\n'}LOST</Text>
          <Text style={styles.sensorLostSub}>Attempting reconnect…</Text>
        </View>
      )}

      {!sensorLost && (
        <>
          <SensorStatusBar status={sensorStatus} />

          {/* Free section banner */}
          {inFreeSection && (
            <View style={styles.freeBanner}>
              <Text style={styles.freeBannerText}>FREE SECTION — CLOCK PAUSED</Text>
            </View>
          )}

          {/* Approaching check banner */}
          {approaching && !inFreeSection && (
            <View style={styles.flagBanner}>
              <Text style={styles.flagBannerText}>
                FLAG — {distToNext !== null ? (distToNext * 5280).toFixed(0) : '—'} FT
              </Text>
            </View>
          )}

          <View style={styles.heroBlock}>
            {/* Deviation hero number */}
            <Text style={[styles.heroNumber, { color: heroColor }]}>
              {onTime ? '0' : `${isLate ? '+' : '-'}${absDeviation}`}
            </Text>
            <Text style={[styles.heroUnit, { color: heroColor }]}>SEC</Text>
            <Text style={[styles.heroLabel, { color: heroColor }]}>{heroLabel}</Text>
          </View>

          {/* Speed line */}
          <View style={styles.speedRow}>
            <Text style={styles.speedValue}>{currentSpeedMph.toFixed(1)}</Text>
            <Text style={styles.speedSep}> / </Text>
            <Text style={styles.speedRequired}>
              {requiredSpeed !== null ? requiredSpeed.toFixed(1) : '—'}
            </Text>
            <Text style={styles.speedUnit}> mph</Text>
          </View>

          {/* Distance to next event */}
          <Text style={styles.distNext}>
            {distToNext !== null
              ? `${(distToNext).toFixed(2)} mi to next`
              : 'Final segment'}
          </Text>

          {/* Odometer */}
          <Text style={styles.odo}>
            {cumulativeDistanceMi.toFixed(2)} mi total
          </Text>

          {/* Controls */}
          <View style={styles.controls}>
            <TouchableOpacity style={styles.controlBtn} onPress={manualReset}>
              <Text style={styles.controlText}>RESET</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.controlBtn, styles.endBtn]} onPress={finishRide}>
              <Text style={styles.controlText}>END</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

const C = { bg: '#0f0f0f', card: '#1a1a1a', text: '#fff', muted: '#666' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  sensorLostOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#e74c3c',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  sensorLostText: {
    color: '#fff', fontSize: 64, fontWeight: '900',
    textAlign: 'center', letterSpacing: 4,
  },
  sensorLostSub: { color: 'rgba(255,255,255,0.8)', fontSize: 18, marginTop: 16 },

  freeBanner: { backgroundColor: '#2980b9', padding: 10, alignItems: 'center' },
  freeBannerText: { color: '#fff', fontWeight: '800', fontSize: 14, letterSpacing: 1.5 },

  flagBanner: { backgroundColor: '#f39c12', padding: 10, alignItems: 'center' },
  flagBannerText: { color: '#000', fontWeight: '900', fontSize: 16, letterSpacing: 2 },

  heroBlock: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
  },
  heroNumber: {
    fontSize: 120, fontWeight: '900', lineHeight: 120,
  },
  heroUnit: { fontSize: 28, fontWeight: '700', letterSpacing: 3, marginTop: 4 },
  heroLabel: { fontSize: 22, fontWeight: '800', letterSpacing: 4, marginTop: 8 },

  speedRow: {
    flexDirection: 'row', alignItems: 'baseline',
    justifyContent: 'center', paddingBottom: 8,
  },
  speedValue: { color: '#fff', fontSize: 36, fontWeight: '700' },
  speedSep: { color: C.muted, fontSize: 28 },
  speedRequired: { color: C.muted, fontSize: 36, fontWeight: '400' },
  speedUnit: { color: C.muted, fontSize: 18 },

  distNext: { color: C.muted, textAlign: 'center', fontSize: 18, paddingBottom: 4 },
  odo: { color: '#444', textAlign: 'center', fontSize: 14, paddingBottom: 24 },

  controls: {
    flexDirection: 'row', paddingHorizontal: 24, paddingBottom: 48, gap: 12,
  },
  controlBtn: {
    flex: 1, backgroundColor: '#222', padding: 18,
    borderRadius: 12, alignItems: 'center',
  },
  endBtn: { backgroundColor: '#3a1a1a' },
  controlText: { color: '#fff', fontWeight: '800', fontSize: 16, letterSpacing: 2 },
});
