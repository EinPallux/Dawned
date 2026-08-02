/**
 * Terrain chunk binary format — `map/<version>/chunk_<cx>_<cy>.bin`
 * (docs/tech/ASSET_PIPELINE.md §6; mirrored by `content_map_chunks` in
 * docs/tech/DATABASE.md).
 *
 * One chunk ≈ 25 kB: 65×65 f32 heights (1 m grid) + two RGBA 32×32 splat-weight
 * maps (8 layers) + an optional water level. Explicit little-endian via DataView
 * on both ends — the bytes are a committed, cross-platform artifact.
 */

import { CHUNK_VERTS } from './map.js';

export const CHUNK_MAGIC = 0x44434831; // 'DCH1'
export const SPLAT_MAP_SIZE = 32;
export const SPLAT_LAYER_COUNT = 8;

const HEIGHT_COUNT = CHUNK_VERTS * CHUNK_VERTS;
const SPLAT_BYTES = 2 * SPLAT_MAP_SIZE * SPLAT_MAP_SIZE * 4;
const HEADER_BYTES = 4 + 2 + 2 + 1 + 4; // magic, cx, cy, hasWater, waterLevel
export const CHUNK_ENCODED_BYTES = HEADER_BYTES + HEIGHT_COUNT * 4 + SPLAT_BYTES;

export interface MapChunk {
  cx: number;
  cy: number;
  /** Water surface height for this chunk, or null when it has no water. */
  waterLevel: number | null;
  /** 65×65 heights, row-major (z-major: index = iz * CHUNK_VERTS + ix). */
  heights: Float32Array;
  /** Two RGBA 32×32 weight maps concatenated: layers 0–3 then 4–7. */
  splat: Uint8Array;
}

export const encodeChunk = (chunk: MapChunk): Uint8Array => {
  if (chunk.heights.length !== HEIGHT_COUNT) {
    throw new Error(`chunk heights must have ${HEIGHT_COUNT} samples`);
  }
  if (chunk.splat.length !== SPLAT_BYTES) {
    throw new Error(`chunk splat must have ${SPLAT_BYTES} bytes`);
  }
  const out = new Uint8Array(CHUNK_ENCODED_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, CHUNK_MAGIC, true);
  view.setUint16(4, chunk.cx, true);
  view.setUint16(6, chunk.cy, true);
  view.setUint8(8, chunk.waterLevel === null ? 0 : 1);
  view.setFloat32(9, chunk.waterLevel ?? 0, true);
  let offset = HEADER_BYTES;
  for (let i = 0; i < HEIGHT_COUNT; i++, offset += 4) {
    view.setFloat32(offset, chunk.heights[i]!, true);
  }
  out.set(chunk.splat, offset);
  return out;
};

export const decodeChunk = (bytes: Uint8Array): MapChunk => {
  if (bytes.byteLength !== CHUNK_ENCODED_BYTES) {
    throw new Error(`chunk must be ${CHUNK_ENCODED_BYTES} bytes, got ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== CHUNK_MAGIC) {
    throw new Error('not a terrain chunk (bad magic)');
  }
  const cx = view.getUint16(4, true);
  const cy = view.getUint16(6, true);
  const hasWater = view.getUint8(8) === 1;
  const waterLevel = view.getFloat32(9, true);
  const heights = new Float32Array(HEIGHT_COUNT);
  let offset = HEADER_BYTES;
  for (let i = 0; i < HEIGHT_COUNT; i++, offset += 4) {
    heights[i] = view.getFloat32(offset, true);
  }
  const splat = bytes.slice(offset, offset + SPLAT_BYTES);
  return { cx, cy, waterLevel: hasWater ? waterLevel : null, heights, splat };
};
