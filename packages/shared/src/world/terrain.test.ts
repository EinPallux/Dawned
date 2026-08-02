/**
 * P2 terrain core: chunk codec round-trips, bilinear sampling (incl. chunk
 * seams), walkgrid packing, and the walkability rules inside stepMovement.
 */

import { describe, expect, it } from 'vitest';
import {
  CHUNK_ENCODED_BYTES,
  CHUNK_SIZE_M,
  CHUNK_VERTS,
  ChunkTerrain,
  OCEAN_FLOOR_Y,
  SPLAT_MAP_SIZE,
  WALKGRID_ENCODED_BYTES,
  WalkClass,
  Walkgrid,
  WORLD_ORIGIN_M,
  chunkIndexOf,
  chunkKey,
  decodeChunk,
  encodeChunk,
  type MapChunk,
} from '../index.js';
import { TICK_DT } from '../constants.js';
import { createMovementState, stepMovement, type MovementIntent } from '../formulas/movement.js';
import { pointInPolygon, zoneAt, zonesFileSchema, type Zone } from '../content/zones.js';

const SPLAT_BYTES = 2 * SPLAT_MAP_SIZE * SPLAT_MAP_SIZE * 4;

/** A chunk whose height is a known ramp: h = ax + bz in LOCAL metres. */
const rampChunk = (cx: number, cy: number, a: number, b: number, water: number | null = null) => {
  const heights = new Float32Array(CHUNK_VERTS * CHUNK_VERTS);
  for (let iz = 0; iz < CHUNK_VERTS; iz++) {
    for (let ix = 0; ix < CHUNK_VERTS; ix++) {
      // Global grid coordinates so neighbours line up seamlessly.
      heights[iz * CHUNK_VERTS + ix] = a * (cx * CHUNK_SIZE_M + ix) + b * (cy * CHUNK_SIZE_M + iz);
    }
  }
  const splat = new Uint8Array(SPLAT_BYTES);
  splat.fill(0);
  for (let i = 0; i < SPLAT_MAP_SIZE * SPLAT_MAP_SIZE; i++) splat[i * 4] = 255; // layer 0
  return { cx, cy, waterLevel: water, heights, splat } satisfies MapChunk;
};

describe('chunk codec', () => {
  it('round-trips heights, splat and water level', () => {
    const chunk = rampChunk(3, 7, 0.25, -0.5, 1.75);
    const bytes = encodeChunk(chunk);
    expect(bytes.byteLength).toBe(CHUNK_ENCODED_BYTES);
    const decoded = decodeChunk(bytes);
    expect(decoded.cx).toBe(3);
    expect(decoded.cy).toBe(7);
    expect(decoded.waterLevel).toBeCloseTo(1.75, 5);
    expect(Array.from(decoded.heights)).toEqual(Array.from(chunk.heights));
    expect(Array.from(decoded.splat)).toEqual(Array.from(chunk.splat));
  });

  it('preserves "no water" as null (not zero)', () => {
    const decoded = decodeChunk(encodeChunk(rampChunk(0, 0, 0, 0, null)));
    expect(decoded.waterLevel).toBeNull();
  });

  it('rejects malformed buffers', () => {
    expect(() => decodeChunk(new Uint8Array(10))).toThrow(/bytes/);
    const bytes = encodeChunk(rampChunk(0, 0, 0, 0));
    bytes[0] = 0; // corrupt magic
    expect(() => decodeChunk(bytes)).toThrow(/magic/);
  });
});

