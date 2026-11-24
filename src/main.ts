import '@fontsource/silkscreen/400.css';
import '@fontsource/silkscreen/700.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/700.css';
import './style.css';
import { BANK_SIZE, BASE, colourName, EMPTY, H, nearest, PALETTE, PAPER, REGEN_MS, rgbOf, START_PIXELS, W, type WireEvent } from '../shared/pixels.ts';
import { chime, music, setSound, soundOn } from './audio.ts';
import { Board } from './board.ts';
import { deviceId, getJSON, Live, myWho, postJSON, type State } from './net.ts';
import { shareCard } from './share.ts';
import { openTimelapse } from './timelapse.ts';
import { $, closeTop, fmt, openPanel, store } from './ui.ts';

const board = new Board($<HTMLCanvasElement>('#board'));
const st = { lastId: 0, pixels: 0, people: 0, online: -1, mine: 0, since: 0 };
const ids = new Int32Array(W * H); // id of the last event applied to each pixel
const myPixels = new Set<number>();
const drafts = new Map<number, number>(); // pixel index -> colour, waiting for Place
let who = '';
let myName: string | null = null;
let lastTapped = -1;
let highlightUntil = 0;
type Mode = 'move' | 'tap' | 'draw'; // move: look around only; tap: taps draft; draw: drags paint
let mode: Mode = (['move', 'tap', 'draw'] as const).find((m) => m === store.get('pw.mode')) ?? 'tap';
const hexOf = (c: number) => (c === EMPTY ? PAPER : PALETTE[c]); // EMPTY = the eraser
let picking = false; // the colour picker is armed for the next tap
let colour = (() => {
  const c = Number(store.get('pw.colour') ?? 5); // first visit: red, never white on white paper
  return Number.isInteger(c) && c >= 0 && c < PALETTE.length ? c : 5;
})();

// ---------- layout & view (pinch-zoom / pan) ----------
let zoom = 1, panX = 0, panY = 0, base = { cx: 0, cy: 0, s: 1 };
let area = { right: 0, top: 0, bottom: 0 }; // the part of the screen the canvas shows in
let fillZoom = 1; // zoom at which the canvas fills its area (tall phone screens would otherwise leave big bands of nothing)
let laidOut = false;
const maxZoom = () => Math.max(1, 44 / base.s); // up to ~44 css px per pixel
function layout() {
  const w = innerWidth, h = innerHeight;
  const top = $('#top').getBoundingClientRect().bottom;
  const sheet = $('#sheet').getBoundingClientRect();
  const side = sheet.top < h / 2; // landscape phones: the sheet is a column on the right
  const right = side ? sheet.left : w, bottom = side ? h : sheet.top;
  document.documentElement.style.setProperty('--sheet-h', `${side ? 0 : h - bottom}px`);
  const availW = Math.max(120, right - 16), availH = Math.max(120, bottom - top - 12);
  // zoom 1 fits the whole canvas, however big; the first view fills the area instead
  base = { cx: right / 2, cy: top + (bottom - top) / 2, s: Math.max(0.05, Math.min(availW / W, availH / H)) };
  area = { right, top, bottom };
  fillZoom = Math.max(availW / (W * base.s), availH / (H * base.s));
  if (!laidOut) (laidOut = true), (zoom = fillZoom);
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
  const lx = (base.s * W * (zoom - 1)) / 2, ly = (base.s * H * (zoom - 1)) / 2;
  panX = Math.max(-lx, Math.min(lx, panX));
  panY = Math.max(-ly, Math.min(ly, panY));
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

// ---------- pointer: one finger pans (Move) or paints drafts (Draw); two fingers always pinch ----------
const pts = new Map<number, { x: number; y: number; x0: number; y0: number }>();
let pinch: { d: number; z: number } | null = null;
let moved = false;
let stroke: number | null = null; // last pixel of the current Draw stroke
let lastTap = { t: 0, x: 0, y: 0, i: -1, before: undefined as number | undefined }; // before: that pixel's draft before the tap, so a double-tap can undo it
const cv = board.cv;
// ---------- minimap: shown while zoomed in; tap or drag it to jump ----------
let miniDrag = -1;
const miniOn = () => zoom > 1.3;
const miniRect = () => {
  const w = Math.min(170, area.right * 0.34);
  return { x: area.right - w - 12, y: area.top + 8, w, h: (w * H) / W };
};
const inMini = (x: number, y: number) => {
  const m = miniRect();
  return miniOn() && x >= m.x - 4 && x <= m.x + m.w + 4 && y >= m.y - 4 && y <= m.y + m.h + 4;
};
function miniJump(e: PointerEvent) {
  const m = miniRect(), s = base.s * zoom;
  panX = -(((e.clientX - m.x) / m.w) * W - W / 2) * s;
  panY = -(((e.clientY - m.y) / m.h) * H - H / 2) * s;
  clampPan();
}

cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  if (!pts.size && inMini(e.clientX, e.clientY)) return (miniDrag = e.pointerId), miniJump(e);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  if (pts.size === 1) {
    moved = false;
    if (mode === 'draw' && !picking) {
      dismissHint();
      const i = board.pixelAt(e.clientX, e.clientY);
      stroke = i;
      if (i >= 0) paintDraft(i), showInfo(i);
    }
  }
  if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom };
    moved = true;
    stroke = null;
  }
});
cv.addEventListener('pointermove', (e) => {
  if (e.pointerId === miniDrag) return miniJump(e);
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
  } else if (pts.size === 1 && stroke !== null) {
    const i = board.pixelAt(e.clientX, e.clientY);
    if (i >= 0 && i !== stroke) {
      for (const j of line(stroke < 0 ? i : stroke, i)) paintDraft(j);
      stroke = i;
    }
  } else if (pts.size === 1 && (moved || Math.hypot(p.x - p.x0, p.y - p.y0) > 8)) {
    moved = true;
    if (zoom > 1) (panX += dx), (panY += dy), clampPan();
  }
});
const up = (e: PointerEvent) => {
  if (e.pointerId === miniDrag) return void (miniDrag = -1);
  const p = pts.get(e.pointerId);
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch = null;
  const wasStroke = stroke !== null;
  if (!pts.size) stroke = null;
  if (!p || moved || wasStroke || e.type === 'pointercancel' || pts.size) return;
  const dbl = e.timeStamp - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40;
  dismissHint();
  if (dbl && !picking) {
    // the first tap of a double-tap already toggled a draft; put it back
    const { i: was, before } = lastTap;
    if (was >= 0) {
      if (before === undefined) drafts.delete(was);
      else drafts.set(was, before);
      paintPlace();
      board.kick();
    }
    lastTap = { t: 0, x: 0, y: 0, i: -1, before: undefined };
    return animateZoom(zoom > Math.max(1.5, fillZoom * 1.2) ? fillZoom : Math.min(maxZoom(), 16 / base.s), p.x, p.y); // dive in / back out
  }
  const i = board.pixelAt(p.x, p.y);
  lastTap = { t: e.timeStamp, x: p.x, y: p.y, i: picking ? -1 : i, before: drafts.get(i) };
  tapPixel(i);
};
cv.addEventListener('pointerup', up);
cv.addEventListener('pointercancel', up);
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });

