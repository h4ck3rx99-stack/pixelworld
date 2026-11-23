import '@fontsource-variable/fraunces';
import '@fontsource-variable/inter';
import './style.css';
import { cellAt, COLOUR_NAMES, COLOURS, PIECE_NAMES, PIECES, type WireEvent } from '../shared/grid.ts';
import { chime, setSound, soundOn } from './audio.ts';
import { deviceId, getJSON, Live, myWho, postJSON, type State } from './net.ts';
import { cellFromWire, copyCentres, keyOf, SPR, spr, type Cell } from './render.ts';
import { Stage } from './stage.ts';
import { openGallery, openTimelapse } from './gallery.ts';
import { shareCard } from './share.ts';
import { closeTop, openPanel, $, fmt, store } from './ui.ts';

const COOLDOWN = 4000;
const stage = new Stage($<HTMLCanvasElement>('#board'));
const st = { day: '', dayNo: 1, lastId: 0, pieces: 0, people: 0, online: -1, mine: 0 };
let who = '';
let cooldownUntil = 0;
let tapRing: { x: number; y: number; until: number } | null = null;
let highlightUntil = 0;
const pending = new Map<number, { local: Cell; prev?: Cell }>();
const sel = (() => {
  const [p, c] = (store.get('rl.sel') ?? '1,0').split(',').map(Number);
  return { piece: p >= 0 && p < PIECES.length ? p : 1, colour: c >= 0 && c < COLOURS.length ? c : 0 };
})();

// ---------- layout & view (pinch-zoom / pan) ----------
let zoom = 1, panX = 0, panY = 0, base = { cx: 0, cy: 0, s: 1 };
function layout() {
  const w = innerWidth, h = innerHeight;
  const top = $('#top').getBoundingClientRect().bottom;
  const bottom = $('#sheet').getBoundingClientRect().top;
  document.documentElement.style.setProperty('--sheet-h', `${h - bottom}px`);
  const avail = Math.max(120, bottom - top);
  base = { cx: w / 2, cy: top + avail / 2, s: Math.max(60, Math.min(w - 20, avail - 12) / 2 / 1.06) };
  stage.resize(w, h, view());
}
const view = () => ({ cx: base.cx + panX, cy: base.cy + panY, s: base.s * zoom });
function setZoom(z: number, ax: number, ay: number) {
  const v = view();
  const mx = (ax - v.cx) / v.s, my = (ay - v.cy) / v.s;
  zoom = Math.min(6, Math.max(1, z));
  panX = ax - base.cx - mx * base.s * zoom;
  panY = ay - base.cy - my * base.s * zoom;
  clampPan();
}
function clampPan() {
  const lim = base.s * (zoom - 1) * 1.05;
  panX = Math.max(-lim, Math.min(lim, panX));
  panY = Math.max(-lim, Math.min(lim, panY));
  stage.setView(view());
}
function resetView() {
  const z0 = zoom, x0 = panX, y0 = panY, t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / 260), e = 1 - Math.pow(1 - k, 3);
    zoom = z0 + (1 - z0) * e;
    panX = x0 * (1 - e);
    panY = y0 * (1 - e);
    stage.setView(view());
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const pts = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
let pinch: { d: number; z: number } | null = null;
let moved = false;
let lastTap = { t: 0, x: 0, y: 0 };
const cv = stage.cv;
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp });
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
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    panX += dx / 2;
    panY += dy / 2;
    setZoom((pinch.z * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, mx, my);
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
  if (dbl && zoom > 1) return resetView();
  tap(p.x, p.y);
};
cv.addEventListener('pointerup', up);
cv.addEventListener('pointercancel', up);
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });

// ---------- placing ----------
function tap(x: number, y: number) {
  dismissHint();
  const v = view();
  const c = cellAt((x - v.cx) / v.s, (y - v.cy) / v.s);
  if (!c) return;
  const left = cooldownUntil - Date.now();
  if (left > 0) {
    navigator.vibrate?.([6, 50, 6]);
    $('#cd').classList.remove('shake');
    void $('#cd').offsetWidth;
    $('#cd').classList.add('shake');
    return;
  }
  place(c.ring, c.slot, x, y);
}

