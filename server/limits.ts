import { istDay } from '../shared/grid.ts';

export type LimitConfig = { cooldownMs: number; ipPerMin: number; deviceDaily: number; ipDaily: number };
export type Verdict = { ok: true } | { ok: false; reason: 'cooldown' | 'rate' | 'daily'; retryMs: number };

const SLACK_MS = 250; // network jitter between the client's timer and ours

/** In-memory cooldown, per-IP rate limit and daily caps. Lost on restart, which only ever errs toward allowing. */
export class Limiter {
  private last = new Map<string, number>();
  private ipWin = new Map<string, { start: number; n: number }>();
  private daily = new Map<string, number>();
  private day = '';

  cfg: LimitConfig;
  constructor(cfg: LimitConfig) {
    this.cfg = cfg;
  }

  /** Checks every limit and, if all pass, records the placement. */
  take(device: string, ip: string, now: number): Verdict {
    const day = istDay(now);
    if (day !== this.day) (this.day = day), this.daily.clear();

    const wait = (this.last.get(device) ?? -Infinity) + this.cfg.cooldownMs - SLACK_MS - now;
    if (wait > 0) return { ok: false, reason: 'cooldown', retryMs: Math.ceil(wait + SLACK_MS) };

    let w = this.ipWin.get(ip);
    if (!w || now - w.start >= 60_000) w = { start: now, n: 0 };
    if (w.n >= this.cfg.ipPerMin) return { ok: false, reason: 'rate', retryMs: w.start + 60_000 - now };

    const dk = 'd:' + device, ik = 'i:' + ip;
    if ((this.daily.get(dk) ?? 0) >= this.cfg.deviceDaily || (this.daily.get(ik) ?? 0) >= this.cfg.ipDaily)
      return { ok: false, reason: 'daily', retryMs: 0 };

    this.last.set(device, now);
    w.n++;
    this.ipWin.set(ip, w);
    this.daily.set(dk, (this.daily.get(dk) ?? 0) + 1);
    this.daily.set(ik, (this.daily.get(ik) ?? 0) + 1);
    return { ok: true };
  }

  cooldownLeft(device: string, now: number) {
    return Math.max(0, (this.last.get(device) ?? -Infinity) + this.cfg.cooldownMs - now);
  }

  prune(now: number) {
    for (const [k, t] of this.last) if (now - t > this.cfg.cooldownMs) this.last.delete(k);
    for (const [k, w] of this.ipWin) if (now - w.start >= 60_000) this.ipWin.delete(k);
  }
}
