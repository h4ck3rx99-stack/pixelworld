import { cellCentre, cellKey, COLOURS, R0, RING_W, RINGS, SYM, type WireEvent } from '../shared/grid.ts';

export const SPR = 128; // sprite size in px
const FILL = 0.84; // share of the sprite half-size the shape occupies (rest is powder spill)
export type Cell = { id: number; ring: number; slot: number; piece: number; colour: number; who: string };
export type M = [number, number, number, number, number, number];
export const cellFromWire = (e: WireEvent): Cell => ({ id: e[0], ring: e[1], slot: e[2], piece: e[3], colour: e[4], who: e[5] });
export const keyOf = (c: { ring: number; slot: number }) => cellKey(c.ring, c.slot);

const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

function canvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function mix(hex: string, to: number, t: number) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) * (1 - t) + to * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

// ---- piece shapes, unit box [-1,1], outward = -y ----
type Shape = (g: CanvasRenderingContext2D, col: string) => void;
const fillPath = (g: CanvasRenderingContext2D, col: string, build: (p: Path2D) => void, rule: CanvasFillRule = 'nonzero') => {
  const p = new Path2D();
  build(p);
  g.fillStyle = col;
  g.fill(p, rule);
};
const cut = (g: CanvasRenderingContext2D, fn: () => void) => {
  g.save();
  g.globalCompositeOperation = 'destination-out';
  fn();
  g.restore();
};

const SHAPES: Shape[] = [
  // bindu
  (g, c) => fillPath(g, c, (p) => p.arc(0, 0, 0.6, 0, Math.PI * 2)),
  // petal
  (g, c) => fillPath(g, c, (p) => {
    p.moveTo(0, -1);
    p.bezierCurveTo(0.66, -0.45, 0.52, 0.6, 0, 0.98);
    p.bezierCurveTo(-0.52, 0.6, -0.66, -0.45, 0, -1);
  }),
  // leaf (asymmetric, so mirrored copies read as a pair)
  (g, c) => {
    fillPath(g, c, (p) => {
      p.moveTo(0.05, -1);
      p.bezierCurveTo(0.8, -0.45, 0.5, 0.6, 0, 0.98);
      p.bezierCurveTo(-0.3, 0.45, -0.6, -0.35, 0.05, -1);
    });
    cut(g, () => {
      g.lineWidth = 0.09;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(0, 0.8);
      g.quadraticCurveTo(0.12, 0, 0.06, -0.75);
      g.stroke();
    });
  },
  // teardrop
  (g, c) => fillPath(g, c, (p) => {
    p.moveTo(0, -1);
    p.bezierCurveTo(0.3, -0.55, 0.62, -0.15, 0.62, 0.3);
    p.arc(0, 0.3, 0.62, 0, Math.PI);
    p.bezierCurveTo(-0.62, -0.15, -0.3, -0.55, 0, -1);
  }),
  // diamond with a pierced centre
  (g, c) => fillPath(g, c, (p) => {
    p.moveTo(0, -1); p.lineTo(0.62, 0); p.lineTo(0, 1); p.lineTo(-0.62, 0); p.closePath();
    p.moveTo(0, -0.28); p.lineTo(0.17, 0); p.lineTo(0, 0.28); p.lineTo(-0.17, 0); p.closePath();
  }, 'evenodd'),
  // crescent, horns outward
  (g, c) => {
    fillPath(g, c, (p) => p.arc(0, 0.1, 0.8, 0, Math.PI * 2));
    cut(g, () => {
      g.beginPath();
      g.arc(0, -0.3, 0.68, 0, Math.PI * 2);
      g.fill();
    });
  },
  // swirl (chiral)
  (g, c) => {
    g.strokeStyle = c;
    g.lineWidth = 0.22;
    g.lineCap = 'round';
    g.beginPath();
    const T = Math.PI * 2.6;
    for (let t = 0; t <= T; t += 0.05) {
      const r = 0.06 + 0.78 * Math.pow(t / T, 1.15);
      const x = r * Math.cos(t - Math.PI / 2), y = r * Math.sin(t - Math.PI / 2) + 0.05;
      t ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.beginPath();
    g.arc(0, 0.05, 0.12, 0, Math.PI * 2);
    g.fillStyle = c;
    g.fill();
  },
  // small diya: bowl + flame
  (g, c) => {
    fillPath(g, c, (p) => {
      p.moveTo(-0.9, 0.18);
      p.quadraticCurveTo(0, 1.15, 0.9, 0.18);
      p.quadraticCurveTo(0, 0.38, -0.9, 0.18);
    });
    fillPath(g, mix(c, 255, 0.5), (p) => {
      p.moveTo(0, -1);
      p.bezierCurveTo(0.34, -0.6, 0.36, -0.22, 0, -0.02);
      p.bezierCurveTo(-0.36, -0.22, -0.34, -0.6, 0, -1);
    });
  },
];

/** Gives a flat vector shape the look of coloured powder: grain, soft holes, a slight mound and spilled specks. */
function powder(cv: HTMLCanvasElement, col: string) {
  const rnd = Math.random;
  const g = cv.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0); // the caller left its shape transform on this context
  const w = cv.width;
  // mound shading: lighter crown, darker rim
  g.save();
  g.globalCompositeOperation = 'source-atop';
  const rg = g.createRadialGradient(w * 0.46, w * 0.42, 0, w * 0.46, w * 0.42, w * 0.6);
  rg.addColorStop(0, 'rgba(255,255,255,0.16)');
  rg.addColorStop(0.6, 'rgba(255,255,255,0)');
  rg.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = rg;
  g.fillRect(0, 0, w, w);
  g.restore();

  const img = g.getImageData(0, 0, w, w);
  const d = img.data;
  const mask = new Uint8Array(w * w);
  for (let i = 0; i < w * w; i++) mask[i] = d[i * 4 + 3] > 40 ? 1 : 0;
  for (let i = 0; i < w * w; i++) {
    const a = d[i * 4 + 3];
    if (!a) continue;
    const k = 1 + (rnd() - 0.5) * 0.32;
    d[i * 4] = Math.min(255, d[i * 4] * k);
    d[i * 4 + 1] = Math.min(255, d[i * 4 + 1] * k);
    d[i * 4 + 2] = Math.min(255, d[i * 4 + 2] * k);
    if (rnd() < 0.07) d[i * 4 + 3] = a * 0.35; // powder gaps
  }
  g.putImageData(img, 0, 0);
  // spill: specks just outside the shape edge
  g.fillStyle = col;
  const near = (x: number, y: number, r: number) => {
    for (let k = 0; k < 8; k++) {
      const xx = Math.round(x + Math.cos((k * Math.PI) / 4) * r), yy = Math.round(y + Math.sin((k * Math.PI) / 4) * r);
      if (xx >= 0 && yy >= 0 && xx < w && yy < w && mask[yy * w + xx]) return true;
    }
    return false;
  };
  for (let n = 0; n < w * 6; n++) {
    const x = rnd() * w, y = rnd() * w;
    if (mask[(y | 0) * w + (x | 0)]) continue;
    const r = 1 + rnd() * w * 0.05;
    if (!near(x, y, r)) continue;
    g.globalAlpha = 0.25 + rnd() * 0.5 * (1 - r / (w * 0.06));
    g.fillRect(x, y, 1 + rnd() * 1.4, 1 + rnd() * 1.4);
  }
  g.globalAlpha = 1;
}

