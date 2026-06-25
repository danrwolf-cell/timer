import { getDb } from './schema';
import { type Segment } from '../engine/pace-engine';

export interface RouteRow {
  id: number;
  name: string;
  event_date: string | null;
  notes: string | null;
}

export interface SegmentRow {
  id: number;
  route_id: number;
  sort_order: number;
  distance: number;
  speed: number | null;
  is_reset: number;
  is_free: number;
  label: string | null;
}

// Routes
export function listRoutes(): RouteRow[] {
  return getDb().getAllSync('SELECT * FROM routes ORDER BY id DESC') as RouteRow[];
}

export function insertRoute(name: string, eventDate?: string, notes?: string): number {
  const result = getDb().runSync(
    'INSERT INTO routes (name, event_date, notes) VALUES (?, ?, ?)',
    name, eventDate ?? null, notes ?? null
  );
  return result.lastInsertRowId;
}

export function deleteRoute(id: number): void {
  getDb().runSync('DELETE FROM routes WHERE id = ?', id);
}

// Segments
export function getSegments(routeId: number): Segment[] {
  const rows = getDb().getAllSync(
    'SELECT * FROM route_segments WHERE route_id = ? ORDER BY sort_order',
    routeId
  ) as SegmentRow[];
  return rows.map(r => ({
    distance: r.distance,
    speed: r.speed,
    isReset: r.is_reset === 1,
    isFree: r.is_free === 1,
    label: r.label ?? undefined,
  }));
}

export function insertSegment(
  routeId: number,
  order: number,
  segment: Omit<Segment, 'label'> & { label?: string }
): void {
  getDb().runSync(
    `INSERT INTO route_segments (route_id, sort_order, distance, speed, is_reset, is_free, label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    routeId, order, segment.distance, segment.speed ?? null,
    segment.isReset ? 1 : 0, segment.isFree ? 1 : 0, segment.label ?? null
  );
}

export function replaceSegments(routeId: number, segments: Segment[]): void {
  const db = getDb();
  db.runSync('DELETE FROM route_segments WHERE route_id = ?', routeId);
  segments.forEach((seg, i) => insertSegment(routeId, i, seg));
}

// Rides
export function insertRide(routeId: number, startTime: string, wheelCircumferenceMm: number, sensorId?: string): number {
  const result = getDb().runSync(
    'INSERT INTO rides (route_id, start_time, wheel_circumference_mm, sensor_id) VALUES (?, ?, ?, ?)',
    routeId, startTime, wheelCircumferenceMm, sensorId ?? null
  );
  return result.lastInsertRowId;
}

// Ride log
export function appendRideLog(
  rideId: number,
  timestamp: string,
  cumulativeDistance: number,
  deviationSeconds: number
): void {
  getDb().runSync(
    'INSERT INTO ride_log (ride_id, timestamp, cumulative_distance, deviation_seconds) VALUES (?, ?, ?, ?)',
    rideId, timestamp, cumulativeDistance, deviationSeconds
  );
}

export interface RideLogRow {
  timestamp: string;
  cumulative_distance: number;
  deviation_seconds: number;
}

export function getRideLog(rideId: number): RideLogRow[] {
  return getDb().getAllSync(
    'SELECT timestamp, cumulative_distance, deviation_seconds FROM ride_log WHERE ride_id = ? ORDER BY id',
    rideId
  ) as RideLogRow[];
}
