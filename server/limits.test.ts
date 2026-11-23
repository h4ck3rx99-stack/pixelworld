import { describe, expect, it } from 'vitest';
import { Limiter } from './limits.ts';

const cfg = { cooldownMs: 4000, ipPerMin: 5, deviceDaily: 3, ipDaily: 100 };
const T = Date.UTC(2026, 10, 23, 10, 0);

describe('Limiter', () => {
  it('enforces a 4s cooldown per device', () => {
    const l = new Limiter({ ...cfg, deviceDaily: 99 });
    expect(l.take('a', 'ip', T).ok).toBe(true);
    const v = l.take('a', 'ip', T + 1000);
    expect(v).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(v.ok === false && v.retryMs).toBe(3000);
    expect(l.take('b', 'ip', T + 1000).ok).toBe(true); // other device unaffected
    expect(l.take('a', 'ip', T + 3800).ok).toBe(true); // within jitter slack
  });

  it('rejected attempts do not reset the cooldown', () => {
    const l = new Limiter({ ...cfg, deviceDaily: 99 });
    l.take('a', 'ip', T);
    l.take('a', 'ip', T + 3000);
    expect(l.take('a', 'ip', T + 4000).ok).toBe(true);
  });

  it('rate limits an IP across many devices, then recovers', () => {
    const l = new Limiter({ ...cfg, deviceDaily: 99 });
    for (let i = 0; i < 5; i++) expect(l.take('d' + i, 'ip', T + i).ok).toBe(true);
    expect(l.take('d9', 'ip', T + 10)).toMatchObject({ ok: false, reason: 'rate' });
    expect(l.take('d9', 'other-ip', T + 10).ok).toBe(true);
    expect(l.take('d9', 'ip', T + 60_000).ok).toBe(true);
  });

  it('caps a device per UTC day and resets at midnight UTC', () => {
    const l = new Limiter(cfg);
    for (let i = 0; i < 3; i++) expect(l.take('a', 'ip' + i, T + i * 5000).ok).toBe(true);
    expect(l.take('a', 'ipx', T + 20_000)).toMatchObject({ ok: false, reason: 'daily' });
    expect(l.take('a', 'ipx', Date.UTC(2026, 10, 23, 23, 59)).ok).toBe(false);
    expect(l.take('a', 'ipx', Date.UTC(2026, 10, 24, 0, 0)).ok).toBe(true);
  });
});
