// 2026 Michaux Enduro — transcribed by hand from the organizer's
// confirmation sheet (MICHAUX_CONFIRMATION_26.pdf). Stopgap for when the
// scan pipeline isn't available (e.g. out of Anthropic API credit) — same
// contract as beehive-2026.ts: every printed key time is re-derived from
// these segments in michaux-2026.test.ts via validateKeyTimes(), which is
// the reason to trust these numbers on ride day.
//
// The sheet prints as two side-by-side columns, but it is ONE continuous
// 81.40-mile route, not a rider-class split: column 2 is the continuation
// of column 1 after the gas stop. Proof is exact — column 1 ends "29.40
// GAS AVAILABLE KT 10:49" -> "PAUSE 21 MINS." -> odometer restart to 0.00,
// and column 2 opens "0.00 18MPH KT 11:10": 10:49 + 21 min = 11:10 on the
// nose. Only column 2 carries a finish ("OBV CK"). See route-scan-prompt.ts
// for the general form of this pattern.
//
// "RESET" on this sheet means one of two things, distinguished by the two
// numbers (see route-scan-prompt.ts):
//   - second number BIGGER than the first: a free zone (no-check zone),
//     e.g. "0.10 RESET 1.63" -> free zone [0.10, 1.63].
//   - second number SMALLER (only "29.40 RESET 0.00", at the gas stop):
//     the rider's trip odometer physically restarts. Modeled with
//     isReset: true on the segment right after it.
//
// PAUSE lines (e.g. "21.00 PAUSE 10 MINS.") are zero-distance, isFree
// segments carrying holdSeconds — real time the printed key times already
// include, not a break in the ride and not a free zone (see
// pace-engine.ts's Segment.holdSeconds).
//
// Mileage below is written as printed on the sheet (odometer-style,
// restarting at the gas stop); COL2_OFFSET converts column 2's own
// mileage into absolute course miles for free zones and checkpoints.

import { type Segment } from '../engine/pace-engine';
import { type FtZoneInput } from '../engine/free-territory';
import { type RouteSheetData, type KeyTimeCheckpoint } from './route-sheet';

const pause = (holdSeconds: number, label: string): Segment => ({
  distance: 0, speed: null, isReset: false, isFree: true, holdSeconds, label,
});

// ---------------------------------------------------------------------------
// Column 1: mile 0.0 to 29.40 (odometer), KT 9:00 start.

const COLUMN1: Segment[] = [
  { distance: 9.30, speed: 18, isReset: false, isFree: false },
  { distance: 2.30, speed: 23, isReset: false, isFree: false },
  { distance: 0.70, speed: 14, isReset: false, isFree: false },
  { distance: 2.40, speed: 18, isReset: false, isFree: false },
  { distance: 4.00, speed: 24, isReset: false, isFree: false, label: 'KC', checkType: 'known' },
  { distance: 2.30, speed: 24, isReset: false, isFree: false },
  pause(600, 'Pause'), // 10 MINS. at mile 21.00
  { distance: 0.90, speed: 24, isReset: false, isFree: false },
  { distance: 4.80, speed: 12, isReset: false, isFree: false },
  { distance: 2.70, speed: 18, isReset: false, isFree: false, label: 'Gas', checkType: 'gas' },
  pause(1260, 'Gas pause'), // 21 MINS. at mile 29.40
];

const COL1_FREE_ZONES: FtZoneInput[] = [
  { start: 0.10, end: 1.63 },
  { start: 6.40, end: 8.56 },
  { start: 13.50, end: 13.53 },
  { start: 18.80, end: 21.90 },
  { start: 26.35, end: 26.70 },
  { start: 26.98, end: 27.18 },
];

const COL1_CHECKPOINTS: KeyTimeCheckpoint[] = [
  { label: 'CHANGE 23 MPH', afterMile: 9.30, keyTimeSeconds: 31 * 60 },   // 9:31
  { label: 'CHANGE 14 MPH', afterMile: 11.60, keyTimeSeconds: 37 * 60 }, // 9:37
  { label: 'CHANGE 18 MPH', afterMile: 12.30, keyTimeSeconds: 40 * 60 }, // 9:40
  { label: 'CHANGE 24 MPH', afterMile: 14.70, keyTimeSeconds: 48 * 60 }, // 9:48
  { label: 'KC', afterMile: 18.70, keyTimeSeconds: 58 * 60 },            // 9:58
  { label: 'CHANGE 12 MPH', afterMile: 21.90, keyTimeSeconds: 76 * 60 }, // 10:16
  { label: 'CHANGE 18 MPH', afterMile: 26.70, keyTimeSeconds: 100 * 60 }, // 10:40
  { label: 'Gas Available', afterMile: 29.40, keyTimeSeconds: 109 * 60 }, // 10:49
];

