/**
 * Character sheet (`C`, UI_UX.md §4): who you are and what you are wearing.
 *
 * Layout follows the owner's reference (2026-08-04): the name and level across
 * the top, two columns of equipment slots flanking the live rig, and the stat
 * block underneath — attributes on the left with their staging buttons,
 * derived numbers on the right. Gear used to live on the pack panel; it
 * belongs here, next to the character it is on.
 *
 * All math is shared-formula math. Worn gear folds through the SAME
 * `equipmentBonus` the server derives with, so what the sheet reads is what
 * the world runs — the sheet can't flatter you.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  aggregateNodeEffects,
  attributeTotals,
  baseWeaponDamage,
  equipmentBonus,
  respecCost,
  zeroAttributes,
  type AttributeSpread,
  type EquipSlot,
  type ItemDef,
} from '@dawned/shared';
import type { InventoryBridge, ProgressionBridge } from '../../game/run-world.js';
import { CharacterStage } from '../components/CharacterStage.js';
import { CLASS_BASE, derivedRows, suggestedAllocation } from './panel-format.js';
import { ItemTooltip, type HoverStack, type HoverTarget } from './ItemTooltip.js';

/**
 * A worn stack as both sides read it: the hover model the tooltip wants and
 * the shape `equipmentBonus` folds, so one map serves the doll and the stats
 * without a cast in between.
 */
type WornStack = HoverStack & { rolled?: Record<string, number> | null };

const ATTRIBUTES: { key: keyof AttributeSpread; label: string; grants: string }[] = [
  { key: 'str', label: 'Might', grants: 'STR · +1 AP (Warrior) · +0.5 Armor' },
  { key: 'agi', label: 'Agility', grants: 'AGI · +1 AP (Rogue) · +0.04% Crit' },
  { key: 'int', label: 'Wisdom', grants: 'INT · +1 SP · +10 Max Mana' },
  { key: 'vit', label: 'Vitality', grants: 'VIT · +12 Max HP' },
  { key: 'end', label: 'Endurance', grants: 'END · +5 Stamina · regen per 4' },
];

/**
 * Slot columns around the rig. Left is armour top-to-bottom, right is what you
 * hold and what you hang off yourself; the trinket sits under the stage
 * because it is the odd slot out (§2).
 */
const DOLL_LEFT: EquipSlot[] = ['head', 'chest', 'gloves', 'legs', 'boots'];
const DOLL_RIGHT: EquipSlot[] = ['mainhand', 'offhand', 'amulet', 'ring1', 'ring2'];
const DOLL_UNDER: EquipSlot[] = ['trinket'];

const SLOT_LABELS: Record<EquipSlot, string> = {
  head: 'Head',
  chest: 'Chest',
  gloves: 'Hands',
  legs: 'Legs',
  boots: 'Feet',
  mainhand: 'Main Hand',
  offhand: 'Off Hand',
  amulet: 'Amulet',
  ring1: 'Ring',
  ring2: 'Ring',
  trinket: 'Trinket',
};

