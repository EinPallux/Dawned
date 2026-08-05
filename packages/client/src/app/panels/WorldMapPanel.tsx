/**
 * The world map (`M`, QUESTS_POI.md §4 / WORLD.md §4.2) — fog of unknowing,
 * pins for what you have found, and the shrine network.
 *
 * Drawn on a canvas from the bake's own minimap tile, because the map has to be
 * the map: an SVG the client invented would drift from the terrain the moment
 * the owner republishes, and this world is republished from an editor.
 *
 * **Fog is per character and comes from the server.** `DiscoverySync` carries
 * the whole set of zones, POIs and shrines this character has found — it has to
 * be the whole set rather than a delta, because it is also what a relog
 * restores. Undiscovered POIs are not dimmed here; they are ABSENT. A grey pin
 * where a secret is would make exploration a matter of walking to the greyed
 * pins, which is the opposite of §1 rule 1.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { WORLD_ORIGIN_M, WORLD_SIZE_M, fastTravelCost } from '@dawned/shared';
import type { QuestBridge } from '../../game/run-world.js';

const CANVAS_PX = 520;

/** Smallest span the map will frame, in metres — a floor, rarely reached. */
const MIN_SPAN_M = 420;

/** Shared empty list, so "nothing discovered yet" is a stable reference. */
const NONE: readonly string[] = [];

/** Pin colours per POI kind — a glance says what sort of place it is. */
const PIN_COLOR: Record<string, string> = {
  vista: '#9ad4ff',
  landmark: '#f0c46b',
  cache: '#c99af0',
  camp: '#e08a6a',
  shrine: '#8ef0c0',
  curiosity: '#d0d6e2',
};

