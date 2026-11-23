// Tiny synthesised sounds, so there are no audio files to load. Muted by default.
let ac: AudioContext | null = null;
let on = (() => {
  try { return localStorage.getItem('pw.sound') === '1'; } catch { return false; }
})();

export const soundOn = () => on;
export function setSound(v: boolean) {
  on = v;
  try { localStorage.setItem('pw.sound', v ? '1' : '0'); } catch { /* private mode */ }
  if (v) ctx();
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

/** Temple-bell partials for the end of a timelapse. Plays even when muted if `force` (record mode). */
export function bell(force = false) {
  if (!on && !force) return;
  const t = ctx().currentTime;
  const f = 392;
  [[1, 0.09, 3.5], [2.01, 0.05, 2.6], [2.76, 0.04, 2], [5.4, 0.02, 1.2], [8.93, 0.01, 0.8]].forEach(([m, g, d]) => tone(f * m, t, d, g));
}
