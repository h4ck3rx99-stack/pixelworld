import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { getConnInfo } from '@hono/node-server/conninfo';
import { cellKey, daysBetween, istDay, nextReset, validPlacement, type WireEvent } from '../shared/grid.ts';
import { Limiter, type LimitConfig } from './limits.ts';

export type Options = { dataDir: string; adminSecret?: string; limits: LimitConfig; now?: () => number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PRESENCE_MS = 30_000;
const POLL_MAX = 1000;

type Row = { id: number; day: string; ring: number; slot: number; piece: number; colour: number; who: string; ts: number };
const wire = (r: Row): WireEvent => [r.id, r.ring, r.slot, r.piece, r.colour, r.who, r.ts];
export const whoOf = (device: string) => createHash('sha256').update(device).digest('hex').slice(0, 10);

export function createApp(opts: Options) {
  const now = opts.now ?? Date.now;
  mkdirSync(opts.dataDir, { recursive: true });
  const db = new DatabaseSync(join(opts.dataDir, 'rangoli.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, ring INTEGER NOT NULL, slot INTEGER NOT NULL,
      piece INTEGER NOT NULL, colour INTEGER NOT NULL, device TEXT NOT NULL, who TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_day ON events(day, id);
    CREATE INDEX IF NOT EXISTS events_device ON events(device);
    CREATE TABLE IF NOT EXISTS snapshots (day TEXT PRIMARY KEY, cells TEXT NOT NULL, pieces INTEGER NOT NULL, people INTEGER NOT NULL);
  `);
  const q = {
    insert: db.prepare('INSERT INTO events (day, ring, slot, piece, colour, device, who, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    dayEvents: db.prepare('SELECT * FROM events WHERE day = ? ORDER BY id'),
    since: db.prepare('SELECT * FROM events WHERE day = ? AND id > ? ORDER BY id LIMIT ?'),
    maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events'),
    firstDay: db.prepare('SELECT MIN(day) AS d FROM events'),
    days: db.prepare('SELECT day, COUNT(*) AS pieces, COUNT(DISTINCT device) AS people FROM events GROUP BY day ORDER BY day DESC'),
    snapGet: db.prepare('SELECT * FROM snapshots WHERE day = ?'),
    snapPut: db.prepare('INSERT OR REPLACE INTO snapshots (day, cells, pieces, people) VALUES (?, ?, ?, ?)'),
    log: db.prepare('SELECT ring, slot, piece, colour FROM events WHERE day = ? ORDER BY id'),
    exportDay: db.prepare('SELECT id, ring, slot, piece, colour, device, ts FROM events WHERE day = ? ORDER BY id'),
  };

  // ---- today's board, kept in memory ----
  let today = '';
  let cells = new Map<number, Row>();
  let pieces = 0;
  let people = new Set<string>();
  let mine = new Map<string, number>();
  let lastId = 0;
  let firstDay = '';

  function loadDay(day: string) {
    today = day;
    cells = new Map();
    people = new Set();
    mine = new Map();
    pieces = 0;
    for (const r of q.dayEvents.all(day) as (Row & { device: string })[]) {
      cells.set(cellKey(r.ring, r.slot), r);
      people.add(r.device);
      mine.set(r.device, (mine.get(r.device) ?? 0) + 1);
      pieces++;
    }
    lastId = (q.maxId.get() as { m: number }).m;
    firstDay = (q.firstDay.get() as { d: string | null }).d ?? day;
  }

  /** Rolls the board over at 00:00 IST. Returns true when it did. */
  function ensureDay() {
    const day = istDay(now());
    if (day === today) return false;
    const prev = today;
    loadDay(day);
    if (prev) snapshot(prev); // archive the finished day
    return true;
  }
  loadDay(istDay(now()));

  const dayNo = (day: string) => Math.max(1, daysBetween(firstDay, day) + 1);
  const cellsOf = (m: Map<number, Row>) => [...m.values()].sort((a, b) => a.id - b.id).map(wire);

  function snapshot(day: string) {
    if (day === today) return { day, dayNo: dayNo(day), cells: cellsOf(cells), pieces, people: people.size };
    const s = q.snapGet.get(day) as { cells: string; pieces: number; people: number } | undefined;
    if (s) return { day, dayNo: dayNo(day), cells: JSON.parse(s.cells) as WireEvent[], pieces: s.pieces, people: s.people };
    const m = new Map<number, Row>();
    const devs = new Set<string>();
    let n = 0;
    for (const r of q.dayEvents.all(day) as (Row & { device: string })[]) m.set(cellKey(r.ring, r.slot), r), devs.add(r.device), n++;
    if (!n) return null;
    const c = cellsOf(m);
    q.snapPut.run(day, JSON.stringify(c), n, devs.size);
    return { day, dayNo: dayNo(day), cells: c, pieces: n, people: devs.size };
  }

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
  const stats = () => ({ pieces, people: people.size, online: online() });

  function send(s: SSEStreamingApi, data: unknown, event?: string) {
    s.writeSSE({ data: JSON.stringify(data), event, id: String(lastId) }).catch(() => clients.delete(s));
  }

  // Batch broadcasts every 250ms; stats ride along whenever they change.
  function flush() {
    if (ensureDay()) reloadPending = true;
    const st = stats();
    const key = JSON.stringify(st);
    if (reloadPending) {
      reloadPending = false;
      pending = [];
      for (const s of clients.keys()) send(s, { day: today }, 'reload');
      return;
    }
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
  const timers = [
    setInterval(flush, 250),
    setInterval(() => limiter.prune(now()), 60_000),
  ];

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
    ensureDay();
    const d = c.req.query('d') ?? '';
    return c.json({
      day: today, dayNo: dayNo(today), lastId, cells: cellsOf(cells), ...stats(),
      mine: UUID.test(d) ? mine.get(d) ?? 0 : 0,
      cooldownMs: UUID.test(d) ? limiter.cooldownLeft(d, now()) : 0,
      resetAt: nextReset(now()),
    });
  });

  app.post('/api/place', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== 'object' || typeof b.d !== 'string' || !UUID.test(b.d) || !validPlacement(b.ring, b.slot, b.piece, b.colour))
      return c.json({ error: 'invalid' }, 400);
    ensureDay();
    const t = now();
    const v = limiter.take(b.d, clientIp(c), t);
    if (!v.ok) return c.json({ error: v.reason, retryMs: v.retryMs }, 429);
    const who = whoOf(b.d);
    const id = Number(q.insert.run(today, b.ring, b.slot, b.piece, b.colour, b.d, who, t).lastInsertRowid);
    const row: Row = { id, day: today, ring: b.ring, slot: b.slot, piece: b.piece, colour: b.colour, who, ts: t };
    cells.set(cellKey(b.ring, b.slot), row);
    pieces++;
    people.add(b.d);
    mine.set(b.d, (mine.get(b.d) ?? 0) + 1);
    presence.set(b.d, t);
    lastId = id;
    pending.push(wire(row));
    return c.json({ ev: wire(row), mine: mine.get(b.d), ...stats() });
  });

  app.post('/api/hello', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.d !== 'string' || !UUID.test(b.d)) return c.json({ error: 'invalid' }, 400);
    presence.set(b.d, now());
    return c.json(stats());
  });

  function eventsSince(day: string | undefined, since: number) {
    ensureDay();
    if (day !== today) return { reload: true as const };
    const rows = q.since.all(today, since, POLL_MAX) as Row[];
    if (rows.length === POLL_MAX) return { reload: true as const };
    return { e: rows.map(wire), lastId, ...stats() };
  }

  app.get('/api/events', (c) => c.json(eventsSince(c.req.query('day'), Number(c.req.query('since')) || 0)));

  app.get('/api/stream', (c) => {
    const since = Number(c.req.header('last-event-id') ?? c.req.query('since')) || 0;
    const day = c.req.query('day');
    c.header('x-accel-buffering', 'no');
    c.header('cache-control', 'no-store, no-transform');
    return streamSSE(c, async (s) => {
      clients.set(s, Math.max(since, lastId));
      await s.writeSSE({ event: 'hello', data: JSON.stringify({ lastId }), id: String(lastId) });
      const missed = eventsSince(day, since);
      if ('reload' in missed) send(s, { day: today }, 'reload');
      else if (missed.e.length) send(s, missed);
      const ping = setInterval(() => s.write(': ping\n\n').catch(() => {}), 15_000);
      await new Promise<void>((resolve) => s.onAbort(resolve));
      clearInterval(ping);
      clients.delete(s);
    });
  });

  // ---- archive ----
  let daysCache: { at: number; body: unknown } | null = null;
  app.get('/api/days', (c) => {
    ensureDay();
    if (!daysCache || now() - daysCache.at > 30_000) {
      const rows = (q.days.all() as { day: string; pieces: number; people: number }[]).filter((r) => r.day !== today);
      daysCache = { at: now(), body: rows.map((r) => ({ ...r, dayNo: dayNo(r.day) })) };
    }
    return c.json({ today: { day: today, dayNo: dayNo(today), pieces, people: people.size }, past: daysCache.body });
  });

  app.get('/api/day/:day/snapshot', (c) => {
    const day = c.req.param('day');
    if (!DAY.test(day)) return c.json({ error: 'invalid' }, 400);
    ensureDay();
    const s = snapshot(day);
    if (!s) return c.json({ error: 'not_found' }, 404);
    if (day < today) c.header('cache-control', 'public, max-age=3600');
    return c.json(s);
  });

  app.get('/api/day/:day/log', (c) => {
    const day = c.req.param('day');
    if (!DAY.test(day)) return c.json({ error: 'invalid' }, 400);
    ensureDay();
    const s = snapshot(day);
    if (!s) return c.json({ error: 'not_found' }, 404);
    if (day < today) c.header('cache-control', 'public, max-age=3600');
    return c.json({ day, dayNo: s.dayNo, pieces: s.pieces, people: s.people, ev: (q.log.all(day) as Pick<Row, 'ring' | 'slot' | 'piece' | 'colour'>[]).flatMap((r) => [r.ring, r.slot, r.piece, r.colour]) });
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
    db.prepare('DELETE FROM snapshots').run();
    daysCache = null;
    loadDay(istDay(now()));
    reloadPending = true;
  }
  admin.post('/reset', (c) => {
    const n = db.prepare('DELETE FROM events WHERE day = ?').run(today).changes;
    afterAdminChange();
    return c.json({ ok: true, deleted: n, day: today });
  });
  admin.post('/purge', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.device !== 'string' || !b.device) return c.json({ error: 'device required' }, 400);
    const n = db.prepare('DELETE FROM events WHERE device = ?').run(b.device).changes;
    afterAdminChange();
    return c.json({ ok: true, deleted: n });
  });
  admin.get('/export', (c) => {
    const day = c.req.query('day') ?? today;
    if (!DAY.test(day)) return c.json({ error: 'invalid' }, 400);
    c.header('content-disposition', `attachment; filename="rangoli-${day}.json"`);
    return c.json({ day, events: q.exportDay.all(day) });
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
