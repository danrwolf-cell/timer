import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import Svg, { Path, Circle, Rect, Line, Polyline } from 'react-native-svg';

const C = { bg: '#1a1a1a', accent: '#FF6600', muted: '#888' };
const ICON_SIZE = 24;

// Icon-only floating pill menu. Rendered once by the tab navigator and
// overlaid on all four pages; screens leave bottom padding so scrolling
// content clears it.
export function FloatingTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { bottom: Math.max(insets.bottom, 12) + 8 }]}>
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const color = focused ? C.accent : C.muted;
        return (
          <TouchableOpacity
            key={route.key}
            accessibilityRole="button"
            accessibilityState={focused ? { selected: true } : {}}
            accessibilityLabel={route.name}
            style={styles.item}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                navigation.navigate(route.name, route.params);
              }
            }}
          >
            <TabIcon name={route.name} color={color} />
            {focused && <View style={styles.dot} />}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function TabIcon({ name, color }: { name: string; color: string }) {
  const p = {
    width: ICON_SIZE,
    height: ICON_SIZE,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'RouteLibrary': // folded map — the route sheet library
      return (
        <Svg {...p}>
          <Path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z" />
          <Line x1="8" y1="2" x2="8" y2="18" />
          <Line x1="16" y1="6" x2="16" y2="22" />
        </Svg>
      );
    case 'Device': // handlebar unit screen
      return (
        <Svg {...p}>
          <Rect x="2" y="3" width="20" height="14" rx="2" />
          <Line x1="8" y1="21" x2="16" y2="21" />
          <Line x1="12" y1="17" x2="12" y2="21" />
        </Svg>
      );
    case 'Rides': // clock — ride history
      return (
        <Svg {...p}>
          <Circle cx="12" cy="12" r="10" />
          <Polyline points="12 6 12 12 16 14" />
        </Svg>
      );
    case 'Settings': // gear
      return (
        <Svg {...p}>
          <Circle cx="12" cy="12" r="3" />
          <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </Svg>
      );
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 32,
    right: 32,
    flexDirection: 'row',
    backgroundColor: C.bg,
    borderRadius: 32,
    paddingVertical: 14,
    // Lift the pill off the page.
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dot: {
    position: 'absolute',
    bottom: -8,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.accent,
  },
});
