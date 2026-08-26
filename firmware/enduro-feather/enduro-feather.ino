/*
 * Enduro Companion handlebar unit — Adafruit Feather nRF52840 Express
 * + Adafruit 4694 Sharp Memory LCD breakout (400x240, LS027B7DH01).
 *
 * Dual-role BLE:
 *   - Central to the CSC speed sensor (service 0x1816, characteristic 0x2A5B)
 *   - Peripheral to the phone (custom Enduro service, docs/BLE-PROTOCOL.md)
 *
 * All pace math and packet decoding lives in firmware/core (EnduroCore
 * library) — pure C validated against the TypeScript golden reference.
 * This sketch is only plumbing: BLE callbacks, flash persistence, display.
 *
 * Build: see firmware/enduro-feather/README.md (arduino-cli instructions).
 *
 * Known parity notes (deliberate, matches the phone implementation):
 *   - A reset checkpoint zeroes the *displayed* deviation for the update
 *     that crossed it; deviation is recomputed from full key time on the
 *     next update. Re-anchoring semantics are a Phase 2 decision that must
 *     land on both platforms at once.
 *   - The ride log is kept in RAM (2 h at 1 Hz). It survives END_RIDE but
 *     not a power cycle; pull it before powering off. QSPI flash persistence
 *     is the upgrade path once the prototype is proven.
 */

#include <bluefruit.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SharpMem.h>
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>

extern "C" {
#include "pace_engine.h"
#include "csc_parser.h"
#include "route_sheet.h"
}

using namespace Adafruit_LittleFS_Namespace;

// ---------------------------------------------------------------------------
// Display — Adafruit 4694 breakout on hardware SPI. See docs/HARDWARE.md.

#define SHARP_CS_PIN 5
#define DISPLAY_W 400
#define DISPLAY_H 240

// Adafruit_SharpMem doesn't define these — the library's own examples expect
// the sketch to. Monochrome panel: 0 = black pixel, 1 = white.
#define BLACK 0
#define WHITE 1

Adafruit_SharpMem display(&SPI, SHARP_CS_PIN, DISPLAY_W, DISPLAY_H);

// ---------------------------------------------------------------------------
// Hardwired buttons — momentary, active-low via internal pull-up. No BLE
// remote (HID/AVRCP shutter-style devices don't speak a documented GATT
// service and add a pairing step to a device that should just work at the
// trailhead). Wiring: docs/HARDWARE.md.
//
// RESET zeroes displayed deviation — parity with the phone's MANUAL_RESET.
//
// UP/DOWN nudge cumulative distance against a known course mile marker.
// A wheel-revolution odometer drifts from the course's measured distance
// over a section — tire wear, wheel spin in mud/sand, course-measurement
// error — and that drift is real-world physical reality, not a bug to fix
// in software. Every enduro trip computer (ICO CheckMate's Autocal is the
// reference) gives the rider a live, two-directional correction against
// painted mile markers. Without it the unit is unusable on an actual
// course: distance-driven key time and deviation would silently drift off
// from what the route sheet expects. Tap = fine step; hold = repeat, for
// correcting larger drift without a hundred taps.

#define RESET_BUTTON_PIN 6
#define UP_BUTTON_PIN 9
#define DOWN_BUTTON_PIN 10
#define BUTTON_DEBOUNCE_MS 50
#define ADJUST_STEP_MI 0.01
#define ADJUST_HOLD_DELAY_MS 600
#define ADJUST_REPEAT_MS 150

// Defined here, not below with pollButton(): the Arduino preprocessor
// auto-generates prototypes for every function and injects them near the top
// of the file, so any type used in a signature must be declared up here or
// the generated prototype won't compile.
struct DebouncedButton {
  uint8_t pin;
  bool lastReading = HIGH;
  bool debouncedState = HIGH;
  uint32_t lastChangeMs = 0;
  uint32_t pressStartMs = 0;
  uint32_t lastRepeatMs = 0;

  explicit DebouncedButton(uint8_t p) : pin(p) {}
};

static DebouncedButton resetButton(RESET_BUTTON_PIN);
static DebouncedButton upButton(UP_BUTTON_PIN);
static DebouncedButton downButton(DOWN_BUTTON_PIN);

// ---------------------------------------------------------------------------
// Enduro GATT service (UUIDs from docs/BLE-PROTOCOL.md, little-endian bytes)

#define ENDURO_UUID(shortId) \
  { 0x3A, 0x6D, 0x4C, 0x1B, 0x8F, 0x2E, 0x4E, 0x8E, \
    0x84, 0x4B, 0xE4, 0xF2, (shortId), 0x00, 0x4B, 0x9E }

