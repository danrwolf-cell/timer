import type { Segment } from '../engine/pace-engine';
import {
  chunkRouteSheet,
  crc16,
  packRouteSheet,
  packSetWheelCircumference,
  packSimpleControl,
  packStartRide,
  parseDeviceStatus,
  parseRideLogPacket,
  parseRouteSheet,
  rideLogCrc,
  CONTROL_OPCODES,
  PROTOCOL_VERSION,
} from './device-protocol';

const ROUTE: Segment[] = [
  { distance: 1.0, speed: 30, isReset: false, isFree: false, label: 'Seg 1' },
  { distance: 0.25, speed: null, isReset: false, isFree: true, label: 'Transfer' },
  { distance: 1.0, speed: 24, isReset: true, isFree: false, label: 'Seg 2 (reset)', checkType: 'known' },
  { distance: 2.75, speed: 18.5, isReset: false, isFree: false, checkType: 'gas' },
];

describe('crc16 (CCITT-FALSE)', () => {
  it('matches the standard check value for "123456789"', () => {
    const bytes = Uint8Array.from('123456789', c => c.charCodeAt(0));
    expect(crc16(bytes)).toBe(0x29b1);
  });

  it('empty input yields the init value', () => {
    expect(crc16(new Uint8Array(0))).toBe(0xffff);
  });
});

describe('route sheet pack/parse', () => {
  it('round-trips a representative route', () => {
    const payload = packRouteSheet(ROUTE);
    const decoded = parseRouteSheet(payload);
    expect(decoded).toEqual([
      { distance: 1.0, speed: 30, isReset: false, isFree: false, label: 'Seg 1', checkType: undefined },
      { distance: 0.25, speed: null, isReset: false, isFree: true, label: 'Transfer', checkType: undefined },
      { distance: 1.0, speed: 24, isReset: true, isFree: false, label: 'Seg 2 (reset)', checkType: 'known' },
      { distance: 2.75, speed: 18.5, isReset: false, isFree: false, label: undefined, checkType: 'gas' },
    ]);
  });

  it('starts with version byte and segment count', () => {
    const payload = packRouteSheet(ROUTE);
    expect(payload[0]).toBe(PROTOCOL_VERSION);
    expect(payload[1]).toBe(ROUTE.length);
  });

  it('quantizes distance to 0.001 mi losslessly for route-sheet values', () => {
    const decoded = parseRouteSheet(packRouteSheet([
      { distance: 12.34, speed: 27.5, isReset: false, isFree: false },
    ]));
    expect(decoded[0].distance).toBe(12.34);
    expect(decoded[0].speed).toBe(27.5);
  });

  it('rejects a corrupted payload', () => {
    const payload = packRouteSheet(ROUTE);
    payload[3] ^= 0xff;
    expect(() => parseRouteSheet(payload)).toThrow(/CRC/);
  });

  it('rejects an unknown version', () => {
    const payload = packRouteSheet(ROUTE);
    // Rewrite version then fix up the CRC so the version check is what trips
    payload[0] = 0x7f;
    const body = payload.subarray(0, payload.length - 2);
    const crc = crc16(body);
    payload[payload.length - 2] = crc & 0xff;
    payload[payload.length - 1] = (crc >> 8) & 0xff;
    expect(() => parseRouteSheet(payload)).toThrow(/version/);
  });

  it('truncates labels longer than 23 bytes', () => {
    const decoded = parseRouteSheet(packRouteSheet([
      { distance: 1, speed: 30, isReset: false, isFree: false, label: 'x'.repeat(40) },
    ]));
    expect(decoded[0].label).toBe('x'.repeat(23));
  });

  it('rejects empty routes and out-of-range values', () => {
    expect(() => packRouteSheet([])).toThrow(/count/);
    expect(() => packRouteSheet([
      { distance: 70, speed: 30, isReset: false, isFree: false },
    ])).toThrow(/distance/);
  });
});

describe('route sheet chunking', () => {
  it('frames BEGIN / DATA / END and reassembles to the original payload', () => {
    const payload = packRouteSheet(ROUTE);
    const packets = chunkRouteSheet(payload, 23); // minimum ATT MTU
    expect(packets[0][0]).toBe(0x01); // BEGIN
    expect(packets[0][1] | (packets[0][2] << 8)).toBe(payload.length);
    expect(packets[packets.length - 1][0]).toBe(0x03); // END

    const reassembled = new Uint8Array(payload.length);
    for (const p of packets.slice(1, -1)) {
      expect(p[0]).toBe(0x02); // DATA
      const offset = p[1] | (p[2] << 8);
      reassembled.set(p.subarray(3), offset);
    }
    expect([...reassembled]).toEqual([...payload]);
  });

  it('uses a single DATA packet when the payload fits the MTU', () => {
    const payload = packRouteSheet([{ distance: 1, speed: 30, isReset: false, isFree: false }]);
    const packets = chunkRouteSheet(payload, 247);
    expect(packets.length).toBe(3); // BEGIN, DATA, END
  });
});

