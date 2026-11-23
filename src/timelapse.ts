import { EMPTY, SIZE } from '../shared/pixels.ts';
import { bell, prime, soundOn } from './audio.ts';
import { Board } from './board.ts';
import { getJSON } from './net.ts';
import { $, closeTop, fmt, openPanel } from './ui.ts';

const DURATION = 20_000;
let tl: Board | null = null;
let play: { start: number; i: number; n: number; ev: number[]; dur: number; rung: boolean } | null = null;

const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);
const sinceText = (ts: number) =>
  ts ? new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

function layoutTl() {
  if (!tl) return;
  const w = innerWidth, h = innerHeight;
  const rec = $('#tl').classList.contains('rec');
  const s = Math.min(w - 24, h * (rec ? 0.66 : 0.62)) / SIZE;
  tl.resize(w, h, { cx: w / 2, cy: h * (rec ? 0.5 : 0.47), s });
}

/** Replays the canvas's whole history, blank to now, in about 20 seconds. */
export async function openTimelapse(record: boolean) {
  const panel = $('#tl');
  panel.classList.toggle('rec', record);
  panel.classList.remove('done');
  openPanel(panel, () => {
    play = null;
    removeEventListener('resize', layoutTl);
  });
  tl ??= new Board($<HTMLCanvasElement>('#tl canvas'));
  tl.onFrame = frame;
  addEventListener('resize', layoutTl);
  layoutTl();
  tl.load(new Uint8Array(SIZE * SIZE).fill(EMPTY));
  $('#tl-count').textContent = 'Loading…';
  let log: { since: number; pixels: number; people: number; ev: number[] };
  try {
    log = await getJSON('/api/log');
  } catch {
    $('#tl-count').textContent = "Couldn't load the history. Try again in a moment.";
    return;
  }
  $('#tl-count').textContent = log.pixels
    ? `${fmt(log.pixels)} pixels by ${fmt(log.people)} ${log.people === 1 ? 'person' : 'people'}${log.since ? ` · since ${sinceText(log.since)}` : ''}`
    : 'Nothing drawn yet.';
  const n = log.ev.length / 3;
  play = { start: 0, i: 0, n, ev: log.ev, dur: n < 60 ? 9000 : DURATION, rung: false };
  if (record) showRecHint();
  else start();
}

function start() {
  if (!play || !tl) return;
  if (soundOn() || $('#tl').classList.contains('rec')) prime();
  $('#tl').classList.remove('done');
  tl.load(new Uint8Array(SIZE * SIZE).fill(EMPTY));
  Object.assign(play, { start: performance.now() + 500, i: 0, rung: false });
  tl.kick();
}

function frame(now: number) {
  if (!play || !tl || !play.start) return false;
  const t = (now - play.start) / play.dur;
  if (t < 0) return true;
  const target = Math.min(play.n, Math.floor(ease(Math.min(1, t)) * play.n));
  const calm = target - play.i <= 2; // flash only while pixels arrive a few at a time
  for (; play.i < target; play.i++) {
    const o = play.i * 3;
    tl.set(play.ev[o + 1] * SIZE + play.ev[o], play.ev[o + 2], calm);
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
  tl?.load(new Uint8Array(SIZE * SIZE).fill(EMPTY));
  if (play) play.start = 0;
  showRecHint();
});
$('#tl-close').addEventListener('click', () => closeTop());
