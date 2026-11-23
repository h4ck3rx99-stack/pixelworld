# RangoliLive

One shared, live rangoli that everyone on the internet draws together from their phones.
Every piece is mirrored 8 ways around the centre, so strangers tapping at random still make
something beautiful. The board resets at 00:00 IST and every day is archived with a timelapse.

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

Tests and checks:

```sh
npm test           # grid mapping, symmetry, cooldown/rate limits, IST rollover, API
npm run typecheck
npm run sim -- --clients 50 --transport mixed --seconds 60 --seed 6000 --keep
```

The simulator is **local only**. It starts its own throwaway server on 127.0.0.1 with a temp
database and takes no URL, so it cannot be pointed at production. `--transport sse|poll|mixed`
exercises both live transports; `--seed N` pre-fills the board to test rendering with thousands
of events; `--keep` leaves the server up so you can open it (run `npm run build` first).

Useful URL flags: `?transport=poll` forces the polling fallback, `?timelapse=today` opens the
replay, `?record=today` (or `?record=2026-11-23`) opens record mode directly.

## Environment variables

| Name | Default | What |
| --- | --- | --- |
| `PORT` | 8787 | Set by Embarko. |
| `DATA_DIR` | `./data` | SQLite lives here. Set by Embarko; survives redeploys. **Not backed up.** |
| `ADMIN_SECRET` | unset | Enables the admin endpoints. Unset = admin endpoints return 404. |
| `COOLDOWN_MS` | 4000 | One piece per device per this many ms. |
| `IP_PER_MIN` | 90 | Placements per IP per minute (allows a few phones on one Wi-Fi). |
| `DEVICE_DAILY` | 600 | Placements per device per IST day. |
| `IP_DAILY` | 5000 | Placements per IP per IST day. |

## Admin endpoints

All need `Authorization: Bearer $ADMIN_SECRET`.

```sh
# wipe today's board
curl -X POST https://rangolilive.embarko.app/api/admin/reset -H "Authorization: Bearer $ADMIN_SECRET"
# remove every piece a device ever placed (find the id in an export)
curl -X POST https://rangolilive.embarko.app/api/admin/purge -H "Authorization: Bearer $ADMIN_SECRET" \
     -H 'content-type: application/json' -d '{"device":"<uuid>"}'
# export one day's full event log, with device ids
curl "https://rangolilive.embarko.app/api/admin/export?day=2026-11-23" -H "Authorization: Bearer $ADMIN_SECRET" -o day.json
```

Connected clients reload the board automatically after a reset or purge.

## Deploy (Embarko)

Deployed through the Embarko MCP connector (`deploy_app`, app name `rangolilive`) with the source
files only: no `node_modules`, `dist`, `data`. Embarko runs `npm install`, `npm run build`,
`npm start`. Set `ADMIN_SECRET` in the app's env vars on Embarko.

## How it works

- **Grid** (`shared/grid.ts`): 14 rings; ring 0 is the centre lotus, and slots per ring grow
  outward so cells stay about the same size. A tap becomes polar coordinates, which fold into one
  canonical 45° wedge to give a `(ring, slot)`. The server stores one event and every client draws it with the 8
  symmetry matrices (4 rotations × mirror). Mirrored copies flip too, so swirls and leaves pair up.
- **Server** (`server/app.ts`): Hono + better-sqlite3. Event `{id, ring, slot, piece, colour,
  device, ts}`; today's board is cached in memory. The broadcast is batched every 250 ms. Each
  event carries a short hash of the device (`who`), never the raw id, so "Show mine" works without
  exposing ids.
- **Live transport**: Embarko does not support WebSockets, so the client tries Server-Sent Events
  and, if no handshake arrives within 4 s or the stream keeps failing, falls back to polling
  `GET /api/events?since=<lastId>` every second.
- **Daily cycle**: every event is tagged with its IST date, so the board rolls over at midnight
  on the next request or broadcast tick, with no cron job. The finished day's final snapshot is written to
  the `snapshots` table; the full event log stays in `events` and drives the timelapse.
- **Rendering** (`src/render.ts`, `src/stage.ts`): Canvas 2D. Each piece × colour is drawn
  once into a powder-textured sprite (grain, soft gaps, spilled specks). Settled pieces sit on an
  offscreen static layer; each frame only blits it and draws the pieces still blooming.
- **Presence**: devices that sent a heartbeat (every 15 s, only while the tab is visible) in the
  last 30 s. Real numbers only.

## Limits worth knowing

- Data is SQLite on Embarko's disk with no backups. Use the admin export to keep a copy of days you care about.
- Cooldown and rate-limit counters are in memory. A restart forgets them, and the worst case is a
  few extra pieces.
