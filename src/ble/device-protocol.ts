// Enduro Companion device protocol (v1) — pure functions, zero platform
// dependencies. See docs/BLE-PROTOCOL.md for the wire format. The C decoder
// in firmware/core/route_sheet.c is validated against vectors generated from
// this module — keep it pure, same golden-reference discipline as the engine.

import type { CheckType, Segment } from '../engine/pace-engine';

export const ENDURO_SERVICE = '9e4b0001-f2e4-4b84-8e4e-2e8f1b4c6d3a';
export const ROUTE_SHEET_CHAR = '9e4b0002-f2e4-4b84-8e4e-2e8f1b4c6d3a';
export const CONTROL_CHAR = '9e4b0003-f2e4-4b84-8e4e-2e8f1b4c6d3a';
export const DEVICE_STATUS_CHAR = '9e4b0004-f2e4-4b84-8e4e-2e8f1b4c6d3a';
export const RIDE_LOG_CHAR = '9e4b0005-f2e4-4b84-8e4e-2e8f1b4c6d3a';

export const PROTOCOL_VERSION = 0x01;
export const MAX_LABEL_BYTES = 23;

// Segment flags
const FLAG_IS_RESET = 0x01;
const FLAG_IS_FREE = 0x02;
const FLAG_HAS_SPEED = 0x04;

const CHECK_TYPES: Array<CheckType | undefined> = [
  undefined, 'known', 'secret', 'emergency', 'gas', 'start', 'finish',
];

// ---------------------------------------------------------------------------
// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR.
// Must match crc16_ccitt() in firmware/core/route_sheet.c exactly.

export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// ---------------------------------------------------------------------------
// ROUTE_SHEET

export function packRouteSheet(segments: Segment[]): Uint8Array {
  if (segments.length === 0 || segments.length > 255) {
    throw new Error(`segment count out of range: ${segments.length}`);
  }
  const encoder = new TextEncoder();
  const body: number[] = [PROTOCOL_VERSION, segments.length];

  for (const seg of segments) {
    const distanceThou = Math.round(seg.distance * 1000);
    if (distanceThou < 0 || distanceThou > 0xffff) {
      throw new Error(`segment distance out of range: ${seg.distance} mi`);
    }
    const hasSpeed = seg.speed !== null;
    const speedTenths = hasSpeed ? Math.round(seg.speed! * 10) : 0;
    if (speedTenths < 0 || speedTenths > 0xffff) {
      throw new Error(`segment speed out of range: ${seg.speed} mph`);
    }

    let flags = 0;
    if (seg.isReset) flags |= FLAG_IS_RESET;
    if (seg.isFree) flags |= FLAG_IS_FREE;
    if (hasSpeed) flags |= FLAG_HAS_SPEED;
    const checkIndex = seg.checkType ? CHECK_TYPES.indexOf(seg.checkType) : 0;
    flags |= (checkIndex > 0 ? checkIndex : 0) << 4;

    let label = encoder.encode(seg.label ?? '');
    if (label.length > MAX_LABEL_BYTES) label = label.slice(0, MAX_LABEL_BYTES);

    body.push(
      distanceThou & 0xff, (distanceThou >> 8) & 0xff,
      speedTenths & 0xff, (speedTenths >> 8) & 0xff,
      flags,
      label.length,
      ...label
    );
  }

  const crc = crc16(Uint8Array.from(body));
  body.push(crc & 0xff, (crc >> 8) & 0xff);
  return Uint8Array.from(body);
}

export function parseRouteSheet(payload: Uint8Array): Segment[] {
  if (payload.length < 4) throw new Error('route sheet too short');
  const crcExpected = payload[payload.length - 2] | (payload[payload.length - 1] << 8);
  const crcActual = crc16(payload.subarray(0, payload.length - 2));
  if (crcExpected !== crcActual) throw new Error('route sheet CRC mismatch');
  if (payload[0] !== PROTOCOL_VERSION) {
    throw new Error(`unsupported route sheet version: ${payload[0]}`);
  }

  const count = payload[1];
  const decoder = new TextDecoder();
  const segments: Segment[] = [];
  let offset = 2;
  const end = payload.length - 2;

  for (let i = 0; i < count; i++) {
    if (offset + 6 > end) throw new Error('route sheet truncated');
    const distanceThou = payload[offset] | (payload[offset + 1] << 8);
    const speedTenths = payload[offset + 2] | (payload[offset + 3] << 8);
    const flags = payload[offset + 4];
    const labelLen = payload[offset + 5];
    offset += 6;
    if (offset + labelLen > end) throw new Error('route sheet truncated');
    const label = labelLen > 0 ? decoder.decode(payload.subarray(offset, offset + labelLen)) : undefined;
    offset += labelLen;

    const hasSpeed = (flags & FLAG_HAS_SPEED) !== 0;
    segments.push({
      distance: distanceThou / 1000,
      speed: hasSpeed ? speedTenths / 10 : null,
      isReset: (flags & FLAG_IS_RESET) !== 0,
      isFree: (flags & FLAG_IS_FREE) !== 0,
      label,
      checkType: CHECK_TYPES[(flags >> 4) & 0x0f],
    });
  }
  if (offset !== end) throw new Error('route sheet has trailing bytes');
  return segments;
}

