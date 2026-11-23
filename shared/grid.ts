// Symmetry grid, palette and IST day maths shared by server and client.
// Model space: board centre at (0,0), outer edge at radius 1, canvas y-down.

export const RINGS = 14; // ring 0 is the centre lotus, rings 1..13 hold pieces
export const R0 = 0.12; // radius of the centre lotus
export const RING_W = (1 - R0) / (RINGS - 1);
export const WEDGE = Math.PI / 4; // 8 wedges: 4 rotations x mirror

export const PIECES = ['dot', 'petal', 'leaf', 'teardrop', 'diamond', 'crescent', 'swirl', 'diya'] as const;
export const PIECE_NAMES = ['Bindu', 'Petal', 'Leaf', 'Teardrop', 'Diamond', 'Crescent', 'Swirl', 'Diya'];
export const COLOURS = ['#F5A623', '#E23D28', '#F2C230', '#1B6CA8', '#3BA55C', '#F7F3E9', '#D6336C', '#3A2E7A'];
export const COLOUR_NAMES = ['Marigold', 'Vermilion', 'Turmeric', 'Peacock blue', 'Parrot green', 'Chalk white', 'Rani pink', 'Deep indigo'];

// Slots grow with the ring so every cell is roughly RING_W wide.
export const SLOTS: number[] = Array.from({ length: RINGS }, (_, i) =>
  i === 0 ? 1 : Math.max(1, Math.round(((R0 + (i - 0.5) * RING_W) * WEDGE) / (RING_W * 0.85))),
);
export const CELL_COUNT = SLOTS.reduce((a, b) => a + b, 0);

export const cellKey = (ring: number, slot: number) => ring * 64 + slot;

export function validPlacement(ring: unknown, slot: unknown, piece: unknown, colour: unknown): boolean {
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  return int(ring, 0, RINGS - 1) && int(slot, 0, SLOTS[ring as number] - 1) && int(piece, 0, PIECES.length - 1) && int(colour, 0, COLOURS.length - 1);
}

/** Model point -> canonical cell, or null outside the board. */
export function cellAt(x: number, y: number): { ring: number; slot: number } | null {
  const r = Math.hypot(x, y);
  if (r > 1) return null;
  if (r < R0) return { ring: 0, slot: 0 };
  let a = Math.atan2(y, x);
  if (a < 0) a += 2 * Math.PI;
  a %= Math.PI / 2;
  if (a > WEDGE) a = Math.PI / 2 - a; // fold the mirror half onto the canonical wedge
  const ring = Math.min(RINGS - 1, Math.floor((r - R0) / RING_W) + 1);
  const n = SLOTS[ring];
  return { ring, slot: Math.min(n - 1, Math.floor((a / WEDGE) * n)) };
}

/** Centre of a canonical cell: radius, angle and the piece half-size, all in model units. */
export function cellCentre(ring: number, slot: number) {
  if (ring === 0) return { r: 0, a: 0, half: R0 };
  const r = R0 + (ring - 0.5) * RING_W;
  const n = SLOTS[ring];
  const a = ((slot + 0.5) / n) * WEDGE;
  const half = 0.5 * Math.min(RING_W, (r * WEDGE) / n) * 1.18; // slight overlap so neighbours read as one pattern
  return { r, a, half };
}

/** The 8 symmetry maps as canvas matrices [a, b, c, d]: x' = a x + c y, y' = b x + d y. */
export const SYM: [number, number, number, number][] = [];
for (let k = 0; k < 4; k++) {
  const c = Math.round(Math.cos((k * Math.PI) / 2));
  const s = Math.round(Math.sin((k * Math.PI) / 2));
  SYM.push([c, s, -s, c]); // rotation
  SYM.push([-s, c, c, s]); // rotation after mirroring across the 45 degree line
}

const IST_MS = 5.5 * 3600_000;
/** Calendar day in India (YYYY-MM-DD) for a timestamp. */
export const istDay = (ts: number) => new Date(ts + IST_MS).toISOString().slice(0, 10);
/** Timestamp of the next 00:00 IST after ts. */
export function nextReset(ts: number): number {
  const d = new Date(ts + IST_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - IST_MS;
}
/** Whole days from a to b (YYYY-MM-DD). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

/** Wire format of one event: [id, ring, slot, piece, colour, who, ts]. `who` is a short hash of the device. */
export type WireEvent = [number, number, number, number, number, string, number];
