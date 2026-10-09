/**
 * Escanor — Active Trades & Pending Orders Chart Engine
 * 
 * Natively renders active MT5 open positions (Entry, Draggable SL, Draggable TP)
 * and pending orders on KLineCharts v10 Canvas.
 * 
 * Features:
 * - Live dollar ($) and point calculations for SL and TP: abs(price - entry) * volume * 100
 * - Click-and-drag adjustment of SL and TP lines
 * - Immediate MT5 order modification on drag release (/api/trade/modify)
 * - Real-time display of pending orders (BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP)
 * - Zero browser alert/confirm popups (uses in-app toasts)
 */

import { showChartToast } from './drawings_storage.js';

export class ActiveOrdersEngine {
  constructor({ chartEngine, symbol = 'XAUUSD' }) {
    this.engine = chartEngine;
    this.chart = (chartEngine && chartEngine.chart) ? chartEngine.chart : chartEngine;
    this.symbol = symbol;
    this.activePositions = [];
    this.pendingOrders = [];
    this.positionOverlays = new Map(); // key -> overlayId
    this.draggingKey = null;
    this.pendingModifications = new Map(); // key -> { price, time }
    this.lastBid = null;
    this.lastAsk = null;
    this._dragTimeout = null;
  }

  updateData({ positions = [], orders = [], bid = null, ask = null }) {
    this.activePositions = Array.isArray(positions) ? positions : [];
    this.pendingOrders = Array.isArray(orders) ? orders : [];
    if (bid && !isNaN(bid)) this.lastBid = Number(bid);
    if (ask && !isNaN(ask)) this.lastAsk = Number(ask);
    this.render();
  }

