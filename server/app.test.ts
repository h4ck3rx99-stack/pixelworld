import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
let t = Date.UTC(2026, 10, 23, 10, 0);
let dir = '';
let inst: ReturnType<typeof createApp> | null = null;

function boot() {
  dir = mkdtempSync(join(tmpdir(), 'rangoli-'));
  inst = createApp({ dataDir: dir, adminSecret: 's3cret', limits: { cooldownMs: 4000, ipPerMin: 100, deviceDaily: 100, ipDaily: 100 }, now: () => t });
  return inst.app;
}
afterEach(() => {
  inst?.close();
  rmSync(dir, { recursive: true, force: true });
});
const place = (app: ReturnType<typeof boot>, body: object) =>
  app.request('/api/place', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' } });

describe('server', () => {
  it('places, enforces cooldown, validates, and serves deltas', async () => {
    const app = boot();
    const ok = await place(app, { d: D1, ring: 3, slot: 1, piece: 2, colour: 4 });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.mine).toBe(1);
    expect(body.ev.slice(1, 5)).toEqual([3, 1, 2, 4]);

    expect((await place(app, { d: D1, ring: 3, slot: 0, piece: 0, colour: 0 })).status).toBe(429);
    expect((await place(app, { d: D2, ring: 3, slot: 99, piece: 0, colour: 0 })).status).toBe(400);
    expect((await place(app, { d: 'nope', ring: 3, slot: 0, piece: 0, colour: 0 })).status).toBe(400);

    t += 4000;
    expect((await place(app, { d: D1, ring: 3, slot: 1, piece: 0, colour: 0 })).status).toBe(200); // replaces the cell

    const state = await (await app.request(`/api/state?d=${D1}`)).json();
    expect(state.cells.length).toBe(1);
    expect(state.cells[0][3]).toBe(0);
    expect(state.pieces).toBe(2);
    expect(state.people).toBe(1);
    expect(state.mine).toBe(2);

    const delta = await (await app.request(`/api/events?since=${body.ev[0]}&day=${state.day}`)).json();
    expect(delta.e.length).toBe(1);
    expect((await (await app.request(`/api/events?since=0&day=2001-01-01`)).json()).reload).toBe(true);
  });

  it('rolls over at midnight IST and archives the day', async () => {
    const app = boot();
    await place(app, { d: D1, ring: 5, slot: 0, piece: 1, colour: 1 });
    const day1 = (await (await app.request('/api/state')).json()).day;
    t = Date.UTC(2026, 10, 23, 18, 30); // 00:00 IST
    const s = await (await app.request('/api/state')).json();
    expect(s.day).not.toBe(day1);
    expect(s.cells.length).toBe(0);
    const days = await (await app.request('/api/days')).json();
    expect(days.past[0]).toMatchObject({ day: day1, pieces: 1, people: 1 });
    const snap = await (await app.request(`/api/day/${day1}/snapshot`)).json();
    expect(snap.cells.length).toBe(1);
    const log = await (await app.request(`/api/day/${day1}/log`)).json();
    expect(log.ev).toEqual([5, 0, 1, 1]);
  });

  it('protects admin endpoints', async () => {
    const app = boot();
    await place(app, { d: D1, ring: 5, slot: 0, piece: 1, colour: 1 });
    expect((await app.request('/api/admin/reset', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/admin/reset', { method: 'POST', headers: { authorization: 'Bearer wrong!' } })).status).toBe(404);
    const auth = { authorization: 'Bearer s3cret', 'content-type': 'application/json' };
    const purge = await app.request('/api/admin/purge', { method: 'POST', headers: auth, body: JSON.stringify({ device: D1 }) });
    expect((await purge.json()).deleted).toBe(1);
    expect((await (await app.request('/api/state')).json()).pieces).toBe(0);
    expect((await app.request('/api/admin/export', { headers: auth })).status).toBe(200);
  });
});
