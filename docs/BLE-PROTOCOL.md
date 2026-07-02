# Enduro Companion BLE protocol (v1)

The handlebar unit (Adafruit Feather nRF52840 Express) exposes a custom GATT
service. The phone connects as central during setup and post-ride; the device
connects to the CSC speed sensor as central during the ride.

Both ends implement this format from a shared pure module:

- Phone: `src/ble/device-protocol.ts` (pack/unpack, unit-tested)
- Device: `firmware/core/route_sheet.{c,h}` (decode/encode, validated against
  vectors generated from the TS module — same golden-reference discipline as
  the pace engine)

All multi-byte integers are **little-endian**.

## Service and characteristics

| | UUID |
|---|---|
| Service | `9E4B0001-F2E4-4B84-8E4E-2E8F1B4C6D3A` |
| `ROUTE_SHEET` (write) | `9E4B0002-F2E4-4B84-8E4E-2E8F1B4C6D3A` |
| `CONTROL` (write) | `9E4B0003-F2E4-4B84-8E4E-2E8F1B4C6D3A` |
| `DEVICE_STATUS` (read + notify) | `9E4B0004-F2E4-4B84-8E4E-2E8F1B4C6D3A` |
| `RIDE_LOG` (notify) | `9E4B0005-F2E4-4B84-8E4E-2E8F1B4C6D3A` |

The device advertises the service UUID with local name `Enduro-<id>`.

## CRC

CRC-16/CCITT-FALSE: polynomial `0x1021`, initial value `0xFFFF`, no
reflection, no final XOR. Implemented identically in TS and C.

## ROUTE_SHEET payload (phone → device)

```
[version u8 = 0x01]
[segment_count u8]
segment_count ×:
  [distance u16]      thousandths of a mile (0.001 mi units, max 65.535 mi)
  [speed u16]         tenths of a mph; 0 and !HAS_SPEED flag = free/null
  [flags u8]          bit0 IS_RESET, bit1 IS_FREE, bit2 HAS_SPEED,
                      bits 4-7 check_type (0 none, 1 known, 2 secret,
                      3 emergency, 4 gas, 5 start, 6 finish)
  [label_len u8]      0-23
  [label utf8]        label_len bytes
[crc16 u16]           over every preceding byte
```

Distances are quantized to 0.001 mi. Route sheets are written in hundredths,
so this is lossless in practice; both ends divide the same integer by 1000.0,
so the doubles the two engines run on are **identical**.

### Transfer framing

The payload can exceed one ATT write, so ROUTE_SHEET receives framed chunks
(write-with-response, sequential):

```
BEGIN: [0x01][total_len u16]
DATA:  [0x02][offset u16][bytes ...]      as many as fit in (MTU-3-3)
END:   [0x03]
```

On END the device verifies length and CRC, stores the sheet in flash, and
reports `route_loaded` in DEVICE_STATUS. A BEGIN aborts any transfer in
progress.

## CONTROL opcodes (phone → device)

```
0x01 START_RIDE   [epoch_s u32]   zero distance/deviation, start raw log;
                                  epoch anchors device millis to wall clock
0x02 END_RIDE
0x03 MANUAL_RESET                 zero deviation (rider hit a known check)
0x04 SET_WHEEL_CIRC [mm u16]
0x05 REQUEST_RIDE_LOG             begin RIDE_LOG stream
0x06 CLEAR_RIDE_LOG
```

## RIDE_LOG stream (device → phone)

Raw CSC log rows captured during the ride, streamed after END_RIDE via
notifications:

```
DATA packet:  [seq u8][row_count u8 >= 1] row_count × 10-byte rows:
                [wall_clock_ms u32]      ms since ride start (device clock)
                [cumulative_revs u32]
                [wheel_event_time u16]
END packet:   [seq u8][0x00][total_rows u16][crc16 u16]
```

`seq` increments per packet (mod 256) so the phone can detect a dropped
notification and re-request. The END CRC covers all row bytes in order.
The phone converts `wall_clock_ms` to epoch ms using the START_RIDE anchor,
inserts rows into `raw_csc_log`, then runs `src/engine/replay.ts` to produce
`ride_log` rows with `source = 'replay'` — the cross-validation step against
what the firmware displayed live.

## DEVICE_STATUS (device → phone, 12 bytes, read + notify ~1 Hz)

```
[version u8 = 0x01]
[sensor_status u8]    0 disconnected, 1 connecting, 2 connected, 3 lost
[ride_state u8]       0 idle, 1 riding, 2 log_ready
[battery_pct u8]      0-100, 0xFF unknown
[deviation_s i16]     current deviation, seconds, clamped to ±32767
[distance u32]        cumulative distance, 0.001 mi units
[segment_index u8]    current segment
[flags u8]            bit0 route_loaded, bit1 in_free_section
```