  render() {
    if (!this.chart) return;

    const activeTickets = new Set(this.activePositions.map(p => Number(p.ticket)));
    const pendingTickets = new Set(this.pendingOrders.map(o => Number(o.ticket)));

    // Clean up stale pending modifications older than 3.5 seconds
    const now = Date.now();
    for (const [key, mod] of this.pendingModifications.entries()) {
      if (now - mod.time > 3500) {
        this.pendingModifications.delete(key);
      }
    }

    // 1. Remove overlays for positions or orders that are no longer active
    for (const [key, ovId] of this.positionOverlays.entries()) {
      // Never remove an overlay while user is actively dragging it!
      if (this.draggingKey === key || window.__currentDraggingOrderKey === key) continue;

      const parts = key.split('_');
      const prefix = parts[0]; // 'pos' or 'ord'
      const ticket = parseInt(parts[1], 10);

      if (prefix === 'pos' && !activeTickets.has(ticket)) {
        try { this.chart.removeOverlay(ovId); } catch (_) {}
        this.positionOverlays.delete(key);
        this.pendingModifications.delete(key);
      } else if (prefix === 'ord' && !pendingTickets.has(ticket)) {
        try { this.chart.removeOverlay(ovId); } catch (_) {}
        this.positionOverlays.delete(key);
        this.pendingModifications.delete(key);
      }
    }

    // 2. Render Active Positions
    for (const pos of this.activePositions) {
      const ticket = Number(pos.ticket);
      const isBuy = pos.type === 'BUY' || pos.type === 0 || String(pos.type).toUpperCase().includes('BUY');
      const openPrice = Number(pos.price_open !== undefined ? pos.price_open : pos.price);
      if (!openPrice || isNaN(openPrice) || openPrice <= 0) continue;

      const volume = Number(pos.volume || 0.50);
      const profitPts = pos.profit_pts !== undefined ? Number(pos.profit_pts) : 0;
      const profitDollar = (profitPts * volume * 100);
      const sign = profitPts >= 0 ? '+' : '';
      const pnlText = `${sign}$${profitDollar.toFixed(2)} (${sign}${profitPts.toFixed(1)} pt)`;

      // Entry line (Locked)
      const entryKey = `pos_${ticket}_entry`;
      const entryTitle = `#${ticket} ${isBuy ? 'BUY' : 'SELL'} ${volume}L @ $${openPrice.toFixed(2)} [${pnlText}]`;
      this._syncOrderLine(entryKey, {
        points: [{ value: openPrice }],
        lock: true,
        extendData: {
          key: entryKey,
          ticket,
          isBuy,
          openPrice,
          volume,
          orderType: 'ENTRY',
          title: entryTitle
        }
      });

      // Stop Loss (SL) Line — DRAGGABLE!
      let rawSlPrice = Number(pos.sl || 0);
      const slKey = `pos_${ticket}_sl`;
      const isDraggingSl = (this.draggingKey === slKey || window.__currentDraggingOrderKey === slKey);

      // Protect against post-drag tick flicker while awaiting MT5 server reflection
      const pendingSlMod = this.pendingModifications.get(slKey);
      if (pendingSlMod) {
        if (Math.abs(rawSlPrice - pendingSlMod.price) < 0.01) {
          this.pendingModifications.delete(slKey);
        } else {
          rawSlPrice = pendingSlMod.price;
        }
      }

      if (rawSlPrice > 0 || isDraggingSl) {
        // While actively being dragged by cursor/finger, do NOT overwrite points from tick update!
        if (!isDraggingSl) {
          const slPrice = rawSlPrice;
          const slDist = Math.abs(openPrice - slPrice);
          const slDollar = (slDist * volume * 100);
          const isFavorable = isBuy ? (slPrice >= openPrice) : (slPrice <= openPrice);
          const slSign = isFavorable ? '+' : '-';
          const slTitle = `SL: $${slPrice.toFixed(2)} [${slSign}$${slDollar.toFixed(2)} / ${slSign}${slDist.toFixed(1)} pt] ⇅`;

          this._syncOrderLine(slKey, {
            points: [{ value: slPrice }],
            lock: false,
            extendData: {
              key: slKey,
              ticket,
              isBuy,
              openPrice,
              volume,
              orderType: 'SL',
              title: slTitle
            },
            onPressedMoveStart: (e) => {
              this._startDrag(slKey);
            },
            onPressedMoveEnd: (e) => {
              this._endDrag();
              const ov = e.overlay;
              const newPrice = ov?.points[0]?.value;
              if (newPrice && newPrice > 0) {
                this.pendingModifications.set(slKey, { price: newPrice, time: Date.now() });
                this._onOrderDragged(ticket, 'SL', newPrice, isBuy, openPrice, volume, pos.tp, slKey, pos.sl);
              }
            }
          });
        }
      } else {
        this._removeOrderLine(slKey);
      }

      // Take Profit (TP) Line — DRAGGABLE!
      let rawTpPrice = Number(pos.tp || 0);
      const tpKey = `pos_${ticket}_tp`;
      const isDraggingTp = (this.draggingKey === tpKey || window.__currentDraggingOrderKey === tpKey);

      // Protect against post-drag tick flicker while awaiting MT5 server reflection
      const pendingTpMod = this.pendingModifications.get(tpKey);
      if (pendingTpMod) {
        if (Math.abs(rawTpPrice - pendingTpMod.price) < 0.01) {
          this.pendingModifications.delete(tpKey);
        } else {
          rawTpPrice = pendingTpMod.price;
        }
      }

      if (rawTpPrice > 0 || isDraggingTp) {
        // While actively being dragged by cursor/finger, do NOT overwrite points from tick update!
        if (!isDraggingTp) {
          const tpPrice = rawTpPrice;
          const tpDist = Math.abs(tpPrice - openPrice);
          const tpDollar = (tpDist * volume * 100);
          const isFavorable = isBuy ? (tpPrice >= openPrice) : (tpPrice <= openPrice);
          const tpSign = isFavorable ? '+' : '-';
          const tpTitle = `TP: $${tpPrice.toFixed(2)} [${tpSign}$${tpDollar.toFixed(2)} / ${tpSign}${tpDist.toFixed(1)} pt] ⇅`;

          this._syncOrderLine(tpKey, {
            points: [{ value: tpPrice }],
            lock: false,
            extendData: {
              key: tpKey,
              ticket,
              isBuy,
              openPrice,
              volume,
              orderType: 'TP',
              title: tpTitle
            },
            onPressedMoveStart: (e) => {
              this._startDrag(tpKey);
            },
            onPressedMoveEnd: (e) => {
              this._endDrag();
              const ov = e.overlay;
              const newPrice = ov?.points[0]?.value;
              if (newPrice && newPrice > 0) {
                this.pendingModifications.set(tpKey, { price: newPrice, time: Date.now() });
                this._onOrderDragged(ticket, 'TP', newPrice, isBuy, openPrice, volume, pos.sl, tpKey, pos.tp);
              }
            }
          });
        }
      } else {
        this._removeOrderLine(tpKey);
      }
    }

    // 3. Render Pending Orders (LIMIT & STOP)
    for (const ord of this.pendingOrders) {
      const ticket = Number(ord.ticket);
      const openPrice = Number(ord.price_open || ord.price);
      if (!openPrice || isNaN(openPrice) || openPrice <= 0) continue;

      const orderType = String(ord.type || 'LIMIT').toUpperCase();
      const volume = Number(ord.volume || 0.50);
      const sl = ord.sl ? Number(ord.sl).toFixed(2) : '--';
      const tp = ord.tp ? Number(ord.tp).toFixed(2) : '--';

      const ordKey = `ord_${ticket}_line`;
      const ordTitle = `#${ticket} ${orderType} ${volume}L @ $${openPrice.toFixed(2)} [SL: ${sl} / TP: ${tp}]`;

      this._syncOrderLine(ordKey, {
        points: [{ value: openPrice }],
        lock: true,
        extendData: {
          key: ordKey,
          ticket,
          isPending: true,
          orderType: orderType,
          title: ordTitle
        }
      });
    }
  }

