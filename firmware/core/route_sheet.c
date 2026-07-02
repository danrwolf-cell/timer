#include "route_sheet.h"

#include <math.h>
#include <string.h>

#define FLAG_IS_RESET 0x01
#define FLAG_IS_FREE 0x02
#define FLAG_HAS_SPEED 0x04

uint16_t rs_crc16_update(uint16_t crc, const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

uint16_t rs_crc16(const uint8_t *data, size_t len) {
  return rs_crc16_update(0xFFFF, data, len);
}

static uint16_t read_u16(const uint8_t *p) {
  return (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
}

int rs_decode_route_sheet(const uint8_t *payload, size_t len, rs_route_t *out) {
  if (len < 4) return RS_ERR_SHORT;

  uint16_t crc_expected = read_u16(payload + len - 2);
  if (rs_crc16(payload, len - 2) != crc_expected) return RS_ERR_CRC;
  if (payload[0] != RS_PROTOCOL_VERSION) return RS_ERR_VERSION;

  uint8_t count = payload[1];
  if (count > RS_MAX_SEGMENTS) return RS_ERR_TOO_MANY;

  size_t offset = 2;
  size_t end = len - 2;

  for (uint8_t i = 0; i < count; i++) {
    if (offset + 6 > end) return RS_ERR_TRUNCATED;
    uint16_t distance_thou = read_u16(payload + offset);
    uint16_t speed_tenths = read_u16(payload + offset + 2);
    uint8_t flags = payload[offset + 4];
    uint8_t label_len = payload[offset + 5];
    offset += 6;
    if (offset + label_len > end) return RS_ERR_TRUNCATED;

    rs_segment_t *s = &out->segments[i];
    /* Same integer-divide-by-constant as the TS parser, so both engines
     * run on bit-identical doubles. */
    s->seg.distance = (double)distance_thou / 1000.0;
    s->seg.has_speed = (flags & FLAG_HAS_SPEED) != 0;
    s->seg.speed = s->seg.has_speed ? (double)speed_tenths / 10.0 : 0.0;
    s->seg.is_reset = (flags & FLAG_IS_RESET) != 0;
    s->seg.is_free = (flags & FLAG_IS_FREE) != 0;
    s->check_type = (uint8_t)((flags >> 4) & 0x0F);

    size_t copy = label_len <= RS_MAX_LABEL ? label_len : RS_MAX_LABEL;
    memcpy(s->label, payload + offset, copy);
    s->label[copy] = '\0';
    offset += label_len;
  }

  if (offset != end) return RS_ERR_TRAILING;
  out->count = count;
  return RS_OK;
}

/* ------------------------------------------------------------------ */

static void write_u16(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)(v >> 8);
}

static void write_u32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)((v >> 8) & 0xFF);
  p[2] = (uint8_t)((v >> 16) & 0xFF);
  p[3] = (uint8_t)((v >> 24) & 0xFF);
}

void rs_encode_status(uint8_t out[RS_STATUS_BYTES], const rs_status_t *status) {
  double dev = round(status->deviation_seconds);
  if (dev > 32767.0) dev = 32767.0;
  if (dev < -32768.0) dev = -32768.0;
  int16_t dev_i16 = (int16_t)dev;

  double dist = round(status->cumulative_distance_mi * 1000.0);
  if (dist < 0.0) dist = 0.0;
  if (dist > 4294967295.0) dist = 4294967295.0;

  out[0] = RS_PROTOCOL_VERSION;
  out[1] = status->sensor_status;
  out[2] = status->ride_state;
  out[3] = status->battery_pct;
  write_u16(out + 4, (uint16_t)dev_i16);
  write_u32(out + 6, (uint32_t)dist);
  out[10] = status->segment_index;
  out[11] = (uint8_t)((status->route_loaded ? 0x01 : 0) |
                      (status->in_free_section ? 0x02 : 0));
}

size_t rs_encode_ride_log_data(uint8_t *out, size_t cap, uint8_t seq,
                               const rs_log_row_t *rows, size_t n,
                               size_t *rows_encoded) {
  if (cap < 2 + RS_LOG_ROW_BYTES || n == 0) {
    if (rows_encoded) *rows_encoded = 0;
    return 0;
  }
  size_t fit = (cap - 2) / RS_LOG_ROW_BYTES;
  if (fit > n) fit = n;
  if (fit > 255) fit = 255;

  out[0] = seq;
  out[1] = (uint8_t)fit;
  for (size_t i = 0; i < fit; i++) {
    uint8_t *p = out + 2 + i * RS_LOG_ROW_BYTES;
    write_u32(p, rows[i].wall_clock_ms);
    write_u32(p + 4, rows[i].cumulative_revs);
    write_u16(p + 8, rows[i].wheel_event_time);
  }
  if (rows_encoded) *rows_encoded = fit;
  return 2 + fit * RS_LOG_ROW_BYTES;
}

void rs_encode_ride_log_end(uint8_t out[RS_LOG_END_BYTES], uint8_t seq,
                            uint16_t total_rows, uint16_t crc) {
  out[0] = seq;
  out[1] = 0x00;
  write_u16(out + 2, total_rows);
  write_u16(out + 4, crc);
}
