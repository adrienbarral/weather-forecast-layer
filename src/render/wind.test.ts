import { expect, it } from 'vitest';
import { barbParts, jet, trailOpacity } from './wind';
import { KNOTS_PER_MS } from '../core/sampling';

it('uses stable classical jet reference colors and saturation', () => {
  expect(jet(0)).toEqual([0, 0, 128]);
  expect(jet(30)).toEqual([128, 255, 128]);
  expect(jet(60)).toEqual([128, 0, 0]);
  expect(jet(100)).toEqual(jet(60));
  expect(() => jet(10, 0)).toThrow();
});
it('uses conventional 5, 10 and 50 knot barbs', () => {
  expect(barbParts(0)).toEqual({ flags: 0, full: 0, half: 0 });
  expect(barbParts(5 / KNOTS_PER_MS)).toEqual({ flags: 0, full: 0, half: 1 });
  expect(barbParts(65 / KNOTS_PER_MS)).toEqual({ flags: 1, full: 1, half: 1 });
});
it('fades from a bright trail head to a dim tail', () => {
  expect(trailOpacity(0)).toBeGreaterThan(trailOpacity(1));
});