/** Pixels on the straight line between two pixels, so a fast drag leaves no gaps. */
function line(a: number, b: number) {
  const ax = a % W, ay = (a / W) | 0, bx = b % W, by = (b / W) | 0;
  const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
  return Array.from({ length: n }, (_, k) => Math.round(ay + ((by - ay) * (k + 1)) / n) * W + Math.round(ax + ((bx - ax) * (k + 1)) / n));
}

// ---------- drafts ----------
const pixelsLeft = () => Math.floor(tokensNow()) - drafts.size;
let warnedFull = 0;
function outOfPixels() {
  if (Date.now() - warnedFull < 2500) return;
  warnedFull = Date.now();
  navigator.vibrate?.([6, 50, 6]);
  toast(Math.floor(tokensNow()) ? `That's all ${Math.floor(tokensNow())} of your pixels. Press Place.` : 'Out of pixels. One comes back every 30 seconds.');
}

/** Draw-mode painting: adds a draft, never removes one. Skips pixels that already have this colour. */
function paintDraft(i: number) {
  if (colour === EMPTY && drafts.has(i)) return void (drafts.delete(i), paintPlace(), board.kick()); // the eraser rubs out drafts first
  if (drafts.get(i) === colour || (!drafts.has(i) && board.colours[i] === colour)) return;
  if (!drafts.has(i) && pixelsLeft() <= 0) return outOfPixels();
  drafts.set(i, colour);
  paintPlace();
  board.kick();
}

/** A tap: picks a colour, or toggles/recolours a draft. */
function tapPixel(i: number) {
  if (i < 0) return;
  showInfo(i);
  if (picking) {
    const c = drafts.get(i) ?? tplAt(i) ?? board.colours[i]; // the guide image wins, so tracing is quick
    setPicking(false);
    if (c === EMPTY) return toast('That pixel is still blank.');
    pick(c);
    return toast(`Picked ${colourName(c)}`);
  }
  if (mode === 'move') return; // Move only looks
  if (drafts.get(i) === colour || (colour === EMPTY && drafts.has(i))) drafts.delete(i);
  else if (colour === EMPTY && board.colours[i] === EMPTY) toast('That pixel is already blank.');
  else if (drafts.has(i) || pixelsLeft() > 0) drafts.set(i, colour);
  else outOfPixels();
  paintPlace();
  board.kick();
}

function clearDrafts() {
  drafts.clear();
  paintPlace();
  board.kick();
}

