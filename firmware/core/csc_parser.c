#include "csc_parser.h"

#define TIMESTAMP_ROLLOVER 65536 /* 16-bit */
#define TIMESTAMP_UNITS 1024.0   /* ticks per second */

/* See csc-parser.ts: genuine 32-bit rollover only if the *previous* counter
 * was near the 32-bit max; any other negative delta is a power-cycle. */
#define ROLLOVER_PREV_THRESHOLD 0xFF000000LL

#define MAX_PLAUSIBLE_SPEED_MPH 150.0

bool csc_parse_notification(const uint8_t *data, size_t len,
                            const csc_state_t *prev,
                            double wheel_circumference_mm,
                            csc_state_t *out_state,
                            csc_update_t *out_update) {
  uint8_t flags = len > 0 ? data[0] : 0;
  bool has_wheel_data = (flags & 0x01) != 0;

  if (!has_wheel_data || len < 7) {
    if (prev) {
      *out_state = *prev;
    } else {
      out_state->cumulative_revolutions = 0;
      out_state->last_event_time = 0;
    }
    return false;
  }

  /* JS `a | (b<<8) | (c<<16) | (d<<24)` produces a signed 32-bit result;
   * sign-extend to int64 to match. */
  int64_t cumulative_revolutions =
      (int64_t)(int32_t)((uint32_t)data[1] | ((uint32_t)data[2] << 8) |
                         ((uint32_t)data[3] << 16) | ((uint32_t)data[4] << 24));
  int32_t last_event_time = (int32_t)(data[5] | ((uint32_t)data[6] << 8));

  out_state->cumulative_revolutions = cumulative_revolutions;
  out_state->last_event_time = last_event_time;

  if (!prev) {
    return false;
  }

  int64_t delta_revs = cumulative_revolutions - prev->cumulative_revolutions;
  int32_t delta_time = last_event_time - prev->last_event_time;

  /* Handle 16-bit timestamp rollover (~64 seconds) */
  if (delta_time < 0) {
    delta_time += TIMESTAMP_ROLLOVER;
  }

  if (delta_time == 0) {
    return false;
  }

  if (delta_revs < 0) {
    if (prev->cumulative_revolutions >= ROLLOVER_PREV_THRESHOLD) {
      /* Genuine 32-bit rollover */
      delta_revs += 0x100000000LL;
    } else {
      /* Power-cycle: re-baseline to new counter, emit no update */
      return false;
    }
  }

  double delta_time_seconds = (double)delta_time / TIMESTAMP_UNITS;
  double distance_meters = ((double)delta_revs * wheel_circumference_mm) / 1000.0;
  double speed_mps = distance_meters / delta_time_seconds;
  double speed_mph = speed_mps * 2.23694;

  /* Final backstop: if implied speed is still implausible, discard and
   * re-baseline. */
  if (speed_mph > MAX_PLAUSIBLE_SPEED_MPH) {
    return false;
  }

  out_update->speed_mph = speed_mph;
  out_update->delta_revolutions = delta_revs;
  out_update->delta_time_seconds = delta_time_seconds;
  return true;
}