describe('ChunkTerrain sampling', () => {
  it('bilinearly interpolates a ramp exactly', () => {
    const terrain = new ChunkTerrain();
    terrain.addChunk(rampChunk(16, 16, 0.5, 0.25)); // chunk containing the origin
    // Chunk (16,16) spans world [0,64)²; sample mid-cell points on the ramp.
    const x = 10.4;
    const z = 3.7;
    const gx = x - WORLD_ORIGIN_M - 16 * CHUNK_SIZE_M + 16 * CHUNK_SIZE_M; // = x - origin
    expect(gx).toBeCloseTo(x + 1024, 6);
    expect(terrain.heightAt(x, z)).toBeCloseTo(0.5 * (x + 1024) + 0.25 * (z + 1024), 4);
  });

  it('is continuous across a chunk seam', () => {
    const terrain = new ChunkTerrain();
    terrain.addChunk(rampChunk(16, 16, 0.3, 0.1));
    terrain.addChunk(rampChunk(17, 16, 0.3, 0.1));
    // The seam sits at world x = 64 (between chunk 16 and 17).
    const before = terrain.heightAt(63.999, 10);
    const at = terrain.heightAt(64, 10);
    const after = terrain.heightAt(64.001, 10);
    expect(Math.abs(at - before)).toBeLessThan(0.01);
    expect(Math.abs(after - at)).toBeLessThan(0.01);
  });

  it('reads ocean floor where no chunk is loaded', () => {
    const terrain = new ChunkTerrain();
    expect(terrain.heightAt(0, 0)).toBe(OCEAN_FLOOR_Y);
    terrain.addChunk(rampChunk(16, 16, 0, 0));
    expect(terrain.heightAt(500, 500)).toBe(OCEAN_FLOOR_Y);
  });

  it('reports slope in degrees', () => {
    const terrain = new ChunkTerrain();
    terrain.addChunk(rampChunk(16, 16, 1, 0)); // 45° along x
    expect(terrain.slopeDegAt(10, 10)).toBeCloseTo(45, 0);
    const flat = new ChunkTerrain();
    flat.addChunk(rampChunk(16, 16, 0, 0));
    expect(flat.slopeDegAt(10, 10)).toBe(0);
  });

  it('maps world coordinates to chunk indices', () => {
    expect(chunkIndexOf(WORLD_ORIGIN_M)).toBe(0);
    expect(chunkIndexOf(0)).toBe(16);
    expect(chunkIndexOf(-0.001)).toBe(15);
    expect(chunkKey(1, 2)).toBe(2 * 32 + 1);
  });
});

describe('walkgrid', () => {
  it('round-trips 2-bit classes', () => {
    const grid = Walkgrid.empty(WalkClass.Blocked);
    grid.setClassAtCell(1024, 1024, WalkClass.Walkable);
    grid.setClassAtCell(1025, 1024, WalkClass.Steep);
    grid.setClassAtCell(1026, 1024, WalkClass.Water);
    const decoded = Walkgrid.decode(grid.encode());
    expect(decoded.classAtCell(1024, 1024)).toBe(WalkClass.Walkable);
    expect(decoded.classAtCell(1025, 1024)).toBe(WalkClass.Steep);
    expect(decoded.classAtCell(1026, 1024)).toBe(WalkClass.Water);
    expect(decoded.classAtCell(0, 0)).toBe(WalkClass.Blocked);
    expect(grid.encode().byteLength).toBe(WALKGRID_ENCODED_BYTES);
  });

  it('answers world-space walkability (water counts as enterable)', () => {
    const grid = Walkgrid.empty(WalkClass.Blocked);
    grid.setClassAtCell(1024, 1024, WalkClass.Water); // world (0..1, 0..1)
    expect(grid.walkableAt(0.5, 0.5)).toBe(true);
    expect(grid.walkableAt(2.5, 0.5)).toBe(false);
    expect(grid.walkableAt(-5000, 0)).toBe(false); // off-world
  });
});

describe('stepMovement walkability', () => {
  const intentRight: MovementIntent = { moveX: 1, moveZ: 0, yaw: 0, buttons: 0 };
  const intentDiag: MovementIntent = { moveX: 1, moveZ: 1, yaw: 0, buttons: 0 };

  /** Flat ground; only cells with x < wallX are walkable. */
  const walledTerrain = (wallX: number) => ({
    heightAt: () => 0,
    walkableAt: (x: number) => x < wallX,
  });

  it('blocks entering an unwalkable cell', () => {
    const state = createMovementState(0, 0, 0);
    const terrain = walledTerrain(0.5);
    for (let i = 0; i < 100; i++) stepMovement(state, intentRight, TICK_DT, terrain);
    expect(state.x).toBeLessThan(0.5);
    expect(state.x).toBeGreaterThan(0); // walked up to the wall
    expect(state.vx).toBe(0);
  });

  it('slides along the open axis on a blocked diagonal', () => {
    const state = createMovementState(0, 0, 0);
    const terrain = walledTerrain(0.5);
    for (let i = 0; i < 60; i++) stepMovement(state, intentDiag, TICK_DT, terrain);
    expect(state.x).toBeLessThan(0.5); // x is walled
    expect(state.z).toBeGreaterThan(3); // z keeps moving
  });

  it('lets a character escape a blocked start cell', () => {
    const state = createMovementState(5, 0, 0); // starts BEHIND the wall
    const terrain = walledTerrain(0.5);
    const left: MovementIntent = { moveX: -1, moveZ: 0, yaw: 0, buttons: 0 };
    for (let i = 0; i < 200; i++) stepMovement(state, left, TICK_DT, terrain);
    expect(state.x).toBeLessThan(0.5); // walked out and back into walkable ground
  });

  it('changes nothing for samplers without walkableAt', () => {
    const state = createMovementState(0, 0, 0);
    for (let i = 0; i < 40; i++) stepMovement(state, intentRight, TICK_DT, { heightAt: () => 0 });
    expect(state.x).toBeGreaterThan(5);
  });
});