// ---------- the pixel bank and Place ----------
const placeBtn = $<HTMLButtonElement>('#place');
let bank = { tokens: START_PIXELS, at: Date.now() }; // until the server says otherwise
let blockedUntil = 0; // set when the network as a whole is rate limited
let inflight = 0;
const tokensNow = () => Math.min(BANK_SIZE, bank.tokens + (Date.now() - bank.at) / REGEN_MS);
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.ceil(ms / 1000) % 60).padStart(2, '0')}`;

function paintPlace() {
  const t = tokensNow(), n = Math.floor(t);
  const blocked = Math.max(0, blockedUntil - Date.now());
  const ready = Math.min(drafts.size, n);
  placeBtn.disabled = !ready || blocked > 0;
  $('#place-label').textContent =
    blocked ? `Try again in ${clock(blocked)}`
    : ready ? `Place ${ready} pixel${ready === 1 ? '' : 's'}`
    : n < 1 ? `Next pixel in ${clock((1 - t) * REGEN_MS)}`
    : mode === 'draw' ? 'Drag on the canvas to draw'
    : mode === 'move' ? 'Switch to Tap or Draw to paint'
    : colour === EMPTY ? 'Tap pixels to erase them' : 'Tap pixels to draft them';
  $('#place-xy').textContent = drafts.size > n ? `${drafts.size - n} more than you have` : '';
  $('#bank b').textContent = String(Math.max(0, n - drafts.size));
  $('#bank small').textContent = n < BANK_SIZE ? `+1 in ${clock((1 - (t % 1)) * REGEN_MS)}` : 'full';
  $<SVGCircleElement>('#cdring .fg').style.strokeDashoffset = String(113.1 * (n < BANK_SIZE ? 1 - (t % 1) : 0));
  placeBtn.classList.toggle('cooling', n < BANK_SIZE);
  const clear = $<HTMLButtonElement>('#clear');
  clear.disabled = !drafts.size;
  $('#clear span').textContent = drafts.size ? `Clear ${drafts.size}` : 'Clear';
}
setInterval(paintPlace, 250);
placeBtn.addEventListener('click', () => !placeBtn.disabled && placeDrafts());

async function placeDrafts() {
  const batch = [...drafts].slice(0, Math.min(Math.floor(tokensNow()), BANK_SIZE));
  if (!batch.length) return;
  const before = batch.map(([i]) => ({ colour: board.colours[i], id: ids[i] }));
  for (const [i, c] of batch) drafts.delete(i), board.set(i, c);
  bank = { tokens: tokensNow() - batch.length, at: Date.now() };
  inflight++;
  navigator.vibrate?.(12);
  chime(batch[0][1]);
  paintPlace();
  let res;
  try {
    res = await postJSON('/api/place', { d: deviceId, pixels: batch.map(([i, c]) => [i % W, (i / W) | 0, c]) });
  } catch {
    res = { status: 0, body: {} };
  }
  inflight--;
  const b = res.body;
  const placed: WireEvent[] = res.status === 200 ? b.evs : [];
  // resync with the server's count once nothing else is on its way
  const synced = typeof b.tokens === 'number' && !inflight;
  if (synced) bank = { tokens: b.tokens, at: Date.now() };
  else bank = { tokens: tokensNow() + batch.length - placed.length, at: Date.now() };
  for (const e of placed) applyEvent(e, false), myPixels.add(e[2] * W + e[1]);
  // Anything the server didn't take goes back to how it was, and back into the drafts.
  batch.slice(placed.length).forEach(([i, c], k) => {
    const was = before[placed.length + k];
    if (ids[i] === was.id) board.set(i, was.colour, false);
    if (!drafts.has(i)) drafts.set(i, c);
  });
  if (b.error === 'rate') blockedUntil = Date.now() + (b.retryMs ?? 0);
  if (res.status === 200) {
    st.mine = b.mine;
    setStats(b);
    const left = Math.floor(tokensNow());
    const kept = batch.length - placed.length;
    toast(kept ? `+${placed.length} · ${kept} kept as drafts` : `+${placed.length} · ${left} pixel${left === 1 ? '' : 's'} left`, true);
    // New players get asked once, right after their first pixels go up, whether to sign them.
    if (!myName && !store.get('pw.nameAsked')) {
      store.set('pw.nameAsked', '1');
      setTimeout(() => openName(true), 900);
    }
  } else {
    toast(
      b.error === 'empty' ? 'Out of pixels. One comes back every 30 seconds.'
      : b.error === 'rate' ? 'Lots of pixels from your network right now. Your drafts are kept.'
      : b.error === 'daily' ? "Your network hit today's limit. It resets at 00:00 UTC."
      : "Couldn't reach the canvas. Your drafts are kept.",
    );
  }
  paintPlace();
}

/** Applies a server event in id order; our own echo is already on screen, so it doesn't flash again. */
function applyEvent(e: WireEvent, flash = true) {
  const [id, x, y, c, w] = e;
  const i = y * W + x;
  st.lastId = Math.max(st.lastId, id);
  if (id <= ids[i]) return;
  ids[i] = id;
  if (w === who) myPixels.add(i);
  else myPixels.delete(i);
  if (board.colours[i] !== c) board.set(i, c, flash && w !== who);
  if (i === lastTapped) showInfo(i);
}

// ---------- pixel info ----------
const ago = (ts: number) => {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
let infoSeq = 0;
async function showInfo(i: number) {
  lastTapped = i;
  $('#link-btn').hidden = false;
  const x = i % W, y = (i / W) | 0, seq = ++infoSeq;
  const el = $('#info');
  el.textContent = `${x}, ${y}`;
  try {
    const r = await getJSON<{ times: number; ts: number | null; by: string | null }>(`/api/pixel?x=${x}&y=${y}`);
    if (seq !== infoSeq) return;
    el.textContent = r.times
      ? `${x}, ${y} · by ${myPixels.has(i) ? 'you' : r.by ?? 'anonymous'} · painted ${r.times}× · last ${ago(r.ts!)} ›`
      : `${x}, ${y} · never painted`;
  } catch { /* coordinates alone are fine */ }
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
  const [s, b] = await Promise.all([getJSON<State>(`/api/state?d=${deviceId}`), fetch('/api/board')]);
  if (!b.ok) throw new Error(`board ${b.status}`);
  // After a full reset everyone starts from scratch: forget everything this browser saved, then reload.
  const was = store.get('pw.epoch');
  if (was !== s.epoch) {
    const played = was !== null || store.get('pw.welcome') !== null || store.get('pw.hint') !== null;
    if (played) {
      store.clear('pw.');
      store.set('pw.epoch', s.epoch);
      location.reload();
      return new Promise<never>(() => {}); // the page is going away
    }
    store.set('pw.epoch', s.epoch);
  }
  // The board can be up to a second old; x-last-id says where the live stream should pick up.
  Object.assign(st, { lastId: Number(b.headers.get('x-last-id')) || 0, mine: s.mine, since: s.since });
  ids.fill(0);
  myPixels.clear();
  s.myPixels.forEach((i) => myPixels.add(i));
  board.load(new Uint8Array(await b.arrayBuffer()));
  setStats(s);
  bank = { tokens: s.tokens, at: Date.now() };
  paintPlace();
  showName(s.name);
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

// ---------- overlay: drafts, last tapped pixel, "show mine" pulses ----------
board.overlay = (g, now) => {
  const d = board.dpr;
  let more = false;
  if (tpl?.on) {
    const [x, y, w] = board.rectOf(tpl.y * W + tpl.x);
    g.globalAlpha = tpl.alpha;
    g.imageSmoothingEnabled = false;
    g.drawImage(tpl.cv, x, y, tpl.cv.width * w, tpl.cv.height * w);
    g.globalAlpha = 1;
  }
  for (const [i, c] of drafts) {
    const [x, y, w] = board.rectOf(i);
    const r = Math.max(w, 2 * d);
    g.fillStyle = hexOf(c);
    g.fillRect(x, y, r, r);
    if (w >= 8 * d) {
      // drafts get a dashed outline so they read as "not placed yet"
      g.setLineDash([3 * d, 2 * d]);
      g.lineWidth = 1.5 * d;
      g.strokeStyle = 'rgba(14,16,32,0.75)';
      g.strokeRect(x + 0.75 * d, y + 0.75 * d, w - 1.5 * d, w - 1.5 * d);
      g.setLineDash([]);
    }
  }
  if (lastTapped >= 0 && !drafts.has(lastTapped)) {
    const [x, y, w] = board.rectOf(lastTapped);
    const r = Math.max(w, 6 * d), ox = x + w / 2 - r / 2, oy = y + w / 2 - r / 2;
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
  if (miniOn()) {
    const m = miniRect(), v = view();
    g.fillStyle = 'rgba(14,16,32,0.88)';
    g.fillRect((m.x - 4) * d, (m.y - 4) * d, (m.w + 8) * d, (m.h + 8) * d);
    g.imageSmoothingEnabled = true; // a shrunk canvas reads better smoothed
    g.drawImage(board.px, m.x * d, m.y * d, m.w * d, m.h * d);
    const bx = (sx: number) => Math.max(0, Math.min(W, (sx - v.cx) / v.s + W / 2)), by = (sy: number) => Math.max(0, Math.min(H, (sy - v.cy) / v.s + H / 2));
    const x0 = bx(0), x1 = bx(area.right), y0 = by(area.top), y1 = by(area.bottom);
    g.strokeStyle = '#FFD23F';
    g.lineWidth = 1.5 * d;
    g.strokeRect((m.x + (x0 / W) * m.w) * d, (m.y + (y0 / H) * m.h) * d, Math.max(2, ((x1 - x0) / W) * m.w) * d, Math.max(2, ((y1 - y0) / H) * m.h) * d);
  }
  return more;
};

function showMine() {
  if (!myPixels.size) {
    toast(st.mine ? 'Your pixels have all been painted over. Place more!' : "You haven't placed a pixel yet.");
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

function dismissHint() {
  const h = $('#hint');
  if (h.hidden) return;
  h.classList.add('gone');
  setTimeout(() => (h.hidden = true), 400);
  store.set('pw.hint', '2');
}
if (store.get('pw.hint') !== '2') $('#hint').hidden = false;

// ---------- palette & tools ----------
const swatch = (label: string, onclick: () => void) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-label', label);
  b.title = label;
  b.append(document.createElement('i'));
  b.onclick = onclick;
  $('#colours').append(b);
  return b;
};
const swatches = BASE.map((hex, i) => {
  const b = swatch(colourName(i), () => pick(i));
  b.style.setProperty('--c', hex);
  return b;
});
// One slot for the latest colour from the big picker, then the button that opens it.
const customSwatch = swatch('Your last custom colour', () => pick(Number(customSwatch.dataset.c)));
customSwatch.hidden = true;
const moreBtn = swatch('More colours', openColours);
moreBtn.classList.add('more');
moreBtn.removeAttribute('role');

let recent: number[] = (() => {
  try { return (JSON.parse(store.get('pw.recent') ?? '[]') as number[]).filter((c) => Number.isInteger(c) && c >= 0 && c < PALETTE.length); } catch { return []; }
})();
let ink = colour; // the last real colour, so turning the eraser off goes back to it
function pick(c: number) {
  colour = c;
  const erasing = c === EMPTY;
  $('#eraser').setAttribute('aria-pressed', String(erasing));
  if (!erasing) (ink = c), store.set('pw.colour', String(c));
  swatches.forEach((b, i) => b.setAttribute('aria-checked', String(i === c)));
  if (c >= BASE.length && !erasing) {
    customSwatch.hidden = false;
    customSwatch.dataset.c = String(c);
    customSwatch.style.setProperty('--c', PALETTE[c]);
    customSwatch.title = customSwatch.ariaLabel = colourName(c);
    recent = [c, ...recent.filter((x) => x !== c)].slice(0, 18);
    store.set('pw.recent', JSON.stringify(recent));
  }
  customSwatch.setAttribute('aria-checked', String(c >= BASE.length && !erasing));
  placeBtn.style.setProperty('--c', hexOf(c));
  if (!$('#colour-panel').hidden && !erasing) showChosen();
  paintPlace();
  board.kick();
}
if (recent[0] !== undefined && colour < BASE.length) {
  customSwatch.hidden = false;
  customSwatch.dataset.c = String(recent[0]);
  customSwatch.style.setProperty('--c', PALETTE[recent[0]]);
}

// ---------- the big colour picker: a wheel snapped to the palette, recents, and every colour ----------
const PAL_RGB = PALETTE.map(rgbOf);
const snapCache = new Map<number, number>();
const snap = (r: number, g: number, b: number) => {
  const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
  let c = snapCache.get(k);
  if (c === undefined) snapCache.set(k, (c = nearest(r, g, b)));
  return c;
};
function hsl(h: number, s: number, l: number) {
  const f = (n: number) => {
    const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)] as const;
}
const wheel = $<HTMLCanvasElement>('#wheel');
const light = $<HTMLInputElement>('#light');
const wheelColour = (x: number, y: number) => {
  const n = wheel.width, dx = x - n / 2, dy = y - n / 2, r = Math.hypot(dx, dy) / (n / 2);
  if (r > 1) return -1;
  return snap(...hsl(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360, r, Number(light.value) / 100));
};
function drawWheel() {
  const n = wheel.width, g = wheel.getContext('2d')!, img = g.createImageData(n, n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const c = wheelColour(x + 0.5, y + 0.5);
      if (c < 0) continue;
      img.data.set([...PAL_RGB[c], 255], (y * n + x) * 4);
    }
  g.putImageData(img, 0, 0);
}
function showChosen() {
  $('#chosen-chip').style.background = PALETTE[colour];
  $('#chosen-name').textContent = colourName(colour);
  const mark = (box: string) => $(box).querySelectorAll<HTMLElement>('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.c) === colour)));
  fillMinis('#recent', recent);
  mark('#recent');
  mark('#all-colours');
}
function fillMinis(box: string, list: number[]) {
  $(box).replaceChildren(...list.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.c = String(c);
    b.style.background = PALETTE[c];
    b.title = b.ariaLabel = colourName(c);
    b.onclick = () => pick(c);
    return b;
  }));
  if (!list.length) $(box).innerHTML = '<p class="small">Colours you choose here show up for next time.</p>';
}
let allFilled = false;
function openColours() {
  if (!allFilled) {
    allFilled = true;
    // all colours sorted greys first, then by hue and lightness, so the grid reads like a rainbow
    const key = (c: number) => {
      const [r, g, b] = PAL_RGB[c], mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
      if (mx - mn < 8) return l;
      const h = mx === r ? ((g - b) / (mx - mn) + 6) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
      return 1000 + Math.round(h * 4) * 1000 + l;
    };
    fillMinis('#all-colours', PALETTE.map((_, i) => i).filter((i, _, a) => a.findIndex((j) => PALETTE[j] === PALETTE[i]) === i).sort((a, b) => key(a) - key(b)));
    drawWheel();
  }
  openPanel($('#colour-panel'));
  showChosen();
}
light.addEventListener('input', drawWheel);
const wheelPick = (e: PointerEvent) => {
  const r = wheel.getBoundingClientRect();
  const c = wheelColour(((e.clientX - r.left) / r.width) * wheel.width, ((e.clientY - r.top) / r.height) * wheel.height);
  if (c >= 0 && c !== colour) pick(c);
};
wheel.addEventListener('pointerdown', (e) => (wheel.setPointerCapture(e.pointerId), wheelPick(e)));
wheel.addEventListener('pointermove', (e) => e.buttons && wheelPick(e));
function setMode(m: Mode) {
  mode = m;
  store.set('pw.mode', m);
  for (const k of ['move', 'tap', 'draw']) $('#mode-' + k).setAttribute('aria-pressed', String(m === k));
  paintPlace();
}
function setPicking(on: boolean) {
  picking = on;
  $('#picker').setAttribute('aria-pressed', String(on));
  if (on) toast('Tap any pixel to copy its colour');
}
$('#mode-move').addEventListener('click', () => setMode('move'));
$('#mode-tap').addEventListener('click', () => setMode('tap'));
$('#mode-draw').addEventListener('click', () => setMode('draw'));
$('#eraser').addEventListener('click', () => pick(colour === EMPTY ? ink : EMPTY));
$('#picker').addEventListener('click', () => setPicking(!picking));
$('#clear').addEventListener('click', clearDrafts);
$('#mine').addEventListener('click', showMine);

// ---------- username ----------
function showName(n: string | null) {
  myName = n;
  const b = $('#name-btn');
  b.textContent = n ? `@${n}` : 'Set your name';
  b.classList.toggle('set', !!n);
}
function openName(prompt = false) {
  $('#name-title').textContent = prompt ? 'Put your name on your pixels?' : 'Your name';
  $('#name-intro').textContent = prompt
    ? 'Anyone who taps your pixels will see "by your name". You can change it any time, or skip and stay anonymous.'
    : 'Shown as "by your name" when someone taps a pixel you painted. Leave it unset to stay anonymous.';
  $<HTMLInputElement>('#name-input').value = myName ?? '';
  $('#name-error').textContent = '';
  openPanel($('#name-panel'));
  setTimeout(() => $<HTMLInputElement>('#name-input').focus(), 300);
}
$('#name-btn').addEventListener('click', () => openName());

// ---------- leaderboard ----------
type Leader = { name: string; n: number };
function fill(id: string, rows: Leader[]) {
    const ol = $(id);
    ol.replaceChildren(...rows.map((r) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      const n = document.createElement('b');
      name.textContent = r.name;
      n.textContent = fmt(r.n);
      li.append(name, n);
      li.classList.toggle('me', r.name === myName);
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      const open = (e: Event) => {
        if (e instanceof KeyboardEvent && e.key !== 'Enter') return;
        if ($('#leaders').hidden) showProfile(false), openPanel($('#leaders')); // from the side list
        openProfile(r.name);
      };
      li.onclick = open;
      li.onkeydown = open;
      return li;
    }));
    if (!rows.length) ol.innerHTML = '<li class="empty">Nobody with a name yet. Set yours and place a few pixels!</li>';
}
$('#leaders-btn').addEventListener('click', async () => {
  showProfile(false);
  openPanel($('#leaders'));
  try {
    const l = await getJSON<{ today: Leader[]; all: Leader[] }>('/api/leaders');
    fill('#leaders-today', l.today);
    fill('#leaders-all', l.all);
    $('#leaders-note').textContent = myName ? `You're @${myName}.` : 'Set a name to appear here; anonymous pixels count toward nobody.';
  } catch {
    $('#leaders-note').textContent = "Couldn't load the leaderboard. Try again in a moment.";
  }
});

