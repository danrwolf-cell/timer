# Enduro Companion firmware — Feather nRF52840 Express

Prototype handlebar unit: Adafruit Feather nRF52840 Express + Adafruit 4694
Sharp Memory LCD breakout (2.7", 400×240). Wiring: see `docs/HARDWARE.md`.

The sketch is plumbing only — BLE callbacks, display, flash persistence. All
pace math and protocol decoding lives in `firmware/core` (pure C, validated
against the TypeScript golden reference by `firmware/test`). If you change
anything in `firmware/core`, run `make -C firmware/test` first.

## Build (arduino-cli)

```sh
# One-time setup
arduino-cli config init
arduino-cli config add board_manager.additional_urls \
  https://adafruit.github.io/arduino-board-index/package_adafruit_index.json
arduino-cli core update-index
arduino-cli core install adafruit:nrf52
pip3 install adafruit-nrfutil          # required by the nRF52 core for packaging/upload

# Libraries (Bluefruit, LittleFS, InternalFileSystem ship with the core)
arduino-cli lib install "Adafruit GFX Library" "Adafruit SHARP Memory Display"

# Compile — the EnduroCore golden-reference library is pulled in via --library
cd firmware
arduino-cli compile \
  --fqbn adafruit:nrf52:feather52840 \
  --library core \
  enduro-feather

# Flash (double-tap the Feather's reset button if the port doesn't appear)
arduino-cli upload --fqbn adafruit:nrf52:feather52840 -p /dev/ttyACM0 enduro-feather
```

Arduino IDE works too: add the Adafruit board index URL in Preferences,
install "Adafruit nRF52" boards + the two display libraries, then symlink or
copy `firmware/core` into your sketchbook `libraries/` folder as `EnduroCore`.

## What it does

- **Central → speed sensor**: scans for the CSC service (0x1816), connects to
  the first sensor found, subscribes to 0x2A5B. Auto-rescans on disconnect.
  Every notification while riding is captured raw (including null-update
  edge cases), same as the phone's `ble-manager.ts`.
- **Peripheral → phone**: advertises as `Enduro-XXXX` with the custom service
  from `docs/BLE-PROTOCOL.md`. The phone pushes route sheets (persisted to
  internal flash, survives power cycles), sends control commands
  (start/end ride, manual reset, wheel circumference), receives a 1 Hz
  status notification, and pulls the ride log after the ride.
- **Display**: 2 Hz refresh. Hero deviation number (signed seconds, m:ss
  above a minute), ON TIME state, segment index/label, FREE indicator,
  RESET flash on crossing a reset checkpoint, speed + distance footer,
  sensor + battery status header.

## Prototype limitations (deliberate)

- **Ride log is RAM-only**: ~2 h at 1 Hz (7200 rows). It survives END_RIDE
  but not a power cycle — pull the log from the phone before switching off.
  QSPI flash persistence is the upgrade path once the BLE pull is proven.
- **Reset semantics match the phone**: crossing a reset checkpoint flashes
  RESET and the deviation continues from full key time (no re-anchoring).
  Re-anchoring is a Phase 2 decision that must change the TS golden
  reference first, then this firmware.
- **No device-side buttons yet**: the phone is the only input. The planned
  handlebar remote lands as a second central connection later.
