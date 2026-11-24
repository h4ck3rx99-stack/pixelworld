// Board size, palette and validation shared by server and client.

export const W = 2400; // canvas width in pixels
export const H = 1350; // canvas height: 16:9 landscape, like a laptop or TV screen
export const BANK_SIZE = 64; // the most a bank can hold, and the most in one batch
export const START_PIXELS = 16; // a brand-new device starts here, so wiping site data for a fresh bank isn't worth much
export const REGEN_MS = 30_000; // one pixel comes back every 30 seconds
export const EMPTY = 255; // colour index of an untouched pixel (drawn as the paper colour)
export const PAPER = '#F4F1EA';

/** The original 16 colours, shown as quick swatches. Indices 0-15 never change. */
export const BASE = [
  '#FFFFFF', '#C7C7CF', '#7A7A86', '#222034',
  '#FF99C8', '#E8322E', '#FF8A1F', '#9C5B2E',
  '#FFD93B', '#8BE04E', '#1FA34A', '#2EC4D6',
  '#3B82F6', '#2B2FA8', '#8E44E8', '#E040A0',
];
const hex2 = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const CUBE = [0, 51, 102, 153, 204, 255];
/** 254 colours, one byte each (255 = blank): the base 16, a 6x6x6 colour cube, then 22 extra greys. */
export const PALETTE = [
  ...BASE,
  ...CUBE.flatMap((r) => CUBE.flatMap((g) => CUBE.map((b) => rgbHex(r, g, b)))),
  ...Array.from({ length: 22 }, (_, i) => { const v = Math.round(((i + 1) * 255) / 23); return rgbHex(v, v, v); }),
];
export const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const RGB = PALETTE.map(rgbOf);
/** Index of the palette colour closest to r, g, b (weighted for how eyes see it). */
export function nearest(r: number, g: number, b: number) {
  let best = 0, bd = Infinity;
  RGB.forEach(([R, G, B], i) => {
    const d = 2 * (R - r) ** 2 + 4 * (G - g) ** 2 + 3 * (B - b) ** 2;
    if (d < bd) (bd = d), (best = i);
  });
  return best;
}
export const colourName = (c: number) => (c < BASE_NAMES.length ? BASE_NAMES[c] : PALETTE[c]);
const BASE_NAMES = [
  'White', 'Light grey', 'Grey', 'Ink',
  'Pink', 'Red', 'Orange', 'Brown',
  'Yellow', 'Lime', 'Green', 'Cyan',
  'Blue', 'Navy', 'Purple', 'Magenta',
];

const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
export const validPixel = (x: unknown, y: unknown, colour: unknown) =>
  int(x, 0, W - 1) && int(y, 0, H - 1) && int(colour, 0, PALETTE.length - 1);

/** Calendar day in UTC (YYYY-MM-DD); daily placement caps reset on it. */
export const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** Wire format of one event: [id, x, y, colour, who, ts]. `who` is a short hash of the device. */
export type WireEvent = [number, number, number, number, string, number];
