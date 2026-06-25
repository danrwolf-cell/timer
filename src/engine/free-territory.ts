import { type Segment } from './pace-engine';

// FtSegment is an alias of Segment — both engines read the same route rows.
export type FtSegment = Segment;

// -------------------------------------------------------------------------
// Rules parameters
// -------------------------------------------------------------------------

export interface FtRules {
  // Gate: if false (modern restart / national format), no secret checks are
  // used and every function returns empty / moot results.
  hasSecretChecks: boolean;

  // Miles of free territory AFTER any check (known or secret).
  milesAfterCheck: number;

  // Miles of free territory BEFORE a gas stop.
  milesBeforeGas: number;

  // Miles of free territory AFTER a gas stop.
  milesAfterGas: number;

  // Miles of calibration zone from the very start of the course.
  // Secret checks are forbidden inside this window.
  ftCalibrationMile: number;
}

// AMA-traditional defaults per AHRMA/AMA enduro rulebooks.
export const AMA_DEFAULTS: FtRules = {
  hasSecretChecks: true,
  milesAfterCheck: 3,
  milesBeforeGas: 2,
  milesAfterGas: 3,
  ftCalibrationMile: 2.9,
};

// -------------------------------------------------------------------------
// Event extraction
// -------------------------------------------------------------------------

export type EventType = 'start' | 'check' | 'gas' | 'finish';

export interface CourseEvent {
  type: EventType;
  mile: number; // absolute course mileage at which the event occurs
  label?: string;
}

/**
 * Walk segments and emit events at their cumulative end-mile positions.
 * The start-of-course is always emitted at mile 0.
 * checkType on a segment describes the event at the END of that segment.
 */
export function deriveEvents(segments: FtSegment[]): CourseEvent[] {
  const events: CourseEvent[] = [{ type: 'start', mile: 0 }];
  let mile = 0;
  for (const seg of segments) {
    mile += seg.distance;
    if (!seg.checkType) continue;
    switch (seg.checkType) {
      case 'known':
      case 'secret':
      case 'emergency':
        events.push({ type: 'check', mile, label: seg.label });
        break;
      case 'gas':
        events.push({ type: 'gas', mile, label: seg.label });
        break;
      case 'finish':
        events.push({ type: 'finish', mile, label: seg.label });
        break;
      // 'start' on a mid-course segment is unusual but silently ignored here;
      // the course start is always mile 0.
    }
  }
  return events;
}

export function courseLength(segments: FtSegment[]): number {
  return segments.reduce((acc, s) => acc + s.distance, 0);
}

// -------------------------------------------------------------------------
// Interval types
// -------------------------------------------------------------------------

export interface FtInterval {
  start: number; // miles, inclusive
  end: number;   // miles, inclusive
  reasons: string[]; // which rules contributed this interval
}

// -------------------------------------------------------------------------
// Per-rule interval generators
// -------------------------------------------------------------------------

/**
 * Raw free intervals from each rule, before merging.
 * All intervals are clamped to [0, totalMiles].
 */
export function freeIntervals(
  segments: FtSegment[],
  rules: FtRules
): FtInterval[] {
  if (!rules.hasSecretChecks) return [];

  const total = courseLength(segments);
  const events = deriveEvents(segments);
  const intervals: FtInterval[] = [];

  function clampedInterval(start: number, end: number, reason: string): FtInterval {
    return {
      start: Math.max(0, start),
      end: Math.min(total, end),
      reasons: [reason],
    };
  }

  // Calibration zone from start
  if (rules.ftCalibrationMile > 0) {
    intervals.push(clampedInterval(0, rules.ftCalibrationMile, 'calibration'));
  }

  for (const ev of events) {
    if (ev.type === 'check') {
      // Free territory after every check (known, secret, emergency)
      intervals.push(
        clampedInterval(ev.mile, ev.mile + rules.milesAfterCheck, `after-check@${ev.mile}`)
      );
    } else if (ev.type === 'gas') {
      // Free territory before gas
      intervals.push(
        clampedInterval(ev.mile - rules.milesBeforeGas, ev.mile, `before-gas@${ev.mile}`)
      );
      // Free territory after gas
      intervals.push(
        clampedInterval(ev.mile, ev.mile + rules.milesAfterGas, `after-gas@${ev.mile}`)
      );
    }
  }

  // Filter out zero-length intervals (can happen at course boundaries)
  return intervals.filter(i => i.end > i.start);
}

// -------------------------------------------------------------------------
// Merge overlapping intervals, joining reasons
// -------------------------------------------------------------------------

export function mergeIntervals(intervals: FtInterval[]): FtInterval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: FtInterval[] = [{ ...sorted[0], reasons: [...sorted[0].reasons] }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.start <= last.end) {
      // Overlapping or touching — extend and merge reasons
      last.end = Math.max(last.end, current.end);
      for (const r of current.reasons) {
        if (!last.reasons.includes(r)) last.reasons.push(r);
      }
    } else {
      merged.push({ ...current, reasons: [...current.reasons] });
    }
  }

  return merged;
}

// -------------------------------------------------------------------------
// Top-level derived views
// -------------------------------------------------------------------------

/** Merged green zones where a secret check would be rules-illegal. */
export function freeTerritory(segments: FtSegment[], rules: FtRules): FtInterval[] {
  return mergeIntervals(freeIntervals(segments, rules));
}

/**
 * Amber gaps between the free zones — where a secret check COULD legally sit.
 * These are the intervals not covered by any free-territory rule.
 * Clamped to [0, courseLength].
 */
export function checkableTerritory(segments: FtSegment[], rules: FtRules): FtInterval[] {
  if (!rules.hasSecretChecks) return [];

  const total = courseLength(segments);
  const free = freeTerritory(segments, rules);

  if (free.length === 0) return [{ start: 0, end: total, reasons: ['uncovered'] }];

  const checkable: FtInterval[] = [];
  let cursor = 0;

  for (const zone of free) {
    if (cursor < zone.start) {
      checkable.push({ start: cursor, end: zone.start, reasons: ['checkable'] });
    }
    cursor = zone.end;
  }

  if (cursor < total) {
    checkable.push({ start: cursor, end: total, reasons: ['checkable'] });
  }

  return checkable;
}

/** Point query: is this mile inside free territory? */
export function freeTerritoryAt(
  mile: number,
  segments: FtSegment[],
  rules: FtRules
): boolean {
  if (!rules.hasSecretChecks) return false;
  return freeTerritory(segments, rules).some(z => mile >= z.start && mile <= z.end);
}
