/**
 * Inventory (`I`, ITEMS_LOOT.md §3 + UI_UX.md §4): the 48-cell pack, the
 * paper-doll around it, the purse, and a tooltip that compares what you are
 * hovering against what you are wearing.
 *
 * There is no local inventory state. A drag sends one `move`, a right-click
 * sends one `equip`/`use`, and the answer is always the server's next
 * InventorySync — which is also what heals a refused drag. That is the whole
 * anti-dupe story on this side of the wire: the client never decides.
 */

import { useState, useSyncExternalStore } from 'react';
import {
  EQUIP_SLOTS,
  equipSlotsFor,
  isEquippable,
  type EquipSlot,
  type ItemDef,
} from '@dawned/shared';
import type { InventoryBridge } from '../../game/run-world.js';
import {
  consumableText,
  damageLine,
  effectText,
  rarityColor,
  rollCount,
  sellLine,
  statLines,
  typeLine,
} from './item-format.js';

const BAG_CELLS = 48;

/** Paper-doll layout: two columns of slots flanking the character (§3). */
const DOLL_LEFT: EquipSlot[] = ['head', 'chest', 'legs', 'boots', 'gloves'];
const DOLL_RIGHT: EquipSlot[] = ['mainhand', 'offhand', 'ring1', 'ring2', 'amulet'];

interface Stack {
  itemId: string;
  qty: number;
  rolled?: Record<string, number> | null;
}

interface HoverTarget {
  def: ItemDef;
  stack: Stack;
  /** The equipped piece this would replace, for the compare column. */
  compare: { def: ItemDef; rolled: Record<string, number> | null } | null;
  x: number;
  y: number;
}

