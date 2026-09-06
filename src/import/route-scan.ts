// Types and pure conversion logic for scanning a route sheet (photo or PDF)
// into RouteSheetData. No RN, Anthropic SDK, or DB imports — safe for both
// the phone app and the extraction server (server/) to depend on directly.
//
// The extraction model's job is deliberately narrow: read the document and
// report raw facts — segments in ride order, free-zone mile ranges, and
// every printed checkpoint as (mile, label, clock-time string). It does no
// arithmetic. All computation — clock-time-to-seconds conversion and
// checking every checkpoint against computeKeyTime() — happens here, in
// deterministic code, then gets run again through checkKeyTimes(). The
// model proposes; the engine disposes, same as a hand-transcribed sheet.
//
// The server's Zod schema (server/src/schema.ts) mirrors ExtractedRouteSheet
// below and must be kept in sync by hand — small, changes rarely, and
// keeping it a plain mirror rather than a codegen step is the tradeoff
// between two runtimes without a shared build step.

import { type CheckType, type Segment } from '../engine/pace-engine';
import { type FtZoneInput } from '../engine/free-territory';
import { type RouteSheetData, type KeyTimeCheckpoint } from './route-sheet';

export interface ExtractedSegment {
  distanceMi: number;
  speedMph: number | null; // null = free/transfer, no required pace
  isFree: boolean;
  isReset: boolean;
  label: string | null;
  checkType: CheckType | null;
}

export interface ExtractedFreeZone {
  startMi: number; // cumulative course mile
  endMi: number;
  reason: string | null;
}

export interface ExtractedCheckpoint {
  label: string;
  afterMile: number; // cumulative course mile — the running total of segments up to here
  clockTime: string; // as printed, e.g. "9:23" or "1:23" — no AM/PM marker
}

export interface ExtractedRouteSheet {
  routeName: string;
  eventDate: string | null;
  startClockTime: string; // e.g. "9:00"
  segments: ExtractedSegment[];
  freeZones: ExtractedFreeZone[];
  checkpoints: ExtractedCheckpoint[];
}

/**
 * Resolves a sequence of bare "H:MM" clock strings (as printed on a route
 * sheet — 12-hour, no AM/PM marker) against a start time, into seconds
 * elapsed since that start.
 *
 * Route sheets read straight across noon without marking it (Beehive's own
 * confirmation sheet goes 11:53 -> 12:08 -> 12:39 -> 1:23 with no AM/PM
 * anywhere). So each successive time is assumed to be no earlier than the
 * one before it, wrapping forward by 12 hours whenever the literal reading
 * would otherwise go backwards. A one-day ride never spans 24 hours, so one
 * wrap per checkpoint is always enough.
 */
export function clockTimesToSecondsSinceStart(
  startClockTime: string,
  clockTimes: string[]
): number[] {
  const parse = (s: string): number => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) throw new Error(`Unparseable clock time: "${s}"`);
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 12 || min > 59) throw new Error(`Clock time out of range: "${s}"`);
    return h * 60 + min; // minutes since the top of a 12-hour cycle
  };

  const startMin = parse(startClockTime);
  let prevAbsolute = startMin;
  const out: number[] = [];
  for (const ct of clockTimes) {
    let m = parse(ct);
    while (m < prevAbsolute) m += 12 * 60;
    out.push((m - startMin) * 60);
    prevAbsolute = m;
  }
  return out;
}

/** Converts a raw extraction into RouteSheetData + KeyTimeCheckpoint[], ready for checkKeyTimes()/validateKeyTimes(). */
export function toRouteSheetData(extracted: ExtractedRouteSheet): {
  routeSheet: RouteSheetData;
  checkpoints: KeyTimeCheckpoint[];
} {
  const segments: Segment[] = extracted.segments.map(s => ({
    distance: s.distanceMi,
    speed: s.isFree ? null : s.speedMph,
    isReset: s.isReset,
    isFree: s.isFree,
    label: s.label ?? undefined,
    checkType: s.checkType ?? undefined,
  }));

  const freeZones: FtZoneInput[] = extracted.freeZones.map(z => ({
    start: z.startMi,
    end: z.endMi,
    reason: z.reason ?? undefined,
  }));

  const seconds = clockTimesToSecondsSinceStart(
    extracted.startClockTime,
    extracted.checkpoints.map(c => c.clockTime)
  );

  const checkpoints: KeyTimeCheckpoint[] = extracted.checkpoints.map((c, i) => ({
    label: c.label,
    afterMile: c.afterMile,
    keyTimeSeconds: seconds[i],
  }));

  return {
    routeSheet: { name: extracted.routeName, eventDate: extracted.eventDate ?? undefined, segments, freeZones },
    checkpoints,
  };
}
