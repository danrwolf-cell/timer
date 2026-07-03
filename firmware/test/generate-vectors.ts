/*
 * Golden-vector generator for the C port of the pace engine and CSC parser.
 *
 * Runs the TypeScript golden-reference modules (src/engine/pace-engine.ts,
 * src/ble/csc-parser.ts, src/engine/replay.ts) over a battery of cases —
 * mirroring the Jest suites plus signed-assembly edge cases — and emits
 * firmware/test/vectors.h as C arrays of inputs and expected outputs.
 *
 * Regenerate with `make vectors` in firmware/test (compiles this file with
 * the project tsc, then runs it under node). The generated header is checked
 * in so the C tests can run without a Node toolchain.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseCscNotification, type CscState } from '../../src/ble/csc-parser';
import {
  detectSegment,
  computeKeyTime,
  isInFreeSegment,
  crossedReset,
  type Segment,
} from '../../src/engine/pace-engine';
import { replayRide, type RawCscRow } from '../../src/engine/replay';
import {
  crc16,
  packRouteSheet,
  parseDeviceStatus,
  parseRideLogPacket,
  rideLogCrc,
  PROTOCOL_VERSION,
} from '../../src/ble/device-protocol';

// ---------------------------------------------------------------------------
// Emission helpers

function dbl(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`non-finite double: ${x}`);
  const s = x.toString(); // shortest round-trip decimal — exact under strtod
  return /[.e]/.test(s) ? s : `${s}.0`;
}

function i64(x: number): string {
  if (!Number.isSafeInteger(x)) throw new Error(`unsafe int64: ${x}`);
  return `${x}LL`;
}

function boolc(b: boolean): string {
  return b ? 'true' : 'false';
}

// ---------------------------------------------------------------------------
// CSC parser vectors

function buildPacket(revolutions: number, eventTime: number): Uint8Array {
  return new Uint8Array([
    0x01,
    revolutions & 0xff,
    (revolutions >> 8) & 0xff,
    (revolutions >> 16) & 0xff,
    (revolutions >> 24) & 0xff,
    eventTime & 0xff,
    (eventTime >> 8) & 0xff,
  ]);
}

interface CscCase {
  comment: string;
  bytes: number[]; // packet, possibly short or without wheel flag
  hasPrev: boolean;
  prev: CscState; // ignored if !hasPrev
}

function emitCscCase(c: CscCase): string {
  const { state, update } = parseCscNotification(
    Uint8Array.from(c.bytes),
    c.hasPrev ? c.prev : null
  );
  const bytes = [...c.bytes];
  while (bytes.length < 8) bytes.push(0);
  return (
    `  /* ${c.comment} */\n` +
    `  { .len = ${c.bytes.length}, .bytes = {${bytes.join(', ')}},\n` +
    `    .has_prev = ${boolc(c.hasPrev)}, .prev_revs = ${i64(c.prev.cumulativeRevolutions)}, .prev_time = ${c.prev.lastEventTime},\n` +
    `    .exp_revs = ${i64(state.cumulativeRevolutions)}, .exp_time = ${state.lastEventTime},\n` +
    `    .has_update = ${boolc(update !== null)},\n` +
    `    .exp_speed_mph = ${dbl(update?.speedMph ?? 0)}, .exp_delta_revs = ${i64(update?.deltaRevolutions ?? 0)}, .exp_delta_time_s = ${dbl(update?.deltaTimeSeconds ?? 0)} },`
  );
}

// A live sequence: state produced by each step becomes prev of the next.
// Exercises first-packet, steady updates, no-wheel-data, zero-dt, 16-bit
// timestamp rollover, power-cycle, recovery, speed clamp, and the signed
// 32-bit counter assembly quirk (values >= 2^31 assemble negative in JS —
// the C port must reproduce this bit-for-bit).
function buildCscSequence(): CscCase[] {
  const packets: Array<{ comment: string; bytes: number[] }> = [
    { comment: 'first packet, no prev state', bytes: [...buildPacket(100, 1024)] },
    { comment: 'steady: 6 revs / 1 s', bytes: [...buildPacket(106, 2048)] },
    { comment: 'steady: 6 revs / 1 s', bytes: [...buildPacket(112, 3072)] },
    { comment: 'no wheel data flag — ignored, state unchanged', bytes: [0x00, 0, 0, 0, 0, 0, 0] },
    { comment: 'zero time delta — null update', bytes: [...buildPacket(112, 3072)] },
    { comment: '16-bit timestamp rollover: 3072 -> 200', bytes: [...buildPacket(118, 200)] },
    { comment: 'power-cycle: counter drops 118 -> 2', bytes: [...buildPacket(2, 1224)] },
    { comment: 'recovery after power-cycle', bytes: [...buildPacket(8, 2248)] },
    { comment: 'implausible delta — speed clamp discards, state advances', bytes: [...buildPacket(2000, 3272)] },
    { comment: 'jump to 0x7FFFFFF0 — clamp again, state at int32 max region', bytes: [...buildPacket(0x7ffffff0, 4296)] },
    { comment: '0x80000010 assembles NEGATIVE (JS signed |) -> treated as power-cycle', bytes: [...buildPacket(0x80000010, 5320)] },
    { comment: 'negative-state arithmetic: 6 revs / 1 s from negative baseline', bytes: [...buildPacket(0x80000016, 6344)] },
  ];

  const cases: CscCase[] = [];
  let state: CscState | null = null;
  for (const p of packets) {
    cases.push({
      comment: p.comment,
      bytes: p.bytes,
      hasPrev: state !== null,
      prev: state ?? { cumulativeRevolutions: 0, lastEventTime: 0 },
    });
    state = parseCscNotification(Uint8Array.from(p.bytes), state).state;
  }
  return cases;
}

// Direct cases with hand-constructed prev states (mirrors the Jest suite,
// including the genuine-rollover branch which is only reachable with a
// positive prev >= 0xFF000000).
function buildCscDirectCases(): CscCase[] {
  return [
    {
      comment: 'genuine 32-bit rollover: prev 0xFFFFFFF0 -> 5, delta 21',
      bytes: [...buildPacket(5, 2048)],
      hasPrev: true,
      prev: { cumulativeRevolutions: 0xfffffff0, lastEventTime: 1024 },
    },
    {
      comment: 'power-cycle: 50000 -> 0, re-baseline',
      bytes: [...buildPacket(0, 2048)],
      hasPrev: true,
      prev: { cumulativeRevolutions: 50000, lastEventTime: 1024 },
    },
    {
      comment: 'speed clamp: 1000 revs / 1 s',
      bytes: [...buildPacket(1000, 1024)],
      hasPrev: true,
      prev: { cumulativeRevolutions: 0, lastEventTime: 0 },
    },
    {
      comment: 'basic speed: 10 revs / 1 s = ~48.8 mph',
      bytes: [...buildPacket(10, 1024)],
      hasPrev: true,
      prev: { cumulativeRevolutions: 0, lastEventTime: 0 },
    },
    {
      comment: 'timestamp rollover: 65000 -> 500, dt 1036 ticks',
      bytes: [...buildPacket(110, 500)],
      hasPrev: true,
      prev: { cumulativeRevolutions: 100, lastEventTime: 65000 },
    },
    {
      comment: 'short packet (len 3) — state = prev, no update',
      bytes: [0x01, 5, 0],
      hasPrev: true,
      prev: { cumulativeRevolutions: 42, lastEventTime: 7 },
    },
    {
      comment: 'realistic enduro: 6 revs / 1 s = ~29.3 mph',
      bytes: [...buildPacket(6, 1024)],
      hasPrev: true,
      prev: { cumulativeRevolutions: 0, lastEventTime: 0 },
    },
  ];
}

// ---------------------------------------------------------------------------
// Pace engine vectors

const PACE_SEGMENTS: Segment[] = [
  { distance: 1.0, speed: 30, isReset: false, isFree: false },
  { distance: 0.25, speed: null, isReset: false, isFree: true },
  { distance: 1.0, speed: 24, isReset: true, isFree: false },
  // isFree with a speed set — locks the free-overrides-speed branch
  { distance: 0.5, speed: 18, isReset: false, isFree: true },
  { distance: 2.0, speed: 36, isReset: true, isFree: false },
];

const PACE_DISTANCES = [
  0, 0.5, 1.0, 1.0000001, 1.1, 1.25, 1.26, 2.0, 2.25, 2.3, 2.75, 3.0,
  4.75, 4.7500001, 5.0, 6.0, 10.0,
];

const CROSSED_RESET_CASES: Array<[number, number]> = [
  [0, 0], [0, 1], [1, 2], [0, 2], [0, 4], [2, 3], [3, 4], [2, 1], [4, 4], [1, 4],
];

function emitPaceSegments(): string {
  return PACE_SEGMENTS.map(
    s =>
      `  { .distance = ${dbl(s.distance)}, .speed = ${dbl(s.speed ?? 0)}, .has_speed = ${boolc(s.speed !== null)}, .is_reset = ${boolc(s.isReset)}, .is_free = ${boolc(s.isFree)} },`
  ).join('\n');
}

function emitPaceCases(): string {
  return PACE_DISTANCES.map(d => {
    const pos = detectSegment(PACE_SEGMENTS, d);
    const keyTime = computeKeyTime(PACE_SEGMENTS, pos.segmentIndex, pos.distanceInSegment);
    const inFree = isInFreeSegment(PACE_SEGMENTS, pos.segmentIndex);
    return `  { .cumulative_distance = ${dbl(d)}, .exp_segment_index = ${pos.segmentIndex}, .exp_distance_in_segment = ${dbl(pos.distanceInSegment)}, .exp_key_time = ${dbl(keyTime)}, .exp_in_free = ${boolc(inFree)} },`;
  }).join('\n');
}

function emitCrossedResetCases(): string {
  return CROSSED_RESET_CASES.map(([prev, cur]) => {
    const result = crossedReset(PACE_SEGMENTS, prev, cur);
    return `  { .prev_index = ${prev}, .current_index = ${cur}, .expected = ${boolc(result)} },`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// End-to-end replay vectors (mirrors replay.test.ts corpora)

function buildCorpus(opts: {
  revPerSec: number;
  durationSec: number;
  startRevs?: number;
  startTimeMs?: number;
  startEventTime?: number;
}): RawCscRow[] {
  const { revPerSec, durationSec, startRevs = 0, startTimeMs = 0, startEventTime = 0 } = opts;
  const rows: RawCscRow[] = [];
  for (let i = 0; i < durationSec; i++) {
    rows.push({
      wall_clock_ms: startTimeMs + i * 1000,
      cumulative_revs: (startRevs + i * revPerSec) >>> 0,
      wheel_event_time: (startEventTime + i * 1024) & 0xffff,
    });
  }
  return rows;
}

const REPLAY_SEGMENTS: Segment[] = [
  { distance: 1.0, speed: 30, isReset: false, isFree: false, label: 'Seg 1' },
  { distance: 0.25, speed: null, isReset: false, isFree: true, label: 'Transfer' },
  { distance: 1.0, speed: 24, isReset: true, isFree: false, label: 'Seg 2 (reset)' },
];

const WHEEL_MM = 2183;
const RIDE_START_MS = 1_000_000;

function buildSnapshotCorpus(): RawCscRow[] {
  const seg1 = buildCorpus({ revPerSec: 6, durationSec: 123, startTimeMs: RIDE_START_MS });
  const lastSeg1 = seg1[seg1.length - 1];
  const freeRows = buildCorpus({
    revPerSec: 3,
    durationSec: 30,
    startRevs: lastSeg1.cumulative_revs + 3,
    startTimeMs: RIDE_START_MS + 123_000,
    startEventTime: (lastSeg1.wheel_event_time + 1024) & 0xffff,
  });
  const lastFree = freeRows[freeRows.length - 1];
  const seg2 = buildCorpus({
    revPerSec: 5,
    durationSec: 120,
    startRevs: lastFree.cumulative_revs + 5,
    startTimeMs: RIDE_START_MS + 153_000,
    startEventTime: (lastFree.wheel_event_time + 1024) & 0xffff,
  });
  return [...seg1, ...freeRows, ...seg2];
}

function buildPowerCycleCorpus(): RawCscRow[] {
  const before = buildCorpus({ revPerSec: 6, durationSec: 20, startTimeMs: RIDE_START_MS });
  const lastBefore = before[before.length - 1];
  const powerCycleRow: RawCscRow = {
    wall_clock_ms: RIDE_START_MS + 20_000,
    cumulative_revs: 0,
    wheel_event_time: (lastBefore.wheel_event_time + 1024) & 0xffff,
  };
  const after = buildCorpus({
    revPerSec: 6,
    durationSec: 10,
    startRevs: 6,
    startTimeMs: RIDE_START_MS + 21_000,
    startEventTime: (powerCycleRow.wheel_event_time + 1024) & 0xffff,
  });
  return [...before, powerCycleRow, ...after];
}

function emitReplay(name: string, rows: RawCscRow[]): string {
  const { points } = replayRide(rows, REPLAY_SEGMENTS, WHEEL_MM, RIDE_START_MS);
  const rowsStr = rows
    .map(r => `  { ${i64(r.wall_clock_ms)}, ${i64(r.cumulative_revs)}, ${r.wheel_event_time} },`)
    .join('\n');
  const pointsStr = points
    .map(
      p =>
        `  { ${i64(p.wallClockMs)}, ${dbl(p.cumulativeDistanceMi)}, ${dbl(p.deviationSeconds)}, ${dbl(p.speedMph)} },`
    )
    .join('\n');
  return `