// Wide screens have room for today's top painters under the controls; refreshed while it's visible.
async function sideTop() {
  if (!$('#side-top').offsetParent || document.hidden) return;
  try {
    fill('#side-top-list', (await getJSON<{ today: Leader[] }>('/api/leaders')).today);
  } catch { /* next refresh retries */ }
}
setInterval(sideTop, 30_000);
addEventListener('resize', sideTop);

const showProfile = (on: boolean) => {
  $('#profile').hidden = !on;
  $('#leaders .boards').hidden = on;
  $('#leaders-note').hidden = on;
};
let profileLast: { x: number; y: number } | null = null;
async function openProfile(name: string) {
  try {
    const p = await getJSON<{ name: string; total: number; today: number; showing: number; last: { x: number; y: number; ts: number } | null }>(`/api/profile?name=${encodeURIComponent(name)}`);
    $('#profile-name').textContent = `@${p.name}`;
    $('#pf-total').textContent = fmt(p.total);
    $('#pf-today').textContent = fmt(p.today);
    $('#pf-showing').textContent = fmt(p.showing);
    $('#pf-last').textContent = p.last ? ago(p.last.ts) : '—';
    profileLast = p.last;
    $<HTMLButtonElement>('#pf-jump').disabled = !p.last;
    showProfile(true);
  } catch {
    toast("Couldn't load that profile.");
  }
}
$('#profile-back').addEventListener('click', () => showProfile(false));
$('#pf-jump').addEventListener('click', () => {
  if (!profileLast) return;
  const { x, y } = profileLast;
  closeTop();
  setTimeout(() => goTo(x, y, 16), 300);
});

