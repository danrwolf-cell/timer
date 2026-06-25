import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Dimensions } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from './types';
import { getRideLog, type RideLogRow } from '../db/queries';
import { Svg, Polyline, Line, Circle, Text as SvgText } from 'react-native-svg';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'PostRide'>;
  route: RouteProp<RootStackParamList, 'PostRide'>;
};

const { width: SCREEN_W } = Dimensions.get('window');
const CHART_W = SCREEN_W - 48;
const CHART_H = 200;
const PAD = { top: 16, bottom: 32, left: 40, right: 16 };

export function PostRideScreen({ navigation, route }: Props) {
  const { rideId } = route.params;
  const [log, setLog] = useState<RideLogRow[]>([]);

  useEffect(() => {
    setLog(getRideLog(rideId));
  }, [rideId]);

  if (log.length < 2) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Ride Complete</Text>
        <Text style={styles.empty}>Not enough data to show a chart.</Text>
        <TouchableOpacity style={styles.doneButton} onPress={() => navigation.replace('RouteLibrary')}>
          <Text style={styles.doneText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Chart math
  const distances = log.map(r => r.cumulative_distance);
  const deviations = log.map(r => r.deviation_seconds);
  const minDist = Math.min(...distances);
  const maxDist = Math.max(...distances);
  const minDev = Math.min(...deviations, -5);
  const maxDev = Math.max(...deviations, 5);

  const innerW = CHART_W - PAD.left - PAD.right;
  const innerH = CHART_H - PAD.top - PAD.bottom;

  function xPos(d: number) {
    return PAD.left + ((d - minDist) / (maxDist - minDist || 1)) * innerW;
  }
  function yPos(v: number) {
    return PAD.top + (1 - (v - minDev) / (maxDev - minDev || 1)) * innerH;
  }

  const points = log.map(r => `${xPos(r.cumulative_distance)},${yPos(r.deviation_seconds)}`).join(' ');
  const zeroY = yPos(0);

  // Summary stats
  const lateCount = deviations.filter(d => d > 3).length;
  const earlyCount = deviations.filter(d => d < -3).length;
  const onTimeCount = deviations.length - lateCount - earlyCount;
  const pctOnTime = Math.round((onTimeCount / deviations.length) * 100);
  const maxLate = Math.max(...deviations);
  const maxEarly = Math.min(...deviations);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Ride Complete</Text>

        {/* Deviation chart */}
        <View style={styles.chartContainer}>
          <Text style={styles.chartLabel}>Deviation (seconds) over distance</Text>
          <Svg width={CHART_W} height={CHART_H}>
            {/* Zero line */}
            <Line
              x1={PAD.left} y1={zeroY}
              x2={CHART_W - PAD.right} y2={zeroY}
              stroke="#333" strokeWidth={1} strokeDasharray="4,4"
            />
            {/* Deviation line */}
            <Polyline
              points={points}
              fill="none"
              stroke="#f0a500"
              strokeWidth={2}
            />
            {/* Y axis labels */}
            <SvgText x={PAD.left - 4} y={PAD.top + 4} fill="#666" fontSize={10} textAnchor="end">
              {Math.round(maxDev)}s
            </SvgText>
            <SvgText x={PAD.left - 4} y={zeroY + 4} fill="#666" fontSize={10} textAnchor="end">
              0
            </SvgText>
            <SvgText x={PAD.left - 4} y={CHART_H - PAD.bottom} fill="#666" fontSize={10} textAnchor="end">
              {Math.round(minDev)}s
            </SvgText>
            {/* X axis labels */}
            <SvgText x={PAD.left} y={CHART_H} fill="#666" fontSize={10} textAnchor="middle">
              {minDist.toFixed(1)}
            </SvgText>
            <SvgText x={CHART_W - PAD.right} y={CHART_H} fill="#666" fontSize={10} textAnchor="middle">
              {maxDist.toFixed(1)} mi
            </SvgText>
          </Svg>
        </View>

        {/* Stats */}
        <View style={styles.statsGrid}>
          <StatBox label="On Time" value={`${pctOnTime}%`} color="#2ecc71" />
          <StatBox label="Worst Late" value={`+${Math.round(maxLate)}s`} color="#e74c3c" />
          <StatBox label="Worst Early" value={`${Math.round(maxEarly)}s`} color="#3498db" />
          <StatBox label="Total Distance" value={`${maxDist.toFixed(2)} mi`} color="#f0a500" />
        </View>
      </ScrollView>

      <TouchableOpacity style={styles.doneButton} onPress={() => navigation.replace('RouteLibrary')}>
        <Text style={styles.doneText}>Done</Text>
      </TouchableOpacity>
    </View>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={statStyles.box}>
      <Text style={[statStyles.value, { color }]}>{value}</Text>
      <Text style={statStyles.label}>{label}</Text>
    </View>
  );
}

const C = { bg: '#0f0f0f', card: '#1a1a1a', text: '#fff', muted: '#888', accent: '#f0a500' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingTop: 60, paddingBottom: 100 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', marginBottom: 24 },
  empty: { color: C.muted, fontSize: 16, marginBottom: 40 },
  chartContainer: { backgroundColor: C.card, borderRadius: 12, padding: 12, marginBottom: 24 },
  chartLabel: { color: C.muted, fontSize: 12, marginBottom: 8 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  doneButton: {
    position: 'absolute', bottom: 40, left: 24, right: 24,
    backgroundColor: C.accent, padding: 18, borderRadius: 12, alignItems: 'center',
  },
  doneText: { color: '#000', fontWeight: '800', fontSize: 18 },
});

const statStyles = StyleSheet.create({
  box: {
    flex: 1, minWidth: '45%', backgroundColor: C.card,
    borderRadius: 10, padding: 16, alignItems: 'center',
  },
  value: { fontSize: 28, fontWeight: '900', marginBottom: 4 },
  label: { color: C.muted, fontSize: 13 },
});