export const CharacterPanel = (props: {
  bridge: ProgressionBridge;
  items: InventoryBridge;
  onClose: () => void;
}): React.JSX.Element => {
  const { bridge, items } = props;
  // The version counter is the stable snapshot; the sheet itself mutates in
  // place between syncs, so it can't be the useSyncExternalStore value.
  const version = useSyncExternalStore(bridge.subscribe, bridge.version);
  useSyncExternalStore(items.subscribe, items.version);
  const sheet = bridge.sheet();
  const [staged, setStaged] = useState<AttributeSpread>(zeroAttributes());
  const [respecArmed, setRespecArmed] = useState(false);
  const [hover, setHover] = useState<HoverTarget | null>(null);

  const identity = bridge.identity();
  const classId = bridge.classId();
  const level = bridge.level();
  const pack = items.pack();

  // --- worn gear ------------------------------------------------------------
  const equipment = new Map<EquipSlot, WornStack>(
    Object.entries(pack?.equipment ?? {}) as [EquipSlot, WornStack][],
  );
  const itemsVersion = items.version();
  const gear = useMemo(
    () =>
      equipmentBonus(
        equipment,
        new Map<string, ItemDef>(
          [...equipment.values()]
            .map((stack) => items.itemDef(stack.itemId))
            .filter((def): def is ItemDef => def !== undefined)
            .map((def) => [def.id, def]),
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the version counter is the change signal
    [itemsVersion, items],
  );

  // --- attributes -----------------------------------------------------------
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

  // Derived rows preview the STAGED allocation against the live node folds AND
  // the worn set — gear attributes go in before the derivation, exactly as the
  // server folds them (progression.ts rebuildPlayerDerived).
  const aggregates = useMemo(
    () => aggregateNodeEffects(bridge.nodeDefs(), bridge.ranks()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the change signal for ranks/defs
    [version, bridge],
  );
  const withGear: AttributeSpread = {
    str: preview.str + (gear.stats.str ?? 0),
    agi: preview.agi + (gear.stats.agi ?? 0),
    int: preview.int + (gear.stats.int ?? 0),
    vit: preview.vit + (gear.stats.vit ?? 0),
    end: preview.end + (gear.stats.end ?? 0),
  };
  const rows = derivedRows(classId, level, withGear, aggregates, gear);

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

  const slotButton = (slot: EquipSlot): React.JSX.Element => {
    const stack = equipment.get(slot);
    const def = stack ? items.itemDef(stack.itemId) : undefined;
    const url = def ? items.iconUrl(def.icon) : undefined;
    return (
      <button
        key={slot}
        type="button"
        className="cs-slot"
        data-rarity={def?.rarity ?? 'none'}
        data-filled={stack ? 'true' : 'false'}
        title={`${SLOT_LABELS[slot]}${stack ? ' — right-click to take off' : ''}`}
        onMouseOver={(event) => {
          if (!stack || !def) return;
          setHover({ def, stack, compare: null, x: event.clientX, y: event.clientY });
        }}
        onMouseLeave={() => {
          setHover(null);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (stack) items.send({ kind: 'unequip', slot });
          setHover(null);
        }}
      >
        {url ? (
          <span
            className="cs-slot-icon"
            style={{ '--icon': `url('${url}')` } as React.CSSProperties}
          />
        ) : (
          <span className="cs-slot-label">{SLOT_LABELS[slot]}</span>
        )}
      </button>
    );
  };

  const weapon = gear.weapon ?? baseWeaponDamage(level);

  return (
    <div className="pv-scrim" data-panel="character">
      <section className="pv-panel is-wide cs-panel">
        <header className="pv-title">
          <span>
            {identity.name.toUpperCase()} — LEVEL {level}
          </span>
          <span className="pv-title-meta">
            {classId.toUpperCase()}
            {unspent > 0 ? <b className="cs-points">{unspent} points</b> : null}
          </span>
          <button className="pv-close" onClick={props.onClose} type="button" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="pv-body cs-body">
          {/* --- doll: slots | rig | slots ------------------------------- */}
          <div className="cs-doll">
            <div className="cs-slot-col">{DOLL_LEFT.map(slotButton)}</div>
            <div className="cs-stage">
              <CharacterStage
                appearance={identity.appearance}
                classId={classId}
                mainhandModel={identity.mainhandModel}
                offhandModel={identity.offhandModel}
              />
              <div className="cs-stage-under">{DOLL_UNDER.map(slotButton)}</div>
            </div>
            <div className="cs-slot-col">{DOLL_RIGHT.map(slotButton)}</div>
          </div>

          {/* --- stats ---------------------------------------------------- */}
          <div className="cs-stats">
            <div className="cs-stat-col">
              <div className="pv-section-head">ATTRIBUTES</div>
              {ATTRIBUTES.map((attribute) => {
                const fromGear = gear.stats[attribute.key] ?? 0;
                return (
                  <div className="cs-stat" key={attribute.key} title={attribute.grants}>
                    <span className="cs-stat-name">{attribute.label}</span>
                    <span className="cs-stat-value">
                      {totals[attribute.key] + fromGear}
                      {fromGear > 0 ? <em className="cs-stat-gear">(+{fromGear})</em> : null}
                      {staged[attribute.key] > 0 ? (
                        <em className="cs-stat-staged">+{staged[attribute.key]}</em>
                      ) : null}
                      <i className="cs-stat-base">
                        {base[attribute.key]}+{preview[attribute.key]}
                      </i>
                    </span>
                    <span className="cs-stat-buttons">
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
                );
              })}
            </div>

            <div className="cs-stat-col">
              <div className="pv-section-head">DERIVED</div>
              {rows.map((row) => (
                <div className="cs-derived" key={row.label} title={row.formula}>
                  <span>{row.label}</span>
                  <b>{row.value}</b>
                </div>
              ))}
              <div className="cs-derived" title="main hand damage band (unarmed without a weapon)">
                <span>Weapon</span>
                <b>
                  {weapon.min}–{weapon.max}
                </b>
              </div>
              <div className="cs-derived" title="what the purse holds">
                <span>Gold</span>
                <b className="pv-gold">{(sheet?.gold ?? 0).toLocaleString('en-US')}</b>
              </div>
            </div>
          </div>

          {/* --- actions --------------------------------------------------- */}
          <div className="cs-actions">
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
                SURE? PAY {respecPrice} GOLD — REFUND ALL
              </button>
            ) : (
              <button
                type="button"
                className="pv-button"
                onClick={() => {
                  setRespecArmed(true);
                }}
              >
                RESPEC · {respecPrice} g
              </button>
            )}
            <span className="cs-hint">right-click a slot to take it off · I opens the pack</span>
          </div>
        </div>
      </section>

      {hover ? <ItemTooltip hover={hover} /> : null}
    </div>
  );
};