const uint8_t UUID_ENDURO_SVC[16] = ENDURO_UUID(0x01);
const uint8_t UUID_ROUTE_SHEET[16] = ENDURO_UUID(0x02);
const uint8_t UUID_CONTROL[16] = ENDURO_UUID(0x03);
const uint8_t UUID_DEVICE_STATUS[16] = ENDURO_UUID(0x04);
const uint8_t UUID_RIDE_LOG[16] = ENDURO_UUID(0x05);

BLEService enduroService(UUID_ENDURO_SVC);
BLECharacteristic routeSheetChar(UUID_ROUTE_SHEET);
BLECharacteristic controlChar(UUID_CONTROL);
BLECharacteristic statusChar(UUID_DEVICE_STATUS);
BLECharacteristic rideLogChar(UUID_RIDE_LOG);

// CSC sensor (central role)
BLEClientService cscService(UUID16_SVC_CYCLING_SPEED_AND_CADENCE);
BLEClientCharacteristic cscMeasurement(UUID16_CHR_CSC_MEASUREMENT);

// ---------------------------------------------------------------------------
// State

// Route
static rs_route_t route;
static pe_segment_t segments[RS_MAX_SEGMENTS];  // contiguous view for the engine
static bool routeLoaded = false;

// CSC / ride
static csc_state_t cscState;
static bool cscHasState = false;
static double cumulativeMi = 0.0;
static double currentSpeedMph = 0.0;
static int32_t segmentIndex = 0;
static uint8_t rideState = RS_RIDE_IDLE;
static uint32_t rideStartMs = 0;
static uint32_t rideEpochS = 0;  // phone-provided wall clock at START_RIDE
static double wheelCircumferenceMm = CSC_DEFAULT_WHEEL_CIRCUMFERENCE_MM;
static volatile uint8_t sensorStatus = RS_SENSOR_DISCONNECTED;
static uint32_t resetFlashUntilMs = 0;

// Row start / countdown. The device has no RTC: SET_START_TIME hands it the
// phone's wall clock, which anchors millis() to epoch for as long as it stays
// powered. rideStartMs is the millis() value at which the ride clock starts —
// it sits in the future while counting down.
static uint32_t epochAtSyncS = 0;
static uint32_t millisAtSync = 0;
static bool clockSynced = false;
static uint32_t riderStartEpochS = 0;
static uint8_t riderRow = 0;

// Window after the scheduled start in which RESET still means "the official
// just said go" (re-anchor the start) rather than "I hit a check" (flash only).
#define RESET_START_WINDOW_MS 60000

// Ride log: RAM buffer, ~2 h at 1 Hz. 10 bytes/row on the wire, 12 in RAM.
#define RIDE_LOG_CAPACITY 7200
static rs_log_row_t rideLog[RIDE_LOG_CAPACITY];
static volatile uint32_t rideLogCount = 0;
static volatile bool rideLogOverflowed = false;

// Route sheet transfer reassembly
#define XFER_BEGIN 0x01
#define XFER_DATA 0x02
#define XFER_END 0x03
#define XFER_MAX 2048
static uint8_t xferBuf[XFER_MAX];
static uint16_t xferExpected = 0;
static bool xferActive = false;

// Deferred work flags (BLE callbacks run on the SoftDevice task — keep them
// short, do the slow work in loop())
static volatile bool logStreamRequested = false;
static volatile bool routePersistPending = false;
static uint16_t routePersistLen = 0;

// Phone (peripheral-role) connection — tracked explicitly because the
// central link to the speed sensor makes Bluefruit.connHandle() ambiguous.
static volatile uint16_t phoneConnHandle = BLE_CONN_HANDLE_INVALID;

#define ROUTE_FILE "/route.bin"

static uint8_t readBatteryPct();
static double currentDeviationSeconds();

// ---------------------------------------------------------------------------
// Route handling

static void adoptRoute(const rs_route_t *decoded) {
  route = *decoded;
  for (uint8_t i = 0; i < route.count; i++) {
    segments[i] = route.segments[i].seg;
  }
  routeLoaded = route.count > 0;
  segmentIndex = 0;
}

static void persistRoute(const uint8_t *payload, uint16_t len) {
  InternalFS.remove(ROUTE_FILE);
  File f(InternalFS);
  if (f.open(ROUTE_FILE, FILE_O_WRITE)) {
    f.write(payload, len);
    f.close();
  }
}

static void loadPersistedRoute() {
  File f(InternalFS);
  if (!f.open(ROUTE_FILE, FILE_O_READ)) return;
  uint32_t len = f.size();
  if (len > 0 && len <= XFER_MAX) {
    static uint8_t buf[XFER_MAX];
    f.read(buf, len);
    // static, not a local: rs_route_t is ~3.6 KB (64 segments) and the
    // Arduino loop task only gets a 4 KB stack (LOOP_STACK_SZ in the nRF52
    // core), so a local here overflows the stack and hard-faults. Safe as a
    // static because this runs once, from setup(), before BLE starts.
    static rs_route_t decoded;
    if (rs_decode_route_sheet(buf, len, &decoded) == RS_OK) {
      adoptRoute(&decoded);
    }
  }
  f.close();
}

