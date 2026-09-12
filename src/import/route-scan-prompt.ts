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

Almost never set isFree or speedMph: null on a segment. That means "no pace requirement for this entire segment" and is rare — most sheets never use it. A stretch of no-secret-check protection (see below) is NOT the same thing and must not be marked isFree.

Set checkType on a segment to describe the event at the END of that segment: "gas" at a gas stop, "finish" at the final segment, "known" or "secret" at a named/lettered checkpoint if the sheet distinguishes them, otherwise null.

## "RESET" means two different things — tell them apart by the two numbers

Many sheets print "RESET" between two mileage numbers with NO connecting word at all, e.g. "6.40 RESET 8.56" or "28.82 RESET 32.80" — don't drop these just because they don't literally contain "TO"; this bare two-number form is the common case on plenty of sheets, not an exception. Compare the second number to the first:

- **Second number BIGGER than the first (the normal case): a free zone.** This is the exact same no-check-zone construct as "RESET ... TO ...", a bare "... TO ...", a "FREE TIME" list, or "Start Free Time" / "End Free Time" elsewhere on a sheet — just this club's shorthand for it, with "TO" omitted. See Free zones below for how to extract it.
- **Second number SMALLER than the first (almost always "RESET 0.00", right at a gas stop): a mileage restart, not a break in the ride.** The rider physically resets their trip odometer there; the printed mileage column restarts counting from that point. Do NOT start a new segments array or treat this as free time — keep appending segments to the SAME list, using each segment's own (now odometer-relative) length. Mark ONLY the segment immediately after this kind of restart with isReset: true — this is the one case isReset applies to. Do not set isReset on anything else, even a "RESET ... TO ..." free zone — that's the unrelated, far more common use of the same word, covered above.

## PAUSE stops — a segment with a fixed hold time, not a break in the sequence

Sheets often print "PAUSE n MIN." or "PAUSE n MINS." at a mileage point (a gas stop's wait is the most common case, but a pause can appear anywhere). This is real time that the printed key times downstream already include — every KT after a pause is that many minutes later than plain distance/speed math would give. It is NOT the same as a free zone (which doesn't add any time, just protects against a check) and NOT the same as isFree with no holdSeconds (which also adds no time).

For each PAUSE, insert one extra segment into the segments list at that exact point in ride order:
- distanceMi: 0
- speedMph: null, isFree: true (no pace requirement — there's no distance to score)
- holdSeconds: the pause duration in seconds (minutes × 60 — "PAUSE 21 MINS." → 1260, "PAUSE 10 MINS." → 600)
- label: something identifying it, e.g. "Pause" or "Gas pause"

On every other segment, holdSeconds must be null — only a PAUSE line gets a non-null value.

## Free zones — separate from segments entirely

Route sheets mark stretches where a secret/surprise check is not allowed — see the "RESET" forms above, plus a bare "... TO ...", a "FREE TIME" list, or "Start Free Time" / "End Free Time". All of these mean the same thing: a no-check zone. Mileage and the key-time clock both keep accruing completely normally through it — nothing about the pace math changes. Extract every one of these as a {startMi, endMi} pair in CUMULATIVE course miles (the running total of every segment so far, not the sheet's possibly-restarted mileage column) — separate from the segments list, not encoded as isFree.

A gas stop typically has its own free zone too (protection approaching and at the pump) — extract it the same way.

## Checkpoints — transcribe every printed "KT =" verbatim

For every printed key time on the sheet, record: a short label, the CUMULATIVE course mile it falls at (running total of segments so far), and the clock time exactly as printed — e.g. "9:23" or "1:23" — with no AM/PM marker added, even if you can infer one. Include the very first key time (the start, e.g. "9:00") as startClockTime, separately from the checkpoints list. Every speed change's key time, every gas stop, and the finish should all appear as checkpoints.

## Output

- routeName: a short descriptive name (include the event name and year if printed).
- eventDate: the event date if printed on the sheet, else null.
- If the sheet has a rider-class split, only extract ONE branch — prefer the first one printed (leftmost column, or the one that appears to apply to the widest set of riders) — and ignore the other. Do not merge the two: this applies whether the split happens partway down a single list (a shared prefix that forks later) OR the sheet prints two fully independent columns side by side from mile 0.00 (a common layout — each class gets its own column of mileage/speed/KT down the whole page, sometimes with the same early entries by coincidence). In the side-by-side case, read your chosen column top-to-bottom as a single ride-ordered sequence using ONLY that column's own numbers — never take a distance from one column and a speed or KT from the other, and never interleave rows from both columns by mileage. If the page layout is ambiguous about which numbers belong to which column, re-examine the visual layout (column position, not just reading order) before extracting.
- Numeric accuracy on checkpoints matters most: they get checked automatically against the segments you extract, so a mistyped digit anywhere will surface as a specific failing checkpoint rather than silently corrupting the whole route.`;
