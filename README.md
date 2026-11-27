# PixelWorld

One shared pixel canvas for the whole internet. Everyone paints on the same 2400 × 1350 grid
(16:9 landscape), live. Pick from 254 colours (16 quick swatches, plus a colour wheel and the
full grid behind the rainbow swatch) and draft pixels by tapping (Move mode) or dragging (Draw
mode), then press Place once to put them all up. A new device starts with 16 pixels; the bank
refills one every 30 seconds (the clock starts on the first visit) and holds up to 64. The canvas
never resets, and the timelapse replays its whole history.

Tools: **Pick** (copy a pixel's colour, or a colour from your guide image), **Clear** (drop
drafts), **Mine** (highlight your pixels), **Guide** (lay an image over the canvas to trace; only
you see it, it is saved on your device, and its colours are snapped to the palette). Tapping a pixel
shows who painted it last; tapping that line opens its last 5 paints, a link to it, and a Report
button. Tapping "online now" jumps to the latest pixel someone else placed. While zoomed in, a
minimap in the corner shows where you are (tap or drag it to jump). Leaderboard names open a small
profile (pixels placed, today, still showing, last seen, and a jump to their latest pixel).

First-time visitors get a short one-time intro (what it is, how to paint, getting around) that ends by
offering to set a name; it's skipped for anyone who has played before.

People can set an optional, unique username (2–20 letters, numbers, spaces, `_ . -`); without one
they show as "anonymous". Names with slurs or obvious swearing are refused (`blockedName` in
`server/app.ts`: long slurs match anywhere, short words only as whole words so names like Ishita pass).

The app installs as a PWA; `public/sw.js` caches the page and built assets so it opens offline
(the live API is never cached).

## Run locally

```sh
npm install
npm run dev        # API on :8787 (auto-reload) + Vite on :5173 → open http://localhost:5173
```

Production build, as Embarko runs it:

```sh
npm run build      # front-end → dist/, server → dist-server/
npm start          # serves both on $PORT (default 8787)
```

Needs Node 22.13+ (uses the built-in `node:sqlite`; `.node-version` pins 22 for Embarko).

Tests and checks:

```sh
npm test           # validation, pixel bank, batches, IP limits, API, pixel info, restart rebuild
npm run typecheck
npm run sim -- --clients 50 --transport mixed --seconds 60 --seed 6000 --keep
```

The simulator is **local only**. It starts its own throwaway server on 127.0.0.1 with a temp
database and takes no URL, so it cannot be pointed at production. Fake people "draw" short random
walks. `--transport sse|poll|mixed` exercises both live transports; `--seed N` pre-fills the canvas;
`--keep` leaves the server up so you can open it (run `npm run build` first).

Useful URL flags: `?x=1200&y=600&z=16` opens zoomed in on a pixel (the Link button next to pixel info copies one), `?transport=poll` forces the polling fallback, `?timelapse` opens the replay,
`?record` opens record mode directly (tap to play, double-tap to exit).

## Environment variables

| Name | Default | What |
| --- | --- | --- |
| `PORT` | 8787 | Set by Embarko. |
| `DATA_DIR` | `./data` | SQLite lives here. Set by Embarko; survives redeploys. **Not backed up.** |
| `ADMIN_SECRET` | unset | Enables the admin endpoints. Unset = admin endpoints return 404. |
| `IP_PER_MIN` | 400 | Placements per IP per minute (lets a few phones on one Wi-Fi spend their 64 at once). |
| `IP_DAILY` | 20000 | Placements per IP per UTC day. |
| `CRON_SECRET`, `STORAGE_URL`, `STORAGE_TOKEN`, `APP_NAME` | set by Embarko | Scheduler auth and file storage, used by backups and restore. |

The palette, starting bank (16), bank size (64) and refill time (30 s) are constants in `shared/pixels.ts`, shared by server and client.

## Admin endpoints

All need `Authorization: Bearer $ADMIN_SECRET`.