export const WorldMapPanel = ({
  bridge,
  onClose,
}: {
  bridge: QuestBridge;
  onClose: () => void;
}): React.JSX.Element => {
  useSyncExternalStore(bridge.subscribe, bridge.version);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tile, setTile] = useState<HTMLImageElement | null>(null);

  const discovery = bridge.discovery();
  const pois = bridge.pois();
  const shrines = bridge.shrines();
  const self = bridge.selfPosition();
  const attuned = new Set(discovery?.shrines ?? NONE);
  // The ARRAY off the sync message, not a Set built here: the message object is
  // stable between syncs, so the draw effect below only re-runs when the server
  // actually told us something new.
  const foundIds = discovery?.pois ?? NONE;

  // The bake writes a world-map image next to the chunks. It may not exist on
  // an older bake, in which case the canvas stays on its flat ground colour —
  // the pins are the useful half and they do not need it.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void (async () => {
      const url = await bridge.worldMapUrl();
      if (!url || !live.current) return;
      const image = new Image();
      image.onload = () => {
        if (live.current) setTile(image);
      };
      image.src = url;
    })();
    return () => {
      live.current = false;
    };
  }, [bridge]);

  /**
   * The square of world the canvas shows.
   *
   * Framed on the chunks the BAKE emitted — its own answer to "where is there a
   * world" — widened if the player or a pin has somehow wandered outside it,
   * and squared off so the terrain image is never stretched. Framing on the
   * pins alone zoomed past the coastline and drew a flat green field; framing
   * on the whole 2048 m world drew an ocean with the island as a smudge. The
   * bake knows, and it keeps knowing when P12 raises four more isles.
   */
  const emitted = bridge.mapBounds();
  let minX = emitted?.minX ?? self.x;
  let maxX = emitted?.maxX ?? self.x;
  let minZ = emitted?.minZ ?? self.z;
  let maxZ = emitted?.maxZ ?? self.z;
  for (const anchor of [...pois, ...shrines, self]) {
    minX = Math.min(minX, anchor.x);
    maxX = Math.max(maxX, anchor.x);
    minZ = Math.min(minZ, anchor.z);
    maxZ = Math.max(maxZ, anchor.z);
  }
  const span = Math.max(MIN_SPAN_M, maxX - minX, maxZ - minZ);
  const centreX = (minX + maxX) / 2;
  const centreZ = (minZ + maxZ) / 2;
  const viewX = centreX - span / 2;
  const viewZ = centreZ - span / 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    ctx.fillStyle = '#0d121b';
    ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
    /** World metres → canvas pixels, inside the effect so it has no identity. */
    const toCanvas = (x: number, z: number): { px: number; py: number } => ({
      px: ((x - viewX) / span) * CANVAS_PX,
      py: ((z - viewZ) / span) * CANVAS_PX,
    });
    if (tile) {
      // Source rect: the same window the pins use, so a pin and the coast it
      // sits on cannot disagree.
      const scale = tile.width / WORLD_SIZE_M;
      ctx.drawImage(
        tile,
        (viewX - WORLD_ORIGIN_M) * scale,
        (viewZ - WORLD_ORIGIN_M) * scale,
        span * scale,
        span * scale,
        0,
        0,
        CANVAS_PX,
        CANVAS_PX,
      );
    }

    // POI pins: facetted diamonds, drawn as paths (UI_UX.md — a shape language,
    // not a character set), only for places this character has been.
    const found = new Set(foundIds);
    let label = 0;
    for (const poi of pois) {
      if (!found.has(poi.id)) continue;
      const { px, py } = toCanvas(poi.x, poi.z);
      ctx.save();
      ctx.translate(px, py);
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 0);
      ctx.lineTo(0, 7);
      ctx.lineTo(-5, 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(21,26,38,0.9)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = PIN_COLOR[poi.kind] ?? '#d0d6e2';
      ctx.stroke();
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      // Alternate the label above and below the pin. Two POIs sharing a spot
      // (a shrine POI on top of the shrine itself, which the pilot set has) put
      // their names in the same pixels otherwise.
      const below = label % 2 === 0;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(13,18,27,0.9)';
      ctx.strokeText(poi.name, 0, below ? 20 : -12);
      ctx.fillStyle = '#cdd4e0';
      ctx.fillText(poi.name, 0, below ? 20 : -12);
      label++;
      ctx.restore();
    }

    // Hint circles for the steps that have one. An EXPLORE step deliberately
    // has none — clue text only — so this loop simply never sees those.
    for (const hint of bridge.hints()) {
      const { px, py } = toCanvas(hint.x, hint.z);
      const radius = (hint.radius / WORLD_SIZE_M) * CANVAS_PX;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(4, radius), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(240,196,107,0.75)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(240,196,107,0.08)';
      ctx.fill();
    }

    // You. Last, so nothing draws over it.
    const you = toCanvas(self.x, self.z);
    ctx.beginPath();
    ctx.arc(you.px, you.py, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#f0e6d2';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#151a26';
    ctx.stroke();
  }, [tile, pois, foundIds, self, bridge, span, viewX, viewZ]);

  /** Which shrine we are standing at, if any — a hop needs a FROM. */
  const nearestShrine = shrines
    .map((shrine) => ({
      ...shrine,
      distance: Math.hypot(self.x - shrine.x, self.z - shrine.z),
    }))
    .sort((a, b) => a.distance - b.distance)[0];
  const atShrine = nearestShrine && nearestShrine.distance <= 4 ? nearestShrine : null;

  return (
    <div className="pv-scrim" data-panel="map">
      <section className="pv-panel is-wide pv-worldmap">
        <header className="pv-title">
          THE DAWNLANDS
          <span className="pv-title-meta">
            <b data-live={String(foundIds.length > 0)}>{foundIds.length}</b> / {pois.length} found
          </span>
          <button className="pv-close" onClick={onClose} type="button" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="pv-body">
          <div className="wm-wrap">
            <canvas
              className="wm-canvas"
              data-worldmap
              height={CANVAS_PX}
              ref={canvasRef}
              width={CANVAS_PX}
            />
          </div>

          <div className="wm-legend">
            {Object.entries(PIN_COLOR).map(([kind, color]) => (
              <span key={kind} style={{ color }}>
                {kind}
              </span>
            ))}
          </div>

          <div className="wm-travel">
            <div className="jr-zone">
              Shrine network
              {atShrine ? ` — you are at ${atShrine.name}` : ' — stand at a shrine to travel'}
            </div>
            {shrines.length === 0 ? (
              <p className="pv-note">No shrines found yet.</p>
            ) : (
              shrines.map((shrine) => {
                const known = attuned.has(shrine.id);
                const here = atShrine?.id === shrine.id;
                const cost =
                  atShrine && !here
                    ? fastTravelCost(atShrine.x, atShrine.z, shrine.x, shrine.z)
                    : 0;
                return (
                  <button
                    className="wm-hop"
                    data-shrine={shrine.id}
                    disabled={!known || !atShrine || here}
                    key={shrine.id}
                    onClick={() => {
                      if (atShrine) bridge.travel(atShrine.id, shrine.id);
                    }}
                    type="button"
                  >
                    {shrine.name}
                    <span className="wm-hop-cost">
                      {here ? 'you are here' : known ? `${cost} g` : 'not attuned'}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