static const replay_row_t ${name}_rows[] = {
${rowsStr}
};
static const size_t ${name}_row_count = sizeof(${name}_rows) / sizeof(${name}_rows[0]);

static const replay_point_t ${name}_points[] = {
${pointsStr}
};
static const size_t ${name}_point_count = sizeof(${name}_points) / sizeof(${name}_points[0]);
`;
}

// ---------------------------------------------------------------------------
// Protocol vectors: route sheet packed by TS -> decoded by C; status and
// ride-log frames encoded by C -> byte-compared to TS-parsed references.

const PROTOCOL_ROUTE: Segment[] = [
  { distance: 1.0, speed: 30, isReset: false, isFree: false, label: 'Seg 1' },
  { distance: 0.25, speed: null, isReset: false, isFree: true, label: 'Transfer' },
  { distance: 1.0, speed: 24, isReset: true, isFree: false, label: 'Seg 2 (reset)', checkType: 'known' },
  { distance: 2.75, speed: 18.5, isReset: false, isFree: false, checkType: 'gas' },
  { distance: 0.62, speed: 33.1, isReset: true, isFree: false, label: 'Finish', checkType: 'finish' },
];

const CHECK_TYPE_CODES: Record<string, number> = {
  known: 1, secret: 2, emergency: 3, gas: 4, start: 5, finish: 6,
};

function emitRouteSheetVectors(): string {
  const payload = packRouteSheet(PROTOCOL_ROUTE);
  const bytes = [...payload].join(', ');
  const expected = PROTOCOL_ROUTE.map(s => {
    // Expected post-decode values: same quantized integers divided by the
    // same constants the C decoder uses.
    const distance = Math.round(s.distance * 1000) / 1000;
    const speed = s.speed !== null ? Math.round(s.speed * 10) / 10 : 0;
    return `  { .distance = ${dbl(distance)}, .speed = ${dbl(speed)}, .has_speed = ${boolc(s.speed !== null)}, .is_reset = ${boolc(s.isReset)}, .is_free = ${boolc(s.isFree)}, .check_type = ${s.checkType ? CHECK_TYPE_CODES[s.checkType] : 0}, .label = "${s.label ?? ''}" },`;
  }).join('\n');
  return `