```sh
# wipe the whole canvas and its history
curl -X POST https://pixelworld.embarko.app/api/admin/reset -H "Authorization: Bearer $ADMIN_SECRET"
# completely fresh start: also forgets names, pixel banks and reports
curl -X POST https://pixelworld.embarko.app/api/admin/reset -H "Authorization: Bearer $ADMIN_SECRET"      -H 'content-type: application/json' -d '{"all":true}'
# remove every pixel a device ever placed (find the id in the export)
curl -X POST https://pixelworld.embarko.app/api/admin/purge -H "Authorization: Bearer $ADMIN_SECRET" \
     -H 'content-type: application/json' -d '{"device":"<uuid>"}'
# roll an area back to how it looked before a time (ms timestamp); leave out "since" to wipe it blank
curl -X POST https://pixelworld.embarko.app/api/admin/erase -H "Authorization: Bearer $ADMIN_SECRET" \
     -H 'content-type: application/json' -d '{"x":100,"y":200,"w":50,"h":40,"since":1795500000000}'
# remove an offensive username (the person shows as anonymous again)
curl -X POST https://pixelworld.embarko.app/api/admin/clear-name -H "Authorization: Bearer $ADMIN_SECRET" \
     -H 'content-type: application/json' -d '{"name":"<name>"}'
# how many people came: unique visitors, today's new and active ones, page loads, and new visitors per day
curl https://pixelworld.embarko.app/api/admin/stats -H "Authorization: Bearer $ADMIN_SECRET"
# see what people reported (grouped into 20 x 20 areas, newest first), then clear the list
curl https://pixelworld.embarko.app/api/admin/reports -H "Authorization: Bearer $ADMIN_SECRET"
curl -X POST https://pixelworld.embarko.app/api/admin/clear-reports -H "Authorization: Bearer $ADMIN_SECRET"
# replace everything with a daily backup from file storage (a wrong name lists the available files)
curl -X POST https://pixelworld.embarko.app/api/admin/restore -H "Authorization: Bearer $ADMIN_SECRET" \
     -H 'content-type: application/json' -d '{"file":"backup-2026-11-24.json.gz"}'
# export the full event log, with device ids
curl https://pixelworld.embarko.app/api/admin/export -H "Authorization: Bearer $ADMIN_SECRET" -o pixelworld.json
```

Connected clients reload the canvas automatically after a reset, purge, erase or restore.

## Backups

Embarko calls `GET /tasks/backup` every day at 03:00 UTC (the schedule lives in `embarko.json`). It
uploads `backup-YYYY-MM-DD.json.gz` (every event plus usernames) to the app's Embarko file storage and
keeps the newest 14. Find them in the app's Files tab on Embarko; `/api/admin/restore` loads one back.

## Deploy (Embarko)

`npm run build` and `npm start` are what Embarko runs. Deploy the committed source:

```sh
git archive --format=tar.gz -o app.tar.gz HEAD
curl -X POST https://ship.embarko.ai/apps -H 'X-App-Name: pixelworld' -H 'X-Agent-Name: claude-code' -F source=@app.tar.gz
```

Set `ADMIN_SECRET` in the app's env vars on Embarko.

## How it works

- **Server** (`server/app.ts`): Hono + `node:sqlite`. `/api/state` and `/api/log` are gzipped
  (the 1 MB board compresses to ~25 KB). Every placement is one event
  `{id, x, y, colour, device, ts}`; the board is rebuilt in memory from the log on start.
  Broadcasts are batched every 250 ms. Events carry a short hash of the device (`who`), never the
  raw id, so "Show mine" works without exposing ids.
- **Live transport**: Embarko does not support WebSockets, so the client tries Server-Sent Events
  and falls back to polling `GET /api/events?since=<lastId>` every second if no handshake arrives
  within 4 s or the stream keeps failing.
- **Pixel bank** (`server/limits.ts`): a token bucket per device, stored in SQLite so a restart
  doesn't refill everyone. The client mirrors it to show the count and the "+1 in 0:29" timer.
- **Batches**: `POST /api/place {d, pixels: [[x, y, colour], …]}` places up to 64 in one
  transaction, as many as the bank allows; the client keeps the rest as drafts.
- **Palette**: 254 colours in one byte per pixel (255 = blank): the original 16, a 6×6×6 colour cube
  and 22 greys. The colour wheel snaps to the nearest of them, so what you see is what gets placed.
- **Pixel info**: `GET /api/pixel?x=&y=` returns how many times a pixel was painted, when, the last
  painter's username (`by`, null if they never set one) and the last 5 paints. Device ids are never exposed.
- **Profiles**: `GET /api/profile?name=`; **reports**: `POST /api/report {d, x, y}` (one per device per 10 s).
- **Board loading**: `GET /api/board` is the whole canvas as raw bytes, gzipped once and shared by
  every visitor (rebuilt at most once a second; `x-last-id` tells the client where the live stream picks up).
- **Leaderboard**: `GET /api/leaders` lists the top 10 named painters today (UTC) and of all time.
- **Usernames**: `POST /api/name {d, name}`; unique ignoring case so nobody can impersonate someone.
- **Rendering** (`src/board.ts`): Canvas 2D. Pixels live on a 2400 × 1350 offscreen canvas;
  each frame is one scaled `drawImage` with smoothing off, plus a faint grid when zoomed in.
- **Timelapse** (`src/timelapse.ts`): `GET /api/log` returns the whole history as flat
  `[x, y, colour, …]`, replayed over ~20 s.
- **Presence**: devices that sent a heartbeat (every 15 s, only while the tab is visible) in the
  last 30 s. Real numbers only.

## Limits worth knowing

- Data is SQLite on Embarko's disk, backed up daily to file storage (newest 14 kept).
- Rude drawings: people can report them; the admin erase rolls an area back, and purge removes
  everything from one device.
- Clearing site data still gives a fresh bank, but only 16 pixels, and the per-IP limits cap how far that goes.
- The name filter is a short English/Hindi word list; it will miss creative spellings.
- The per-IP counters are in memory, so a restart forgets them.
- `/api/log` sends the whole history at once; fine to ~500k pixels.
