import { replayRide, type RawCscRow } from './replay';
import type { Segment } from './pace-engine';

// Synthetic corpus builder.
// Generates raw_csc_log rows as if the sensor sent one notification per second.
// revPerSec: how many wheel revolutions per notification interval.
// durationSec: how many notifications to generate.
// startRevs: initial cumulative_revs value (allows stitching after power-cycle).
// startTimeMs: wall clock at first notification.
// startEventTime: wheel_event_time at first notification (1/1024s units, 16-bit).
function buildCorpus(opts: {
  revPerSec: number;
  durationSec: number;
  startRevs?: number;
  startTimeMs?: number;
  startEventTime?: number;
}): RawCscRow[] {
  const {
    revPerSec,
    durationSec,
    startRevs = 0,
    startTimeMs = 0,
    startEventTime = 0,
  } = opts;

  const rows: RawCscRow[] = [];
  for (let i = 0; i < durationSec; i++) {
    rows.push({
      wall_clock_ms: startTimeMs + i * 1000,
      cumulative_revs: (startRevs + i * revPerSec) >>> 0, // keep 32-bit unsigned
      wheel_event_time: (startEventTime + i * 1024) & 0xffff, // 16-bit rollover
    });
  }
  return rows;
}

// Two scored segments + one free section, with a reset checkpoint at segment 2.
// Segment 1: 1 mile at 30 mph (120 seconds of key time)
// Segment 2: free (0.25 miles, clock paused)
// Segment 3: 1 mile at 24 mph (150 seconds of key time), reset checkpoint
const TEST_SEGMENTS: Segment[] = [
  { distance: 1.0, speed: 30, isReset: false, isFree: false, label: 'Seg 1' },
  { distance: 0.25, speed: null, isReset: false, isFree: true, label: 'Transfer' },
  { distance: 1.0, speed: 24, isReset: true, isFree: false, label: 'Seg 2 (reset)' },
];

// 30 mph at 2183mm wheel circumference:
// 30 mph = 13.411 m/s; 13.411 / 2.183 = 6.143 rev/s → use 6 rev/s (≈29.3 mph)
// That gives cumulativeDistance increment per second:
// 6 * 2.183m / 1609.34m/mi = 0.008138 mi/s → 1 mile in ~122.9 seconds
const REV_PER_SEC_30MPH = 6;

// 24 mph = 10.733 m/s; 10.733 / 2.183 = 4.917 rev/s → use 5 rev/s (≈24.4 mph)
const REV_PER_SEC_24MPH = 5;

// Free section at 20 mph → 3 rev/s, just enough to cross 0.25 miles
const REV_PER_SEC_FREE = 3; // doesn't affect key time

const WHEEL_MM = 2183;
const RIDE_START_MS = 1_000_000; // arbitrary epoch anchor