static const uint8_t route_sheet_payload[] = { ${bytes} };
static const size_t route_sheet_payload_len = sizeof(route_sheet_payload);

typedef struct {
  double distance;
  double speed;
  bool has_speed;
  bool is_reset;
  bool is_free;
  uint8_t check_type;
  const char *label;
} route_sheet_expected_t;

static const route_sheet_expected_t route_sheet_expected[] = {
${expected}
};
static const size_t route_sheet_expected_count = sizeof(route_sheet_expected) / sizeof(route_sheet_expected[0]);
`;
}

interface StatusFields {
  sensorStatus: number;
  rideState: number;
  batteryPct: number;
  deviationSeconds: number;
  cumulativeDistanceMi: number;
  segmentIndex: number;
  routeLoaded: boolean;
  inFreeSection: boolean;
}

// Reference packer for DEVICE_STATUS — the C encoder must reproduce these
// bytes exactly. Verified against parseDeviceStatus below.
function packStatus(f: StatusFields): Uint8Array {
  let dev = Math.round(f.deviationSeconds);
  dev = Math.max(-32768, Math.min(32767, dev));
  const devU16 = dev < 0 ? dev + 0x10000 : dev;
  let dist = Math.round(f.cumulativeDistanceMi * 1000);
  dist = Math.max(0, Math.min(0xffffffff, dist));
  return Uint8Array.from([
    PROTOCOL_VERSION,
    f.sensorStatus,
    f.rideState,
    f.batteryPct,
    devU16 & 0xff, (devU16 >> 8) & 0xff,
    dist & 0xff, (dist >>> 8) & 0xff, (dist >>> 16) & 0xff, (dist >>> 24) & 0xff,
    f.segmentIndex,
    (f.routeLoaded ? 0x01 : 0) | (f.inFreeSection ? 0x02 : 0),
  ]);
}

const STATUS_CASES: StatusFields[] = [
  { sensorStatus: 2, rideState: 1, batteryPct: 88, deviationSeconds: -74.6, cumulativeDistanceMi: 12.345, segmentIndex: 4, routeLoaded: true, inFreeSection: true },
  { sensorStatus: 0, rideState: 0, batteryPct: 0xff, deviationSeconds: 0, cumulativeDistanceMi: 0, segmentIndex: 0, routeLoaded: false, inFreeSection: false },
  { sensorStatus: 3, rideState: 2, batteryPct: 5, deviationSeconds: 100000, cumulativeDistanceMi: 250.75, segmentIndex: 12, routeLoaded: true, inFreeSection: false },
];

function emitStatusVectors(): string {
  const rows = STATUS_CASES.map(f => {
    const bytes = packStatus(f);
    // Sanity: the TS parser must read back what the reference packer wrote
    // (deviation clamped/rounded, distance quantized).
    parseDeviceStatus(bytes);
    return `  { .sensor_status = ${f.sensorStatus}, .ride_state = ${f.rideState}, .battery_pct = ${f.batteryPct}, .deviation_seconds = ${dbl(f.deviationSeconds)}, .cumulative_distance_mi = ${dbl(f.cumulativeDistanceMi)}, .segment_index = ${f.segmentIndex}, .route_loaded = ${boolc(f.routeLoaded)}, .in_free_section = ${boolc(f.inFreeSection)},\n    .expected = { ${[...bytes].join(', ')} } },`;
  }).join('\n');
  return `