// ---------- pixel history & reports ----------
const linkTo = (i: number) => `${location.origin}/?x=${i % W}&y=${(i / W) | 0}&z=${Math.round(base.s * zoom)}`;
async function openHistory() {
  if (lastTapped < 0) return;
  const i = lastTapped, x = i % W, y = (i / W) | 0;
  $('#history-title').textContent = `Pixel ${x}, ${y}`;
  $('#history-list').innerHTML = '';
  $('#history-note').textContent = 'Loading…';
  openPanel($('#history'));
  try {
    const r = await getJSON<{ times: number; history: { colour: number; ts: number; name: string | null }[] }>(`/api/pixel?x=${x}&y=${y}`);
    $('#history-list').replaceChildren(...r.history.map((h, k) => {
      const li = document.createElement('li');
      const chip = document.createElement('i'), who = document.createElement('span'), when = document.createElement('b');
      chip.className = 'chip';
      chip.style.background = hexOf(h.colour);
      who.textContent = k === 0 && myPixels.has(i) ? 'you' : h.name ?? 'anonymous';
      when.textContent = ago(h.ts);
      li.append(chip, who, when);
      return li;
    }));
    $('#history-note').textContent = r.times ? `Painted ${fmt(r.times)} time${r.times === 1 ? '' : 's'} in all${r.times > 5 ? '; the latest 5 are shown' : ''}.` : 'Nobody has painted this pixel yet.';
  } catch {
    $('#history-note').textContent = "Couldn't load the history.";
  }
}
$('#info').addEventListener('click', openHistory);
$('#info').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && openHistory());
$('#history-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(linkTo(lastTapped));
    toast('Link copied');
  } catch {
    toast(linkTo(lastTapped));
  }
});
$('#history-report').addEventListener('click', async () => {
  const r = await postJSON('/api/report', { d: deviceId, x: lastTapped % W, y: (lastTapped / W) | 0 }).catch(() => ({ status: 0 }));
  closeTop();
  toast(r.status === 200 ? 'Reported. Thanks for keeping the canvas nice.' : r.status === 429 ? 'You just reported something. Try again in a few seconds.' : "Couldn't send the report.");
});

