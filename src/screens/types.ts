import type { NavigatorScreenParams } from '@react-navigation/native';
import type { ScanMimeType } from '../import/route-scan-result';

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
  RouteDetail: { routeId: number };
  // Custom camera with a photo-library shortcut; captures land on ScanReview.
  ScanCamera: undefined;
  // Extraction runs immediately on the file passed in; shows results + save.
  ScanReview: { uri: string; mimeType: ScanMimeType; label: string };
};
