import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync, inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BANK_SIZE, EMPTY, H, REGEN_MS, W } from '../shared/pixels.ts';
import { createApp } from './app.ts';

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
let t = Date.UTC(2026, 10, 23, 10, 0);
let dir = '';
let inst: ReturnType<typeof createApp> | null = null;

function boot() {
  dir = mkdtempSync(join(tmpdir(), 'pixelworld-'));
  inst = createApp({ dataDir: dir, adminSecret: 's3cret', limits: { ipPerMin: 1000, ipDaily: 100_000 }, now: () => t });
  return inst.app;
}
afterEach(() => {
  inst?.close();
  rmSync(dir, { recursive: true, force: true });
});
type App = ReturnType<typeof boot>;
type One = { d: string; x: number; y: number; colour: number };
const post = (app: App, body: object) =>
  app.request('/api/place', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' } });
const place = (app: App, { d, x, y, colour }: One) => post(app, { d, pixels: [[x, y, colour]] });
const boardOf = async (a: App) => new Uint8Array(gunzipSync(Buffer.from(await (await a.request('/api/board')).arrayBuffer())));

describe('server', () => {
  it('places, validates, and serves deltas', async () => {
    const app = boot();
    const ok = await place(app, { d: D1, x: 3, y: 7, colour: 5 });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.mine).toBe(1);
    expect(body.tokens).toBe(BANK_SIZE - 1);
    expect(body.evs[0].slice(1, 4)).toEqual([3, 7, 5]);

    expect((await place(app, { d: D2, x: W, y: 0, colour: 0 })).status).toBe(400);
    expect((await place(app, { d: 'nope', x: 0, y: 0, colour: 0 })).status).toBe(400);

    expect((await place(app, { d: D1, x: 3, y: 7, colour: 9 })).status).toBe(200); // overwrites the pixel

    const state = await (await app.request(`/api/state?d=${D1}`)).json();
    const board = await boardOf(app);
    expect(board.length).toBe(W * H);
    expect(board[7 * W + 3]).toBe(9);
    expect(board[0]).toBe(EMPTY);
    expect(state).toMatchObject({ pixels: 2, people: 1, mine: 2, myPixels: [7 * W + 3], tokens: BANK_SIZE - 2 });

    const delta = await (await app.request(`/api/events?since=${body.evs[0][0]}`)).json();
    expect(delta.e.length).toBe(1);
    expect((await (await app.request(`/api/events?since=999`)).json()).reload).toBe(true);

    const log = await (await app.request('/api/log')).json();
    expect(log.ev).toEqual([3, 7, 5, 3, 7, 9]);
  });

  it('rebuilds the board from the event log after a restart', async () => {
    const app = boot();
    await place(app, { d: D1, x: 1, y: 2, colour: 3 });
    inst!.close();
    inst = createApp({ dataDir: dir, limits: { ipPerMin: 1000, ipDaily: 100_000 }, now: () => t });
    const s = await (await inst.app.request('/api/state')).json();
    expect((await boardOf(inst.app))[2 * W + 1]).toBe(3);
    expect(s.pixels).toBe(1);
  });

  it('spends the 64-pixel bank, refills it over time, and keeps it across a restart', async () => {
    const app = boot();
    for (let i = 0; i < BANK_SIZE; i++) expect((await place(app, { d: D2, x: i, y: 0, colour: 1 })).status).toBe(200);
    const empty = await place(app, { d: D2, x: 0, y: 1, colour: 1 });
    expect(empty.status).toBe(429);
    expect(await empty.json()).toMatchObject({ error: 'empty', retryMs: REGEN_MS });
    inst!.close();
    inst = createApp({ dataDir: dir, limits: { ipPerMin: 1000, ipDaily: 100_000 }, now: () => t });
    expect((await place(inst.app, { d: D2, x: 0, y: 1, colour: 1 })).status).toBe(429); // restart did not refill it
    t += REGEN_MS;
    expect((await place(inst.app, { d: D2, x: 0, y: 1, colour: 1 })).status).toBe(200);
  });

  it('places a whole batch at once, but never more than the bank holds', async () => {
    const app = boot();
    const batch = (n: number, y: number) => Array.from({ length: n }, (_, i) => [i, y, 4]);
    const r1 = await (await post(app, { d: D1, pixels: batch(60, 0) })).json();
    expect(r1.evs.length).toBe(60);
    expect(r1.tokens).toBe(BANK_SIZE - 60);
    const r2 = await (await post(app, { d: D1, pixels: batch(10, 1) })).json();
    expect(r2.evs.length).toBe(4); // only 4 left in the bank
    expect((await post(app, { d: D1, pixels: batch(1, 2) })).status).toBe(429);
    expect((await post(app, { d: D2, pixels: batch(BANK_SIZE + 1, 3) })).status).toBe(400);
    expect((await post(app, { d: D2, pixels: [] })).status).toBe(400);
    expect((await post(app, { d: D2, pixels: [[0, 0, 1], [W, 0, 1]] })).status).toBe(400); // one bad pixel rejects the batch
    const s = await (await app.request('/api/state')).json();
    expect(s.pixels).toBe(64);
  });

  it('reports how busy a pixel has been', async () => {
    const app = boot();
    await place(app, { d: D1, x: 9, y: 9, colour: 1 });
    await place(app, { d: D2, x: 9, y: 9, colour: 2 });
    const info = await (await app.request('/api/pixel?x=9&y=9')).json();
    expect(info).toMatchObject({ x: 9, y: 9, colour: 2, times: 2, ts: t });
    expect(await (await app.request('/api/pixel?x=0&y=0')).json()).toMatchObject({ times: 0, ts: null, colour: EMPTY });
    expect((await app.request(`/api/pixel?x=${W}&y=0`)).status).toBe(400);
  });

  it('renders the link preview and icons as real PNGs', async () => {
    const app = boot();
    await place(app, { d: D1, x: 500, y: 500, colour: 5 });
    for (const [path, w, h] of [['/og.png', 1200, 630], ['/icon-192.png', 192, 192], ['/icon-512.png', 512, 512]] as const) {
      const r = await app.request(path);
      expect(r.headers.get('content-type')).toBe('image/png');
      const b = Buffer.from(await r.arrayBuffer());
      expect(b.subarray(1, 4).toString()).toBe('PNG');
      expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([w, h]);
      const rows = inflateSync(b.subarray(41, b.length - 12)); // IDAT payload (single chunk)
      expect(rows.length).toBe((w * 3 + 1) * h);
    }
  });

  it('lets people pick a unique name that pixel info shows', async () => {
    const app = boot();
    const setName = (d: string, name: unknown) =>
      app.request('/api/name', { method: 'POST', body: JSON.stringify({ d, name }), headers: { 'content-type': 'application/json' } });
    expect((await setName(D1, '  Ada   Lovelace ')).status).toBe(200);
    expect((await (await app.request(`/api/state?d=${D1}`)).json()).name).toBe('Ada Lovelace');
    expect((await setName(D2, 'ada lovelace')).status).toBe(409); // taken, ignoring case
    expect((await setName(D2, 'x')).status).toBe(400); // too short
    expect((await setName(D2, '<script>')).status).toBe(400);
    expect((await setName(D2, '...')).status).toBe(400); // needs a letter or digit
    expect((await setName(D2, 42)).status).toBe(400);
    await place(app, { d: D1, x: 4, y: 4, colour: 1 });
    expect((await (await app.request('/api/pixel?x=4&y=4')).json()).by).toBe('Ada Lovelace');
    await place(app, { d: D2, x: 4, y: 4, colour: 2 });
    expect((await (await app.request('/api/pixel?x=4&y=4')).json()).by).toBeNull(); // last painter is anonymous
    expect((await setName(D1, 'Ada')).status).toBe(200); // renaming frees the old name
    expect((await setName(D2, 'Ada Lovelace')).status).toBe(200);
    const auth = { authorization: 'Bearer s3cret', 'content-type': 'application/json' };
    await app.request('/api/admin/clear-name', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'ADA' }) });
    expect((await (await app.request(`/api/state?d=${D1}`)).json()).name).toBeNull();
  });

  it('lets the admin roll an area back in time or wipe it', async () => {
    const app = boot();
    await place(app, { d: D1, x: 10, y: 10, colour: 1 }); // the "good" art
    const before = t;
    t += 60_000;
    await place(app, { d: D2, x: 10, y: 10, colour: 3 }); // vandalism on top
    await place(app, { d: D2, x: 50, y: 50, colour: 3 }); // outside the area
    const auth = { authorization: 'Bearer s3cret', 'content-type': 'application/json' };
    const erase = (body: object) => app.request('/api/admin/erase', { method: 'POST', headers: auth, body: JSON.stringify(body) });
    expect((await erase({ x: 0, y: 0, w: 20, h: 20, since: before + 1 })).status).toBe(200);
    let s = await (await app.request('/api/state')).json();
    expect((await boardOf(app))[10 * W + 10]).toBe(1); // back to how it was
    expect((await boardOf(app))[50 * W + 50]).toBe(3); // untouched
    expect(await (await erase({ x: 0, y: 0, w: 20, h: 20 })).json()).toMatchObject({ deleted: 1 });
    s = await (await app.request('/api/state')).json();
    expect((await boardOf(app))[10 * W + 10]).toBe(EMPTY);
    expect((await erase({ x: W - 5, y: 0, w: 10, h: 1 })).status).toBe(400); // off the canvas
    expect((await app.request('/api/admin/erase', { method: 'POST', body: '{}' })).status).toBe(404); // needs the secret
  });

  it('serves the board as one cached gzip and says which events it includes', async () => {
    const app = boot();
    await place(app, { d: D1, x: 2, y: 2, colour: 6 });
    const r1 = await app.request('/api/board');
    expect(r1.headers.get('content-encoding')).toBe('gzip');
    const id1 = Number(r1.headers.get('x-last-id'));
    expect(gunzipSync(Buffer.from(await r1.arrayBuffer()))[2 * W + 2]).toBe(6);
    await place(app, { d: D2, x: 3, y: 3, colour: 6 });
    // within a second the cached copy is reused, and its x-last-id tells the client to stream the rest
    const r2 = await app.request('/api/board');
    expect(Number(r2.headers.get('x-last-id'))).toBe(id1);
    expect((await (await app.request(`/api/events?since=${id1}`)).json()).e.length).toBe(1);
    t += 1000;
    expect((await boardOf(app))[3 * W + 3]).toBe(6);
  });

  it('ranks named painters on the leaderboard', async () => {
    const app = boot();
    const setName = (d: string, name: string) =>
      app.request('/api/name', { method: 'POST', body: JSON.stringify({ d, name }), headers: { 'content-type': 'application/json' } });
    await setName(D1, 'Ada');
    await setName(D2, 'Bo');
    await post(app, { d: D1, pixels: [[1, 1, 1], [2, 1, 1], [3, 1, 1]] });
    await post(app, { d: D2, pixels: [[1, 2, 1]] });
    await post(app, { d: '33333333-3333-4333-8333-333333333333', pixels: [[1, 3, 1], [2, 3, 1], [3, 3, 1], [4, 3, 1]] }); // anonymous: not listed
    const l = await (await app.request('/api/leaders')).json();
    expect(l.all).toEqual([{ name: 'Ada', n: 3 }, { name: 'Bo', n: 1 }]);
    expect(l.today).toEqual(l.all);
  });

  it('backs up to file storage on the scheduler\'s call and keeps 14', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pixelworld-'));
    inst = createApp({ dataDir: dir, limits: { ipPerMin: 1000, ipDaily: 100_000 }, now: () => t, cronSecret: 'cron', storage: { url: 'https://store.test', token: 'tok', app: 'pw' } });
    const app = inst.app;
    await place(app, { d: D1, x: 1, y: 1, colour: 1 });
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? 'GET', url });
      if (init.method === 'PUT') return new Response('{}', { status: 201 });
      if (!init.method) return Response.json({ files: Array.from({ length: 16 }, (_, i) => ({ id: `f${i}`, filename: `backup-${i}.json.gz` })) });
      return new Response('{}');
    });
    try {
      expect((await app.request('/tasks/backup')).status).toBe(401);
      const r = await app.request('/tasks/backup', { headers: { authorization: 'Bearer cron' } });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Backed up 1 events');
      expect(calls[0]).toMatchObject({ method: 'PUT', url: expect.stringMatching(/^https:\/\/store\.test\/apps\/pw\/files\/backup-\d{4}-\d{2}-\d{2}\.json\.gz$/) });
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['https://store.test/apps/pw/files/f14', 'https://store.test/apps/pw/files/f15']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('protects admin endpoints', async () => {
    const app = boot();
    await place(app, { d: D1, x: 5, y: 5, colour: 1 });
    expect((await app.request('/api/admin/reset', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/admin/reset', { method: 'POST', headers: { authorization: 'Bearer wrong!' } })).status).toBe(404);
    const auth = { authorization: 'Bearer s3cret', 'content-type': 'application/json' };
    const purge = await app.request('/api/admin/purge', { method: 'POST', headers: auth, body: JSON.stringify({ device: D1 }) });
    expect((await purge.json()).deleted).toBe(1);
    const s = await (await app.request('/api/state')).json();
    expect(s.pixels).toBe(0);
    expect((await boardOf(app))[5 * W + 5]).toBe(EMPTY);
    expect((await app.request('/api/admin/export', { headers: auth })).status).toBe(200);
  });
});
