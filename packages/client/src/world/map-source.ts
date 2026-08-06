/**
 * Map artifact loading — meta, zones, walkgrid and terrain chunks from
 * /assets/map/<version>/ (docs/tech/ASSET_PIPELINE.md §6), with an IndexedDB
 * cache keyed by map version so repeat visits stream from disk, not network.
 *
 * The cache is best-effort: any IndexedDB failure (private mode, quota) falls
 * back to plain fetches. Chunk existence comes from meta.json's id list — the
 * client never probes for ocean chunks that were never baked.
 */

import {
  Walkgrid,
  decodeChunk,
  placementsFileSchema,
  zonesFileSchema,
  type MapChunk,
  type PlacementsFile,
  type ZonesFile,
  CHUNK_SIZE_M,
  WORLD_ORIGIN_M,
} from '@dawned/shared';

export interface MapMeta {
  mapVersion: string;
  spawn: { x: number; y: number; z: number; yaw: number };
  seaLevel: number;
  chunks: { emitted: number; ids: string[] };
}

const DB_NAME = 'dawned-map';
const STORE = 'artifacts';

const openDatabase = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });

const idbGet = (db: IDBDatabase, key: string): Promise<ArrayBuffer | null> =>
  new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => {
        resolve(request.result instanceof ArrayBuffer ? request.result : null);
      };
      request.onerror = () => {
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });

const idbPut = (db: IDBDatabase, key: string, value: ArrayBuffer): void => {
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
  } catch {
    // Cache is advisory — losing a write costs one refetch.
  }
};

export class MapSource {
  private db: IDBDatabase | null = null;
  private meta: MapMeta | null = null;
  private zones: ZonesFile | null = null;
  private available = new Set<string>();

  /**
   * `fallbackVersion` is the compiled-in `MAP_VERSION`, used only until the
   * server says which bake it is running. After A2 the live version is a
   * published artifact directory, and the SERVER is the authority on which one
   * — a client streaming a different map than the server simulates would
   * predict against ground that is not there.
   */
  constructor(private activeVersion: string) {}

  get version(): string {
    return this.activeVersion;
  }

  private url(file: string): string {
    return `/assets/map/${this.activeVersion}/${file}`;
  }

  /** Load meta + zones + open the cache. Call once before anything else. */
  async open(serverVersion?: string): Promise<{ meta: MapMeta; zones: ZonesFile }> {
    if (serverVersion) this.activeVersion = serverVersion;
    this.db = await openDatabase();
    const [metaResponse, zonesResponse] = await Promise.all([
      fetch(this.url('meta.json')),
      fetch(this.url('zones.json')),
    ]);
    if (!metaResponse.ok || !zonesResponse.ok) {
      throw new Error(`map "${this.activeVersion}" is missing its meta/zones artifacts`);
    }
    this.meta = (await metaResponse.json()) as MapMeta;
    this.zones = zonesFileSchema.parse(await zonesResponse.json());
    this.available = new Set(this.meta.chunks.ids);
    return { meta: this.meta, zones: this.zones };
  }

  hasChunk(cx: number, cy: number): boolean {
    return this.available.has(`${cx}_${cy}`);
  }

  /** Cached-or-fetched binary artifact; null when it doesn't exist. */
  private async loadBinary(file: string): Promise<ArrayBuffer | null> {
    const key = `${this.activeVersion}/${file}`;
    if (this.db) {
      const cached = await idbGet(this.db, key);
      if (cached) return cached;
    }
    const response = await fetch(this.url(file));
    // Dev servers answer unknown paths with the SPA page — verify content type.
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
      return null;
    }
    const bytes = await response.arrayBuffer();
    if (this.db) idbPut(this.db, key, bytes);
    return bytes;
  }

  /** Fetch + decode one terrain chunk. Null = open ocean (not baked). */
  async loadChunk(cx: number, cy: number): Promise<MapChunk | null> {
    if (!this.hasChunk(cx, cy)) return null;
    const bytes = await this.loadBinary(`chunk_${cx}_${cy}.bin`);
    return bytes ? decodeChunk(new Uint8Array(bytes)) : null;
  }

  async loadWalkgrid(): Promise<Walkgrid | null> {
    const bytes = await this.loadBinary('walkgrid.bin');
    return bytes ? Walkgrid.decode(new Uint8Array(bytes)) : null;
  }

  /**
   * Placed objects from the bake (P10 needs the `nodes` layer).
   *
   * Deliberately NOT cached in IndexedDB with the chunks: placements change on
   * every map publish while a chunk usually does not, and the file is small.
   * Parsed through the shared schema rather than cast — this is the same file
   * the server reads, and a client that silently accepted a malformed one
   * would render a world the server does not simulate.
   */
  /**
   * The world square the bake actually EMITTED, in metres.
   *
   * `meta.chunks.ids` is the bake's own answer to "where is there a world" —
   * it lists exactly the chunks that were written, so it tracks whatever the
   * owner publishes rather than a constant that rots the first time the map
   * grows. The world map frames on this: a map of 2048 m of ocean with the
   * island as a smudge in the middle is not a map of anywhere.
   */
  emittedBounds(): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
    const ids = this.meta?.chunks.ids ?? [];
    if (ids.length === 0) return null;
    let minCx = Infinity;
    let minCy = Infinity;
    let maxCx = -Infinity;
    let maxCy = -Infinity;
    for (const id of ids) {
      const [cx, cy] = id.split('_').map(Number);
      if (cx === undefined || cy === undefined || Number.isNaN(cx) || Number.isNaN(cy)) continue;
      minCx = Math.min(minCx, cx);
      minCy = Math.min(minCy, cy);
      maxCx = Math.max(maxCx, cx);
      maxCy = Math.max(maxCy, cy);
    }
    if (!Number.isFinite(minCx)) return null;
    return {
      minX: WORLD_ORIGIN_M + minCx * CHUNK_SIZE_M,
      minZ: WORLD_ORIGIN_M + minCy * CHUNK_SIZE_M,
      maxX: WORLD_ORIGIN_M + (maxCx + 1) * CHUNK_SIZE_M,
      maxZ: WORLD_ORIGIN_M + (maxCy + 1) * CHUNK_SIZE_M,
    };
  }

  /**
   * The published world-map image for this bake, or null when it has none.
   *
   * A URL rather than the decoded image: the map panel draws it into a canvas
   * and only opens occasionally, so there is no reason to hold a megapixel
   * texture for a screen nobody has looked at yet. HEAD, because a bake made
   * before the renderer existed answers the SPA's index.html with a 200.
   */
  async worldMapUrl(): Promise<string | null> {
    const url = this.url('worldmap.png');
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (!response.ok || response.headers.get('content-type')?.includes('text/html')) return null;
      return url;
    } catch {
      return null;
    }
  }

  async loadPlacements(): Promise<PlacementsFile | null> {
    try {
      const response = await fetch(this.url('placements.json'));
      if (!response.ok || response.headers.get('content-type')?.includes('text/html')) return null;
      return placementsFileSchema.parse(await response.json());
    } catch (error) {
      console.warn('[map] placements unavailable:', error);
      return null;
    }
  }
}