describe('control packing', () => {
  it('packs START_RIDE with epoch seconds', () => {
    const packet = packStartRide(1_735_689_600); // some epoch
    expect(packet[0]).toBe(CONTROL_OPCODES.START_RIDE);
    const epoch =
      (packet[1] | (packet[2] << 8) | (packet[3] << 16) | (packet[4] << 24)) >>> 0;
    expect(epoch).toBe(1_735_689_600);
  });

  it('packs SET_WHEEL_CIRC', () => {
    const packet = packSetWheelCircumference(2183);
    expect(packet[0]).toBe(CONTROL_OPCODES.SET_WHEEL_CIRC);
    expect(packet[1] | (packet[2] << 8)).toBe(2183);
  });

  it('packs single-byte opcodes', () => {
    expect([...packSimpleControl(CONTROL_OPCODES.MANUAL_RESET)]).toEqual([0x03]);
  });
});

describe('ride log stream', () => {
  function packDataPacket(seq: number, rows: Array<[number, number, number]>): Uint8Array {
    const bytes = new Uint8Array(2 + rows.length * 10);
    bytes[0] = seq;
    bytes[1] = rows.length;
    rows.forEach(([ms, revs, wet], i) => {
      const o = 2 + i * 10;
      bytes[o] = ms & 0xff; bytes[o + 1] = (ms >>> 8) & 0xff;
      bytes[o + 2] = (ms >>> 16) & 0xff; bytes[o + 3] = (ms >>> 24) & 0xff;
      bytes[o + 4] = revs & 0xff; bytes[o + 5] = (revs >>> 8) & 0xff;
      bytes[o + 6] = (revs >>> 16) & 0xff; bytes[o + 7] = (revs >>> 24) & 0xff;
      bytes[o + 8] = wet & 0xff; bytes[o + 9] = (wet >> 8) & 0xff;
    });
    return bytes;
  }

  it('parses a DATA packet with multiple rows', () => {
    const packet = packDataPacket(7, [
      [1000, 6, 1024],
      [2000, 12, 2048],
    ]);
    const parsed = parseRideLogPacket(packet);
    expect(parsed).toEqual({
      kind: 'data',
      seq: 7,
      rows: [
        { wallClockMs: 1000, cumulativeRevs: 6, wheelEventTime: 1024 },
        { wallClockMs: 2000, cumulativeRevs: 12, wheelEventTime: 2048 },
      ],
    });
  });

  it('parses 32-bit values with the high bit set', () => {
    const packet = packDataPacket(0, [[0xfffffff0, 0x80000010, 0xffff]]);
    const parsed = parseRideLogPacket(packet);
    if (parsed.kind !== 'data') throw new Error('expected data packet');
    expect(parsed.rows[0].wallClockMs).toBe(0xfffffff0);
    expect(parsed.rows[0].cumulativeRevs).toBe(0x80000010);
    expect(parsed.rows[0].wheelEventTime).toBe(0xffff);
  });

  it('parses an END packet and its CRC matches rideLogCrc', () => {
    const rows = [
      { wallClockMs: 1000, cumulativeRevs: 6, wheelEventTime: 1024 },
      { wallClockMs: 2000, cumulativeRevs: 12, wheelEventTime: 2048 },
    ];
    const crc = rideLogCrc(rows);
    const end = Uint8Array.from([9, 0, 2, 0, crc & 0xff, (crc >> 8) & 0xff]);
    expect(parseRideLogPacket(end)).toEqual({ kind: 'end', seq: 9, totalRows: 2, crc });
  });

  it('rejects truncated packets', () => {
    expect(() => parseRideLogPacket(Uint8Array.from([0]))).toThrow(/short/);
    expect(() => parseRideLogPacket(Uint8Array.from([0, 2, 1, 2, 3]))).toThrow(/truncated/);
  });
});

describe('device status', () => {
  it('parses a full status frame including negative deviation', () => {
    // deviation -75 s, distance 12.345 mi
    const deviation = (-75 + 0x10000) & 0xffff;
    const distanceThou = 12345;
    const bytes = Uint8Array.from([
      PROTOCOL_VERSION,
      2, // connected
      1, // riding
      88,
      deviation & 0xff, (deviation >> 8) & 0xff,
      distanceThou & 0xff, (distanceThou >> 8) & 0xff, (distanceThou >> 16) & 0xff, (distanceThou >> 24) & 0xff,
      4,
      0x03, // route_loaded | in_free_section
    ]);
    expect(parseDeviceStatus(bytes)).toEqual({
      sensorStatus: 'connected',
      rideState: 'riding',
      batteryPct: 88,
      deviationSeconds: -75,
      cumulativeDistanceMi: 12.345,
      segmentIndex: 4,
      routeLoaded: true,
      inFreeSection: true,
    });
  });

  it('maps battery 0xFF to null', () => {
    const bytes = new Uint8Array(12);
    bytes[0] = PROTOCOL_VERSION;
    bytes[3] = 0xff;
    expect(parseDeviceStatus(bytes).batteryPct).toBeNull();
  });
});