export const InventoryPanel = ({
  bridge,
  onClose,
}: {
  bridge: InventoryBridge;
  onClose: () => void;
}): React.JSX.Element => {
  useSyncExternalStore(bridge.subscribe, bridge.version);
  const pack = bridge.pack();
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [filter, setFilter] = useState('');

  const bag = new Map<number, Stack>(pack?.bag ?? []);
  const equipment = new Map<string, Stack>(Object.entries(pack?.equipment ?? {}));

  /** What a hovered item would replace: its own slot, or the emptier ring. */
  const equippedRival = (
    def: ItemDef,
  ): { def: ItemDef; rolled: Record<string, number> | null } | null => {
    if (!isEquippable(def)) return null;
    for (const slot of equipSlotsFor(def)) {
      const worn = equipment.get(slot);
      if (worn) {
        const wornDef = bridge.itemDef(worn.itemId);
        if (wornDef) return { def: wornDef, rolled: worn.rolled ?? null };
      }
    }
    return null;
  };

  const showTooltip = (
    event: React.MouseEvent,
    stack: Stack,
    options: { compare?: boolean } = {},
  ): void => {
    const def = bridge.itemDef(stack.itemId);
    if (!def) return;
    setHover({
      def,
      stack,
      compare: options.compare ? (equippedRival(def) ?? null) : null,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const cellContent = (stack: Stack | undefined, muted: boolean): React.JSX.Element | null => {
    if (!stack) return null;
    const def = bridge.itemDef(stack.itemId);
    const url = def ? bridge.iconUrl(def.icon) : undefined;
    return (
      <>
        {url ? (
          <span
            className="inv-cell-icon"
            style={{ '--icon': `url('${url}')` } as React.CSSProperties}
          />
        ) : (
          <span className="inv-cell-mono">{(def?.name ?? stack.itemId).slice(0, 2)}</span>
        )}
        {stack.qty > 1 ? <em className="inv-cell-qty">{stack.qty}</em> : null}
        {muted ? <span className="inv-cell-dim" /> : null}
      </>
    );
  };

  const matchesFilter = (stack: Stack | undefined): boolean => {
    if (!stack || filter === '') return filter === '';
    const def = bridge.itemDef(stack.itemId);
    return (def?.name ?? stack.itemId).toLowerCase().includes(filter.toLowerCase());
  };

  return (
    <div className="pv-scrim" data-panel="inventory">
      <section className="pv-panel is-wide">
        <header className="pv-title">
          <span>INVENTORY</span>
          <span className="pv-title-meta">
            <b>{pack?.gold ?? 0}</b> gold
          </span>
          <button className="pv-close" onClick={onClose} type="button" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="pv-body inv-body">
          <div className="inv-doll">
            <div className="pv-section-head">EQUIPPED</div>
            <div className="inv-doll-grid">
              {[DOLL_LEFT, DOLL_RIGHT].map((column, index) => (
                <div className="inv-doll-col" key={index}>
                  {column.map((slot) => {
                    const stack = equipment.get(slot);
                    return (
                      <button
                        key={slot}
                        type="button"
                        className="inv-cell inv-cell--equip"
                        data-slot={slot}
                        title={slot}
                        onMouseEnter={(event) => {
                          if (stack) showTooltip(event, stack);
                        }}
                        onMouseLeave={() => {
                          setHover(null);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          if (stack) bridge.send({ kind: 'unequip', slot });
                          setHover(null);
                        }}
                      >
                        {cellContent(stack, false) ?? <span className="inv-cell-slot">{slot}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="inv-doll-hint">right-click a slot to take it off</div>
            {/* Trinket sits under the doll: it is the odd slot out (§2). */}
            <div className="inv-doll-trinket">
              {(['trinket'] as EquipSlot[]).map((slot) => {
                const stack = equipment.get(slot);
                return (
                  <button
                    key={slot}
                    type="button"
                    className="inv-cell inv-cell--equip"
                    title={slot}
                    onMouseEnter={(event) => {
                      if (stack) showTooltip(event, stack);
                    }}
                    onMouseLeave={() => {
                      setHover(null);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (stack) bridge.send({ kind: 'unequip', slot });
                      setHover(null);
                    }}
                  >
                    {cellContent(stack, false) ?? <span className="inv-cell-slot">{slot}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="inv-bag">
            <div className="pv-section-head">
              PACK
              <span className="inv-bag-tools">
                <input
                  className="inv-filter"
                  placeholder="search…"
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value);
                  }}
                />
                <button
                  type="button"
                  className="pv-btn"
                  onClick={() => {
                    bridge.send({ kind: 'sort' });
                  }}
                >
                  sort
                </button>
              </span>
            </div>
            <div className="inv-grid">
              {Array.from({ length: BAG_CELLS }, (_, cell) => {
                const stack = bag.get(cell);
                const def = stack ? bridge.itemDef(stack.itemId) : undefined;
                return (
                  <button
                    key={cell}
                    type="button"
                    className="inv-cell"
                    data-rarity={def?.rarity ?? 'none'}
                    data-junk={def?.category === 'junk' ? 'true' : 'false'}
                    style={def ? { borderColor: rarityColor(def.rarity) } : undefined}
                    draggable={stack !== undefined}
                    onDragStart={() => {
                      setDragFrom(cell);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragFrom !== null && dragFrom !== cell) {
                        // Shift splits the stack in half instead of moving it.
                        if (event.shiftKey && stack === undefined) {
                          const source = bag.get(dragFrom);
                          const half = Math.floor((source?.qty ?? 1) / 2);
                          if (half > 0) {
                            bridge.send({ kind: 'split', from: dragFrom, to: cell, qty: half });
                          }
                        } else {
                          bridge.send({ kind: 'move', from: dragFrom, to: cell });
                        }
                      }
                      setDragFrom(null);
                    }}
                    onMouseEnter={(event) => {
                      if (stack) showTooltip(event, stack, { compare: true });
                    }}
                    onMouseLeave={() => {
                      setHover(null);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (!stack || !def) return;
                      if (def.consumable) bridge.send({ kind: 'use', from: cell });
                      else if (isEquippable(def)) bridge.send({ kind: 'equip', from: cell });
                      setHover(null);
                    }}
                  >
                    {cellContent(stack, !matchesFilter(stack))}
                  </button>
                );
              })}
            </div>
            <div className="inv-bag-hint">
              drag to move · shift-drag to split · right-click to equip or drink · E drinks the
              first draught
            </div>
          </div>
        </div>
      </section>

      {hover ? <ItemTooltip hover={hover} /> : null}
    </div>
  );
};

/** The tooltip itself: fixed-position so no panel clip-path can cut it off. */
const ItemTooltip = ({ hover }: { hover: HoverTarget }): React.JSX.Element => {
  const { def, stack, compare } = hover;
  const lines = statLines(def, stack.rolled, compare);
  const rolls = rollCount(def);
  const flipX = hover.x > window.innerWidth - 320;
  return (
    <div
      className="inv-tip"
      style={{
        left: flipX ? undefined : hover.x + 18,
        right: flipX ? window.innerWidth - hover.x + 18 : undefined,
        top: Math.min(hover.y, window.innerHeight - 260),
      }}
    >
      <div className="inv-tip-name" style={{ color: rarityColor(def.rarity) }}>
        {def.name}
      </div>
      <div className="inv-tip-type">{typeLine(def)}</div>
      {damageLine(def) ? <div className="inv-tip-damage">{damageLine(def)}</div> : null}
      {lines.map((line) => (
        <div className="inv-tip-stat" key={line.key}>
          <span>
            +{line.value} {line.label}
          </span>
          {line.delta !== null && line.delta !== 0 ? (
            <em data-sign={line.delta > 0 ? 'up' : 'down'}>
              {line.delta > 0 ? '+' : ''}
              {line.delta}
            </em>
          ) : null}
        </div>
      ))}
      {effectText(def) ? <div className="inv-tip-effect">{effectText(def)}</div> : null}
      {consumableText(def) ? <div className="inv-tip-effect">{consumableText(def)}</div> : null}
      {def.requiresLevel > 1 ? (
        <div className="inv-tip-req">Requires level {def.requiresLevel}</div>
      ) : null}
      {def.classLock.length > 0 ? (
        <div className="inv-tip-req">{def.classLock.join(', ')} only</div>
      ) : null}
      {def.flavor ? <div className="inv-tip-flavor">{def.flavor}</div> : null}
      <div className="inv-tip-sell">{sellLine(def)}</div>
      {rolls > 0 ? (
        <div className="inv-tip-rolls">
          Dropped copies roll {rolls} extra attribute{rolls === 1 ? '' : 's'}
        </div>
      ) : null}
      {compare ? (
        <div className="inv-tip-compare">compared with your {compare.def.name}</div>
      ) : null}
    </div>
  );
};

/** Slot order for the doll, exported so tests can assert coverage. */
export const DOLL_SLOTS = EQUIP_SLOTS;