// ---------------------------------------------------------------------------
// Pace math (display-side). Deviation is recomputed from elapsed time and
// the last known distance so the hero number keeps ticking between wheel
// notifications — identical to the phone's value at every notification
// timestamp, which is what the replay cross-validation compares.

static uint32_t currentEpochS() {
  if (!clockSynced) return 0;
  return epochAtSyncS + (millis() - millisAtSync) / 1000;
}

// Seconds remaining until the scheduled row start; 0 once it has passed.
static int32_t countdownSeconds() {
  int32_t remainMs = (int32_t)(rideStartMs - millis());
  return remainMs > 0 ? (remainMs + 999) / 1000 : 0;
}

// Shared by the CONTROL opcode and the hardwired button. During the countdown
// (or just after the scheduled start) this anchors the ride to the actual go
// signal, absorbing drift between the device clock and the official one, and
// zeroes distance and the log because the ride truly starts here. Later in the
// ride it is an AMA reset checkpoint: flash only, no re-anchoring.
static void triggerReset() {
  uint32_t now = millis();
  bool atStart = (rideState == RS_RIDE_COUNTDOWN) ||
                 (rideState == RS_RIDE_RIDING && (int32_t)(now - rideStartMs) >= 0 &&
                  (now - rideStartMs) <= RESET_START_WINDOW_MS);

  if (atStart) {
    rideStartMs = now;
    rideEpochS = currentEpochS();
    cumulativeMi = 0.0;
    currentSpeedMph = 0.0;
    segmentIndex = 0;
    cscHasState = false;
    rideLogCount = 0;
    rideLogOverflowed = false;
    rideState = RS_RIDE_RIDING;
  }
  resetFlashUntilMs = now + 3000;
}

static double currentDeviationSeconds() {
  if (rideState != RS_RIDE_RIDING || !routeLoaded) return 0.0;
  double elapsed = (double)(millis() - rideStartMs) / 1000.0;
  pe_position_t pos = pe_detect_segment(segments, route.count, cumulativeMi);
  double keyTime = pe_compute_key_time(segments, route.count, pos.segment_index,
                                       pos.distance_in_segment);
  return pe_compute_deviation(elapsed, keyTime);
}

// ---------------------------------------------------------------------------
// CSC central role

static void cscNotifyCallback(BLEClientCharacteristic *chr, uint8_t *data,
                              uint16_t len) {
  (void)chr;

  // Capture the raw decoded pair unconditionally while riding — including
  // null-update cases — exactly like ble-manager.ts does on the phone.
  if (rideState == RS_RIDE_RIDING && len >= 7 && (data[0] & 0x01)) {
    uint32_t revs = (uint32_t)data[1] | ((uint32_t)data[2] << 8) |
                    ((uint32_t)data[3] << 16) | ((uint32_t)data[4] << 24);
    uint16_t eventTime = (uint16_t)(data[5] | ((uint16_t)data[6] << 8));
    uint32_t n = rideLogCount;
    if (n < RIDE_LOG_CAPACITY) {
      rideLog[n].wall_clock_ms = millis() - rideStartMs;
      rideLog[n].cumulative_revs = revs;
      rideLog[n].wheel_event_time = eventTime;
      rideLogCount = n + 1;
    } else {
      rideLogOverflowed = true;
    }
  }

  csc_state_t next;
  csc_update_t update;
  bool hasUpdate = csc_parse_notification(data, len,
                                          cscHasState ? &cscState : NULL,
                                          wheelCircumferenceMm, &next, &update);
  cscState = next;
  cscHasState = true;

  if (!hasUpdate) return;
  currentSpeedMph = update.speed_mph;

  if (rideState != RS_RIDE_RIDING || !routeLoaded) return;
  cumulativeMi +=
      ((double)update.delta_revolutions * wheelCircumferenceMm) / 1000.0 / 1609.34;

  pe_position_t pos = pe_detect_segment(segments, route.count, cumulativeMi);
  if (pe_crossed_reset(segments, route.count, segmentIndex, pos.segment_index)) {
    resetFlashUntilMs = millis() + 3000;
  }
  segmentIndex = pos.segment_index;
}

// Counter so the "still looking" line is periodic rather than per-advert.
static uint32_t scanOtherSeen = 0;