describe('zones', () => {
  const square = (minX: number, minZ: number, size: number): [number, number][] => [
    [minX, minZ],
    [minX + size, minZ],
    [minX + size, minZ + size],
    [minX, minZ + size],
  ];

  const ambience = {
    fogColor: '#aabbcc',
    fogNear: 40,
    fogFar: 260,
    skyTop: '#334466',
    skyHorizon: '#ffcc99',
    sunColor: '#ffeedd',
    sunIntensity: 2,
    hemiSky: '#ccddff',
    hemiGround: '#445544',
    hemiIntensity: 1,
  };

  const zone = (id: string, polygon: [number, number][]): Zone => ({
    id,
    name: id,
    levelMin: 1,
    levelMax: 6,
    polygon,
    ambience,
    safe: false,
    settlement: null,
  });

  it('tests point membership', () => {
    const poly = square(0, 0, 100);
    expect(pointInPolygon(50, 50, poly)).toBe(true);
    expect(pointInPolygon(-1, 50, poly)).toBe(false);
    expect(pointInPolygon(150, 50, poly)).toBe(false);
  });

  it('resolves the first matching zone by order', () => {
    const inner = zone('inner', square(25, 25, 50));
    const outer = zone('outer', square(0, 0, 100));
    expect(zoneAt(50, 50, [inner, outer])?.id).toBe('inner');
    expect(zoneAt(10, 10, [inner, outer])?.id).toBe('outer');
    expect(zoneAt(500, 500, [inner, outer])).toBeNull();
  });

  it('validates the zones file shape', () => {
    const parsed = zonesFileSchema.safeParse({
      defaultAmbience: ambience,
      zones: [zone('dawnshore', square(-100, -100, 200))],
    });
    expect(parsed.success).toBe(true);
    const bad = zonesFileSchema.safeParse({
      defaultAmbience: ambience,
      zones: [{ ...zone('x', square(0, 0, 10)), polygon: [[0, 0]] }],
    });
    expect(bad.success).toBe(false);
  });
});

