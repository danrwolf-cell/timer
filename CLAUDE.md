@AGENTS.md

# Enduro Companion — Claude Code context

## What this app is

A time-distance riding companion for enduro MX. The rider follows a route sheet of timed segments; the app tracks cumulative distance via a BLE CSC (Cycling Speed and Cadence) speed sensor on the front wheel hub and displays live deviation from the ideal key time.

**The phone app is the demo and validation harness, not the final product.** The live-ride product is an ESP32 + Sharp Memory LCD handlebar unit (always-on, no battery anxiety, sunlight-readable). The phone becomes a companion: route entry, library, BLE push/pull to the device, and post-ride analytics.

---

## Golden-reference constraint

`src/engine/pace-engine.ts`, `src/engine/csc-parser.ts`, and `src/engine/free-territory.ts` are **pure functions with zero platform dependencies**. Keep them that way permanently. The C firmware on the ESP32 is validated against the TypeScript unit tests — same inputs, same outputs. Never add side effects, timers, React Native imports, or I/O to these files.

---

## File map

| File | Role |
|---|---|
| `src/engine/pace-engine.ts` | Core math: `detectSegment`, `computeKeyTime`, `computeDeviation`, `crossedReset`. Golden reference. |
| `src/engine/free-territory.ts` | AMA free-territory rules: calibration zone, after-check, before/after gas. Pure. No UI yet. |
| `src/engine/replay.ts` | Post-ride replay: feeds `raw_csc_log` rows through parser + engine → deviation-over-distance. |
| `src/ble/csc-parser.ts` | Decodes CSC GATT characteristic 0x2A5B. Distinguishes power-cycle from genuine 32-bit rollover. Golden reference. |
| `src/ble/ble-manager.ts` | Singleton `EnduroBleManager` (`bleMgr`). Manages BLE scan, connect, reconnect, raw CSC capture. |
| `src/ble/use-ble-sensor.ts` | React hook wrapping `bleMgr`. |
| `src/store/ride-store.ts` | Zustand store: live ride state, `updateDistance`, `manualReset`, `crossedReset` integration. |
| `src/db/schema.ts` | SQLite schema + additive PRAGMA-guarded migrations. Tables: `routes`, `route_segments`, `rides`, `ride_log`, `raw_csc_log`. |
| `src/db/queries.ts` | Typed query helpers. `getRouteRules()` returns `FtRules` with AMA fallbacks. `ride_log.source`: `'live'`\|`'replay'`. |
| `src/screens/RouteLibraryScreen.tsx` | Route list + modal sheet builder. |
| `src/screens/PreRideScreen.tsx` | 4-step pre-ride flow: route confirm → sensor scan → circumference → GO. |
| `src/screens/LiveRideScreen.tsx` | Live ride display. Intentionally lean — demo only, not polished. |
| `src/screens/PostRideScreen.tsx` | Hand-rolled SVG deviation chart, stat boxes. |
| `docs/BUILD-PLAN.md` | Authoritative product strategy, phase structure, and priority queue. Read this before planning any work. |

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

**Tests: 84/84 passing** (run `npx jest` to verify).

Phase 1 priorities complete:
- [x] Raw CSC log capture (`raw_csc_log` table + BLE manager queue)
- [x] Replay harness (`src/engine/replay.ts`) — snapshot-tested
- [x] Speed sanity clamp / power-cycle vs. rollover (`csc-parser.ts`)
- [x] Auto-reset boundary-crossing detector (`crossedReset` in `pace-engine.ts`)
- [x] Free-territory engine (`free-territory.ts`) — pure, fully tested, no UI yet
- [x] iOS/Android BLE permissions in `app.json` (bundle ID: `com.danwolf.enduro`)

Remaining Phase 1:
- [ ] iOS BLE backgrounding — `bluetooth-central` background mode is set in `app.json`; needs field test on real device (sensor disconnect/reconnect with screen locked, verify `raw_csc_log` accumulates at ~1 Hz)
- [ ] EAS build, TestFlight, ride with it

---

## Branch / PR convention

Development branch: `claude/build-planning-czfjir`. Main branch exists on GitHub. PR against `main` when a phase or priority block is complete.

---

## What NOT to do

- Do not add side effects, timers, or RN imports to `pace-engine.ts`, `csc-parser.ts`, or `free-territory.ts`
- Do not polish the live-ride screen (animation, haptics, gesture refinements) — it's a demo harness; polish waits until the ESP32 path is proven
- Do not drop or rename SQLite columns — additive migrations only
- Do not add the `bluetooth-central` background mode again — it's already in `app.json`
- Do not run `playwright install` — Chromium is pre-installed at `/opt/pw-browsers`
