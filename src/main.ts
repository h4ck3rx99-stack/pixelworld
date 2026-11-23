import '@fontsource-variable/inter';
import './style.css';
import { BANK_SIZE, PALETTE, PALETTE_NAMES, REGEN_MS, SIZE, type WireEvent } from '../shared/pixels.ts';
import { chime, setSound, soundOn } from './audio.ts';
import { Board } from './board.ts';
import { deviceId, getJSON, Live, myWho, postJSON, type State } from './net.ts';
import { shareCard } from './share.ts';
import { openTimelapse } from './timelapse.ts';
import { $, closeTop, fmt, openPanel, store } from './ui.ts';

const board = new Board($<HTMLCanvasElement>('#board'));
const st = { lastId: 0, pixels: 0, people: 0, online: -1, mine: 0, since: 0 };
const ids = new Int32Array(SIZE * SIZE); // id of the last event applied to each pixel
const myPixels = new Set<number>();
let who = '';
let selected = -1;
let highlightUntil = 0;
let colour = (() => {
  const c = Number(store.get('pw.colour') ?? 5); // first visit: red, never white on white paper
  return Number.isInteger(c) && c >= 0 && c < PALETTE.length ? c : 5;
})();

// ---------- layout & view (pinch-zoom / pan) ----------
let zoom = 1, panX = 0, panY = 0, base = { cx: 0, cy: 0, s: 1 };
const maxZoom = () => Math.max(1, 44 / base.s); // up to ~44 css px per pixel
function layout() {
  const w = innerWidth, h = innerHeight;
  const top = $('#top').getBoundingClientRect().bottom;
  const bottom = $('#sheet').getBoundingClientRect().top;
  document.documentElement.style.setProperty('--sheet-h', `${h - bottom}px`);
  const avail = Math.max(120, bottom - top);
  base = { cx: w / 2, cy: top + avail / 2, s: Math.max(0.5, Math.min(w - 16, avail - 16) / SIZE) };
  zoom = Math.min(zoom, maxZoom());
  board.resize(w, h, view());
}
const view = () => ({ cx: base.cx + panX, cy: base.cy + panY, s: base.s * zoom });
function setZoom(z: number, ax: number, ay: number) {
  const v = view();
  const mx = (ax - v.cx) / v.s, my = (ay - v.cy) / v.s;
  zoom = Math.min(maxZoom(), Math.max(1, z));
  panX = ax - base.cx - mx * base.s * zoom;
  panY = ay - base.cy - my * base.s * zoom;
  clampPan();
}
function clampPan() {
  const lim = (base.s * SIZE * (zoom - 1)) / 2;
  panX = Math.max(-lim, Math.min(lim, panX));
  panY = Math.max(-lim, Math.min(lim, panY));
  board.setView(view());
}
function animateZoom(z1: number, ax: number, ay: number) {
  const z0 = zoom, t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / 260), e = 1 - Math.pow(1 - k, 3);
    setZoom(z0 + (z1 - z0) * e, ax, ay);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const pts = new Map<number, { x: number; y: number; x0: number; y0: number }>();
let pinch: { d: number; z: number } | null = null;
let moved = false;
let lastTap = { t: 0, x: 0, y: 0 };
const cv = board.cv;
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  if (pts.size === 1) moved = false;
  if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom };
    moved = true;
  }
});
cv.addEventListener('pointermove', (e) => {
  const p = pts.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;
  if (pinch && pts.size === 2) {
    const [a, b] = [...pts.values()];
    panX += dx / 2;
    panY += dy / 2;
    setZoom((pinch.z * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
  } else if (pts.size === 1 && (moved || Math.hypot(p.x - p.x0, p.y - p.y0) > 8)) {
    moved = true;
    if (zoom > 1) (panX += dx), (panY += dy), clampPan();
  }
});
const up = (e: PointerEvent) => {
  const p = pts.get(e.pointerId);
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch = null;
  if (!p || moved || e.type === 'pointercancel' || pts.size) return;
  const dbl = e.timeStamp - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40;
  lastTap = { t: e.timeStamp, x: p.x, y: p.y };
  dismissHint();
  if (dbl) return animateZoom(zoom > 1.5 ? 1 : Math.min(maxZoom(), 16 / base.s), p.x, p.y); // double-tap: dive in to ~16px pixels / back out
  select(board.pixelAt(p.x, p.y));
};
cv.addEventListener('pointerup', up);
cv.addEventListener('pointercancel', up);
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });

// ---------- selecting & placing ----------
const placeBtn = $<HTMLButtonElement>('#place');
function select(i: number) {
  selected = i;
  paintPlace();
  board.kick();
}

