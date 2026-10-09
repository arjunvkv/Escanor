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
    this.lastBid = null;
    this.lastAsk = null;
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

    // 1. Remove overlays for positions or orders that are no longer active
    for (const [key, ovId] of this.positionOverlays.entries()) {
      const parts = key.split('_');
      const prefix = parts[0]; // 'pos' or 'ord'
      const ticket = parseInt(parts[1], 10);

      if (prefix === 'pos' && !activeTickets.has(ticket)) {
        try { this.chart.removeOverlay(ovId); } catch (_) {}
        this.positionOverlays.delete(key);
      } else if (prefix === 'ord' && !pendingTickets.has(ticket)) {
        try { this.chart.removeOverlay(ovId); } catch (_) {}
        this.positionOverlays.delete(key);
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
          ticket,
          isBuy,
          orderType: 'ENTRY',
          title: entryTitle
        }
      });

      // Stop Loss (SL) Line — DRAGGABLE!
      const slPrice = Number(pos.sl || 0);
      const slKey = `pos_${ticket}_sl`;
      if (slPrice > 0) {
        const slDist = Math.abs(openPrice - slPrice);
        const slDollar = (slDist * volume * 100);
        const isFavorable = isBuy ? (slPrice >= openPrice) : (slPrice <= openPrice);
        const slSign = isFavorable ? '+' : '-';
        const slTitle = `SL: $${slPrice.toFixed(2)} [${slSign}$${slDollar.toFixed(2)} / ${slSign}${slDist.toFixed(1)} pt]`;

        this._syncOrderLine(slKey, {
          points: [{ value: slPrice }],
          lock: false,
          extendData: {
            ticket,
            isBuy,
            orderType: 'SL',
            title: slTitle
          },
          onPressedMoveEnd: (e) => {
            const ov = e.overlay;
            const newPrice = ov?.points[0]?.value;
            if (newPrice && newPrice > 0) {
              this._onOrderDragged(ticket, 'SL', newPrice, isBuy, openPrice, volume, pos.tp);
            }
          }
        });
      } else {
        this._removeOrderLine(slKey);
      }

      // Take Profit (TP) Line — DRAGGABLE!
      const tpPrice = Number(pos.tp || 0);
      const tpKey = `pos_${ticket}_tp`;
      if (tpPrice > 0) {
        const tpDist = Math.abs(tpPrice - openPrice);
        const tpDollar = (tpDist * volume * 100);
        const isFavorable = isBuy ? (tpPrice >= openPrice) : (tpPrice <= openPrice);
        const tpSign = isFavorable ? '+' : '-';
        const tpTitle = `TP: $${tpPrice.toFixed(2)} [${tpSign}$${tpDollar.toFixed(2)} / ${tpSign}${tpDist.toFixed(1)} pt]`;

        this._syncOrderLine(tpKey, {
          points: [{ value: tpPrice }],
          lock: false,
          extendData: {
            ticket,
            isBuy,
            orderType: 'TP',
            title: tpTitle
          },
          onPressedMoveEnd: (e) => {
            const ov = e.overlay;
            const newPrice = ov?.points[0]?.value;
            if (newPrice && newPrice > 0) {
              this._onOrderDragged(ticket, 'TP', newPrice, isBuy, openPrice, volume, pos.sl);
            }
          }
        });
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
          ticket,
          isPending: true,
          orderType: orderType,
          title: ordTitle
        }
      });
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

  async _onOrderDragged(ticket, type, newPrice, isBuy, openPrice, volume, existingOtherPrice) {
    const finalPrice = Math.round(Number(newPrice) * 100) / 100;
    const isSl = type === 'SL';
    const bid = this.lastBid;
    const ask = this.lastAsk;

    // Pre-flight validation against live market price to prevent invalid stop placement
    if (isBuy) {
      if (isSl && bid && finalPrice >= bid) {
        showChartToast(`⚠️ Invalid SL: For BUY #${ticket}, Stop Loss must be below current market price ($${bid.toFixed(2)})`);
        this.render();
        return;
      }
      if (!isSl && ask && finalPrice <= ask) {
        showChartToast(`⚠️ Invalid TP: For BUY #${ticket}, Take Profit must be above current market price ($${ask.toFixed(2)})`);
        this.render();
        return;
      }
    } else {
      if (isSl && ask && finalPrice <= ask) {
        showChartToast(`⚠️ Invalid SL: For SELL #${ticket}, Stop Loss must be above current market price ($${ask.toFixed(2)})`);
        this.render();
        return;
      }
      if (!isSl && bid && finalPrice >= bid) {
        showChartToast(`⚠️ Invalid TP: For SELL #${ticket}, Take Profit must be below current market price ($${bid.toFixed(2)})`);
        this.render();
        return;
      }
    }

    const newSl = isSl ? finalPrice : (existingOtherPrice ? Number(existingOtherPrice) : null);
    const newTp = !isSl ? finalPrice : (existingOtherPrice ? Number(existingOtherPrice) : null);

    const distPts = Math.abs(finalPrice - openPrice);
    const dollarVal = (distPts * volume * 100);
    const isFavorable = isSl
      ? (isBuy ? finalPrice >= openPrice : finalPrice <= openPrice)
      : (isBuy ? finalPrice >= openPrice : finalPrice <= openPrice);
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
        const err = data?.error || data?.message || 'Modification rejected';
        showChartToast(`⚠️ Failed to update ${type}: ${err}`);
        this.render(); // Revert back to server state
      }
    } catch (err) {
      console.error('[ActiveOrders] Network error updating SL/TP:', err);
      showChartToast(`⚠️ Network error updating ${type}`);
      this.render();
    }
  }
}