function makePiece(piece: number, colour: number) {
  const cv = canvas(SPR);
  const g = cv.getContext('2d')!;
  g.translate(SPR / 2, SPR / 2);
  g.scale((SPR / 2) * FILL, (SPR / 2) * FILL);
  SHAPES[piece](g, COLOURS[colour]);
  powder(cv, COLOURS[colour]);
  return cv;
}

function lotusShape(g: CanvasRenderingContext2D, col: string, outline = false) {
  const petal = (len: number, wid: number) => {
    const p = new Path2D();
    p.moveTo(0, 0);
    p.bezierCurveTo(wid, -len * 0.35, wid * 0.8, -len * 0.8, 0, -len);
    p.bezierCurveTo(-wid * 0.8, -len * 0.8, -wid, -len * 0.35, 0, 0);
    return p;
  };
  const layer = (len: number, wid: number, off: number, c: string) => {
    for (let k = 0; k < 8; k++) {
      g.save();
      g.rotate(off + (k * Math.PI) / 4);
      const p = petal(len, wid);
      if (outline) (g.strokeStyle = c), g.stroke(p);
      else (g.fillStyle = c), g.fill(p);
      g.restore();
    }
  };
  if (outline) g.lineWidth = 0.03;
  layer(1, 0.36, 0, outline ? col : col);
  layer(0.72, 0.3, Math.PI / 8, outline ? col : mix(col, 255, 0.35));
  g.beginPath();
  g.arc(0, 0, 0.26, 0, Math.PI * 2);
  if (outline) g.stroke();
  else (g.fillStyle = mix(col, 0, 0.35)), g.fill();
  if (!outline) {
    g.beginPath();
    g.arc(0, 0, 0.11, 0, Math.PI * 2);
    g.fillStyle = mix(col, 255, 0.7);
    g.fill();
  }
}

