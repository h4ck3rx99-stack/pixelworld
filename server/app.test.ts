import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
const boardOf = (s: { board: string }) => new Uint8Array(Buffer.from(s.board, 'base64'));

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
    const board = boardOf(state);
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
    expect(boardOf(s)[2 * W + 1]).toBe(3);
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
    expect(boardOf(s)[5 * W + 5]).toBe(EMPTY);
    expect((await app.request('/api/admin/export', { headers: auth })).status).toBe(200);
  });
});
