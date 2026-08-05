/**
 * Professions (`J`, PROFESSIONS.md §1.3): four independent levels, the tier
 * gate each one has reached, and the codex of everything it has ever brought
 * home.
 *
 * The codex is the point of this panel. Levels are a number you could read off
 * a toast; the collection is the thing you come back to look at — which fish
 * you have never caught, which gem the Weald still owes you. It is drawn from
 * what the SERVER remembers you gathering, not from what is in your bag, so
 * selling a stack does not un-discover it.
 *
 * The shell is the same `pv-*` panel the sheet and the pack use. Every overlay
 * in the game is that shell; a hand-rolled one drifts the moment the design
 * system moves (UI_UX.md §4) — and the first draft of this file proved it by
 * inventing classes the stylesheet did not have, which rendered as a
 * see-through slab pinned to the corner with the debug HUD showing through.
 */

import { useSyncExternalStore } from 'react';
import {
  MAX_PROFESSION_LEVEL,
  PROFESSIONS,
  gateForTier,
  type ItemDef,
  type ProfessionSyncMessage,
} from '@dawned/shared';
import type { ProfessionsBridge } from '../../game/run-world.js';
import { rarityColor } from './item-format.js';

/** Display names + the verb each profession is really about. */
const LABEL: Record<string, { name: string; verb: string }> = {
  woodcutting: { name: 'Woodcutting', verb: 'chopped' },
  mining: { name: 'Mining', verb: 'mined' },
  herbalism: { name: 'Herbalism', verb: 'picked' },
  fishing: { name: 'Fishing', verb: 'caught' },
};

export const ProfessionsPanel = ({
  bridge,
  onClose,
}: {
  bridge: ProfessionsBridge;
  onClose: () => void;
}): React.JSX.Element => {
  useSyncExternalStore(bridge.subscribe, bridge.version);
  const state = bridge.state();

  /** Everything this profession CAN produce, so gaps are visible as gaps. */
  const catalogueFor = (profession: string): ItemDef[] => bridge.catalogue(profession);

  const rows = PROFESSIONS.map((profession) => {
    const live = state?.professions.find(
      (entry: ProfessionSyncMessage['professions'][number]) => entry.profession === profession,
    );
    return {
      profession,
      level: live?.level ?? 1,
      xp: live?.xp ?? 0,
      xpToNext: live?.xpToNext ?? 0,
      tier: live?.tier ?? 1,
      codex: state?.codex[profession] ?? [],
      catalogue: catalogueFor(profession),
    };
  });

  /** One line at the top for "how much of this game have I seen?". */
  const foundTotal = rows.reduce(
    (sum, row) => sum + row.catalogue.filter((def) => row.codex.includes(def.id)).length,
    0,
  );
  const catalogueTotal = rows.reduce((sum, row) => sum + row.catalogue.length, 0);

  return (
    <div className="pv-scrim" data-panel="professions">
      <section className="pv-panel pv-professions">
        <header className="pv-title">
          PROFESSIONS
          <span className="pv-title-meta">
            CODEX <b data-live={String(foundTotal > 0)}>{foundTotal}</b> / {catalogueTotal}
          </span>
          <button className="pv-close" onClick={onClose} type="button" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="pv-body">
          {state === null ? (
            <p className="pv-note">Waiting for the server…</p>
          ) : (
            <div className="prof-list">
              {rows.map((row) => {
                const capped = row.level >= MAX_PROFESSION_LEVEL;
                const pct = capped ? 100 : Math.round((row.xp / Math.max(1, row.xpToNext)) * 100);
                const nextGate = row.tier < 5 ? gateForTier(row.tier + 1) : null;
                const known = new Set(row.codex);
                const found = row.catalogue.filter((def) => known.has(def.id)).length;
                return (
                  <section
                    className="prof-row"
                    key={row.profession}
                    data-profession={row.profession}
                  >
                    <header className="prof-head">
                      <span className="prof-name">
                        {LABEL[row.profession]?.name ?? row.profession}
                      </span>
                      <span className="prof-level">{row.level}</span>
                      <span className="prof-tier">
                        T{row.tier} nodes
                        {nextGate !== null ? (
                          <span className="prof-gate">
                            {' · '}T{row.tier + 1} at {nextGate}
                          </span>
                        ) : null}
                      </span>
                    </header>
                    <div className="prof-bar">
                      <div className="prof-bar-fill" style={{ width: `${pct}%` }} />
                      <span className="prof-bar-label">
                        {capped ? 'mastered' : `${row.xp} / ${row.xpToNext} xp`}
                      </span>
                    </div>
                    <div className="prof-codex-head">
                      <span>Codex</span>
                      <span className="prof-codex-count">
                        {found}/{row.catalogue.length}
                      </span>
                    </div>
                    <div className="prof-codex">
                      {row.catalogue.length === 0 ? (
                        <span className="pv-note">No catalogue loaded.</span>
                      ) : (
                        row.catalogue.map((def) => {
                          const has = known.has(def.id);
                          return (
                            <span
                              className="prof-codex-cell"
                              key={def.id}
                              data-found={String(has)}
                              title={
                                has
                                  ? `${def.name} — ${LABEL[row.profession]?.verb ?? 'gathered'}`
                                  : 'Not yet found'
                              }
                              style={has ? { borderColor: rarityColor(def.rarity) } : undefined}
                            >
                              {has ? (
                                <img
                                  alt=""
                                  className="prof-codex-icon"
                                  src={bridge.iconUrl(def.icon) ?? ''}
                                />
                              ) : (
                                <span className="prof-codex-unknown">?</span>
                              )}
                            </span>
                          );
                        })
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
