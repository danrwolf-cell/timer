// Pure route-sheet types plus the validation gate that earns a transcribed
// sheet the right to be trusted. No DB or platform imports here — the same
// discipline as the engine layer — so this stays unit-testable without a
// SQLite binding. The DB-writing half lives in import-route.ts.
//
// A route sheet like this is transcribed once, by hand, from the organizer's
// PDF. There is no OCR or column-heuristic parser here — that's future work
// (see docs/BUILD-PLAN.md). What this module guarantees is that a
// transcription error doesn't silently ship: every printed key time on the
// sheet becomes a KeyTimeCheckpoint, and validateKeyTimes() re-derives each
// one from the segments using the same computeKeyTime the live engine runs.
// A mistyped distance or speed throws before the route ever reaches the DB.

import { detectSegment, computeKeyTime, type Segment } from '../engine/pace-engine';
import { type FtZoneInput } from '../engine/free-territory';

export interface RouteSheetData {
  name: string;
  eventDate?: string;
  segments: Segment[];
  freeZones: FtZoneInput[];
}

/**
 * One printed key time from the sheet: "at this cumulative course mile, the
 * sheet says the key time is this many seconds since the 9:00-style start."
 */
export interface KeyTimeCheckpoint {
  label: string;
  afterMile: number;
  keyTimeSeconds: number;
}

/**
 * Re-derives key time at every checkpoint's mileage and compares it to what
 * the sheet printed. Throws listing every mismatch (not just the first) if
 * any checkpoint is off by more than `toleranceSeconds` — the sheet's own
 * printed numbers are the ground truth a transcription has to reproduce.
 */
export function validateKeyTimes(
  segments: Segment[],
  checkpoints: KeyTimeCheckpoint[],
  toleranceSeconds = 1
): void {
  const mismatches: string[] = [];
  for (const cp of checkpoints) {
    const pos = detectSegment(segments, cp.afterMile);
    const kt = computeKeyTime(segments, pos.segmentIndex, pos.distanceInSegment);
    if (Math.abs(kt - cp.keyTimeSeconds) > toleranceSeconds) {
      mismatches.push(
        `${cp.label} @ mile ${cp.afterMile}: computed ${kt.toFixed(1)}s, sheet says ${cp.keyTimeSeconds}s`
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Route sheet key-time validation failed:\n${mismatches.join('\n')}`);
  }
}
