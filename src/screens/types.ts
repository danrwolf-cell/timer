import type { NavigatorScreenParams } from '@react-navigation/native';

// The four tab pages behind the floating bottom menu.
export type TabParamList = {
  RouteLibrary: undefined;
  // routeId is optional: tapping the tab falls back to the last-used route.
  Device: { routeId: number } | undefined;
  Rides: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList>;
  PostRide: { rideId: number };
};
