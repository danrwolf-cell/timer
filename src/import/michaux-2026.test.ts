import { validateKeyTimes } from './route-sheet';
import { MICHAUX_2026, MICHAUX_2026_CHECKPOINTS } from './michaux-2026';

// Trust gate for the hand-transcribed sheet: every key time the organizer
// printed must fall out of computeKeyTime() run over these segments.

describe('2026 Michaux Enduro', () => {
  it('reproduces every printed key time', () => {
    expect(() =>
      validateKeyTimes(MICHAUX_2026.segments, MICHAUX_2026_CHECKPOINTS)
    ).not.toThrow();
  });

  it('totals 81.40 miles (column 1 + column 2, odometer restart at the gas stop)', () => {
    const total = MICHAUX_2026.segments.reduce((sum, s) => sum + s.distance, 0);
    expect(total).toBeCloseTo(81.40, 2);
  });

  it('has 29 segments and 13 free zones, matching the printed sheet', () => {
    expect(MICHAUX_2026.segments).toHaveLength(29);
    expect(MICHAUX_2026.freeZones).toHaveLength(13);
  });

  it('carries the 10-minute and 21-minute pauses as holdSeconds, not distance', () => {
    const pauses = MICHAUX_2026.segments.filter(s => (s.holdSeconds ?? 0) > 0);
    expect(pauses.map(s => s.holdSeconds)).toEqual([600, 1260, 60, 60, 60, 180, 60, 240]);
    expect(pauses.every(s => s.distance === 0)).toBe(true);
  });
});
