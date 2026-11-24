import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { getConnInfo } from '@hono/node-server/conninfo';
import { BANK_SIZE, EMPTY, H, validPixel, W, type WireEvent } from '../shared/pixels.ts';
import { Limiter, type Bank, type LimitConfig } from './limits.ts';
import { iconImage, ogImage } from './png.ts';

export type Options = { dataDir: string; adminSecret?: string; limits: LimitConfig; now?: () => number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRESENCE_MS = 30_000;
const POLL_MAX = 1000;

type Row = { id: number; x: number; y: number; colour: number; device: string; who: string; ts: number };
const wire = (r: Row): WireEvent => [r.id, r.x, r.y, r.colour, r.who, r.ts];
export const validName = (n: string) => /^[\p{L}\p{N}_.\- ]{2,20}$/u.test(n) && /[\p{L}\p{N}]/u.test(n);
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
    CREATE INDEX IF NOT EXISTS events_xy ON events(x, y);
    CREATE TABLE IF NOT EXISTS banks (device TEXT PRIMARY KEY, tokens REAL NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS names (device TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS names_unique ON names(name COLLATE NOCASE);
  `);
  const q = {
    insert: db.prepare('INSERT INTO events (x, y, colour, device, who, ts) VALUES (?, ?, ?, ?, ?, ?)'),
    all: db.prepare('SELECT * FROM events ORDER BY id'),
    since: db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?'),
    log: db.prepare('SELECT x, y, colour FROM events ORDER BY id'),
    exportAll: db.prepare('SELECT id, x, y, colour, device, ts FROM events ORDER BY id'),
    bankGet: db.prepare('SELECT tokens, at FROM banks WHERE device = ?'),
    bankPut: db.prepare('INSERT OR REPLACE INTO banks (device, tokens, at) VALUES (?, ?, ?)'),
    pixelInfo: db.prepare('SELECT COUNT(*) AS times, MAX(ts) AS ts FROM events WHERE x = ? AND y = ?'),
    lastPainter: db.prepare('SELECT n.name FROM events e LEFT JOIN names n ON n.device = e.device WHERE e.x = ? AND e.y = ? ORDER BY e.id DESC LIMIT 1'),
    nameGet: db.prepare('SELECT name FROM names WHERE device = ?'),
    nameOwner: db.prepare('SELECT device FROM names WHERE name = ? COLLATE NOCASE'),
    namePut: db.prepare('INSERT OR REPLACE INTO names (device, name) VALUES (?, ?)'),
  };

  // ---- the board, kept in memory and rebuilt from the event log on start ----
  let board = new Uint8Array(W * H);
  // Who last painted each pixel, as a small number (a plain JS array this size would blow the 256 MB limit).
  let owner = new Uint32Array(W * H);
  let whoIds = new Map<string, number>();
  let people = new Set<string>();
  let mine = new Map<string, number>();
  let pixels = 0;
  let lastId = 0;
  let firstTs = 0;

  function load() {
    board = new Uint8Array(W * H).fill(EMPTY);
    owner = new Uint32Array(W * H); // 0 = nobody
    whoIds = new Map();
    people = new Set();
    mine = new Map();
    pixels = 0;
    lastId = 0;
    firstTs = 0;
    for (const r of q.all.all() as Row[]) apply(r);
  }
  function apply(r: Row) {
    const i = r.y * W + r.x;
    board[i] = r.colour;
    let wid = whoIds.get(r.who);
    if (!wid) whoIds.set(r.who, (wid = whoIds.size + 1));
    owner[i] = wid;
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

  const limiter = new Limiter(opts.limits, {
    get: (d) => q.bankGet.get(d) as Bank | undefined,
    set: (d, b) => void q.bankPut.run(d, b.tokens, b.at),
  });
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
  // The board is 1 MB of mostly identical bytes; gzip it here rather than trusting the proxy to.
  app.use('/api/state', compress());
  app.use('/api/log', compress());
  app.use('/api/*', bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: 'too_large' }, 413) }));

  app.get('/api/health', (c) => c.json({ ok: true, rss: process.memoryUsage().rss, clients: clients.size }));

  app.get('/api/state', (c) => {
    const d = c.req.query('d') ?? '';
    const me = UUID.test(d) ? whoOf(d) : '';
    const myPixels: number[] = [];
    const wid = me ? whoIds.get(me) : 0;
    if (wid) owner.forEach((w, i) => w === wid && myPixels.push(i));
    return c.json({
      w: W, h: H, lastId, board: Buffer.from(board).toString('base64'), ...stats(), since: firstTs,
      mine: me ? mine.get(d) ?? 0 : 0, myPixels,
      tokens: limiter.tokens(me ? d : '', now()),
      name: me ? (q.nameGet.get(d) as { name: string } | undefined)?.name ?? null : null,
    });
  });

  // Body: { d, pixels: [[x, y, colour], ...] } with 1..BANK_SIZE pixels. Places as many as the bank
  // allows, in order, and returns those events; the client rolls back the rest.
  app.post('/api/place', async (c) => {
    const b = await c.req.json().catch(() => null);
    const list = b?.pixels;
    if (!b || typeof b !== 'object' || typeof b.d !== 'string' || !UUID.test(b.d) || !Array.isArray(list) ||
        !list.length || list.length > BANK_SIZE || !list.every((p) => Array.isArray(p) && validPixel(p[0], p[1], p[2])))
      return c.json({ error: 'invalid' }, 400);
    const t = now();
    const v = limiter.take(b.d, clientIp(c), t, list.length);
    if (!v.ok) return c.json({ error: v.reason, retryMs: v.retryMs, tokens: v.tokens }, 429);
    const who = whoOf(b.d);
    const evs: WireEvent[] = [];
    db.exec('BEGIN');
    try {
      for (const [x, y, colour] of list.slice(0, v.count)) {
        const id = Number(q.insert.run(x, y, colour, b.d, who, t).lastInsertRowid);
        const row: Row = { id, x, y, colour, device: b.d, who, ts: t };
        apply(row);
        evs.push(wire(row));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      load(); // memory may hold rows the database dropped
      throw e;
    }
    presence.set(b.d, t);
    pending.push(...evs);
    return c.json({ evs, mine: mine.get(b.d), tokens: v.tokens, ...stats() });
  });

  // Who-painted-what stays private; this only says how busy a pixel has been.
  app.get('/api/pixel', (c) => {
    const x = Number(c.req.query('x')), y = Number(c.req.query('y'));
    if (!validPixel(x, y, 0)) return c.json({ error: 'invalid' }, 400);
    const r = q.pixelInfo.get(x, y) as { times: number; ts: number | null };
    const by = r.times ? (q.lastPainter.get(x, y) as { name: string | null }).name : null; // null = anonymous
    return c.json({ x, y, colour: board[y * W + x], times: r.times, ts: r.ts, by });
  });

  // Optional public username, shown as "by <name>" in pixel info. Unique ignoring case so nobody can pose as someone else.
  app.post('/api/name', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.d !== 'string' || !UUID.test(b.d) || typeof b.name !== 'string') return c.json({ error: 'invalid' }, 400);
    const name = b.name.trim().replace(/\s+/g, ' ');
    if (!validName(name)) return c.json({ error: 'invalid_name' }, 400);
    const owner = q.nameOwner.get(name) as { device: string } | undefined;
    if (owner && owner.device !== b.d) return c.json({ error: 'taken' }, 409);
    q.namePut.run(b.d, name);
    return c.json({ name });
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
    return c.json({ w: W, h: H, since: firstTs, pixels, people: people.size, ev });
  });

  // ---- images rendered by the server, so the deploy has no binary files ----
  const png = (body: Buffer, maxAge: number) =>
    new Response(new Uint8Array(body), { headers: { 'content-type': 'image/png', 'cache-control': `public, max-age=${maxAge}` } });
  let og = { at: 0, body: Buffer.alloc(0) };
  app.get('/og.png', () => {
    if (now() - og.at > 300_000) og = { at: now(), body: ogImage(board) }; // the live canvas, re-rendered every 5 min
    return png(og.body, 300);
  });
  const icons = new Map([192, 512].map((n) => [n, iconImage(n)]));
  app.get('/icon-192.png', () => png(icons.get(192)!, 86400));
  app.get('/icon-512.png', () => png(icons.get(512)!, 86400));

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
    db.prepare('DELETE FROM names WHERE device = ?').run(b.device);
    afterAdminChange();
    return c.json({ ok: true, deleted: n });
  });
  // Body: { x, y, w, h, since? } in canvas pixels. With since (ms timestamp) the area goes back to how
  // it looked before then; without it the area is wiped blank. Either way the events are deleted.
  admin.post('/erase', async (c) => {
    const b = await c.req.json().catch(() => null);
    const { x, y, w, h } = b ?? {};
    if (!validPixel(x, y, 0) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || x + w > W || y + h > H)
      return c.json({ error: 'need x, y, w, h inside the canvas' }, 400);
    const since = Number.isFinite(b.since) ? b.since : -Infinity;
    const n = db.prepare('DELETE FROM events WHERE x >= ? AND x < ? AND y >= ? AND y < ? AND ts >= ?').run(x, x + w, y, y + h, since).changes;
    afterAdminChange();
    return c.json({ ok: true, deleted: n });
  });
  admin.post('/clear-name', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.name !== 'string') return c.json({ error: 'name required' }, 400);
    return c.json({ ok: true, cleared: db.prepare('DELETE FROM names WHERE name = ? COLLATE NOCASE').run(b.name).changes });
  });
  admin.get('/export', (c) => {
    c.header('content-disposition', 'attachment; filename="pixelworld.json"');
    return c.json({ w: W, h: H, events: q.exportAll.all() });
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