// Transfer framing: BEGIN / DATA / END chunks written sequentially.
const XFER_BEGIN = 0x01;
const XFER_DATA = 0x02;
const XFER_END = 0x03;

export function chunkRouteSheet(payload: Uint8Array, attMtu: number): Uint8Array[] {
  // 3 bytes ATT header + 3 bytes DATA frame header (op + offset)
  const chunkSize = Math.max(1, attMtu - 3 - 3);
  const packets: Uint8Array[] = [];
  packets.push(Uint8Array.from([XFER_BEGIN, payload.length & 0xff, (payload.length >> 8) & 0xff]));
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const slice = payload.subarray(offset, Math.min(offset + chunkSize, payload.length));
    const packet = new Uint8Array(3 + slice.length);
    packet[0] = XFER_DATA;
    packet[1] = offset & 0xff;
    packet[2] = (offset >> 8) & 0xff;
    packet.set(slice, 3);
    packets.push(packet);
  }
  packets.push(Uint8Array.from([XFER_END]));
  return packets;
}

// ---------------------------------------------------------------------------
// CONTROL

export const CONTROL_OPCODES = {
  START_RIDE: 0x01,
  END_RIDE: 0x02,
  MANUAL_RESET: 0x03,
  SET_WHEEL_CIRC: 0x04,
  REQUEST_RIDE_LOG: 0x05,
  CLEAR_RIDE_LOG: 0x06,
} as const;

export function packStartRide(epochSeconds: number): Uint8Array {
  const s = Math.floor(epochSeconds) >>> 0;
  return Uint8Array.from([
    CONTROL_OPCODES.START_RIDE,
    s & 0xff, (s >>> 8) & 0xff, (s >>> 16) & 0xff, (s >>> 24) & 0xff,
  ]);
}

export function packSetWheelCircumference(mm: number): Uint8Array {
  const v = Math.round(mm);
  if (v < 0 || v > 0xffff) throw new Error(`circumference out of range: ${mm}`);
  return Uint8Array.from([CONTROL_OPCODES.SET_WHEEL_CIRC, v & 0xff, (v >> 8) & 0xff]);
}

export function packSimpleControl(
  opcode: typeof CONTROL_OPCODES[keyof typeof CONTROL_OPCODES]
): Uint8Array {
  return Uint8Array.from([opcode]);
}

// ---------------------------------------------------------------------------
// RIDE_LOG stream

export interface RideLogRow {
  wallClockMs: number; // device ms since ride start
  cumulativeRevs: number;
  wheelEventTime: number;
}

export type RideLogPacket =
  | { kind: 'data'; seq: number; rows: RideLogRow[] }
  | { kind: 'end'; seq: number; totalRows: number; crc: number };

const RIDE_LOG_ROW_BYTES = 10;

export function parseRideLogPacket(bytes: Uint8Array): RideLogPacket {
  if (bytes.length < 2) throw new Error('ride log packet too short');
  const seq = bytes[0];
  const rowCount = bytes[1];

  if (rowCount === 0) {
    if (bytes.length < 6) throw new Error('ride log END packet too short');
    return {
      kind: 'end',
      seq,
      totalRows: bytes[2] | (bytes[3] << 8),
      crc: bytes[4] | (bytes[5] << 8),
    };
  }

  if (bytes.length < 2 + rowCount * RIDE_LOG_ROW_BYTES) {
    throw new Error('ride log DATA packet truncated');
  }
  const rows: RideLogRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    const o = 2 + i * RIDE_LOG_ROW_BYTES;
    rows.push({
      wallClockMs:
        (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0,
      cumulativeRevs:
        (bytes[o + 4] | (bytes[o + 5] << 8) | (bytes[o + 6] << 16) | (bytes[o + 7] << 24)) >>> 0,
      wheelEventTime: bytes[o + 8] | (bytes[o + 9] << 8),
    });
  }
  return { kind: 'data', seq, rows };
}