describe('swimming', () => {
  const still: MovementIntent = { moveX: 0, moveZ: 0, yaw: 0, buttons: 0 };
  const fwd: MovementIntent = { moveX: 0, moveZ: 1, yaw: 0, buttons: 0 };

  /** Ground drops from 0 to -6 across z ∈ [10, 16]; water surface at 0 beyond z=10. */
  const shoreTerrain = () => ({
    heightAt: (_x: number, z: number) => (z <= 10 ? 0 : Math.max(-6, -(z - 10))),
    waterLevelAt: (_x: number, z: number) => (z > 10 ? 0 : null),
  });

  it('enters swim in deep water, pinned under the surface, and exits on the shore', () => {
    const state = createMovementState(0, 0, 0);
    const terrain = shoreTerrain();
    for (let i = 0; i < 200; i++) stepMovement(state, fwd, TICK_DT, terrain);
    expect(state.swimming).toBe(true);
    expect(state.z).toBeGreaterThan(12);
    expect(state.y).toBeCloseTo(-0.55, 3); // surface (0) − SWIM_SURFACE_OFFSET
    expect(state.grounded).toBe(false);

    const back: MovementIntent = { moveX: 0, moveZ: -1, yaw: 0, buttons: 0 };
    for (let i = 0; i < 300; i++) stepMovement(state, back, TICK_DT, terrain);
    expect(state.swimming).toBe(false);
    expect(state.grounded).toBe(true);
    expect(state.y).toBeCloseTo(0, 2);
  });

  it('swims slower than it runs', () => {
    const terrain = shoreTerrain();
    const runner = createMovementState(0, 0, 0);
    for (let i = 0; i < 40; i++) stepMovement(runner, fwd, TICK_DT, terrain);
    const runSpeed = Math.hypot(runner.vx, runner.vz);

    const swimmer = createMovementState(0, -0.55, 14);
    swimmer.swimming = true;
    swimmer.grounded = false;
    for (let i = 0; i < 40; i++) stepMovement(swimmer, fwd, TICK_DT, terrain);
    const swimSpeed = Math.hypot(swimmer.vx, swimmer.vz);
    expect(swimSpeed).toBeLessThan(runSpeed * 0.65);
    expect(swimSpeed).toBeGreaterThan(runSpeed * 0.4);
  });

  it('negates fall damage when landing in swimmable water', () => {
    const terrain = shoreTerrain();
    const diver = createMovementState(0, 30, 14); // high above deep water
    diver.grounded = false;
    diver.fallPeakY = 30;
    let damaged = 0;
    for (let i = 0; i < 200; i++) {
      damaged += stepMovement(diver, still, TICK_DT, terrain).fallDamageFraction;
    }
    expect(diver.swimming).toBe(true);
    expect(damaged).toBe(0);

    // The same drop onto dry ground DOES hurt.
    const faller = createMovementState(0, 30, 0);
    faller.grounded = false;
    faller.fallPeakY = 30;
    let groundDamage = 0;
    for (let i = 0; i < 200; i++) {
      groundDamage += stepMovement(faller, still, TICK_DT, terrain).fallDamageFraction;
    }
    expect(groundDamage).toBeGreaterThan(0);
  });

  it('drains stamina faster while swim-sprinting and never jumps from water', () => {
    const terrain = shoreTerrain();
    const sprintFwd: MovementIntent = { moveX: 0, moveZ: 1, yaw: 0, buttons: 1 }; // Sprint bit
    const jumpFwd: MovementIntent = { moveX: 0, moveZ: 1, yaw: 0, buttons: 2 }; // Jump bit

    const swimmer = createMovementState(0, -0.55, 14);
    swimmer.swimming = true;
    swimmer.grounded = false;
    const before = swimmer.stamina;
    for (let i = 0; i < 20; i++) stepMovement(swimmer, sprintFwd, TICK_DT, terrain);
    const swimDrain = before - swimmer.stamina;

    const runner = createMovementState(0, 0, 0);
    const beforeRun = runner.stamina;
    for (let i = 0; i < 20; i++) stepMovement(runner, sprintFwd, TICK_DT, terrain);
    const runDrain = beforeRun - runner.stamina;
    expect(swimDrain).toBeGreaterThan(runDrain);

    const jumper = createMovementState(0, -0.55, 14);
    jumper.swimming = true;
    jumper.grounded = false;
    const result = stepMovement(jumper, jumpFwd, TICK_DT, terrain);
    expect(result.jumped).toBe(false);
    expect(jumper.y).toBeCloseTo(-0.55, 3); // still pinned to the surface
  });

  it('client/server parity holds across 10k mixed land/water ticks', () => {
    const terrain = shoreTerrain();
    const a = createMovementState(0, 0, 0);
    const b = createMovementState(0, 0, 0);
    let hash = 7;
    for (let i = 0; i < 10_000; i++) {
      // Deterministic pseudo-random intents crossing the shoreline repeatedly.
      hash = (Math.imul(hash, 1103515245) + 12345) | 0;
      const intent: MovementIntent = {
        moveX: ((hash >> 3) % 3) - 1,
        moveZ: ((hash >> 7) % 3) - 1,
        yaw: ((hash >> 11) % 628) / 100,
        buttons: (hash >> 15) & 3,
      };
      stepMovement(a, intent, TICK_DT, terrain);
      stepMovement(b, intent, TICK_DT, terrain);
    }
    expect(a).toEqual(b);
    expect(Number.isFinite(a.x + a.y + a.z)).toBe(true);
  });
});
