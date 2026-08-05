import { describe, expect, it } from 'vitest';
import {
  FAST_TRAVEL_MAX_GOLD,
  FAST_TRAVEL_MIN_GOLD,
  fastTravelCost,
  travelHops,
  type TravelNode,
} from './travel.js';
import { CHUNK_SIZE_M } from '../world/map.js';

describe('fast travel cost', () => {
  it('is 2 gold per chunk of distance (ITEMS_LOOT.md §5)', () => {
    // 10 chunks apart → 20 g, inside the band so no clamp is involved.
    expect(fastTravelCost(0, 0, CHUNK_SIZE_M * 10, 0)).toBe(20);
  });

  it('never charges less than the floor, even next door', () => {
    expect(fastTravelCost(0, 0, 4, 4)).toBe(FAST_TRAVEL_MIN_GOLD);
    expect(fastTravelCost(0, 0, 0, 0)).toBe(FAST_TRAVEL_MIN_GOLD);
  });

  it('caps at the design band rather than scaling forever', () => {
    expect(fastTravelCost(-1024, -1024, 1024, 1024)).toBe(FAST_TRAVEL_MAX_GOLD);
  });

  it('is symmetric — travelling back costs what coming cost', () => {
    expect(fastTravelCost(120, -40, 700, 260)).toBe(fastTravelCost(700, 260, 120, -40));
  });

  it('is whole gold, never a fraction of a coin', () => {
    for (let d = 0; d < 2000; d += 37) {
      expect(Number.isInteger(fastTravelCost(0, 0, d, d * 0.5))).toBe(true);
    }
  });
});

describe('travel hops', () => {
  const node = (id: string, x: number, z: number): TravelNode => ({ id, name: id, x, z });

  it('lists each unordered pair once, cheapest first', () => {
    const hops = travelHops([
      node('a', 0, 0),
      node('b', CHUNK_SIZE_M * 12, 0),
      node('c', CHUNK_SIZE_M * 3, 0),
    ]);
    expect(hops).toHaveLength(3); // 3 nodes → 3 pairs, not 6
    // Each pair keeps the order it was given in; only the LIST is sorted.
    expect(hops.map((hop) => `${hop.from.id}${hop.to.id}`)).toEqual(['ac', 'bc', 'ab']);
    expect(hops[0]!.gold).toBe(6);
    expect(hops[0]!.metres).toBe(CHUNK_SIZE_M * 3);
  });

  it('has nothing to say about a lone shrine', () => {
    expect(travelHops([node('a', 0, 0)])).toEqual([]);
    expect(travelHops([])).toEqual([]);
  });
});
