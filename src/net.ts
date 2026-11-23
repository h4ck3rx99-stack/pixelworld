import type { WireEvent } from '../shared/grid.ts';

export type Stats = { pieces: number; people: number; online: number };
export type State = Stats & { day: string; dayNo: number; lastId: number; cells: WireEvent[]; mine: number; cooldownMs: number; resetAt: number };
type Msg = Partial<Stats> & { e?: WireEvent[]; lastId?: number; reload?: boolean };

const KEY = 'rl.device';
export const deviceId: string = (() => {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) localStorage.setItem(KEY, (id = crypto.randomUUID()));
    return id;
  } catch {
    return crypto.randomUUID();
  }
})();

/** Same short hash the server stores as `who`, so we can spot our own pieces. */
export async function myWho() {
  if (!crypto.subtle) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceId));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 10);
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

export async function postJSON(url: string, body: object) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/**
 * Live updates. Tries Server-Sent Events; if no hello arrives within 4s or the stream keeps
 * failing (e.g. a buffering proxy), falls back to polling /api/events every second.
 * (WebSockets are not offered: Embarko does not support them.)
 */
export class Live {
  mode: 'sse' | 'poll' | 'connecting' = 'connecting';
  private es: EventSource | null = null;
  private pollTimer = 0;
  private errors: number[] = [];

  constructor(
    private get: () => { day: string; lastId: number },
    private onMsg: (m: Msg) => void,
    private onMode: (mode: string) => void,
  ) {}

  start() {
    const forced = new URLSearchParams(location.search).get('transport');
    if (forced === 'poll' || typeof EventSource === 'undefined') return this.poll();
    this.sse();
  }

  private setMode(m: 'sse' | 'poll') {
    this.mode = m;
    this.onMode(m);
  }

  private sse() {
    const { day, lastId } = this.get();
    const es = (this.es = new EventSource(`/api/stream?since=${lastId}&day=${day}`));
    const giveUp = setTimeout(() => this.mode === 'connecting' && this.fallback(), 4000);
    es.addEventListener('hello', () => {
      clearTimeout(giveUp);
      this.setMode('sse');
    });
    es.addEventListener('reload', () => this.onMsg({ reload: true }));
    es.onmessage = (ev) => this.onMsg(JSON.parse(ev.data));
    es.onerror = () => {
      const t = Date.now();
      this.errors = [...this.errors.filter((x) => t - x < 30_000), t];
      if (this.errors.length >= 3) this.fallback();
    };
  }

  private fallback() {
    this.es?.close();
    this.es = null;
    this.poll();
  }

  private poll() {
    this.setMode('poll');
    const tick = async () => {
      if (!document.hidden) {
        try {
          const { day, lastId } = this.get();
          this.onMsg(await getJSON<Msg>(`/api/events?since=${lastId}&day=${day}`));
        } catch {
          /* offline for a moment: next tick retries */
        }
      }
      this.pollTimer = window.setTimeout(tick, 1000);
    };
    tick();
  }

  /** After a reload the stream must restart from the new lastId. */
  restart() {
    if (this.mode === 'sse' && this.es) {
      this.es.close();
      this.mode = 'connecting';
      this.sse();
    }
  }

  stop() {
    this.es?.close();
    clearTimeout(this.pollTimer);
  }
}
