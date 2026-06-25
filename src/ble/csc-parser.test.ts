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

describe('power-cycle and rollover handling', () => {
  it('treats counter reset to near-zero as power-cycle: emits null, re-baselines', () => {
    // Sensor was at 50000 revs, powered off, restarted at 0
    const prev: CscState = { cumulativeRevolutions: 50000, lastEventTime: 1024 };
    const packet = buildPacket(0, 2048); // counter reset to 0
    const { state, update } = parseCscNotification(packet, prev);
    // No update — power-cycle, we drop this notification
    expect(update).toBeNull();
    // State re-baselined to new counter value so next delta is clean
    expect(state.cumulativeRevolutions).toBe(0);
  });

  it('recovers correctly on the notification after a power-cycle', () => {
    // First notification after reset: re-baselined to { revs: 0, time: 2048 }
    const prev: CscState = { cumulativeRevolutions: 0, lastEventTime: 2048 };
    // Next notification: 6 revs in 1 second = ~30 mph
    const packet = buildPacket(6, 3072);
    const { update } = parseCscNotification(packet, prev);
    expect(update).not.toBeNull();
    expect(update!.speedMph).toBeCloseTo(29.3, 0);
  });

  it('handles genuine 32-bit counter rollover (counter was near max)', () => {
    // Counter was at 0xFFFFFFF0 (just below max), rolled over to 5
    // True delta = 5 + (0x100000000 - 0xFFFFFFF0) = 5 + 16 = 21 revs
    const prev: CscState = { cumulativeRevolutions: 0xFFFFFFF0, lastEventTime: 1024 };
    const packet = buildPacket(5, 2048); // 1 second later
    const { state, update } = parseCscNotification(packet, prev);
    expect(update).not.toBeNull();
    // 21 revs * 2.183m / 1s = ~46 mph — plausible
    expect(update!.deltaRevolutions).toBe(21);
    expect(update!.speedMph).toBeCloseTo(21 * 2.183 * 2.23694, 0);
    expect(state.cumulativeRevolutions).toBe(5);
  });

  it('discards implausibly fast update as final backstop', () => {
    // Construct a delta that somehow implies >150 mph (shouldn't happen after
    // power-cycle check, but backstop should catch anything that slips through)
    const prev: CscState = { cumulativeRevolutions: 0, lastEventTime: 0 };
    // 1000 revs in 1 second = ~2183 m/s = ~4883 mph — clearly bogus
    const packet = buildPacket(1000, 1024);
    const { update } = parseCscNotification(packet, prev);
    expect(update).toBeNull();
  });
});
