# Route-scan extraction server

One endpoint, `POST /extract`: takes a photographed or uploaded route sheet
(image or PDF) and returns structured segments, free zones, and a
checkpoint-by-checkpoint comparison against the sheet's own printed key
times. See `src/prompt.ts` for what the model is asked to extract and
`../src/import/route-scan.ts` for the deterministic conversion and check
that run on its output before anything is returned — the model transcribes
raw facts, the pace engine is the one that decides whether they're right.

This holds an Anthropic API key and therefore cannot live in the phone app
itself. It's a small, plain Node/Express service — deploy it anywhere that
runs Node (Fly.io, Render, Railway, a VPS, your own machine on your LAN for
testing). It is not tied to any one platform's proprietary format.

## Run it

```bash
cd server
npm install
cp .env.example .env      # then fill in ANTHROPIC_API_KEY
npm start                 # or: npm run dev (restarts on file changes)
```

Listens on `PORT` (default `8787`). `GET /health` returns `{"ok":true}` once
it's up.

## Point the app at it

In the app, open **Route Library → Scan Route Sheet**, and enter this
server's URL (e.g. `https://your-deployment.example.com`, or
`http://<your-laptop-LAN-IP>:8787` for local testing on the same network —
`localhost` from the phone means the phone itself, not your computer). It's
saved on the phone once entered.

## Why this exists as a separate service

The extraction model needs an Anthropic API key on every call. A key
embedded in the mobile app binary is not secret — anyone can extract it
from the app package. This service is the one place the key lives; the
phone only ever talks to it, never to the Anthropic API directly.

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
- Imports three files straight from the main app's source tree
  (`../src/engine/pace-engine.ts`, `../src/engine/free-territory.ts`,
  `../src/import/route-sheet.ts`, `../src/import/route-scan.ts`) rather than
  duplicating them — these are pure, zero-platform-dependency modules (the
  same golden-reference discipline the firmware core relies on), so
  importing them straight from Node has always been safe. Keep this
  directory checked out alongside `../src` when deploying (i.e. deploy the
  whole repo, with `server/` as the working directory) rather than copying
  `server/` out on its own.
- `server/src/schema.ts`'s Zod schema hand-mirrors `ExtractedRouteSheet` in
  `../src/import/route-scan.ts`. If that type changes, update the schema to
  match — there's no codegen link between the two.