  _startDrag(key) {
    this.draggingKey = key;
    window.__currentDraggingOrderKey = key;
    if (this._dragTimeout) clearTimeout(this._dragTimeout);
    // Safety fallback: if drag end never arrives (e.g. mouse left screen), release after 10s
    this._dragTimeout = setTimeout(() => {
      this._endDrag();
    }, 10000);
  }

  _endDrag() {
    this.draggingKey = null;
    window.__currentDraggingOrderKey = null;
    if (this._dragTimeout) {
      clearTimeout(this._dragTimeout);
      this._dragTimeout = null;
    }
  }

  _syncOrderLine(key, options) {
    if (!this.chart) return;

    let ovId = this.positionOverlays.get(key);
    if (ovId) {
      try {
        this.chart.overrideOverlay(Object.assign({ id: ovId, name: 'activeTradeOrder' }, options));
        return;
      } catch (_) {
        try { this.chart.removeOverlay(ovId); } catch (e) {}
        this.positionOverlays.delete(key);
      }
    }

    try {
      const createdId = this.chart.createOverlay(Object.assign({ name: 'activeTradeOrder' }, options));
      if (createdId) {
        this.positionOverlays.set(key, createdId);
      }
    } catch (err) {
      console.warn(`[ActiveOrdersEngine] Error creating overlay ${key}:`, err);
    }
  }

  _removeOrderLine(key) {
    const ovId = this.positionOverlays.get(key);
    if (ovId && this.chart) {
      try { this.chart.removeOverlay(ovId); } catch (_) {}
      this.positionOverlays.delete(key);
    }
  }

  async _onOrderDragged(ticket, type, newPrice, isBuy, openPrice, volume, existingOtherPrice, key, currentPrice) {
    const finalPrice = Math.round(Number(newPrice) * 100) / 100;
    const isSl = type === 'SL';
    const bid = this.lastBid;
    const ask = this.lastAsk;

    // Check if the price didn't actually change (e.g. user just clicked without dragging)
    if (currentPrice && Math.abs(finalPrice - Number(currentPrice)) < 0.02) {
      if (key) this.pendingModifications.delete(key);
      return;
    }

    // Pre-flight validation against live market price to prevent invalid stop placement
    if (isBuy) {
      if (isSl && bid && finalPrice >= bid) {
        if (key) this.pendingModifications.delete(key);
        showChartToast(`⚠️ Invalid SL: For BUY #${ticket}, Stop Loss must be below current market price ($${bid.toFixed(2)})`);
        this.render();
        return;
      }
      if (!isSl && ask && finalPrice <= ask) {
        if (key) this.pendingModifications.delete(key);
        showChartToast(`⚠️ Invalid TP: For BUY #${ticket}, Take Profit must be above current market price ($${ask.toFixed(2)})`);
        this.render();
        return;
      }
    } else {
      if (isSl && ask && finalPrice <= ask) {
        if (key) this.pendingModifications.delete(key);
        showChartToast(`⚠️ Invalid SL: For SELL #${ticket}, Stop Loss must be above current market price ($${ask.toFixed(2)})`);
        this.render();
        return;
      }
      if (!isSl && bid && finalPrice >= bid) {
        if (key) this.pendingModifications.delete(key);
        showChartToast(`⚠️ Invalid TP: For SELL #${ticket}, Take Profit must be below current market price ($${bid.toFixed(2)})`);
        this.render();
        return;
      }
    }

    const newSl = isSl ? finalPrice : (existingOtherPrice ? Number(existingOtherPrice) : null);
    const newTp = !isSl ? finalPrice : (existingOtherPrice ? Number(existingOtherPrice) : null);

    const distPts = Math.abs(finalPrice - openPrice);
    const dollarVal = (distPts * volume * 100);
    const isFavorable = (isBuy ? finalPrice >= openPrice : finalPrice <= openPrice);
    const sign = isFavorable ? '+' : '-';

    console.log(`[ActiveOrders] Dragged #${ticket} ${type} to $${finalPrice.toFixed(2)} (${sign}$${dollarVal.toFixed(2)} / ${sign}${distPts.toFixed(1)} pt). Modifying MT5...`);

    try {
      const res = await fetch('/api/trade/modify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, sl: newSl, tp: newTp })
      });
      const data = await res.json();
      if (data && (data.status === 'OK' || data.status === 'MODIFIED')) {
        showChartToast(`✅ #${ticket} ${type} updated: $${finalPrice.toFixed(2)} (${sign}$${dollarVal.toFixed(2)} / ${sign}${distPts.toFixed(1)} pt)`);
      } else {
        if (key) this.pendingModifications.delete(key);
        const err = data?.error || data?.message || 'Modification rejected';
        showChartToast(`⚠️ Failed to update ${type}: ${err}`);
        this.render(); // Revert back to server state
      }
    } catch (err) {
      if (key) this.pendingModifications.delete(key);
      console.error('[ActiveOrders] Network error updating SL/TP:', err);
      showChartToast(`⚠️ Network error updating ${type}`);
      this.render();
    }
  }
}
