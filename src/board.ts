import { EMPTY, PALETTE, PAPER, SIZE } from '../shared/pixels.ts';

const RGB = [...PALETTE, PAPER].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
const rgbOf = (c: number) => RGB[c === EMPTY ? PALETTE.length : c];
export const BG = '#0E1020';

/**
 * One SIZE x SIZE pixel canvas drawn crisp at any zoom. The pixels live on a 1:1 offscreen
 * canvas; each frame is a single scaled drawImage, so the cost does not grow with activity.
 */
export class Board {
  readonly g: CanvasRenderingContext2D;
  readonly px = document.createElement('canvas');
  private pg: CanvasRenderingContext2D;
  colours: Uint8Array = new Uint8Array(SIZE * SIZE).fill(EMPTY);
  w = 0;
  h = 0;
  dpr = 1;
  view = { cx: 0, cy: 0, s: 1 }; // s = css px per board pixel
  /** Called each frame before drawing; return true to keep animating. */
  onFrame?: (now: number) => boolean;
  /** Drawn on top in device pixels; return true to keep animating. */
  overlay?: (g: CanvasRenderingContext2D, now: number) => boolean;
  private flashes: { i: number; start: number }[] = [];
  private raf = 0;

  constructor(readonly cv: HTMLCanvasElement) {
    this.g = cv.getContext('2d')!;
    this.px.width = this.px.height = SIZE;
    this.pg = this.px.getContext('2d')!;
    this.load(this.colours);
  }

  resize(w: number, h: number, view: Board['view']) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = w;
    this.h = h;
    this.cv.width = Math.round(w * this.dpr);
    this.cv.height = Math.round(h * this.dpr);
    this.cv.style.width = w + 'px';
    this.cv.style.height = h + 'px';
    this.setView(view);
  }

  setView(view: Board['view']) {
    this.view = view;
    this.kick();
  }

  load(colours: Uint8Array) {
    this.colours = colours;
    const img = this.pg.createImageData(SIZE, SIZE);
    const px = new Uint32Array(img.data.buffer); // one write per pixel (RGBA, little-endian)
    const packed = new Uint32Array(256).map((_, c) => {
      const [r, g, b] = rgbOf(c < PALETTE.length ? c : EMPTY);
      return (255 << 24) | (b << 16) | (g << 8) | r;
    });
    for (let i = 0; i < colours.length; i++) px[i] = packed[colours[i]];
    this.pg.putImageData(img, 0, 0);
    this.flashes = [];
    this.kick();
  }

  set(i: number, colour: number, flash = true) {
    this.colours[i] = colour;
    this.pg.fillStyle = colour === EMPTY ? PAPER : PALETTE[colour];
    this.pg.fillRect(i % SIZE, (i / SIZE) | 0, 1, 1);
    if (flash) this.flashes.push({ i, start: performance.now() });
    this.kick();
  }

  /** Screen (css px) -> board pixel index, or -1 outside the board. */
  pixelAt(x: number, y: number) {
    const { cx, cy, s } = this.view;
    const bx = Math.floor((x - cx) / s + SIZE / 2), by = Math.floor((y - cy) / s + SIZE / 2);
    return bx < 0 || by < 0 || bx >= SIZE || by >= SIZE ? -1 : by * SIZE + bx;
  }

  /** Device-pixel rectangle of a board pixel. */
  rectOf(i: number) {
    const { cx, cy, s } = this.view, d = this.dpr;
    return [(cx + (i % SIZE - SIZE / 2) * s) * d, (cy + (((i / SIZE) | 0) - SIZE / 2) * s) * d, s * d] as const;
  }

  kick() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number) {
    this.raf = 0;
    let more = this.onFrame?.(now) ?? false;
    const g = this.g, d = this.dpr, { cx, cy, s } = this.view;
    const size = SIZE * s * d, x0 = (cx * d - size / 2), y0 = (cy * d - size / 2);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = BG;
    g.fillRect(0, 0, this.cv.width, this.cv.height);
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 40 * d;
    g.shadowOffsetY = 12 * d;
    g.fillStyle = PAPER;
    g.fillRect(x0, y0, size, size);
    g.shadowColor = 'transparent';
    g.imageSmoothingEnabled = false;
    g.drawImage(this.px, x0, y0, size, size);

    // faint grid once pixels are big enough to aim at
    const cell = s * d;
    if (cell >= 10) {
      g.strokeStyle = `rgba(14,16,32,${Math.min(0.14, (cell - 10) / 60)})`;
      g.lineWidth = 1;
      g.beginPath();
      const a = Math.max(0, Math.floor(-x0 / cell)), b = Math.min(SIZE, Math.ceil((this.cv.width - x0) / cell));
      const c = Math.max(0, Math.floor(-y0 / cell)), e = Math.min(SIZE, Math.ceil((this.cv.height - y0) / cell));
      for (let i = a; i <= b; i++) g.moveTo(Math.round(x0 + i * cell) + 0.5, y0 + c * cell), g.lineTo(Math.round(x0 + i * cell) + 0.5, y0 + e * cell);
      for (let j = c; j <= e; j++) g.moveTo(x0 + a * cell, Math.round(y0 + j * cell) + 0.5), g.lineTo(x0 + b * cell, Math.round(y0 + j * cell) + 0.5);
      g.stroke();
    }

    // new pixels pop with a ring that fades over ~0.9s
    this.flashes = this.flashes.filter((f) => now - f.start < 900);
    for (const f of this.flashes) {
      const t = (now - f.start) / 900;
      const [x, y, w] = this.rectOf(f.i);
      const grow = Math.max(3 * d, w) * (0.6 + 1.4 * t);
      g.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.9})`;
      g.lineWidth = 2 * d;
      g.strokeRect(x + w / 2 - grow / 2, y + w / 2 - grow / 2, grow, grow);
    }
    if (this.flashes.length) more = true;
    if (this.overlay?.(g, now)) more = true;
    if (more) this.kick();
  }
}
