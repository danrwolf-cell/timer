import {
  detectSegment,
  computeKeyTime,
  computeDeviation,
  isInFreeSegment,
  distanceToNextEvent,
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
