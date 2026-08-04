/**
 * Skills panel (`K`, UI_UX.md §4): left — the 8 ability tiles with unlock
 * states; right — the class's 3-branch tree as vertical faceted lattices,
 * nodes as cut hexes, connectors lighting up on invest, capstone at the
 * crown. Allocation clicks run the SHARED gate check before anything hits
 * the wire; the tree the panel draws is the same published rows the server
 * folds (content-as-data).
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  CLASS_BRANCHES,
  branchPointsSpent,
  nodeGate,
  respecCost,
  type SkillNodeDef,
} from '@dawned/shared';
import type { ProgressionBridge } from '../../game/run-world.js';
import { describeNodeRank } from './panel-format.js';

const monogram = (name: string): string => {
  const words = name.replace(/[_-]+/g, ' ').trim().split(/\s+/);
  if (words.length >= 2) return `${words[0]![0] ?? ''}${words[1]![0] ?? ''}`.toUpperCase();
  return (words[0] ?? '??').slice(0, 2).toUpperCase();
};

export const SkillsPanel = (props: {
  bridge: ProgressionBridge;
  onClose: () => void;
}): React.JSX.Element => {
  const { bridge } = props;
  const version = useSyncExternalStore(bridge.subscribe, bridge.version);
  const sheet = bridge.sheet();
  const [respecArmed, setRespecArmed] = useState(false);
  // One fixed-position tooltip at scrim level: the branch boxes clip-path
  // their contents, so an in-node tooltip would be cut at the column edge.
  const [hover, setHover] = useState<{ nodeId: string; x: number; y: number } | null>(null);

  const classId = bridge.classId();
  const level = bridge.level();
  const branches = CLASS_BRANCHES[classId];
  const defs = bridge.nodeDefs();
  const ranks = bridge.ranks();
  const unspent = sheet?.unspentSkillPoints ?? 0;

  // Branch columns in display order (nodes by `order`), recomputed per change.
  const columns = useMemo(
    () =>
      branches.map((branch) => {
        const nodes = [...defs.values()]
          .filter((def) => def.classId === classId && def.branch === branch.id)
          .sort((a, b) => a.order - b.order);
        return { branch, nodes };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the defs/ranks change signal
    [version, classId, branches],
  );

  const respecPrice = respecCost('skills', level);
  const spentTotal = [...ranks.values()].reduce((sum, rank) => sum + rank, 0);
  const hotbar = bridge.hotbar();

  const nodeState = (
    def: SkillNodeDef,
  ): {
    rank: number;
    gateText: string | null;
    allocatable: boolean;
  } => {
    const rank = ranks.get(def.id) ?? 0;
    const points = branchPointsSpent(ranks, defs, classId, def.branch);
    const gate = nodeGate(def, level, points);
    let gateText: string | null = null;
    if (!gate.unlocked) {
      const needs: string[] = [];
      if (gate.pointsMissing > 0) needs.push(`${gate.pointsMissing} more in branch`);
      if (gate.levelMissing > 0) needs.push(`level ${level + gate.levelMissing}`);
      gateText = `Locked — needs ${needs.join(' · ')}`;
    }
    return {
      rank,
      gateText,
      allocatable: gate.unlocked && rank < def.maxRanks && unspent > 0,
    };
  };

  return (
    <div className="pv-scrim" data-panel="skills">
      <section className="pv-panel is-wide">
        <header className="pv-title">
          <span>SKILLS</span>
          <span className="pv-title-meta">
            Level {level} · {classId.toUpperCase()} ·{' '}
            <b data-live={unspent > 0 ? 'true' : 'false'}>{unspent} points</b>
          </span>
          <button className="pv-close" onClick={props.onClose} type="button" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="pv-body pv-skills">
          <div className="pv-abilities">
            <div className="pv-section-head">ABILITIES</div>
            {hotbar.map((row) => {
              const icon = row.def ? bridge.iconUrl(row.def.icon) : undefined;
              return (
                <div
                  className="pv-ability"
                  key={row.slot}
                  data-locked={row.lockedUntilLevel > 0 ? 'true' : 'false'}
                  title={row.def ? `${row.def.name} — ${row.def.description}` : ''}
                >
                  <span className="pv-ability-key">{row.slot}</span>
                  {icon ? (
                    <span
                      className="pv-ability-icon"
                      style={{ ['--icon' as never]: `url('${icon}')` }}
                    />
                  ) : (
                    <span className="pv-ability-glyph">
                      {row.def ? monogram(row.def.name) : ''}
                    </span>
                  )}
                  <span className="pv-ability-name">{row.def?.name ?? '—'}</span>
                  {row.lockedUntilLevel > 0 ? (
                    <span className="pv-ability-lock">Lv {row.lockedUntilLevel}</span>
                  ) : null}
                </div>
              );
            })}
            <div className="pv-footer">
              {respecArmed ? (
                <button
                  type="button"
                  className="pv-button is-danger"
                  disabled={(sheet?.gold ?? 0) < respecPrice}
                  onClick={() => {
                    bridge.respec('skills');
                    setRespecArmed(false);
                  }}
                >
                  SURE? PAY {respecPrice} GOLD — REFUND {spentTotal} POINTS
                </button>
              ) : (
                <button
                  type="button"
                  className="pv-button"
                  disabled={spentTotal < 1}
                  onClick={() => {
                    setRespecArmed(true);
                  }}
                >
                  RESPEC TREE · {respecPrice} g
                </button>
              )}
              <p className="pv-note">
                Tiers open at 0/3/6/9/12 points in the branch or level 2/5/10/15/20 — whichever
                comes later. Capstones need 8 points and level 25.
              </p>
            </div>
          </div>
          <div className="pv-tree">
            {columns.map(({ branch, nodes }) => {
              const points = branchPointsSpent(ranks, defs, classId, branch.id);
              return (
                <div className="pv-branch" key={branch.id}>
                  <div className="pv-branch-head">
                    <span className="pv-branch-name">{branch.name}</span>
                    <span className="pv-branch-theme">{branch.theme}</span>
                    <span className="pv-branch-points">{points}</span>
                  </div>
                  <div className="pv-lattice">
                    {nodes.map((def, index) => {
                      const state = nodeState(def);
                      const invested = state.rank > 0;
                      const prev = index > 0 ? (nodes[index - 1] ?? null) : null;
                      const linkLit = invested && prev !== null && (ranks.get(prev.id) ?? 0) > 0;
                      // The lattice climbs: tier 1 at the foot, capstone at
                      // the crown (CSS column-reverse) — the connector sits
                      // AFTER the node in DOM so it renders between this row
                      // and the lower-order one beneath it.
                      return (
                        <div className="pv-node-row" key={def.id}>
                          <button
                            type="button"
                            className="pv-node"
                            data-capstone={def.capstone ? 'true' : 'false'}
                            data-state={invested ? 'invested' : state.gateText ? 'locked' : 'open'}
                            data-can={state.allocatable ? 'true' : 'false'}
                            onClick={() => {
                              bridge.allocateSkill(def.id);
                            }}
                            onMouseEnter={(event) => {
                              const rect = event.currentTarget.getBoundingClientRect();
                              // Right of the node; flip left near the edge.
                              const flip = rect.right + 260 > window.innerWidth;
                              setHover({
                                nodeId: def.id,
                                x: flip ? rect.left - 252 : rect.right + 6,
                                y: Math.min(rect.top, window.innerHeight - 240),
                              });
                            }}
                            onMouseLeave={() => {
                              setHover((current) => (current?.nodeId === def.id ? null : current));
                            }}
                          >
                            <span className="pv-node-hex">
                              <span className="pv-node-glyph">{monogram(def.name)}</span>
                            </span>
                            <span className="pv-node-label">
                              <span className="pv-node-name">{def.name}</span>
                              <span className="pv-node-rank">
                                {state.rank}/{def.maxRanks}
                              </span>
                            </span>
                          </button>
                          {index > 0 ? (
                            <span className="pv-connector" data-lit={linkLit ? 'true' : 'false'} />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
      {hover
        ? (() => {
            const def = defs.get(hover.nodeId);
            if (!def) return null;
            const state = nodeState(def);
            return (
              <div className="pv-tooltip" style={{ left: hover.x, top: hover.y }}>
                <b>
                  {def.name}
                  {def.capstone ? ' — CAPSTONE' : ` — tier ${def.tier}`}
                </b>
                {def.description ? <i>{def.description}</i> : null}
                {describeNodeRank(def, Math.max(1, state.rank)).map((line) => (
                  <span key={line} data-now={state.rank > 0 ? 'true' : 'false'}>
                    {line}
                  </span>
                ))}
                {state.rank > 0 && state.rank < def.maxRanks ? (
                  <>
                    <em>Next rank:</em>
                    {describeNodeRank(def, state.rank + 1).map((line) => (
                      <span key={`next-${line}`}>{line}</span>
                    ))}
                  </>
                ) : null}
                {state.gateText ? <u>{state.gateText}</u> : null}
              </div>
            );
          })()
        : null}
    </div>
  );
};