function makeLotus(colour: number) {
  const n = SPR * 2;
  const cv = canvas(n);
  const g = cv.getContext('2d')!;
  g.translate(n / 2, n / 2);
  g.scale((n / 2) * FILL, (n / 2) * FILL);
  lotusShape(g, COLOURS[colour]);
  powder(cv, COLOURS[colour]);
  return cv;
}

function makeGlow(colour: number) {
  const cv = canvas(64);
  const g = cv.getContext('2d')!;
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, mix(COLOURS[colour], 255, 0.3).replace('rgb', 'rgba').replace(')', ',0.85)'));
  rg.addColorStop(0.45, mix(COLOURS[colour], 255, 0).replace('rgb', 'rgba').replace(')', ',0.3)'));
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 64, 64);
  return cv;
}

// Built on first use so the first paint does not wait for all 80 textures.
const cache = new Map<string, HTMLCanvasElement>();
const memo = (k: string, make: () => HTMLCanvasElement) => cache.get(k) ?? (cache.set(k, make()), cache.get(k)!);
export const spr = (p: number, c: number) => memo(`p${p}.${c}`, () => makePiece(p, c));
const lotusSpr = (c: number) => memo(`l${c}`, () => makeLotus(c));
const glowSpr = (c: number) => memo(`g${c}`, () => makeGlow(c));

// ---- floor and board ----
let noiseTile: HTMLCanvasElement | null = null;
function noise() {
  if (noiseTile) return noiseTile;
  noiseTile = canvas(192);
  const g = noiseTile.getContext('2d')!;
  const img = g.createImageData(192, 192);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 20;
  }
  g.putImageData(img, 0, 0);
  return noiseTile;
}

/** Screen-fixed dark terracotta floor with grain and vignette. */
export function drawFloor(g: CanvasRenderingContext2D, w: number, h: number) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  const rg = g.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, Math.max(w, h) * 0.75);
  rg.addColorStop(0, '#3b2620');
  rg.addColorStop(0.55, '#2a1c18');
  rg.addColorStop(1, '#140e0d');
  g.fillStyle = rg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = g.createPattern(noise(), 'repeat')!;
  g.fillRect(0, 0, w, h);
}

/** Swept disc, chalk guides and dotted border, in model space through view matrix v. */
export function drawBase(g: CanvasRenderingContext2D, v: M, guides = 1) {
  g.setTransform(...v);
  const rg = g.createRadialGradient(0, 0, 0, 0, 0, 1.08);
  rg.addColorStop(0, 'rgba(255,225,200,0.07)');
  rg.addColorStop(0.92, 'rgba(255,225,200,0.035)');
  rg.addColorStop(1, 'rgba(255,225,200,0)');
  g.fillStyle = rg;
  g.beginPath();
  g.arc(0, 0, 1.08, 0, Math.PI * 2);
  g.fill();
  const px = 1 / v[0];
  if (guides > 0) {
    g.fillStyle = `rgba(247,243,233,${0.13 * guides})`;
    for (let i = 1; i < RINGS; i++) {
      const r = R0 + (i - 1) * RING_W;
      const n = Math.round((r * Math.PI * 2) / (RING_W * 0.5));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        g.fillRect(r * Math.cos(a) - px * 0.75, r * Math.sin(a) - px * 0.75, px * 1.5, px * 1.5);
      }
    }
    g.strokeStyle = `rgba(247,243,233,${0.05 * guides})`;
    g.lineWidth = px;
    g.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      g.moveTo(R0 * Math.cos(a), R0 * Math.sin(a));
      g.lineTo(Math.cos(a), Math.sin(a));
    }
    g.stroke();
  }
  // chalk border: a ring of dots like a real rangoli outline
  g.fillStyle = 'rgba(247,243,233,0.5)';
  for (let k = 0; k < 160; k++) {
    const a = (k / 160) * Math.PI * 2;
    g.beginPath();
    g.arc(1.035 * Math.cos(a), 1.035 * Math.sin(a), k % 4 === 0 ? 0.0085 : 0.0045, 0, Math.PI * 2);
    g.fill();
  }
}

export function drawLotus(g: CanvasRenderingContext2D, v: M, colour: number | null, scale = 1, alpha = 1) {
  const s = R0 * 1.02 * scale;
  g.globalAlpha = alpha;
  if (colour == null) {
    g.setTransform(v[0] * s, v[1] * s, v[2] * s, v[3] * s, v[4], v[5]);
    lotusShape(g, 'rgba(247,243,233,0.28)', true);
  } else {
    const k = s / ((SPR) * FILL);
    g.setTransform(v[0] * k, v[1] * k, v[2] * k, v[3] * k, v[4], v[5]);
    g.drawImage(lotusSpr(colour), -SPR, -SPR);
  }
  g.globalAlpha = 1;
}

