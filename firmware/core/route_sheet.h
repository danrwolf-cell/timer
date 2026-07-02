/*
 * Enduro Companion BLE protocol (v1) — device-side codec. C mirror of
 * src/ble/device-protocol.ts; see docs/BLE-PROTOCOL.md for the wire format.
 * Pure functions, no allocation, no platform dependencies. Validated against
 * vectors generated from the TS module (firmware/test).
 */
#ifndef ENDURO_ROUTE_SHEET_H
#define ENDURO_ROUTE_SHEET_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pace_engine.h"

#ifdef __cplusplus
extern "C" {
#endif

#define RS_PROTOCOL_VERSION 0x01
#define RS_MAX_SEGMENTS 64
#define RS_MAX_LABEL 23

/* check_type codes (flags bits 4-7) */
enum {
  RS_CHECK_NONE = 0,
  RS_CHECK_KNOWN = 1,
  RS_CHECK_SECRET = 2,
  RS_CHECK_EMERGENCY = 3,
  RS_CHECK_GAS = 4,
  RS_CHECK_START = 5,
  RS_CHECK_FINISH = 6,
};

/* Decode error codes */
enum {
  RS_OK = 0,
  RS_ERR_SHORT = -1,
  RS_ERR_CRC = -2,
  RS_ERR_VERSION = -3,
  RS_ERR_TRUNCATED = -4,
  RS_ERR_TRAILING = -5,
  RS_ERR_TOO_MANY = -6,
};

typedef struct {
  pe_segment_t seg;               /* feeds the pace engine directly */
  uint8_t check_type;             /* RS_CHECK_* */
  char label[RS_MAX_LABEL + 1];   /* NUL-terminated, may be empty */
} rs_segment_t;

typedef struct {
  uint8_t count;
  rs_segment_t segments[RS_MAX_SEGMENTS];
} rs_route_t;

/* CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF. Matches crc16() in TS. */
uint16_t rs_crc16(const uint8_t *data, size_t len);
uint16_t rs_crc16_update(uint16_t crc, const uint8_t *data, size_t len);

/* Decode a complete ROUTE_SHEET payload (after transfer reassembly).
 * Returns RS_OK or an RS_ERR_* code. */
int rs_decode_route_sheet(const uint8_t *payload, size_t len, rs_route_t *out);

/* ------------------------------------------------------------------ */
/* DEVICE_STATUS encoder (12 bytes) */

enum { RS_SENSOR_DISCONNECTED = 0, RS_SENSOR_CONNECTING = 1,
       RS_SENSOR_CONNECTED = 2, RS_SENSOR_LOST = 3 };
enum { RS_RIDE_IDLE = 0, RS_RIDE_RIDING = 1, RS_RIDE_LOG_READY = 2 };

#define RS_STATUS_BYTES 12
#define RS_BATTERY_UNKNOWN 0xFF

typedef struct {
  uint8_t sensor_status;      /* RS_SENSOR_* */
  uint8_t ride_state;         /* RS_RIDE_* */
  uint8_t battery_pct;        /* 0-100, RS_BATTERY_UNKNOWN */
  double deviation_seconds;   /* rounded + clamped to i16 on the wire */
  double cumulative_distance_mi;
  uint8_t segment_index;
  bool route_loaded;
  bool in_free_section;
} rs_status_t;

void rs_encode_status(uint8_t out[RS_STATUS_BYTES], const rs_status_t *status);

/* ------------------------------------------------------------------ */
/* RIDE_LOG stream encoder */

typedef struct {
  uint32_t wall_clock_ms;   /* ms since ride start (device clock) */
  uint32_t cumulative_revs;
  uint16_t wheel_event_time;
} rs_log_row_t;

#define RS_LOG_ROW_BYTES 10
#define RS_LOG_END_BYTES 6

/* Encode a DATA packet. Returns bytes written, or 0 if cap is too small
 * for even one row. Encodes as many of the n rows as fit. */
size_t rs_encode_ride_log_data(uint8_t *out, size_t cap, uint8_t seq,
                               const rs_log_row_t *rows, size_t n,
                               size_t *rows_encoded);

/* Encode the END packet. crc covers all row bytes in stream order
 * (accumulate with rs_crc16_update as DATA packets are encoded). */
void rs_encode_ride_log_end(uint8_t out[RS_LOG_END_BYTES], uint8_t seq,
                            uint16_t total_rows, uint16_t crc);

#ifdef __cplusplus
}
#endif

#endif /* ENDURO_ROUTE_SHEET_H */