typedef struct {
  uint8_t sensor_status;
  uint8_t ride_state;
  uint8_t battery_pct;
  double deviation_seconds;
  double cumulative_distance_mi;
  uint8_t segment_index;
  bool route_loaded;
  bool in_free_section;
  uint8_t expected[12];
} status_vector_t;

static const status_vector_t status_vectors[] = {
${rows}
};
static const size_t status_vector_count = sizeof(status_vectors) / sizeof(status_vectors[0]);
`;
}

function emitRideLogVectors(): string {
  const rows = [
    { wallClockMs: 1000, cumulativeRevs: 6, wheelEventTime: 1024 },
    { wallClockMs: 2000, cumulativeRevs: 12, wheelEventTime: 2048 },
    { wallClockMs: 0xfffffff0, cumulativeRevs: 0x80000010, wheelEventTime: 0xffff },
  ];
  // Reference DATA packet: seq 7, all three rows.
  const data: number[] = [7, rows.length];
  for (const r of rows) {
    const ms = r.wallClockMs >>> 0;
    const revs = r.cumulativeRevs >>> 0;
    data.push(
      ms & 0xff, (ms >>> 8) & 0xff, (ms >>> 16) & 0xff, (ms >>> 24) & 0xff,
      revs & 0xff, (revs >>> 8) & 0xff, (revs >>> 16) & 0xff, (revs >>> 24) & 0xff,
      r.wheelEventTime & 0xff, (r.wheelEventTime >> 8) & 0xff
    );
  }
  const parsed = parseRideLogPacket(Uint8Array.from(data));
  if (parsed.kind !== 'data' || parsed.rows.length !== rows.length) {
    throw new Error('ride log reference packet failed TS parse');
  }
  const crc = rideLogCrc(rows);
  const end = [9, 0, rows.length & 0xff, 0, crc & 0xff, (crc >> 8) & 0xff];
  const endParsed = parseRideLogPacket(Uint8Array.from(end));
  if (endParsed.kind !== 'end' || endParsed.crc !== crc) {
    throw new Error('ride log END reference packet failed TS parse');
  }
  return `
