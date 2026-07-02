#include "pace_engine.h"

pe_position_t pe_detect_segment(const pe_segment_t *segments, size_t count,
                                double cumulative_distance) {
  double remaining = cumulative_distance;
  for (size_t i = 0; i < count; i++) {
    if (remaining <= segments[i].distance || i == count - 1) {
      pe_position_t pos = {
        .segment_index = (int32_t)i,
        .distance_in_segment = remaining,
        .cumulative_distance = cumulative_distance,
      };
      return pos;
    }
    remaining -= segments[i].distance;
  }
  pe_position_t pos = {0, 0.0, cumulative_distance};
  return pos;
}

double pe_completed_key_time(const pe_segment_t *segments, size_t count,
                             int32_t segment_index) {
  double key_time = 0.0;
  for (int32_t i = 0; i < segment_index && (size_t)i < count; i++) {
    const pe_segment_t *seg = &segments[i];
    if (!seg->is_free && seg->has_speed) {
      key_time += (seg->distance / seg->speed) * 3600.0;
    }
  }
  return key_time;
}

double pe_compute_key_time(const pe_segment_t *segments, size_t count,
                           int32_t segment_index, double distance_in_segment) {
  double completed = pe_completed_key_time(segments, count, segment_index);
  const pe_segment_t *current = &segments[segment_index];
  if (current->is_free || !current->has_speed) {
    return completed;
  }
  return completed + (distance_in_segment / current->speed) * 3600.0;
}

double pe_compute_deviation(double elapsed_seconds, double key_time_seconds) {
  return elapsed_seconds - key_time_seconds;
}

bool pe_is_in_free_segment(const pe_segment_t *segments, size_t count,
                           int32_t segment_index) {
  if (segment_index < 0 || (size_t)segment_index >= count) return false;
  return segments[segment_index].is_free || !segments[segment_index].has_speed;
}

bool pe_crossed_reset(const pe_segment_t *segments, size_t count,
                      int32_t prev_segment_index, int32_t current_segment_index) {
  if (current_segment_index <= prev_segment_index) return false;
  for (int32_t i = prev_segment_index + 1; i <= current_segment_index; i++) {
    if (i >= 0 && (size_t)i < count && segments[i].is_reset) return true;
  }
  return false;
}
