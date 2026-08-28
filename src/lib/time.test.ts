import {
  parseTimeOfDay,
  resolveTimeOfDay,
  formatTimeOfDay,
  formatCountdown,
  clockOffsetMs,
  eventNowMs,
  eventTimeToPhoneEpochMs,
  formatOffset,
} from './time';

describe('parseTimeOfDay', () => {
  it('accepts HH:MM and defaults seconds to zero', () => {
    expect(parseTimeOfDay('08:00')).toEqual({ hours: 8, minutes: 0, seconds: 0 });
    expect(parseTimeOfDay('8:05')).toEqual({ hours: 8, minutes: 5, seconds: 0 });
  });

  it('accepts HH:MM:SS', () => {
    expect(parseTimeOfDay('08:00:37')).toEqual({ hours: 8, minutes: 0, seconds: 37 });
    expect(parseTimeOfDay('23:59:59')).toEqual({ hours: 23, minutes: 59, seconds: 59 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseTimeOfDay('  09:30:15 ')).toEqual({ hours: 9, minutes: 30, seconds: 15 });
  });

  it('rejects out-of-range and malformed input', () => {
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('08:60')).toBeNull();
    expect(parseTimeOfDay('08:00:60')).toBeNull();
    expect(parseTimeOfDay('0800')).toBeNull();
    expect(parseTimeOfDay('8')).toBeNull();
    expect(parseTimeOfDay('')).toBeNull();
  });
});

describe('resolveTimeOfDay', () => {
  it('lands on the reference calendar day', () => {
    const ref = new Date(2026, 7, 29, 17, 45, 12, 500);
    const ms = resolveTimeOfDay({ hours: 8, minutes: 0, seconds: 37 }, ref);
    const d = new Date(ms);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(29);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(37);
    expect(d.getMilliseconds()).toBe(0);
  });

  it('does not roll forward when the time already passed', () => {
    const ref = new Date(2026, 7, 29, 17, 0, 0, 0);
    const ms = resolveTimeOfDay({ hours: 8, minutes: 0, seconds: 0 }, ref);
    expect(ms).toBeLessThan(ref.getTime());
    expect(new Date(ms).getDate()).toBe(29);
  });

  it('round-trips through formatTimeOfDay', () => {
    const ref = new Date(2026, 7, 29, 12, 0, 0, 0);
    const ms = resolveTimeOfDay({ hours: 8, minutes: 3, seconds: 9 }, ref);
    expect(formatTimeOfDay(ms)).toBe('08:03:09');
  });
});

describe('formatCountdown', () => {
  it('uses M:SS below an hour', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(3599)).toBe('59:59');
  });

  it('uses H:MM:SS from an hour up', () => {
    expect(formatCountdown(3600)).toBe('1:00:00');
    expect(formatCountdown(3661)).toBe('1:01:01');
    expect(formatCountdown(7325)).toBe('2:02:05');
  });

  it('clamps negatives to zero', () => {
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('rounds partial seconds up so it never shows early', () => {
    expect(formatCountdown(0.4)).toBe('0:01');
  });
});

describe('event clock offset', () => {
  // The reported case: phone reads 7:35:30 while the official clock shows
  // 7:34:58 — the event clock is 32 seconds behind the phone.
  const day = (h: number, m: number, s: number) =>
    new Date(2026, 7, 29, h, m, s, 0).getTime();

  const PHONE = day(7, 35, 30);
  const EVENT = day(7, 34, 58);
  const OFFSET = -32_000;

  it('derives a negative offset when the event clock is behind', () => {
    expect(clockOffsetMs(EVENT, PHONE)).toBe(OFFSET);
  });

  it('derives a positive offset when the event clock is ahead', () => {
    expect(clockOffsetMs(day(7, 36, 10), PHONE)).toBe(40_000);
  });

  it('converts phone now into event now', () => {
    expect(eventNowMs(PHONE, OFFSET)).toBe(EVENT);
  });

  it('maps a 9am event key time onto the later phone instant', () => {
    // Event clock lags by 32s, so event-9:00:00 happens at phone-9:00:32.
    const phoneInstant = eventTimeToPhoneEpochMs(day(9, 0, 0), OFFSET);
    expect(phoneInstant).toBe(day(9, 0, 32));
  });

  it('round-trips between the two clocks', () => {
    const t = day(9, 12, 0);
    expect(eventNowMs(eventTimeToPhoneEpochMs(t, OFFSET), OFFSET)).toBe(t);
  });

  it('is identity at zero offset', () => {
    expect(eventTimeToPhoneEpochMs(PHONE, 0)).toBe(PHONE);
    expect(eventNowMs(PHONE, 0)).toBe(PHONE);
  });

  it('formats signed offsets', () => {
    expect(formatOffset(-32_000)).toBe('-32s');
    expect(formatOffset(40_000)).toBe('+40s');
    expect(formatOffset(0)).toBe('+0s');
    expect(formatOffset(-64_000)).toBe('-1m 04s');
  });
});
