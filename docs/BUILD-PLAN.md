# Enduro Companion: Build Plan

> Supersedes the original `enduro-app-plan.md` where hardware strategy is concerned.
> Code decisions already made and committed are noted as decided — they are not open.

---

## Product strategy

The phone app is the demo and the on-ramp, not the final product.

The live ride ultimately runs on a dedicated **ESP32 + Sharp Memory LCD** handlebar unit: always-on, no battery anxiety, no lock-screen, no OS interruptions, readable in direct sun, survives mud. The phone becomes a companion: route-sheet entry, library and sharing, post-ride analytics, pushing sheets to the device over BLE and pulling back the ride log.

The Sharp Memory LCD (e.g., LS013B7DH03, 128×128, or LS027B7DH01, 400×240) is specifically chosen over e-ink because refresh is fast enough for a live number that changes every second. E-ink is not suitable.

This strategy has two practical consequences for how the phone code is written right now:

1. **The engine and parser are the golden reference.** `pace-engine.ts` and `csc-parser.ts` are pure functions with no platform dependencies. They stay that way permanently. The C firmware on the ESP32 gets validated against the TypeScript unit tests — same inputs, same outputs. Do not add side effects, timers, or RN imports to these files.

2. **The phone live-screen is deliberately lean and partially throwaway.** It needs to be correct and testable, not polished. Time spent on live-screen animation, haptics, and gesture refinement before the ESP32 path is validated is mostly wasted. Build it to the point where you can ride with it and trust the numbers. Stop there until the hardware path is proven.

---

## What the phone app permanently keeps

These survive into the companion role unchanged or with minor adaptation:

- **Route library and sheet builder** — the primary input surface regardless of hardware
- **Pre-ride setup flow** — sensor pairing, circumference confirmation, start-time entry
- **Route sharing** (Phase 2) — search, publish, AirDrop-style local share
- **Post-ride analytics** — deviation chart, session history, per-event trends
- **SQLite store** — routes, segments, rides, raw CSC log, derived ride log

---

## What the phone live-screen is (deliberately not)

The phone live-screen is a functional demo and a validation harness, not a shipping product. Accept that:

- Touch interaction is adequate for now; BLE remote is Phase 2 on phone, primary on ESP32
- Screen brightness, keep-awake, and anti-ghost-touch are worth doing but not blocking
- Polish (animation, haptics, font tuning) waits until the hardware path is proven

---

## Current codebase state (as of this writing)

Tests: 21/21 passing.

| File | Status |
|---|---|
| `src/engine/pace-engine.ts` | Decided. Pure functions. Formula uses `* 3600` (seconds). The plan doc said `* 60` — the doc was wrong, the code is right. |
| `src/ble/csc-parser.ts` | Decided. Pure function. Has a 32-bit rollover guard that will misread sensor power-cycles — see Priority 2 below. |
| `src/ble/ble-manager.ts` | Working. iOS backgrounding behavior untested — see Priority 4. |
| `src/store/ride-store.ts` | Working. Auto-reset detection has a known gap — see Priority 4. |
| `src/db/schema.ts` | Working. Missing raw CSC log table — see Priority 1. |
| All four screens | Working shell. Phone live-screen intentionally lean per above. |

---

## Near-term priorities (ordered)

### Priority 1 — Raw CSC log + replay harness (must land before next real ride)

**Why first:** The derived `ride_log` table stores `(cumulative_distance, deviation_seconds)` sampled every 5 seconds. That is permanently lossy. The raw notification stream — `(cumulative_revs, wheel_event_time, wall_clock_ms)` — is what the C firmware gets validated against. Once a ride happens without this, that replay corpus is gone forever. But the corpus is inert without a runner that can feed it through the engine and assert the output. The harness is what makes the TS engine a "golden reference" in any enforceable sense — a log you can't replay is just a file.

**Schema — new table `raw_csc_log` in `src/db/schema.ts`:**