// ---------- jump to where someone just painted ----------
$('#online').addEventListener('click', async () => {
  try {
    const m = await getJSON<{ e?: WireEvent[] }>(`/api/events?since=${Math.max(0, st.lastId - 30)}`);
    const e = (m.e ?? []).filter((x) => x[4] !== who).pop();
    if (!e || Date.now() - e[5] > 3_600_000) return toast('Nobody else has painted in the last hour.');
    goTo(e[1], e[2], 16);
    toast(`Someone painted here ${ago(e[5])}`);
  } catch {
    toast("Couldn't check right now.");
  }
});

// ---------- guide image (only this device sees it) ----------
type TplSave = { src: string; x: number; y: number; w: number; alpha: number; on: boolean };
let tpl: (TplSave & { img: HTMLImageElement; cv: HTMLCanvasElement; idx: Uint8Array }) | null = null;
const TPL_MAX = 600;
function buildTpl() {
  if (!tpl) return;
  const w = Math.max(8, Math.min(tpl.w, tpl.img.naturalWidth, W)), h = Math.max(1, Math.min(H, Math.round((tpl.img.naturalHeight * w) / tpl.img.naturalWidth)));
  tpl.w = w;
  const cv2 = document.createElement('canvas');
  cv2.width = w;
  cv2.height = h;
  const g = cv2.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(tpl.img, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h), idx = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const o = k * 4;
    if (img.data[o + 3] < 128) { idx[k] = EMPTY; img.data[o + 3] = 0; continue; } // transparent stays transparent
    const c = (idx[k] = snap(img.data[o], img.data[o + 1], img.data[o + 2]));
    img.data.set([...PAL_RGB[c], 255], o);
  }
  g.putImageData(img, 0, 0);
  Object.assign(tpl, { cv: cv2, idx, x: Math.min(tpl.x, W - w), y: Math.min(tpl.y, H - h) });
}
function tplAt(i: number) {
  if (!tpl?.on) return undefined;
  const x = (i % W) - tpl.x, y = ((i / W) | 0) - tpl.y;
  if (x < 0 || y < 0 || x >= tpl.cv.width || y >= tpl.cv.height) return undefined;
  const c = tpl.idx[y * tpl.cv.width + x];
  return c === EMPTY ? undefined : c;
}
function saveTpl() {
  if (!tpl) return store.set('pw.tpl', '');
  const { src, x, y, w, alpha, on } = tpl;
  store.set('pw.tpl', JSON.stringify({ src, x, y, w, alpha, on }));
}
function paintTpl() {
  $('#guide').setAttribute('aria-pressed', String(!!tpl?.on));
  $('#tpl-controls').hidden = !tpl;
  $('#tpl-choose').textContent = tpl ? 'Choose a different image' : 'Choose an image';
  if (!tpl) return board.kick();
  const wIn = $<HTMLInputElement>('#tpl-w');
  wIn.max = String(Math.min(TPL_MAX, tpl.img.naturalWidth));
  wIn.value = String(tpl.w);
  $('#tpl-w-out').textContent = `${tpl.w} × ${tpl.cv.height} px`;
  $<HTMLInputElement>('#tpl-a').value = String(Math.round(tpl.alpha * 100));
  $('#tpl-toggle').textContent = tpl.on ? 'Hide' : 'Show';
  $('#tpl-pos').textContent = `Top-left corner at ${tpl.x}, ${tpl.y}.` + (lastTapped >= 0 ? '' : ' Tap a pixel on the canvas first to choose where it goes.');
  board.kick();
}
async function loadTpl(t: TplSave) {
  const img = new Image();
  img.src = t.src;
  await img.decode();
  tpl = { ...t, img, cv: document.createElement('canvas'), idx: new Uint8Array(0) };
  buildTpl();
  paintTpl();
}
$('#guide').addEventListener('click', () => (paintTpl(), openPanel($('#tpl-panel'))));
$('#tpl-choose').addEventListener('click', () => $<HTMLInputElement>('#tpl-file').click());
$<HTMLInputElement>('#tpl-file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    // Shrink big photos once, so the saved copy fits in local storage.
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, TPL_MAX / bmp.width, TPL_MAX / bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const at = lastTapped >= 0 ? lastTapped : board.pixelAt(area.right / 2, (area.top + area.bottom) / 2);
    const start = Math.max(0, at);
    await loadTpl({ src: c.toDataURL('image/png'), x: start % W, y: (start / W) | 0, w: Math.min(c.width, 128), alpha: 0.45, on: true });
    saveTpl();
  } catch {
    toast("Couldn't open that image.");
  }
  (e.target as HTMLInputElement).value = '';
});
$<HTMLInputElement>('#tpl-w').addEventListener('input', (e) => {
  if (!tpl) return;
  tpl.w = Number((e.target as HTMLInputElement).value);
  buildTpl();
  paintTpl();
});
$<HTMLInputElement>('#tpl-w').addEventListener('change', saveTpl);
$<HTMLInputElement>('#tpl-a').addEventListener('input', (e) => {
  if (!tpl) return;
  tpl.alpha = Number((e.target as HTMLInputElement).value) / 100;
  saveTpl();
  board.kick();
});
$('#tpl-move').addEventListener('click', () => {
  if (!tpl || lastTapped < 0) return toast('Tap a pixel on the canvas first.');
  tpl.x = Math.min(lastTapped % W, W - tpl.cv.width);
  tpl.y = Math.min((lastTapped / W) | 0, H - tpl.cv.height);
  saveTpl();
  paintTpl();
});
$('#tpl-toggle').addEventListener('click', () => {
  if (!tpl) return;
  tpl.on = !tpl.on;
  saveTpl();
  paintTpl();
});
$('#tpl-remove').addEventListener('click', () => {
  tpl = null;
  saveTpl();
  paintTpl();
});
try {
  const saved = JSON.parse(store.get('pw.tpl') || 'null') as TplSave | null;
  if (saved?.src) loadTpl(saved).catch(() => store.set('pw.tpl', ''));
} catch { /* nothing saved */ }

