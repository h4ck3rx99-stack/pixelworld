import { describe, expect, it } from 'vitest';
import { PALETTE, PALETTE_NAMES, SIZE, utcDay, validPixel } from './pixels.ts';

describe('pixels', () => {
  it('validates coordinates and colours', () => {
    expect(validPixel(0, 0, 0)).toBe(true);
    expect(validPixel(SIZE - 1, SIZE - 1, PALETTE.length - 1)).toBe(true);
    expect(validPixel(SIZE, 0, 0)).toBe(false);
    expect(validPixel(0, -1, 0)).toBe(false);
    expect(validPixel(0, 0, PALETTE.length)).toBe(false);
    expect(validPixel(1.5, 0, 0)).toBe(false);
    expect(validPixel('1', 0, 0)).toBe(false);
  });

  it('has a name for every colour', () => {
    expect(PALETTE_NAMES.length).toBe(PALETTE.length);
    expect(PALETTE.length).toBeLessThan(255); // 255 marks an empty pixel
  });

  it('daily caps roll over at 00:00 UTC', () => {
    expect(utcDay(Date.UTC(2026, 10, 23, 23, 59, 59))).toBe('2026-11-23');
    expect(utcDay(Date.UTC(2026, 10, 24, 0, 0, 0))).toBe('2026-11-24');
  });
});