static void scanCallback(ble_gap_evt_adv_report_t *report) {
  // Checked here rather than via Scanner.filterUuid() so that a sensor which
  // advertises 0x1816 only in its SCAN_RSP is still matched, and so the serial
  // log shows what is actually on the air when it isn't.
  if (Bluefruit.Scanner.checkReportForUuid(report, cscService.uuid)) {
    const uint8_t *a = report->peer_addr.addr;
    Serial.printf("[scan] CSC sensor %02X:%02X:%02X:%02X:%02X:%02X rssi=%d\n",
                  a[5], a[4], a[3], a[2], a[1], a[0], report->rssi);
    Bluefruit.Central.connect(report);
    return;  // no resume(): connecting takes over from scanning
  }

  if (++scanOtherSeen % 25 == 0) {
    Serial.printf("[scan] %lu non-CSC adverts seen, still looking\n",
                  (unsigned long)scanOtherSeen);
  }
  // SoftDevice pauses the scanner to deliver each report; without this it
  // stops after the first device that isn't ours.
  Bluefruit.Scanner.resume();
}

static void centralConnectCallback(uint16_t connHandle) {
  sensorStatus = RS_SENSOR_CONNECTING;
  if (cscService.discover(connHandle) && cscMeasurement.discover()) {
    cscMeasurement.enableNotify();
    sensorStatus = RS_SENSOR_CONNECTED;
    Serial.println("[csc] connected, notifications enabled");
  } else {
    Serial.println("[csc] service/characteristic discovery FAILED, dropping");
    Bluefruit.disconnect(connHandle);
    sensorStatus = RS_SENSOR_DISCONNECTED;
  }
}

static void centralDisconnectCallback(uint16_t connHandle, uint8_t reason) {
  (void)connHandle;
  // 0x08 supervision timeout (out of range / battery out), 0x13 remote user
  // terminated (the sensor went to sleep), 0x3E failed to establish.
  Serial.printf("[csc] disconnected, reason 0x%02X\n", reason);
  cscHasState = false;  // re-baseline on reconnect, same as the phone manager
  sensorStatus = RS_SENSOR_LOST;
  // Scanner.restartOnDisconnect(true) handles the reconnect scan.
}

// ---------------------------------------------------------------------------
// Phone peripheral role

static void routeSheetWriteCallback(uint16_t connHandle, BLECharacteristic *chr,
                                    uint8_t *data, uint16_t len) {
  (void)connHandle;
  (void)chr;
  if (len < 1) return;

  switch (data[0]) {
    case XFER_BEGIN: {
      if (len < 3) return;
      xferExpected = (uint16_t)(data[1] | (data[2] << 8));
      xferActive = xferExpected > 0 && xferExpected <= XFER_MAX;
      break;
    }
    case XFER_DATA: {
      if (!xferActive || len < 4) return;
      uint16_t offset = (uint16_t)(data[1] | (data[2] << 8));
      uint16_t chunkLen = len - 3;
      if ((uint32_t)offset + chunkLen > xferExpected) {
        xferActive = false;
        return;
      }
      memcpy(xferBuf + offset, data + 3, chunkLen);
      break;
    }
    case XFER_END: {
      if (!xferActive) return;
      xferActive = false;
      // static for the same reason as in loadPersistedRoute(): ~3.6 KB will
      // not fit on this callback's stack. Its own static, not shared with the
      // boot-time one, since this runs on the BLE task.
      static rs_route_t decoded;
      if (rs_decode_route_sheet(xferBuf, xferExpected, &decoded) == RS_OK) {
        adoptRoute(&decoded);
        routePersistLen = xferExpected;
        routePersistPending = true;  // flash write deferred to loop()
      }
      break;
    }
  }
}

