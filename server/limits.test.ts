import { describe, expect, it } from 'vitest';
import { BANK_SIZE, REGEN_MS } from '../shared/pixels.ts';
import { Limiter } from './limits.ts';

const cfg = { ipPerMin: 1000, ipDaily: 100_000 };
const T = Date.UTC(2026, 10, 23, 10, 0);

describe('pixel bank', () => {
  it('starts full, empties, then refills one pixel per REGEN_MS', () => {
    const l = new Limiter(cfg);
    for (let i = 0; i < BANK_SIZE; i++) expect(l.take('a', 'ip' + (i % 9), T).ok).toBe(true);
    const v = l.take('a', 'ip', T);
    expect(v).toMatchObject({ ok: false, reason: 'empty', retryMs: REGEN_MS });
    expect(l.take('b', 'ip', T).ok).toBe(true); // other devices have their own bank
    expect(l.take('a', 'ip', T + REGEN_MS - 1).ok).toBe(false);
    expect(l.take('a', 'ip', T + REGEN_MS).ok).toBe(true);
    expect(l.take('a', 'ip', T + REGEN_MS).ok).toBe(false);
  });

  it('never refills above the bank size', () => {
    const l = new Limiter(cfg);
    l.take('a', 'ip', T);
    expect(l.tokens('a', T + REGEN_MS * 1000)).toBe(BANK_SIZE);
  });

  it('rejected attempts do not spend pixels', () => {
    const l = new Limiter({ ...cfg, ipPerMin: 1 });
    l.take('a', 'ip', T);
    expect(l.take('a', 'ip', T)).toMatchObject({ ok: false, reason: 'rate' });
    expect(l.tokens('a', T)).toBe(BANK_SIZE - 1);
  });
});

describe('IP limits', () => {
  it('rate limits an IP across many devices, then recovers', () => {
    const l = new Limiter({ ...cfg, ipPerMin: 5 });
    for (let i = 0; i < 5; i++) expect(l.take('d' + i, 'ip', T + i).ok).toBe(true);
    expect(l.take('d9', 'ip', T + 10)).toMatchObject({ ok: false, reason: 'rate' });
    expect(l.take('d9', 'other-ip', T + 10).ok).toBe(true);
    expect(l.take('d9', 'ip', T + 60_000).ok).toBe(true);
  });

  it('caps an IP per UTC day and resets at midnight UTC', () => {
    const l = new Limiter({ ...cfg, ipDaily: 3 });
    for (let i = 0; i < 3; i++) expect(l.take('d' + i, 'ip', T).ok).toBe(true);
    expect(l.take('d9', 'ip', T)).toMatchObject({ ok: false, reason: 'daily' });
    expect(l.take('d9', 'ip', Date.UTC(2026, 10, 24, 0, 0)).ok).toBe(true);
  });
});
