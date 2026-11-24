import { crc32, deflateSync } from 'node:zlib';
import { EMPTY, H as BH, PALETTE, PAPER, rgbOf as hex, W as BW } from '../shared/pixels.ts';

const BG = hex('#12121F');
const SHADOW = [0, 0, 0];
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
  const W = 1200, H = 630, k = Math.min(1120 / BW, 570 / BH); // fit the canvas inside the preview with a margin
  const cw = Math.round(BW * k), ch = Math.round(BH * k), x0 = (W - cw) / 2, y0 = (H - ch) / 2;
  const rgb = new Uint8Array(W * H * 3);
  const colourOf = (v: number) => COLOUR[v === EMPTY ? PALETTE.length : v];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inside = x >= x0 && x < x0 + cw && y >= y0 && y < y0 + ch;
      const shadow = x >= x0 + 8 && x < x0 + cw + 8 && y >= y0 + 8 && y < y0 + ch + 8; // hard offset shadow, like the app
      const bx = Math.min(BW - 1, Math.floor((x - x0) / k)), by = Math.min(BH - 1, Math.floor((y - y0) / k));
      rgb.set(inside ? colourOf(board[by * BW + bx]) : shadow ? SHADOW : BG, (y * W + x) * 3);
    }
  return encodePng(W, H, rgb);
}

/** App icon: four square pixels in the logo colours (same as public/icon.svg). */
export function iconImage(n: number) {
  const rgb = new Uint8Array(n * n * 3);
  const tiles = [[112, 112, '#E8322E'], [268, 112, '#FFD23F'], [112, 268, '#3B82F6'], [268, 268, '#7CF05A']] as const;
  const k = n / 512, size = 132 * k;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let c = BG;
      for (const [tx, ty, col] of tiles) if (x >= tx * k && x < tx * k + size && y >= ty * k && y < ty * k + size) c = hex(col);
      rgb.set(c, (y * n + x) * 3);
    }
  return encodePng(n, n, rgb);
}
