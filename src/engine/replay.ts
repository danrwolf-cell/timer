import { parseCscNotification, type CscState } from '../ble/csc-parser';
import {
  detectSegment,
  computeKeyTime,
  computeDeviation,
  type Segment,
} from './pace-engine';

export interface RawCscRow {
  wall_clock_ms: number;
  cumulative_revs: number;
  wheel_event_time: number;
}

export interface ReplayPoint {
  wallClockMs: number;
  cumulativeDistanceMi: number;
  deviationSeconds: number;
  speedMph: number;
}

export interface ReplayResult {
  points: ReplayPoint[];
  // The final cscState after processing all rows, exposed for multi-segment
  // corpus stitching and firmware cross-validation.
  finalCscState: CscState | null;
}

/**
 * Feed a raw_csc_log corpus through the TS parser and pace engine.
 *
 * This is the golden-reference runner. The C firmware processes the same
 * (cumulative_revs, wheel_event_time) sequence and should produce identical
 * deviationSeconds at each wall_clock_ms. Row-by-row comparison between
 * this output and the firmware's log is the cross-validation step.
 *
 * Null-update rows (first packet, zero time delta, power-cycle re-baseline)
 * do not produce a ReplayPoint but still advance cscState, which is exactly
 * what the firmware must also do.
 */
export function replayRide(
  rows: RawCscRow[],
  segments: Segment[],
  wheelCircumferenceMm: number,
  rideStartMs: number
): ReplayResult {
  let cscState: CscState | null = null;
  let cumulativeDistanceMi = 0;
  const points: ReplayPoint[] = [];

  for (const row of rows) {
    // Reconstruct the 7-byte CSC packet from decoded fields so we reuse the
    // exact same parser code path (including all guards and clamps) rather
    // than calling a separate "already-decoded" code path. This keeps the
    // replay surface identical to the live path.
    const packet = new Uint8Array(7);
    packet[0] = 0x01; // wheel revolution data present
    packet[1] = row.cumulative_revs & 0xff;
    packet[2] = (row.cumulative_revs >> 8) & 0xff;
    packet[3] = (row.cumulative_revs >> 16) & 0xff;
    packet[4] = (row.cumulative_revs >> 24) & 0xff;
    packet[5] = row.wheel_event_time & 0xff;
    packet[6] = (row.wheel_event_time >> 8) & 0xff;

    const { state, update } = parseCscNotification(packet, cscState, wheelCircumferenceMm);
    cscState = state;

    if (!update) continue;

    cumulativeDistanceMi +=
      (update.deltaRevolutions * wheelCircumferenceMm) / 1000 / 1609.34;

    const elapsedSeconds = (row.wall_clock_ms - rideStartMs) / 1000;
    const position = detectSegment(segments, cumulativeDistanceMi);
    const keyTime = computeKeyTime(segments, position.segmentIndex, position.distanceInSegment);
    const deviationSeconds = computeDeviation(elapsedSeconds, keyTime);

    points.push({
      wallClockMs: row.wall_clock_ms,
      cumulativeDistanceMi,
      deviationSeconds,
      speedMph: update.speedMph,
    });
  }

  return { points, finalCscState: cscState };
}
