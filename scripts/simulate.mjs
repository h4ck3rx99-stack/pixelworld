// LOCAL-ONLY load simulator. It starts its own throwaway server on 127.0.0.1 with a temp
// database and drives fake clients against it. It takes no URL, so it cannot touch production.
//
//   node scripts/simulate.mjs [--clients 50] [--transport mixed|sse|poll] [--seconds 60] [--seed 0] [--keep]
//
// --seed N   pre-fills the canvas with N pixels (e.g. 6000) to test load and the timelapse
// --keep     leaves the server running afterwards so you can open it in a browser (run `npm run build` first)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true;
};
const CLIENTS = Number(arg('clients', 50));
const TRANSPORT = arg('transport', 'mixed');
const SECONDS = Number(arg('seconds', 60));
const SEED = Number(arg('seed', 0));
const KEEP = arg('keep', false) === true;
const PORT = 8790 + Math.floor(Math.random() * 100);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
if (new URL(BASE).hostname !== '127.0.0.1') throw new Error('simulator only runs against its own local server');

const W = 2400, H = 1350, COLOURS = 254; // must mirror PALETTE.length in shared/pixels.ts
const rnd = (n) => Math.floor(Math.random() * n);
// Each fake person "draws": a short random walk in one colour, so the canvas looks used rather than noisy.
const walker = () => {
  let x = rnd(W), y = rnd(H), colour = rnd(COLOURS);
  return () => {
    if (Math.random() < 0.04) (x = rnd(W)), (y = rnd(H)), (colour = rnd(COLOURS));
    x = (x + rnd(3) - 1 + W) % W;
    y = (y + rnd(3) - 1 + H) % H;
    return [x, y, colour];
  };
};

const dataDir = mkdtempSync(join(tmpdir(), 'pixelworld-sim-'));
const server = spawn(process.execPath, ['server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, IP_PER_MIN: '1000000', IP_DAILY: '100000000', ADMIN_SECRET: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const stop = () => {
  server.kill();
  setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 500);
};
process.on('SIGINT', () => (stop(), process.exit()));

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const stats = { placed: 0, rejected: 0, deliveries: 0, lat: [], errors: 0 };
const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const take = (events) => {
  const now = Date.now();
  for (const e of events) { stats.lat.push(now - e[5]); stats.deliveries++; if (now - e[5] > 3000) stats.old = (stats.old ?? 0) + 1; }
};

async function sseClient(state, signal) {
  const res = await fetch(`${BASE}/api/stream?since=${state.lastId}`, { signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').find((l) => l.startsWith('data:'));
      if (data && !block.includes('event:')) take(JSON.parse(data.slice(5)).e ?? []);
    }
  }
}

async function pollClient(state, signal) {
  while (!signal.aborted) {
    try {
      const m = await (await fetch(`${BASE}/api/events?since=${state.lastId}`, { signal })).json();
      if (m.e) take(m.e), (state.lastId = m.lastId);
    } catch { if (!signal.aborted) stats.errors++; }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function client(i, signal) {
  const d = randomUUID();
  const s = await (await fetch(`${BASE}/api/state?d=${d}`)).json();
  const state = { lastId: s.lastId };
  const next = walker();
  const mode = TRANSPORT === 'mixed' ? (i % 2 ? 'sse' : 'poll') : TRANSPORT;
  (mode === 'sse' ? sseClient : pollClient)(state, signal).catch(() => !signal.aborted && stats.errors++);
  post('/api/hello', { d });
  const hb = setInterval(() => post('/api/hello', { d }), 15_000);
  signal.addEventListener('abort', () => clearInterval(hb));
  await new Promise((r) => setTimeout(r, Math.random() * 4000));
  while (!signal.aborted) {
    // draft a short stroke, then place it in one batch
    const r = await post('/api/place', { d, pixels: Array.from({ length: 3 + rnd(6) }, next) }).catch(() => null);
    const body = r?.ok ? await r.json() : null;
    body ? (stats.placed += body.evs.length) : stats.rejected++;
    await new Promise((res) => setTimeout(res, 6000 + Math.random() * 4000));
  }
}

const pct = (a, p) => (a.length ? a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

await waitUp();
if (SEED) {
  const t0 = Date.now();
  const batch = 200;
  const walkers = Array.from({ length: 60 }, walker);
  for (let n = 0; n < SEED; n += batch)
    await Promise.all(Array.from({ length: Math.min(batch, SEED - n) }, (_, k) => post('/api/place', { d: randomUUID(), pixels: [walkers[(n + k) % walkers.length]()] })));
  console.log(`seeded ${SEED} events in ${Date.now() - t0}ms`);
}
console.log(`simulating ${CLIENTS} clients (${TRANSPORT}) for ${SECONDS}s against ${BASE}`);
const ac = new AbortController();
for (let i = 0; i < CLIENTS; i++) client(i, ac.signal).catch(() => stats.errors++);
const report = setInterval(async () => {
  const h = await (await fetch(BASE + '/api/health')).json().catch(() => ({}));
  console.log(
    `placed ${stats.placed}  rejected ${stats.rejected}  deliveries ${stats.deliveries}  ` +
    `latency p50 ${pct(stats.lat, 0.5)}ms p95 ${pct(stats.lat, 0.95)}ms  sse ${h.clients}  rss ${Math.round((h.rss ?? 0) / 1e6)}MB  errors ${stats.errors} old ${stats.old ?? 0}`,
  );
}, 5000);
setTimeout(() => {
  ac.abort();
  clearInterval(report);
  const expected = stats.placed * CLIENTS;
  console.log(`done. each client should see every event: ~${expected} expected deliveries, got ${stats.deliveries}.`);
  if (KEEP) console.log(`server still running at ${BASE} (Ctrl+C to stop)`);
  else stop();
}, SECONDS * 1000);
