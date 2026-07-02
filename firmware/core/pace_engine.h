/*
 * Pace engine — C port of src/engine/pace-engine.ts (golden reference).
 *
 * Pure functions, no platform dependencies, no allocation. All distance
 * values are miles, speeds are mph, times are seconds, matching the TS
 * reference exactly. Validated against TS-generated vectors by
 * firmware/test (run `make -C firmware/test`).
 */
#ifndef ENDURO_PACE_ENGINE_H
#define ENDURO_PACE_ENGINE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Mirrors Segment in pace-engine.ts. `has_speed` false == speed: null
 * (free/transfer). checkType is ignored by the engine and not ported. */
typedef struct {
  double distance;   /* miles */
  double speed;      /* required avg mph; meaningful only if has_speed */
  bool has_speed;
  bool is_reset;
  bool is_free;
} pe_segment_t;

/* Mirrors RidePosition. */
typedef struct {
  int32_t segment_index;
  double distance_in_segment;  /* miles into current segment */
  double cumulative_distance;  /* total miles */
} pe_position_t;

pe_position_t pe_detect_segment(const pe_segment_t *segments, size_t count,
                                double cumulative_distance);

/* Key time in seconds for completed scored segments before segment_index. */
double pe_completed_key_time(const pe_segment_t *segments, size_t count,
                             int32_t segment_index);

/* Key time in seconds including partial contribution of current segment. */
double pe_compute_key_time(const pe_segment_t *segments, size_t count,
                           int32_t segment_index, double distance_in_segment);

/* Positive = late, negative = early (seconds). */
double pe_compute_deviation(double elapsed_seconds, double key_time_seconds);

bool pe_is_in_free_segment(const pe_segment_t *segments, size_t count,
                           int32_t segment_index);

/* True if any segment boundary crossed since the last update carried a
 * reset checkpoint. Walks prev+1 .. current inclusive; cannot miss a reset
 * bracketed between two notifications or skipped in one large update. */
bool pe_crossed_reset(const pe_segment_t *segments, size_t count,
                      int32_t prev_segment_index, int32_t current_segment_index);

#ifdef __cplusplus
}
#endif

#endif /* ENDURO_PACE_ENGINE_H */
