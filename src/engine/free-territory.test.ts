import {
  deriveEvents,
  courseLength,
  freeIntervals,
  mergeIntervals,
  freeTerritory,
  checkableTerritory,
  freeTerritoryAt,
  AMA_DEFAULTS,
  type FtSegment,
  type FtRules,
  type FtInterval,
} from './free-territory';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function seg(distance: number, checkType?: FtSegment['checkType'], label?: string): FtSegment {
  return { distance, speed: 24, isReset: false, isFree: false, checkType, label };
}

const RULES = AMA_DEFAULTS; // 3mi after check, 2mi before gas, 3mi after gas, 2.9mi cal

function noSecrets(overrides?: Partial<FtRules>): FtRules {
  return { ...RULES, hasSecretChecks: false, ...overrides };
}

function intervalContains(intervals: FtInterval[], mile: number): boolean {
  return intervals.some(z => mile >= z.start && mile <= z.end);
}

// -------------------------------------------------------------------------
// deriveEvents
// -------------------------------------------------------------------------

describe('deriveEvents', () => {
  it('always emits start at mile 0', () => {
    const events = deriveEvents([seg(5)]);
    expect(events[0]).toMatchObject({ type: 'start', mile: 0 });
  });

  it('emits check at cumulative end-mile of segment', () => {
    const segments = [seg(5), seg(3, 'known', 'Check 1'), seg(4)];
    const events = deriveEvents(segments);
    expect(events).toContainEqual(expect.objectContaining({ type: 'check', mile: 8 }));
  });

  it('emits gas event', () => {
    const segments = [seg(10, 'gas', 'Gas 1')];
    const events = deriveEvents(segments);
    expect(events).toContainEqual(expect.objectContaining({ type: 'gas', mile: 10 }));
  });

  it('ignores segments with no checkType', () => {
    const events = deriveEvents([seg(5), seg(3)]);
    expect(events).toHaveLength(1); // only start
  });

  it('emits finish event', () => {
    const segments = [seg(10), seg(2, 'finish')];
    const events = deriveEvents(segments);
    expect(events).toContainEqual(expect.objectContaining({ type: 'finish', mile: 12 }));
  });
});

// -------------------------------------------------------------------------
// courseLength
// -------------------------------------------------------------------------

describe('courseLength', () => {
  it('sums all segment distances', () => {
    expect(courseLength([seg(3), seg(4), seg(5)])).toBe(12);
  });

  it('handles empty course', () => {
    expect(courseLength([])).toBe(0);
  });
});

// -------------------------------------------------------------------------
// hasSecretChecks gate
// -------------------------------------------------------------------------

