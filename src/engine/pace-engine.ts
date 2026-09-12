export type CheckType = 'known' | 'secret' | 'emergency' | 'gas' | 'start' | 'finish';

export interface Segment {
  distance: number;   // miles
  speed: number | null; // required avg mph, null = free/transfer
  isReset: boolean;
  isFree: boolean;
  label?: string;
  checkType?: CheckType; // type of event at the END of this segment; pace engine ignores it
  // Fixed seconds this segment adds to the key-time schedule, independent of
  // distance/speed — a scheduled pause or gas-stop wait printed on the sheet
  // (e.g. "PAUSE 21 MINS."). Distance is typically 0. Applies regardless of
  // isFree/speed: a pause has no pace to score, but the printed key times
  // downstream still assume its duration passed, so it must still count
  // against the clock (unlike a plain free/transfer segment, which
  // contributes nothing).
  holdSeconds?: number;
}

export interface RidePosition {
  segmentIndex: number;
  distanceInSegment: number; // miles into current segment
  cumulativeDistance: number; // total miles
}

export function detectSegment(segments: Segment[], cumulativeDistance: number): RidePosition {
  let remaining = cumulativeDistance;
  for (let i = 0; i < segments.length; i++) {
    if (remaining <= segments[i].distance || i === segments.length - 1) {
      return {
        segmentIndex: i,
        distanceInSegment: remaining,
        cumulativeDistance,
      };
    }
    remaining -= segments[i].distance;
  }
  return { segmentIndex: 0, distanceInSegment: 0, cumulativeDistance };
}

// Returns key time in seconds for completed scored segments before segmentIndex
export function completedKeyTime(segments: Segment[], segmentIndex: number): number {
  let keyTime = 0;
  for (let i = 0; i < segmentIndex; i++) {
    const seg = segments[i];
    if (!seg.isFree && seg.speed !== null) {
      keyTime += (seg.distance / seg.speed) * 3600;
    }
    keyTime += seg.holdSeconds ?? 0;
  }
  return keyTime;
}

// Returns key time in seconds including partial contribution of current segment
export function computeKeyTime(
  segments: Segment[],
  segmentIndex: number,
  distanceInSegment: number
): number {
  const completed = completedKeyTime(segments, segmentIndex);
  const current = segments[segmentIndex];
  const hold = current.holdSeconds ?? 0;
  if (current.isFree || current.speed === null) {
    return completed + hold;
  }
  return completed + (distanceInSegment / current.speed) * 3600 + hold;
}

// Positive = late, negative = early (seconds)
export function computeDeviation(elapsedSeconds: number, keyTimeSeconds: number): number {
  return elapsedSeconds - keyTimeSeconds;
}

export function isInFreeSegment(segments: Segment[], segmentIndex: number): boolean {
  return segments[segmentIndex]?.isFree || segments[segmentIndex]?.speed === null;
}

export function distanceToNextEvent(segments: Segment[], position: RidePosition): number | null {
  const current = segments[position.segmentIndex];
  if (!current) return null;
  return current.distance - position.distanceInSegment;
}

/**
 * Returns true if any segment boundary crossed since the last update carried
 * a reset checkpoint.
 *
 * Keying off index advance rather than proximity to the segment start means
 * a reset cannot be silently dropped because two BLE notifications bracketed
 * the boundary and the second landed more than the proximity threshold past it.
 * Also handles the case where multiple boundaries are crossed in one update —
 * the reset need not be on the final segment entered.
 */
export function crossedReset(
  segments: Segment[],
  prevSegmentIndex: number,
  currentSegmentIndex: number
): boolean {
  if (currentSegmentIndex <= prevSegmentIndex) return false;
  for (let i = prevSegmentIndex + 1; i <= currentSegmentIndex; i++) {
    if (segments[i]?.isReset) return true;
  }
  return false;
}
