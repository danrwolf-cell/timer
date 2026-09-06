import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView, Alert } from 'react-native';
import { getApiKey, setApiKey } from '../import/api-key-store';

// The fourth tab: API key management for route-sheet scanning, plus the
// app-wide defaults so the numbers on the Device page aren't magic.
export function SettingsScreen() {
  const [keyText, setKeyText] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getApiKey().then(k => setHasKey(!!k));
  }, []);

  async function save() {
    await setApiKey(keyText);
    setKeyText('');
    setHasKey(true);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function clear() {
    Alert.alert('Remove API key', 'Route sheet scanning will stop working until a new key is added. Remove it?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        await setApiKey('');
        setHasKey(false);
      }},
    ]);
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

        <Text style={styles.sectionLabel}>Anthropic API key</Text>
        <Text style={styles.cardBody}>
          Used only for Scan Route Sheet — extraction runs directly from this
          phone to Anthropic's API, no separate server involved. Stored in
          this device's secure keychain, never in the app itself.
          {'\n\n'}
          Get a key at console.anthropic.com — API Keys.
        </Text>

        <Text style={styles.statusText}>
          {hasKey ? 'A key is currently set.' : 'No key set — scanning is disabled.'}
        </Text>

        <TextInput
          style={styles.input}
          placeholder="sk-ant-..."
          placeholderTextColor="#888"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          value={keyText}
          onChangeText={setKeyText}
        />

        <TouchableOpacity
          style={[styles.saveButton, !keyText.trim() && styles.disabled]}
          onPress={save}
          disabled={!keyText.trim()}
        >
          <Text style={styles.saveButtonText}>{saved ? 'Saved' : 'Save Key'}</Text>
        </TouchableOpacity>

        {hasKey && (
          <TouchableOpacity style={styles.clearButton} onPress={clear}>
            <Text style={styles.clearButtonText}>Remove Key</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.sectionLabel}>Defaults</Text>
        <Text style={styles.cardBody}>
          Wheel circumference: 2183 mm (90/90-21 enduro MX front wheel).
          Adjustable per ride on the Device page before arming the start.
        </Text>
      </ScrollView>
    </View>
  );
}

const C = { bg: '#0f0f0f', card: '#1a1a1a', accent: '#FF6600', text: '#fff', muted: '#888', fail: '#e74c3c' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  // paddingBottom keeps the last row clear of the floating tab bar.
  content: { padding: 24, paddingTop: 60, paddingBottom: 110 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', marginBottom: 24 },
  sectionLabel: { color: C.muted, fontSize: 13, letterSpacing: 1, marginTop: 12, marginBottom: 8 },
  cardBody: { color: C.text, fontSize: 14, lineHeight: 20, marginBottom: 16 },
  statusText: { color: C.accent, fontSize: 13, marginBottom: 16 },
  input: {
    backgroundColor: C.card, color: C.text, borderRadius: 8,
    padding: 14, fontSize: 15, marginBottom: 16,
  },
  saveButton: { backgroundColor: C.accent, padding: 16, borderRadius: 10, alignItems: 'center' },
  saveButtonText: { color: '#000', fontWeight: '800', fontSize: 16 },
  disabled: { opacity: 0.5 },
  clearButton: { padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 12 },
  clearButtonText: { color: C.fail, fontWeight: '700', fontSize: 14 },
});
