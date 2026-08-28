import { validateKeyTimes } from './route-sheet';
import {
  BEEHIVE_2026_AB,
  BEEHIVE_2026_AB_CHECKPOINTS,
  BEEHIVE_2026_ALL_OTHERS,
  BEEHIVE_2026_ALL_OTHERS_CHECKPOINTS,
} from './beehive-2026';

// This is the trust gate for a hand-transcribed route sheet: every key time
// the organizer printed must fall out of computeKeyTime() run over these
// segments. If someone fat-fingers a distance or a speed while transcribing
// next year's sheet, this is what catches it before ride day.

describe('2026 Beehive — A & B riders', () => {
  it('reproduces every printed key time', () => {
    expect(() =>
      validateKeyTimes(BEEHIVE_2026_AB.segments, BEEHIVE_2026_AB_CHECKPOINTS)
    ).not.toThrow();
  });

  it('totals 105.0 miles (leg 1 + leg 2 + leg 3 A&B tail)', () => {
    const total = BEEHIVE_2026_AB.segments.reduce((sum, s) => sum + s.distance, 0);
    expect(total).toBeCloseTo(105.0, 2);
  });
});

describe('2026 Beehive — All others', () => {
  it('reproduces every printed key time', () => {
    expect(() =>
      validateKeyTimes(BEEHIVE_2026_ALL_OTHERS.segments, BEEHIVE_2026_ALL_OTHERS_CHECKPOINTS)
    ).not.toThrow();
  });

  it('totals 95.4 miles (leg 1 + leg 2 + leg 3 all-others tail)', () => {
    const total = BEEHIVE_2026_ALL_OTHERS.segments.reduce((sum, s) => sum + s.distance, 0);
    expect(total).toBeCloseTo(95.4, 2);
  });
});

describe('validateKeyTimes', () => {
  it('throws, listing the mismatch, when a segment is wrong', () => {
    // A speed typo misaligns key time immediately within that segment,
    // unlike a distance typo (which only misaligns segments further out) —
    // this is the more direct way to prove the gate actually catches errors.
    const brokenSegments = BEEHIVE_2026_AB.segments.map((s, i) =>
      i === 0 ? { ...s, speed: 25 } : s
    );
    expect(() => validateKeyTimes(brokenSegments, BEEHIVE_2026_AB_CHECKPOINTS)).toThrow(
      /CHANGE 30 MPH.*mile 9.2/
    );
  });
});
