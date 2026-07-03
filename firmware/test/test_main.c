/*
 * Host-side test runner: validates the C port of the pace engine and CSC
 * parser against golden vectors generated from the TypeScript reference.
 *
 * Build and run: `make -C firmware/test`
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "csc_parser.h"
#include "pace_engine.h"
#include "route_sheet.h"
#include "vectors.h"

static int failures = 0;
static int checks = 0;

static void fail(const char *group, size_t idx, const char *what,
                 double expected, double actual) {
  failures++;
  fprintf(stderr, "FAIL %s[%zu] %s: expected %.17g, got %.17g\n", group, idx,
          what, expected, actual);
}

static void check_close(const char *group, size_t idx, const char *what,
                        double expected, double actual) {
  checks++;
  double tol = 1e-9 * fmax(1.0, fabs(expected));
  if (fabs(expected - actual) > tol) fail(group, idx, what, expected, actual);
}

static void check_i64(const char *group, size_t idx, const char *what,
                      int64_t expected, int64_t actual) {
  checks++;
  if (expected != actual) fail(group, idx, what, (double)expected, (double)actual);
}

static void check_bool(const char *group, size_t idx, const char *what,
                       bool expected, bool actual) {
  checks++;
  if (expected != actual) fail(group, idx, what, expected, actual);
}

/* ------------------------------------------------------------------ */

static void run_csc_vectors(const char *group, const csc_vector_t *vectors,
                            size_t count) {
  for (size_t i = 0; i < count; i++) {
    const csc_vector_t *v = &vectors[i];
    csc_state_t prev = {v->prev_revs, v->prev_time};
    csc_state_t state;
    csc_update_t update;
    bool has_update = csc_parse_notification(
        v->bytes, (size_t)v->len, v->has_prev ? &prev : NULL,
        CSC_DEFAULT_WHEEL_CIRCUMFERENCE_MM, &state, &update);

    check_i64(group, i, "state.revs", v->exp_revs, state.cumulative_revolutions);
    check_i64(group, i, "state.time", v->exp_time, state.last_event_time);
    check_bool(group, i, "has_update", v->has_update, has_update);
    if (v->has_update && has_update) {
      check_close(group, i, "speed_mph", v->exp_speed_mph, update.speed_mph);
      check_i64(group, i, "delta_revs", v->exp_delta_revs, update.delta_revolutions);
      check_close(group, i, "delta_time_s", v->exp_delta_time_s, update.delta_time_seconds);
    }
  }
}

/* ------------------------------------------------------------------ */

#define MAX_SEGMENTS 16

static size_t load_segments(pe_segment_t *out, const void *vec_ptr, size_t count) {
  /* pace_segment_vectors and replay_segment_vectors share this layout */
  const struct {
    double distance;
    double speed;
    bool has_speed;
    bool is_reset;
    bool is_free;
  } *rows = vec_ptr;
  for (size_t i = 0; i < count && i < MAX_SEGMENTS; i++) {
    out[i].distance = rows[i].distance;
    out[i].speed = rows[i].speed;
    out[i].has_speed = rows[i].has_speed;
    out[i].is_reset = rows[i].is_reset;
    out[i].is_free = rows[i].is_free;
  }
  return count;
}

static void run_pace_vectors(void) {
  pe_segment_t segments[MAX_SEGMENTS];
  size_t count = load_segments(segments, pace_segment_vectors, pace_segment_count);

  for (size_t i = 0; i < pace_vector_count; i++) {
    const pace_vector_t *v = &pace_vectors[i];
    pe_position_t pos = pe_detect_segment(segments, count, v->cumulative_distance);
    check_i64("pace", i, "segment_index", v->exp_segment_index, pos.segment_index);
    check_close("pace", i, "distance_in_segment", v->exp_distance_in_segment,
                pos.distance_in_segment);
    double key_time =
        pe_compute_key_time(segments, count, pos.segment_index, pos.distance_in_segment);
    check_close("pace", i, "key_time", v->exp_key_time, key_time);
    check_bool("pace", i, "in_free", v->exp_in_free,
               pe_is_in_free_segment(segments, count, pos.segment_index));
  }

  for (size_t i = 0; i < crossed_reset_count; i++) {
    const crossed_reset_vector_t *v = &crossed_reset_vectors[i];
    check_bool("crossed_reset", i, "result", v->expected,
               pe_crossed_reset(segments, count, v->prev_index, v->current_index));
  }
}

/* ------------------------------------------------------------------ */

/*
 * C mirror of replay.ts replayRide(): reconstruct the 7-byte packet from
 * decoded fields, run the parser, accumulate distance, compute deviation.
 * This is also the reference structure for the firmware's live loop.
 */
