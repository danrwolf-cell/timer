// DB-writing half of route-sheet import. Kept separate from route-sheet.ts
// so that module can stay free of the expo-sqlite import and be unit-tested
// directly, the same way the engine layer is.

import { insertRoute, replaceSegments, replaceFreeZones } from '../db/queries';
import { type RouteSheetData } from './route-sheet';

/** Writes segments + explicit free zones for a new route. Returns the route id. */
export function importRouteSheet(data: RouteSheetData): number {
  const routeId = insertRoute(data.name, data.eventDate);
  replaceSegments(routeId, data.segments);
  replaceFreeZones(routeId, data.freeZones);
  return routeId;
}
