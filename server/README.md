# Route-scan extraction server (optional — not the default)

The app's default scan path (`src/import/route-scan-direct.ts`) calls
Anthropic directly from the phone, using an API key you enter in
**Settings** on-device (Keychain/Keystore via `expo-secure-store`, never
shipped with the app). Most riders don't need this server at all.

Use this instead if you'd rather keep the key off the phone entirely — e.g.
sharing one deployment across a few riders' phones, or you just don't want
a live API key sitting on a device that could be lost. Same endpoint, same
extraction, same check — it's the identical pipeline, just running on a
server you host instead of on-device.

One endpoint, `POST /extract`: takes a photographed or uploaded route sheet
(image or PDF) and returns structured segments, free zones, and a
checkpoint-by-checkpoint comparison against the sheet's own printed key
times. See `../src/import/route-scan-prompt.ts` for what the model is asked
to extract and `../src/import/route-scan.ts` for the deterministic
conversion and check that run on its output before anything is returned —
the model transcribes raw facts, the pace engine is the one that decides
whether they're right.

It's a small, plain Node/Express service — deploy it anywhere that runs
Node (Fly.io, Render, Railway, a VPS, your own machine on your LAN for
testing). Not tied to any one platform's proprietary format.

## Run it

```bash
cd server
npm install
cp .env.example .env      # then fill in ANTHROPIC_API_KEY
npm start                 # or: npm run dev (restarts on file changes)
```

Listens on `PORT` (default `8787`). `GET /health` returns `{"ok":true}` once
it's up.

## Using it from the app

The app's `ScanRouteScreen` doesn't have a server-URL field — it always
calls Anthropic directly (`route-scan-direct.ts`). To use this server
instead, point `ScanRouteScreen` at `route-scan-client.ts`'s
`extractRouteSheet(serverUrl, ...)` in place of `extractRouteSheetDirect`,
and add a way to enter/store this server's URL (it used to live in
`app_settings` under the key `scanServerUrl` before the direct path
replaced it as the default — that plumbing is gone from the screen now,
not from the DB layer).

## Why this can hold the key when the app can't

A key embedded in the mobile app binary is not secret — anyone can extract
it from the app package. A key entered by the rider into Settings and
stored in the device's own Keychain/Keystore is a materially different
risk (tied to that one device, protected by OS-level secure storage) — good
enough for a private, self-built app. This server exists for the case
where even that isn't wanted: the key lives only here, and phones calling
it never see it.

## What it does NOT do

- No auth on `/extract` as shipped. If you deploy this somewhere reachable
  from the public internet, put your own auth in front of it (a shared
  header token checked in `src/index.ts` is the minimum) — otherwise anyone
  who finds the URL can spend your API budget.
- No rate limiting, no persistence, no logging beyond stderr on failure.
  This is sized for "one rider's app talking to their own deployment," not
  a shared multi-user service.

## Deployment notes

- Runs directly via `tsx` (no separate build step) — `npm start` works
  identically in dev and production.
- Imports straight from the main app's source tree
  (`../src/engine/pace-engine.ts`, `../src/engine/free-territory.ts`,
  `../src/import/route-sheet.ts`, `../src/import/route-scan.ts`,
  `../src/import/route-scan-schema.ts`, `../src/import/route-scan-prompt.ts`)
  rather than duplicating them — these are pure, zero-platform-dependency
  modules (the same golden-reference discipline the firmware core relies
  on), so importing them straight from Node has always been safe. Keep this
  directory checked out alongside `../src` when deploying (i.e. deploy the
  whole repo, with `server/` as the working directory) rather than copying
  `server/` out on its own.
- Unlike this server, the app's own `route-scan-direct.ts` can't use
  `@anthropic-ai/sdk` — its credential-resolution code imports `node:fs`,
  which Metro can't bundle for React Native (confirmed via a real
  `expo export` failure). It hand-builds the equivalent request instead.
  This server has no such constraint; it's plain Node.
