import React, { useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet, ScrollView, Alert, Switch,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from './types';
import {
  getRoute, getSegments, getFreeZones, getRouteStartConfig,
  updateRoute, deleteRoute, replaceSegments, replaceFreeZones,
  type RouteRow,
} from '../db/queries';
import type { Segment } from '../engine/pace-engine';
import type { FtZoneInput } from '../engine/free-territory';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'RouteDetail'>;
  route: RouteProp<RootStackParamList, 'RouteDetail'>;
};

type EditableSegment = {
  distanceText: string;
  speedText: string;
  isReset: boolean;
  isFree: boolean;
  label: string;
};

// A reset on the sheet: the odometer jumps from the start marker forward to
// the end marker (course mileage), riders take it as free territory.
type EditableZone = {
  startText: string;
  endText: string;
  reason: string;
};

type TimelineRow =
  | { kind: 'segment'; segment: Segment; index: number; rowMiles: number; rowKt: number }
  | { kind: 'zone'; zone: FtZoneInput; rowStart: number; rowEnd: number };

/**
 * Segments and resets in one ride-ordered list, the way they sit on the
 * course — a reset isn't its own leg, it's a mile range layered over the
 * segments it spans, merged in by mile rather than listed separately.
 * Also computes each segment's own odometer mile (resets to 0 at an
 * isReset segment, like the physical trip meter at a gas stop) and running
 * key time, the same walk the old two-section render did.
 *
 * `freeZones` are stored in raw, never-resetting course-cumulative miles
 * (same as the engine uses internally) — a zone after the gas stop reads
 * like mile 30+, not the small number the trip odometer actually shows
 * there. `rowStart`/`rowEnd` below convert to the same odometer mile the
 * segment rows show, using whatever offset was active at the zone's own
 * position, so a zone in the second half of the day doesn't read wrong
 * relative to the segments around it.
 */
function buildTimeline(segments: Segment[], freeZones: FtZoneInput[]): TimelineRow[] {
  let cumulative = 0;   // internal course-cumulative, never resets — for merging zones by position
  let runningMiles = 0; // odometer-style, resets at isReset
  let offset = 0;        // cumulative value at the start of the current odometer epoch
  let ktSeconds = 0;
  const zonesByStart = [...freeZones].sort((a, b) => a.start - b.start);
  let zoneIdx = 0;
  const rows: TimelineRow[] = [];
  const pushZone = (zone: FtZoneInput) =>
    rows.push({ kind: 'zone', zone, rowStart: zone.start - offset, rowEnd: zone.end - offset });

  segments.forEach((seg, i) => {
    while (zoneIdx < zonesByStart.length && zonesByStart[zoneIdx].start <= cumulative) {
      pushZone(zonesByStart[zoneIdx]);
      zoneIdx++;
    }
    if (seg.isReset) {
      runningMiles = 0;
      offset = cumulative;
    }
    const rowMiles = runningMiles;
    const rowKt = ktSeconds;
    runningMiles += seg.distance;
    cumulative += seg.distance;
    if (!seg.isFree && seg.speed !== null) {
      ktSeconds += (seg.distance / seg.speed) * 3600;
    }
    rows.push({ kind: 'segment', segment: seg, index: i, rowMiles, rowKt });
  });
  while (zoneIdx < zonesByStart.length) {
    pushZone(zonesByStart[zoneIdx]);
    zoneIdx++;
  }
  return rows;
}

function toEditable(s: Segment): EditableSegment {
  return {
    distanceText: String(s.distance),
    speedText: s.speed !== null ? String(s.speed) : '',
    isReset: s.isReset,
    isFree: s.isFree,
    label: s.label ?? '',
  };
}

