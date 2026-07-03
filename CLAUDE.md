@AGENTS.md

# Enduro Companion — Claude Code context

## What this app is

A time-distance riding companion for enduro MX. The rider follows a route sheet of timed segments; the app tracks cumulative distance via a BLE CSC (Cycling Speed and Cadence) speed sensor on the front wheel hub and displays live deviation from the ideal key time.

**The phone app is the demo and validation harness, not the final product.** The live-ride product is a handlebar unit — **Adafruit Feather nRF52840 Express + Adafruit 4694 Sharp Memory LCD** (400×240, always-on, sunlight-readable). Parts are in hand; firmware lives in `firmware/`. The phone is the companion: route entry, library, BLE push/pull to the device, and post-ride analytics.

---

## Golden-reference constraint

`src/engine/pace-engine.ts`, `src/ble/csc-parser.ts`, `src/engine/free-territory.ts`, and `src/ble/device-protocol.ts` are **pure functions with zero platform dependencies**. Keep them that way permanently. The C firmware core (`firmware/core`) is validated against vectors generated from these TS modules — same inputs, same outputs. Never add side effects, timers, React Native imports, or I/O to these files.

If you change a golden-reference TS module: `make -C firmware/test vectors && make -C firmware/test`. If you change `firmware/core`: `make -C firmware/test` before committing.

---

## File map

| File | Role |
|---|---|
| `src/engine/pace-engine.ts` | Core math: `detectSegment`, `computeKeyTime`, `computeDeviation`, `crossedReset`. Golden reference. |
| `src/engine/free-territory.ts` | AMA free-territory rules: calibration zone, after-check, before/after gas. Pure. No UI yet. |
| `src/engine/replay.ts` | Post-ride replay: feeds `raw_csc_log` rows through parser + engine → deviation-over-distance. |
| `src/ble/csc-parser.ts` | Decodes CSC GATT characteristic 0x2A5B. Distinguishes power-cycle from genuine 32-bit rollover. Golden reference. |
| `src/ble/ble-instance.ts` | The single shared native `BleManager` instance. |
| `src/ble/ble-manager.ts` | Singleton `EnduroBleManager` (`bleMgr`). Manages BLE scan, connect, reconnect, raw CSC capture. |
| `src/ble/use-ble-sensor.ts` | React hook wrapping `bleMgr`. |
| `src/ble/device-protocol.ts` | Pure codec for the handlebar-unit protocol (pack/parse, CRC-16, `RideLogAssembler`). Golden reference. |
| `src/ble/device-manager.ts` | Singleton `EnduroDeviceManager` (`deviceMgr`). Phone↔device: route push, control, status, ride log pull. |
| `src/ble/use-enduro-device.ts` | React hook wrapping `deviceMgr` + `device-store`. |
| `src/store/ride-store.ts` | Zustand store: live ride state, `updateDistance`, `manualReset`, `crossedReset` integration. |
| `src/store/device-store.ts` | Zustand store: device connection state, live `DeviceStatus`, transfer progress. |
| `src/db/import-ride.ts` | Pulled device log → `raw_csc_log` → replay → `ride_log` (`source: 'replay'`). |
| `src/db/schema.ts` | SQLite schema + additive PRAGMA-guarded migrations. Tables: `routes`, `route_segments`, `rides`, `ride_log`, `raw_csc_log`. |
| `src/db/queries.ts` | Typed query helpers. `getRouteRules()` returns `FtRules` with AMA fallbacks. `ride_log.source`: `'live'`\|`'replay'`. |
| `src/screens/RouteLibraryScreen.tsx` | Route list + modal sheet builder. |
| `src/screens/PreRideScreen.tsx` | 4-step pre-ride flow: route confirm → sensor scan → circumference → GO. |
| `src/screens/LiveRideScreen.tsx` | Live ride display. Intentionally lean — demo only, not polished. |
| `src/screens/PostRideScreen.tsx` | Hand-rolled SVG deviation chart, stat boxes. |
| `src/screens/DeviceScreen.tsx` | Handlebar-unit companion: connect, push route, drive ride, pull log. Lean. |
| `firmware/core/` | Pure C golden-reference port: `pace_engine`, `csc_parser`, `route_sheet` codec. Doubles as Arduino library `EnduroCore`. |
| `firmware/test/` | Vector generator (TS → `vectors.h`) + host C test runner. `make` runs it; `make vectors` regenerates. |
| `firmware/enduro-feather/` | Arduino sketch for the Feather nRF52840: display, dual-role BLE, flash persistence. |
| `docs/BUILD-PLAN.md` | Authoritative product strategy, phase structure, and priority queue. Read this before planning any work. |
| `docs/BLE-PROTOCOL.md` | Wire format phone↔device (v1): UUIDs, framing, CRC. Change TS+C codecs together. |
| `docs/HARDWARE.md` | Wiring (5 jumpers), flashing, bring-up checklist for the physical prototype. |

