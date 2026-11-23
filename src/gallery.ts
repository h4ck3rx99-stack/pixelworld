import type { WireEvent } from '../shared/grid.ts';
import { bell, soundOn, prime } from './audio.ts';
import { getJSON } from './net.ts';
import { cellFromWire, drawStatic, type Cell, type M } from './render.ts';
import { Stage } from './stage.ts';
import { $, fmt, openPanel, prettyDay, closeTop } from './ui.ts';

type DayInfo = { day: string; dayNo: number; pieces: number; people: number };
const people = (n: number) => `${fmt(n)} ${n === 1 ? 'person' : 'people'}`;

// ---------- gallery ----------
export async function openGallery() {
  const grid = $('#days');
  grid.replaceChildren();
  openPanel($('#gallery'));
  let data: { today: DayInfo; past: DayInfo[] };
  try {
    data = await getJSON('/api/days');
  } catch {
    grid.textContent = "Couldn't load the archive. Try again in a moment.";
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) io.unobserve(en.target), paintThumb(en.target as HTMLCanvasElement);
  }, { rootMargin: '200px' });
  const card = (d: DayInfo, today: boolean) => {
    const b = document.createElement('button');
    b.className = 'day';
    b.innerHTML = `<canvas></canvas><b></b><span></span>`;
    $('b', b).textContent = today ? `Today · Day ${d.dayNo}` : `Day ${d.dayNo} · ${prettyDay(d.day)}`;
    $('span', b).textContent = d.pieces ? `drawn by ${people(d.people)}${today ? ' so far' : ''}` : 'waiting for its first piece';
    const cv = $<HTMLCanvasElement>('canvas', b);
    cv.dataset.day = d.day;
    io.observe(cv);
    b.onclick = () => openTimelapse(d.day, false);
    b.setAttribute('aria-label', `Replay ${today ? "today's" : prettyDay(d.day, true)} rangoli`);
    grid.append(b);
  };
  card(data.today, true);
  data.past.forEach((d) => card(d, false));
  if (!data.past.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = "Each day's rangoli is archived here at midnight IST, with its full timelapse.";
    grid.append(p);
  }
}

async function paintThumb(cv: HTMLCanvasElement) {
  const r = cv.getBoundingClientRect();
  const d = Math.min(devicePixelRatio || 1, 2);
  cv.width = Math.round(r.width * d);
  cv.height = Math.round(r.height * d);
  let cells: Cell[] = [];
  try {
    cells = (await getJSON<{ cells: WireEvent[] }>(`/api/day/${cv.dataset.day}/snapshot`)).cells.map(cellFromWire);
  } catch { /* empty day: draw the bare floor */ }
  const s = (cv.width / 2) * 0.9;
  const v: M = [s, 0, 0, s, cv.width / 2, cv.height / 2];
  drawStatic(cv.getContext('2d')!, cv.width, cv.height, v, new Map(cells.map((c) => [c.ring * 64 + c.slot, c])), undefined, 0.5);
}

// ---------- timelapse ----------
const DURATION = 20_000;
let tl: Stage | null = null;
let play: { start: number; i: number; n: number; ev: number[]; dur: number; rung: boolean } | null = null;

const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);

function layoutTl() {
  if (!tl) return;
  const w = innerWidth, h = innerHeight;
  const rec = $('#tl').classList.contains('rec');
  // record mode: rangoli centred with room for the date above and the count below
  const s = Math.min(w * 0.47, (h * (rec ? 0.66 : 0.6)) / 2.1);
  tl.resize(w, h, { cx: w / 2, cy: h * (rec ? 0.5 : 0.47), s });
}

export async function openTimelapse(day: string, record: boolean) {
  const panel = $('#tl');
  panel.classList.toggle('rec', record);
  panel.classList.remove('done');
  openPanel(panel, () => {
    play = null;
    removeEventListener('resize', layoutTl);
  });
  tl ??= new Stage($<HTMLCanvasElement>('#tl canvas'));
  tl.guides = 0.35;
  tl.staticThrottle = 140;
  tl.onFrame = frame;
  addEventListener('resize', layoutTl);
  layoutTl();
  tl.reset([]);
  $('#tl-date').textContent = 'Loading…';
  $('#tl-count').textContent = '';
  let log: { day: string; dayNo: number; pieces: number; people: number; ev: number[] };
  try {
    log = await getJSON(`/api/day/${day}/log`);
  } catch {
    $('#tl-date').textContent = 'Nothing drawn on this day yet.';
    return;
  }
  $('#tl-date').textContent = prettyDay(log.day, true);
  $('#tl-count').textContent = `Day ${log.dayNo} · drawn live by ${people(log.people)}`;
  const n = log.ev.length / 4;
  play = { start: 0, i: 0, n, ev: log.ev, dur: n < 60 ? 9000 : DURATION, rung: false };
  if (record) showRecHint();
  else start();
}

function start() {
  if (!play || !tl) return;
  const recording = $('#tl').classList.contains('rec');
  if (soundOn() || recording) prime();
  $('#tl').classList.remove('done');
  tl.reset([]);
  Object.assign(play, { start: performance.now() + 500, i: 0, rung: false });
  tl.kick();
}

function frame(now: number) {
  if (!play || !tl || !play.start) return false;
  const t = (now - play.start) / play.dur;
  if (t < 0) return true;
  const target = Math.min(play.n, Math.floor(ease(Math.min(1, t)) * play.n));
  // Spread work: many events per frame on big days, so animate fewer of them.
  const busy = target - play.i > 6;
  const calm = target - play.i <= 1; // glow only while pieces arrive one at a time, or it washes out
  for (; play.i < target; play.i++) {
    const o = play.i * 4;
    const c: Cell = { id: play.i, ring: play.ev[o], slot: play.ev[o + 1], piece: play.ev[o + 2], colour: play.ev[o + 3], who: '' };
    tl.put(c, { dur: 380, stagger: busy ? 0 : 35, glow: calm ? 700 : 0 });
  }
  if (t >= 1 && !play.rung) {
    play.rung = true;
    bell($('#tl').classList.contains('rec'));
    $('#tl').classList.add('done');
    return false;
  }
  return t < 1;
}

let recHintTimer = 0;
function showRecHint() {
  const h = $('#tl-hint');
  h.classList.add('show');
  clearTimeout(recHintTimer);
  recHintTimer = window.setTimeout(() => h.classList.remove('show'), 2500);
}

// Record mode: tap = play / replay, double-tap = leave record mode.
let lastTap = 0;
$('#tl canvas').addEventListener('click', (e) => {
  const panel = $('#tl');
  if (!panel.classList.contains('rec')) return;
  if (e.timeStamp - lastTap < 320) {
    lastTap = 0;
    panel.classList.remove('rec');
    layoutTl();
    return;
  }
  lastTap = e.timeStamp;
  $('#tl-hint').classList.remove('show');
  setTimeout(() => lastTap && start(), 330);
});
$('#tl-replay').addEventListener('click', start);
$('#tl-record').addEventListener('click', () => {
  $('#tl').classList.add('rec');
  layoutTl();
  tl?.reset([]);
  if (play) play.start = 0;
  showRecHint();
});
$('#tl-close').addEventListener('click', () => closeTop());