static void controlWriteCallback(uint16_t connHandle, BLECharacteristic *chr,
                                 uint8_t *data, uint16_t len) {
  (void)connHandle;
  (void)chr;
  if (len < 1) return;

  switch (data[0]) {
    case 0x01:  // START_RIDE [epoch_s u32]
      if (len >= 5) {
        rideEpochS = (uint32_t)data[1] | ((uint32_t)data[2] << 8) |
                     ((uint32_t)data[3] << 16) | ((uint32_t)data[4] << 24);
      }
      rideStartMs = millis();
      cumulativeMi = 0.0;
      currentSpeedMph = 0.0;
      segmentIndex = 0;
      cscHasState = false;
      rideLogCount = 0;
      rideLogOverflowed = false;
      rideState = RS_RIDE_RIDING;
      break;
    case 0x02:  // END_RIDE
      if (rideState == RS_RIDE_RIDING) {
        rideState = rideLogCount > 0 ? RS_RIDE_LOG_READY : RS_RIDE_IDLE;
      }
      break;
    case 0x03:  // MANUAL_RESET — parity with the phone: momentary zero
      triggerReset();
      break;
    case 0x04:  // SET_WHEEL_CIRC [mm u16]
      if (len >= 3) {
        uint16_t mm = (uint16_t)(data[1] | (data[2] << 8));
        if (mm > 0) wheelCircumferenceMm = (double)mm;
      }
      break;
    case 0x05:  // REQUEST_RIDE_LOG
      logStreamRequested = true;
      break;
    case 0x07:  // SET_START_TIME [now_epoch_s u32][key_epoch_s u32][row u8]
      if (len >= 10) {
        uint32_t nowEpoch = (uint32_t)data[1] | ((uint32_t)data[2] << 8) |
                            ((uint32_t)data[3] << 16) | ((uint32_t)data[4] << 24);
        uint32_t keyEpoch = (uint32_t)data[5] | ((uint32_t)data[6] << 8) |
                            ((uint32_t)data[7] << 16) | ((uint32_t)data[8] << 24);
        riderRow = data[9];
        riderStartEpochS =
            rs_rider_start_epoch(keyEpoch, riderRow, RS_DEFAULT_ROW_INTERVAL_S);
        epochAtSyncS = nowEpoch;
        millisAtSync = millis();
        clockSynced = true;

        int64_t deltaS = (int64_t)riderStartEpochS - (int64_t)nowEpoch;
        rideStartMs = (uint32_t)((int64_t)millisAtSync + deltaS * 1000);
        rideEpochS = riderStartEpochS;

        cumulativeMi = 0.0;
        currentSpeedMph = 0.0;
        segmentIndex = 0;
        cscHasState = false;
        rideLogCount = 0;
        rideLogOverflowed = false;
        rideState = deltaS > 0 ? RS_RIDE_COUNTDOWN : RS_RIDE_RIDING;
      }
      break;
    case 0x06:  // CLEAR_RIDE_LOG
      rideLogCount = 0;
      rideLogOverflowed = false;
      if (rideState == RS_RIDE_LOG_READY) rideState = RS_RIDE_IDLE;
      break;
  }
}

static void notifyStatus() {
  rs_status_t st = {
      .sensor_status = sensorStatus,
      .ride_state = rideState,
      .battery_pct = readBatteryPct(),
      .deviation_seconds = currentDeviationSeconds(),
      .cumulative_distance_mi = cumulativeMi,
      .segment_index = (uint8_t)segmentIndex,
      .route_loaded = routeLoaded,
      .in_free_section =
          routeLoaded && pe_is_in_free_segment(segments, route.count, segmentIndex),
  };
  uint8_t buf[RS_STATUS_BYTES];
  rs_encode_status(buf, &st);
  statusChar.write(buf, RS_STATUS_BYTES);  // keep readable value current
  if (phoneConnHandle != BLE_CONN_HANDLE_INVALID) {
    statusChar.notify(phoneConnHandle, buf, RS_STATUS_BYTES);
  }
}

static void periphConnectCallback(uint16_t connHandle) {
  phoneConnHandle = connHandle;
}

static void periphDisconnectCallback(uint16_t connHandle, uint8_t reason) {
  (void)reason;
  if (phoneConnHandle == connHandle) phoneConnHandle = BLE_CONN_HANDLE_INVALID;
  xferActive = false;
}

// Stream the whole RAM log as DATA packets + END, sized to the live MTU.
static void streamRideLog() {
  uint16_t conn = phoneConnHandle;
  if (conn == BLE_CONN_HANDLE_INVALID) return;

  uint16_t payloadMax = 20;  // ATT_MTU 23 default
  BLEConnection *connection = Bluefruit.Connection(conn);
  if (connection) payloadMax = connection->getMtu() - 3;
  if (payloadMax > 244) payloadMax = 244;

  static uint8_t buf[247];
  uint16_t crc = 0xFFFF;
  uint8_t seq = 0;
  uint32_t idx = 0;
  uint32_t total = rideLogCount;

  while (idx < total) {
    size_t encoded = 0;
    size_t len = rs_encode_ride_log_data(buf, payloadMax, seq,
                                         (const rs_log_row_t *)&rideLog[idx],
                                         total - idx, &encoded);
    if (len == 0) break;
    crc = rs_crc16_update(crc, buf + 2, len - 2);
    int retries = 0;
    while (!rideLogChar.notify(conn, buf, (uint16_t)len)) {
      if (phoneConnHandle != conn || ++retries > 400) return;  // phone went away
      delay(5);
    }
    idx += encoded;
    seq++;
  }

  uint8_t endBuf[RS_LOG_END_BYTES];
  rs_encode_ride_log_end(endBuf, seq, (uint16_t)total, crc);
  int retries = 0;
  while (!rideLogChar.notify(conn, endBuf, RS_LOG_END_BYTES)) {
    if (phoneConnHandle != conn || ++retries > 400) return;
    delay(5);
  }
}

