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

// Hub sensors reset their cumulative counter to 0 on power-cycle. We distinguish
// this from a genuine 32-bit counter rollover by where the *previous* counter was:
//   - Genuine rollover: prev counter was near 0xFFFFFFFF (close to the 32-bit max),
//     new counter wrapped to a small value. Apply +0x100000000 correction.
//   - Power-cycle: prev counter was some arbitrary value (not near max), new counter
//     reset to near zero. Re-baseline; do not apply rollover correction.
// At 30 mph (~6 rev/s), reaching within 0xFF000000 of the max would take
// ~2.7 million seconds (~31 days) of continuous riding, so this is a safe boundary.
const ROLLOVER_PREV_THRESHOLD = 0xFF000000;

// Hard ceiling on plausible speed. Enduro sections top out well below this.
// Acts as a final backstop against any delta that slipped through the above.
const MAX_PLAUSIBLE_SPEED_MPH = 150;

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

  if (deltaTime === 0) {
    return { state, update: null };
  }

  if (deltaRevs < 0) {
    // A negative delta means either:
    //   (a) Genuine 32-bit rollover: counter wrapped past 0xFFFFFFFF. Only possible
    //       if the previous value was near the 32-bit max (>= ROLLOVER_PREV_THRESHOLD).
    //   (b) Sensor power-cycle: counter reset to 0 (or near-zero). The previous value
    //       can be anything — the sensor simply restarted.
    //
    // Distinguish by where the *previous* counter was, not where the new one lands.
    // This check must precede the rollover correction — applying +0x100000000 to a
    // power-cycle delta would corrupt it to ~4B before the speed clamp can catch it.
    if (prev.cumulativeRevolutions >= ROLLOVER_PREV_THRESHOLD) {
      // Genuine 32-bit rollover
      deltaRevs += 0x100000000;
    } else {
      // Power-cycle: re-baseline to new counter, emit no update
      return { state, update: null };
    }
  }

  const deltaTimeSeconds = deltaTime / TIMESTAMP_UNITS;
  const distanceMeters = (deltaRevs * wheelCircumferenceMm) / 1000;
  const speedMps = distanceMeters / deltaTimeSeconds;
  const speedMph = speedMps * 2.23694;

  // Final backstop: if implied speed is still implausible, discard and re-baseline.
  if (speedMph > MAX_PLAUSIBLE_SPEED_MPH) {
    return { state, update: null };
  }

  return {
    state,
    update: { speedMph, deltaRevolutions: deltaRevs, deltaTimeSeconds },
  };
}
