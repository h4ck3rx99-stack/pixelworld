import { crc32, deflateSync } from 'node:zlib';
import { EMPTY, PALETTE, PAPER, SIZE } from '../shared/pixels.ts';

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const BG = hex('#0E1020');
const COLOUR = [...PALETTE.map(hex), hex(PAPER)];

/** Minimal PNG encoder: 8-bit RGB, no filtering. Enough for flat pixel art. */
export function encodePng(w: number, h: number, rgb: Uint8Array) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, deflate, no filter, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Link preview: the live canvas on the app's dark background, 1200 x 630. */
export function ogImage(board: Uint8Array) {
  const W = 1200, H = 630, side = 570, x0 = (W - side) / 2, y0 = (H - side) / 2;
  const rgb = new Uint8Array(W * H * 3);
  const colourOf = (v: number) => COLOUR[v === EMPTY ? PALETTE.length : v];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inside = x >= x0 && x < x0 + side && y >= y0 && y < y0 + side;
      const bx = Math.floor(((x - x0) * SIZE) / side), by = Math.floor(((y - y0) * SIZE) / side);
      rgb.set(inside ? colourOf(board[by * SIZE + bx]) : BG, (y * W + x) * 3);
    }
  return encodePng(W, H, rgb);
}

/** App icon: four rounded squares in the logo colours. */
export function iconImage(n: number) {
  const rgb = new Uint8Array(n * n * 3);
  const tiles = [[112, 112, '#E8322E'], [268, 112, '#FFD93B'], [112, 268, '#3B82F6'], [268, 268, '#8BE04E']] as const;
  const k = n / 512, size = 132 * k, r = 22 * k;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let c = BG;
      for (const [tx, ty, col] of tiles) {
        const dx = Math.max(tx * k + r - x, 0, x - (tx * k + size - r)), dy = Math.max(ty * k + r - y, 0, y - (ty * k + size - r));
        if (x >= tx * k && x < tx * k + size && y >= ty * k && y < ty * k + size && dx * dx + dy * dy <= r * r) c = hex(col);
      }
      rgb.set(c, (y * n + x) * 3);
    }
  return encodePng(n, n, rgb);
}