/** Matrix placing a piece's sprite for one symmetry copy. grow scales size, push scales radius. */
export function pieceMatrix(v: M, k: number, c: { ring: number; slot: number }, grow = 1, push = 1): M {
  const { r, a, half } = cellCentre(c.ring, c.slot);
  const sc = (half * grow) / ((SPR / 2) * FILL);
  const t = a + Math.PI / 2;
  const L: M = [Math.cos(t) * sc, Math.sin(t) * sc, -Math.sin(t) * sc, Math.cos(t) * sc, r * push * Math.cos(a), r * push * Math.sin(a)];
  const [sa, sb, scc, sd] = SYM[k];
  return mul(mul(v, [sa, sb, scc, sd, 0, 0]), L);
}

/** A settled cell: the lotus for ring 0, otherwise 8 copies of the piece. */
export function drawCell(g: CanvasRenderingContext2D, v: M, c: Cell) {
  c.ring === 0 ? drawLotus(g, v, c.colour) : drawPiece(g, v, c);
}

export function drawPiece(g: CanvasRenderingContext2D, v: M, c: Cell) {
  const s = spr(c.piece, c.colour);
  for (let k = 0; k < 8; k++) {
    g.setTransform(...pieceMatrix(v, k, c));
    g.drawImage(s, -SPR / 2, -SPR / 2);
  }
}

/** Everything that is not animating: floor, base, lotus and settled pieces. */
export function drawStatic(g: CanvasRenderingContext2D, w: number, h: number, v: M, cells: Map<number, Cell>, skip?: Set<number>, guides = 1) {
  drawFloor(g, w, h);
  drawBase(g, v, guides);
  const centre = cells.get(0);
  drawLotus(g, v, centre && !skip?.has(0) ? centre.colour : null);
  for (const [k, c] of cells) if (k !== 0 && !skip?.has(k)) drawPiece(g, v, c);
  g.setTransform(1, 0, 0, 1, 0, 0);
}

const backOut = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
export type Anim = { cell: Cell; start: number; dur: number; stagger: number; glow: number };

/** Draws one blooming piece; returns false once fully settled (glow included). */
export function drawAnim(g: CanvasRenderingContext2D, v: M, a: Anim, now: number) {
  const { cell } = a;
  const el = now - a.start;
  if (cell.ring === 0) {
    const t = Math.min(1, Math.max(0, el / (a.dur * 1.6)));
    drawLotus(g, v, cell.colour, 0.4 + 0.6 * backOut(t), Math.min(1, t * 3));
  } else {
    const s = spr(cell.piece, cell.colour);
    for (let k = 0; k < 8; k++) {
      const t = Math.min(1, Math.max(0, (el - k * a.stagger) / a.dur));
      if (t <= 0) continue;
      const e = backOut(t);
      g.globalAlpha = Math.min(1, t * 2.5);
      g.setTransform(...pieceMatrix(v, k, cell, e, 0.82 + 0.18 * Math.min(1, e)));
      g.drawImage(s, -SPR / 2, -SPR / 2);
    }
  }
  const gl = a.glow ? 1 - el / a.glow : 0;
  if (gl > 0) {
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = gl * gl * 0.9;
    const gs = glowSpr(cell.colour);
    const ks = cell.ring === 0 ? [0] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (const k of ks) {
      const m = cell.ring === 0 ? v : pieceMatrix(v, k, cell);
      const f = cell.ring === 0 ? (R0 * 2.4) / 32 : ((SPR / 2) * 2.6) / 32;
      g.setTransform(m[0] * f, m[1] * f, m[2] * f, m[3] * f, m[4], m[5]);
      g.drawImage(gs, -32, -32);
    }
    g.globalCompositeOperation = 'source-over';
  }
  g.globalAlpha = 1;
  return el < Math.max(a.dur + a.stagger * 7, a.glow);
}

/** Device-pixel centres of the 8 copies of a cell, for highlight rings. */
export function copyCentres(v: M, c: { ring: number; slot: number }) {
  if (c.ring === 0) return [[v[4], v[5], R0 * v[0]]];
  return SYM.map((_, k) => {
    const m = pieceMatrix(v, k, c);
    return [m[4], m[5], cellCentre(c.ring, c.slot).half * Math.hypot(v[0], v[1])];
  });
}
