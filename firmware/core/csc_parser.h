/*
 * CSC GATT characteristic 0x2A5B parser — C port of src/ble/csc-parser.ts
 * (golden reference). Pure, no platform dependencies.
 *
 * Semantics note: the TS reference assembles the 32-bit cumulative
 * revolution counter with JavaScript bitwise OR, which yields a *signed*
 * 32-bit value. This port reproduces that exactly (sign-extended into
 * int64) so that both implementations make identical decisions in every
 * branch, including the rollover-vs-power-cycle distinction. State supplied
 * from outside (e.g. test vectors) may carry any int64 value, matching how
 * the TS tests hand-construct prev states with positive values >= 2^31.
 */
#ifndef ENDURO_CSC_PARSER_H
#define ENDURO_CSC_PARSER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CSC_DEFAULT_WHEEL_CIRCUMFERENCE_MM 2183.0

typedef struct {
  int64_t cumulative_revolutions;
  int32_t last_event_time; /* 1/1024 sec units, 16-bit */
} csc_state_t;

typedef struct {
  double speed_mph;
  int64_t delta_revolutions;
  double delta_time_seconds;
} csc_update_t;

/*
 * Parse one 0x2A5B notification.
 *
 *   prev       — previous state, or NULL for the first packet
 *   out_state  — always written (the re-baselined / advanced state)
 *   out_update — written only when the function returns true
 *
 * Returns true if a valid speed/distance update was produced; false for
 * the null-update cases (no wheel data, first packet, zero time delta,
 * power-cycle re-baseline, implausible-speed discard).
 */
bool csc_parse_notification(const uint8_t *data, size_t len,
                            const csc_state_t *prev,
                            double wheel_circumference_mm,
                            csc_state_t *out_state,
                            csc_update_t *out_update);

#ifdef __cplusplus
}
#endif

#endif /* ENDURO_CSC_PARSER_H */
