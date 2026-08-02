/**
 * The P0 development terrain.
 *
 * Lives in shared because the movement step samples it: if the client and server
 * disagreed about the ground by even a little, prediction would fight the server on
 * every slope. P2 replaces this with streamed heightmap chunks — which will also be
 * sampled through a shared implementation, for the same reason.
 *
 * Shape: a hill in the middle to exercise slopes and fall damage, gentle ripples for
 * uneven ground, and a flat outer plain.
 */

import type { TerrainSampler } from '../formulas/movement.js';

export const devTerrain: TerrainSampler = {
  heightAt(x: number, z: number): number {
    const hill = 6 * Math.exp(-(x * x + z * z) / 900);
    const ripple = Math.sin(x * 0.08) * Math.cos(z * 0.08) * 0.6;
    return hill + ripple;
  },
};

/** Extent of the P0 dev island in metres (used for the client's terrain mesh). */
export const DEV_TERRAIN_EXTENT = 120;