// ---------------------------------------------------------------------------
// Battery (Feather nRF52840: VBAT through a 1/2 divider on PIN_VBAT)

static uint8_t readBatteryPct() {
  analogReference(AR_INTERNAL_3_0);
  analogReadResolution(12);
  float vbat = analogRead(PIN_VBAT) * 2.0f * 3.0f / 4096.0f;
  analogReference(AR_DEFAULT);
  if (vbat < 2.5f) return RS_BATTERY_UNKNOWN;  // no LiPo attached
  float pct = (vbat - 3.3f) / (4.2f - 3.3f) * 100.0f;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return (uint8_t)pct;
}

// ---------------------------------------------------------------------------
// Display

static void formatDeviation(double dev, bool resetFlash, char *out, size_t cap) {
  if (resetFlash) {
    snprintf(out, cap, "RESET");
    return;
  }
  long s = lround(dev);
  if (s == 0) {
    snprintf(out, cap, "0");
    return;
  }
  char sign = s > 0 ? '+' : '-';
  long a = labs(s);
  if (a < 60) {
    snprintf(out, cap, "%c%ld", sign, a);
  } else {
    snprintf(out, cap, "%c%ld:%02ld", sign, a / 60, a % 60);
  }
}

static void drawCentered(const char *text, int16_t y, uint8_t size) {
  int16_t x1, y1;
  uint16_t w, h;
  display.setTextSize(size);
  display.getTextBounds(text, 0, y, &x1, &y1, &w, &h);
  display.setCursor((DISPLAY_W - (int16_t)w) / 2, y);
  display.print(text);
}

static void render() {
  display.clearDisplayBuffer();
  display.setTextWrap(false);

  // Colour scheme is decided before anything is drawn: when the rider is early
  // (ahead of schedule) the whole panel inverts to white-on-black, so the state
  // reads at a glance on the bars without parsing the sign on the number.
  // Deliberately not applied to the RESET flash, which stays normal so it can't
  // be confused with the early state.
  bool riding = (rideState == RS_RIDE_RIDING) && routeLoaded;
  bool resetFlash = millis() < resetFlashUntilMs;
  double dev = riding ? currentDeviationSeconds() : 0.0;
  long devRounded = lround(dev);
  bool inverted = riding && !resetFlash && devRounded < 0;

  if (inverted) display.fillScreen(BLACK);
  display.setTextColor(inverted ? WHITE : BLACK);

  char line[48];

  // Header: sensor + battery + segment
  display.setTextSize(2);
  display.setCursor(4, 4);
  switch (sensorStatus) {
    case RS_SENSOR_CONNECTED: display.print("SENSOR OK"); break;
    case RS_SENSOR_CONNECTING: display.print("SENSOR ..."); break;
    case RS_SENSOR_LOST: display.print("SENSOR LOST"); break;
    default: display.print("NO SENSOR"); break;
  }
  uint8_t batt = readBatteryPct();
  if (batt != RS_BATTERY_UNKNOWN) {
    snprintf(line, sizeof(line), "%u%%", batt);
    display.setCursor(DISPLAY_W - 12 * strlen(line) - 4, 4);
    display.print(line);
  }

  if (!routeLoaded) {
    drawCentered("NO ROUTE", 100, 4);
    drawCentered("push a sheet from the phone", 150, 2);
    display.refresh();
    return;
  }

  if (rideState == RS_RIDE_COUNTDOWN) {
    int32_t remain = countdownSeconds();
    snprintf(line, sizeof(line), "ROW %u", riderRow);
    drawCentered(line, 40, 3);
    // H:MM:SS past an hour — arming well ahead of the start is normal, so the
    // hour field is not an edge case. Narrower glyphs keep it on the panel.
    if (remain >= 3600) {
      snprintf(line, sizeof(line), "%ld:%02ld:%02ld", (long)(remain / 3600),
               (long)((remain % 3600) / 60), (long)(remain % 60));
      drawCentered(line, 100, 7);
    } else {
      snprintf(line, sizeof(line), "%ld:%02ld", (long)(remain / 60),
               (long)(remain % 60));
      drawCentered(line, 88, 11);
    }
    drawCentered("TO START", 190, 3);
    display.refresh();
    return;
  }

  if (rideState != RS_RIDE_RIDING) {
    drawCentered(rideState == RS_RIDE_LOG_READY ? "LOG READY" : "READY", 90, 5);
    snprintf(line, sizeof(line), "%u segments", route.count);
    drawCentered(line, 160, 2);
    display.refresh();
    return;
  }

  // Segment line
  const char *label = route.segments[segmentIndex].label;
  snprintf(line, sizeof(line), "SEG %ld/%u %s", (long)segmentIndex + 1,
           route.count, label);
  display.setCursor(4, 28);
  display.setTextSize(2);
  display.print(line);

  // Hero: deviation (or ON TIME / FREE / RESET). resetFlash, dev and
  // devRounded were computed at the top of render() to pick the colour scheme.
  bool inFree = pe_is_in_free_segment(segments, route.count, segmentIndex);

  char hero[16];
  formatDeviation(dev, resetFlash, hero, sizeof(hero));

  if (!resetFlash && devRounded == 0) {
    drawCentered("ON TIME", 90, 7);
  } else {
    uint8_t size = strlen(hero) <= 3 ? 12 : (strlen(hero) <= 5 ? 10 : 8);
    drawCentered(hero, 70, size);
  }

  if (inFree) {
    drawCentered("FREE", 176, 3);
  }

  // Footer: speed and distance
  snprintf(line, sizeof(line), "%.1f mph", currentSpeedMph);
  display.setTextSize(3);
  display.setCursor(4, DISPLAY_H - 28);
  display.print(line);
  snprintf(line, sizeof(line), "%.2f mi", cumulativeMi);
  display.setCursor(DISPLAY_W - 18 * strlen(line) - 4, DISPLAY_H - 28);
  display.print(line);

  display.refresh();
}