/** CRC over row bytes in stream order — what the END packet's crc covers. */
export function rideLogCrc(rows: RideLogRow[]): number {
  const bytes = new Uint8Array(rows.length * RIDE_LOG_ROW_BYTES);
  rows.forEach((row, i) => {
    const o = i * RIDE_LOG_ROW_BYTES;
    const ms = row.wallClockMs >>> 0;
    const revs = row.cumulativeRevs >>> 0;
    bytes[o] = ms & 0xff;
    bytes[o + 1] = (ms >>> 8) & 0xff;
    bytes[o + 2] = (ms >>> 16) & 0xff;
    bytes[o + 3] = (ms >>> 24) & 0xff;
    bytes[o + 4] = revs & 0xff;
    bytes[o + 5] = (revs >>> 8) & 0xff;
    bytes[o + 6] = (revs >>> 16) & 0xff;
    bytes[o + 7] = (revs >>> 24) & 0xff;
    bytes[o + 8] = row.wheelEventTime & 0xff;
    bytes[o + 9] = (row.wheelEventTime >> 8) & 0xff;
  });
  return crc16(bytes);
}

/**
 * Reassembles a RIDE_LOG notification stream. Feed each notification's bytes
 * to addPacket(); when it returns 'done', `rows` holds the complete log.
 * Detects dropped notifications (seq gap), row-count mismatch, and CRC
 * mismatch — any of which surface as 'error' with `error` set.
 */
export class RideLogAssembler {
  readonly rows: RideLogRow[] = [];
  error: string | null = null;
  private expectedSeq = 0;
  private finished = false;

  addPacket(bytes: Uint8Array): 'pending' | 'done' | 'error' {
    if (this.finished) return this.error ? 'error' : 'done';

    let packet: RideLogPacket;
    try {
      packet = parseRideLogPacket(bytes);
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : 'malformed packet');
    }

    if (packet.seq !== this.expectedSeq) {
      return this.fail(`sequence gap: expected ${this.expectedSeq}, got ${packet.seq}`);
    }
    this.expectedSeq = (packet.seq + 1) & 0xff;

    if (packet.kind === 'data') {
      this.rows.push(...packet.rows);
      return 'pending';
    }

    if (packet.totalRows !== this.rows.length) {
      return this.fail(`row count mismatch: device sent ${packet.totalRows}, received ${this.rows.length}`);
    }
    if (packet.crc !== rideLogCrc(this.rows)) {
      return this.fail('ride log CRC mismatch');
    }
    this.finished = true;
    return 'done';
  }

  private fail(message: string): 'error' {
    this.error = message;
    this.finished = true;
    return 'error';
  }
}

// ---------------------------------------------------------------------------
// DEVICE_STATUS

export type DeviceSensorStatus = 'disconnected' | 'connecting' | 'connected' | 'lost';
export type DeviceRideState = 'idle' | 'riding' | 'log_ready';

export interface DeviceStatus {
  sensorStatus: DeviceSensorStatus;
  rideState: DeviceRideState;
  batteryPct: number | null;
  deviationSeconds: number;
  cumulativeDistanceMi: number;
  segmentIndex: number;
  routeLoaded: boolean;
  inFreeSection: boolean;
}

const SENSOR_STATUSES: DeviceSensorStatus[] = ['disconnected', 'connecting', 'connected', 'lost'];
const RIDE_STATES: DeviceRideState[] = ['idle', 'riding', 'log_ready'];

export const DEVICE_STATUS_BYTES = 12;

export function parseDeviceStatus(bytes: Uint8Array): DeviceStatus {
  if (bytes.length < DEVICE_STATUS_BYTES) throw new Error('device status too short');
  if (bytes[0] !== PROTOCOL_VERSION) {
    throw new Error(`unsupported device status version: ${bytes[0]}`);
  }
  const deviationRaw = bytes[4] | (bytes[5] << 8);
  const deviation = deviationRaw >= 0x8000 ? deviationRaw - 0x10000 : deviationRaw;
  const distanceThou =
    (bytes[6] | (bytes[7] << 8) | (bytes[8] << 16) | (bytes[9] << 24)) >>> 0;
  return {
    sensorStatus: SENSOR_STATUSES[bytes[1]] ?? 'disconnected',
    rideState: RIDE_STATES[bytes[2]] ?? 'idle',
    batteryPct: bytes[3] === 0xff ? null : bytes[3],
    deviationSeconds: deviation,
    cumulativeDistanceMi: distanceThou / 1000,
    segmentIndex: bytes[10],
    routeLoaded: (bytes[11] & 0x01) !== 0,
    inFreeSection: (bytes[11] & 0x02) !== 0,
  };
}