describe('format gating', () => {
  const segments = [seg(5, 'known'), seg(10, 'gas'), seg(5)];

  it('freeIntervals returns empty when hasSecretChecks is false', () => {
    expect(freeIntervals(segments, noSecrets())).toHaveLength(0);
  });

  it('freeTerritory returns empty when hasSecretChecks is false', () => {
    expect(freeTerritory(segments, noSecrets())).toHaveLength(0);
  });

  it('checkableTerritory returns empty when hasSecretChecks is false', () => {
    expect(checkableTerritory(segments, noSecrets())).toHaveLength(0);
  });

  it('freeTerritoryAt returns false when hasSecretChecks is false', () => {
    expect(freeTerritoryAt(1, segments, noSecrets())).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Calibration zone rule
// -------------------------------------------------------------------------

describe('calibration zone', () => {
  const segments = [seg(10)]; // plain course, no checks

  it('marks 0 to ftCalibrationMile as free', () => {
    const intervals = freeIntervals(segments, RULES);
    const cal = intervals.find(i => i.reasons.includes('calibration'));
    expect(cal).toBeDefined();
    expect(cal!.start).toBe(0);
    expect(cal!.end).toBe(RULES.ftCalibrationMile); // 2.9
  });

  it('freeTerritoryAt 1.0 is true (inside calibration zone)', () => {
    expect(freeTerritoryAt(1.0, segments, RULES)).toBe(true);
  });

  it('freeTerritoryAt 2.9 is true (edge of calibration zone)', () => {
    expect(freeTerritoryAt(2.9, segments, RULES)).toBe(true);
  });

  it('freeTerritoryAt 3.5 is false (outside calibration, no other rules)', () => {
    expect(freeTerritoryAt(3.5, segments, RULES)).toBe(false);
  });
});

// -------------------------------------------------------------------------
// After-check rule
// -------------------------------------------------------------------------

describe('after-check rule', () => {
  // Check at mile 10, course 20 miles
  const segments = [seg(10, 'known'), seg(10)];

  it('produces free interval [10, 13] after a check at mile 10', () => {
    const intervals = freeIntervals(segments, RULES);
    const afterCheck = intervals.find(i => i.reasons.some(r => r.startsWith('after-check')));
    expect(afterCheck).toBeDefined();
    expect(afterCheck!.start).toBe(10);
    expect(afterCheck!.end).toBe(13); // 10 + 3mi
  });

  it('freeTerritoryAt 11 is true (inside after-check zone)', () => {
    expect(freeTerritoryAt(11, segments, RULES)).toBe(true);
  });

  it('freeTerritoryAt 13 is true (edge of after-check zone)', () => {
    expect(freeTerritoryAt(13, segments, RULES)).toBe(true);
  });

  it('freeTerritoryAt 13.1 is false (past after-check zone)', () => {
    expect(freeTerritoryAt(13.1, segments, RULES)).toBe(false);
  });

  it('all check types (secret, emergency) also trigger after-check rule', () => {
    const secretSeg = [seg(10, 'secret'), seg(10)];
    const emergSeg = [seg(10, 'emergency'), seg(10)];
    expect(freeTerritoryAt(11, secretSeg, RULES)).toBe(true);
    expect(freeTerritoryAt(11, emergSeg, RULES)).toBe(true);
  });
});

// -------------------------------------------------------------------------
// Gas stop rule
// -------------------------------------------------------------------------

describe('gas stop rule', () => {
  // Gas at mile 15, course 25 miles
  const segments = [seg(15, 'gas'), seg(10)];

  it('produces free interval [13, 15] before gas', () => {
    const intervals = freeIntervals(segments, RULES);
    const beforeGas = intervals.find(i => i.reasons.some(r => r.startsWith('before-gas')));
    expect(beforeGas).toBeDefined();
    expect(beforeGas!.start).toBe(13); // 15 - 2mi
    expect(beforeGas!.end).toBe(15);
  });

  it('produces free interval [15, 18] after gas', () => {
    const intervals = freeIntervals(segments, RULES);
    const afterGas = intervals.find(i => i.reasons.some(r => r.startsWith('after-gas')));
    expect(afterGas).toBeDefined();
    expect(afterGas!.start).toBe(15);
    expect(afterGas!.end).toBe(18); // 15 + 3mi
  });

  it('freeTerritoryAt 14 is true (before-gas zone)', () => {
    expect(freeTerritoryAt(14, segments, RULES)).toBe(true);
  });

  it('freeTerritoryAt 16 is true (after-gas zone)', () => {
    expect(freeTerritoryAt(16, segments, RULES)).toBe(true);
  });

  it('freeTerritoryAt 12 is false (before the before-gas zone)', () => {
    expect(freeTerritoryAt(12, segments, RULES)).toBe(false);
  });

  it('clamped before-gas does not go below 0', () => {
    const earlyGas = [seg(1, 'gas'), seg(20)]; // gas at mile 1, before-gas would be [-1, 1]
    const intervals = freeIntervals(earlyGas, RULES);
    const beforeGas = intervals.find(i => i.reasons.some(r => r.startsWith('before-gas')));
    expect(beforeGas!.start).toBe(0);
  });
});

// -------------------------------------------------------------------------
// mergeIntervals
// -------------------------------------------------------------------------

describe('mergeIntervals', () => {
  it('merges overlapping intervals and joins reasons', () => {
    const input: FtInterval[] = [
      { start: 0, end: 5, reasons: ['a'] },
      { start: 3, end: 8, reasons: ['b'] },
    ];
    const result = mergeIntervals(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ start: 0, end: 8 });
    expect(result[0].reasons).toContain('a');
    expect(result[0].reasons).toContain('b');
  });

  it('merges touching intervals (end == start)', () => {
    const input: FtInterval[] = [
      { start: 0, end: 5, reasons: ['a'] },
      { start: 5, end: 8, reasons: ['b'] },
    ];
    const result = mergeIntervals(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ start: 0, end: 8 });
  });

  it('keeps disjoint intervals separate', () => {
    const input: FtInterval[] = [
      { start: 0, end: 3, reasons: ['a'] },
      { start: 5, end: 8, reasons: ['b'] },
    ];
    const result = mergeIntervals(input);
    expect(result).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(mergeIntervals([])).toHaveLength(0);
  });

  it('does not duplicate reasons when two intervals have the same reason', () => {
    const input: FtInterval[] = [
      { start: 0, end: 5, reasons: ['cal'] },
      { start: 3, end: 6, reasons: ['cal'] },
    ];
    const result = mergeIntervals(input);
    expect(result[0].reasons.filter(r => r === 'cal')).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------
// checkableTerritory (inverse)
// -------------------------------------------------------------------------

describe('checkableTerritory', () => {
  it('returns the gaps between free zones', () => {
    // Course: 20 miles. Calibration [0,2.9]. Check at 10 → after-check [10,13].
    const segments = [seg(10, 'known'), seg(10)];
    const checkable = checkableTerritory(segments, RULES);

    // Should have a gap between end of calibration (2.9) and start of after-check (10)
    const gap = checkable.find(z => z.start >= 2.9 && z.end <= 10);
    expect(gap).toBeDefined();
    expect(gap!.start).toBeCloseTo(2.9);
    expect(gap!.end).toBe(10);
  });

  it('covers the tail after the last free zone', () => {
    const segments = [seg(10, 'known'), seg(10)];
    const checkable = checkableTerritory(segments, RULES);
    const tail = checkable.find(z => z.start >= 13);
    expect(tail).toBeDefined();
    expect(tail!.end).toBe(20);
  });

  it('free + checkable spans cover the entire course with no overlap', () => {
    const segments = [seg(5, 'known'), seg(5, 'gas'), seg(10)];
    const free = freeTerritory(segments, RULES);
    const checkable = checkableTerritory(segments, RULES);
    const total = courseLength(segments); // 20

    const allZones = [...free, ...checkable].sort((a, b) => a.start - b.start);

    // No gaps in coverage
    let cursor = 0;
    for (const z of allZones) {
      expect(z.start).toBeCloseTo(cursor, 5);
      cursor = z.end;
    }
    expect(cursor).toBeCloseTo(total, 5);

    // No overlaps between free and checkable
    for (const fz of free) {
      for (const cz of checkable) {
        const overlaps = fz.start < cz.end && cz.start < fz.end;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('returns full course as checkable when no rules produce free zones', () => {
    // No calibration, no checks, no gas — every mile is checkable
    const zeroCalRules: FtRules = { ...RULES, ftCalibrationMile: 0 };
    const segments = [seg(10)];
    const checkable = checkableTerritory(segments, zeroCalRules);
    expect(checkable).toHaveLength(1);
    expect(checkable[0]).toMatchObject({ start: 0, end: 10 });
  });
});

// -------------------------------------------------------------------------
// Realistic multi-event course
// -------------------------------------------------------------------------

describe('realistic multi-event course', () => {
  // 50-mile course:
  // [0-8]   plain riding
  // Check 1 (known) at mile 8
  // [8-20]  plain riding
  // Gas at mile 20 (zero-length marker)
  // [20-35] plain riding
  // Check 2 (secret) at mile 35
  // [35-50] plain riding to finish
  const segments: FtSegment[] = [
    seg(8, 'known', 'Check 1'),   // check at mile 8
    seg(12),                       // plain to mile 20
    seg(0, 'gas', 'Gas 1'),       // gas at mile 20 (zero-length marker)
    seg(15, 'secret', 'Check 2'), // secret check at mile 35
    seg(15, 'finish', 'Finish'),  // finish at mile 50
  ];

  const total = courseLength(segments); // 50

  it('course is 50 miles', () => {
    expect(total).toBe(50);
  });

  it('calibration zone covers [0, 2.9]', () => {
    expect(freeTerritoryAt(1, segments, RULES)).toBe(true);
    expect(freeTerritoryAt(2.9, segments, RULES)).toBe(true);
  });

  it('after-check 1 covers [8, 11]', () => {
    expect(freeTerritoryAt(8, segments, RULES)).toBe(true);
    expect(freeTerritoryAt(11, segments, RULES)).toBe(true);
    expect(freeTerritoryAt(11.1, segments, RULES)).toBe(false);
  });

  it('before-gas covers [18, 20]', () => {
    expect(freeTerritoryAt(18, segments, RULES)).toBe(true);
    expect(freeTerritoryAt(19.9, segments, RULES)).toBe(true);
  });

  it('after-gas covers [20, 23]', () => {
    expect(freeTerritoryAt(20, segments, RULES)).toBe(true);
    expect(freeTerritoryAt(23, segments, RULES)).toBe(true);
    expect(freeTerritoryAt(23.1, segments, RULES)).toBe(false);
  });

  it('gap between check1 zone and before-gas is checkable', () => {
    // [11, 18] is checkable (after after-check1, before before-gas)
    const checkable = checkableTerritory(segments, RULES);
    expect(intervalContains(checkable, 14)).toBe(true);
    expect(intervalContains(checkable, 11.1)).toBe(true);
    expect(intervalContains(checkable, 17.9)).toBe(true);
  });

  it('after-check 2 covers [35, 38]', () => {
    expect(freeTerritoryAt(35, segments, RULES)).toBe(true);
    expect(freeTerritoryAt(38, segments, RULES)).toBe(true);
    expect(freeTerritoryAt(38.1, segments, RULES)).toBe(false);
  });

  it('tail [38.1, 50] is checkable', () => {
    const checkable = checkableTerritory(segments, RULES);
    expect(intervalContains(checkable, 45)).toBe(true);
    expect(intervalContains(checkable, 50)).toBe(true);
  });

  it('free + checkable covers entire 50-mile course exactly', () => {
    const free = freeTerritory(segments, RULES);
    const checkable = checkableTerritory(segments, RULES);
    const allZones = [...free, ...checkable].sort((a, b) => a.start - b.start);

    let cursor = 0;
    for (const z of allZones) {
      expect(z.start).toBeCloseTo(cursor, 5);
      cursor = z.end;
    }
    expect(cursor).toBeCloseTo(total, 5);
  });

  it('free map has correct number of merged zones', () => {
    const free = freeTerritory(segments, RULES);
    // Expected merged zones: [0,2.9] cal, [8,11] after-check1,
    // [18,23] before+after gas merged, [35,38] after-check2
    // cal and after-check1 are disjoint (2.9 < 8), so 4 zones total
    expect(free).toHaveLength(4);
  });
});
