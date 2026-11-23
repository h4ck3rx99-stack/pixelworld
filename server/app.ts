import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { getConnInfo } from '@hono/node-server/conninfo';
import { EMPTY, SIZE, validPixel, type WireEvent } from '../shared/pixels.ts';
import { Limiter, type LimitConfig } from './limits.ts';

export type Options = { dataDir: string; adminSecret?: string; limits: LimitConfig; now?: () => number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRESENCE_MS = 30_000;
const POLL_MAX = 1000;

type Row = { id: number; x: number; y: number; colour: number; device: string; who: string; ts: number };
const wire = (r: Row): WireEvent => [r.id, r.x, r.y, r.colour, r.who, r.ts];
export const whoOf = (device: string) => createHash('sha256').update(device).digest('hex').slice(0, 10);

export function createApp(opts: Options) {
  const now = opts.now ?? Date.now;
  mkdirSync(opts.dataDir, { recursive: true });
  const db = new DatabaseSync(join(opts.dataDir, 'pixelworld.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, x INTEGER NOT NULL, y INTEGER NOT NULL, colour INTEGER NOT NULL,
      device TEXT NOT NULL, who TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_device ON events(device);
  `);
  const q = {
    insert: db.prepare('INSERT INTO events (x, y, colour, device, who, ts) VALUES (?, ?, ?, ?, ?, ?)'),
    all: db.prepare('SELECT * FROM events ORDER BY id'),
    since: db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?'),
    log: db.prepare('SELECT x, y, colour FROM events ORDER BY id'),
    exportAll: db.prepare('SELECT id, x, y, colour, device, ts FROM events ORDER BY id'),
  };

  // ---- the board, kept in memory and rebuilt from the event log on start ----
  let board = new Uint8Array(SIZE * SIZE);
  let owner: string[] = [];
  let people = new Set<string>();
  let mine = new Map<string, number>();
  let pixels = 0;
  let lastId = 0;
  let firstTs = 0;

  function load() {
    board = new Uint8Array(SIZE * SIZE).fill(EMPTY);
    owner = new Array(SIZE * SIZE).fill('');
    people = new Set();
    mine = new Map();
    pixels = 0;
    lastId = 0;
    firstTs = 0;
    for (const r of q.all.all() as Row[]) apply(r);
  }
  function apply(r: Row) {
    const i = r.y * SIZE + r.x;
    board[i] = r.colour;
    owner[i] = r.who;
    people.add(r.device);
    mine.set(r.device, (mine.get(r.device) ?? 0) + 1);
    pixels++;
    lastId = r.id;
    firstTs ||= r.ts;
  }
  load();

  // ---- presence and live fan-out ----
  const presence = new Map<string, number>();
  const online = () => {
    const t = now();
    let n = 0;
    for (const [d, seen] of presence) t - seen < PRESENCE_MS ? n++ : presence.delete(d);
    return n;
  };
  const clients = new Map<SSEStreamingApi, number>(); // stream -> last event id it has
  let pending: WireEvent[] = [];
  let reloadPending = false;
  let lastStats = '';
  const stats = () => ({ pixels, people: people.size, online: online() });

  function send(s: SSEStreamingApi, data: unknown, event?: string) {
    s.writeSSE({ data: JSON.stringify(data), event, id: String(lastId) }).catch(() => clients.delete(s));
  }

  // Batch broadcasts every 250ms; stats ride along whenever they change.
  function flush() {
    if (reloadPending) {
      reloadPending = false;
      pending = [];
      for (const s of clients.keys()) send(s, {}, 'reload');
      return;
    }
    const st = stats();
    const key = JSON.stringify(st);
    if (!pending.length && key === lastStats) return;
    const e = pending;
    pending = [];
    lastStats = key;
    // A client that connected mid-batch already has the early part of it from its snapshot.
    for (const [s, seen] of clients) {
      send(s, { e: e.length && e[0][0] <= seen ? e.filter((x) => x[0] > seen) : e, ...st });
      clients.set(s, lastId);
    }
  }

  const limiter = new Limiter(opts.limits);
  const timers = [setInterval(flush, 250), setInterval(() => limiter.prune(now()), 60_000)];

  function clientIp(c: Context) {
    // Cloudflare in front of Embarko sets cf-connecting-ip and overwrites any client-sent value.
    const h = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (h) return h;
    try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
  }

  // ---- routes ----
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.get('cache-control')) c.header('cache-control', 'no-store');
  });
  app.use('/api/*', bodyLimit({ maxSize: 2048, onError: (c) => c.json({ error: 'too_large' }, 413) }));

  app.get('/api/health', (c) => c.json({ ok: true, rss: process.memoryUsage().rss, clients: clients.size }));

  app.get('/api/state', (c) => {
    const d = c.req.query('d') ?? '';
    const me = UUID.test(d) ? whoOf(d) : '';
    const myPixels: number[] = [];
    if (me) owner.forEach((w, i) => w === me && myPixels.push(i));
    return c.json({
      size: SIZE, lastId, board: Buffer.from(board).toString('base64'), ...stats(), since: firstTs,
      mine: me ? mine.get(d) ?? 0 : 0, myPixels,
      cooldownMs: me ? limiter.cooldownLeft(d, now()) : 0,
    });
  });

  app.post('/api/place', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== 'object' || typeof b.d !== 'string' || !UUID.test(b.d) || !validPixel(b.x, b.y, b.colour))
      return c.json({ error: 'invalid' }, 400);
    const t = now();
    const v = limiter.take(b.d, clientIp(c), t);
    if (!v.ok) return c.json({ error: v.reason, retryMs: v.retryMs }, 429);
    const who = whoOf(b.d);
    const id = Number(q.insert.run(b.x, b.y, b.colour, b.d, who, t).lastInsertRowid);
    const row: Row = { id, x: b.x, y: b.y, colour: b.colour, device: b.d, who, ts: t };
    apply(row);
    presence.set(b.d, t);
    pending.push(wire(row));
    return c.json({ ev: wire(row), mine: mine.get(b.d), ...stats() });
  });

  app.post('/api/hello', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.d !== 'string' || !UUID.test(b.d)) return c.json({ error: 'invalid' }, 400);
    presence.set(b.d, now());
    return c.json(stats());
  });

  function eventsSince(since: number) {
    if (since > lastId) return { reload: true as const }; // the board was reset under this client
    const rows = q.since.all(since, POLL_MAX) as Row[];
    if (rows.length === POLL_MAX) return { reload: true as const };
    return { e: rows.map(wire), lastId, ...stats() };
  }

  app.get('/api/events', (c) => c.json(eventsSince(Number(c.req.query('since')) || 0)));

  app.get('/api/stream', (c) => {
    const since = Number(c.req.header('last-event-id') ?? c.req.query('since')) || 0;
    c.header('x-accel-buffering', 'no');
    c.header('cache-control', 'no-store, no-transform');
    return streamSSE(c, async (s) => {
      clients.set(s, Math.max(since, lastId));
      await s.writeSSE({ event: 'hello', data: JSON.stringify({ lastId }), id: String(lastId) });
      const missed = eventsSince(since);
      if ('reload' in missed) send(s, {}, 'reload');
      else if (missed.e.length) send(s, missed);
      const ping = setInterval(() => s.write(': ping\n\n').catch(() => {}), 15_000);
      await new Promise<void>((resolve) => s.onAbort(resolve));
      clearInterval(ping);
      clients.delete(s);
    });
  });

  // Whole history for the timelapse, flat [x, y, colour, ...].
  // shortcut: sends every event at once (~10 bytes each), fine to ~500k events; sample or paginate beyond that.
  app.get('/api/log', (c) => {
    const ev = (q.log.all() as Pick<Row, 'x' | 'y' | 'colour'>[]).flatMap((r) => [r.x, r.y, r.colour]);
    return c.json({ size: SIZE, since: firstTs, pixels, people: people.size, ev });
  });

  // ---- admin (Authorization: Bearer $ADMIN_SECRET) ----
  const admin = new Hono();
  admin.use('*', async (c, next) => {
    const secret = opts.adminSecret;
    const got = Buffer.from(c.req.header('authorization') ?? '');
    const want = Buffer.from(`Bearer ${secret}`);
    if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) return c.json({ error: 'not_found' }, 404);
    await next();
  });
  function afterAdminChange() {
    load();
    reloadPending = true;
  }
  admin.post('/reset', (c) => {
    const n = db.prepare('DELETE FROM events').run().changes;
    afterAdminChange();
    return c.json({ ok: true, deleted: n });
  });
  admin.post('/purge', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.device !== 'string' || !b.device) return c.json({ error: 'device required' }, 400);
    const n = db.prepare('DELETE FROM events WHERE device = ?').run(b.device).changes;
    afterAdminChange();
    return c.json({ ok: true, deleted: n });
  });
  admin.get('/export', (c) => {
    c.header('content-disposition', 'attachment; filename="pixelworld.json"');
    return c.json({ size: SIZE, events: q.exportAll.all() });
  });
  app.route('/api/admin', admin);

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  return {
    app,
    flush,
    close() {
      timers.forEach(clearInterval);
      db.close();
    },
  };
}
