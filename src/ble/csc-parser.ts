// CSC GATT characteristic 0x2A5B parser
// Wheel circumference in mm (default: 90/90-21 enduro front wheel)
export const DEFAULT_WHEEL_CIRCUMFERENCE_MM = 2183;

export interface CscState {
  cumulativeRevolutions: number;
  lastEventTime: number; // 1/1024 sec units, 16-bit
}

export interface CscUpdate {
  speedMph: number;
  deltaRevolutions: number;
  deltaTimeSeconds: number;
}

const TIMESTAMP_ROLLOVER = 65536; // 16-bit
const TIMESTAMP_UNITS = 1024;     // ticks per second

export function parseCscNotification(
  data: Uint8Array,
  prev: CscState | null,
  wheelCircumferenceMm: number = DEFAULT_WHEEL_CIRCUMFERENCE_MM
): { state: CscState; update: CscUpdate | null } {
  const flags = data[0];
  const hasWheelData = (flags & 0x01) !== 0;

  if (!hasWheelData || data.length < 7) {
    return { state: prev ?? { cumulativeRevolutions: 0, lastEventTime: 0 }, update: null };
  }

  const cumulativeRevolutions =
    data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
  const lastEventTime = data[5] | (data[6] << 8);

  const state: CscState = { cumulativeRevolutions, lastEventTime };

  if (!prev) {
    return { state, update: null };
  }

  let deltaRevs = cumulativeRevolutions - prev.cumulativeRevolutions;
  let deltaTime = lastEventTime - prev.lastEventTime;

  // Handle 16-bit timestamp rollover (~64 seconds)
  if (deltaTime < 0) {
    deltaTime += TIMESTAMP_ROLLOVER;
  }

  // Handle 32-bit revolution counter rollover (rare but possible)
  if (deltaRevs < 0) {
    deltaRevs += 0x100000000;
  }

  if (deltaTime === 0) {
    return { state, update: null };
  }

  const deltaTimeSeconds = deltaTime / TIMESTAMP_UNITS;
  const distanceMeters = (deltaRevs * wheelCircumferenceMm) / 1000;
  const speedMps = distanceMeters / deltaTimeSeconds;
  const speedMph = speedMps * 2.23694;

  return {
    state,
    update: { speedMph, deltaRevolutions: deltaRevs, deltaTimeSeconds },
  };
}
