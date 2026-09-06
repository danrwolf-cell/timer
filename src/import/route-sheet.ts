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

/** Per-checkpoint result of re-deriving key time and comparing to the sheet. */
export interface CheckpointResult {
  label: string;
  afterMile: number;
  sheetKeyTimeSeconds: number;
  computedKeyTimeSeconds: number;
  deltaSeconds: number;
  passed: boolean;
}

/**
 * Re-derives key time at every checkpoint's mileage using the same
 * computeKeyTime the live engine runs, and reports how each compares to
 * what the sheet printed. Never throws — this is the non-fatal form, used
 * by a review UI that wants to show every checkpoint's status rather than
 * abort on the first mismatch. `validateKeyTimes` below is the throwing
 * wrapper for callers (and tests) that just want a pass/fail gate.
 */
export function checkKeyTimes(
  segments: Segment[],
  checkpoints: KeyTimeCheckpoint[],
  toleranceSeconds = 1
): CheckpointResult[] {
  return checkpoints.map(cp => {
    const pos = detectSegment(segments, cp.afterMile);
    const computed = computeKeyTime(segments, pos.segmentIndex, pos.distanceInSegment);
    const deltaSeconds = computed - cp.keyTimeSeconds;
    return {
      label: cp.label,
      afterMile: cp.afterMile,
      sheetKeyTimeSeconds: cp.keyTimeSeconds,
      computedKeyTimeSeconds: computed,
      deltaSeconds,
      passed: Math.abs(deltaSeconds) <= toleranceSeconds,
    };
  });
}

/**
 * Throws listing every mismatch (not just the first) if any checkpoint is
 * off by more than `toleranceSeconds` — the sheet's own printed numbers are
 * the ground truth a transcription (by hand or by extraction) has to
 * reproduce.
 */
export function validateKeyTimes(
  segments: Segment[],
  checkpoints: KeyTimeCheckpoint[],
  toleranceSeconds = 1
): void {
  const mismatches = checkKeyTimes(segments, checkpoints, toleranceSeconds)
    .filter(r => !r.passed)
    .map(r => `${r.label} @ mile ${r.afterMile}: computed ${r.computedKeyTimeSeconds.toFixed(1)}s, sheet says ${r.sheetKeyTimeSeconds}s`);
  if (mismatches.length > 0) {
    throw new Error(`Route sheet key-time validation failed:\n${mismatches.join('\n')}`);
  }
}