// Pixel bank: start with BANK_SIZE, one comes back every REGEN_MS. The server enforces it; this mirrors it.
let bank = { tokens: BANK_SIZE, at: Date.now() };
let blockedUntil = 0; // set when the network as a whole is rate limited
let inflight = 0;
const tokensNow = () => Math.min(BANK_SIZE, bank.tokens + (Date.now() - bank.at) / REGEN_MS);
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.ceil(ms / 1000) % 60).padStart(2, '0')}`;

function paintPlace() {
  const t = tokensNow(), n = Math.floor(t);
  const wait = Math.max(blockedUntil - Date.now(), n < 1 ? (1 - t) * REGEN_MS : 0);
  placeBtn.disabled = selected < 0 || wait > 0;
  $('#place-label').textContent = wait > 0 ? `Next pixel in ${clock(wait)}` : selected < 0 ? 'Tap a pixel first' : 'Place pixel';
  $('#place-xy').textContent = selected < 0 ? '' : `${selected % SIZE}, ${(selected / SIZE) | 0}`;
  $('#bank b').textContent = String(n);
  $('#bank small').textContent = n < BANK_SIZE ? `+1 in ${clock((1 - (t % 1)) * REGEN_MS)}` : 'full';
  // the ring fills toward the next pixel
  $<SVGCircleElement>('#cdring .fg').style.strokeDashoffset = String(113.1 * (n < BANK_SIZE ? 1 - (t % 1) : 0));
  placeBtn.classList.toggle('cooling', n < BANK_SIZE);
}
setInterval(paintPlace, 250);

placeBtn.addEventListener('click', () => selected >= 0 && !placeBtn.disabled && place(selected));

async function place(i: number) {
  const prev = board.colours[i], prevId = ids[i];
  const c = colour;
  board.set(i, c);
  bank = { tokens: tokensNow() - 1, at: Date.now() };
  inflight++;
  navigator.vibrate?.(10);
  chime(c);
  paintPlace();
  let res;
  try {
    res = await postJSON('/api/place', { d: deviceId, x: i % SIZE, y: (i / SIZE) | 0, colour: c });
  } catch {
    res = { status: 0, body: {} };
  }
  inflight--;
  const b = res.body;
  // resync with the server's count once nothing else is on its way
  const synced = typeof b.tokens === 'number' && !inflight;
  if (synced) bank = { tokens: b.tokens, at: Date.now() };
  if (res.status === 200) {
    st.mine = b.mine;
    myPixels.add(i);
    setStats(b);
    applyEvent(b.ev, false);
    const n = Math.floor(tokensNow());
    toast(`+1 · ${n} pixel${n === 1 ? '' : 's'} left`, true);
    paintPlace();
    return;
  }
  // rejected: roll the optimistic pixel back unless someone has painted it since
  if (ids[i] === prevId) board.set(i, prev, false);
  if (!synced) bank = { tokens: tokensNow() + 1, at: Date.now() }; // give back the pixel we spent optimistically
  if (b.error === 'rate') blockedUntil = Date.now() + (b.retryMs ?? 0);
  paintPlace();
  toast(
    b.error === 'empty' ? 'Out of pixels. One comes back every 30 seconds.'
    : b.error === 'rate' ? 'Lots of pixels from your network right now. Try again in a moment.'
    : b.error === 'daily' ? "Your network hit today's limit. It resets at 00:00 UTC."
    : "Couldn't reach the canvas. Check your connection.",
  );
}

/** Applies a server event in id order; our own echo is already on screen, so it doesn't flash again. */
function applyEvent(e: WireEvent, flash = true) {
  const [id, x, y, c, w] = e;
  const i = y * SIZE + x;
  st.lastId = Math.max(st.lastId, id);
  if (id <= ids[i]) return;
  ids[i] = id;
  if (w === who) myPixels.add(i);
  else myPixels.delete(i);
  if (board.colours[i] !== c) board.set(i, c, flash && w !== who);
}

// ---------- live data ----------
function setStats(s: { pixels?: number; people?: number; online?: number }) {
  if (s.pixels != null) st.pixels = s.pixels;
  if (s.people != null) st.people = s.people;
  if (s.online != null) st.online = s.online;
  $('#online b').textContent = st.online < 0 ? 'Connecting…' : `${fmt(st.online)} online now`;
  $('#online').classList.toggle('live', st.online > 0);
  $('#stats').textContent = st.pixels
    ? `${fmt(st.pixels)} pixel${st.pixels === 1 ? '' : 's'} by ${fmt(st.people)} ${st.people === 1 ? 'person' : 'people'}`
    : 'A blank canvas. Be the first.';
}

async function loadState() {
  const s = await getJSON<State>(`/api/state?d=${deviceId}`);
  Object.assign(st, { lastId: s.lastId, mine: s.mine, since: s.since });
  ids.fill(0);
  myPixels.clear();
  s.myPixels.forEach((i) => myPixels.add(i));
  board.load(Uint8Array.from(atob(s.board), (ch) => ch.charCodeAt(0)));
  setStats(s);
  bank = { tokens: s.tokens, at: Date.now() };
  paintPlace();
}

const live = new Live(
  () => st,
  async (m) => {
    if (m.reload) {
      await loadState();
      live.restart();
      return;
    }
    for (const e of m.e ?? []) applyEvent(e);
    setStats(m);
  },
  (mode) => (document.documentElement.dataset.transport = mode),
);

async function hello() {
  if (document.hidden) return;
  try {
    setStats((await postJSON('/api/hello', { d: deviceId })).body);
  } catch { /* retried in 15s */ }
}

// ---------- overlay: selection reticle with colour preview, "show mine" pulses ----------
board.overlay = (g, now) => {
  const d = board.dpr;
  let more = false;
  if (selected >= 0) {
    const [x, y, w] = board.rectOf(selected);
    const r = Math.max(w, 6 * d);
    const ox = x + w / 2 - r / 2, oy = y + w / 2 - r / 2;
    if (!placeBtn.disabled) {
      g.globalAlpha = 0.75;
      g.fillStyle = PALETTE[colour];
      g.fillRect(ox, oy, r, r);
      g.globalAlpha = 1;
    }
    g.lineWidth = 3 * d;
    g.strokeStyle = '#0E1020';
    g.strokeRect(ox - 2 * d, oy - 2 * d, r + 4 * d, r + 4 * d);
    g.lineWidth = 1.5 * d;
    g.strokeStyle = '#FFFFFF';
    g.strokeRect(ox - 2 * d, oy - 2 * d, r + 4 * d, r + 4 * d);
  }
  if (now < highlightUntil) {
    const t = (highlightUntil - now) / 3000;
    const pulse = 0.5 + 0.5 * Math.sin(now / 120);
    g.strokeStyle = `rgba(255,217,59,${(0.55 + 0.45 * pulse) * Math.min(1, t * 3)})`;
    g.lineWidth = 2 * d;
    for (const i of myPixels) {
      const [x, y, w] = board.rectOf(i);
      const r = Math.max(w, 4 * d) + (4 + pulse * 4) * d;
      g.strokeRect(x + w / 2 - r / 2, y + w / 2 - r / 2, r, r);
    }
    more = true;
  }
  return more;
};

function showMine() {
  if (!myPixels.size) {
    toast(st.mine ? 'Your pixels have all been painted over. Place another!' : "You haven't placed a pixel yet.");
    return;
  }
  highlightUntil = performance.now() + 3000;
  board.kick();
}

// ---------- toast, hint ----------
let toastTimer = 0;
function toast(text: string, mine = false) {
  const t = $('#toast');
  $('#toast span').textContent = text;
  $('#toast button').hidden = !mine;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), mine ? 3200 : 2800);
}
$('#toast button').addEventListener('click', showMine);
$('#mine').addEventListener('click', showMine);

function dismissHint() {
  const h = $('#hint');
  if (h.hidden) return;
  h.classList.add('gone');
  setTimeout(() => (h.hidden = true), 400);
  store.set('pw.hint', '1');
}
if (!store.get('pw.hint')) $('#hint').hidden = false;

// ---------- palette ----------
const swatches = PALETTE.map((hex, i) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-label', PALETTE_NAMES[i]);
  b.title = PALETTE_NAMES[i];
  b.style.setProperty('--c', hex);
  b.append(document.createElement('i'));
  b.onclick = () => pick(i);
  $('#colours').append(b);
  return b;
});
function pick(c: number) {
  colour = c;
  store.set('pw.colour', String(c));
  swatches.forEach((b, i) => b.setAttribute('aria-checked', String(i === c)));
  placeBtn.style.setProperty('--c', PALETTE[c]);
  board.kick();
}

// ---------- top bar ----------
const soundBtn = $('#sound');
const paintSound = () => {
  soundBtn.setAttribute('aria-pressed', String(soundOn()));
  soundBtn.setAttribute('aria-label', soundOn() ? 'Sound on' : 'Sound off');
};
soundBtn.addEventListener('click', () => {
  setSound(!soundOn());
  paintSound();
  if (soundOn()) chime(colour);
});
$('#timelapse-btn').addEventListener('click', () => openTimelapse(false));
$('#about-btn').addEventListener('click', () => openPanel($('#about')));
$('#share-btn').addEventListener('click', async () => {
  const b = $<HTMLButtonElement>('#share-btn');
  b.disabled = true;
  try {
    await shareCard(board.px, { people: st.people, pixels: st.pixels, mine: st.mine });
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast("Couldn't make the share card. Try again.");
  }
  b.disabled = false;
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeTop()));

// ---------- boot ----------
pick(colour);
paintSound();
setStats({});
paintPlace();
layout();
addEventListener('resize', layout);
document.addEventListener('visibilitychange', hello);
(async () => {
  who = await myWho();
  for (let i = 0; ; i++) {
    try {
      await loadState();
      break;
    } catch {
      $('#online b').textContent = 'Reconnecting…';
      await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** i)));
    }
  }
  live.start();
  hello();
  setInterval(hello, 15_000);
  const q = new URLSearchParams(location.search);
  if (q.has('record') || q.has('timelapse')) openTimelapse(q.has('record'));
})();