// ---------------------------------------------------------------------------
// Column 2: continuation after the gas restart. Odometer relative to its
// own 0.00; COL2_OFFSET (= column 1's total distance) converts to absolute
// course miles. Column 2's own opening "0.00 18MPH KT 11:10" isn't its own
// checkpoint — see route-scan-prompt.ts's "continuation column's own
// opening KT" note — it just confirms the pause above is the right length
// (10:49 + 21 min = 11:10, which the running total below reproduces).

const COL2_OFFSET = 29.40;

const COLUMN2: Segment[] = [
  // First segment after the restart carries isReset — matches the physical
  // odometer having just been zeroed at the gas stop.
  { distance: 4.80, speed: 18, isReset: true, isFree: false, label: 'Restart after gas (odo 0.00)' },
  { distance: 3.60, speed: 36, isReset: false, isFree: false },
  { distance: 2.60, speed: 18, isReset: false, isFree: false },
  pause(60, 'Pause'), // 1 MIN. at 11.00
  { distance: 2.03, speed: 18, isReset: false, isFree: false },
  pause(60, 'Pause'), // 1 MIN. at 13.03
  { distance: 6.17, speed: 18, isReset: false, isFree: false },
  { distance: 7.62, speed: 24, isReset: false, isFree: false },
  pause(60, 'Pause'), // 1 MIN. at 26.82
  { distance: 6.28, speed: 24, isReset: false, isFree: false },
  pause(180, 'Pause'), // 3 MINS. at 33.10
  { distance: 2.10, speed: 24, isReset: false, isFree: false },
  { distance: 1.60, speed: 12, isReset: false, isFree: false },
  { distance: 0.02, speed: 24, isReset: false, isFree: false },
  pause(60, 'Pause'), // 1 MIN. at 36.82
  { distance: 12.00, speed: 24, isReset: false, isFree: false },
  pause(240, 'Pause'), // 4 MINS. at 48.82
  { distance: 3.18, speed: 24, isReset: false, isFree: false, label: 'Finish (OBV CK)', checkType: 'finish' },
];

const COL2_FREE_ZONES: FtZoneInput[] = [
  { start: 0.10, end: 1.63 },
  { start: 7.51, end: 7.60 },
  { start: 7.85, end: 10.95 },
  { start: 16.21, end: 19.47 },
  { start: 28.82, end: 32.80 },
  { start: 41.36, end: 45.20 },
  { start: 49.27, end: 50.90 },
].map(z => ({ start: z.start + COL2_OFFSET, end: z.end + COL2_OFFSET }));

const COL2_CHECKPOINTS: KeyTimeCheckpoint[] = [
  { label: 'CHANGE 36 MPH', afterMile: 4.80, keyTimeSeconds: 146 * 60 },  // 11:26
  { label: 'CHANGE 18 MPH', afterMile: 8.40, keyTimeSeconds: 152 * 60 },  // 11:32
  { label: 'CHANGE 24 MPH', afterMile: 19.20, keyTimeSeconds: 190 * 60 }, // 12:10
  { label: 'CHANGE 12 MPH', afterMile: 35.20, keyTimeSeconds: 234 * 60 }, // 12:54
  { label: 'CHANGE 24 MPH', afterMile: 36.80, keyTimeSeconds: 242 * 60 }, // 1:02
  { label: 'Finish (OBV CK)', afterMile: 52.00, keyTimeSeconds: 285 * 60 }, // 1:45
].map(c => ({ ...c, afterMile: c.afterMile + COL2_OFFSET }));

// ---------------------------------------------------------------------------

export const MICHAUX_2026: RouteSheetData = {
  name: '2026 Michaux Enduro',
  segments: [...COLUMN1, ...COLUMN2],
  freeZones: [...COL1_FREE_ZONES, ...COL2_FREE_ZONES],
};

export const MICHAUX_2026_CHECKPOINTS: KeyTimeCheckpoint[] = [...COL1_CHECKPOINTS, ...COL2_CHECKPOINTS];