describe('replayRide', () => {
  it('produces deviation points from a valid corpus', () => {
    const rows = buildCorpus({ revPerSec: REV_PER_SEC_30MPH, durationSec: 10, startTimeMs: RIDE_START_MS });
    const { points } = replayRide(rows, TEST_SEGMENTS, WHEEL_MM, RIDE_START_MS);
    // First row is always null (no previous state), so 9 points
    expect(points.length).toBe(9);
    expect(points[0].cumulativeDistanceMi).toBeGreaterThan(0);
  });

  it('deviation is near zero when riding at exactly the required speed', () => {
    // 6 rev/s ≈ 29.3 mph; required is 30 mph. Deviation should be small and positive
    // (slightly slow) but under 5 seconds after 10 seconds of riding.
    const rows = buildCorpus({ revPerSec: REV_PER_SEC_30MPH, durationSec: 10, startTimeMs: RIDE_START_MS });
    const { points } = replayRide(rows, TEST_SEGMENTS, WHEEL_MM, RIDE_START_MS);
    const last = points[points.length - 1];
    expect(Math.abs(last.deviationSeconds)).toBeLessThan(5);
  });

  it('free section does not accumulate key time', () => {
    // Ride through segment 1 then into the free section.
    // At 6 rev/s for 123s we cover ~1 mile (segment 1).
    // Then ride free section: key time should freeze.
    const seg1 = buildCorpus({ revPerSec: REV_PER_SEC_30MPH, durationSec: 123, startTimeMs: RIDE_START_MS });
    const lastSeg1 = seg1[seg1.length - 1];
    const freeSection = buildCorpus({
      revPerSec: REV_PER_SEC_FREE,
      durationSec: 30,
      startRevs: lastSeg1.cumulative_revs + REV_PER_SEC_FREE,
      startTimeMs: RIDE_START_MS + 123_000,
      startEventTime: (lastSeg1.wheel_event_time + 1024) & 0xffff,
    });

    const rows = [...seg1, ...freeSection];
    const { points } = replayRide(rows, TEST_SEGMENTS, WHEEL_MM, RIDE_START_MS);

    // Find the first point in the free section (distance > 1 mile)
    const freePoints = points.filter(p => p.cumulativeDistanceMi > 1.0 && p.cumulativeDistanceMi < 1.25);
    expect(freePoints.length).toBeGreaterThan(0);

    // Key time should be frozen during the free section, so deviation grows
    // at the rate of elapsed real time (1 sec per sec, clock paused).
    // Each successive free-section point should have increasing deviation.
    for (let i = 1; i < freePoints.length; i++) {
      expect(freePoints[i].deviationSeconds).toBeGreaterThan(freePoints[i - 1].deviationSeconds);
    }
  });

  it('power-cycle in the middle: null notification logged, recovery on next packet', () => {
    // Build 20 seconds of normal riding, then simulate a power-cycle
    // (counter resets to 0), then resume normal riding.
    const before = buildCorpus({
      revPerSec: REV_PER_SEC_30MPH,
      durationSec: 20,
      startTimeMs: RIDE_START_MS,
    });
    const lastBefore = before[before.length - 1];

    // Power-cycle row: counter resets to 0, one second later
    const powerCycleRow: RawCscRow = {
      wall_clock_ms: RIDE_START_MS + 20_000,
      cumulative_revs: 0,
      wheel_event_time: (lastBefore.wheel_event_time + 1024) & 0xffff,
    };

    // Resume from 0 after power-cycle
    const after = buildCorpus({
      revPerSec: REV_PER_SEC_30MPH,
      durationSec: 10,
      startRevs: REV_PER_SEC_30MPH, // first notification after reset has deltaRevs=6
      startTimeMs: RIDE_START_MS + 21_000,
      startEventTime: (powerCycleRow.wheel_event_time + 1024) & 0xffff,
    });

    const rows = [...before, powerCycleRow, ...after];
    const { points } = replayRide(rows, TEST_SEGMENTS, WHEEL_MM, RIDE_START_MS);

    // The power-cycle row produces no point (parser returns null update and
    // re-baselines cscState to {revs: 0} in the same step). The next row
    // has a clean positive delta from 0 and produces a valid point.
    // Before: 20 rows → 19 points (first row has no prev). Power-cycle: 0 points.
    // After: 10 rows → 10 points (all have valid deltas from the re-baseline).
    // Total: 29.
    expect(points.length).toBe(29);

    // Distance should be continuous across the gap (no jump, no reset)
    const beforePoints = points.slice(0, 19);
    const afterPoints = points.slice(19);
    expect(afterPoints[0].cumulativeDistanceMi).toBeGreaterThan(
      beforePoints[beforePoints.length - 1].cumulativeDistanceMi
    );
  });

  it('snapshot: synthetic corpus produces stable deviation series', () => {
    // Full synthetic ride: seg1 → free → seg2.
    // Deviation at end of each segment is the ground truth we snapshot.
    // Any change to the engine or parser that shifts these numbers will fail this test.
    const seg1 = buildCorpus({
      revPerSec: REV_PER_SEC_30MPH,
      durationSec: 123,
      startTimeMs: RIDE_START_MS,
    });
    const lastSeg1 = seg1[seg1.length - 1];

    const freeRows = buildCorpus({
      revPerSec: REV_PER_SEC_FREE,
      durationSec: 30,
      startRevs: lastSeg1.cumulative_revs + REV_PER_SEC_FREE,
      startTimeMs: RIDE_START_MS + 123_000,
      startEventTime: (lastSeg1.wheel_event_time + 1024) & 0xffff,
    });
    const lastFree = freeRows[freeRows.length - 1];

    const seg2 = buildCorpus({
      revPerSec: REV_PER_SEC_24MPH,
      durationSec: 120,
      startRevs: lastFree.cumulative_revs + REV_PER_SEC_24MPH,
      startTimeMs: RIDE_START_MS + 153_000,
      startEventTime: (lastFree.wheel_event_time + 1024) & 0xffff,
    });

    const rows = [...seg1, ...freeRows, ...seg2];
    const { points } = replayRide(rows, TEST_SEGMENTS, WHEEL_MM, RIDE_START_MS);

    // Snapshot the last point of each section:
    // End of seg1 (distance just under 1 mile)
    const endSeg1 = points.filter(p => p.cumulativeDistanceMi < 1.0).at(-1)!;
    // End of free section (distance just under 1.25 miles)
    const endFree = points.filter(p => p.cumulativeDistanceMi >= 1.0 && p.cumulativeDistanceMi < 1.25).at(-1)!;
    // End of seg2
    const endSeg2 = points.at(-1)!;

    // Snapshot these values. If the engine changes and shifts them, this test
    // catches it. Update the snapshot intentionally when the change is correct.
    expect(endSeg1.cumulativeDistanceMi).toMatchSnapshot('seg1 end distance');
    expect(endSeg1.deviationSeconds).toMatchSnapshot('seg1 end deviation');
    expect(endFree.deviationSeconds).toMatchSnapshot('free end deviation');
    expect(endSeg2.cumulativeDistanceMi).toMatchSnapshot('seg2 end distance');
    expect(endSeg2.deviationSeconds).toMatchSnapshot('seg2 end deviation');
  });
});
