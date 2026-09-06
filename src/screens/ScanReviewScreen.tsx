import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from './types';
import { getApiKey } from '../import/api-key-store';
import { extractRouteSheetDirect, type ScanProgress } from '../import/route-scan-direct';
import { importRouteSheet } from '../import/import-route';
import type { RouteSheetData, CheckpointResult } from '../import/route-sheet';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ScanReview'>;
  route: RouteProp<RootStackParamList, 'ScanReview'>;
};

type Result = { routeSheet: RouteSheetData; checkpointResults: CheckpointResult[]; allPassed: boolean };

// Lands here straight from the camera or the file picker. Extraction starts
// immediately; the screen only exists to show progress, the checkpoint
// validation, and the save button.
export function ScanReviewScreen({ navigation, route }: Props) {
  const { uri, mimeType, label } = route.params;
  const [scanning, setScanning] = useState(true);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Progress streams in fast; buffer it in refs and flush to state on an
  // interval so we don't re-render on every delta.
  const progressRef = useRef<{ stage: ScanProgress['stage']; thinking: string; outputChars: number }>({
    stage: 'uploading', thinking: '', outputChars: 0,
  });
  const startedAtRef = useRef(Date.now());
  const [progress, setProgress] = useState(progressRef.current);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const flusher = setInterval(() => {
      if (cancelled) return;
      setProgress({ ...progressRef.current });
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 350);
    (async () => {
      const apiKey = await getApiKey();
      if (!apiKey) {
        if (!cancelled) {
          setScanning(false);
          setError('No API key set — add your Anthropic API key in Settings to scan route sheets.');
        }
        return;
      }
      try {
        // Full-resolution photos are several MB — past Anthropic's image cap
        // and painfully slow to upload from a phone. Downscale images to a
        // width that still reads fine; PDFs go through untouched.
        let sendMime = mimeType;
        let dataBase64: string;
        if (mimeType === 'application/pdf') {
          dataBase64 = await new File(uri).base64();
        } else {
          const rendered = await ImageManipulator.manipulate(uri)
            .resize({ width: 1600 })
            .renderAsync();
          const result = await rendered.saveAsync({
            compress: 0.7,
            format: SaveFormat.JPEG,
            base64: true,
          });
          if (!result.base64) throw new Error('Could not encode the image.');
          dataBase64 = result.base64;
          sendMime = 'image/jpeg';
        }
        const response = await extractRouteSheetDirect(apiKey, sendMime, dataBase64, p => {
          progressRef.current.stage = p.stage;
          if (p.stage === 'thinking') progressRef.current.thinking += p.fragment;
          if (p.stage === 'writing') progressRef.current.outputChars = p.totalChars;
        });
        if (cancelled) return;
        setScanning(false);
        if (!response.ok) setError(response.error);
        else setResult(response);
      } catch (e) {
        if (cancelled) return;
        setScanning(false);
        setError(e instanceof Error ? e.message : 'Could not read the file.');
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(flusher);
    };
  }, [uri, mimeType]);

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
        <Text style={styles.title}>Route Sheet</Text>

        {scanning && (
          <View style={styles.card}>
            <View style={styles.scanningHeader}>
              <ActivityIndicator color="#FF6600" />
              <Text style={styles.scanningText}>
                {progress.stage === 'uploading' && `Uploading ${label}…`}
                {progress.stage === 'waiting' && 'Uploaded. Waiting for Claude…'}
                {progress.stage === 'thinking' && 'Claude is reading the sheet…'}
                {progress.stage === 'writing' && 'Transcribing the route sheet…'}
              </Text>
              <Text style={styles.elapsedText}>{elapsed}s</Text>
            </View>
            {progress.stage === 'writing' && (
              <Text style={styles.thinkingText}>{progress.outputChars} characters so far</Text>
            )}
            {progress.thinking.length > 0 && progress.stage !== 'writing' && (
              <Text style={styles.thinkingText}>
                {/* tail only — the interesting part is what it's doing now */}
                {progress.thinking.length > 600 ? '…' + progress.thinking.slice(-600) : progress.thinking}
              </Text>
            )}
          </View>
        )}

        {error && (
          <View style={styles.card}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              style={styles.errorButton}
              onPress={() =>
                error.startsWith('No API key')
                  ? navigation.navigate('Tabs', { screen: 'Settings' })
                  : navigation.goBack()
              }
            >
              <Text style={styles.errorButtonText}>
                {error.startsWith('No API key') ? 'Go to Settings' : 'Back'}
              </Text>
            </TouchableOpacity>
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

        {!scanning && (
          <TouchableOpacity style={styles.cancelLink} onPress={() => navigation.goBack()}>
            <Text style={styles.cancelLinkText}>Cancel</Text>
          </TouchableOpacity>
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
  card: { backgroundColor: C.card, borderRadius: 14, padding: 20, marginTop: 4 },
  scanningHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  scanningText: { color: C.text, fontSize: 15, fontWeight: '600', flex: 1 },
  elapsedText: { color: C.muted, fontSize: 13, fontVariant: ['tabular-nums'] },
  thinkingText: {
    color: C.muted, fontSize: 12, lineHeight: 17, marginTop: 14,
    fontStyle: 'italic',
  },
  cardTitle: { color: C.accent, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  cardBody: { color: C.text, fontSize: 15, marginBottom: 16 },
  sectionLabel: { color: C.muted, fontSize: 13, letterSpacing: 1, marginTop: 12, marginBottom: 8 },
  errorText: { color: C.fail, fontSize: 15, marginBottom: 16 },
  errorButton: { backgroundColor: C.accent, padding: 14, borderRadius: 10, alignItems: 'center' },
  errorButtonText: { color: '#000', fontWeight: '800', fontSize: 15 },
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
  cancelLink: { alignItems: 'center', marginTop: 20, padding: 10 },
  cancelLinkText: { color: C.muted, fontSize: 15 },
});
