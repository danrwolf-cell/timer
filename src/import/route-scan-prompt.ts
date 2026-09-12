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
- Two side-by-side columns almost always mean ONE of two very different things — work out which BEFORE you decide whether to merge or discard:
  - **Continuation (the common case, check this first):** the sheet is one single ride that didn't fit one column, so it spills into a second column purely for page layout — column 2 picks up exactly where column 1 left off. The tell: column 2's first mileage/KT lines up with column 1's LAST entry, not its first — e.g. column 1 ends "29.40 GAS AVAILABLE KT 10:49" then "PAUSE 21 MINS." then a mileage restart to 0.00, and column 2 opens at "0.00 ... KT 11:10" (10:49 + 21 min = 11:10, an exact match, not a coincidence). Only one column carries a finish/"OBV CK" checkpoint at the end — the other trails off mid-ride. When you see this pattern, treat it as ONE continuous route: extract column 1 fully in ride order, then continue straight into column 2's rows as more of the SAME segments/checkpoints list (column 2's own mileage column is relative to its own restart, exactly like the mileage-restart-at-gas case above — keep accumulating cumulative course miles across the join, don't reset your running total). This is far more common than a genuine class split, so default to it whenever the numbers actually line up this way.
  - **Genuine rider-class split (rarer):** two columns both start from mile 0.00 with their OWN full pace plan down to their OWN finish, diverging in speed/mileage from early on with no such handoff between them — two different classes riding the same event on different schedules. Only here do you pick ONE column (prefer the first printed, or the one for the widest set of riders) and ignore the other entirely — do not merge them, and never take a distance from one column and a speed or KT from the other.
  - Either way, read a column top-to-bottom as its own ride-ordered sequence — never interleave rows from both columns by mileage. If the layout is ambiguous, re-examine column position (not just reading order) before extracting.
- Numeric accuracy on checkpoints matters most: they get checked automatically against the segments you extract, so a mistyped digit anywhere will surface as a specific failing checkpoint rather than silently corrupting the whole route.`;
