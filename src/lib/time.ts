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
