import { describe, expect, it } from 'vitest';
import { BASE, colourName, EMPTY, H, nearest, PALETTE, utcDay, validPixel, W } from './pixels.ts';

describe('pixels', () => {
  it('validates coordinates and colours', () => {
    expect(validPixel(0, 0, 0)).toBe(true);
    expect(validPixel(W - 1, H - 1, PALETTE.length - 1)).toBe(true);
    expect(validPixel(W, 0, 0)).toBe(false);
    expect(validPixel(0, H, 0)).toBe(false);
    expect(validPixel(0, -1, 0)).toBe(false);
    expect(validPixel(0, 0, PALETTE.length)).toBe(false);
    expect(validPixel(1.5, 0, 0)).toBe(false);
    expect(validPixel('1', 0, 0)).toBe(false);
  });

  it('is a 16:9 landscape canvas', () => {
    expect(W / H).toBeCloseTo(16 / 9);
  });

  it('fits 254 distinct colours in a byte, keeping the original 16 first', () => {
    expect(PALETTE.length).toBe(254);
    expect(PALETTE.length).toBeLessThan(EMPTY); // 255 marks an empty pixel
    expect(PALETTE.slice(0, 16)).toEqual(BASE);
    expect(PALETTE.every((h) => /^#[0-9A-F]{6}$/.test(h))).toBe(true);
    expect(colourName(5)).toBe('Red');
    expect(colourName(100)).toBe(PALETTE[100]);
  });

  it('snaps any colour to the nearest palette entry', () => {
    expect(PALETTE[nearest(255, 255, 255)]).toBe('#FFFFFF');
    expect(PALETTE[nearest(0, 0, 0)]).toBe('#000000');
    expect(nearest(232, 50, 46)).toBe(5); // exact base red
    expect(PALETTE[nearest(250, 5, 3)]).toBe('#FF0000');
  });

  it('daily caps roll over at 00:00 UTC', () => {
    expect(utcDay(Date.UTC(2026, 10, 23, 23, 59, 59))).toBe('2026-11-23');
    expect(utcDay(Date.UTC(2026, 10, 24, 0, 0, 0))).toBe('2026-11-24');
  });
});
