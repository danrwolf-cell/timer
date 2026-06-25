export interface Segment {
  distance: number;   // miles
  speed: number | null; // required avg mph, null = free/transfer
  isReset: boolean;
  isFree: boolean;
  label?: string;
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
  if (current.isFree || current.speed === null) {
    return completed;
  }
  return completed + (distanceInSegment / current.speed) * 3600;
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