async function place(ring: number, slot: number, x: number, y: number) {
  const key = ring * 64 + slot;
  const prev = stage.cells.get(key);
  const local: Cell = { id: (prev?.id ?? 0) + 0.5, ring, slot, piece: sel.piece, colour: sel.colour, who };
  pending.set(key, { local, prev });
  stage.put(local, {});
  cooldownUntil = Date.now() + COOLDOWN;
  tapRing = { x, y, until: performance.now() + COOLDOWN };
  navigator.vibrate?.(10);
  chime(sel.colour);
  tickCooldown();
  let res;
  try {
    res = await postJSON('/api/place', { d: deviceId, ring, slot, piece: sel.piece, colour: sel.colour });
  } catch {
    res = { status: 0, body: {} };
  }
  if (res.status === 200) {
    st.mine = res.body.mine;
    setStats(res.body);
    applyEvent(res.body.ev, false);
    toast(`+1 · You've added ${fmt(st.mine)} piece${st.mine === 1 ? '' : 's'} today`, true);
    return;
  }
  // rejected: roll back the optimistic piece
  if (stage.cells.get(key) === local) stage.remove(key, prev);
  pending.delete(key);
  const b = res.body;
  if (b.retryMs) cooldownUntil = Date.now() + b.retryMs;
  else if (res.status !== 429) cooldownUntil = 0;
  tapRing = null;
  tickCooldown();
  toast(
    b.error === 'cooldown' ? 'One piece every 4 seconds. Almost there.'
    : b.error === 'rate' ? 'Lots of pieces from your network right now. Try again in a moment.'
    : b.error === 'daily' ? "You've reached today's limit. A fresh board starts at midnight IST."
    : "Couldn't reach the board. Check your connection.",
  );
}

/** Applies a server event. Our own echo replaces the optimistic piece without re-animating. */
function applyEvent(e: WireEvent, animate = true) {
  const c = cellFromWire(e);
  const k = keyOf(c);
  st.lastId = Math.max(st.lastId, c.id);
  const cur = stage.cells.get(k);
  if (cur && cur.id >= c.id) return;
  const p = pending.get(k);
  if (p && cur === p.local) {
    pending.delete(k);
    if (c.who === who && c.piece === cur.piece && c.colour === cur.colour) {
      stage.cells.set(k, c);
      const a = stage.anims.get(k);
      if (a) a.cell = c;
      return;
    }
  }
  stage.put(c, animate ? {} : undefined);
}

// ---------- live data ----------
function setStats(s: { pieces?: number; people?: number; online?: number }) {
  if (s.pieces != null) st.pieces = s.pieces;
  if (s.people != null) st.people = s.people;
  if (s.online != null) st.online = s.online;
  $('#online b').textContent = st.online < 0 ? 'Connecting…' : `${fmt(st.online)} drawing now`;
  $('#online').classList.toggle('live', st.online > 0);
  $('#stats').textContent = st.pieces
    ? `${fmt(st.pieces)} piece${st.pieces === 1 ? '' : 's'} by ${fmt(st.people)} ${st.people === 1 ? 'person' : 'people'} today`
    : 'A fresh board. Be the first today.';
}

async function loadState() {
  const s = await getJSON<State>(`/api/state?d=${deviceId}`);
  Object.assign(st, { day: s.day, dayNo: s.dayNo, lastId: s.lastId, mine: s.mine });
  pending.clear();
  stage.reset(s.cells.map(cellFromWire));
  setStats(s);
  if (s.cooldownMs > 0) (cooldownUntil = Date.now() + s.cooldownMs), tickCooldown();
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
  (mode) => document.documentElement.dataset.transport = mode,
);

async function hello() {
  if (document.hidden) return;
  try {
    setStats((await postJSON('/api/hello', { d: deviceId })).body);
  } catch { /* retried in 15s */ }
}

