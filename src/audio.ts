// Tiny synthesised sounds and a quiet chiptune loop, so there are no audio files to load. On by default;
// browsers only allow audio after the first tap, so the music starts then.
let ac: AudioContext | null = null;
let on = (() => {
  try { return localStorage.getItem('pw.sound') !== '0'; } catch { return true; }
})();

export const soundOn = () => on;
export function setSound(v: boolean) {
  on = v;
  try { localStorage.setItem('pw.sound', v ? '1' : '0'); } catch { /* private mode */ }
  if (v) ctx(), music(true);
  else music(false);
}
/** Call inside a user gesture so a later bell is allowed to play. */
export const prime = () => void ctx();
function ctx() {
  ac ??= new AudioContext();
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

function tone(freq: number, start: number, dur: number, gain: number) {
  const a = ctx();
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(a.destination);
  o.start(start);
  o.stop(start + dur + 0.05);
}

/** Soft two-note chime when you place a pixel. */
export function chime(colour: number) {
  if (!on) return;
  const t = ctx().currentTime;
  const base = [880, 988, 1047, 1175, 1319, 1397, 1568, 1760][colour % 8];
  tone(base, t, 0.5, 0.05);
  tone(base * 1.5, t + 0.06, 0.6, 0.03);
}

// ---------- background music: a looping 8-bar tune in C major pentatonic, square lead over a triangle bass ----------
const BPM = 96, STEP = 60 / BPM / 2; // eighth notes
// 0 = rest; numbers are semitones above C4
const LEAD = [12, 0, 16, 19, 16, 0, 14, 12, 9, 0, 12, 14, 16, 0, 0, 0, 12, 0, 16, 19, 21, 19, 16, 0, 14, 0, 12, 9, 12, 0, 0, 0,
  19, 0, 21, 19, 16, 0, 14, 16, 12, 0, 9, 7, 9, 12, 0, 0, 16, 14, 12, 0, 9, 0, 12, 14, 12, 0, 0, 0, 0, 0, 0, 0];
const BASS = [-24, -17, -15, -20]; // C, G, A, E, one per two bars
let bus: GainNode | null = null;
let nextAt = 0, step = 0, timer = 0;
function note(type: OscillatorType, semis: number, start: number, dur: number, gain: number) {
  const a = ctx(), o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.value = 261.63 * 2 ** (semis / 12);
  g.gain.setValueAtTime(gain, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(bus!);
  o.start(start);
  o.stop(start + dur + 0.02);
}
function schedule() {
  const a = ctx();
  while (nextAt < a.currentTime + 0.25) {
    const s = step % LEAD.length;
    if (LEAD[s]) note('square', LEAD[s], nextAt, STEP * 0.9, 0.05);
    if (s % 4 === 0) note('triangle', BASS[Math.floor(s / 16) % BASS.length], nextAt, STEP * 3.6, 0.12);
    nextAt += STEP;
    step++;
  }
}
/** Starts or stops the background loop. Quiet on purpose: it sits under the place chime. */
export function music(play: boolean) {
  clearInterval(timer);
  timer = 0;
  if (!play || !on || document.hidden) return void bus?.gain.setTargetAtTime(0, ac?.currentTime ?? 0, 0.1);
  const a = ctx();
  if (!bus) (bus = a.createGain()).connect(a.destination);
  bus.gain.setTargetAtTime(0.35, a.currentTime, 0.3);
  nextAt = Math.max(nextAt, a.currentTime + 0.05);
  timer = window.setInterval(schedule, 100);
  schedule();
}
document.addEventListener('visibilitychange', () => ac && music(!document.hidden));

/** Temple-bell partials for the end of a timelapse. Plays even when muted if `force` (record mode). */
export function bell(force = false) {
  if (!on && !force) return;
  const t = ctx().currentTime;
  const f = 392;
  [[1, 0.09, 3.5], [2.01, 0.05, 2.6], [2.76, 0.04, 2], [5.4, 0.02, 1.2], [8.93, 0.01, 0.8]].forEach(([m, g, d]) => tone(f * m, t, d, g));
}
