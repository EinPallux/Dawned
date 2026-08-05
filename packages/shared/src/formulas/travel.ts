/**
 * Fast travel between attuned shrines (WORLD.md §4.2, ITEMS_LOOT.md §5).
 *
 * The design fixes the price as `2 × distance-in-chunks`, banded to roughly
 * 5–40 g so the shortest hop is never free and the longest is never a wall.
 * That number is a gold SINK, which makes it a balance lever the owner will
 * want to see while they are placing shrines — a shrine ring that costs 6 g to
 * cross is decoration, one that costs 40 g is a decision.
 *
 * It lives in shared for the usual reason: the map editor previews the cost
 * matrix as shrines are placed (MAP_EDITOR.md §2.4) and the game will charge it
 * when the shrine interactable lands. Two copies of a price is exactly the kind
 * of drift `@dawned/shared` exists to prevent — the panel must never quote a
 * number the game will not take.
 */

import { CHUNK_SIZE_M } from '../world/map.js';

/** A hop to the next shrine over still costs something. */
export const FAST_TRAVEL_MIN_GOLD = 5;
/** ITEMS_LOOT.md §5's upper band — crossing the world is a cost, not a toll gate. */
export const FAST_TRAVEL_MAX_GOLD = 40;

/**
 * Gold to travel between two shrines, in whole coins (money is integer —
 * CLAUDE.md's "no floats for currency").
 */
export const fastTravelCost = (ax: number, az: number, bx: number, bz: number): number => {
  const chunks = Math.hypot(bx - ax, bz - az) / CHUNK_SIZE_M;
  const raw = Math.round(2 * chunks);
  return Math.min(FAST_TRAVEL_MAX_GOLD, Math.max(FAST_TRAVEL_MIN_GOLD, raw));
};

/** One shrine on the travel graph. */
export interface TravelNode {
  id: string;
  name: string;
  x: number;
  z: number;
}

/**
 * Every ordered pair's cost, cheapest first.
 *
 * Symmetric by construction (the cost only depends on the distance), so each
 * unordered pair appears once — a matrix that lists both directions doubles the
 * rows and tells the owner nothing new.
 */
export interface TravelHop {
  from: TravelNode;
  to: TravelNode;
  metres: number;
  gold: number;
}

export const travelHops = (nodes: readonly TravelNode[]): TravelHop[] => {
  const hops: TravelHop[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const from = nodes[i]!;
      const to = nodes[j]!;
      hops.push({
        from,
        to,
        metres: Math.round(Math.hypot(to.x - from.x, to.z - from.z)),
        gold: fastTravelCost(from.x, from.z, to.x, to.z),
      });
    }
  }
  return hops.sort((a, b) => a.gold - b.gold || a.metres - b.metres);
};
