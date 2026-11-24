import '@fontsource-variable/inter';
import './style.css';
import { BANK_SIZE, EMPTY, H, PALETTE, PALETTE_NAMES, REGEN_MS, W, type WireEvent } from '../shared/pixels.ts';
import { chime, setSound, soundOn } from './audio.ts';
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
let mode: 'move' | 'draw' = store.get('pw.mode') === 'draw' ? 'draw' : 'move';
let picking = false; // the colour picker is armed for the next tap
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
  const sheet = $('#sheet').getBoundingClientRect();
  const side = sheet.top < h / 2; // landscape phones: the sheet is a column on the right
  const right = side ? sheet.left : w, bottom = side ? h : sheet.top;
  document.documentElement.style.setProperty('--sheet-h', `${side ? 0 : h - bottom}px`);
  const availW = Math.max(120, right - 16), availH = Math.max(120, bottom - top - 12);
  // fit the whole canvas, however big
  base = { cx: right / 2, cy: top + (bottom - top) / 2, s: Math.max(0.05, Math.min(availW / W, availH / H)) };
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
let lastTap = { t: 0, x: 0, y: 0 };
const cv = board.cv;
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
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
  const p = pts.get(e.pointerId);
  pts.delete(e.pointerId);
  if (pts.size < 2) pinch = null;
  const wasStroke = stroke !== null;
  if (!pts.size) stroke = null;
  if (!p || moved || wasStroke || e.type === 'pointercancel' || pts.size) return;
  const dbl = e.timeStamp - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40;
  lastTap = { t: e.timeStamp, x: p.x, y: p.y };
  dismissHint();
  if (dbl && !picking) return animateZoom(zoom > 1.5 ? 1 : Math.min(maxZoom(), 16 / base.s), p.x, p.y); // dive in / back out
  tapPixel(board.pixelAt(p.x, p.y));
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
    const c = drafts.get(i) ?? board.colours[i];
    setPicking(false);
    if (c === EMPTY) return toast('That pixel is still blank.');
    pick(c);
    return toast(`Picked ${PALETTE_NAMES[c]}`);
  }
  if (drafts.get(i) === colour) drafts.delete(i);
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
let bank = { tokens: BANK_SIZE, at: Date.now() };
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
    : mode === 'draw' ? 'Drag on the canvas to draw' : 'Tap pixels to draft them';
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
      ? `${x}, ${y} · by ${myPixels.has(i) ? 'you' : r.by ?? 'anonymous'} · painted ${r.times}× · last ${ago(r.ts!)}`
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
  const s = await getJSON<State>(`/api/state?d=${deviceId}`);
  Object.assign(st, { lastId: s.lastId, mine: s.mine, since: s.since });
  ids.fill(0);
  myPixels.clear();
  s.myPixels.forEach((i) => myPixels.add(i));
  board.load(Uint8Array.from(atob(s.board), (ch) => ch.charCodeAt(0)));
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
  for (const [i, c] of drafts) {
    const [x, y, w] = board.rectOf(i);
    const r = Math.max(w, 2 * d);
    g.fillStyle = PALETTE[c];
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
function setMode(m: 'move' | 'draw') {
  mode = m;
  store.set('pw.mode', m);
  $('#mode-move').setAttribute('aria-pressed', String(m === 'move'));
  $('#mode-draw').setAttribute('aria-pressed', String(m === 'draw'));
  paintPlace();
}
function setPicking(on: boolean) {
  picking = on;
  $('#picker').setAttribute('aria-pressed', String(on));
  if (on) toast('Tap any pixel to copy its colour');
}
$('#mode-move').addEventListener('click', () => setMode('move'));
$('#mode-draw').addEventListener('click', () => setMode('draw'));
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

// ---------- location links: ?x=&y=&z= opens zoomed in on a pixel ----------
$('#link-btn').addEventListener('click', async () => {
  const url = `${location.origin}/?x=${lastTapped % W}&y=${(lastTapped / W) | 0}&z=${Math.round(base.s * zoom)}`;
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
$('#name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>('#name-input').value;
  const res = await postJSON('/api/name', { d: deviceId, name }).catch(() => ({ status: 0, body: {} as { name?: string } }));
  if (res.status === 200) {
    showName(res.body.name!);
    closeTop();
    toast(`You're @${res.body.name} now`);
  } else {
    $('#name-error').textContent =
      res.status === 409 ? 'Someone already has that name. Try another.'
      : res.status === 400 ? 'Use 2–20 letters, numbers, spaces, _ . or -'
      : "Couldn't save. Check your connection.";
  }
});

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
  if (e.target instanceof HTMLInputElement || !$('#name-panel').hidden) return;
  if (e.key === 'Enter' && !placeBtn.disabled) placeDrafts();
  if (e.key === 'd') setMode(mode === 'draw' ? 'move' : 'draw');
});

// ---------- boot ----------
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
  hello();
  setInterval(hello, 15_000);
  const q = new URLSearchParams(location.search);
  if (q.has('record') || q.has('timelapse')) openTimelapse(q.has('record'));
  const lx = Number(q.get('x')), ly = Number(q.get('y'));
  if (q.has('x') && q.has('y') && Number.isInteger(lx) && Number.isInteger(ly) && lx >= 0 && ly >= 0 && lx < W && ly < H) {
    dismissHint();
    goTo(lx, ly, Number(q.get('z')) || 16);
  }
})();
