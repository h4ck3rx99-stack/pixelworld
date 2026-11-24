# PixelWorld

One shared pixel canvas for the whole internet. Everyone paints on the same 2400 × 1350 grid
(16:9 landscape), live. Pick one of 16 colours and draft pixels by tapping
(Move mode) or dragging (Draw mode), then press Place once to put them all up. Everyone has a
bank of up to 64 pixels that refills one every 30 seconds. The canvas never resets, and the
timelapse replays its whole history.

Tools: **Pick** (copy a pixel's colour), **Clear** (drop drafts), **Mine** (highlight your
pixels), and tapping any pixel shows who painted it last, how often it has been painted and when.
People can set an optional, unique username (2–20 letters, numbers, spaces, `_ . -`); without one
they show as "anonymous".

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

The bank size (64) and refill time (30 s) are constants in `shared/pixels.ts`, shared by server and client.

## Admin endpoints

All need `Authorization: Bearer $ADMIN_SECRET`.

```sh
# wipe the whole canvas and its history
curl -X POST https://pixelworld.embarko.app/api/admin/reset -H "Authorization: Bearer $ADMIN_SECRET"
# remove every pixel a device ever placed (find the id in the export)
curl -X POST https://pixelworld.embarko.app/api/admin/purge -H "Authorization: Bearer $ADMIN_SECRET" \
     -H 'content-type: application/json' -d '{"device":"<uuid>"}'
# roll an area back to how it looked before a time (ms timestamp); leave out "since" to wipe it blank
curl -X POST https://pixelworld.embarko.app/api/admin/erase -H "Authorization: Bearer $ADMIN_SECRET"      -H 'content-type: application/json' -d '{"x":100,"y":200,"w":50,"h":40,"since":1795500000000}'
# remove an offensive username (the person shows as anonymous again)
curl -X POST https://pixelworld.embarko.app/api/admin/clear-name -H "Authorization: Bearer $ADMIN_SECRET" \n     -H 'content-type: application/json' -d '{"name":"<name>"}'
# export the full event log, with device ids
curl https://pixelworld.embarko.app/api/admin/export -H "Authorization: Bearer $ADMIN_SECRET" -o pixelworld.json
```

Connected clients reload the canvas automatically after a reset or purge.

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
- **Pixel info**: `GET /api/pixel?x=&y=` returns how many times a pixel was painted, when, and the last
  painter's username (`by`, null if they never set one). Device ids are never exposed.
- **Usernames**: `POST /api/name {d, name}`; unique ignoring case so nobody can impersonate someone.
- **Rendering** (`src/board.ts`): Canvas 2D. Pixels live on a 2400 × 1350 offscreen canvas;
  each frame is one scaled `drawImage` with smoothing off, plus a faint grid when zoomed in.
- **Timelapse** (`src/timelapse.ts`): `GET /api/log` returns the whole history as flat
  `[x, y, colour, …]`, replayed over ~20 s.
- **Presence**: devices that sent a heartbeat (every 15 s, only while the tab is visible) in the
  last 30 s. Real numbers only.

## Limits worth knowing

- Data is SQLite on Embarko's disk with no backups. Use the admin export to keep a copy.
- A free canvas has no built-in protection against rude drawings; the admin purge removes
  everything from one device.
- Clearing site data gives a device a fresh 64-pixel bank; the per-IP limits cap how far that goes.
- The per-IP counters are in memory, so a restart forgets them.
- `/api/log` sends the whole history at once; fine to ~500k pixels.
