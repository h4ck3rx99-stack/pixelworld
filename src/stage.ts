import { drawAnim, drawCell, drawStatic, keyOf, type Anim, type Cell, type M } from './render.ts';

/**
 * A canvas showing one rangoli. Settled pieces live on an offscreen static layer that is
 * redrawn only when something settles; each frame blits it and draws just the animating pieces.
 */
export class Stage {
  readonly g: CanvasRenderingContext2D;
  private st = document.createElement('canvas');
  private sg = this.st.getContext('2d')!;
  cells = new Map<number, Cell>();
  anims = new Map<number, Anim & { done?: boolean }>();
  w = 0;
  h = 0;
  dpr = 1;
  view = { cx: 0, cy: 0, s: 1 };
  guides = 1;
  staticThrottle = 0; // ms between static redraws while pieces are settling (timelapse uses this)
  /** Called first each frame; return true to keep the loop running. */
  onFrame?: (now: number) => boolean;
  /** Drawn on top each frame in device pixels; return true to keep the loop running. */
  overlay?: (g: CanvasRenderingContext2D, now: number) => boolean;
  private dirty = true;
  private lastStatic = 0;
  private raf = 0;

  constructor(readonly cv: HTMLCanvasElement) {
    this.g = cv.getContext('2d')!;
  }

  resize(w: number, h: number, view: { cx: number; cy: number; s: number }) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = w;
    this.h = h;
    this.cv.width = this.st.width = Math.round(w * this.dpr);
    this.cv.height = this.st.height = Math.round(h * this.dpr);
    this.cv.style.width = w + 'px';
    this.cv.style.height = h + 'px';
    this.setView(view);
  }

  setView(view: { cx: number; cy: number; s: number }) {
    this.view = view;
    this.invalidate();
  }

  /** View matrix: model units -> device pixels. */
  V(): M {
    const { cx, cy, s } = this.view, d = this.dpr;
    return [s * d, 0, 0, s * d, cx * d, cy * d];
  }

  invalidate() {
    this.dirty = true;
    this.kick();
  }

  reset(cells: Cell[]) {
    this.cells = new Map(cells.map((c) => [keyOf(c), c]));
    this.anims.clear();
    this.invalidate();
  }

  /** Puts a cell on the board, optionally with the bloom animation. */
  put(c: Cell, anim?: { dur?: number; stagger?: number; glow?: number }) {
    const k = keyOf(c);
    this.cells.set(k, c);
    if (anim) this.anims.set(k, { cell: c, start: performance.now(), dur: anim.dur ?? 420, stagger: anim.stagger ?? 55, glow: anim.glow ?? 2000 });
    else this.anims.delete(k), (this.dirty = true);
    this.kick();
  }

  remove(k: number, prev?: Cell) {
    prev ? this.cells.set(k, prev) : this.cells.delete(k);
    this.anims.delete(k);
    this.invalidate();
  }

  kick() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number) {
    this.raf = 0;
    let more = this.onFrame?.(now) ?? false;
    const v = this.V();
    if (this.dirty && now - this.lastStatic >= this.staticThrottle) {
      for (const [k, a] of this.anims) if (a.done) this.anims.delete(k);
      drawStatic(this.sg, this.st.width, this.st.height, v, this.cells, new Set(this.anims.keys()), this.guides);
      this.dirty = false;
      this.lastStatic = now;
    }
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.st, 0, 0);
    for (const a of this.anims.values()) {
      if (a.done) drawCell(g, v, a.cell);
      else if (!drawAnim(g, v, a, now)) (a.done = true), (this.dirty = true);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (this.overlay?.(g, now)) more = true;
    if (more || this.dirty || [...this.anims.values()].some((a) => !a.done)) this.kick();
  }
}
