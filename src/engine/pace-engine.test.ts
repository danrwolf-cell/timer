import {
  detectSegment,
  computeKeyTime,
  computeDeviation,
  isInFreeSegment,
  distanceToNextEvent,
  crossedReset,
  type Segment,
} from './pace-engine';

const scored = (distance: number, speed: number, isReset = false): Segment => ({
  distance,
  speed,
  isReset,
  isFree: false,
});

const free = (distance: number): Segment => ({
  distance,
  speed: null,
  isReset: false,
  isFree: true,
});

describe('detectSegment', () => {
  const segments = [scored(5, 24), scored(3, 30), free(2), scored(4, 24)];

  it('places rider in first segment at start', () => {
    const pos = detectSegment(segments, 0);
    expect(pos.segmentIndex).toBe(0);
    expect(pos.distanceInSegment).toBe(0);
  });

  it('places rider mid first segment', () => {
    const pos = detectSegment(segments, 2.5);
    expect(pos.segmentIndex).toBe(0);
    expect(pos.distanceInSegment).toBeCloseTo(2.5);
  });

  it('places rider in second segment', () => {
    const pos = detectSegment(segments, 6);
    expect(pos.segmentIndex).toBe(1);
    expect(pos.distanceInSegment).toBeCloseTo(1);
  });

  it('places rider in free segment', () => {
    const pos = detectSegment(segments, 8.5);
    expect(pos.segmentIndex).toBe(2);
    expect(pos.distanceInSegment).toBeCloseTo(0.5);
  });
});

describe('computeKeyTime', () => {
  const segments = [scored(5, 30), free(2), scored(3, 24)];

  it('returns 0 at start', () => {
    expect(computeKeyTime(segments, 0, 0)).toBe(0);
  });

  it('calculates partial segment key time', () => {
    // 2.5 miles at 30mph = 5 minutes = 300s
    expect(computeKeyTime(segments, 0, 2.5)).toBeCloseTo(300);
  });

  it('calculates completed first segment correctly', () => {
    // 5 miles at 30mph = 10 min = 600s
    expect(computeKeyTime(segments, 1, 0)).toBeCloseTo(600);
  });

  it('does not accumulate key time in free segment', () => {
    // Still 600s — clock paused in free section
    expect(computeKeyTime(segments, 1, 1)).toBeCloseTo(600);
  });

  it('accumulates after free segment', () => {
    // 600s + (1.5mi / 24mph * 3600) = 600 + 225 = 825s
    expect(computeKeyTime(segments, 2, 1.5)).toBeCloseTo(825);
  });
});

describe('computeDeviation', () => {
  it('returns positive when late', () => {
    expect(computeDeviation(610, 600)).toBeCloseTo(10);
  });

  it('returns negative when early', () => {
    expect(computeDeviation(590, 600)).toBeCloseTo(-10);
  });

  it('returns zero when on time', () => {
    expect(computeDeviation(600, 600)).toBe(0);
  });
});

describe('isInFreeSegment', () => {
  const segments = [scored(5, 30), free(2)];

  it('false for scored segment', () => {
    expect(isInFreeSegment(segments, 0)).toBe(false);
  });

  it('true for free segment', () => {
    expect(isInFreeSegment(segments, 1)).toBe(true);
  });
});

describe('distanceToNextEvent', () => {
  const segments = [scored(5, 30), free(2)];

  it('returns distance remaining in current segment', () => {
    const pos = { segmentIndex: 0, distanceInSegment: 3, cumulativeDistance: 3 };
    expect(distanceToNextEvent(segments, pos)).toBeCloseTo(2);
  });
});

describe('crossedReset', () => {
  // Segments: plain, plain, reset, plain, reset
  const segments: Segment[] = [
    scored(5, 30, false), // 0
    scored(5, 30, false), // 1
    scored(5, 30, true),  // 2 — reset
    scored(5, 30, false), // 3
    scored(5, 30, true),  // 4 — reset
  ];

  it('returns false when segment index has not advanced', () => {
    expect(crossedReset(segments, 1, 1)).toBe(false);
  });

  it('returns false when current index is behind prev (should never happen in practice)', () => {
    expect(crossedReset(segments, 3, 2)).toBe(false);
  });

  it('returns false when advancing forward but no reset in range', () => {
    // Moving from 0 to 1 — segment 1 has no reset
    expect(crossedReset(segments, 0, 1)).toBe(false);
  });

  it('returns true when directly entering a reset segment', () => {
    // Moving from 1 to 2 — segment 2 is a reset
    expect(crossedReset(segments, 1, 2)).toBe(true);
  });

  it('returns true when reset segment is skipped past (current index > reset index)', () => {
    // Moving from 1 to 3 in one update — segment 2 (reset) was crossed
    expect(crossedReset(segments, 1, 3)).toBe(true);
  });

  it('returns true when multiple boundaries crossed and reset is not the final segment', () => {
    // Moving from 0 to 3 — segment 2 (reset) is in the middle of the crossed range
    expect(crossedReset(segments, 0, 3)).toBe(true);
  });

  it('returns true for the second reset when crossing from 3 to 4', () => {
    expect(crossedReset(segments, 3, 4)).toBe(true);
  });

  it('returns true when both resets are crossed in one update', () => {
    // Moving from 0 to 4 in a single huge jump
    expect(crossedReset(segments, 0, 4)).toBe(true);
  });

  it('returns false on out-of-bounds current index (no segment there)', () => {
    // Segment 5 does not exist — segments[5] is undefined, safe to call
    expect(crossedReset(segments, 4, 5)).toBe(false);
  });
});