// ---------------------------------------------------------------------------
// Hardwired buttons — debounced, with optional press-and-hold auto-repeat
// for UP/DOWN. RESET fires CONTROL 0x03's effect; UP/DOWN nudge cumulativeMi
// directly (course mile-marker correction, not a route-sheet reset).

// Returns true on the debounced press edge, and again on each auto-repeat
// tick while held (if allowRepeat).
static bool pollButton(DebouncedButton &b, bool allowRepeat) {
  bool reading = digitalRead(b.pin);
  uint32_t now = millis();
  bool fired = false;

  if (reading != b.lastReading) {
    b.lastChangeMs = now;
    b.lastReading = reading;
  }

  if (now - b.lastChangeMs >= BUTTON_DEBOUNCE_MS && reading != b.debouncedState) {
    b.debouncedState = reading;
    if (b.debouncedState == LOW) {  // press edge
      b.pressStartMs = now;
      b.lastRepeatMs = now;
      fired = true;
    }
  }

  if (allowRepeat && b.debouncedState == LOW &&
      now - b.pressStartMs >= ADJUST_HOLD_DELAY_MS &&
      now - b.lastRepeatMs >= ADJUST_REPEAT_MS) {
    b.lastRepeatMs = now;
    fired = true;
  }

  return fired;
}

static void adjustDistance(double deltaMi) {
  if (!routeLoaded) return;  // nothing to recompute a segment against
  cumulativeMi += deltaMi;
  if (cumulativeMi < 0) cumulativeMi = 0;
  pe_position_t pos = pe_detect_segment(segments, route.count, cumulativeMi);
  segmentIndex = pos.segment_index;  // no crossedReset check: a mile-marker
                                      // correction isn't crossing a route
                                      // reset checkpoint, so no RESET flash
}

static void pollButtons() {
  if (pollButton(resetButton, false)) {
    triggerReset();
  }
  if (pollButton(upButton, true)) {
    adjustDistance(ADJUST_STEP_MI);
  }
  if (pollButton(downButton, true)) {
    adjustDistance(-ADJUST_STEP_MI);
  }
}

// ---------------------------------------------------------------------------
// Boot progress. Each stage is printed to serial AND painted on the panel, so
// a hang during setup() leaves the last completed stage on screen — the Sharp
// LCD holds its last image, which makes it a usable debugger when no serial
// monitor is attached. If the unit ever boots to a "BOOT: ..." screen instead
// of NO ROUTE/READY, setup() died at the stage after the one shown.

static void bootStage(const char *msg) {
  Serial.print("[boot] ");
  Serial.println(msg);
  display.clearDisplayBuffer();
  display.setTextColor(BLACK);
  display.setTextWrap(false);
  display.setTextSize(2);
  display.setCursor(4, 4);
  display.print("BOOT: ");
  display.print(msg);
  display.refresh();
  delay(150);  // long enough for a human to watch the sequence
}