```sql
CREATE TABLE IF NOT EXISTS raw_csc_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id          INTEGER NOT NULL,
  wall_clock_ms    INTEGER NOT NULL,   -- Date.now() at notification receipt
  cumulative_revs  INTEGER NOT NULL,   -- decoded 32-bit wheel revolution counter
  wheel_event_time INTEGER NOT NULL,   -- decoded 16-bit 1/1024s timestamp
  FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE
);
```

Store the **decoded** `(cumulative_revs, wheel_event_time)` pair, not the raw base64 bytes. The decoded pair is what both the TS and C parsers actually consume. Storing raw bytes would force the replay harness to re-walk CSC flag parsing, which is not the thing under test. The table is separate from `ride_log` because the cardinality is totally different: one row per BLE notification (~1 Hz) versus a 5-second derived sample.

**Capture point:** Inside `ble-manager.ts`, `subscribeToSpeed()`, after decoding `bytes` and extracting `cumulativeRevolutions` / `lastEventTime`, before calling `parseCscNotification`. The write goes to a queue that flushes in batches (every ~50 rows or 10s) — do not SQLite-write synchronously on every BLE notification, that will block the JS thread.

The `csc-parser.ts` signature does not change. The raw log is captured by the manager, not the parser.

**Replay harness — `src/engine/replay.ts` + snapshot test:**

Read `raw_csc_log` rows for a ride, feed them sequentially through `parseCscNotification` then the pace engine, and produce a `deviation_seconds` series. Snapshot-test it so any engine change that alters the numbers fails loudly. This is also the exact function you point at C firmware output later: same inputs, compare outputs row by row.

---

### Priority 2 — Speed sanity clamp in `csc-parser.ts`

**Why second:** The current 32-bit rollover guard:

```ts
if (deltaRevs < 0) {
  deltaRevs += 0x100000000;
}
```

This correctly handles counter rollover after ~4 billion revolutions (years of riding). It does *not* handle a sensor **power-cycle**, where the cumulative counter resets to 0. In that case `deltaRevs` is a large negative number, the guard adds 4B to it, and the result is a near-4-billion-rev delta. This is the "mileage jumped to a huge number" failure documented in CheckPoint Two reviews.

**Fix — order matters:** Both a genuine 32-bit rollover and a power-cycle present as a negative `deltaRevs`. The way to tell them apart is where the new counter lands: a real rollover produces a new value near the top of the 32-bit range with a plausible implied speed; a power-cycle resets to near zero and implies an absurd speed after the rollover guard inflates it.

The correct order:

1. Compute raw `deltaRevs = cumulativeRevolutions - prev.cumulativeRevolutions`
2. **Before** the rollover guard: if `deltaRevs` is negative and the new `cumulativeRevolutions` is small (near zero, say `< 1000`), treat it as a power-cycle — re-baseline `cscState` to the new reading, return `{ state, update: null }`. No rollover correction applied.
3. **After** that check: apply the genuine 32-bit rollover correction for the case where the counter wrapped naturally near `0xFFFFFFFF`.
4. Clamp by implied speed as a final backstop against any other implausible delta.

Add a code comment at the branch point because this is non-obvious: "A negative delta can mean counter rollover (~4B revs, years of riding) or sensor power-cycle (counter resets to 0). Distinguish by where the new counter lands: near zero = power-cycle, re-baseline. Near max = genuine rollover, apply correction."

Add test cases for both: genuine rollover near `0xFFFFFFFF`, and power-cycle reset to small value. Both should produce `null` update on the bad notification and correct speed on the next one.

---

### Priority 3 — Handlebar BLE remote

**Decision: Priority 2 item on phone, primary input on ESP32.**

Rationale: the phone live-screen is a demo. Getting through one real ride using the touch RESET button is acceptable for validation purposes. However, there is a real risk in validating a touch-driven live screen for too long — you end up optimizing a UI model that gets thrown away when the ESP32 takes over.