// ---------- location links: ?x=&y=&z= opens zoomed in on a pixel ----------
$('#link-btn').addEventListener('click', async () => {
  const url = linkTo(lastTapped);
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ url, text: 'Look at this on PixelWorld' });
    else await navigator.clipboard.writeText(url), toast('Link copied');
  } catch (e) {
    if ((e as Error).name !== 'AbortError') toast(url);
  }
});
function goTo(x: number, y: number, z: number) {
  zoom = Math.min(maxZoom(), Math.max(1, z / base.s));
  const s = base.s * zoom;
  panX = -(x + 0.5 - W / 2) * s;
  panY = -(y + 0.5 - H / 2) * s;
  clampPan();
  showInfo(y * W + x);
}
async function saveName(name: string, error: HTMLElement) {
  const res = await postJSON('/api/name', { d: deviceId, name }).catch(() => ({ status: 0, body: {} as { name?: string } }));
  if (res.status === 200) {
    showName(res.body.name!);
    closeTop();
    toast(`You're @${res.body.name} now`);
  } else {
    error.textContent =
      res.status === 409 ? 'Someone already has that name. Try another.'
      : res.status === 400 ? 'Use 2–20 letters, numbers, spaces, _ . or -'
      : "Couldn't save. Check your connection.";
  }
}
$('#name-form').addEventListener('submit', (e) => (e.preventDefault(), saveName($<HTMLInputElement>('#name-input').value, $('#name-error'))));

