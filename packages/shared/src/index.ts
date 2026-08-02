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
export * from './data/appearance.js';
export * from './api/requests.js';
// NOTE: the Drizzle database schema is deliberately NOT exported here — it would
// drag ORM code into the browser bundle. Server/admin import '@dawned/shared/schema'.
