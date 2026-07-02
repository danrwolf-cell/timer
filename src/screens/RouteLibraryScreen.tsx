import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, Alert, Modal, ScrollView, Switch,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from './types';
import { listRoutes, insertRoute, deleteRoute, replaceSegments, type RouteRow } from '../db/queries';
import type { Segment } from '../engine/pace-engine';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'RouteLibrary'> };

const EMPTY_SEGMENT = (): Partial<Segment> & { distanceText: string; speedText: string } => ({
  distanceText: '',
  speedText: '',
  isReset: false,
  isFree: false,
  label: '',
});

export function RouteLibraryScreen({ navigation }: Props) {
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [showBuilder, setShowBuilder] = useState(false);
  const [routeName, setRouteName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [segments, setSegments] = useState([EMPTY_SEGMENT()]);

  useFocusEffect(
    useCallback(() => {
      setRoutes(listRoutes());
    }, [])
  );

  function saveRoute() {
    if (!routeName.trim()) {
      Alert.alert('Name required');
      return;
    }
    const parsed: Segment[] = [];
    for (const s of segments) {
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
        isReset: s.isReset ?? false,
        isFree: s.isFree ?? false,
        label: s.label || undefined,
      });
    }
    const id = insertRoute(routeName.trim(), eventDate.trim() || undefined);
    replaceSegments(id, parsed);
    setRoutes(listRoutes());
    setShowBuilder(false);
    setRouteName('');
    setEventDate('');
    setSegments([EMPTY_SEGMENT()]);
  }

  function confirmDelete(route: RouteRow) {
    Alert.alert('Delete route', `Delete "${route.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        deleteRoute(route.id);
        setRoutes(listRoutes());
      }},
    ]);
  }

  function updateSegment(i: number, patch: Partial<ReturnType<typeof EMPTY_SEGMENT>>) {
    setSegments(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Routes</Text>

      <FlatList
        data={routes}
        keyExtractor={r => String(r.id)}
        ListEmptyComponent={<Text style={styles.empty}>No routes yet. Add one below.</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.routeRow}
            onPress={() => navigation.navigate('PreRide', { routeId: item.id })}
            onLongPress={() => confirmDelete(item)}
          >
            <View>
              <Text style={styles.routeName}>{item.name}</Text>
              {item.event_date ? <Text style={styles.routeDate}>{item.event_date}</Text> : null}
            </View>
            <View style={styles.rowActions}>
              <TouchableOpacity
                style={styles.deviceButton}
                onPress={() => navigation.navigate('Device', { routeId: item.id })}
              >
                <Text style={styles.deviceButtonText}>DEVICE</Text>
              </TouchableOpacity>
              <Text style={styles.chevron}>›</Text>
            </View>
          </TouchableOpacity>
        )}
      />

      <TouchableOpacity style={styles.addButton} onPress={() => setShowBuilder(true)}>
        <Text style={styles.addButtonText}>+ New Route</Text>
      </TouchableOpacity>

      <Modal visible={showBuilder} animationType="slide">
        <ScrollView style={styles.modal} contentContainerStyle={styles.modalContent}>
          <Text style={styles.modalTitle}>New Route</Text>

          <TextInput
            style={styles.input}
            placeholder="Route name"
            placeholderTextColor="#888"
            value={routeName}
            onChangeText={setRouteName}
          />
          <TextInput
            style={styles.input}
            placeholder="Event date (optional)"
            placeholderTextColor="#888"
            value={eventDate}
            onChangeText={setEventDate}
          />

          <Text style={styles.sectionLabel}>Segments</Text>
          {segments.map((seg, i) => (
            <View key={i} style={styles.segmentCard}>
              <Text style={styles.segmentNum}>Segment {i + 1}</Text>
              <TextInput
                style={styles.input}
                placeholder="Label (optional)"
                placeholderTextColor="#888"
                value={seg.label}
                onChangeText={v => updateSegment(i, { label: v })}
              />
              <TextInput
                style={styles.input}
                placeholder="Distance (miles)"
                placeholderTextColor="#888"
                keyboardType="decimal-pad"
                value={seg.distanceText}
                onChangeText={v => updateSegment(i, { distanceText: v })}
              />
              <View style={styles.row}>
                <Text style={styles.toggleLabel}>Free section</Text>
                <Switch
                  value={seg.isFree}
                  onValueChange={v => updateSegment(i, { isFree: v })}
                />
              </View>
              {!seg.isFree && (
                <TextInput
                  style={styles.input}
                  placeholder="Required speed (mph)"
                  placeholderTextColor="#888"
                  keyboardType="decimal-pad"
                  value={seg.speedText}
                  onChangeText={v => updateSegment(i, { speedText: v })}
                />
              )}
              <View style={styles.row}>
                <Text style={styles.toggleLabel}>Reset checkpoint</Text>
                <Switch
                  value={seg.isReset}
                  onValueChange={v => updateSegment(i, { isReset: v })}
                />
              </View>
              {segments.length > 1 && (
                <TouchableOpacity onPress={() => setSegments(prev => prev.filter((_, idx) => idx !== i))}>
                  <Text style={styles.removeText}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}

          <TouchableOpacity
            style={styles.addSegmentButton}
            onPress={() => setSegments(prev => [...prev, EMPTY_SEGMENT()])}
          >
            <Text style={styles.addSegmentText}>+ Add Segment</Text>
          </TouchableOpacity>

          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.cancelButton} onPress={() => setShowBuilder(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.saveButton} onPress={saveRoute}>
              <Text style={styles.saveText}>Save</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </Modal>
    </View>
  );
}

const C = { bg: '#0f0f0f', card: '#1a1a1a', accent: '#f0a500', text: '#fff', muted: '#888' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', paddingHorizontal: 20, marginBottom: 16 },
  empty: { color: C.muted, textAlign: 'center', marginTop: 40, fontSize: 16 },
  routeRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.card, marginHorizontal: 16, marginBottom: 10,
    padding: 16, borderRadius: 10,
  },
  routeName: { color: C.text, fontSize: 18, fontWeight: '600' },
  routeDate: { color: C.muted, fontSize: 13, marginTop: 2 },
  chevron: { color: C.muted, fontSize: 24 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  deviceButton: {
    borderWidth: 1, borderColor: C.accent, borderRadius: 6,
    paddingVertical: 4, paddingHorizontal: 10,
  },
  deviceButtonText: { color: C.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  addButton: {
    margin: 20, padding: 16, backgroundColor: C.accent,
    borderRadius: 10, alignItems: 'center',
  },
  addButtonText: { color: '#000', fontWeight: '800', fontSize: 16 },
  modal: { flex: 1, backgroundColor: C.bg },
  modalContent: { padding: 24, paddingBottom: 60 },
  modalTitle: { color: C.text, fontSize: 24, fontWeight: '800', marginBottom: 20 },
  sectionLabel: { color: C.muted, fontSize: 13, letterSpacing: 1, marginTop: 12, marginBottom: 8 },
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
  removeText: { color: '#e74c3c', marginTop: 6, fontWeight: '600' },
  addSegmentButton: { padding: 14, borderRadius: 8, borderWidth: 1, borderColor: C.accent, alignItems: 'center', marginBottom: 20 },
  addSegmentText: { color: C.accent, fontWeight: '700', fontSize: 15 },
  modalActions: { flexDirection: 'row', gap: 12 },
  cancelButton: { flex: 1, padding: 16, borderRadius: 10, backgroundColor: C.card, alignItems: 'center' },
  cancelText: { color: C.text, fontWeight: '700', fontSize: 16 },
  saveButton: { flex: 1, padding: 16, borderRadius: 10, backgroundColor: C.accent, alignItems: 'center' },
  saveText: { color: '#000', fontWeight: '800', fontSize: 16 },
});
