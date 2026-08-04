/**
 * Character panel (`C`, UI_UX.md §4): attributes with +/− staging & Confirm,
 * the suggested-build one-click, derived stats with hover formulas, gold and
 * the attribute respec. All math is shared-formula math — what this previews
 * is exactly what the server derives after Confirm.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  aggregateNodeEffects,
  attributeTotals,
  respecCost,
  zeroAttributes,
  type AttributeSpread,
} from '@dawned/shared';
import type { ProgressionBridge } from '../../game/run-world.js';
import { CLASS_BASE, derivedRows, suggestedAllocation } from './panel-format.js';

const ATTRIBUTES: { key: keyof AttributeSpread; label: string; grants: string }[] = [
  { key: 'str', label: 'STR', grants: '+1 AP (Warrior) · +0.5 Armor' },
  { key: 'agi', label: 'AGI', grants: '+1 AP (Rogue) · +0.04% Crit' },
  { key: 'int', label: 'INT', grants: '+1 SP · +10 Max Mana' },
  { key: 'vit', label: 'VIT', grants: '+12 Max HP' },
  { key: 'end', label: 'END', grants: '+5 Stamina · regen per 4' },
];

export const CharacterPanel = (props: {
  bridge: ProgressionBridge;
  onClose: () => void;
}): React.JSX.Element => {
  const { bridge } = props;
  // The version counter is the stable snapshot; the sheet itself mutates in
  // place between syncs, so it can't be the useSyncExternalStore value.
  const version = useSyncExternalStore(bridge.subscribe, bridge.version);
  const sheet = bridge.sheet();
  const [staged, setStaged] = useState<AttributeSpread>(zeroAttributes());
  const [respecArmed, setRespecArmed] = useState(false);

  const classId = bridge.classId();
  const level = bridge.level();
  const stagedTotal = staged.str + staged.agi + staged.int + staged.vit + staged.end;
  const allocated = sheet?.allocated ?? zeroAttributes();
  const preview: AttributeSpread = {
    str: allocated.str + staged.str,
    agi: allocated.agi + staged.agi,
    int: allocated.int + staged.int,
    vit: allocated.vit + staged.vit,
    end: allocated.end + staged.end,
  };
  const totals = attributeTotals(classId, preview);
  const base = CLASS_BASE[classId];
  const unspent = (sheet?.unspentStatPoints ?? 0) - stagedTotal;

  // Derived rows preview the STAGED allocation against the live node folds.
  const aggregates = useMemo(
    () => aggregateNodeEffects(bridge.nodeDefs(), bridge.ranks()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the change signal for ranks/defs
    [version, bridge],
  );
  const rows = derivedRows(classId, level, preview, aggregates);

  const stage = (key: keyof AttributeSpread, delta: number): void => {
    const next = staged[key] + delta;
    if (next < 0 || (delta > 0 && unspent < 1)) return;
    setStaged({ ...staged, [key]: next });
  };
  const stageSuggested = (): void => {
    const suggestion = suggestedAllocation(classId);
    const per = suggestion.str + suggestion.agi + suggestion.int + suggestion.vit + suggestion.end;
    if (unspent < per) return;
    setStaged({
      str: staged.str + suggestion.str,
      agi: staged.agi + suggestion.agi,
      int: staged.int + suggestion.int,
      vit: staged.vit + suggestion.vit,
      end: staged.end + suggestion.end,
    });
  };
  const suggestion = suggestedAllocation(classId);
  const suggestionText = ATTRIBUTES.filter((a) => suggestion[a.key] > 0)
    .map((a) => `${suggestion[a.key]} ${a.label}`)
    .join(' ');
  const respecPrice = respecCost('stats', level);

  return (
    <div className="pv-scrim" data-panel="character">
      <section className="pv-panel">
        <header className="pv-title">
          <span>CHARACTER</span>
          <span className="pv-title-meta">
            Level {level} · {classId.toUpperCase()}
          </span>
          <button className="pv-close" onClick={props.onClose} type="button" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="pv-body pv-body-split">
          <div className="pv-col">
            <div className="pv-section-head">
              ATTRIBUTES
              <span className="pv-points" data-live={unspent > 0 ? 'true' : 'false'}>
                {unspent} point{unspent === 1 ? '' : 's'}
              </span>
            </div>
            {ATTRIBUTES.map((attribute) => (
              <div className="pv-attr" key={attribute.key} title={attribute.grants}>
                <span className="pv-attr-name">{attribute.label}</span>
                <span className="pv-attr-value">
                  {totals[attribute.key]}
                  {staged[attribute.key] > 0 ? (
                    <em className="pv-attr-staged">+{staged[attribute.key]}</em>
                  ) : null}
                  <i className="pv-attr-base">
                    {base[attribute.key]}+{preview[attribute.key]}
                  </i>
                </span>
                <span className="pv-attr-buttons">
                  <button
                    type="button"
                    onClick={() => {
                      stage(attribute.key, -1);
                    }}
                    disabled={staged[attribute.key] < 1}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      stage(attribute.key, 1);
                    }}
                    disabled={unspent < 1}
                  >
                    +
                  </button>
                </span>
              </div>
            ))}
            <div className="pv-actions">
              <button
                type="button"
                className="pv-button is-primary"
                disabled={stagedTotal < 1}
                onClick={() => {
                  bridge.allocateStats(staged);
                  setStaged(zeroAttributes());
                }}
              >
                CONFIRM {stagedTotal > 0 ? `(${stagedTotal})` : ''}
              </button>
              <button
                type="button"
                className="pv-button"
                disabled={stagedTotal < 1}
                onClick={() => {
                  setStaged(zeroAttributes());
                }}
              >
                RESET
              </button>
              <button
                type="button"
                className="pv-button"
                disabled={unspent < 3}
                title={`Suggested: ${suggestionText}`}
                onClick={stageSuggested}
              >
                SUGGESTED · {suggestionText}
              </button>
            </div>
          </div>
          <div className="pv-col">
            <div className="pv-section-head">DERIVED</div>
            {rows.map((row) => (
              <div className="pv-derived" key={row.label} title={row.formula}>
                <span>{row.label}</span>
                <b>{row.value}</b>
              </div>
            ))}
            <div className="pv-section-head">PURSE</div>
            <div className="pv-derived">
              <span>Gold</span>
              <b className="pv-gold">{(sheet?.gold ?? 0).toLocaleString('en-US')}</b>
            </div>
            <div className="pv-footer">
              {respecArmed ? (
                <button
                  type="button"
                  className="pv-button is-danger"
                  disabled={(sheet?.gold ?? 0) < respecPrice}
                  onClick={() => {
                    bridge.respec('stats');
                    setStaged(zeroAttributes());
                    setRespecArmed(false);
                  }}
                >
                  SURE? PAY {respecPrice} GOLD — REFUND ALL ATTRIBUTES
                </button>
              ) : (
                <button
                  type="button"
                  className="pv-button"
                  onClick={() => {
                    setRespecArmed(true);
                  }}
                >
                  RESPEC ATTRIBUTES · {respecPrice} g
                </button>
              )}
              <p className="pv-note">
                The Mirror of Dawn (Dawnhaven) will host respecs once placed — until then it works
                from anywhere.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
