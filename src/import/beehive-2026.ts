// 2026 Beehive Enduro — transcribed by hand from the organizer's route sheet
// and confirmation sheet (event date 2026-08-30). See the free-territory
// semantics this event actually uses (not the AMA_DEFAULTS formula):
//
//   - Every "RESET ... TO ..." / "... TO ..." span on the roll chart, and
//     the "FREE TIME" list on the confirmation sheet, is the SAME thing:
//     a no-secret-check zone. Mileage and key time both keep accruing
//     normally through it — "free" means no check can be planted there,
//     not that the clock stops or the average is waived.
//   - Free protection around gas is BEFORE the stop only, running through
//     the pump to the restart point. There is no after-gas grace: the
//     instant the odometer reads 0.00 in the next leg, checks are live
//     again.
//   - The two REAL odometer restarts (leaving Gas 1, leaving Gas 2) are
//     modeled with `isReset: true` on the segment right after them — this
//     is pace-engine.ts's own reset flag (zeroes displayed deviation for
//     that update), unrelated to the free-zone table below. The sheet
//     reuses the word "RESET" for both concepts; don't conflate them.
//
// The A/B split and the all-others split share everything through mile 6.40
// of leg 3 and diverge after. They're written out as two full routes rather
// than one branching one, since the schema has no notion of a branch.
//
// Every printed key time on both sheets is checked against these segments
// in beehive-2026.test.ts via validateKeyTimes() — that test is the reason
// to trust these numbers on ride day.

import { type Segment } from '../engine/pace-engine';
import { type FtZoneInput } from '../engine/free-territory';
import { type RouteSheetData, type KeyTimeCheckpoint } from './route-sheet';

const LEG1: Segment[] = [
  { distance: 9.20, speed: 24, isReset: false, isFree: false },
  { distance: 4.00, speed: 30, isReset: false, isFree: false },
  { distance: 7.20, speed: 24, isReset: false, isFree: false },
  { distance: 4.50, speed: 30, isReset: false, isFree: false },
  { distance: 16.00, speed: 24, isReset: false, isFree: false, label: 'Gas 1', checkType: 'gas' },
  { distance: 6.00, speed: 24, isReset: false, isFree: false, label: 'Gas 1 approach / restart' },
];

const LEG2: Segment[] = [
  { distance: 1.80, speed: 18, isReset: true, isFree: false, label: 'Restart after Gas 1 (odo 0.00)' },
  { distance: 4.50, speed: 30, isReset: false, isFree: false },
  { distance: 6.00, speed: 18, isReset: false, isFree: false },
  { distance: 4.50, speed: 30, isReset: false, isFree: false },
  { distance: 4.80, speed: 18, isReset: false, isFree: false },
  { distance: 4.50, speed: 18, isReset: false, isFree: false, label: 'Gas 2', checkType: 'gas' },
];

const LEG3_COMMON: Segment[] = [
  { distance: 2.40, speed: 24, isReset: true, isFree: false, label: 'Restart after Gas 2 (odo 0.00)' },
  { distance: 4.00, speed: 30, isReset: false, isFree: false },
];

const LEG3_AB_TAIL: Segment[] = [
  { distance: 6.80, speed: 24, isReset: false, isFree: false },
  { distance: 6.00, speed: 30, isReset: false, isFree: false },
  { distance: 12.80, speed: 24, isReset: false, isFree: false, label: 'Finish (K.C.) — A & B riders', checkType: 'finish' },
];

const LEG3_ALL_TAIL: Segment[] = [
  { distance: 16.00, speed: 24, isReset: false, isFree: false, label: 'Finish (K.C.) — All others', checkType: 'finish' },
];

// Free zones shared by every rider, in absolute course miles (leg offsets:
// leg 2 starts at 46.90, leg 3 starts at 73.00 — leg 1 + leg 2 totals).
const LEG1_LEN = 46.90;
const LEG2_LEN = 26.10;
const LEG2_OFFSET = LEG1_LEN;
const LEG3_OFFSET = LEG1_LEN + LEG2_LEN;

const SHARED_ZONES: FtZoneInput[] = [
  { start: 7.50, end: 8.22, reason: 'pre-check' },
  { start: 9.20, end: 9.25, reason: 'pre-check' },
  { start: 13.20, end: 16.20, reason: 'pre-check' },
  { start: 16.22, end: 17.78, reason: 'calibration' }, // the "Start/End Free Time" pond stop
  { start: 19.99, end: 20.32, reason: 'pre-check' },
  { start: 20.40, end: 20.81, reason: 'pre-check' },
  { start: 24.90, end: 28.03, reason: 'pre-check' },
  { start: 40.90, end: 46.90, reason: 'gas' }, // before/at Gas 1, through the restart point

  { start: LEG2_OFFSET + 1.34, end: LEG2_OFFSET + 1.66, reason: 'pre-check' },
  { start: LEG2_OFFSET + 1.90, end: LEG2_OFFSET + 2.02, reason: 'pre-check' },
  { start: LEG2_OFFSET + 6.30, end: LEG2_OFFSET + 11.14, reason: 'pre-check' },
  { start: LEG2_OFFSET + 12.40, end: LEG2_OFFSET + 12.72, reason: 'pre-check' },
  { start: LEG2_OFFSET + 16.80, end: LEG2_OFFSET + 20.05, reason: 'pre-check' },
  { start: LEG2_OFFSET + 21.60, end: LEG2_OFFSET + 26.10, reason: 'gas' }, // before/at Gas 2

  { start: LEG3_OFFSET + 1.51, end: LEG3_OFFSET + 1.61, reason: 'pre-check' },
  { start: LEG3_OFFSET + 2.50, end: LEG3_OFFSET + 2.92, reason: 'pre-check' },
  { start: LEG3_OFFSET + 6.41, end: LEG3_OFFSET + 10.41, reason: 'pre-check' },
  { start: LEG3_OFFSET + 12.71, end: LEG3_OFFSET + 12.72, reason: 'pre-check' },
];

