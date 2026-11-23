import { describe, expect, it } from 'vitest';
import { cellAt, cellCentre, CELL_COUNT, daysBetween, istDay, nextReset, R0, RINGS, SLOTS, SYM, validPlacement } from './grid.ts';

const apply = ([a, b, c, d]: number[], x: number, y: number) => [a * x + c * y, b * x + d * y] as const;

describe('polar -> cell mapping', () => {
  it('has ~14 rings with slots growing outward', () => {
    expect(SLOTS.length).toBe(RINGS);
    for (let i = 2; i < RINGS; i++) expect(SLOTS[i]).toBeGreaterThanOrEqual(SLOTS[i - 1]);
    expect(CELL_COUNT).toBeGreaterThan(60);
  });

  it('maps every cell centre back to itself', () => {
    for (let ring = 0; ring < RINGS; ring++)
      for (let slot = 0; slot < SLOTS[ring]; slot++) {
        const { r, a } = cellCentre(ring, slot);
        expect(cellAt(r * Math.cos(a), r * Math.sin(a))).toEqual({ ring, slot });
      }
  });

  it('centre and outside', () => {
    expect(cellAt(0, 0)).toEqual({ ring: 0, slot: 0 });
    expect(cellAt(R0 * 0.9, 0)).toEqual({ ring: 0, slot: 0 });
    expect(cellAt(1.01, 0)).toBeNull();
    expect(cellAt(0, -0.999)?.ring).toBe(RINGS - 1);
  });

  it('validates placements', () => {
    expect(validPlacement(3, 0, 0, 0)).toBe(true);
    expect(validPlacement(3, SLOTS[3], 0, 0)).toBe(false);
    expect(validPlacement(0, 1, 0, 0)).toBe(false);
    expect(validPlacement(14, 0, 0, 0)).toBe(false);
    expect(validPlacement(1, 0, 8, 0)).toBe(false);
    expect(validPlacement(1, 0, 0, -1)).toBe(false);
    expect(validPlacement('1', 0, 0, 0)).toBe(false);
    expect(validPlacement(1.5, 0, 0, 0)).toBe(false);
  });
});

describe('symmetry transforms', () => {
  it('are 8 distinct isometries', () => {
    expect(SYM.length).toBe(8);
    expect(new Set(SYM.map((m) => m.join())).size).toBe(8);
    for (const [a, b, c, d] of SYM) expect(Math.abs(a * d - b * c)).toBe(1);
  });

  it('every image of a point lands in the same canonical cell, at 8 distinct places', () => {
    for (let i = 0; i < 500; i++) {
      const r = R0 + Math.random() * (1 - R0) * 0.999;
      const t = Math.random() * Math.PI * 2;
      const [x, y] = [r * Math.cos(t), r * Math.sin(t)];
      const want = cellAt(x, y);
      const images = SYM.map((m) => apply(m, x, y));
      for (const [ix, iy] of images) expect(cellAt(ix, iy)).toEqual(want);
      expect(new Set(images.map(([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`)).size).toBe(8);
    }
  });
});

describe('IST daily reset', () => {
  it('rolls over at 00:00 IST (18:30 UTC)', () => {
    expect(istDay(Date.UTC(2026, 10, 23, 18, 29, 59))).toBe('2026-11-23');
    expect(istDay(Date.UTC(2026, 10, 23, 18, 30, 0))).toBe('2026-11-24');
    expect(istDay(Date.UTC(2026, 11, 31, 18, 30))).toBe('2027-01-01');
  });

  it('nextReset is the next IST midnight', () => {
    expect(nextReset(Date.UTC(2026, 10, 23, 10, 0))).toBe(Date.UTC(2026, 10, 23, 18, 30));
    expect(nextReset(Date.UTC(2026, 10, 23, 18, 30))).toBe(Date.UTC(2026, 10, 24, 18, 30));
  });

  it('daysBetween', () => {
    expect(daysBetween('2026-11-23', '2026-11-23')).toBe(0);
    expect(daysBetween('2026-11-23', '2026-12-01')).toBe(8);
  });
});
