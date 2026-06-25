import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView, Alert,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from './types';
import { useBleSensor } from '../ble/use-ble-sensor';
import { useRideStore } from '../store/ride-store';
import { getSegments } from '../db/queries';
import { SensorStatusBar } from '../components/SensorStatusBar';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'PreRide'>;
  route: RouteProp<RootStackParamList, 'PreRide'>;
};

type Step = 'route' | 'sensor' | 'circumference' | 'ready';

export function PreRideScreen({ navigation, route }: Props) {
  const { routeId } = route.params;
  const { scanning, error, sensorStatus, scan } = useBleSensor();
  const { loadRoute, setWheelCircumference, startRide, wheelCircumferenceMm } = useRideStore();
  const [step, setStep] = useState<Step>('route');
  const [circumferenceText, setCircumferenceText] = useState(String(wheelCircumferenceMm));

  useEffect(() => {
    const segments = getSegments(routeId);
    if (segments.length === 0) {
      Alert.alert('Empty route', 'This route has no segments.');
      navigation.goBack();
      return;
    }
    loadRoute(segments, routeId);
  }, [routeId]);

  function confirmCircumference() {
    const val = parseInt(circumferenceText, 10);
    if (isNaN(val) || val < 1500 || val > 3000) {
      Alert.alert('Enter a wheel circumference between 1500–3000 mm');
      return;
    }
    setWheelCircumference(val);
    setStep('ready');
  }

  function goRide() {
    startRide();
    navigation.replace('LiveRide');
  }

  const STEPS: Step[] = ['route', 'sensor', 'circumference', 'ready'];
  const stepIndex = STEPS.indexOf(step);

  return (
    <View style={styles.container}>
      <SensorStatusBar status={sensorStatus} />

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Pre-Ride Setup</Text>

        {/* Progress dots */}
        <View style={styles.dots}>
          {STEPS.map((s, i) => (
            <View key={s} style={[styles.dot, i <= stepIndex && styles.dotActive]} />
          ))}
        </View>

        {step === 'route' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>1. Route Loaded</Text>
            <Text style={styles.cardBody}>Route segments confirmed and ready.</Text>
            <TouchableOpacity style={styles.nextButton} onPress={() => setStep('sensor')}>
              <Text style={styles.nextText}>Next →</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'sensor' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>2. Pair Speed Sensor</Text>
            <Text style={styles.cardBody}>
              Mount your hub sensor and spin the wheel a few times.{'\n'}
              Tap Scan to connect.
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <TouchableOpacity
              style={[styles.nextButton, scanning && styles.disabled]}
              onPress={sensorStatus === 'connected' ? () => setStep('circumference') : scan}
              disabled={scanning}
            >
              <Text style={styles.nextText}>
                {sensorStatus === 'connected' ? 'Connected — Next →' : scanning ? 'Scanning...' : 'Scan for Sensor'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'circumference' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>3. Wheel Circumference</Text>
            <Text style={styles.cardBody}>
              Default is 2183 mm (90/90-21).{'\n'}
              Adjust if you've measured your actual rolling circumference.
            </Text>
            <TextInput
              style={styles.input}
              keyboardType="number-pad"
              value={circumferenceText}
              onChangeText={setCircumferenceText}
            />
            <Text style={styles.unit}>mm</Text>
            <TouchableOpacity style={styles.nextButton} onPress={confirmCircumference}>
              <Text style={styles.nextText}>Confirm →</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'ready' && (
          <View style={styles.card}>
            <Text style={styles.readyLabel}>READY</Text>
            <Text style={styles.cardBody}>
              Sensor connected.{'\n'}
              Wheel circumference: {wheelCircumferenceMm} mm.{'\n\n'}
              Tap when the clock starts.
            </Text>
            <TouchableOpacity style={styles.goButton} onPress={goRide}>
              <Text style={styles.goText}>GO</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const C = { bg: '#0f0f0f', card: '#1a1a1a', accent: '#f0a500', text: '#fff', muted: '#888' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingTop: 60 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', marginBottom: 24 },
  dots: { flexDirection: 'row', gap: 8, marginBottom: 32 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#333' },
  dotActive: { backgroundColor: C.accent },
  card: { backgroundColor: C.card, borderRadius: 14, padding: 24 },
  cardTitle: { color: C.accent, fontSize: 18, fontWeight: '700', marginBottom: 12 },
  cardBody: { color: C.text, fontSize: 16, lineHeight: 24, marginBottom: 24 },
  error: { color: '#e74c3c', marginBottom: 16 },
  nextButton: { backgroundColor: C.accent, padding: 16, borderRadius: 10, alignItems: 'center' },
  nextText: { color: '#000', fontWeight: '800', fontSize: 16 },
  disabled: { opacity: 0.5 },
  input: {
    backgroundColor: '#2a2a2a', color: C.text, borderRadius: 8,
    padding: 14, fontSize: 24, fontWeight: '700', textAlign: 'center', marginBottom: 4,
  },
  unit: { color: C.muted, textAlign: 'center', marginBottom: 20 },
  readyLabel: {
    color: '#2ecc71', fontSize: 48, fontWeight: '900',
    textAlign: 'center', letterSpacing: 4, marginBottom: 16,
  },
  goButton: {
    backgroundColor: '#2ecc71', padding: 24, borderRadius: 14, alignItems: 'center', marginTop: 8,
  },
  goText: { color: '#000', fontWeight: '900', fontSize: 32, letterSpacing: 4 },
});
