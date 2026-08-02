/**
 * Zones — data-driven gameplay regions (docs/design/WORLD.md §2, DATABASE.md
 * `content_zones`). A zone is a polygon over the world plane plus an ambience
 * profile the client blends toward when the player is inside (fog, sky, light).
 *
 * P2 ships zones as a baked `zones.json` from worldgen; the admin map editor
 * takes over authoring at A2/A3 — the schema here is the contract for both.
 */

import { z } from 'zod';

const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i, 'expected #rrggbb');

/** Client-side rendering targets while inside the zone. */
export const zoneAmbienceSchema = z.object({
  fogColor: hexColor,
  /** Linear fog range in metres. */
  fogNear: z.number().min(0),
  fogFar: z.number().positive(),
  skyTop: hexColor,
  skyHorizon: hexColor,
  sunColor: hexColor,
  sunIntensity: z.number().min(0).max(8),
  hemiSky: hexColor,
  hemiGround: hexColor,
  hemiIntensity: z.number().min(0).max(8),
});
export type ZoneAmbience = z.infer<typeof zoneAmbienceSchema>;

export const zoneSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, 'zone ids are snake_case slugs'),
  name: z.string().min(1).max(64),
  levelMin: z.number().int().min(1),
  levelMax: z.number().int().min(1),
  /** World-space (x, z) vertices, counter-clockwise, not self-intersecting. */
  polygon: z.array(z.tuple([z.number(), z.number()])).min(3),
  ambience: zoneAmbienceSchema,
  /** Safe zones: no enemy spawns, no damage (docs/design/WORLD.md §3). */
  safe: z.boolean(),
  settlement: z.string().nullable(),
});
export type Zone = z.infer<typeof zoneSchema>;

export const zonesFileSchema = z.object({
  /** Ambience outside every polygon (open ocean / travel water). */
  defaultAmbience: zoneAmbienceSchema,
  zones: z.array(zoneSchema),
});
export type ZonesFile = z.infer<typeof zonesFileSchema>;

/** Ray-cast point-in-polygon on the (x, z) plane. */
export const pointInPolygon = (
  x: number,
  z: number,
  polygon: readonly (readonly [number, number])[],
): boolean => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!;
    const [xj, zj] = polygon[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

/** First zone containing the point (authoring order is priority). */
export const zoneAt = (x: number, z: number, zones: readonly Zone[]): Zone | null => {
  for (const zone of zones) {
    if (pointInPolygon(x, z, zone.polygon)) return zone;
  }
  return null;
};
