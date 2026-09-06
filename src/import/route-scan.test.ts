import { clockTimesToSecondsSinceStart, toRouteSheetData, type ExtractedRouteSheet } from './route-scan';
import { checkKeyTimes } from './route-sheet';

describe('clockTimesToSecondsSinceStart', () => {
  it('handles times within the same AM/PM cycle with no wrap', () => {
    const secs = clockTimesToSecondsSinceStart('9:00', ['9:23', '9:31', '9:58']);
    expect(secs).toEqual([23 * 60, 31 * 60, 58 * 60]);
  });

  it('wraps forward across noon exactly once, matching the real Beehive sequence', () => {
    // 9:00 -> 11:53 -> 12:08 -> 12:39 -> 1:23, no AM/PM anywhere on the sheet.
    const secs = clockTimesToSecondsSinceStart('9:00', ['11:53', '12:08', '12:39', '1:23']);
    expect(secs).toEqual([
      173 * 60, // 11:53 = 2h53m after 9:00
      188 * 60, // 12:08 = 3h08m
      219 * 60, // 12:39 = 3h39m
      263 * 60, // 1:23 = 4h23m
    ]);
  });

  it('rejects an out-of-range clock string', () => {
    expect(() => clockTimesToSecondsSinceStart('9:00', ['13:00'])).toThrow(/out of range/);
  });

  it('rejects an unparseable clock string', () => {
    expect(() => clockTimesToSecondsSinceStart('9:00', ['nine ish'])).toThrow(/Unparseable/);
  });
});

describe('toRouteSheetData + checkKeyTimes (extraction -> engine round trip)', () => {
  const extracted: ExtractedRouteSheet = {
    routeName: 'Test Sheet',
    eventDate: '2026-08-30',
    startClockTime: '9:00',
    segments: [
      { distanceMi: 9.2, speedMph: 24, isFree: false, isReset: false, label: null, checkType: null },
      { distanceMi: 4.0, speedMph: 30, isFree: false, isReset: false, label: null, checkType: null },
    ],
    freeZones: [{ startMi: 5, endMi: 6, reason: 'landmark' }],
    checkpoints: [
      { label: 'CHANGE 30 MPH', afterMile: 9.2, clockTime: '9:23' },
      { label: 'CHANGE 24 MPH', afterMile: 13.2, clockTime: '9:31' },
    ],
  };

  it('converts cleanly and every checkpoint passes for a correct extraction', () => {
    const { routeSheet, checkpoints } = toRouteSheetData(extracted);
    expect(routeSheet.segments).toHaveLength(2);
    expect(routeSheet.freeZones).toEqual([{ start: 5, end: 6, reason: 'landmark' }]);

    const results = checkKeyTimes(routeSheet.segments, checkpoints);
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('surfaces a failing checkpoint without throwing, for review-screen use', () => {
    const bad: ExtractedRouteSheet = {
      ...extracted,
      segments: [{ ...extracted.segments[0], speedMph: 25 }, extracted.segments[1]],
    };
    const { routeSheet, checkpoints } = toRouteSheetData(bad);
    const results = checkKeyTimes(routeSheet.segments, checkpoints);
    expect(results[0].passed).toBe(false);
    expect(results[0].deltaSeconds).not.toBe(0);
  });
});
