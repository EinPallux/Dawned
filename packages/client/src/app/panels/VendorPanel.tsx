/**
 * Vendor panel (ITEMS_LOOT.md §6): buy, sell and buy back, opened by the `F`
 * prompt at a market post and closed by the server the moment you walk away.
 *
 * Every price here came down the wire already computed — the panel never
 * multiplies anything itself, so what you read is what the server charges.
 */

import { useState, useSyncExternalStore } from 'react';
import { sellPriceFor } from '@dawned/shared';
import type { InventoryBridge } from '../../game/run-world.js';
import { rarityColor, typeLine } from './item-format.js';

type Tab = 'buy' | 'sell' | 'buyback';

export const VendorPanel = ({
  bridge,
  onClose,
}: {
  bridge: InventoryBridge;
  onClose: () => void;
}): React.JSX.Element | null => {
  useSyncExternalStore(bridge.subscribe, bridge.version);
  const vendor = bridge.vendor();
  const pack = bridge.pack();
  const [tab, setTab] = useState<Tab>('buy');
  if (!vendor) return null;

  const gold = pack?.gold ?? 0;
  const close = (): void => {
    bridge.send({ kind: 'vendorClose' });
    onClose();
  };

  const rows: React.JSX.Element[] = [];
  if (tab === 'buy') {
    for (const entry of vendor.stock) {
      const def = bridge.itemDef(entry.itemId);
      rows.push(
        <div className="vd-row" key={entry.itemId}>
          <IconCell bridge={bridge} itemId={entry.itemId} />
          <span className="vd-name" style={{ color: def ? rarityColor(def.rarity) : undefined }}>
            {def?.name ?? entry.itemId}
            <em>{def ? typeLine(def) : ''}</em>
          </span>
          <span className="vd-price">{entry.price} g</span>
          <button
            type="button"
            className="pv-btn"
            disabled={gold < entry.price}
            onClick={() => {
              bridge.send({
                kind: 'vendorBuy',
                vendorId: vendor.vendorId,
                itemId: entry.itemId,
                qty: 1,
              });
            }}
          >
            buy
          </button>
        </div>,
      );
    }
  } else if (tab === 'sell') {
    for (const [cell, stack] of pack?.bag ?? []) {
      const def = bridge.itemDef(stack.itemId);
      const unit = def ? sellPriceFor(def.value, vendor.sellMult) : 0;
      rows.push(
        <div className="vd-row" key={cell}>
          <IconCell bridge={bridge} itemId={stack.itemId} />
          <span className="vd-name" style={{ color: def ? rarityColor(def.rarity) : undefined }}>
            {def?.name ?? stack.itemId}
            {stack.qty > 1 ? ` ×${stack.qty}` : ''}
            <em>{def ? typeLine(def) : ''}</em>
          </span>
          <span className="vd-price">{unit * stack.qty} g</span>
          <button
            type="button"
            className="pv-btn"
            disabled={!def || def.bound || unit <= 0}
            onClick={() => {
              bridge.send({
                kind: 'vendorSell',
                vendorId: vendor.vendorId,
                from: cell,
                qty: stack.qty,
              });
            }}
          >
            sell
          </button>
        </div>,
      );
    }
  } else {
    for (const entry of vendor.buyback) {
      const def = bridge.itemDef(entry.itemId);
      rows.push(
        <div className="vd-row" key={entry.index}>
          <IconCell bridge={bridge} itemId={entry.itemId} />
          <span className="vd-name" style={{ color: def ? rarityColor(def.rarity) : undefined }}>
            {def?.name ?? entry.itemId}
            {entry.qty > 1 ? ` ×${entry.qty}` : ''}
          </span>
          <span className="vd-price">{entry.price} g</span>
          <button
            type="button"
            className="pv-btn"
            disabled={gold < entry.price}
            onClick={() => {
              bridge.send({
                kind: 'vendorBuyback',
                vendorId: vendor.vendorId,
                index: entry.index,
              });
            }}
          >
            buy back
          </button>
        </div>,
      );
    }
  }

  return (
    <div className="pv-scrim" data-panel="vendor">
      <section className="pv-panel">
        <header className="pv-title">
          <span>{vendor.name.toUpperCase()}</span>
          <span className="pv-title-meta">
            <b>{gold}</b> gold
          </span>
          <button className="pv-close" onClick={close} type="button" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="pv-body vd-body">
          {vendor.greeting ? <p className="vd-greeting">“{vendor.greeting}”</p> : null}
          <div className="vd-tabs">
            {(['buy', 'sell', 'buyback'] as Tab[]).map((entry) => (
              <button
                key={entry}
                type="button"
                className={`pv-btn${tab === entry ? ' is-active' : ''}`}
                onClick={() => {
                  setTab(entry);
                }}
              >
                {entry}
              </button>
            ))}
            <span className="vd-rate">pays {Math.round(vendor.sellMult * 100)}% of value</span>
          </div>
          <div className="vd-rows">
            {rows.length > 0 ? (
              rows
            ) : (
              <p className="vd-empty">
                {tab === 'buy'
                  ? 'This one only buys.'
                  : tab === 'sell'
                    ? 'Your pack is empty.'
                    : 'Nothing sold yet this session.'}
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};

const IconCell = ({
  bridge,
  itemId,
}: {
  bridge: InventoryBridge;
  itemId: string;
}): React.JSX.Element => {
  const def = bridge.itemDef(itemId);
  const url = def ? bridge.iconUrl(def.icon) : undefined;
  return (
    <span className="inv-cell inv-cell--tiny" data-rarity={def?.rarity ?? 'none'}>
      {url ? (
        <span
          className="inv-cell-icon"
          style={{ '--icon': `url('${url}')` } as React.CSSProperties}
        />
      ) : (
        <span className="inv-cell-mono">{(def?.name ?? itemId).slice(0, 2)}</span>
      )}
    </span>
  );
};
