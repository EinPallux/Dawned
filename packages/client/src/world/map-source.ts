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
  zonesFileSchema,
  type MapChunk,
  type ZonesFile,
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

  constructor(readonly version: string) {}

  private url(file: string): string {
    return `/assets/map/${this.version}/${file}`;
  }

  /** Load meta + zones + open the cache. Call once before anything else. */
  async open(): Promise<{ meta: MapMeta; zones: ZonesFile }> {
    this.db = await openDatabase();
    const [metaResponse, zonesResponse] = await Promise.all([
      fetch(this.url('meta.json')),
      fetch(this.url('zones.json')),
    ]);
    if (!metaResponse.ok || !zonesResponse.ok) {
      throw new Error(`map "${this.version}" is missing its meta/zones artifacts`);
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
    const key = `${this.version}/${file}`;
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
}