// ---------- overlay: cooldown ring at the tap point, "show mine" pulses ----------
stage.overlay = (g, now) => {
  const d = stage.dpr;
  let more = false;
  if (tapRing && now < tapRing.until) {
    const k = (tapRing.until - now) / COOLDOWN;
    g.lineWidth = 2.5 * d;
    g.lineCap = 'round';
    g.strokeStyle = `rgba(247,243,233,${0.55 * Math.min(1, k * 4)})`;
    g.beginPath();
    g.arc(tapRing.x * d, tapRing.y * d, 26 * d, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
    g.stroke();
    more = true;
  }
  if (now < highlightUntil) {
    const t = (highlightUntil - now) / 3000;
    const pulse = 0.5 + 0.5 * Math.sin(now / 120);
    g.strokeStyle = `rgba(255,255,255,${(0.45 + 0.5 * pulse) * Math.min(1, t * 3)})`;
    g.lineWidth = 2 * d;
    const v = stage.V();
    for (const c of stage.cells.values()) {
      if (c.who !== who) continue;
      for (const [x, y, r] of copyCentres(v, c)) {
        g.beginPath();
        g.arc(x, y, r * (1.35 + pulse * 0.25), 0, Math.PI * 2);
        g.stroke();
      }
    }
    more = true;
  }
  return more;
};

function showMine() {
  if (![...stage.cells.values()].some((c) => c.who === who)) {
    toast(st.mine ? 'Your pieces have all been painted over. Add another!' : "You haven't placed a piece today yet.");
    return;
  }
  highlightUntil = performance.now() + 3000;
  stage.kick();
}

let cdRaf = 0;
function tickCooldown() {
  cancelAnimationFrame(cdRaf);
  const ring = $<SVGCircleElement>('#cdring circle.fg');
  const label = $('#cdlabel');
  const step = () => {
    const left = Math.max(0, cooldownUntil - Date.now());
    ring.style.strokeDashoffset = String(113.1 * (left / COOLDOWN));
    $('#cd').classList.toggle('ready', !left);
    label.textContent = left ? `Next piece in ${(left / 1000).toFixed(1)}s` : 'Ready · tap the floor';
    if (left) cdRaf = requestAnimationFrame(step);
  };
  step();
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
  store.set('rl.hint', '1');
}
if (!store.get('rl.hint')) $('#hint').hidden = false;

// ---------- palette ----------
const pieceBtns: HTMLButtonElement[] = [];
const colourBtns: HTMLButtonElement[] = [];
PIECES.forEach((_, i) => {
  const b = document.createElement('button');
  b.className = 'opt';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-label', PIECE_NAMES[i]);
  b.title = PIECE_NAMES[i];
  b.append(document.createElement('canvas'));
  b.onclick = () => select(i, sel.colour);
  pieceBtns.push(b);
  $('#pieces').append(b);
});
COLOURS.forEach((hex, i) => {
  const b = document.createElement('button');
  b.className = 'opt swatch';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-label', COLOUR_NAMES[i]);
  b.title = COLOUR_NAMES[i];
  b.style.setProperty('--c', hex);
  b.append(document.createElement('i'));
  b.onclick = () => select(sel.piece, i);
  colourBtns.push(b);
  $('#colours').append(b);
});
function select(piece: number, colour: number) {
  const recolour = colour !== sel.colour || !pieceBtns[0].dataset.drawn;
  Object.assign(sel, { piece, colour });
  store.set('rl.sel', `${piece},${colour}`);
  pieceBtns.forEach((b, i) => b.setAttribute('aria-checked', String(i === piece)));
  colourBtns.forEach((b, i) => b.setAttribute('aria-checked', String(i === colour)));
  if (recolour)
    pieceBtns.forEach((b, i) => {
      const c = b.querySelector('canvas')!;
      const px = Math.round(34 * Math.min(devicePixelRatio || 1, 3));
      c.width = c.height = px;
      const g = c.getContext('2d')!;
      g.drawImage(spr(i, colour), 0, 0, SPR, SPR, 0, 0, px, px);
      b.dataset.drawn = '1';
    });
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
  if (soundOn()) chime(sel.colour);
});
$('#gallery-btn').addEventListener('click', () => openGallery());
$('#about-btn').addEventListener('click', () => openPanel($('#about')));
$('#share-btn').addEventListener('click', async () => {
  const b = $<HTMLButtonElement>('#share-btn');
  b.disabled = true;
  try {
    await shareCard([...stage.cells.values()], { day: st.day, dayNo: st.dayNo, people: st.people, mine: st.mine });
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast("Couldn't make the share card. Try again.");
  }
  b.disabled = false;
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeTop()));

// ---------- boot ----------
select(sel.piece, sel.colour);
paintSound();
setStats({});
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
  const rec = q.get('record') ?? q.get('timelapse');
  if (rec) openTimelapse(rec === 'today' ? st.day : rec, q.has('record'));
})();
