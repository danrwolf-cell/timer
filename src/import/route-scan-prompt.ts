// Extraction instructions. Deliberately narrow: the model transcribes raw
// facts off the sheet; every downstream computation (clock-time-to-seconds,
// checking each checkpoint against computeKeyTime) happens in the caller,
// in deterministic TS — see route-scan.ts. Get the model to a faithful
// transcription and let the engine be the judge of whether it's right.
//
// Shared between the app's direct-from-phone path (route-scan-direct.ts)
// and server/ (the optional self-hosted path) — same prompt either way.

export const EXTRACTION_PROMPT = `You are transcribing an enduro motorcycle route sheet (a "roll chart" or "confirmation sheet") into structured data. Read the attached document carefully and extract exactly what is printed — do not compute or infer numbers that are not written on the sheet.

## What a route sheet looks like

A ride is a sequence of timed segments, each ridden at a required average speed (mph). The sheet gives, at each mileage point, either a speed change ("CHANGE TO n MPH") or a checkpoint. Printed "KT =" (key time) values are the official clock time a rider is scored against at that mileage — these are your ground truth for accuracy, since they get checked automatically against the segments you output.

## Segments — output as ONE continuous ride-ordered list

Each segment is (distance, speed): the distance is that segment's OWN length in miles, not a cumulative/running total. Segments accumulate speed changes in ride order.

**Mileage restarts at gas are bookkeeping only, not a break in the ride.** Many sheets restart their printed mileage column at 0.00 after a gas stop (the rider physically resets their trip odometer there). Do NOT start a new segments array or treat this as free time — keep appending segments to the SAME list, using each segment's own (now odometer-relative) length. Mark ONLY the segment immediately after such a restart with isReset: true — this is the one case isReset applies to. Do not set isReset on anything else, even if the sheet prints the word "RESET" elsewhere (see Free zones below — that is a different, unrelated use of the same word).

Almost never set isFree or speedMph: null on a segment. That means "no pace requirement for this entire segment" and is rare — most sheets never use it. A stretch of no-secret-check protection (see below) is NOT the same thing and must not be marked isFree.

Set checkType on a segment to describe the event at the END of that segment: "gas" at a gas stop, "finish" at the final segment, "known" or "secret" at a named/lettered checkpoint if the sheet distinguishes them, otherwise null.

## Free zones — separate from segments entirely

Route sheets mark stretches where a secret/surprise check is not allowed — commonly printed as "RESET ... TO ...", a bare "... TO ...", a "FREE TIME" list, or "Start Free Time" / "End Free Time". All of these mean the same thing: a no-check zone. Mileage and the key-time clock both keep accruing completely normally through it — nothing about the pace math changes. Extract every one of these as a {startMi, endMi} pair in CUMULATIVE course miles (the running total of every segment so far, not the sheet's possibly-restarted mileage column) — separate from the segments list, not encoded as isFree.

A gas stop typically has its own free zone too (protection approaching and at the pump) — extract it the same way.

## Checkpoints — transcribe every printed "KT =" verbatim

For every printed key time on the sheet, record: a short label, the CUMULATIVE course mile it falls at (running total of segments so far), and the clock time exactly as printed — e.g. "9:23" or "1:23" — with no AM/PM marker added, even if you can infer one. Include the very first key time (the start, e.g. "9:00") as startClockTime, separately from the checkpoints list. Every speed change's key time, every gas stop, and the finish should all appear as checkpoints.

## Output

- routeName: a short descriptive name (include the event name and year if printed).
- eventDate: the event date if printed on the sheet, else null.
- If the sheet has a rider-class split (e.g. two sets of segments after a common point), only extract ONE branch — prefer the first one printed, or the one that appears to apply to the widest set of riders — and ignore the other. Do not merge the two.
- Numeric accuracy on checkpoints matters most: they get checked automatically against the segments you extract, so a mistyped digit anywhere will surface as a specific failing checkpoint rather than silently corrupting the whole route.`;