static const struct { int64_t wall_clock_ms; int64_t cumulative_revs; int32_t wheel_event_time; } ride_log_rows[] = {
${rows.map(r => `  { ${i64(r.wallClockMs)}, ${i64(r.cumulativeRevs)}, ${r.wheelEventTime} },`).join('\n')}
};
static const size_t ride_log_row_count = sizeof(ride_log_rows) / sizeof(ride_log_rows[0]);

static const uint8_t ride_log_expected_data[] = { ${data.join(', ')} };
static const uint8_t ride_log_expected_end[] = { ${end.join(', ')} };
static const uint16_t ride_log_expected_crc = ${crc};

/* Standard CRC-16/CCITT-FALSE check value for "123456789" */
static const uint16_t crc16_check_value = ${crc16(Uint8Array.from('123456789', c => c.charCodeAt(0)))};
`;
}

// ---------------------------------------------------------------------------
// Header assembly

function main(): void {
  const cscSequence = buildCscSequence().map(emitCscCase).join('\n');
  const cscDirect = buildCscDirectCases().map(emitCscCase).join('\n');

  const header = `/*
 * GENERATED FILE — DO NOT EDIT.
 *
 * Golden test vectors exported from the TypeScript reference implementation
 * (src/engine/pace-engine.ts, src/ble/csc-parser.ts, src/engine/replay.ts).
 * Regenerate with \`make vectors\` in firmware/test.
 */
