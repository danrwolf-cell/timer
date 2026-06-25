import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { type SensorStatus } from '../store/ride-store';

const LABELS: Record<SensorStatus, string> = {
  disconnected: 'SENSOR DISCONNECTED',
  connecting: 'CONNECTING...',
  connected: 'SENSOR OK',
  lost: 'SENSOR LOST',
};

const COLORS: Record<SensorStatus, string> = {
  disconnected: '#555',
  connecting: '#f0a500',
  connected: '#2ecc71',
  lost: '#e74c3c',
};

export function SensorStatusBar({ status }: { status: SensorStatus }) {
  if (status === 'connected') return null;
  return (
    <View style={[styles.bar, { backgroundColor: COLORS[status] }]}>
      <Text style={styles.text}>{LABELS[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  text: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 1.5,
  },
});
