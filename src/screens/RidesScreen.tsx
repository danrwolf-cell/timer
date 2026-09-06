import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect, type CompositeNavigationProp } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, TabParamList } from './types';
import { listRides, type RideRow } from '../db/queries';

type Props = {
  navigation: CompositeNavigationProp<
    BottomTabNavigationProp<TabParamList, 'Rides'>,
    NativeStackNavigationProp<RootStackParamList>
  >;
};

// Ride history: every pulled-and-replayed device log, newest first. Tapping a
// ride opens the PostRide deviation chart.
export function RidesScreen({ navigation }: Props) {
  const [rides, setRides] = useState<RideRow[]>([]);

  useFocusEffect(
    useCallback(() => {
      setRides(listRides());
    }, [])
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Rides</Text>
      <FlatList
        data={rides}
        keyExtractor={r => String(r.id)}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No rides yet. Pull a ride log from the handlebar unit to see it here.
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.rideRow}
            onPress={() => navigation.navigate('PostRide', { rideId: item.id })}
          >
            <View>
              <Text style={styles.rideName}>{item.route_name}</Text>
              <Text style={styles.rideDate}>{formatStartTime(item.start_time)}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

// start_time is an ISO string; show it in the rider's local time, readably.
function formatStartTime(startTime: string): string {
  const d = new Date(startTime);
  if (isNaN(d.getTime())) return startTime;
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const C = { bg: '#0f0f0f', card: '#1a1a1a', text: '#fff', muted: '#888' };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
  title: { color: C.text, fontSize: 28, fontWeight: '800', paddingHorizontal: 20, marginBottom: 16 },
  listContent: { paddingBottom: 110 },
  empty: { color: C.muted, textAlign: 'center', marginTop: 40, fontSize: 16, paddingHorizontal: 32 },
  rideRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.card, marginHorizontal: 16, marginBottom: 10,
    padding: 16, borderRadius: 10,
  },
  rideName: { color: C.text, fontSize: 18, fontWeight: '600' },
  rideDate: { color: C.muted, fontSize: 13, marginTop: 2 },
  chevron: { color: C.muted, fontSize: 24 },
});
