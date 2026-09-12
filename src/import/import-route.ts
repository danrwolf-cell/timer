// DB-writing half of route-sheet import. Kept separate from route-sheet.ts
// so that module can stay free of the expo-sqlite import and be unit-tested
// directly, the same way the engine layer is.

import { listRoutes, insertRoute, replaceSegments, replaceFreeZones } from '../db/queries';
import { type RouteSheetData } from './route-sheet';

/** Writes segments + explicit free zones for a new route. Returns the route id. */
export function importRouteSheet(data: RouteSheetData): number {
  const routeId = insertRoute(data.name, data.eventDate);
  replaceSegments(routeId, data.segments);
  replaceFreeZones(routeId, data.freeZones);
  return routeId;
}

/**
 * Imports `data` once, by name, if no route with that name exists yet —
 * a one-time seed rather than a repeatable menu action. For a
 * hand-transcribed stopgap route (see michaux-2026.ts) that should just be
 * in the library on first launch, not something the rider has to remember
 * to tap in. Safe to call on every app start.
 */
export function seedRouteSheetOnce(data: RouteSheetData): void {
  if (listRoutes().some(r => r.name === data.name)) return;
  importRouteSheet(data);
}
