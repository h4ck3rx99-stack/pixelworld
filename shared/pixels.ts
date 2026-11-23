// Board size, palette and validation shared by server and client.

export const W = 2400; // canvas width in pixels
export const H = 1350; // canvas height: 16:9 landscape, like a laptop or TV screen
export const BANK_SIZE = 64; // pixels a new device starts with, the most it can hold, and the most in one batch
export const REGEN_MS = 30_000; // one pixel comes back every 30 seconds
export const EMPTY = 255; // colour index of an untouched pixel (drawn as the paper colour)
export const PAPER = '#F4F1EA';

export const PALETTE = [
  '#FFFFFF', '#C7C7CF', '#7A7A86', '#222034',
  '#FF99C8', '#E8322E', '#FF8A1F', '#9C5B2E',
  '#FFD93B', '#8BE04E', '#1FA34A', '#2EC4D6',
  '#3B82F6', '#2B2FA8', '#8E44E8', '#E040A0',
];
export const PALETTE_NAMES = [
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
