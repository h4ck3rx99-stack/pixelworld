import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BANK_SIZE, EMPTY, REGEN_MS, SIZE } from '../shared/pixels.ts';
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
const place = (app: App, body: object) =>
  app.request('/api/place', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' } });
const boardOf = (s: { board: string }) => new Uint8Array(Buffer.from(s.board, 'base64'));

describe('server', () => {
  it('places, validates, and serves deltas', async () => {
    const app = boot();
    const ok = await place(app, { d: D1, x: 3, y: 7, colour: 5 });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.mine).toBe(1);
    expect(body.tokens).toBe(BANK_SIZE - 1);
    expect(body.ev.slice(1, 4)).toEqual([3, 7, 5]);

    expect((await place(app, { d: D2, x: SIZE, y: 0, colour: 0 })).status).toBe(400);
    expect((await place(app, { d: 'nope', x: 0, y: 0, colour: 0 })).status).toBe(400);

    expect((await place(app, { d: D1, x: 3, y: 7, colour: 9 })).status).toBe(200); // overwrites the pixel

    const state = await (await app.request(`/api/state?d=${D1}`)).json();
    const board = boardOf(state);
    expect(board.length).toBe(SIZE * SIZE);
    expect(board[7 * SIZE + 3]).toBe(9);
    expect(board[0]).toBe(EMPTY);
    expect(state).toMatchObject({ pixels: 2, people: 1, mine: 2, myPixels: [7 * SIZE + 3], tokens: BANK_SIZE - 2 });

    const delta = await (await app.request(`/api/events?since=${body.ev[0]}`)).json();
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
    expect(boardOf(s)[2 * SIZE + 1]).toBe(3);
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
    expect(boardOf(s)[5 * SIZE + 5]).toBe(EMPTY);
    expect((await app.request('/api/admin/export', { headers: auth })).status).toBe(200);
  });
});