---

## Key formulas and constants

- **Key time**: `(distanceMi / speedMph) * 3600` → seconds
- **Deviation**: `elapsedSeconds - keyTimeSeconds` (positive = late, negative = early)
- **Default wheel circumference**: 2183 mm (90/90-21 enduro MX front wheel, M59 tire)
- **Power-cycle vs. rollover**: negative `deltaRevs` — if `prev.cumulativeRevolutions >= 0xFF000000` it's a genuine 32-bit rollover; otherwise it's a power-cycle and state is re-baselined with no update emitted
- **Speed ceiling**: 150 mph backstop after rollover correction
- **Auto-reset**: `crossedReset(segments, prevIndex, currentIndex)` walks every segment entered since last update; fires if any has `isReset: true`

---

## Database schema (current)

- `routes` — id, name, has_secret_checks, ft_miles_after_check, ft_miles_before_gas, ft_miles_after_gas, ft_calibration_mile
- `route_segments` — id, route_id, sort_order, distance_mi, speed_mph, is_free, is_reset, label, check_type
- `rides` — id, route_id, started_at, ended_at, wheel_circumference_mm, sensor_id
- `ride_log` — id, ride_id, wall_clock_ms, cumulative_distance_mi, deviation_seconds, speed_mph, segment_index, source ('live'|'replay')
- `raw_csc_log` — id, ride_id, wall_clock_ms, cumulative_revs, wheel_event_time

All schema changes must use additive PRAGMA-guarded ALTER TABLE migrations (see `migrateAddColumn` in `schema.ts`). Never drop or rename columns.

---

## Current state

**Tests: 109/109 passing** (`npx jest`). **Firmware host suite: 1418 checks** (`make -C firmware/test`).

Phase 1 priorities complete:
- [x] Raw CSC log capture (`raw_csc_log` table + BLE manager queue)
- [x] Replay harness (`src/engine/replay.ts`) — snapshot-tested
- [x] Speed sanity clamp / power-cycle vs. rollover (`csc-parser.ts`)
- [x] Auto-reset boundary-crossing detector (`crossedReset` in `pace-engine.ts`)
- [x] Free-territory engine (`free-territory.ts`) — pure, fully tested, no UI yet
- [x] iOS/Android BLE permissions in `app.json` (bundle ID: `com.danwolf.enduro`)

Phase 3 (device bring-up) — code complete, hardware validation pending:
- [x] C golden-reference port (`firmware/core`) validated against TS vectors
- [x] BLE device protocol v1 (`docs/BLE-PROTOCOL.md`) — TS + C codecs cross-validated
- [x] Feather nRF52840 firmware sketch (`firmware/enduro-feather`)
- [x] Phone companion: DeviceScreen, route push, ride log pull → replay import
- [ ] Physical bring-up: wire + flash + run the `docs/HARDWARE.md` checklist (device required)
- [ ] Field cross-validation: live-displayed deviation vs. phone replay of the pulled log

Remaining Phase 1:
- [ ] iOS BLE backgrounding — `bluetooth-central` background mode is set in `app.json`; needs field test on real device (sensor disconnect/reconnect with screen locked, verify `raw_csc_log` accumulates at ~1 Hz)
- [ ] EAS build, TestFlight, ride with it

---

## Branch / PR convention

Development branch: `claude/hardware-prototype-mobile-app-zhwolc`. Main branch exists on GitHub. PR against `main` when a phase or priority block is complete.

---

## What NOT to do

- Do not add side effects, timers, or RN imports to `pace-engine.ts`, `csc-parser.ts`, `free-territory.ts`, or `device-protocol.ts`
- Do not edit `firmware/test/vectors.h` by hand — it is generated (`make -C firmware/test vectors`)
- Do not change the BLE wire format in only one place — `docs/BLE-PROTOCOL.md`, `device-protocol.ts`, and `firmware/core/route_sheet.c` move together
- Do not polish the live-ride screen (animation, haptics, gesture refinements) — it's a demo harness; polish waits until the hardware path is proven
- Do not drop or rename SQLite columns — additive migrations only
- Do not add the `bluetooth-central` background mode again — it's already in `app.json`
- Do not run `playwright install` — Chromium is pre-installed at `/opt/pw-browsers`