// All-others-only: this zone falls after the split, on the leg the A/B
// riders don't ride.
const ALL_OTHERS_ONLY_ZONE: FtZoneInput = {
  start: LEG3_OFFSET + 21.45,
  end: LEG3_OFFSET + 21.82,
  reason: 'pre-check',
};

// Checkpoints shared by both splits (everything through the divergence at
// leg-3 mile 6.40 / absolute mile 79.40). afterMile is absolute course mile;
// keyTimeSeconds is seconds since the 9:00 key time.
const SHARED_CHECKPOINTS: KeyTimeCheckpoint[] = [
  { label: 'CHANGE 30 MPH', afterMile: 9.20, keyTimeSeconds: 23 * 60 },
  { label: 'CHANGE 24 MPH', afterMile: 13.20, keyTimeSeconds: 31 * 60 },
  { label: 'CHANGE 30 MPH', afterMile: 20.40, keyTimeSeconds: 49 * 60 },
  { label: 'CHANGE 24 MPH', afterMile: 24.90, keyTimeSeconds: 58 * 60 },
  { label: 'Gas 1', afterMile: 40.90, keyTimeSeconds: 98 * 60 }, // 10:38
  { label: 'restart, CHANGE 18 MPH', afterMile: LEG2_OFFSET + 0.00, keyTimeSeconds: 113 * 60 }, // 10:53
  { label: 'CHANGE 30 MPH', afterMile: LEG2_OFFSET + 1.80, keyTimeSeconds: 119 * 60 }, // 10:59
  { label: 'CHANGE 18 MPH', afterMile: LEG2_OFFSET + 6.30, keyTimeSeconds: 128 * 60 }, // 11:08
  { label: 'CHANGE 30 MPH', afterMile: LEG2_OFFSET + 12.30, keyTimeSeconds: 148 * 60 }, // 11:28
  { label: 'CHANGE 18 MPH', afterMile: LEG2_OFFSET + 16.80, keyTimeSeconds: 157 * 60 }, // 11:37
  { label: 'Gas 2', afterMile: LEG2_OFFSET + 21.60, keyTimeSeconds: 173 * 60 }, // 11:53
  { label: 'restart, CHANGE 30 MPH', afterMile: LEG3_OFFSET + 0.00, keyTimeSeconds: 188 * 60 }, // 12:08
  { label: 'CHANGE 24 MPH', afterMile: LEG3_OFFSET + 2.40, keyTimeSeconds: 194 * 60 }, // 12:14
  { label: 'CHANGE 30 MPH', afterMile: LEG3_OFFSET + 6.40, keyTimeSeconds: 202 * 60 }, // 12:22
];

export const BEEHIVE_2026_AB: RouteSheetData = {
  name: '2026 Beehive Enduro — A & B riders',
  eventDate: '2026-08-30',
  segments: [...LEG1, ...LEG2, ...LEG3_COMMON, ...LEG3_AB_TAIL],
  freeZones: SHARED_ZONES,
};

export const BEEHIVE_2026_AB_CHECKPOINTS: KeyTimeCheckpoint[] = [
  ...SHARED_CHECKPOINTS,
  { label: 'SPLIT, CHANGE 24 MPH', afterMile: LEG3_OFFSET + 13.20, keyTimeSeconds: 219 * 60 }, // 12:39
  { label: 'CHANGE 30 MPH', afterMile: LEG3_OFFSET + 19.20, keyTimeSeconds: 231 * 60 }, // 12:51
  { label: 'Finish (K.C.)', afterMile: LEG3_OFFSET + 32.00, keyTimeSeconds: 263 * 60 }, // 1:23 PM = 4h23m after 9:00
];

export const BEEHIVE_2026_ALL_OTHERS: RouteSheetData = {
  name: '2026 Beehive Enduro — All others',
  eventDate: '2026-08-30',
  segments: [...LEG1, ...LEG2, ...LEG3_COMMON, ...LEG3_ALL_TAIL],
  freeZones: [...SHARED_ZONES, ALL_OTHERS_ONLY_ZONE],
};

export const BEEHIVE_2026_ALL_OTHERS_CHECKPOINTS: KeyTimeCheckpoint[] = [
  ...SHARED_CHECKPOINTS,
  { label: 'Finish (K.C.)', afterMile: LEG3_OFFSET + 22.40, keyTimeSeconds: 242 * 60 }, // 1:02 PM = 4h2m after 9:00
];
