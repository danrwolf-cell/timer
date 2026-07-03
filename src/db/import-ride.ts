import { insertRide, insertRawCscRows, appendRideLog } from './queries';
import { replayRide, type RawCscRow } from '../engine/replay';
import type { Segment } from '../engine/pace-engine';
import type { RideLogRow } from '../ble/device-protocol';

/**
 * Import a ride log pulled from the handlebar unit.
 *
 * Rows carry device-relative ms; rideStartEpochMs (the START_RIDE anchor)
 * converts them to wall clock. Raw rows go to raw_csc_log, then the same
 * golden-reference replay used for phone rides produces ride_log rows with
 * source 'replay'. Comparing those deviations to what the firmware displayed
 * live is the cross-validation step from the build plan.
 *
 * Returns the new ride id.
 */
export function importDeviceRideLog(opts: {
  routeId: number;
  segments: Segment[];
  wheelCircumferenceMm: number;
  rideStartEpochMs: number;
  deviceName: string | null;
  rows: RideLogRow[];
}): number {
  const { routeId, segments, wheelCircumferenceMm, rideStartEpochMs, deviceName, rows } = opts;

  const rideId = insertRide(
    routeId,
    new Date(rideStartEpochMs).toISOString(),
    wheelCircumferenceMm,
    deviceName ?? undefined
  );

  const rawRows: RawCscRow[] = rows.map(r => ({
    wall_clock_ms: rideStartEpochMs + r.wallClockMs,
    cumulative_revs: r.cumulativeRevs,
    wheel_event_time: r.wheelEventTime,
  }));
  insertRawCscRows(rideId, rawRows);

  const { points } = replayRide(rawRows, segments, wheelCircumferenceMm, rideStartEpochMs);
  for (const p of points) {
    appendRideLog(
      rideId,
      new Date(p.wallClockMs).toISOString(),
      p.cumulativeDistanceMi,
      p.deviationSeconds,
      'replay'
    );
  }

  return rideId;
}
