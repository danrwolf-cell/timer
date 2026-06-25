import { parseCscNotification, DEFAULT_WHEEL_CIRCUMFERENCE_MM, type CscState } from './csc-parser';

function buildPacket(revolutions: number, eventTime: number): Uint8Array {
  // Flags byte: bit 0 set = wheel revolution data present
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

describe('parseCscNotification', () => {
  it('returns null update on first packet (no previous state)', () => {
    const packet = buildPacket(100, 1024);
    const { update } = parseCscNotification(packet, null);
    expect(update).toBeNull();
  });

  it('calculates speed correctly', () => {
    // 10 revolutions in 1 second (1024 ticks) at default circumference
    // distance = 10 * 2183mm = 21.83m
    // speed = 21.83 m/s * 2.23694 = ~48.8 mph
    const prev: CscState = { cumulativeRevolutions: 0, lastEventTime: 0 };
    const packet = buildPacket(10, 1024);
    const { update } = parseCscNotification(packet, prev);
    expect(update).not.toBeNull();
    expect(update!.speedMph).toBeCloseTo(48.8, 0);
  });

  it('handles 16-bit timestamp rollover', () => {
    const prev: CscState = { cumulativeRevolutions: 100, lastEventTime: 65000 };
    // timestamp rolled over: new time = 500, delta = 500 + (65536 - 65000) = 1036 ticks
    const packet = buildPacket(110, 500);
    const { update } = parseCscNotification(packet, prev);
    expect(update).not.toBeNull();
    expect(update!.deltaRevolutions).toBe(10);
    // 1036 ticks / 1024 = ~1.012 seconds
    expect(update!.deltaTimeSeconds).toBeCloseTo(1.012, 2);
  });

  it('returns null update when delta time is zero', () => {
    const prev: CscState = { cumulativeRevolutions: 100, lastEventTime: 1024 };
    const packet = buildPacket(105, 1024); // same timestamp
    const { update } = parseCscNotification(packet, prev);
    expect(update).toBeNull();
  });

  it('ignores packet without wheel data flag', () => {
    const prev: CscState = { cumulativeRevolutions: 0, lastEventTime: 0 };
    const packet = new Uint8Array([0x00, 0, 0, 0, 0, 0, 0]); // flags = 0, no wheel data
    const { update } = parseCscNotification(packet, prev);
    expect(update).toBeNull();
  });

  it('realistic enduro speed: 30mph at 90/90-21', () => {
    // 30 mph = 13.41 m/s
    // revs per second = 13.41 / (2.183m) = 6.14 rev/s
    // in 1 second: ~6 revs, 1024 ticks
    const prev: CscState = { cumulativeRevolutions: 0, lastEventTime: 0 };
    const packet = buildPacket(6, 1024);
    const { update } = parseCscNotification(packet, prev, DEFAULT_WHEEL_CIRCUMFERENCE_MM);
    expect(update!.speedMph).toBeCloseTo(29.3, 0); // close to 30mph
  });
});