void setup() {
  Serial.begin(115200);
  // Bounded wait: give USB serial a moment to enumerate so early prints aren't
  // lost, but never block forever when running off a battery with no host.
  uint32_t serialWaitStart = millis();
  while (!Serial && millis() - serialWaitStart < 2000) {}

  // begin() mallocs the 12 KB frame buffer. If that fails it returns false and
  // every subsequent draw writes through a null pointer — a hard fault with a
  // blank panel and no clue why. Signal it on the LED instead.
  if (!display.begin()) {
    Serial.println("[boot] FATAL: display.begin() failed (frame buffer alloc)");
    pinMode(LED_BUILTIN, OUTPUT);
    for (;;) {
      digitalWrite(LED_BUILTIN, HIGH);
      delay(100);
      digitalWrite(LED_BUILTIN, LOW);
      delay(100);
    }
  }
  display.clearDisplay();
  bootStage("display");

  pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
  pinMode(UP_BUTTON_PIN, INPUT_PULLUP);
  pinMode(DOWN_BUTTON_PIN, INPUT_PULLUP);
  bootStage("buttons");

  InternalFS.begin();
  bootStage("filesystem");
  loadPersistedRoute();
  bootStage("route load");

  if (!Bluefruit.begin(1 /* peripheral */, 1 /* central */)) {
    Serial.println("[boot] FATAL: Bluefruit.begin() failed");
    bootStage("BLE FAILED");
    for (;;) delay(1000);
  }
  Bluefruit.setTxPower(4);

  char name[16];
  snprintf(name, sizeof(name), "Enduro-%04X",
           (unsigned)(NRF_FICR->DEVICEID[0] & 0xFFFF));
  Bluefruit.setName(name);
  bootStage("bluefruit");

  // Peripheral: Enduro service
  enduroService.begin();

  routeSheetChar.setProperties(CHR_PROPS_WRITE);
  routeSheetChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  routeSheetChar.setMaxLen(247);
  routeSheetChar.setWriteCallback(routeSheetWriteCallback);
  routeSheetChar.begin();

  controlChar.setProperties(CHR_PROPS_WRITE);
  controlChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  controlChar.setMaxLen(20);
  controlChar.setWriteCallback(controlWriteCallback);
  controlChar.begin();

  statusChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  statusChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  statusChar.setFixedLen(RS_STATUS_BYTES);
  statusChar.begin();

  rideLogChar.setProperties(CHR_PROPS_NOTIFY);
  rideLogChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  rideLogChar.setMaxLen(247);
  rideLogChar.begin();
  bootStage("gatt");

  // Central: CSC client
  cscService.begin();
  cscMeasurement.setNotifyCallback(cscNotifyCallback);
  cscMeasurement.begin();
  bootStage("csc client");

  Bluefruit.Central.setConnectCallback(centralConnectCallback);
  Bluefruit.Central.setDisconnectCallback(centralDisconnectCallback);
  Bluefruit.Periph.setConnectCallback(periphConnectCallback);
  Bluefruit.Periph.setDisconnectCallback(periphDisconnectCallback);

  Bluefruit.Scanner.setRxCallback(scanCallback);
  Bluefruit.Scanner.restartOnDisconnect(true);
  // Active scanning so SCAN_RSP payloads are received: plenty of CSC sensors
  // advertise the 0x1816 UUID only there, and a passive scan never sees it.
  // The UUID match moved into scanCallback() (see there).
  Bluefruit.Scanner.useActiveScan(true);
  Bluefruit.Scanner.setInterval(160, 80);  // 100 ms interval, 50 ms window
  Bluefruit.Scanner.start(0);              // scan forever
  bootStage("scanner");

  // Advertise to the phone
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(enduroService);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
  bootStage("advertising");

  Serial.println("[boot] setup complete");
  render();
}

void loop() {
  static uint32_t lastRenderMs = 0;
  static uint32_t lastStatusMs = 0;
  static uint32_t lastHeartbeatMs = 0;
  uint32_t now = millis();

  // Heartbeat: proves loop() is still running when the panel looks frozen.
  if (now - lastHeartbeatMs >= 2000) {
    lastHeartbeatMs = now;
    Serial.print("[loop] up=");
    Serial.print(now / 1000);
    Serial.print("s route=");
    Serial.print(routeLoaded ? "yes" : "no");
    Serial.print(" mi=");
    Serial.println(cumulativeMi, 2);
  }

  pollButtons();

  // Scheduled row start reached: the ride clock begins on its own, so the
  // deviation is anchored to the official minute whether or not anyone
  // touches a button. RESET within RESET_START_WINDOW_MS re-anchors it.
  if (rideState == RS_RIDE_COUNTDOWN && (int32_t)(now - rideStartMs) >= 0) {
    rideState = RS_RIDE_RIDING;
  }

  if (routePersistPending) {
    routePersistPending = false;
    persistRoute(xferBuf, routePersistLen);
  }

  if (logStreamRequested) {
    logStreamRequested = false;
    streamRideLog();
  }

  if (now - lastRenderMs >= 500) {
    lastRenderMs = now;
    render();
  }

  if (now - lastStatusMs >= 1000) {
    lastStatusMs = now;
    notifyStatus();
  }

  delay(10);
}