// ---------- first visit: a one-time intro that ends by asking for a name ----------
const wlSteps = [...document.querySelectorAll<HTMLElement>('.wl-step')];
let wlAt = 0;
function wlShow(n: number) {
  wlAt = n;
  wlSteps.forEach((s, k) => (s.hidden = k !== n));
  $('#wl-title').innerHTML = wlSteps[n].dataset.title!; // our own markup, from index.html
  document.querySelectorAll('#wl-dots i').forEach((d, k) => d.classList.toggle('on', k === n));
  const last = n === wlSteps.length - 1;
  $('.wl-nav').hidden = last;
  $<HTMLButtonElement>('#wl-back').disabled = n === 0;
  if (last) store.set('pw.nameAsked', '1'), $<HTMLInputElement>('#wl-name').focus();
}
$('#wl-next').addEventListener('click', () => wlShow(wlAt + 1));
$('#wl-back').addEventListener('click', () => wlShow(wlAt - 1));
$('#wl-name-form').addEventListener('submit', (e) => (e.preventDefault(), saveName($<HTMLInputElement>('#wl-name').value, $('#wl-error'))));
function openWelcome() {
  store.set('pw.welcome', '1');
  dismissHint();
  wlShow(0);
  openPanel($('#welcome'));
}

// ---------- top bar ----------
const soundBtn = $('#sound');
const paintSound = () => {
  soundBtn.setAttribute('aria-pressed', String(soundOn()));
  soundBtn.setAttribute('aria-label', soundOn() ? 'Sound on' : 'Sound off');
};
// Browsers allow audio only after a gesture, so the music waits for the first tap or key anywhere.
const startMusic = () => (soundOn() && music(true), removeEventListener('pointerdown', startMusic), removeEventListener('keydown', startMusic));
addEventListener('pointerdown', startMusic);
addEventListener('keydown', startMusic);
soundBtn.addEventListener('click', () => {
  removeEventListener('pointerdown', startMusic);
  setSound(!soundOn());
  paintSound();
  if (soundOn()) chime(colour);
});
$('#timelapse-btn').addEventListener('click', () => openTimelapse(false));
$('#about-btn').addEventListener('click', () => {
  $('#about-stats').textContent =
    `${fmt(st.pixels)} pixels placed by ${fmt(st.people)} ${st.people === 1 ? 'person' : 'people'}; ${fmt(Math.max(0, st.online))} online now. ` +
    `You've placed ${fmt(st.mine)}, and ${fmt(myPixels.size)} are still showing.` +
    (st.since ? ` The canvas started on ${new Date(st.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.` : '');
  openPanel($('#about'));
});
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
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || document.querySelector('.panel.open')) return;
  if (e.key === 'Enter' && !placeBtn.disabled) placeDrafts();
  if (e.key === 'd') setMode(mode === 'draw' ? 'tap' : 'draw');
});

// ---------- boot ----------
// Offline support: the app shell loads without a connection and reconnects by itself.
if ('serviceWorker' in navigator && import.meta.env.PROD) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
// Embarko pins its badge to the bottom-left of hosted apps; leave room so it never covers Place.
document.documentElement.classList.toggle('hosted', location.hostname.endsWith('.embarko.app') || new URLSearchParams(location.search).has('hosted'));
pick(colour);
setMode(mode);
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
  sideTop();
  hello();
  setInterval(hello, 15_000);
  const q = new URLSearchParams(location.search);
  if (q.has('record') || q.has('timelapse')) openTimelapse(q.has('record'));
  // only brand-new visitors: anyone who already dismissed the old hint or has a name has played before
  else if (!store.get('pw.welcome') && store.get('pw.hint') !== '2' && !myName) openWelcome();
  const lx = Number(q.get('x')), ly = Number(q.get('y'));
  if (q.has('x') && q.has('y') && Number.isInteger(lx) && Number.isInteger(ly) && lx >= 0 && ly >= 0 && lx < W && ly < H) {
    dismissHint();
    goTo(lx, ly, Number(q.get('z')) || 16);
  }
})();
