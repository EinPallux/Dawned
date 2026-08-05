/**
 * @dawned/shared — the only module the client and server may share.
 *
 * If both sides need a number, a formula, a packet shape or an id, it belongs here
 * (docs/tech/ARCHITECTURE.md §2).
 */

export * from './constants.js';
export * from './math/vec.js';
export * from './protocol/index.js';
export * from './formulas/index.js';
export * from './world/dev-terrain.js';
export * from './world/map.js';
export * from './world/chunk-codec.js';
export * from './world/chunk-terrain.js';
export * from './world/walkgrid.js';
export * from './world/brush.js';
export * from './world/terrain-geometry.js';
export * from './content/zones.js';
export * from './content/placements.js';
export * from './content/world-settings.js';
export * from './content/enemies.js';
export * from './content/enemy-clips.js';
export * from './content/spawners.js';
export * from './content/abilities.js';
export * from './content/xp-curve.js';
export * from './content/skill-nodes.js';
export * from './content/items.js';
export * from './content/loot.js';
export * from './content/vendors.js';
export * from './content/resource-nodes.js';
export * from './data/appearance.js';
export * from './data/splat-layers.js';
export * from './data/basic-combos.js';
export * from './api/requests.js';
// NOTE: the Drizzle database schema is deliberately NOT exported here — it would
// drag ORM code into the browser bundle. Server/admin import '@dawned/shared/schema'.
