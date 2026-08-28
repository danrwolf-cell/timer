import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from './types';
import { getApiKey } from '../import/api-key-store';
import { extractRouteSheetDirect } from '../import/route-scan-direct';
import { type ScanMimeType } from '../import/route-scan-result';
import { importRouteSheet } from '../import/import-route';
import type { RouteSheetData, CheckpointResult } from '../import/route-sheet';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'ScanRoute'> };

type Pending = { mimeType: ScanMimeType; dataBase64: string; sourceLabel: string };
type Result = { routeSheet: RouteSheetData; checkpointResults: CheckpointResult[]; allPassed: boolean };

export function ScanRouteScreen({ navigation }: Props) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getApiKey().then(k => setHasKey(!!k));
  }, []);

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera permission needed');
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.7 });
    if (res.canceled || !res.assets?.[0]?.base64) return;
    setResult(null);
    setError(null);
    setPending({ mimeType: 'image/jpeg', dataBase64: res.assets[0].base64, sourceLabel: 'Photo' });
  }

  async function choosePhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photos permission needed');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.7 });
    if (res.canceled || !res.assets?.[0]?.base64) return;
    const mimeType: ScanMimeType = res.assets[0].mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
    setResult(null);
    setError(null);
    setPending({ mimeType, dataBase64: res.assets[0].base64, sourceLabel: 'Photo' });
  }

  async function choosePdf() {
    const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf' });
    if (res.canceled || !res.assets?.[0]?.uri) return;
    const dataBase64 = await FileSystem.readAsStringAsync(res.assets[0].uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    setResult(null);
    setError(null);
    setPending({ mimeType: 'application/pdf', dataBase64, sourceLabel: res.assets[0].name ?? 'PDF' });
  }

  async function runScan() {
    if (!pending) return;
    const apiKey = await getApiKey();
    if (!apiKey) {
      Alert.alert('No API key set', 'Add your Anthropic API key in Settings first.');
      return;
    }
    setScanning(true);
    setError(null);
    const response = await extractRouteSheetDirect(apiKey, pending.mimeType, pending.dataBase64);
    setScanning(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setResult(response);
  }

  function saveRoute() {
    if (!result) return;
    const proceed = () => {
      importRouteSheet(result.routeSheet);
      navigation.goBack();
    };
    if (!result.allPassed) {
      const failed = result.checkpointResults.filter(r => !r.passed).length;
      Alert.alert(
        'Some checkpoints did not match',
        `${failed} of ${result.checkpointResults.length} printed key times didn't come back out of the extracted segments. Save anyway?`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Save anyway', style: 'destructive', onPress: proceed }]
      );
    } else {
      proceed();
    }
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Scan Route Sheet</Text>

        {hasKey === false && (
          <View style={styles.card}>
            <Text style={styles.cardBody}>No API key set — extraction runs directly from this phone to Anthropic's API, which needs a key.</Text>
            <TouchableOpacity style={styles.scanButton} onPress={() => navigation.navigate('Settings')}>
              <Text style={styles.scanButtonText}>Go to Settings</Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={styles.sectionLabel}>Source</Text>
        <View style={styles.row}>
          <TouchableOpacity style={styles.sourceButton} onPress={takePhoto}>
            <Text style={styles.sourceButtonText}>Take Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.sourceButton} onPress={choosePhoto}>
            <Text style={styles.sourceButtonText}>Choose Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.sourceButton} onPress={choosePdf}>
            <Text style={styles.sourceButtonText}>Choose PDF</Text>
          </TouchableOpacity>
        </View>

        {pending && (
          <View style={styles.card}>
            <Text style={styles.cardBody}>{pending.sourceLabel} ready to scan.</Text>
            <TouchableOpacity
              style={[styles.scanButton, scanning && styles.disabled]}
              onPress={runScan}
              disabled={scanning}
            >
              {scanning
                ? <ActivityIndicator color="#000" />
                : <Text style={styles.scanButtonText}>Scan</Text>}
            </TouchableOpacity>
          </View>
        )}

        {error && (
          <View style={styles.card}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {result && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{result.routeSheet.name}</Text>
            <Text style={styles.cardBody}>
              {result.routeSheet.segments.length} segments · {result.routeSheet.freeZones.length} free zones
            </Text>

            <Text style={styles.sectionLabel}>Checkpoints</Text>
            {result.checkpointResults.map((r, i) => (
              <View key={i} style={styles.checkRow}>
                <Text style={[styles.checkMark, r.passed ? styles.passMark : styles.failMark]}>
                  {r.passed ? '✓' : '✗'}
                </Text>
                <View style={styles.checkInfo}>
                  <Text style={styles.checkLabel}>{r.label} (mile {r.afterMile.toFixed(2)})</Text>
                  {!r.passed && (
                    <Text style={styles.checkDelta}>
                      off by {r.deltaSeconds >= 0 ? '+' : ''}{r.deltaSeconds.toFixed(0)}s
                    </Text>
                  )}
                </View>
              </View>
            ))}

            <Text style={[styles.summary, result.allPassed ? styles.passMark : styles.failMark]}>
              {result.allPassed
                ? 'All checkpoints matched'
                : `${result.checkpointResults.filter(r => !r.passed).length} of ${result.checkpointResults.length} did not match`}
            </Text>

            <TouchableOpacity style={styles.saveButton} onPress={saveRoute}>
              <Text style={styles.saveButtonText}>Save Route</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const C = { bg: '#0f0f0f', card: '#1a1a1a', accent: '#FF6600', text: '#fff', muted: '#888', pass: '#2ecc71', fail: '#e74c3c' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingTop: 60, paddingBottom: 60 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', marginBottom: 24 },
  sectionLabel: { color: C.muted, fontSize: 13, letterSpacing: 1, marginTop: 12, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 10 },
  sourceButton: {
    flex: 1, borderWidth: 1, borderColor: C.accent, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center',
  },
  sourceButtonText: { color: C.accent, fontWeight: '700', fontSize: 13, textAlign: 'center' },
  card: { backgroundColor: C.card, borderRadius: 14, padding: 20, marginTop: 20 },
  cardTitle: { color: C.accent, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  cardBody: { color: C.text, fontSize: 15, marginBottom: 16 },
  errorText: { color: C.fail, fontSize: 15 },
  scanButton: { backgroundColor: C.accent, padding: 16, borderRadius: 10, alignItems: 'center' },
  scanButtonText: { color: '#000', fontWeight: '800', fontSize: 16 },
  disabled: { opacity: 0.5 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8, gap: 10 },
  checkMark: { fontSize: 16, fontWeight: '800', width: 18 },
  passMark: { color: C.pass },
  failMark: { color: C.fail },
  checkInfo: { flex: 1 },
  checkLabel: { color: C.text, fontSize: 14 },
  checkDelta: { color: C.fail, fontSize: 12, marginTop: 2 },
  summary: { fontSize: 15, fontWeight: '700', marginTop: 12, marginBottom: 16 },
  saveButton: { backgroundColor: C.accent, padding: 16, borderRadius: 10, alignItems: 'center' },
  saveButtonText: { color: '#000', fontWeight: '800', fontSize: 16 },
});