#ifndef ENDURO_TEST_VECTORS_H
#define ENDURO_TEST_VECTORS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  int len;
  uint8_t bytes[8];
  bool has_prev;
  int64_t prev_revs;
  int32_t prev_time;
  int64_t exp_revs;
  int32_t exp_time;
  bool has_update;
  double exp_speed_mph;
  int64_t exp_delta_revs;
  double exp_delta_time_s;
} csc_vector_t;

typedef struct {
  double cumulative_distance;
  int32_t exp_segment_index;
  double exp_distance_in_segment;
  double exp_key_time;
  bool exp_in_free;
} pace_vector_t;

typedef struct {
  int32_t prev_index;
  int32_t current_index;
  bool expected;
} crossed_reset_vector_t;

typedef struct {
  int64_t wall_clock_ms;
  int64_t cumulative_revs; /* stored unsigned 32-bit value */
  int32_t wheel_event_time;
} replay_row_t;

typedef struct {
  int64_t wall_clock_ms;
  double cumulative_distance_mi;
  double deviation_seconds;
  double speed_mph;
} replay_point_t;

/* CSC parser: live sequence (state carried between steps) */
static const csc_vector_t csc_sequence_vectors[] = {
${cscSequence}
};
static const size_t csc_sequence_count = sizeof(csc_sequence_vectors) / sizeof(csc_sequence_vectors[0]);

