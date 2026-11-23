import { BANK_SIZE, REGEN_MS, utcDay } from '../shared/pixels.ts';

export type LimitConfig = { ipPerMin: number; ipDaily: number };
export type Verdict = { ok: true; tokens: number } | { ok: false; reason: 'empty' | 'rate' | 'daily'; retryMs: number; tokens: number };
export type Bank = { tokens: number; at: number };
/** Where banks live; the server backs this with SQLite so a restart doesn't refill everyone. */
export type BankStore = { get(device: string): Bank | undefined; set(device: string, b: Bank): void };

const memoryStore = (): BankStore => {
  const m = new Map<string, Bank>();
  return { get: (d) => m.get(d), set: (d, b) => void m.set(d, b) };
};

/** Tokens a bank holds at `now`: starts full, refills one per REGEN_MS, never above BANK_SIZE. */
export const tokensAt = (b: Bank | undefined, now: number) =>
  b ? Math.min(BANK_SIZE, b.tokens + Math.max(0, now - b.at) / REGEN_MS) : BANK_SIZE;

/** Per-device pixel bank plus per-IP rate limit and daily cap (those two are in memory). */
export class Limiter {
  private ipWin = new Map<string, { start: number; n: number }>();
  private daily = new Map<string, number>();
  private day = '';
  cfg: LimitConfig;
  store: BankStore;

  constructor(cfg: LimitConfig, store: BankStore = memoryStore()) {
    this.cfg = cfg;
    this.store = store;
  }

  tokens(device: string, now: number) {
    return tokensAt(this.store.get(device), now);
  }

  /** Checks every limit and, if all pass, spends one pixel from the device's bank. */
  take(device: string, ip: string, now: number): Verdict {
    const day = utcDay(now);
    if (day !== this.day) (this.day = day), this.daily.clear();

    const tokens = this.tokens(device, now);
    if (tokens < 1) return { ok: false, reason: 'empty', retryMs: Math.ceil((1 - tokens) * REGEN_MS), tokens };

    let w = this.ipWin.get(ip);
    if (!w || now - w.start >= 60_000) w = { start: now, n: 0 };
    if (w.n >= this.cfg.ipPerMin) return { ok: false, reason: 'rate', retryMs: w.start + 60_000 - now, tokens };
    if ((this.daily.get(ip) ?? 0) >= this.cfg.ipDaily) return { ok: false, reason: 'daily', retryMs: 0, tokens };

    this.store.set(device, { tokens: tokens - 1, at: now });
    w.n++;
    this.ipWin.set(ip, w);
    this.daily.set(ip, (this.daily.get(ip) ?? 0) + 1);
    return { ok: true, tokens: tokens - 1 };
  }

  prune(now: number) {
    for (const [k, w] of this.ipWin) if (now - w.start >= 60_000) this.ipWin.delete(k);
  }
}
