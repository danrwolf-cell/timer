/**
 * Clock helpers for event key times and countdowns.
 *
 * Pure and platform-free, but NOT part of the golden-reference set — the
 * device never sees these. It receives an absolute epoch (CONTROL 0x07) and
 * does its own countdown; this is the phone-side entry and display path.
 */

export interface TimeOfDay {
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * Parse an event key time as `HH:MM` or `HH:MM:SS` (24-hour).
 *
 * Seconds matter: officials call key time to the second, and a whole minute
 * of error is a whole minute of deviation for the entire ride.
 */
export function parseTimeOfDay(text: string): TimeOfDay | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const seconds = m[3] === undefined ? 0 : parseInt(m[3], 10);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return { hours, minutes, seconds };
}

/**
 * Resolve a time-of-day against a reference date, yielding epoch ms.
 * Always the same calendar day as `reference` — no rolling to tomorrow, so
 * what the rider entered is unambiguously what they get.
 */
export function resolveTimeOfDay(t: TimeOfDay, reference: Date = new Date()): number {
  const d = new Date(reference.getTime());
  d.setHours(t.hours, t.minutes, t.seconds, 0);
  return d.getTime();
}

export function formatTimeOfDay(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Countdown as `H:MM:SS` past an hour, `M:SS` below it. Negative clamps to
 * zero. Arming hours ahead of a start is normal, so the hour field is not an
 * edge case.
 */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

// ---------------------------------------------------------------------------
// Event clock offset
//
// The timekeeper's clock is authoritative and rarely matches the phone's. All
// key times are quoted in EVENT time, so the phone holds a signed offset and
// converts. Positive offset = the event clock reads ahead of the phone.
//
//   eventClock = phoneClock + offset
//
// Measured by the rider naming a time they are about to see and tapping at the
// instant the official clock reaches it.

/**
 * Offset implied by seeing the event clock read `eventReadingEpochMs` at the
 * instant the phone read `phoneEpochMs`.
 */
export function clockOffsetMs(eventReadingEpochMs: number, phoneEpochMs: number): number {
  return eventReadingEpochMs - phoneEpochMs;
}

/** What the event clock reads when the phone reads `phoneEpochMs`. */
export function eventNowMs(phoneEpochMs: number, offsetMs: number): number {
  return phoneEpochMs + offsetMs;
}

/**
 * Convert an instant expressed on the event clock into the phone-clock instant
 * at which it occurs — the form the device needs, since the device is synced to
 * the phone's clock, not the timekeeper's.
 */
export function eventTimeToPhoneEpochMs(eventEpochMs: number, offsetMs: number): number {
  return eventEpochMs - offsetMs;
}

/** Signed offset for display, e.g. "-32s" or "+1m 04s". */
export function formatOffset(offsetMs: number): string {
  const totalSeconds = Math.round(offsetMs / 1000);
  const sign = totalSeconds < 0 ? '-' : '+';
  const abs = Math.abs(totalSeconds);
  if (abs < 60) return `${sign}${abs}s`;
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${m}m ${String(s).padStart(2, '0')}s`;
}
