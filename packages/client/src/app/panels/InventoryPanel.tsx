/**
 * The pack (`I`, ITEMS_LOOT.md §3 + UI_UX.md §4): 48 cells, the purse, search
 * and sort. Worn gear lives on the CHARACTER sheet (`C`) — the bag is what you
 * are carrying, the sheet is what you are wearing.
 *
 * There is no local inventory state. A drag sends one `move`, a right-click
 * sends one `equip`/`use`, and the answer is always the server's next
 * InventorySync — which is also what heals a refused drag. That is the whole
 * anti-dupe story on this side of the wire: the client never decides.
 */

import { useState, useSyncExternalStore } from 'react';
import { equipSlotsFor, isEquippable, type ItemDef } from '@dawned/shared';
import type { InventoryBridge } from '../../game/run-world.js';
import { rarityColor } from './item-format.js';
import { ItemTooltip, type HoverStack, type HoverTarget } from './ItemTooltip.js';

const BAG_CELLS = 48;
/** 8 across — 48 cells in six rows, the shape the design specs (§3). */
const BAG_COLUMNS = 8;

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

  const bag = new Map<number, HoverStack>(pack?.bag ?? []);
  const equipment = new Map<string, HoverStack>(Object.entries(pack?.equipment ?? {}));

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

  const showTooltip = (event: React.MouseEvent, stack: HoverStack): void => {
    const def = bridge.itemDef(stack.itemId);
    if (!def) return;
    setHover({
      def,
      stack,
      compare: equippedRival(def) ?? null,
      x: event.clientX,
      y: event.clientY,
    });
  };

  const matchesFilter = (stack: HoverStack | undefined): boolean => {
    if (!stack || filter === '') return filter === '';
    const def = bridge.itemDef(stack.itemId);
    return (def?.name ?? stack.itemId).toLowerCase().includes(filter.toLowerCase());
  };

  return (
    <div className="pv-scrim" data-panel="inventory">
      <section className="pv-panel">
        <header className="pv-title">
          <span>PACK</span>
          <span className="pv-title-meta">
            <b>{pack?.gold ?? 0}</b> gold
          </span>
          <button className="pv-close" onClick={onClose} type="button" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="pv-body inv-body">
          <div className="pv-section-head">
            CARRIED
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
          <div className="inv-grid" style={{ '--bag-cols': BAG_COLUMNS } as React.CSSProperties}>
            {Array.from({ length: BAG_CELLS }, (_, cell) => {
              const stack = bag.get(cell);
              const def = stack ? bridge.itemDef(stack.itemId) : undefined;
              const url = def ? bridge.iconUrl(def.icon) : undefined;
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
                  onMouseOver={(event) => {
                    if (stack) showTooltip(event, stack);
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
                  {stack ? (
                    <>
                      {url ? (
                        <span
                          className="inv-cell-icon"
                          style={{ '--icon': `url('${url}')` } as React.CSSProperties}
                        />
                      ) : (
                        <span className="inv-cell-mono">
                          {(def?.name ?? stack.itemId).slice(0, 2)}
                        </span>
                      )}
                      {stack.qty > 1 ? <em className="inv-cell-qty">{stack.qty}</em> : null}
                      {matchesFilter(stack) ? null : <span className="inv-cell-dim" />}
                    </>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="inv-bag-hint">
            drag to move · shift-drag to split · right-click to equip or drink · E drinks the first
            draught · C opens the character sheet for worn gear
          </div>
        </div>
      </section>

      {hover ? <ItemTooltip hover={hover} /> : null}
    </div>
  );
};
