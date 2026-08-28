import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';

// Placeholder settings page — the fourth tab. Real preferences (default wheel
// circumference, units) land here as they come up; for now it documents the
// defaults so the numbers on the Device page aren't magic.
export function SettingsScreen() {
  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Defaults</Text>
          <InfoRow label="Wheel circumference" value="2183 mm" />
          <Text style={styles.hint}>
            90/90-21 enduro MX front wheel. Adjustable per ride on the Device
            page before arming the start.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>About</Text>
          <InfoRow label="App" value="Enduro Companion" />
          <Text style={styles.hint}>
            Companion for the handlebar unit: route entry, device control, and
            post-ride replay.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const C = { bg: '#0f0f0f', card: '#1a1a1a', accent: '#FF6600', text: '#fff', muted: '#888' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingTop: 60, paddingBottom: 110 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', marginBottom: 24 },
  card: { backgroundColor: C.card, borderRadius: 14, padding: 20, marginBottom: 16 },
  cardTitle: { color: C.accent, fontSize: 16, fontWeight: '700', marginBottom: 12 },
  infoRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 8,
  },
  infoLabel: { color: C.text, fontSize: 15 },
  infoValue: { color: C.text, fontSize: 15, fontWeight: '700' },
  hint: { color: C.muted, fontSize: 13, lineHeight: 18, marginTop: 4 },
});