Mitigation: keep touch interaction minimal and functional (it already is). Do not add gesture refinements or multi-tap shortcuts to the phone live-screen. When the remote lands, it lands as a second `BleManager` connection (separate device) that fires the same store actions (`manualReset`, future `incrementMileage`, `markCheck`). The phone remote implementation is a direct preview of the ESP32 input handler.

Target remote for first validation: the BT shutter / media remote family (AB Shutter 3, Satechi) that the CheckPoint Two community has already validated. These present as HID keyboard or AVRCP and don't speak a documented GATT service — scan by device name pattern or require manual pairing. Document which one ships first.

---

### Priority 4a — Auto-reset detection (unit-testable, no device needed)

The current store logic keys off proximity to segment start, which can be skipped between BLE updates:

```ts
const justCrossedReset =
  currentSeg?.isReset &&
  position.distanceInSegment < 0.05 &&
  position.segmentIndex !== get().segmentIndex;
```

At 30 mph the bike travels ~0.05 miles in ~6 seconds. If two BLE notifications bracket the segment boundary and the second one lands more than 0.05 miles past it, the reset is silently dropped.

**Fix:** This is pure engine logic — a boundary-crossing detector, not a proximity detector. Track `prevSegmentIndex` in the store. On every `updateDistance`, if `segmentIndex > prevSegmentIndex`, walk the segments that were crossed and apply any reset that appeared in that range, regardless of current `distanceInSegment`. Fully testable with constructed inputs against the pace engine; no device required.

---

### Priority 4b — iOS BLE backgrounding (field test, device required)

`react-native-ble-plx` uses Core Bluetooth's `bluetooth-central` background mode. When the app goes to background, Core Bluetooth continues delivering notifications but with coalesced timing — batched with stale timestamps rather than real-time. If iOS suspends the JS runtime, the reconnect logic in `ble-manager.ts` may not execute on schedule.

This is not a Phase 2 discovery item. It directly affects whether the phone app is trustworthy in a race scenario and needs to be tested on real hardware before riding:

- Add `bluetooth-central` background mode to `app.json` / `Info.plist`
- Test: connect sensor, lock phone, ride for 5 minutes, disconnect and reconnect sensor mid-ride — confirm SENSOR LOST fires and reconnect completes without the app in foreground
- Test: lock phone in a pocket, confirm `raw_csc_log` entries accumulate at the expected ~1 Hz rate (not coalesced into large gaps)
- If coalescing is a problem, the fix is to use `wall_clock_ms` at receipt for elapsed-time calculation rather than BLE event timestamps — but measure first, don't assume

These are separate tasks from 4a. 4a can be closed with a unit test. 4b can only be closed with a field test. Bundling them tends to mean 4b gets deferred under cover of 4a being done.

---

## Phone ↔ ESP32 BLE boundary (sketch)

The ESP32 exposes a custom GATT service. The phone connects as central during setup and post-ride; the ESP32 connects to the speed sensor as central during the ride.

**Service: Enduro Companion (`custom UUID`)**

| Characteristic | Direction | Content |
|---|---|---|
| `ROUTE_SHEET` | Phone → ESP32 (write) | Route segments as packed binary: for each segment, `[distance_m u16][speed_tenths u16][flags u8][label_len u8][label utf8]`. ESP32 stores in flash. |
| `RIDE_LOG` | ESP32 → Phone (notify + read) | Raw CSC log rows streamed after ride ends: `[wall_clock_ms u32][cumulative_revs u32][wheel_event_time u16]` per row, 10 bytes each. Phone reassembles into `csc_raw_log`. |
| `DEVICE_STATUS` | ESP32 → Phone (notify) | Sensor connected/lost, battery level, current deviation (for companion glance). |
| `CONTROL` | Phone → ESP32 (write) | Start ride, end ride, manual reset, set wheel circumference. |

**Schema mapping:**

The current SQLite schema maps cleanly to this boundary with one note:

- `routes` / `route_segments` → serialized and written to `ROUTE_SHEET`. The `sort_order` column determines transmission order. The `published_id` column is phone-only and not transmitted.
- `rides` → created on the phone when a ride is started via `CONTROL`. `sensor_id` stores the ESP32's device ID rather than the speed sensor ID (the speed sensor is invisible to the phone once the ESP32 is in the loop).
- `csc_raw_log` → populated by streaming `RIDE_LOG` back after the ride. This is why the raw log table needs to exist on the phone: it's the post-ride pull target.
- `ride_log` (derived) → computed on the phone from `csc_raw_log` after transfer, using the same `pace-engine.ts` functions. This is the cross-validation step: run the TS engine over the raw log and compare to what the C firmware computed in real time.

One thing that fights this: `deviation_seconds` in `ride_log` is currently computed live by the phone during a phone-only ride and stored directly. In the ESP32 path, the phone recomputes it post-hoc from the raw log. These two paths need to produce identical results — which they will, because both call the same pure engine functions. But the schema needs to be clear that `ride_log` is always derived, never authoritative. Consider adding a `source` column (`'live'` vs `'replay'`) to make this explicit.

---

## Phase structure (revised)

### Phase 1 — Phone demo (current focus)

Goal: a working app you can ride with that produces trustworthy numbers and a raw log for firmware validation.

- [x] Pace engine + unit tests
- [x] CSC parser + unit tests
- [x] BLE manager with reconnect
- [x] SQLite schema (routes, segments, rides, ride_log)
- [x] All four screens (library, pre-ride, live, post-ride)
- [ ] **Raw CSC log table (`raw_csc_log`) + capture in BLE manager** ← Priority 1
- [ ] **Replay harness (`src/engine/replay.ts`) + snapshot test** ← Priority 1
- [ ] **Speed sanity clamp in CSC parser (power-cycle vs. rollover)** ← Priority 2
- [ ] **Auto-reset: boundary-crossing detector** ← Priority 4a (unit test, no device)
- [ ] **iOS BLE backgrounding — prototype and field test** ← Priority 4b (device required)
- [ ] EAS build, TestFlight, ride with it

### Phase 2 — Phone companion solidified

- [ ] Handlebar BLE remote (HID/AVRCP, primary input path proven)
- [ ] Route sharing (search, publish, AirDrop local share)
- [ ] CSV route import
- [ ] Audio cues to Bluetooth speakers
- [ ] Keep-awake + screen brightness management
- [ ] Transfer section time allowances (vs. fully free)

### Phase 3 — ESP32 bring-up

- [ ] ESP32 + Sharp Memory LCD hardware selection and board bringup
- [ ] C port of pace engine, validated against TS unit test vectors
- [ ] C CSC parser, validated against TS unit test vectors
- [ ] Custom GATT service (ROUTE_SHEET, RIDE_LOG, DEVICE_STATUS, CONTROL)
- [ ] Phone companion BLE connection to ESP32
- [ ] Route push (phone → device)
- [ ] Ride log pull (device → phone), post-hoc replay validation

### Phase 4 — Hardware polish

- [ ] Custom enclosure / handlebar mount
- [ ] Waterproofing
- [ ] Apple Watch companion (glance-readable deviation)
- [ ] Per-event season history
- [ ] Route sharing moat (the ICO InstaRace answer)

---

## Open questions (first-class, not deferred)

1. **Which BLE remote ships first.** AB Shutter 3 is cheap and documented; get one in hand and characterize its GATT profile before writing the remote handler. The HID vs. AVRCP distinction changes the connection approach significantly.

2. **iOS backgrounding behavior.** Prototype this before riding with the app. See Priority 4 above.

3. **ESP32 hardware selection.** ESP32-S3 preferred (more RAM, USB, BLE 5.0). Sharp Memory LCD model depends on enclosure size. This is a Phase 3 decision but the SPI wiring affects PCB layout early.

4. **Route sheet serialization format for BLE transfer.** The packed binary sketch above is fine for a start but needs a version byte and a checksum. Define before implementing ROUTE_SHEET characteristic.