// Opened from the route library: the full route sheet — every segment with
// its numbers — plus editing, deletion, and the handoff to the device.
export function RouteDetailScreen({ navigation, route }: Props) {
  const { routeId } = route.params;
  const [routeRow, setRouteRow] = useState<RouteRow | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [freeZones, setFreeZones] = useState<FtZoneInput[]>([]);
  const [keyTimeEpochMs, setKeyTimeEpochMs] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [nameText, setNameText] = useState('');
  const [dateText, setDateText] = useState('');
  const [editSegments, setEditSegments] = useState<EditableSegment[]>([]);
  const [editZones, setEditZones] = useState<EditableZone[]>([]);

  useFocusEffect(
    useCallback(() => {
      const r = getRoute(routeId);
      setRouteRow(r);
      setSegments(getSegments(routeId));
      setFreeZones(getFreeZones(routeId));
      setKeyTimeEpochMs(getRouteStartConfig(routeId).keyTimeEpochMs);
    }, [routeId])
  );

  function startEditing() {
    if (!routeRow) return;
    setNameText(routeRow.name);
    setDateText(routeRow.event_date ?? '');
    setEditSegments(segments.map(toEditable));
    setEditZones(freeZones.map(z => ({
      startText: String(z.start),
      endText: String(z.end),
      reason: z.reason ?? '',
    })));
    setEditing(true);
  }

  function saveEdits() {
    if (!nameText.trim()) {
      Alert.alert('Name required');
      return;
    }
    const parsed: Segment[] = [];
    for (const s of editSegments) {
      const dist = parseFloat(s.distanceText);
      const spd = s.isFree ? null : parseFloat(s.speedText);
      if (isNaN(dist) || dist <= 0) {
        Alert.alert('Each segment needs a valid distance');
        return;
      }
      if (!s.isFree && (isNaN(spd!) || spd! <= 0)) {
        Alert.alert('Each scored segment needs a valid speed');
        return;
      }
      parsed.push({
        distance: dist,
        speed: spd,
        isReset: s.isReset,
        isFree: s.isFree,
        label: s.label || undefined,
      });
    }
    const zones: FtZoneInput[] = [];
    for (const z of editZones) {
      const start = parseFloat(z.startText);
      const end = parseFloat(z.endText);
      if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
        Alert.alert('Each reset needs valid start and end miles (end after start)');
        return;
      }
      zones.push({ start, end, reason: z.reason.trim() || undefined });
    }
    updateRoute(routeId, nameText.trim(), dateText.trim() || undefined);
    replaceSegments(routeId, parsed);
    replaceFreeZones(routeId, zones);
    setRouteRow(getRoute(routeId));
    setSegments(getSegments(routeId));
    setFreeZones(getFreeZones(routeId));
    setEditing(false);
  }

  function confirmDelete() {
    if (!routeRow) return;
    Alert.alert('Delete route', `Delete "${routeRow.name}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        deleteRoute(routeId);
        navigation.goBack();
      }},
    ]);
  }

  function updateEditSegment(i: number, patch: Partial<EditableSegment>) {
    setEditSegments(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  }

  if (!routeRow) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Route not found.</Text>
      </View>
    );
  }

  const totalMiles = segments.reduce((sum, s) => sum + s.distance, 0);

  // KT as clock time when the official key time is set; elapsed time otherwise.
  function formatKt(seconds: number): string {
    const total = keyTimeEpochMs !== null
      ? Math.round(keyTimeEpochMs / 1000 + seconds)
      : Math.round(seconds);
    const asDate = keyTimeEpochMs !== null ? new Date(total * 1000) : null;
    const h = asDate ? asDate.getHours() : Math.floor(total / 3600);
    const m = asDate ? asDate.getMinutes() : Math.floor((total % 3600) / 60);
    const s = asDate ? asDate.getSeconds() : total % 60;
    const mm = String(m).padStart(2, '0');
    return s > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${h}:${mm}`;
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <TouchableOpacity style={styles.backLink} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>‹ Routes</Text>
        </TouchableOpacity>

        {!editing ? (
          <>
            <Text style={styles.title}>{routeRow.name}</Text>
            <Text style={styles.subtitle}>
              {routeRow.event_date ? `${routeRow.event_date} · ` : ''}
              {segments.length} segments · {totalMiles.toFixed(2)} mi
            </Text>

            <TouchableOpacity
              style={styles.deviceButton}
              onPress={() => navigation.navigate('Tabs', { screen: 'Device', params: { routeId } })}
            >
              <Text style={styles.deviceButtonText}>Send to Device</Text>
            </TouchableOpacity>

            <Text style={styles.sectionLabel}>Segments</Text>
            {buildTimeline(segments, freeZones).map((row, i) => {
              if (row.kind === 'zone') {
                const z = row.zone;
                return (
                  <View key={`z${i}`} style={styles.segmentRow}>
                    <Text style={styles.segmentIndex}>R</Text>
                    <View style={styles.segmentInfo}>
                      <Text style={styles.segmentMain}>
                        {row.rowStart.toFixed(1)} → {row.rowEnd.toFixed(1)}
                      </Text>
                      {z.reason ? <Text style={styles.segmentLabel}>{z.reason}</Text> : null}
                      <Text style={styles.segmentCumulative}>
                        odometer moves up {(z.end - z.start).toFixed(2)} mi
                      </Text>
                    </View>
                  </View>
                );
              }
              const { segment: seg, index: i2, rowMiles, rowKt } = row;
              return (
                <View key={`s${i}`} style={styles.segmentRow}>
                  <Text style={styles.segmentIndex}>{i2 + 1}</Text>
                  <View style={styles.segmentInfo}>
                    <View style={styles.sheetRow}>
                      <Text style={styles.sheetMiles}>{rowMiles.toFixed(1)}</Text>
                      <Text style={styles.sheetSpeed}>
                        {seg.isFree ? 'FREE' : `${seg.speed}mph`}
                      </Text>
                      <Text style={styles.sheetKt}>KT {formatKt(rowKt)}</Text>
                    </View>
                    {seg.label ? <Text style={styles.segmentLabel}>{seg.label}</Text> : null}
                    <View style={styles.flagRow}>
                      {seg.isReset && <Text style={styles.flagReset}>RESET</Text>}
                      <Text style={styles.segmentCumulative}>
                        {seg.distance.toFixed(2)} mi to {(rowMiles + seg.distance).toFixed(1)}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })}

            <TouchableOpacity style={styles.editButton} onPress={startEditing}>
              <Text style={styles.editButtonText}>Edit Route</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.deleteButton} onPress={confirmDelete}>
              <Text style={styles.deleteButtonText}>Delete Route</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.title}>Edit Route</Text>
            <TextInput
              style={styles.input}
              placeholder="Route name"
              placeholderTextColor="#888"
              value={nameText}
              onChangeText={setNameText}
            />
            <TextInput
              style={styles.input}
              placeholder="Event date (optional)"
              placeholderTextColor="#888"
              value={dateText}
              onChangeText={setDateText}
            />

            <Text style={styles.sectionLabel}>Segments</Text>
            {editSegments.map((seg, i) => (
              <View key={i} style={styles.segmentCard}>
                <Text style={styles.segmentNum}>Segment {i + 1}</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Label (optional)"
                  placeholderTextColor="#888"
                  value={seg.label}
                  onChangeText={v => updateEditSegment(i, { label: v })}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Distance (miles)"
                  placeholderTextColor="#888"
                  keyboardType="decimal-pad"
                  value={seg.distanceText}
                  onChangeText={v => updateEditSegment(i, { distanceText: v })}
                />
                <View style={styles.row}>
                  <Text style={styles.toggleLabel}>Free section</Text>
                  <Switch
                    value={seg.isFree}
                    onValueChange={v => updateEditSegment(i, { isFree: v })}
                  />
                </View>
                {!seg.isFree && (
                  <TextInput
                    style={styles.input}
                    placeholder="Required speed (mph)"
                    placeholderTextColor="#888"
                    keyboardType="decimal-pad"
                    value={seg.speedText}
                    onChangeText={v => updateEditSegment(i, { speedText: v })}
                  />
                )}
                <View style={styles.row}>
                  <Text style={styles.toggleLabel}>Reset checkpoint</Text>
                  <Switch
                    value={seg.isReset}
                    onValueChange={v => updateEditSegment(i, { isReset: v })}
                  />
                </View>
                {editSegments.length > 1 && (
                  <TouchableOpacity
                    onPress={() => setEditSegments(prev => prev.filter((_, idx) => idx !== i))}
                  >
                    <Text style={styles.removeText}>Remove</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}

            <TouchableOpacity
              style={styles.addSegmentButton}
              onPress={() => setEditSegments(prev => [
                ...prev,
                { distanceText: '', speedText: '', isReset: false, isFree: false, label: '' },
              ])}
            >
              <Text style={styles.addSegmentText}>+ Add Segment</Text>
            </TouchableOpacity>

            <Text style={styles.sectionLabel}>Resets</Text>
            {editZones.map((z, i) => (
              <View key={i} style={styles.segmentCard}>
                <Text style={styles.segmentNum}>Reset {i + 1}</Text>
                <View style={styles.zoneRow}>
                  <TextInput
                    style={[styles.input, styles.zoneInput]}
                    placeholder="From mile"
                    placeholderTextColor="#888"
                    keyboardType="decimal-pad"
                    value={z.startText}
                    onChangeText={v => setEditZones(prev =>
                      prev.map((p, idx) => idx === i ? { ...p, startText: v } : p))}
                  />
                  <Text style={styles.zoneArrow}>→</Text>
                  <TextInput
                    style={[styles.input, styles.zoneInput]}
                    placeholder="To mile"
                    placeholderTextColor="#888"
                    keyboardType="decimal-pad"
                    value={z.endText}
                    onChangeText={v => setEditZones(prev =>
                      prev.map((p, idx) => idx === i ? { ...p, endText: v } : p))}
                  />
                </View>
                <TextInput
                  style={styles.input}
                  placeholder="Note (optional)"
                  placeholderTextColor="#888"
                  value={z.reason}
                  onChangeText={v => setEditZones(prev =>
                    prev.map((p, idx) => idx === i ? { ...p, reason: v } : p))}
                />
                <TouchableOpacity
                  onPress={() => setEditZones(prev => prev.filter((_, idx) => idx !== i))}
                >
                  <Text style={styles.removeText}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity
              style={styles.addSegmentButton}
              onPress={() => setEditZones(prev => [...prev, { startText: '', endText: '', reason: '' }])}
            >
              <Text style={styles.addSegmentText}>+ Add Reset</Text>
            </TouchableOpacity>

            <View style={styles.editActions}>
              <TouchableOpacity style={styles.cancelButton} onPress={() => setEditing(false)}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveButton} onPress={saveEdits}>
                <Text style={styles.saveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const C = { bg: '#0f0f0f', card: '#1a1a1a', accent: '#FF6600', text: '#fff', muted: '#888', fail: '#e74c3c' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingTop: 56, paddingBottom: 60 },
  backLink: { marginBottom: 12 },
  backText: { color: C.accent, fontSize: 16, fontWeight: '600' },
  title: { color: C.text, fontSize: 28, fontWeight: '800', marginBottom: 4 },
  subtitle: { color: C.muted, fontSize: 14, marginBottom: 20 },
  empty: { color: C.muted, textAlign: 'center', marginTop: 80, fontSize: 16 },
  deviceButton: {
    backgroundColor: C.accent, padding: 16, borderRadius: 10,
    alignItems: 'center', marginBottom: 8,
  },
  deviceButtonText: { color: '#000', fontWeight: '800', fontSize: 16 },
  sectionLabel: { color: C.muted, fontSize: 13, letterSpacing: 1, marginTop: 20, marginBottom: 8 },
  segmentRow: {
    flexDirection: 'row', backgroundColor: C.card, borderRadius: 10,
    padding: 12, marginBottom: 8, gap: 12,
  },
  segmentIndex: { color: C.accent, fontSize: 16, fontWeight: '800', width: 24, textAlign: 'center' },
  segmentInfo: { flex: 1 },
  segmentMain: { color: C.text, fontSize: 16, fontWeight: '600' },
  sheetRow: { flexDirection: 'row', alignItems: 'baseline', gap: 14 },
  sheetMiles: {
    color: C.accent, fontSize: 18, fontWeight: '800',
    fontVariant: ['tabular-nums'], minWidth: 44,
  },
  sheetSpeed: { color: C.text, fontSize: 16, fontWeight: '700' },
  sheetKt: {
    color: C.muted, fontSize: 14, fontWeight: '600',
    fontVariant: ['tabular-nums'], marginLeft: 'auto',
  },
  segmentLabel: { color: C.muted, fontSize: 13, marginTop: 2 },
  flagRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  flagReset: { color: C.fail, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  segmentCumulative: { color: C.muted, fontSize: 12 },
  editButton: {
    marginTop: 20, padding: 14, borderRadius: 10,
    borderWidth: 1, borderColor: C.accent, alignItems: 'center',
  },
  editButtonText: { color: C.accent, fontWeight: '700', fontSize: 15 },
  deleteButton: { marginTop: 12, padding: 14, alignItems: 'center' },
  deleteButtonText: { color: C.fail, fontWeight: '700', fontSize: 15 },
  input: {
    backgroundColor: C.card, color: C.text, borderRadius: 8,
    padding: 14, marginBottom: 10, fontSize: 16,
  },
  segmentCard: {
    backgroundColor: '#222', borderRadius: 10, padding: 14,
    marginBottom: 12, borderLeftWidth: 3, borderLeftColor: C.accent,
  },
  segmentNum: { color: C.accent, fontWeight: '700', marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  toggleLabel: { color: C.text, fontSize: 15 },
  removeText: { color: C.fail, marginTop: 6, fontWeight: '600' },
  addSegmentButton: {
    padding: 14, borderRadius: 8, borderWidth: 1, borderColor: C.accent,
    alignItems: 'center', marginBottom: 20,
  },
  addSegmentText: { color: C.accent, fontWeight: '700', fontSize: 15 },
  zoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  zoneInput: { flex: 1 },
  zoneArrow: { color: C.muted, fontSize: 18, marginBottom: 10 },
  editActions: { flexDirection: 'row', gap: 12 },
  cancelButton: { flex: 1, padding: 16, borderRadius: 10, backgroundColor: C.card, alignItems: 'center' },
  cancelText: { color: C.text, fontWeight: '700', fontSize: 16 },
  saveButton: { flex: 1, padding: 16, borderRadius: 10, backgroundColor: C.accent, alignItems: 'center' },
  saveText: { color: '#000', fontWeight: '800', fontSize: 16 },
});
