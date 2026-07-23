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
// Temporary bring-up flag: set to 1 to skip all Bluefruit/BLE init and test
// whether the display + serial path boots stably on its own. Leave at 0 for
// normal builds — remove this flag once bring-up is done.
#define ENDURO_DEBUG_SKIP_BLE 0

// ---------------------------------------------------------------------------
// Display — Adafruit 4694 breakout on hardware SPI. See docs/HARDWARE.md.

#define SHARP_CS_PIN 5
#define DISPLAY_W 400
#define DISPLAY_H 240

Adafruit_SharpMem display(&SPI, SHARP_CS_PIN, DISPLAY_W, DISPLAY_H);

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
    rs_route_t decoded;
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

static void scanCallback(ble_gap_evt_adv_report_t *report) {
  // Scanner is filtered on the CSC service UUID — connect to the first hit.
  Bluefruit.Central.connect(report);
}

static void centralConnectCallback(uint16_t connHandle) {
  sensorStatus = RS_SENSOR_CONNECTING;
  if (cscService.discover(connHandle) && cscMeasurement.discover()) {
    cscMeasurement.enableNotify();
    sensorStatus = RS_SENSOR_CONNECTED;
  } else {
    Bluefruit.disconnect(connHandle);
    sensorStatus = RS_SENSOR_DISCONNECTED;
  }
}

static void centralDisconnectCallback(uint16_t connHandle, uint8_t reason) {
  (void)connHandle;
  (void)reason;
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
      rs_route_t decoded;
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
      resetFlashUntilMs = millis() + 3000;
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
  Serial.println("checkpoint: render() start");
  display.clearDisplayBuffer();
  display.setTextColor(0);  // Adafruit_SharpMem: 0 = black
  display.setTextWrap(false);

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
    Serial.println("checkpoint: drawing NO ROUTE");
    drawCentered("NO ROUTE", 100, 4);
    drawCentered("push a sheet from the phone", 150, 2);
    Serial.println("checkpoint: calling display.refresh()");
    display.refresh();
    Serial.println("checkpoint: refresh() returned");
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

  // Hero: deviation (or ON TIME / FREE / RESET)
  bool resetFlash = millis() < resetFlashUntilMs;
  bool inFree = pe_is_in_free_segment(segments, route.count, segmentIndex);
  double dev = currentDeviationSeconds();

  char hero[16];
  formatDeviation(dev, resetFlash, hero, sizeof(hero));
  long devRounded = lround(dev);

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

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("checkpoint: serial up");

  display.begin();
  display.clearDisplay();
  Serial.println("checkpoint: display cleared");

#if ENDURO_DEBUG_SKIP_BLE
  // Bare draw worked. Now test drawCentered()/getTextBounds() specifically,
  // without readBatteryPct() in the mix.
  Serial.println("checkpoint: drawCentered test (debug minimal)");
  display.clearDisplayBuffer();
  display.setTextColor(0);
  display.setTextWrap(false);
  drawCentered("NO ROUTE", 100, 4);
  drawCentered("push a sheet from the phone", 150, 2);
  display.refresh();
  Serial.println("checkpoint: drawCentered refresh() returned (debug minimal)");
  while (1) { delay(1000); }  // halt here — don't touch FS or BLE at all
#endif

  InternalFS.begin();
  loadPersistedRoute();
  Serial.println("checkpoint: fs + route load done");

#if !ENDURO_DEBUG_SKIP_BLE
  Bluefruit.begin(1 /* peripheral */, 1 /* central */);
  Bluefruit.setTxPower(4);
  Serial.println("checkpoint: bluefruit begin done");

  char name[16];
  snprintf(name, sizeof(name), "Enduro-%04X",
           (unsigned)(NRF_FICR->DEVICEID[0] & 0xFFFF));
  Bluefruit.setName(name);

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

  // Central: CSC client
  cscService.begin();
  cscMeasurement.setNotifyCallback(cscNotifyCallback);
  cscMeasurement.begin();

  Bluefruit.Central.setConnectCallback(centralConnectCallback);
  Bluefruit.Central.setDisconnectCallback(centralDisconnectCallback);
  Bluefruit.Periph.setConnectCallback(periphConnectCallback);
  Bluefruit.Periph.setDisconnectCallback(periphDisconnectCallback);

  Bluefruit.Scanner.setRxCallback(scanCallback);
  Bluefruit.Scanner.restartOnDisconnect(true);
  Bluefruit.Scanner.filterUuid(cscService.uuid);
  Bluefruit.Scanner.useActiveScan(false);
  Bluefruit.Scanner.setInterval(160, 80);  // 100 ms interval, 50 ms window
  Bluefruit.Scanner.start(0);              // scan forever

  // Advertise to the phone
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(enduroService);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
  Serial.println("checkpoint: advertising started, calling render()");
#else
  Serial.println("checkpoint: BLE skipped for debug");
#endif

  render();
  Serial.println("checkpoint: render() returned");
}

void loop() {
  static uint32_t lastRenderMs = 0;
  static uint32_t lastStatusMs = 0;
  uint32_t now = millis();

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