static void run_replay(const char *group, const replay_row_t *rows,
                       size_t row_count, const replay_point_t *expected,
                       size_t expected_count) {
  pe_segment_t segments[MAX_SEGMENTS];
  size_t seg_count =
      load_segments(segments, replay_segment_vectors, replay_segment_count);

  csc_state_t state;
  bool has_state = false;
  double cumulative_distance_mi = 0.0;
  size_t point_idx = 0;

  for (size_t i = 0; i < row_count; i++) {
    uint32_t revs = (uint32_t)rows[i].cumulative_revs;
    uint32_t wet = (uint32_t)rows[i].wheel_event_time;
    uint8_t packet[7] = {
        0x01,
        (uint8_t)(revs & 0xff),
        (uint8_t)((revs >> 8) & 0xff),
        (uint8_t)((revs >> 16) & 0xff),
        (uint8_t)((revs >> 24) & 0xff),
        (uint8_t)(wet & 0xff),
        (uint8_t)((wet >> 8) & 0xff),
    };

    csc_state_t next;
    csc_update_t update;
    bool has_update = csc_parse_notification(packet, sizeof(packet),
                                             has_state ? &state : NULL,
                                             replay_wheel_mm, &next, &update);
    state = next;
    has_state = true;

    if (!has_update) continue;

    cumulative_distance_mi +=
        ((double)update.delta_revolutions * replay_wheel_mm) / 1000.0 / 1609.34;

    double elapsed_seconds =
        (double)(rows[i].wall_clock_ms - replay_ride_start_ms) / 1000.0;
    pe_position_t pos = pe_detect_segment(segments, seg_count, cumulative_distance_mi);
    double key_time = pe_compute_key_time(segments, seg_count, pos.segment_index,
                                          pos.distance_in_segment);
    double deviation = pe_compute_deviation(elapsed_seconds, key_time);

    if (point_idx >= expected_count) {
      failures++;
      checks++;
      fprintf(stderr, "FAIL %s: produced more points than expected (%zu)\n",
              group, expected_count);
      return;
    }
    const replay_point_t *exp = &expected[point_idx];
    check_i64(group, point_idx, "wall_clock_ms", exp->wall_clock_ms,
              rows[i].wall_clock_ms);
    check_close(group, point_idx, "cumulative_distance_mi",
                exp->cumulative_distance_mi, cumulative_distance_mi);
    check_close(group, point_idx, "deviation_seconds", exp->deviation_seconds,
                deviation);
    check_close(group, point_idx, "speed_mph", exp->speed_mph, update.speed_mph);
    point_idx++;
  }

  checks++;
  if (point_idx != expected_count) {
    failures++;
    fprintf(stderr, "FAIL %s: produced %zu points, expected %zu\n", group,
            point_idx, expected_count);
  }
}

/* ------------------------------------------------------------------ */

