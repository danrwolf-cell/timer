import { getDb } from './schema';
import { type Segment } from '../engine/pace-engine';
import { type FtRules, AMA_DEFAULTS } from '../engine/free-territory';

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
  check_type: string | null;
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

interface RouteRulesRow {
  has_secret_checks: number | null;
  ft_miles_after_check: number | null;
  ft_miles_before_gas: number | null;
  ft_miles_after_gas: number | null;
  ft_calibration_mile: number | null;
}

/** Read free-territory rule params for a route, falling back to AMA defaults per-column. */
export function getRouteRules(routeId: number): FtRules {
  const row = getDb().getFirstSync(
    'SELECT has_secret_checks, ft_miles_after_check, ft_miles_before_gas, ft_miles_after_gas, ft_calibration_mile FROM routes WHERE id = ?',
    routeId
  ) as RouteRulesRow | null;

  if (!row) return { ...AMA_DEFAULTS };

  return {
    hasSecretChecks: row.has_secret_checks !== null
      ? row.has_secret_checks === 1
      : AMA_DEFAULTS.hasSecretChecks,
    milesAfterCheck: row.ft_miles_after_check ?? AMA_DEFAULTS.milesAfterCheck,
    milesBeforeGas: row.ft_miles_before_gas ?? AMA_DEFAULTS.milesBeforeGas,
    milesAfterGas: row.ft_miles_after_gas ?? AMA_DEFAULTS.milesAfterGas,
    ftCalibrationMile: row.ft_calibration_mile ?? AMA_DEFAULTS.ftCalibrationMile,
  };
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
    checkType: (r.check_type ?? undefined) as Segment['checkType'],
  }));
}

export function insertSegment(
  routeId: number,
  order: number,
  segment: Segment
): void {
  getDb().runSync(
    `INSERT INTO route_segments (route_id, sort_order, distance, speed, is_reset, is_free, label, check_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    routeId, order, segment.distance, segment.speed ?? null,
    segment.isReset ? 1 : 0, segment.isFree ? 1 : 0,
    segment.label ?? null, segment.checkType ?? null
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
  deviationSeconds: number,
  source: 'live' | 'replay' = 'live'
): void {
  getDb().runSync(
    'INSERT INTO ride_log (ride_id, timestamp, cumulative_distance, deviation_seconds, source) VALUES (?, ?, ?, ?, ?)',
    rideId, timestamp, cumulativeDistance, deviationSeconds, source
  );
}

export interface RideLogRow {
  timestamp: string;
  cumulative_distance: number;
  deviation_seconds: number;
  source: 'live' | 'replay';
}

export function getRideLog(rideId: number): RideLogRow[] {
  return getDb().getAllSync(
    'SELECT timestamp, cumulative_distance, deviation_seconds, source FROM ride_log WHERE ride_id = ? ORDER BY id',
    rideId
  ) as RideLogRow[];
}

// Raw CSC log — one row per BLE notification regardless of whether it produced
// a valid update. Null cases (first packet, zero time delta, power-cycle re-baseline)
// are exactly what the firmware's edge-case paths need to replay against.

const RAW_CSC_BATCH_SIZE = 50;
const rawCscQueue: Array<{ rideId: number; wallClockMs: number; cumulativeRevs: number; wheelEventTime: number }> = [];
let rawCscFlushTimer: ReturnType<typeof setTimeout> | null = null;

export function enqueueRawCscRow(
  rideId: number,
  wallClockMs: number,
  cumulativeRevs: number,
  wheelEventTime: number
): void {
  rawCscQueue.push({ rideId, wallClockMs, cumulativeRevs, wheelEventTime });
  if (rawCscQueue.length >= RAW_CSC_BATCH_SIZE) {
    flushRawCscQueue();
  } else if (!rawCscFlushTimer) {
    rawCscFlushTimer = setTimeout(flushRawCscQueue, 10_000);
  }
}

export function flushRawCscQueue(): void {
  if (rawCscFlushTimer) {
    clearTimeout(rawCscFlushTimer);
    rawCscFlushTimer = null;
  }
  if (rawCscQueue.length === 0) return;
  const rows = rawCscQueue.splice(0);
  const db = getDb();
  const stmt = db.prepareSync(
    'INSERT INTO raw_csc_log (ride_id, wall_clock_ms, cumulative_revs, wheel_event_time) VALUES (?, ?, ?, ?)'
  );
  try {
    db.withTransactionSync(() => {
      for (const r of rows) {
        stmt.executeSync(r.rideId, r.wallClockMs, r.cumulativeRevs, r.wheelEventTime);
      }
    });
  } finally {
    stmt.finalizeSync();
  }
}

export interface RawCscRow {
  wall_clock_ms: number;
  cumulative_revs: number;
  wheel_event_time: number;
}

/** Bulk insert for device ride-log imports (bypasses the live-capture queue). */
export function insertRawCscRows(rideId: number, rows: RawCscRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepareSync(
    'INSERT INTO raw_csc_log (ride_id, wall_clock_ms, cumulative_revs, wheel_event_time) VALUES (?, ?, ?, ?)'
  );
  try {
    db.withTransactionSync(() => {
      for (const r of rows) {
        stmt.executeSync(rideId, r.wall_clock_ms, r.cumulative_revs, r.wheel_event_time);
      }
    });
  } finally {
    stmt.finalizeSync();
  }
}

export function getRawCscLog(rideId: number): RawCscRow[] {
  return getDb().getAllSync(
    'SELECT wall_clock_ms, cumulative_revs, wheel_event_time FROM raw_csc_log WHERE ride_id = ? ORDER BY id',
    rideId
  ) as RawCscRow[];
}