/* CSC parser: direct cases with hand-constructed prev states */
static const csc_vector_t csc_direct_vectors[] = {
${cscDirect}
};
static const size_t csc_direct_count = sizeof(csc_direct_vectors) / sizeof(csc_direct_vectors[0]);

/* Pace engine: route used by pace/crossed-reset vectors */
static const struct {
  double distance;
  double speed;
  bool has_speed;
  bool is_reset;
  bool is_free;
} pace_segment_vectors[] = {
${emitPaceSegments()}
};
static const size_t pace_segment_count = sizeof(pace_segment_vectors) / sizeof(pace_segment_vectors[0]);

static const pace_vector_t pace_vectors[] = {
${emitPaceCases()}
};
static const size_t pace_vector_count = sizeof(pace_vectors) / sizeof(pace_vectors[0]);

static const crossed_reset_vector_t crossed_reset_vectors[] = {
${emitCrossedResetCases()}
};
static const size_t crossed_reset_count = sizeof(crossed_reset_vectors) / sizeof(crossed_reset_vectors[0]);

/* End-to-end replay: segments used by both corpora */
static const struct {
  double distance;
  double speed;
  bool has_speed;
  bool is_reset;
  bool is_free;
} replay_segment_vectors[] = {
${REPLAY_SEGMENTS.map(
    s =>
      `  { .distance = ${dbl(s.distance)}, .speed = ${dbl(s.speed ?? 0)}, .has_speed = ${boolc(s.speed !== null)}, .is_reset = ${boolc(s.isReset)}, .is_free = ${boolc(s.isFree)} },`
  ).join('\n')}
};
static const size_t replay_segment_count = sizeof(replay_segment_vectors) / sizeof(replay_segment_vectors[0]);

static const double replay_wheel_mm = ${dbl(WHEEL_MM)};
static const int64_t replay_ride_start_ms = ${i64(RIDE_START_MS)};
${emitReplay('replay_snapshot', buildSnapshotCorpus())}
${emitReplay('replay_power_cycle', buildPowerCycleCorpus())}
/* ---- protocol vectors (device-protocol.ts <-> route_sheet.c) ---- */
${emitRouteSheetVectors()}
${emitStatusVectors()}
${emitRideLogVectors()}
#endif /* ENDURO_TEST_VECTORS_H */
`;

  // Walk up to the repo root (package.json) so the output path is correct
  // whether this runs from source or from the tsc build directory.
  let root = __dirname;
  while (!fs.existsSync(path.join(root, 'package.json'))) {
    const parent = path.dirname(root);
    if (parent === root) throw new Error('repo root not found');
    root = parent;
  }
  const outPath = path.join(root, 'firmware/test/vectors.h');
  fs.writeFileSync(outPath, header);
  console.log(`wrote ${outPath}`);
}

main();