static void run_protocol_vectors(void) {
  /* CRC self-check against the published CCITT-FALSE check value */
  check_i64("crc16", 0, "check_value", crc16_check_value,
            rs_crc16((const uint8_t *)"123456789", 9));

  /* Route sheet: TS-packed payload must decode to the expected segments */
  rs_route_t route;
  int rc = rs_decode_route_sheet(route_sheet_payload, route_sheet_payload_len, &route);
  check_i64("route_sheet", 0, "decode_rc", RS_OK, rc);
  check_i64("route_sheet", 0, "count", (int64_t)route_sheet_expected_count, route.count);
  for (size_t i = 0; i < route_sheet_expected_count && i < route.count; i++) {
    const route_sheet_expected_t *e = &route_sheet_expected[i];
    const rs_segment_t *s = &route.segments[i];
    check_close("route_sheet", i, "distance", e->distance, s->seg.distance);
    check_close("route_sheet", i, "speed", e->speed, s->seg.speed);
    check_bool("route_sheet", i, "has_speed", e->has_speed, s->seg.has_speed);
    check_bool("route_sheet", i, "is_reset", e->is_reset, s->seg.is_reset);
    check_bool("route_sheet", i, "is_free", e->is_free, s->seg.is_free);
    check_i64("route_sheet", i, "check_type", e->check_type, s->check_type);
    checks++;
    if (strcmp(e->label, s->label) != 0) {
      failures++;
      fprintf(stderr, "FAIL route_sheet[%zu] label: expected \"%s\", got \"%s\"\n",
              i, e->label, s->label);
    }
  }

  /* Corrupted payload must be rejected */
  uint8_t corrupted[sizeof(route_sheet_payload)];
  memcpy(corrupted, route_sheet_payload, sizeof(corrupted));
  corrupted[3] ^= 0xFF;
  check_i64("route_sheet", 0, "corrupt_rc", RS_ERR_CRC,
            rs_decode_route_sheet(corrupted, sizeof(corrupted), &route));

  /* Wrong version (CRC fixed up) must be rejected */
  memcpy(corrupted, route_sheet_payload, sizeof(corrupted));
  corrupted[0] = 0x7F;
  uint16_t crc = rs_crc16(corrupted, sizeof(corrupted) - 2);
  corrupted[sizeof(corrupted) - 2] = (uint8_t)(crc & 0xFF);
  corrupted[sizeof(corrupted) - 1] = (uint8_t)(crc >> 8);
  check_i64("route_sheet", 0, "version_rc", RS_ERR_VERSION,
            rs_decode_route_sheet(corrupted, sizeof(corrupted), &route));

  /* DEVICE_STATUS: C encoder must reproduce the reference bytes exactly */
  for (size_t i = 0; i < status_vector_count; i++) {
    const status_vector_t *v = &status_vectors[i];
    rs_status_t st = {
      .sensor_status = v->sensor_status,
      .ride_state = v->ride_state,
      .battery_pct = v->battery_pct,
      .deviation_seconds = v->deviation_seconds,
      .cumulative_distance_mi = v->cumulative_distance_mi,
      .segment_index = v->segment_index,
      .route_loaded = v->route_loaded,
      .in_free_section = v->in_free_section,
    };
    uint8_t out[RS_STATUS_BYTES];
    rs_encode_status(out, &st);
    checks++;
    if (memcmp(out, v->expected, RS_STATUS_BYTES) != 0) {
      failures++;
      fprintf(stderr, "FAIL status[%zu]: encoded bytes differ from reference\n", i);
    }
  }

  /* RIDE_LOG: C encoder must reproduce the reference DATA and END packets */
  rs_log_row_t rows[8];
  for (size_t i = 0; i < ride_log_row_count && i < 8; i++) {
    rows[i].wall_clock_ms = (uint32_t)ride_log_rows[i].wall_clock_ms;
    rows[i].cumulative_revs = (uint32_t)ride_log_rows[i].cumulative_revs;
    rows[i].wheel_event_time = (uint16_t)ride_log_rows[i].wheel_event_time;
  }
  uint8_t data_out[64];
  size_t rows_encoded = 0;
  size_t data_len = rs_encode_ride_log_data(data_out, sizeof(data_out), 7, rows,
                                            ride_log_row_count, &rows_encoded);
  check_i64("ride_log", 0, "rows_encoded", (int64_t)ride_log_row_count,
            (int64_t)rows_encoded);
  check_i64("ride_log", 0, "data_len", (int64_t)sizeof(ride_log_expected_data),
            (int64_t)data_len);
  checks++;
  if (data_len == sizeof(ride_log_expected_data) &&
      memcmp(data_out, ride_log_expected_data, data_len) != 0) {
    failures++;
    fprintf(stderr, "FAIL ride_log DATA: encoded bytes differ from reference\n");
  }

  /* Stream CRC accumulated over row bytes must match the TS rideLogCrc */
  uint16_t stream_crc = rs_crc16(data_out + 2, data_len - 2);
  check_i64("ride_log", 0, "stream_crc", ride_log_expected_crc, stream_crc);

  uint8_t end_out[RS_LOG_END_BYTES];
  rs_encode_ride_log_end(end_out, 9, (uint16_t)ride_log_row_count, stream_crc);
  checks++;
  if (memcmp(end_out, ride_log_expected_end, RS_LOG_END_BYTES) != 0) {
    failures++;
    fprintf(stderr, "FAIL ride_log END: encoded bytes differ from reference\n");
  }

  /* Capacity-limited encode: only as many rows as fit */
  size_t small_len = rs_encode_ride_log_data(data_out, 2 + RS_LOG_ROW_BYTES + 5, 0,
                                             rows, ride_log_row_count, &rows_encoded);
  check_i64("ride_log", 1, "small_rows", 1, (int64_t)rows_encoded);
  check_i64("ride_log", 1, "small_len", 2 + RS_LOG_ROW_BYTES, (int64_t)small_len);
}

int main(void) {
  run_csc_vectors("csc_sequence", csc_sequence_vectors, csc_sequence_count);
  run_csc_vectors("csc_direct", csc_direct_vectors, csc_direct_count);
  run_pace_vectors();
  run_replay("replay_snapshot", replay_snapshot_rows, replay_snapshot_row_count,
             replay_snapshot_points, replay_snapshot_point_count);
  run_replay("replay_power_cycle", replay_power_cycle_rows,
             replay_power_cycle_row_count, replay_power_cycle_points,
             replay_power_cycle_point_count);
  run_protocol_vectors();

  if (failures) {
    fprintf(stderr, "\n%d/%d checks FAILED\n", failures, checks);
    return 1;
  }
  printf("all %d checks passed\n", checks);
  return 0;
}
