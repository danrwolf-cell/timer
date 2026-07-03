# Enduro Companion: Build Plan

> Supersedes the original `enduro-app-plan.md` where hardware strategy is concerned.
> Code decisions already made and committed are noted as decided — they are not open.

---

## Product strategy

The phone app is the demo and the on-ramp, not the final product.

The live ride ultimately runs on a dedicated **nRF52840 + Sharp Memory LCD** handlebar unit: always-on, no battery anxiety, no lock-screen, no OS interruptions, readable in direct sun, survives mud. The phone becomes a companion: route-sheet entry, library and sharing, post-ride analytics, pushing sheets to the device over BLE and pulling back the ride log.

> **Hardware decision (July 2026, parts in hand):** the prototype MCU is the
> **Adafruit Feather nRF52840 Express**, not the ESP32-S3 originally sketched.
> The workload is BLE-first (dual-role: central to the sensor, peripheral to
> the phone) and the nRF52840 is the stronger BLE part: mature Bluefruit
> dual-role support, far better battery behavior, built-in LiPo charging on
> the Feather. Nothing product-level is lost — the golden-reference C core is
> platform-independent either way. The display is the **Adafruit 4694**
> breakout (LS027B7DH01, 2.7", 400×240) with onboard boost + level shifting.
> Wiring and bring-up: `docs/HARDWARE.md`.

The Sharp Memory LCD is specifically chosen over e-ink because refresh is fast enough for a live number that changes every second. E-ink is not suitable.

This strategy has two practical consequences for how the phone code is written right now:

1. **The engine and parser are the golden reference.** `pace-engine.ts` and `csc-parser.ts` are pure functions with no platform dependencies. They stay that way permanently. The C firmware gets validated against the TypeScript unit tests — same inputs, same outputs. Do not add side effects, timers, or RN imports to these files. *(Implemented: `firmware/core` is the C port; `firmware/test` generates vectors from the TS modules and validates the port host-side — `make -C firmware/test`.)*

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

Tests: 109/109 passing (`npx jest`), plus the firmware host-side vector suite
(`make -C firmware/test`, 1418 checks) validating the C port against the TS
golden reference.

| File | Status |
|---|---|
| `src/engine/pace-engine.ts` | Decided. Pure functions. Formula uses `* 3600` (seconds). `crossedReset()` added — boundary-crossing detector, Priority 4a done. |
| `src/engine/free-territory.ts` | **New.** Pure module. Free-territory/secret-check planning: AMA-traditional rules, `freeTerritory`, `checkableTerritory`, `freeTerritoryAt`, `mergeIntervals`. No UI surface yet — see Phase 2. |
| `src/engine/replay.ts` | **New.** Replay harness: feeds `raw_csc_log` rows through parser + engine, produces deviation-over-distance. Snapshot-tested. Priority 1 done. |
| `src/ble/csc-parser.ts` | Decided. Power-cycle vs. genuine 32-bit rollover distinguished by previous counter value. 150 mph speed ceiling backstop. Priority 2 done. |
| `src/ble/ble-manager.ts` | Working. Captures decoded CSC pair to `raw_csc_log` unconditionally (including null-update cases). iOS backgrounding untested — see Priority 4b. |
| `src/store/ride-store.ts` | Working. Auto-reset now uses `crossedReset()` — boundary-crossing detector. Priority 4a done. |
| `src/db/schema.ts` | Working. `raw_csc_log` table added. Additive migrations for `check_type`, `has_secret_checks`, and FT rule columns via PRAGMA-guarded ALTERs. |
| `src/db/queries.ts` | Working. `check_type` in read/write. `getRouteRules()` returns `FtRules` with per-column AMA fallbacks. `ride_log.source` column (`'live'`\|`'replay'`) distinguishes live-computed from post-hoc replay. |
| All four screens | Working shell. Phone live-screen intentionally lean per above. |

---

## Near-term priorities (ordered)

### Priority 1 — Raw CSC log + replay harness ✅ DONE

`raw_csc_log` table captures decoded `(cumulative_revs, wheel_event_time, wall_clock_ms)` per BLE notification, unconditionally — null-update cases included. Batched queue flushes at 50 rows or 10s. `ride_log` gains a `source` column (`'live'`|`'replay'`). `src/engine/replay.ts` feeds `raw_csc_log` rows through the parser and pace engine, produces deviation-over-distance. Snapshot-tested with a synthetic corpus covering free sections, resets, and a mid-ride power-cycle.

---

### Priority 2 — Speed sanity clamp / power-cycle vs. rollover ✅ DONE

Both a genuine 32-bit rollover and a sensor power-cycle present as negative `deltaRevs`. Distinguished by where the **previous** counter was: if `prev.cumulativeRevolutions >= 0xFF000000`, it was near the 32-bit max and the rollover is genuine; otherwise it's a power-cycle. Power-cycle re-baselines `cscState` and emits no update. 150 mph speed ceiling as final backstop. Four test cases covering both failure modes and recovery.

---

### Priority 3 — Handlebar BLE remote

**Decision: Priority 2 item on phone, primary input on ESP32.**

Rationale: the phone live-screen is a demo. Getting through one real ride using the touch RESET button is acceptable for validation purposes. However, there is a real risk in validating a touch-driven live screen for too long — you end up optimizing a UI model that gets thrown away when the ESP32 takes over.

Mitigation: keep touch interaction minimal and functional (it already is). Do not add gesture refinements or multi-tap shortcuts to the phone live-screen. When the remote lands, it lands as a second `BleManager` connection (separate device) that fires the same store actions (`manualReset`, future `incrementMileage`, `markCheck`). The phone remote implementation is a direct preview of the ESP32 input handler.

Target remote for first validation: the BT shutter / media remote family (AB Shutter 3, Satechi) that the CheckPoint Two community has already validated. These present as HID keyboard or AVRCP and don't speak a documented GATT service — scan by device name pattern or require manual pairing. Document which one ships first.

---

### Priority 4a — Auto-reset detection ✅ DONE

`crossedReset(segments, prevSegmentIndex, currentSegmentIndex)` is a pure function in `pace-engine.ts`. Walks every segment entered since the last update (`prevSegmentIndex+1` through `currentSegmentIndex` inclusive); returns true if any has `isReset`. The store reads `segmentIndex` from state before recomputing, passes it as `prevSegmentIndex`, and replaces the old proximity check with a call to `crossedReset`. Cannot miss a reset that was bracketed between two BLE notifications, or one that was skipped past in a large single update. Nine unit tests covering all crossing cases.

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

## Phone ↔ device BLE boundary

**Status: defined and implemented on both sides.** The authoritative wire
format lives in `docs/BLE-PROTOCOL.md` (version byte + CRC-16, chunked
route-sheet transfer, seq/CRC-verified ride-log stream) with matching codecs
in `src/ble/device-protocol.ts` (TS, unit-tested) and
`firmware/core/route_sheet.c` (C, byte-validated against TS vectors). The
sketch below is the original design note.

The device exposes a custom GATT service. The phone connects as central during setup and post-ride; the device connects to the speed sensor as central during the ride.

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
- [x] **Raw CSC log table (`raw_csc_log`) + capture in BLE manager** ← Priority 1
- [x] **Replay harness (`src/engine/replay.ts`) + snapshot test** ← Priority 1
- [x] **Speed sanity clamp in CSC parser (power-cycle vs. rollover)** ← Priority 2
- [x] **Auto-reset: boundary-crossing detector** ← Priority 4a (unit test, no device)
- [ ] **iOS BLE backgrounding — prototype and field test** ← Priority 4b (device required)
- [ ] EAS build, TestFlight, ride with it

### Phase 2 — Phone companion solidified

- [ ] Handlebar BLE remote (HID/AVRCP, primary input path proven)
- [ ] Route sharing (search, publish, AirDrop local share)
- [ ] CSV route import
- [ ] Audio cues to Bluetooth speakers
- [ ] Keep-awake + screen brightness management
- [ ] Transfer section time allowances (vs. fully free)
- [ ] Free-territory UI: zone overlay in route builder, live "check possible" state on live screen (`free-territory.ts` is built and fully tested — no UI surface yet)

### Phase 3 — Device bring-up (Feather nRF52840)

- [x] Hardware selection: Feather nRF52840 Express + Adafruit 4694 (parts in hand; see `docs/HARDWARE.md`)
- [x] C port of pace engine, validated against TS unit test vectors (`firmware/core/pace_engine.c`)
- [x] C CSC parser, validated against TS unit test vectors (`firmware/core/csc_parser.c`)
- [x] Custom GATT service (ROUTE_SHEET, RIDE_LOG, DEVICE_STATUS, CONTROL) — `docs/BLE-PROTOCOL.md`, both codecs cross-validated
- [x] Firmware sketch: display renderer, dual-role BLE, flash route persistence, RAM ride log (`firmware/enduro-feather`)
- [x] Phone companion BLE connection to the device (`src/ble/device-manager.ts`, DeviceScreen)
- [x] Route push (phone → device)
- [x] Ride log pull (device → phone) → raw_csc_log → replay validation path
- [ ] Board bring-up on the physical hardware (flash, wire, run the `docs/HARDWARE.md` checklist) ← **you are here**
- [ ] Field cross-validation: ride, pull the log, compare live-displayed deviation to phone replay
- [ ] Sharp Memory LCD draw spec round 2: per-check DQ states with max_late_seconds, time-format polish (current renderer is functional)
- [ ] Ride log to QSPI flash (survives power-off; RAM-only today, ~2 h at 1 Hz)

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

3. ~~**ESP32 hardware selection.**~~ **Resolved:** Feather nRF52840 Express + Adafruit 4694 (2.7" 400×240). See the hardware decision note at the top and `docs/HARDWARE.md`.

4. ~~**Route sheet serialization format for BLE transfer.**~~ **Resolved:** `docs/BLE-PROTOCOL.md` — version byte, CRC-16/CCITT-FALSE, chunked transfer framing, implemented and cross-validated in TS and C.

5. **Reset semantics.** Both the phone store and the firmware zero the displayed deviation for the update that crosses a reset checkpoint, then resume computing from full key time — there is no re-anchoring. If a reset should re-anchor the key time, that change must land in the TS golden reference (and its tests) first, then propagate to the C port via regenerated vectors.
