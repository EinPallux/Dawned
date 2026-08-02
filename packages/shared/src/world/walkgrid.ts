/**
 * Walkability grid — `map/<version>/walkgrid.bin` (docs/tech/ASSET_PIPELINE.md §6).
 *
 * One class per 1 m cell over the whole world, 2 bits each (2048² cells = 1 MiB).
 * Baked by worldgen (later the admin publish pipeline) from slope and water depth;
 * the server enforces it authoritatively and the shared movement step consults it
 * on both sides so prediction never disagrees with the wall.
 */

import { WORLD_ORIGIN_M, WORLD_SIZE_M } from './map.js';

export const WALKGRID_MAGIC = 0x44574731; // 'DWG1'

export const WalkClass = {
  /** Open ground. */
  Walkable: 0,
  /** Too steep — blocked. */
  Steep: 1,
  /** Water — enterable; the movement step decides wade vs swim by depth (P3). */
  Water: 2,
  /** Off-world / unbaked void — blocked. */
  Blocked: 3,
} as const;
export type WalkClass = (typeof WalkClass)[keyof typeof WalkClass];

const CELLS = WORLD_SIZE_M; // 1 m cells across the whole world
const HEADER_BYTES = 4 + 2 + 2; // magic, size, reserved
export const WALKGRID_ENCODED_BYTES = HEADER_BYTES + (CELLS * CELLS) / 4;

export class Walkgrid {
  /** 2-bit packed classes, cell (ix, iz) at bit offset (iz * CELLS + ix) * 2. */
  constructor(private readonly packed: Uint8Array) {
    if (packed.length !== (CELLS * CELLS) / 4) {
      throw new Error(`walkgrid must pack ${CELLS}×${CELLS} cells`);
    }
  }

  static empty(fill: WalkClass = WalkClass.Walkable): Walkgrid {
    const packed = new Uint8Array((CELLS * CELLS) / 4);
    packed.fill((fill << 6) | (fill << 4) | (fill << 2) | fill);
    return new Walkgrid(packed);
  }

  classAtCell(ix: number, iz: number): WalkClass {
    if (ix < 0 || iz < 0 || ix >= CELLS || iz >= CELLS) return WalkClass.Blocked;
    const cell = iz * CELLS + ix;
    const byte = this.packed[cell >> 2]!;
    return ((byte >> ((cell & 3) * 2)) & 3) as WalkClass;
  }

  setClassAtCell(ix: number, iz: number, walkClass: WalkClass): void {
    if (ix < 0 || iz < 0 || ix >= CELLS || iz >= CELLS) return;
    const cell = iz * CELLS + ix;
    const shift = (cell & 3) * 2;
    const index = cell >> 2;
    this.packed[index] = (this.packed[index]! & ~(3 << shift)) | (walkClass << shift);
  }

  /** Class at a world position (cells outside the world are Blocked). */
  classAt(x: number, z: number): WalkClass {
    return this.classAtCell(Math.floor(x - WORLD_ORIGIN_M), Math.floor(z - WORLD_ORIGIN_M));
  }

  /** Movement rule: open ground and water (wade or swim) are enterable. */
  walkableAt(x: number, z: number): boolean {
    const walkClass = this.classAt(x, z);
    return walkClass === WalkClass.Walkable || walkClass === WalkClass.Water;
  }

  encode(): Uint8Array {
    const out = new Uint8Array(WALKGRID_ENCODED_BYTES);
    const view = new DataView(out.buffer);
    view.setUint32(0, WALKGRID_MAGIC, true);
    view.setUint16(4, CELLS, true);
    out.set(this.packed, HEADER_BYTES);
    return out;
  }

  static decode(bytes: Uint8Array): Walkgrid {
    if (bytes.byteLength !== WALKGRID_ENCODED_BYTES) {
      throw new Error(`walkgrid must be ${WALKGRID_ENCODED_BYTES} bytes, got ${bytes.byteLength}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== WALKGRID_MAGIC) throw new Error('not a walkgrid (bad magic)');
    if (view.getUint16(4, true) !== CELLS) throw new Error('walkgrid size mismatch');
    return new Walkgrid(bytes.slice(HEADER_BYTES));
  }
}
