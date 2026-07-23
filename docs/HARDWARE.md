# Hardware prototype — wiring and bring-up

Parts (the DigiKey order):

- **Adafruit Feather nRF52840 Express** — MCU + BLE. Replaces the ESP32-S3
  from the original plan; see BUILD-PLAN.md for the rationale.
- **Adafruit 4694** — SHARP Memory Display breakout, 2.7", 400×240
  (LS027B7DH01). Onboard 5 V boost and level shifting: safe to drive from
  the Feather's 3.3 V logic and 3 V rail directly.
- Breadboard + female-female jumper wires.

## Wiring

Five wires. The 4694 breakout's EXTMODE / DISP / EXTCOMIN pins stay
unconnected — the board defaults leave the display enabled with software
VCOM, which the Adafruit_SharpMem library toggles on every refresh.

| 4694 breakout | Feather nRF52840 | Purpose |
|---|---|---|
| VIN | 3V | Power (onboard boost makes the panel's 5 V) |
| GND | GND | Ground |
| SCLK | SCK | SPI clock |
| DI | MO | SPI data |
| CS | 5 | Chip select (`SHARP_CS_PIN` in the sketch) |

Notes:

- The Feather nRF52840 Express silkscreens its digital pins as bare numbers
  (`5`, `6`, `9`, `10`, `11`, `12`, `13`) — there's no "D" prefix printed on
  the board, unlike some other Arduino-family boards. Pin `5` sits on the
  header row with SCK/MOSI/MISO/RX/TX, opposite the battery/EN side. If you
  don't see a pad labeled `5` there, tell me what labels you *do* see on
  that row and I'll adjust — you may have the Sense variant, which reuses
  some pins for onboard sensors.
- Both boards ship with headers loose in the bag — solder them on before
  breadboarding. Female-female jumpers can also go pin-to-pin without the
  breadboard once headers are on.
- The display is write-only (no MISO line).
- USB powers the prototype. The Feather's JST connector takes a 3.7 V LiPo
  later; the sketch already reports battery percentage when one is attached.

## Flash the firmware

Follow `firmware/enduro-feather/README.md` (arduino-cli or Arduino IDE).
If the serial port doesn't appear for upload, double-tap the Feather's
reset button to enter the UF2 bootloader.

## Bring-up checklist

1. **Display**: on boot the panel shows `NO ROUTE` with the sensor status
   header. If it's blank, check CS on pin `5` and that VIN is on 3V (not EN).
2. **Phone → device**: open a route in the app → DEVICE → Scan for Device.
   It appears as `Enduro-XXXX`. Push the route; the display switches to
   `READY` with the segment count.
3. **Sensor → device**: wake the CSC hub sensor (spin the wheel). The
   header changes to `SENSOR OK` without any pairing step.
4. **Ride**: START RIDE from the phone. Spin the wheel — distance and the
   hero deviation number move. Cross a reset boundary to see the RESET flash.
5. **Cross-validation** (the point of the prototype): END RIDE, then PULL
   RIDE LOG. The phone replays the raw log through the TypeScript engine
   and shows the deviation chart. The numbers the panel displayed live and
   the chart's values at the same timestamps must agree — both sides run
   the same golden-reference math, so any disagreement is a bug.
6. **Power-cycle robustness**: mid-ride, power the sensor off and on.
   The display should show `SENSOR LOST`, reconnect by itself, and distance
   must continue without a jump (power-cycle re-baseline, not a rollover).

## Known prototype limits

- Ride log is RAM-only (~2 h at 1 Hz): pull it before powering off.
- No buttons on the unit yet — the phone is the remote. The handlebar
  remote (Priority 3) arrives as a second central connection later.
- The panel is unmounted bare electronics: keep it dry; enclosure is
  Phase 4.

## Bring-up findings (first unit, July 2026)

Three real software bugs were found and fixed in `enduro-feather.ino`
during first bring-up, all specific to this board's Adafruit nRF52 BSP
(1.7.0) — isolated by progressively halting execution at different points
and reading the result off the bistable Sharp display, since the Arduino
IDE serial monitor was unreliable throughout:

1. `Adafruit_GFX::getTextBounds()` hard-faults on this board. `drawCentered()`
   now computes text width directly from the built-in font's fixed 6×8
   glyph cell instead of calling it.
2. `analogReference(AR_INTERNAL_3_0)` hard-faults. `readBatteryPct()` uses
   the ADC's default reference/resolution instead of switching them.
3. Calling a function containing a local `File` object hard-faults on this
   board — even along a code path that never actually constructs one (e.g.
   an early return). Route persistence is inlined directly in `setup()`
   and `loop()` rather than factored into `loadPersistedRoute()`/
   `persistRoute()` functions.
4. `InternalFS.begin()` must run *after* `Bluefruit.begin()`, not before —
   calling it first hard-faults once the SoftDevice touches flash.

**Unresolved hardware defect:** BLE central role fails to initialize on
this specific board — confirmed with the stock, unmodified
`Adafruit Bluefruit nRF52 Libraries → Central → central_hrm` example,
which crashes identically. Peripheral role works fine (confirmed with the
stock `bleuart` example and in our own sketch). Reflashing the
bootloader+SoftDevice combo (both the latest GitHub release and the
BSP-bundled version, both S140 6.1.1) did not fix it. Central role is
required for this product (connects to the CSC speed sensor as a BLE
central), so this unit cannot complete bring-up as-is — treat as a
defective unit; a replacement board should not hit this since it's
isolated to BLE central specifically, not any of the four software bugs
above (those are BSP-wide and will need to be reapplied/kept as-is on a
new board with the same BSP version).
