/**
 * Terrain splat layers — the 8 paint channels of the two RGBA splat maps
 * (docs/tech/ASSET_PIPELINE.md §6). The vibrant low-poly look shades terrain
 * with flat per-layer colors (no ground textures): the chunk mesh mixes these
 * by splat weight into vertex colors.
 *
 * Order is the wire format: splat map 0 carries layers 0–3 in RGBA, map 1
 * carries 4–7. Worldgen paints by height/slope now; the admin map editor
 * paints by hand from A2.
 */

export interface SplatLayer {
  id: string;
  name: string;
  color: string;
}

export const SPLAT_LAYERS: readonly SplatLayer[] = [
  { id: 'grass', name: 'Meadow grass', color: '#5ea84e' },
  { id: 'sand', name: 'Beach sand', color: '#e3d29b' },
  { id: 'rock', name: 'Bare rock', color: '#8a8478' },
  { id: 'dirt', name: 'Packed dirt', color: '#8a6a48' },
  { id: 'forest', name: 'Forest floor', color: '#47803c' },
  { id: 'flowers', name: 'Flower field', color: '#7dbb58' },
  { id: 'ash', name: 'Ash & shadow', color: '#585450' },
  { id: 'shallows', name: 'Shore shallows', color: '#b8c7a2' },
] as const;
