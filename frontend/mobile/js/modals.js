/**
 * Escanor Mobile Terminal — Modals & Interactive Trading Dialogs
 * Scalp execution modal, Metric manual modal, Intermarket Lead/Lag modal, and Macro News modal.
 */

import { formatPrice, showTerminalToast, INTERMARKET_DRIVERS, SATELLITE_NORMALIZER, calcShiftScore, formatShiftScore } from './constants.js';
import { selectLeadGauge } from './thermometers.js';
import { getMetricTimeHorizonStats } from './thermo_story_engine.js';

// Scalp Order State
let scalpModalDirection = 'BUY';
let scalpOrderMode = 'MARKET'; // 'MARKET' | 'PENDING'
let scalpTriggerPrice = 0.0;
let scalpLots = 0.50;
let scalpSlPts = 5.0;
let scalpTpPts = 10.0;
let scalpAutoCloseMins = Number(localStorage.getItem('scalp_auto_close_mins') || 0);
let isExecutingTrade = false;
let isOneClickMode = true;
let activeLeadLagTab = 'OVERVIEW';

export function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }
}
window.toggleFullscreen = toggleFullscreen;

export function updateQuickLotBadge() {
  const badge = document.getElementById('btnQuickLotBadge');
  if (badge) {
    const timerTag = scalpAutoCloseMins > 0 ? ` ⏱️${scalpAutoCloseMins}m` : '';
    badge.textContent = `⚡ ${scalpLots.toFixed(2)}L${timerTag} ⚙`;
  }
}

export function setAutoCloseMins(mins) {
  scalpAutoCloseMins = Math.max(0, Math.min(1440, Number(mins) || 0));
  localStorage.setItem('scalp_auto_close_mins', scalpAutoCloseMins);
  updateQuickLotBadge();
  syncScalpModalUI(true);
}
window.setAutoCloseMins = setAutoCloseMins;

export function onAutoCloseMinsChange(val) {
  scalpAutoCloseMins = Math.max(0, Math.min(1440, Number(val) || 0));
  localStorage.setItem('scalp_auto_close_mins', scalpAutoCloseMins);
  updateQuickLotBadge();
  syncScalpModalUI(false);
}
window.onAutoCloseMinsChange = onAutoCloseMinsChange;

export function setScalpOrderMode(mode) {
  scalpOrderMode = mode === 'PENDING' ? 'PENDING' : 'MARKET';
  if (scalpOrderMode === 'PENDING') {
    const spot = (window.__lastTelemetry && window.__lastTelemetry.spot) || {};
    const curPrice = scalpModalDirection === 'BUY' ? (spot.ask || spot.bid || 4160.0) : (spot.bid || spot.ask || 4160.0);
    scalpTriggerPrice = Number(curPrice.toFixed(2));
  }
  syncScalpModalUI(true);
}
window.setScalpOrderMode = setScalpOrderMode;

export function adjustTriggerPrice(delta) {
  const spot = (window.__lastTelemetry && window.__lastTelemetry.spot) || {};
  const curPrice = scalpModalDirection === 'BUY' ? (spot.ask || spot.bid || 4160.0) : (spot.bid || spot.ask || 4160.0);
  const base = scalpTriggerPrice > 0 ? scalpTriggerPrice : curPrice;
  scalpTriggerPrice = Number((base + delta).toFixed(2));
  syncScalpModalUI(true);
}
window.adjustTriggerPrice = adjustTriggerPrice;

export function resetTriggerPriceToCurrent() {
  const spot = (window.__lastTelemetry && window.__lastTelemetry.spot) || {};
  const curPrice = scalpModalDirection === 'BUY' ? (spot.ask || spot.bid || 4160.0) : (spot.bid || spot.ask || 4160.0);
  scalpTriggerPrice = Number(curPrice.toFixed(2));
  syncScalpModalUI(true);
}
window.resetTriggerPriceToCurrent = resetTriggerPriceToCurrent;

export function onTriggerPriceChange(val) {
  scalpTriggerPrice = Math.max(0, Number(val) || 0);
  syncScalpModalUI(false);
}
window.onTriggerPriceChange = onTriggerPriceChange;

let lastTopActionTime = 0;
export function onTopActionClick(direction) {
  const now = Date.now();
  if (now - lastTopActionTime < 350) return;
  lastTopActionTime = now;
  if (isOneClickMode) {
    triggerQuickMarketOrder(direction);
  } else {
    openScalpModal(direction);
  }
}
window.onTopActionClick = onTopActionClick;

export async function triggerQuickMarketOrder(direction) {
  if (isExecutingTrade) return;
  isExecutingTrade = true;
  if (navigator.vibrate) navigator.vibrate([40, 30, 40]);

  const isBuy = direction === 'BUY';
  const btn = isBuy ? document.getElementById('btnTopBuy') : document.getElementById('btnTopSell');
  const label = isBuy ? document.getElementById('topBuyLabel') : document.getElementById('topSellLabel');

  if (label) label.textContent = '⚡ FIRING...';
  if (btn) btn.disabled = true;

  const spot = (window.__lastTelemetry && window.__lastTelemetry.spot) || {};
  const curPrice = isBuy ? (spot.ask || 4160.0) : (spot.bid || 4160.0);
  const estSl = isBuy ? (curPrice - scalpSlPts) : (curPrice + scalpSlPts);
  const estTp = isBuy ? (curPrice + scalpTpPts) : (curPrice - scalpTpPts);

  const payload = JSON.stringify({
    symbol: 'XAUUSD',
    direction: direction,
    volume: scalpLots,
    sl_pts: scalpSlPts,
    tp_pts: scalpTpPts,
    sl: Number(estSl.toFixed(2)),
    tp: Number(estTp.toFixed(2)),
    auto_close_mins: scalpAutoCloseMins
  });

  try {
    const resp = await fetch('/api/trade/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
    const res = await resp.json();
    if (res.status === 'OK') {
      const timerNotice = scalpAutoCloseMins > 0 ? ` [Auto-close ${scalpAutoCloseMins}m]` : '';
      showTerminalToast(`⚡ MARKET ${direction} FILLED: ${scalpLots}L @ $${(res.price || curPrice).toFixed(2)}${timerNotice}`, 'success');
      
      // OPTIMISTIC ZERO-LATENCY ACTIVE TRADE DISPATCH
      if (!window.__lastTelemetry) window.__lastTelemetry = {};
      if (!Array.isArray(window.__lastTelemetry.active_positions)) {
        window.__lastTelemetry.active_positions = [];
      }
      const ticketId = res.order || res.ticket || Date.now();
      const openPrice = Number((res.price || curPrice).toFixed(2));
      const newPos = res.position || {
        ticket: ticketId,
        symbol: 'XAUUSD',
        type: direction,
        volume: scalpLots,
        price_open: openPrice,
        sl: res.sl || Number(estSl.toFixed(2)),
        tp: res.tp || Number(estTp.toFixed(2)),
        profit: 0.0,
        profit_pts: 0.0,
        time: Math.floor(Date.now() / 1000),
        open_epoch_utc: Math.floor(Date.now() / 1000),
        elapsed_sec: 0
      };
      
      // Prepend to active positions list immediately
      const existingIdx = window.__lastTelemetry.active_positions.findIndex(p => Number(p.ticket) === Number(ticketId));
      if (existingIdx === -1) {
        window.__lastTelemetry.active_positions.unshift(newPos);
      } else {
        window.__lastTelemetry.active_positions[existingIdx] = newPos;
      }
      
      // Render active trades UI immediately (0ms wait)
      if (typeof window.renderActiveTradesUI === 'function') {
        window.renderActiveTradesUI(window.__lastTelemetry);
      }
      
      // Sync broker telemetry snapshot in background
      if (typeof window.fetchTelemetrySnapshot === 'function') {
        window.fetchTelemetrySnapshot();
      }
    } else {
      showTerminalToast(`❌ ORDER REJECTED: ${res.message || 'Broker Error'}`, 'error');
    }
  } catch (err) {
    showTerminalToast(`❌ EXECUTION FAILED: ${err.message}`, 'error');
  } finally {
    isExecutingTrade = false;
    if (label) label.textContent = isBuy ? '🟢 BUY' : '🔴 SELL';
    if (btn) btn.disabled = false;
  }
}
window.triggerQuickMarketOrder = triggerQuickMarketOrder;

export function openScalpModal(direction = 'BUY') {
  scalpModalDirection = direction;
  const spot = (window.__lastTelemetry && window.__lastTelemetry.spot) || {};
  const curPrice = direction === 'BUY' ? (spot.ask || spot.bid || 4160.0) : (spot.bid || spot.ask || 4160.0);
  if (!scalpTriggerPrice || scalpTriggerPrice <= 0) {
    scalpTriggerPrice = Number(curPrice.toFixed(2));
  }
  const modal = document.getElementById('scalpOrderModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  syncScalpModalUI(true);
}
window.openScalpModal = openScalpModal;

export function closeScalpModal() {
  const modal = document.getElementById('scalpOrderModal');
  if (modal) modal.classList.add('hidden');
}
window.closeScalpModal = closeScalpModal;

export function setScalpDirection(dir) {
  scalpModalDirection = dir;
  if (scalpOrderMode === 'PENDING') {
    const spot = (window.__lastTelemetry && window.__lastTelemetry.spot) || {};
    const curPrice = dir === 'BUY' ? (spot.ask || spot.bid || 4160.0) : (spot.bid || spot.ask || 4160.0);
    scalpTriggerPrice = Number(curPrice.toFixed(2));
  }
  syncScalpModalUI(true);
}
window.setScalpDirection = setScalpDirection;

export function setLots(val) {
  scalpLots = Math.max(0.01, Math.min(10.0, Number(val) || 0.50));
  updateQuickLotBadge();
  syncScalpModalUI(true);
}
window.setLots = setLots;

export function adjustLots(delta) {
  scalpLots = Math.max(0.01, Math.min(10.0, Number((scalpLots + delta).toFixed(2))));
  updateQuickLotBadge();
  syncScalpModalUI(true);
}
window.adjustLots = adjustLots;

export function onLotsChange(val) {
  scalpLots = Math.max(0.01, Math.min(10.0, Number(val) || 0.01));
  updateQuickLotBadge();
  syncScalpModalUI(false);
}
window.onLotsChange = onLotsChange;

export function applyScalpPreset(sl, tp) {
  scalpSlPts = Number(sl);
  scalpTpPts = Number(tp);
  syncScalpModalUI(true);
}
window.applyScalpPreset = applyScalpPreset;

export function onRiskDollarChange(val) {
  const d = Math.max(1, Number(val) || 10);
  scalpSlPts = Number((d / (scalpLots * 100)).toFixed(1));
  syncScalpModalUI(false);
}
window.onRiskDollarChange = onRiskDollarChange;

export function onProfitDollarChange(val) {
  const d = Math.max(1, Number(val) || 10);
  scalpTpPts = Number((d / (scalpLots * 100)).toFixed(1));
  syncScalpModalUI(false);
}
window.onProfitDollarChange = onProfitDollarChange;

export function syncScalpModalUI(updateInputValues = true) {
  const isBuy = scalpModalDirection === 'BUY';
  const isPending = scalpOrderMode === 'PENDING';
  const tabBuy = document.getElementById('modalTabBuy');
  const tabSell = document.getElementById('modalTabSell');
  const tabModeMkt = document.getElementById('modalTabModeMarket');
  const tabModePend = document.getElementById('modalTabModePending');
  const secPending = document.getElementById('pendingTriggerPriceSection');
  const modalTitle = document.getElementById('scalpModalTitle');
  const modalIcon = document.getElementById('scalpModalIcon');
  const btnExec = document.getElementById('btnExecuteModalTrade');

  // Mode Switch Tabs
  if (tabModeMkt && tabModePend) {
    if (isPending) {
      tabModeMkt.className = 'py-2 rounded-lg font-black text-xs uppercase tracking-wider transition bg-transparent text-slate-400 hover:text-white flex items-center justify-center gap-1.5 cursor-pointer';
      tabModePend.className = 'py-2 rounded-lg font-black text-xs uppercase tracking-wider transition bg-amber-500 text-slate-950 font-black shadow shadow-amber-950/60 flex items-center justify-center gap-1.5 cursor-pointer';
    } else {
      tabModeMkt.className = 'py-2 rounded-lg font-black text-xs uppercase tracking-wider transition bg-amber-500 text-slate-950 font-black shadow shadow-amber-950/60 flex items-center justify-center gap-1.5 cursor-pointer';
      tabModePend.className = 'py-2 rounded-lg font-black text-xs uppercase tracking-wider transition bg-transparent text-slate-400 hover:text-white flex items-center justify-center gap-1.5 cursor-pointer';
    }
  }

  // Toggle Trigger Price Box Visibility
  if (secPending) {
    if (isPending) {
      secPending.classList.remove('hidden');
    } else {
      secPending.classList.add('hidden');
    }
  }

  // Direction Tabs
  if (tabBuy && tabSell) {
    if (isBuy) {
      tabBuy.className = 'py-2.5 rounded-lg font-black text-xs uppercase tracking-wider transition bg-emerald-600 text-white shadow shadow-emerald-950/60';
      tabSell.className = 'py-2.5 rounded-lg font-black text-xs uppercase tracking-wider transition bg-slate-800 text-slate-400 hover:text-white';
    } else {
      tabBuy.className = 'py-2.5 rounded-lg font-black text-xs uppercase tracking-wider transition bg-slate-800 text-slate-400 hover:text-white';
      tabSell.className = 'py-2.5 rounded-lg font-black text-xs uppercase tracking-wider transition bg-red-600 text-white shadow shadow-red-950/60';
    }
  }

  const spot = (window.__lastTelemetry && window.__lastTelemetry.spot) || {};
  const curAsk = spot.ask || spot.bid || 4160.0;
  const curBid = spot.bid || spot.ask || 4160.0;
  const curMktPrice = isBuy ? curAsk : curBid;

  if (isPending && (scalpTriggerPrice <= 0 || isNaN(scalpTriggerPrice))) {
    scalpTriggerPrice = Number(curMktPrice.toFixed(2));
  }

  // Base Reference Price: Trigger Price for Pending, Market Price for Instant
  const basePrice = isPending ? scalpTriggerPrice : curMktPrice;
  const slPrice = isBuy ? (basePrice - scalpSlPts) : (basePrice + scalpSlPts);
  const tpPrice = isBuy ? (basePrice + scalpTpPts) : (basePrice - scalpTpPts);

  // Auto-detect Pending Order Type & Spread Offset
  let detectedPendingType = isBuy ? 'BUY_LIMIT' : 'SELL_LIMIT';
  let offsetLabel = '0.0 pt off market';
  if (isPending) {
    if (isBuy) {
      if (scalpTriggerPrice < (curBid - 0.05)) {
        detectedPendingType = 'BUY_LIMIT';
        const diff = (curBid - scalpTriggerPrice).toFixed(1);
        offsetLabel = `-${diff} pt (discount)`;
      } else if (scalpTriggerPrice > (curAsk + 0.05)) {
        detectedPendingType = 'BUY_STOP';
        const diff = (scalpTriggerPrice - curAsk).toFixed(1);
        offsetLabel = `+${diff} pt (breakout)`;
      } else {
        detectedPendingType = 'BUY_LIMIT';
        offsetLabel = 'At live ask';
      }
    } else {
      if (scalpTriggerPrice > (curAsk + 0.05)) {
        detectedPendingType = 'SELL_LIMIT';
        const diff = (scalpTriggerPrice - curAsk).toFixed(1);
        offsetLabel = `+${diff} pt (premium)`;
      } else if (scalpTriggerPrice < (curBid - 0.05)) {
        detectedPendingType = 'SELL_STOP';
        const diff = (curBid - scalpTriggerPrice).toFixed(1);
        offsetLabel = `-${diff} pt (breakdown)`;
      } else {
        detectedPendingType = 'SELL_LIMIT';
        offsetLabel = 'At live bid';
      }
    }

    const typeBadge = document.getElementById('pendingTypeBadge');
    if (typeBadge) {
      typeBadge.textContent = detectedPendingType.replace('_', ' ');
      if (detectedPendingType.includes('LIMIT')) {
        typeBadge.className = 'px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 text-[9.5px] font-mono font-bold';
      } else {
        typeBadge.className = 'px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/50 text-[9.5px] font-mono font-bold';
      }
    }

    const offsetBadge = document.getElementById('pendingOffsetBadge');
    if (offsetBadge) offsetBadge.textContent = offsetLabel;

    if (updateInputValues) {
      const inputTrigger = document.getElementById('pendingTriggerPriceInput');
      if (inputTrigger) inputTrigger.value = scalpTriggerPrice.toFixed(2);
    }
  }

  if (modalTitle) {
    if (isPending) {
      modalTitle.textContent = `${scalpModalDirection} PENDING (${detectedPendingType.replace('_', ' ')})`;
    } else {
      modalTitle.textContent = `${scalpModalDirection} SCALP EXECUTION`;
    }
    modalTitle.className = `font-black text-sm tracking-wider uppercase ${isBuy ? 'text-emerald-400' : 'text-red-400'}`;
  }
  if (modalIcon) {
    modalIcon.textContent = isPending ? '🎯' : '⚡';
    modalIcon.className = `text-base ${isBuy ? 'text-emerald-400' : 'text-red-400'}`;
  }

  const riskDollar = Math.round(scalpSlPts * scalpLots * 100);
  const profitDollar = Math.round(scalpTpPts * scalpLots * 100);

  const ptValLabel = document.getElementById('scalpPtValLabel');
  if (ptValLabel) ptValLabel.textContent = `1.0 pt = $${(scalpLots * 100).toFixed(2)}`;

  if (updateInputValues) {
    const inputLots = document.getElementById('scalpLotsInput');
    if (inputLots) inputLots.value = scalpLots.toFixed(2);
    const inputRisk = document.getElementById('scalpRiskDollarInput');
    if (inputRisk) inputRisk.value = riskDollar;
    const inputProf = document.getElementById('scalpProfitDollarInput');
    if (inputProf) inputProf.value = profitDollar;
  }

  const slPtsBadge = document.getElementById('scalpSlPtsBadge');
  if (slPtsBadge) slPtsBadge.textContent = `-${scalpSlPts.toFixed(1)} pt`;
  const tpPtsBadge = document.getElementById('scalpTpPtsBadge');
  if (tpPtsBadge) tpPtsBadge.textContent = `+${scalpTpPts.toFixed(1)} pt`;

  const slPriceLabel = document.getElementById('scalpSlPriceLabel');
  if (slPriceLabel) slPriceLabel.textContent = `$${slPrice.toFixed(2)}`;
  const tpPriceLabel = document.getElementById('scalpTpPriceLabel');
  if (tpPriceLabel) tpPriceLabel.textContent = `$${tpPrice.toFixed(2)}`;

  const rrBadge = document.getElementById('scalpRrRatioBadge');
  if (rrBadge) {
    const ratio = scalpSlPts > 0 ? (scalpTpPts / scalpSlPts).toFixed(1) : '0.0';
    rrBadge.textContent = `1 : ${ratio}`;
  }

  const autoCloseBadge = document.getElementById('scalpAutoCloseBadge');
  if (autoCloseBadge) {
    if (scalpAutoCloseMins > 0) {
      autoCloseBadge.textContent = `${scalpAutoCloseMins} min${scalpAutoCloseMins === 1 ? '' : 's'}`;
      autoCloseBadge.className = 'text-amber-400 font-bold font-mono';
    } else {
      autoCloseBadge.textContent = 'Off (0 min)';
      autoCloseBadge.className = 'text-slate-400 font-bold font-mono';
    }
  }

  if (updateInputValues) {
    const autoCloseInput = document.getElementById('scalpAutoCloseMinsInput');
    if (autoCloseInput) autoCloseInput.value = scalpAutoCloseMins > 0 ? scalpAutoCloseMins : '';
  }

  if (btnExec) {
    const timerTag = scalpAutoCloseMins > 0 ? ` · ⏱️${scalpAutoCloseMins}m` : '';
    if (isPending) {
      btnExec.className = `w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-98 text-slate-950 font-black text-sm uppercase tracking-wider shadow-lg transition cursor-pointer flex items-center justify-center gap-2`;
      btnExec.innerHTML = `<span>🎯 PLACE ${detectedPendingType.replace('_', ' ')} (${scalpLots.toFixed(2)}L @ $${scalpTriggerPrice.toFixed(2)}${timerTag})</span>`;
    } else {
      btnExec.className = `w-full py-3 rounded-xl ${isBuy ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'} active:scale-98 text-white font-black text-sm uppercase tracking-wider shadow-lg transition cursor-pointer flex items-center justify-center gap-2`;
      btnExec.innerHTML = `<span>⚡ EXECUTE MARKET ${scalpModalDirection} (${scalpLots.toFixed(2)}L${timerTag})</span>`;
    }
  }
}

export async function executeScalpTradeNow() {
  if (isExecutingTrade) return;
  isExecutingTrade = true;

  const btnExec = document.getElementById('btnExecuteModalTrade');
  if (btnExec) {
    btnExec.disabled = true;
    btnExec.innerHTML = `<span>⚡ TRANSMITTING TO MT5...</span>`;
  }

  const isBuy = scalpModalDirection === 'BUY';
  const isPending = scalpOrderMode === 'PENDING';
  const spot = (window.__lastTelemetry && window.__lastTelemetry.spot) || {};
  const curAsk = spot.ask || spot.bid || 4160.0;
  const curBid = spot.bid || spot.ask || 4160.0;
  const curMktPrice = isBuy ? curAsk : curBid;

  const basePrice = isPending ? scalpTriggerPrice : curMktPrice;
  const slPrice = isBuy ? (basePrice - scalpSlPts) : (basePrice + scalpSlPts);
  const tpPrice = isBuy ? (basePrice + scalpTpPts) : (basePrice - scalpTpPts);

  // =========================================================================
  // 🎯 PENDING ORDER EXECUTION BRANCH
  // =========================================================================
  if (isPending) {
    let detectedPendingType = isBuy ? 'BUY_LIMIT' : 'SELL_LIMIT';
    if (isBuy) {
      detectedPendingType = scalpTriggerPrice < (curBid - 0.05) ? 'BUY_LIMIT' : 'BUY_STOP';
    } else {
      detectedPendingType = scalpTriggerPrice > (curAsk + 0.05) ? 'SELL_LIMIT' : 'SELL_STOP';
    }

    const payload = JSON.stringify({
      symbol: 'XAUUSD',
      direction: scalpModalDirection,
      order_type: detectedPendingType,
      price: Number(scalpTriggerPrice.toFixed(2)),
      volume: scalpLots,
      sl: Number(slPrice.toFixed(2)),
      tp: Number(tpPrice.toFixed(2)),
      auto_close_mins: scalpAutoCloseMins,
      comment: 'Escanor Pending'
    });

    try {
      const resp = await fetch('/api/trade/place_pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      const res = await resp.json();
      if (res.status === 'OK') {
        const timerNotice = scalpAutoCloseMins > 0 ? ` [Auto-close ${scalpAutoCloseMins}m attached]` : '';
        showTerminalToast(`🎯 PENDING ${detectedPendingType.replace('_', ' ')} PLACED: ${scalpLots}L @ $${scalpTriggerPrice.toFixed(2)}${timerNotice}`, 'success');
        closeScalpModal();

        // Optimistically record pending order in memory
        if (!window.__lastTelemetry) window.__lastTelemetry = {};
        if (!Array.isArray(window.__lastTelemetry.pending_orders)) {
          window.__lastTelemetry.pending_orders = [];
        }
        const ticketId = res.order || res.ticket || Date.now();
        window.__lastTelemetry.pending_orders.unshift({
          ticket: ticketId,
          symbol: 'XAUUSD',
          type: detectedPendingType,
          volume: scalpLots,
          price_open: Number(scalpTriggerPrice.toFixed(2)),
          sl: Number(slPrice.toFixed(2)),
          tp: Number(tpPrice.toFixed(2)),
          time_setup: Math.floor(Date.now() / 1000),
          auto_close_mins: scalpAutoCloseMins > 0 ? scalpAutoCloseMins : null
        });

        if (typeof window.renderActiveTradesUI === 'function') {
          window.renderActiveTradesUI(window.__lastTelemetry);
        }
        if (typeof window.fetchTelemetrySnapshot === 'function') {
          window.fetchTelemetrySnapshot();
        }
      } else {
        showTerminalToast(`❌ PENDING FAILED: ${res.message || 'Broker Error'}`, 'error');
      }
    } catch (err) {
      showTerminalToast(`❌ PENDING ERROR: ${err.message}`, 'error');
    } finally {
      isExecutingTrade = false;
      if (btnExec) btnExec.disabled = false;
      syncScalpModalUI(false);
    }
    return;
  }

  // =========================================================================
  // ⚡ INSTANT MARKET EXECUTION BRANCH
  // =========================================================================
  const payload = JSON.stringify({
    symbol: 'XAUUSD',
    direction: scalpModalDirection,
    volume: scalpLots,
    sl_pts: scalpSlPts,
    tp_pts: scalpTpPts,
    sl: Number(slPrice.toFixed(2)),
    tp: Number(tpPrice.toFixed(2)),
    auto_close_mins: scalpAutoCloseMins
  });

  try {
    const resp = await fetch('/api/trade/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
    const res = await resp.json();
    if (res.status === 'OK') {
      const timerNotice = scalpAutoCloseMins > 0 ? ` [Auto-close ${scalpAutoCloseMins}m]` : '';
      showTerminalToast(`⚡ MARKET ${scalpModalDirection} EXECUTED: ${scalpLots}L @ $${(res.price || curMktPrice).toFixed(2)}${timerNotice}`, 'success');
      closeScalpModal();

      // OPTIMISTIC ZERO-LATENCY ACTIVE TRADE DISPATCH
      if (!window.__lastTelemetry) window.__lastTelemetry = {};
      if (!Array.isArray(window.__lastTelemetry.active_positions)) {
        window.__lastTelemetry.active_positions = [];
      }
      const ticketId = res.order || res.ticket || Date.now();
      const openPrice = Number((res.price || curMktPrice).toFixed(2));
      const newPos = res.position || {
        ticket: ticketId,
        symbol: 'XAUUSD',
        type: scalpModalDirection,
        volume: scalpLots,
        price_open: openPrice,
        sl: res.sl || Number(slPrice.toFixed(2)),
        tp: res.tp || Number(tpPrice.toFixed(2)),
        profit: 0.0,
        profit_pts: 0.0,
        time: Math.floor(Date.now() / 1000),
        open_epoch_utc: Math.floor(Date.now() / 1000),
        elapsed_sec: 0,
        auto_close_mins: scalpAutoCloseMins > 0 ? scalpAutoCloseMins : null
      };

      const existingIdx = window.__lastTelemetry.active_positions.findIndex(p => Number(p.ticket) === Number(ticketId));
      if (existingIdx === -1) {
        window.__lastTelemetry.active_positions.unshift(newPos);
      } else {
        window.__lastTelemetry.active_positions[existingIdx] = newPos;
      }

      if (typeof window.renderActiveTradesUI === 'function') {
        window.renderActiveTradesUI(window.__lastTelemetry);
      }

      if (typeof window.fetchTelemetrySnapshot === 'function') {
        window.fetchTelemetrySnapshot();
      }
    } else {
      showTerminalToast(`❌ ORDER REJECTED: ${res.message || 'Broker Error'}`, 'error');
    }
  } catch (err) {
    showTerminalToast(`❌ EXECUTION FAILED: ${err.message}`, 'error');
  } finally {
    isExecutingTrade = false;
    if (btnExec) btnExec.disabled = false;
    syncScalpModalUI(false);
  }
}
window.executeScalpTradeNow = executeScalpTradeNow;

// Metric Reasoning Modal Logic
export function openMetricModal(metricKey) {
  const modal = document.getElementById('metricDetailModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  renderMetricModalContent(metricKey);
}
window.openMetricModal = openMetricModal;

export function closeMetricModal() {
  const modal = document.getElementById('metricDetailModal');
  if (modal) modal.classList.add('hidden');
}
window.closeMetricModal = closeMetricModal;

export function renderMetricModalContent(key) {
  const titleEl = document.getElementById('metricModalTitle');
  const bodyEl = document.getElementById('metricModalBody');
  if (!titleEl || !bodyEl) return;

  const tel = window.__lastTelemetry || {};
  const tape = tel.tape || {};

  const manuals = {
    'velocity': {
      title: 'TICK VELOCITY & TAPE SPEED',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Frequency of live price quotes executed per minute on the MT5 tape (${tape.vel_1m || tape.tick_velocity || 0} t/m).</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">≥ 100 t/m (Kinetic Expansion):</strong> Institutional momentum in flight. Prong C market order authorized. Never stage counter-trend limits.</div>
              <div>• <strong class="text-amber-400">45 to 95 t/m (Active Tape):</strong> Normal rotation, structural reclaims, and Turtle Soup sweeps.</div>
              <div>• <strong class="text-slate-300">≤ 40 t/m (Quiet Absorption):</strong> Safe zone for Prong A structural resting limits and pullback tip retests.</div>
            </div>
          </div>
        </div>
      `
    },
    'cvd': {
      title: 'CVD (CUMULATIVE VOLUME DELTA)',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Net balance of aggressive buyer orders lifting asks vs seller orders hitting bids (${tape.cvd_delta || 0} Lots).</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">+CVD with Rising Price:</strong> Organic buyer aggression driving trend continuation.</div>
              <div>• <strong class="text-amber-400">+CVD with Falling Price:</strong> Iceberg limit absorption at support (energy coiling for explosive spring UP).</div>
              <div>• <strong class="text-rose-400">-CVD with Falling Price:</strong> Heavy aggressive sell liquidation cascade.</div>
              <div>• <strong class="text-cyan-400">Divergence at Extremes:</strong> Large delta surge without price progress warns of imminent reversal.</div>
            </div>
          </div>
        </div>
      `
    },
    'footprint': {
      title: '4M FOOTPRINT DELTA BLOCKS',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Orderflow delta balance aggregated across the last 4 1-minute candle blocks (${tape.footprint_delta || 0} L).</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">4/4 or 3/4 Green Blocks (LIFT):</strong> Relentless buyer dominance — ride trend continuation.</div>
              <div>• <strong class="text-rose-400">4/4 or 3/4 Red Blocks (DUMP):</strong> Relentless seller dominance — institutional distribution cascade.</div>
              <div>• <strong class="text-amber-400">Split (2/4 vs 2/4):</strong> Balanced two-sided rotational chop — breakouts will fail.</div>
              <div>• <strong class="text-cyan-400">Red to Green Flip at Shelf:</strong> High-conviction demand floor absorption.</div>
            </div>
          </div>
        </div>
      `
    },
    'impulse': {
      title: 'IMPULSE DISPLACEMENT VELOCITY',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Spatial price travel rate per unit time (${tel.impulse?.rate_pt_min || tape.impulse_rate || 0} pt/min) through the chart.</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">≥ 1.0 pt/min (SURGE):</strong> Price accelerating through open air vacuum pockets.</div>
              <div>• <strong class="text-amber-400">≤ 0.4 pt/min (COIL):</strong> Range compression coiling potential energy for a breakout.</div>
              <div>• <strong class="text-cyan-400">High Surge + Low Ticks:</strong> Pure vacuum slip — price moves effortlessly into targets.</div>
              <div>• <strong class="text-rose-400">&gt; 20 pt Uncorrected Run:</strong> Climax exhaustion — lock Breakeven Armor immediately.</div>
            </div>
          </div>
        </div>
      `
    },
    'silver': {
      title: 'INTERMARKET LEAD / LAG (SILVER & MACRO)',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Relative strength and beta lead of Silver and intermarket satellites vs Gold (XAUUSD).</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">Silver Leading Higher (BETA Lead):</strong> Confirms authentic macro Gold rally with ~1.8x beta.</div>
              <div>• <strong class="text-amber-400">Silver Lagging / Diverging (DRAG):</strong> Warns Gold move is a thin broker liquidity sweep. Stand flat.</div>
              <div>• <strong class="text-cyan-400">Aligned Macro Flow:</strong> Peak institutional conviction across the precious metals desk.</div>
              <div>• <strong class="text-rose-400">Silver Stalling at Supply:</strong> Early warning signal to bank profits on Gold longs.</div>
            </div>
          </div>
        </div>
      `
    },
    '4tf': {
      title: '4-TIMEFRAME POSTURE ALIGNMENT',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Multi-timeframe trend and momentum consensus across H4, H1, M15, and M5 structural layers.</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">4/4 Aligned:</strong> Sovereign highway trend — highest probability directional follow-through.</div>
              <div>• <strong class="text-amber-400">3/4 Aligned:</strong> Strong directional permission — enter pullbacks on M5.</div>
              <div>• <strong class="text-rose-400">2/2 Split:</strong> EMA compression sandwich — high friction chop; trade boundaries only.</div>
            </div>
          </div>
        </div>
      `
    },
    'equilibrium': {
      title: 'DEALING RANGE & EQUILIBRIUM (50%)',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Current price position inside the active dealing range (0.00 Floor to 1.00 Ceiling).</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">Discount (≤ 0.35):</strong> Cheap institutional value — longs authorized. Never initiate shorts.</div>
              <div>• <strong class="text-slate-300">Equilibrium (0.45 to 0.55):</strong> Fair value mid-air — coin-flip zone taxed by spread; avoid entries.</div>
              <div>• <strong class="text-rose-400">Premium (≥ 0.70):</strong> Expensive institutional value — shorts authorized. Never initiate longs.</div>
            </div>
          </div>
        </div>
      `
    },
    'runway': {
      title: 'RUNWAY AIR POCKET CLEARANCE',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Points of open air clearance to the nearest unmitigated Fair Value Gap (FVG) or Order Block.</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">High Runway (> 8.0 pts):</strong> Open vacuum highway — velocity expands rapidly to Take Profit.</div>
              <div>• <strong class="text-amber-400">Low Runway (< 3.0 pts):</strong> Friction road — opposing shelves will stall price with wick rejections.</div>
              <div>• <strong class="text-rose-400">Zero Runway:</strong> Structural shelf reached — take profit or trail armor.</div>
            </div>
          </div>
        </div>
      `
    },
    'sweep': {
      title: 'TURTLE SOUP SWEEP HARVEST DEPTH',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Penetration depth beyond major session extremes (PDH, PDL, Asian High/Low).</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">≥ 2.0 to 3.5 pt Sweep + Reclaim:</strong> Valid stop harvest — trigger Pattern A Turtle Soup reversal.</div>
              <div>• <strong class="text-amber-400">&lt; 2.0 pt Wick:</strong> Mid-air dip trap — stops have not been cleared; institutions will push further.</div>
              <div>• <strong class="text-rose-400">Violent Through-Sweep without Reclaim:</strong> Kinetic continuation cascade — do not fade.</div>
            </div>
          </div>
        </div>
      `
    },
    'pdh': {
      title: 'PREVIOUS DAY HIGH (CEILING)',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Yesterday's absolute apex price and resting buy-side liquidity (BSL) pool.</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">Sweep + Reclaim below PDH:</strong> Institutional short trigger (Turtle Soup).</div>
              <div>• <strong class="text-cyan-400">Sustained Hold above PDH (≥ 100 t/m):</strong> Bullish breakout expansion into new price discovery.</div>
              <div>• <strong class="text-amber-400">Approaching PDH on Low Delta:</strong> Prime profit-taking target for existing longs.</div>
            </div>
          </div>
        </div>
      `
    },
    'vwap': {
      title: 'SESSION VWAP (FAIR VALUE ANCHOR)',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Volume-Weighted Average Price — institutional fair value anchor for the active session.</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">Price Above VWAP:</strong> Buyers in institutional control — buy pullbacks into VWAP.</div>
              <div>• <strong class="text-rose-400">Price Below VWAP:</strong> Sellers in institutional control — sell rallies into VWAP.</div>
              <div>• <strong class="text-amber-400">VWAP Touch in Range Chop:</strong> Prime mean-reversion target and rotational pivot.</div>
            </div>
          </div>
        </div>
      `
    },
    'pdl': {
      title: 'PREVIOUS DAY LOW (FLOOR)',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Yesterday's lowest price and resting sell-side liquidity (SSL) pool.</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">Sweep + Reclaim above PDL:</strong> Institutional long trigger (Turtle Soup).</div>
              <div>• <strong class="text-rose-400">Sustained Breakdown below PDL:</strong> Bearish liquidation cascade into lower price discovery.</div>
              <div>• <strong class="text-amber-400">Approaching PDL on Low Delta:</strong> Prime profit-taking target for existing shorts.</div>
            </div>
          </div>
        </div>
      `
    },
    'asian_low': {
      title: 'ASIAN SESSION LOW FLOOR',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Asian Session Low (00:00–06:00 UTC) targeted by London and NY session opens.</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-emerald-400">Judas Swing Sweep (07:00–07:15 UTC):</strong> Engineered stop hunt below Asian Low followed by sharp reclaim.</div>
              <div>• <strong class="text-cyan-400">Reclaim + CVD Flip Positive:</strong> Textbook London Open long entry with stop below sweep wick.</div>
              <div>• <strong class="text-rose-400">Failure to Reclaim:</strong> Structural trend day down into European session.</div>
            </div>
          </div>
        </div>
      `
    },
    'effort': {
      title: 'EFFORT VS RESULT (ABSORPTION)',
      html: `
        <div class="space-y-2.5">
          <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10">
            <div class="text-[10px] font-bold text-amber-400 font-mono uppercase tracking-wider mb-1">📐 WHAT IT MEASURES</div>
            <div class="text-[11.5px] text-slate-200 leading-snug">Thermodynamic ratio between volume/delta effort and resulting price displacement.</div>
          </div>
          <div class="p-2.5 rounded-xl bg-[#081026] border border-cyan-500/20">
            <div class="text-[10px] font-bold text-cyan-400 font-mono uppercase tracking-wider mb-1.5">🎯 HOW IT'S READ</div>
            <div class="space-y-1.5 text-[11px] text-slate-300">
              <div>• <strong class="text-amber-400">Huge Volume + Zero Displacement:</strong> Opposing iceberg limit wall absorbing all flow — reversal imminent.</div>
              <div>• <strong class="text-emerald-400">High Buy Delta at Support:</strong> Institutional bids absorbing sellers; coiling upward spring.</div>
              <div>• <strong class="text-cyan-400">Large Candle + Low Volume:</strong> Thin-tape vacuum drift into unpopulated order book.</div>
            </div>
          </div>
        </div>
      `
    }
  };

  const info = manuals[key] || {
    title: String(key).toUpperCase(),
    html: `<div class="text-slate-400">Institutional scalping telemetry for ${key}.</div>`
  };

  titleEl.textContent = info.title;

  // Multi-horizon time breakdown table (1m, 3m, 5m, 10m, 15m, 30m, 1h)
  const isGaugeMetric = ['velocity', 'cvd', 'footprint', 'impulse', 'silver', 'lead'].includes(key);
  let timeTableHtml = '';

  if (isGaugeMetric) {
    const horizons = getMetricTimeHorizonStats(key);
    const rowsHtml = horizons.map(h => {
      const upWidth = Math.max(3, Math.min(97, h.upPct));
      const dnWidth = 100 - upWidth;
      return `
        <tr class="border-b border-white/5 hover:bg-slate-900/40">
          <td class="py-1 px-2 font-bold text-slate-300 text-[10px] whitespace-nowrap">${h.label}</td>
          <td class="py-1 px-2 text-right text-emerald-300 font-bold text-[10px] whitespace-nowrap">${h.upSec}s <span class="text-[8.5px] text-emerald-400/80">(${h.upPct}%)</span></td>
          <td class="py-1 px-2 text-right text-rose-300 font-bold text-[10px] whitespace-nowrap">${h.dnSec}s <span class="text-[8.5px] text-rose-400/80">(${h.dnPct}%)</span></td>
          <td class="py-1 px-2 text-right text-amber-300 font-mono text-[9.5px] whitespace-nowrap">${h.flips}x</td>
          <td class="py-1 px-2 text-center">
            <div class="w-16 h-2 rounded bg-slate-950 flex overflow-hidden border border-white/10 mx-auto">
              <div style="width:${upWidth}%;" class="bg-emerald-500 h-full"></div>
              <div style="width:${dnWidth}%;" class="bg-rose-500 h-full"></div>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    timeTableHtml = `
      <div class="rounded-xl border border-amber-500/30 bg-[#060a16] p-2 space-y-1.5 shadow-md">
        <div class="flex items-center justify-between text-[10px] font-bold text-amber-300 px-1">
          <span class="flex items-center gap-1">
            <span>⏱️</span>
            <span>TIME STAYED IN UP vs DOWN STATES</span>
          </span>
          <span class="text-[8.5px] text-slate-400 font-mono">1m • 3m • 5m • 10m • 15m • 30m • 1h</span>
        </div>
        <div class="overflow-x-auto rounded-lg border border-white/5">
          <table class="w-full text-left font-mono">
            <thead class="bg-slate-950/80 text-slate-400 text-[9px] uppercase border-b border-white/10">
              <tr>
                <th class="py-1 px-2">HORIZON</th>
                <th class="py-1 px-2 text-right text-emerald-400">UP / EXP</th>
                <th class="py-1 px-2 text-right text-rose-400">DN / STALL</th>
                <th class="py-1 px-2 text-right text-amber-400">FLIPS</th>
                <th class="py-1 px-2 text-center text-slate-400">SPLIT</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/5">
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  bodyEl.innerHTML = (timeTableHtml ? timeTableHtml : '') + info.html;
}

// Intermarket Lead/Lag Modal Logic (Cleaned up: Silver only in 2-line row table format)
export function openLeadLagModal() {
  const modal = document.getElementById('leadLagModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  renderLeadLagTabs();
  renderLeadLagModalContent(window.__lastTelemetry);
}
window.openLeadLagModal = openLeadLagModal;

export function closeLeadLagModal() {
  const modal = document.getElementById('leadLagModal');
  if (modal) modal.classList.add('hidden');
}
window.closeLeadLagModal = closeLeadLagModal;

export function setLeadLagTab(tab) {
  // Tabs removed; stub kept for backwards compatibility
}
window.setLeadLagTab = setLeadLagTab;

export function onLeadAssetSelect(sym) {
  // Kept for backwards compatibility
}
window.onLeadAssetSelect = onLeadAssetSelect;

export function renderLeadLagTabs() {
  const row = document.getElementById('leadLagTabsRow');
  if (row) {
    row.innerHTML = '';
    row.classList.add('hidden');
  }
}

export function renderLeadLagModalContent(tel) {
  const body = document.getElementById('leadLagModalBody');
  if (!body) return;

  const data = tel || window.__lastTelemetry || {};
  const im = (data && data.intermarket) || {};
  const silver = (data && data.silver) || {};
  const spot = (data && data.spot) || {};
  const truth = (data && data.intermarket_truth) || {};
  const sat = (truth.satellite_correlations) || {};

  const xauPct = Number(silver.xau_pct !== undefined ? silver.xau_pct : (spot.xau_pct || 0.0));

  // Full 10 Intermarket Drivers
  const assetKeys = ['XAG', 'YLD', 'DXY', 'JPY', 'XPT', 'CPR', 'NDX', 'BTC', 'OIL', 'GOL'];

  const assetDetails = {
    'XAG': { name: 'SILVER', sym: 'XAGUSD', defBeta: 1.8 },
    'YLD': { name: 'US 10Y YIELD', sym: 'US10Y', defBeta: 1.2 },
    'DXY': { name: 'US DOLLAR', sym: 'DXY', defBeta: 1.0 },
    'JPY': { name: 'USD/JPY', sym: 'USDJPY', defBeta: 0.9 },
    'XPT': { name: 'PLATINUM', sym: 'XPTUSD', defBeta: 1.1 },
    'CPR': { name: 'COPPER', sym: 'XCUUSD', defBeta: 0.8 },
    'NDX': { name: 'NASDAQ 100', sym: 'US100', defBeta: 0.7 },
    'BTC': { name: 'BITCOIN', sym: 'BTCUSD', defBeta: 0.5 },
    'OIL': { name: 'CRUDE OIL', sym: 'USOIL', defBeta: 0.6 },
    'GOL': { name: 'GOLD SPOT', sym: 'XAUUSD', defBeta: 1.0 }
  };

  const rowsHtml = assetKeys.map(k => {
    const meta = assetDetails[k] || { name: k, sym: k, defBeta: 1.0 };
    const item = (k === 'GOL')
      ? { symbol: 'XAUUSD', name: 'GOLD SPOT', bid: (spot.bid || data.price || 0.0), pct: xauPct }
      : (im[k] || (k === 'XAG' ? { symbol: 'XAGUSD', name: 'SILVER', bid: silver.bid, pct: silver.xag_pct } : {}));

    // 1. Asset Name & Sym
    const assetName = meta.name;
    const assetSym = item.symbol || meta.sym;

    // 2. Quote (Bid)
    let bid = Number(item.bid || 0);
    if (k === 'XAG' && (!bid || isNaN(bid))) bid = Number(silver.bid || 0);
    let bidStr = '--';
    if (bid > 0) {
      if (bid >= 1000) bidStr = bid.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      else if (bid >= 10) bidStr = bid.toFixed(2);
      else bidStr = bid.toFixed(3);
    }

    // 3. Delta %
    let pct = 0.0;
    if (k === 'GOL') {
      pct = xauPct;
    } else if (k === 'XAG') {
      pct = Number(silver.xag_pct !== undefined ? silver.xag_pct : (item.pct || 0.0));
    } else {
      pct = Number(item.pct !== undefined ? item.pct : 0.0);
    }
    const sign = pct >= 0 ? '+' : '';
    const pCol = pct >= 0 ? 'text-emerald-400' : 'text-red-400';
    const deltaStr = `${sign}${pct.toFixed(2)}%`;

    // 4. Dist (vs XAU displacement score)
    const dispScore = calcShiftScore(k, pct, xauPct);
    const dispScoreStr = formatShiftScore(dispScore);
    const dispCol = dispScore > 0 ? 'text-emerald-300' : (dispScore < 0 ? 'text-red-300' : 'text-slate-400');

    // 5. R Value (r30 rolling correlation)
    let rVal = null;
    if (k === 'GOL') {
      rVal = 1.0;
    } else if (k === 'XAG') {
      const silSat = sat.SIL || {};
      const r30 = silSat.r30 !== undefined ? silSat.r30 : (silver.r30 !== undefined ? silver.r30 : item.r30);
      rVal = (r30 !== undefined && r30 !== null) ? Number(r30) : null;
    } else {
      const satItem = sat[k] || sat[meta.name] || {};
      const r30 = satItem.r30 !== undefined ? satItem.r30 : item.r30;
      rVal = (r30 !== undefined && r30 !== null) ? Number(r30) : null;
    }
    const rStr = rVal !== null ? `${rVal >= 0 ? '+' : ''}${rVal.toFixed(2)}` : '--';
    const rCol = rVal !== null && (Math.abs(rVal) >= 0.70) ? 'text-emerald-400' : (rVal !== null && Math.abs(rVal) >= 0.30 ? 'text-amber-400' : 'text-slate-400');

    // 6. Beta Velocity (vel_beta)
    let velBeta = null;
    if (k === 'GOL') {
      velBeta = 1.0;
    } else if (k === 'XAG') {
      const silSat = sat.SIL || {};
      velBeta = silSat.vel_beta !== undefined ? silSat.vel_beta : (silver.vel_beta || silver.beta_ratio || item.vel_beta || meta.defBeta);
    } else {
      const satItem = sat[k] || {};
      velBeta = satItem.vel_beta !== undefined ? satItem.vel_beta : (item.vel_beta || meta.defBeta);
    }
    const bVal = (velBeta !== undefined && velBeta !== null) ? Number(velBeta) : null;
    const bStr = bVal !== null ? `${bVal.toFixed(1)}x` : '--';

    return `
      <tr class="hover:bg-slate-900/50 transition">
        <td class="py-2.5 px-3">
          <div class="font-black text-amber-300 text-xs">${assetName}</div>
          <div class="text-[9.5px] text-slate-400">${assetSym}</div>
        </td>
        <td class="py-2.5 px-3 text-right font-mono">
          <div class="font-black text-slate-100 text-xs">${bidStr}</div>
          <div class="text-[9.5px] text-slate-500">BID</div>
        </td>
        <td class="py-2.5 px-3 text-right font-mono">
          <div class="font-black text-xs ${pCol}">${deltaStr}</div>
          <div class="text-[9.5px] text-slate-500">24H %</div>
        </td>
        <td class="py-2.5 px-3 text-right font-mono">
          <div class="font-black text-xs ${dispCol}">${dispScoreStr}</div>
          <div class="text-[9.5px] text-slate-500">VS XAU</div>
        </td>
        <td class="py-2.5 px-3 text-right font-mono">
          <div class="font-black text-xs ${rCol}">${rStr}</div>
          <div class="text-[9.5px] text-slate-500">r₃₀</div>
        </td>
        <td class="py-2.5 px-3 text-right font-mono">
          <div class="font-black text-xs text-cyan-300">${bStr}</div>
          <div class="text-[9.5px] text-slate-500">β VEL</div>
        </td>
      </tr>
    `;
  }).join('');

  body.innerHTML = `
    <div class="overflow-x-auto rounded-xl border border-white/10 bg-slate-950/80 shadow-lg">
      <table class="w-full text-left font-mono">
        <thead class="bg-slate-900/90 text-slate-400 text-[10px] uppercase border-b border-white/10 tracking-wider sticky top-0 backdrop-blur z-10">
          <tr>
            <th class="py-2.5 px-3">ASSET</th>
            <th class="py-2.5 px-3 text-right">QUOTE</th>
            <th class="py-2.5 px-3 text-right">DELTA</th>
            <th class="py-2.5 px-3 text-right">DIST</th>
            <th class="py-2.5 px-3 text-right">R VALUE</th>
            <th class="py-2.5 px-3 text-right">BETA VEL</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/5">
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}


// Macro News Dossier Modal Logic
export function toggleMacroNewsModal() {
  const modal = document.getElementById('macroNewsDetailsModal');
  if (!modal) return;
  if (modal.classList.contains('hidden')) {
    modal.classList.remove('hidden');
    renderMacroNewsModalContent();
  } else {
    modal.classList.add('hidden');
  }
}
window.toggleMacroNewsModal = toggleMacroNewsModal;

// Helper to format timestamps to IST (Indian Standard Time, UTC+5:30)
function formatUtcToIst(val) {
  if (!val) return 'Live Active Session';
  try {
    let d;
    if (typeof val === 'number') {
      d = new Date(val > 1e11 ? val : val * 1000);
    } else if (typeof val === 'string') {
      const clean = val.replace(' UTC', 'Z').replace(' ', 'T');
      d = new Date(clean);
      if (isNaN(d.getTime())) {
        d = new Date(val);
      }
    } else {
      d = new Date();
    }
    if (isNaN(d.getTime())) return String(val);

    const dateStr = d.toLocaleDateString('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
    const timeStr = d.toLocaleTimeString('en-US', {
      timeZone: 'Asia/Kolkata',
      hour12: true,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    return `${dateStr} · ${timeStr} IST`;
  } catch (e) {
    return String(val);
  }
}

export function renderMacroNewsModalContent() {
  const body = document.getElementById('macroNewsModalBody');
  if (!body) return;

  const tel = window.__lastTelemetry || {};
  const sent = tel.macro_sentiment || {};
  const macro = tel.macro || {};

  // 1. Recorded Time in IST by OpenCode Session
  const istTimeStr = sent.updated_at_ist || formatUtcToIst(sent.updated_at || sent.updated_at_utc);
  const sourceDesk = sent.source || 'OpenCode Escanor CIO Desk';

  // 2. Current Hour (1H) Sentiment & Percentages
  const curH = sent.current_hour || {};
  const rawBull = (curH.bull_pct !== undefined && curH.bull_pct !== null) ? Number(curH.bull_pct) : ((sent.bull_pct !== undefined && sent.bull_pct !== null) ? Number(sent.bull_pct) : null);
  const rawBear = (curH.bear_pct !== undefined && curH.bear_pct !== null) ? Number(curH.bear_pct) : ((sent.bear_pct !== undefined && sent.bear_pct !== null) ? Number(sent.bear_pct) : null);
  const hasSentiment = rawBull !== null && rawBear !== null && !isNaN(rawBull) && !isNaN(rawBear);
  let bullPct = 0;
  let bearPct = 0;
  if (hasSentiment) {
    const tot = (rawBull + rawBear) > 0 ? (rawBull + rawBear) : 100;
    bullPct = Math.round((rawBull / tot) * 100);
    bearPct = 100 - bullPct;
  }
  const isBull = hasSentiment && bullPct >= bearPct;
  const bias = hasSentiment ? (isBull ? 'BULLISH' : 'BEARISH') : '--';
  const catalystSummary = curH.summary || sent.catalyst_summary || (hasSentiment ? '' : 'Awaiting OpenCode session authoring...');

  const biasBadgeColor = bias === 'BULLISH'
    ? 'bg-emerald-950 text-emerald-300 border-emerald-500/60 shadow-[0_0_10px_rgba(16,185,129,0.3)]'
    : (bias === 'BEARISH'
        ? 'bg-red-950 text-red-300 border-red-500/60 shadow-[0_0_10px_rgba(239,68,68,0.3)]'
        : 'bg-slate-900 text-slate-400 border-white/10');

  // 3. Upcoming Hour (+1H) Forward Session Horizon
  const nextH = sent.next_hour || {};
  const rawNextBull = (nextH.bull_pct !== undefined && nextH.bull_pct !== null) ? Number(nextH.bull_pct) : ((sent.next_hour_bull_pct !== undefined && sent.next_hour_bull_pct !== null) ? Number(sent.next_hour_bull_pct) : null);
  const rawNextBear = (nextH.bear_pct !== undefined && nextH.bear_pct !== null) ? Number(nextH.bear_pct) : ((sent.next_hour_bear_pct !== undefined && sent.next_hour_bear_pct !== null) ? Number(sent.next_hour_bear_pct) : null);
  const hasNextSentiment = rawNextBull !== null && rawNextBear !== null && !isNaN(rawNextBull) && !isNaN(rawNextBear);
  let nextBullPct = 0;
  let nextBearPct = 0;
  if (hasNextSentiment) {
    const totNext = (rawNextBull + rawNextBear) > 0 ? (rawNextBull + rawNextBear) : 100;
    nextBullPct = Math.round((rawNextBull / totNext) * 100);
    nextBearPct = 100 - nextBullPct;
  }
  const isNextBull = hasNextSentiment && nextBullPct >= nextBearPct;
  const nextBias = hasNextSentiment ? (isNextBull ? 'BULLISH' : 'BEARISH') : '--';
  const nextSummary = nextH.summary || sent.next_hour_summary || (hasNextSentiment ? '' : 'Awaiting OpenCode session authoring...');
  const nextBiasBadgeColor = nextBias === 'BULLISH'
    ? 'bg-emerald-950 text-emerald-300 border-emerald-500/50'
    : (nextBias === 'BEARISH'
        ? 'bg-red-950 text-red-300 border-red-500/50'
        : 'bg-slate-900 text-slate-400 border-white/10');

  // 4. Macro Yields
  const dfii10 = sent.dfii10 || (macro.dfii10_real_yield ? macro.dfii10_real_yield + '%' : '--');
  const us10y = sent.us10y || (macro.us10y_nominal ? macro.us10y_nominal + '%' : '--');
  const dxy = sent.dxy || (macro.dxy_index ? String(macro.dxy_index) : '--');
  const nextNewsTitle = macro.next_event_title || '--';
  const minsToNews = macro.mins_to_news !== undefined && macro.mins_to_news !== null ? `${macro.mins_to_news}m` : '--';

  // 5. OpenCode Session Market-Moving Headlines
  const sessionHeadlines = sent.headlines || [];
  let headlinesHtml = '';
  if (sessionHeadlines.length > 0) {
    headlinesHtml = sessionHeadlines.map(h => {
      const text = h.text || h.title || h.headline || '';
      const src = h.source || 'WIRE';
      const dir = String(h.direction || h.sentiment || 'NEUTRAL').toUpperCase();
      const isHBul = dir.includes('BULL');
      const isHBea = dir.includes('BEAR');
      const hBadge = isHBul 
        ? 'bg-emerald-950 text-emerald-300 border-emerald-500/60' 
        : (isHBea ? 'bg-red-950 text-red-300 border-red-500/60' : 'bg-slate-900 text-slate-300 border-white/10');
      const hIcon = isHBul ? '🟢 BULL' : (isHBea ? '🔴 BEAR' : '⚪ NEUTRAL');

      return `
        <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/5 space-y-1 hover:border-white/10 transition">
          <div class="flex items-center justify-between text-[10px]">
            <span class="text-amber-400 font-bold tracking-wider">${src}</span>
            <span class="px-1.5 py-0.2 rounded text-[9.5px] font-black border ${hBadge}">${hIcon}</span>
          </div>
          <div class="text-[12px] text-slate-200 font-medium leading-snug">${text}</div>
        </div>
      `;
    }).join('');
  } else {
    headlinesHtml = `<div class="p-3 text-center text-slate-400 bg-slate-900/60 rounded-xl text-xs">Awaiting breaking headlines from next session scan...</div>`;
  }

  // 6. Real-Time Live World Event Wires (Streaming News Feed)
  const liveEvents = tel.live_world_events || [];
  let liveEventsHtml = '';
  if (liveEvents.length > 0) {
    liveEventsHtml = liveEvents.slice(0, 10).map(ev => {
      const cat = ev.category || 'MACRO';
      let catCol = 'bg-slate-800 text-slate-300 border-white/10';
      if (cat === 'MACRO') catCol = 'bg-amber-950/80 text-amber-300 border-amber-500/50';
      else if (cat === 'MICRO') catCol = 'bg-cyan-950/80 text-cyan-300 border-cyan-500/50';
      else if (cat === 'COMMODITY') catCol = 'bg-purple-950/80 text-purple-300 border-purple-500/50';

      const mins = ev.minutes_ago !== undefined ? `${Math.round(ev.minutes_ago)}m ago` : 'Live';

      return `
        <div class="p-2.5 rounded-xl bg-slate-950/80 border border-white/5 space-y-1 hover:border-amber-500/30 transition">
          <div class="flex items-center justify-between text-[10px]">
            <div class="flex items-center gap-1.5">
              <span class="px-1.5 py-0.2 rounded text-[9px] font-black uppercase border ${catCol}">${cat}</span>
              <span class="text-slate-400 font-bold">${ev.source || 'Wire'}</span>
            </div>
            <span class="text-slate-400 font-mono text-[9.5px]">${mins}</span>
          </div>
          <div class="text-[11.5px] text-slate-100 font-medium leading-snug">${ev.title || ''}</div>
          ${ev.summary ? `<div class="text-[10.5px] text-slate-400 leading-tight">${ev.summary}</div>` : ''}
          ${ev.link ? `<div class="pt-0.5"><a href="${ev.link}" target="_blank" class="text-[10px] text-amber-400/90 hover:text-amber-300 underline font-mono">Read Wire Source →</a></div>` : ''}
        </div>
      `;
    }).join('');
  }

  body.innerHTML = `
    <div class="space-y-3 font-mono">
      <!-- 1. OpenCode Session Recorded Timestamp in IST Banner -->
      <div class="p-3 rounded-xl bg-gradient-to-r from-amber-950/40 via-slate-900/90 to-slate-950 border border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.15)] flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-2">
          <span class="text-lg">🕒</span>
          <div>
            <div class="text-[9.5px] text-amber-400/80 font-bold uppercase tracking-wider">RECORDED BY OPENCODE SESSION (IST)</div>
            <div class="text-xs sm:text-sm font-black text-amber-300 font-mono tracking-tight">${istTimeStr}</div>
          </div>
        </div>
        <div class="text-right">
          <span class="px-2 py-0.5 rounded bg-amber-500 text-black font-black text-[9.5px] uppercase tracking-wider shadow">
            ${sourceDesk}
          </span>
        </div>
      </div>

      <!-- 2. Current Hour (1H) Macro Sentiment & Probability Gauge -->
      <div class="p-3.5 rounded-xl bg-slate-900/90 border border-white/10 space-y-2.5">
        <div class="flex items-center justify-between border-b border-white/5 pb-2">
          <div class="flex items-center gap-1.5">
            <span class="text-sm">⚡</span>
            <span class="text-xs font-black text-slate-100 uppercase tracking-wide">CURRENT HOUR (1H) MACRO SENTIMENT</span>
          </div>
          <span class="px-2 py-0.5 rounded text-[10px] font-black uppercase border ${biasBadgeColor}">
            ${bias}
          </span>
        </div>

        <!-- Bull vs Bear Percentages Visual Ratio Bar -->
        <div class="space-y-1">
          <div class="flex items-center justify-between text-xs font-black">
            <span class="text-emerald-400 flex items-center gap-1">
              <span>BULL:</span>
              <span class="text-emerald-300 text-sm">${hasSentiment ? bullPct.toFixed(1) + '%' : '--%'}</span>
            </span>
            <span class="text-red-400 flex items-center gap-1">
              <span class="text-red-300 text-sm">${hasSentiment ? bearPct.toFixed(1) + '%' : '--%'}</span>
              <span>:BEAR</span>
            </span>
          </div>
          <div class="h-2.5 w-full bg-slate-950 rounded-full overflow-hidden flex border border-white/10 shadow-inner">
            <div class="bg-gradient-to-r from-emerald-600 to-emerald-400 h-full transition-all duration-300" style="width: ${bullPct}%;"></div>
            <div class="bg-gradient-to-r from-red-500 to-red-600 h-full transition-all duration-300" style="width: ${bearPct}%;"></div>
          </div>
        </div>

        <!-- OpenCode Catalyst Narrative Summary -->
        <div class="p-2.5 rounded-lg bg-black/40 border border-white/5 text-[11.5px] text-slate-200 leading-relaxed font-sans">
          <strong class="text-amber-300 font-mono text-[10.5px]">CIO MACRO CAUSALITY:</strong> ${catalystSummary}
        </div>
      </div>

      <!-- 3. Upcoming Hour (+1H) Forward Session Projection -->
      <div class="p-3 rounded-xl bg-slate-900/70 border border-white/10 space-y-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <span class="text-xs">🔮</span>
            <span class="text-[11px] font-bold text-slate-300 uppercase tracking-wide">+1H FORWARD SESSION HORIZON</span>
          </div>
          <span class="px-1.5 py-0.2 rounded text-[9.5px] font-bold uppercase border ${nextBiasBadgeColor}">
            ${nextBias}
          </span>
        </div>
        <div class="space-y-1">
          <div class="flex items-center justify-between text-[11px] font-bold">
            <span class="text-emerald-400">${hasNextSentiment ? nextBullPct.toFixed(0) + '% Bull' : '--% Bull'}</span>
            <span class="text-red-400">${hasNextSentiment ? nextBearPct.toFixed(0) + '% Bear' : '--% Bear'}</span>
          </div>
          <div class="h-1.5 w-full bg-slate-950 rounded-full overflow-hidden flex border border-white/10">
            <div class="bg-emerald-500 h-full" style="width: ${nextBullPct}%;"></div>
            <div class="bg-red-500 h-full" style="width: ${nextBearPct}%;"></div>
          </div>
        </div>
        <div class="text-[11px] text-slate-400 leading-tight font-sans">${nextSummary}</div>
      </div>

      <!-- 4. Sovereign Macro Yields Transmission Matrix -->
      <div class="p-3 rounded-xl bg-slate-900/80 border border-white/10 space-y-2">
        <div class="text-[10px] font-bold text-amber-400 uppercase tracking-wider">🏛️ SOVEREIGN TRANSMISSION HUD</div>
        <div class="grid grid-cols-4 gap-1.5 text-center font-mono">
          <div class="p-1.5 rounded-lg bg-slate-950 border border-white/5">
            <div class="text-[8.5px] text-slate-400">DFII10 REAL</div>
            <div class="text-xs font-black text-amber-300">${dfii10}</div>
          </div>
          <div class="p-1.5 rounded-lg bg-slate-950 border border-white/5">
            <div class="text-[8.5px] text-slate-400">US10Y NOM</div>
            <div class="text-xs font-black text-slate-200">${us10y}</div>
          </div>
          <div class="p-1.5 rounded-lg bg-slate-950 border border-white/5">
            <div class="text-[8.5px] text-slate-400">DXY INDEX</div>
            <div class="text-xs font-black text-slate-200">${dxy}</div>
          </div>
          <div class="p-1.5 rounded-lg bg-slate-950 border border-white/5">
            <div class="text-[8.5px] text-slate-400">EVENT LOCK</div>
            <div class="text-xs font-black text-red-400">${minsToNews}</div>
          </div>
        </div>
      </div>

      <!-- 5. OpenCode Session Market-Moving Headlines -->
      <div class="space-y-2">
        <div class="flex items-center justify-between text-[11px] font-bold text-slate-300">
          <span class="flex items-center gap-1">
            <span>📰 MARKET-MOVING HEADLINES</span>
            <span class="text-slate-500 font-normal">(${sessionHeadlines.length} Published)</span>
          </span>
          <span class="text-[9.5px] text-amber-300 font-mono">DIRECT IMPACT</span>
        </div>
        <div class="space-y-1.5">${headlinesHtml}</div>
      </div>

      <!-- 6. Real-Time Live World Event Wires (Streaming Feed) -->
      ${liveEventsHtml ? `
        <div class="space-y-2 pt-1 border-t border-white/5">
          <div class="flex items-center justify-between text-[11px] font-bold text-slate-300">
            <span class="flex items-center gap-1">
              <span>📡 REAL-TIME BREAKING WIRES</span>
              <span class="text-slate-500 font-normal">(${liveEvents.length} Active Feeds)</span>
            </span>
            <span class="text-[9.5px] text-emerald-400 font-mono">30s LIVE POLL</span>
          </div>
          <div class="space-y-2 max-h-[320px] overflow-y-auto custom-scrollbar pr-1">${liveEventsHtml}</div>
        </div>
      ` : ''}
    </div>
  `;
}

// =========================================================================
// ⏱️ ACTIVE TRADE AUTO-CLOSE TIMER MANAGEMENT
// =========================================================================
let currentEditTimerTicket = null;
let currentEditTimerMins = 5;

export function openEditTradeTimerModal(ticket, mins = 0, remSec = 0, isPending = false) {
  currentEditTimerTicket = Number(ticket);
  currentEditTimerMins = mins > 0 ? Number(mins) : 5;

  const modal = document.getElementById('editTradeTimerModal');
  if (!modal) return;

  const titleSub = document.getElementById('editTimerModalSubtitle');
  if (titleSub) {
    titleSub.textContent = `${isPending ? 'PENDING ORDER' : 'ACTIVE POSITION'} #${ticket}`;
  }

  const statusBadge = document.getElementById('editTimerStatusBadge');
  const detailLabel = document.getElementById('editTimerDetailLabel');
  if (statusBadge) {
    if (remSec > 0) {
      const rm = Math.floor(remSec / 60);
      const rs = remSec % 60;
      statusBadge.textContent = `⏳ ${rm}m ${String(rs).padStart(2, '0')}s remaining`;
      statusBadge.className = 'font-black text-rose-300 font-mono';
    } else if (mins > 0) {
      statusBadge.textContent = `⏳ ${mins}m configured (waiting)`;
      statusBadge.className = 'font-black text-amber-300 font-mono';
    } else {
      statusBadge.textContent = 'Off (No timer)';
      statusBadge.className = 'font-bold text-slate-400 font-mono';
    }
  }
  if (detailLabel) {
    detailLabel.textContent = isPending
      ? 'Timer will activate countdown immediately once order fills on MT5.'
      : 'Position will automatically exit at market upon timer expiration.';
  }

  const inputEl = document.getElementById('editTimerInputMins');
  if (inputEl) inputEl.value = currentEditTimerMins;

  const valBadge = document.getElementById('editTimerNewValBadge');
  if (valBadge) valBadge.textContent = `${currentEditTimerMins} mins`;

  modal.classList.remove('hidden');
}
window.openEditTradeTimerModal = openEditTradeTimerModal;

export function closeEditTradeTimerModal() {
  const modal = document.getElementById('editTradeTimerModal');
  if (modal) modal.classList.add('hidden');
  currentEditTimerTicket = null;
}
window.closeEditTradeTimerModal = closeEditTradeTimerModal;

export function adjustEditTimerMins(delta) {
  currentEditTimerMins = Math.max(1, Math.min(1440, currentEditTimerMins + delta));
  const inputEl = document.getElementById('editTimerInputMins');
  if (inputEl) inputEl.value = currentEditTimerMins;
  const valBadge = document.getElementById('editTimerNewValBadge');
  if (valBadge) valBadge.textContent = `${currentEditTimerMins} mins`;
}
window.adjustEditTimerMins = adjustEditTimerMins;

export function setEditTimerPreset(mins) {
  currentEditTimerMins = Math.max(1, Math.min(1440, Number(mins) || 5));
  const inputEl = document.getElementById('editTimerInputMins');
  if (inputEl) inputEl.value = currentEditTimerMins;
  const valBadge = document.getElementById('editTimerNewValBadge');
  if (valBadge) valBadge.textContent = `${currentEditTimerMins} mins`;
}
window.setEditTimerPreset = setEditTimerPreset;

export function onEditTimerInputChange(val) {
  currentEditTimerMins = Math.max(0, Math.min(1440, Number(val) || 0));
  const valBadge = document.getElementById('editTimerNewValBadge');
  if (valBadge) {
    valBadge.textContent = currentEditTimerMins > 0 ? `${currentEditTimerMins} mins` : 'Off (Cancel)';
  }
}
window.onEditTimerInputChange = onEditTimerInputChange;

export async function quickCancelTradeTimer(e, ticket) {
  if (e && e.stopPropagation) e.stopPropagation();
  try {
    const resp = await fetch('/api/trade/auto_close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: Number(ticket), mins: 0, symbol: 'XAUUSD' })
    });
    const res = await resp.json();
    if (res.status === 'OK') {
      showTerminalToast(`⏱️ Auto-close cancelled for #${ticket}`, 'success');
      // Optimistically update memory
      if (window.__lastTelemetry && window.__lastTelemetry.active_positions) {
        const pos = window.__lastTelemetry.active_positions.find(p => Number(p.ticket) === Number(ticket));
        if (pos) {
          pos.auto_close_mins = null;
          pos.auto_close_rem_sec = null;
        }
      }
      if (window.__lastTelemetry && window.__lastTelemetry.pending_orders) {
        const ord = window.__lastTelemetry.pending_orders.find(o => Number(o.ticket) === Number(ticket));
        if (ord) ord.auto_close_mins = null;
      }
      if (typeof window.renderActiveTradesUI === 'function') {
        window.renderActiveTradesUI(window.__lastTelemetry);
      }
      if (typeof window.fetchTelemetrySnapshot === 'function') {
        window.fetchTelemetrySnapshot();
      }
    } else {
      showTerminalToast(`❌ Cancel failed: ${res.message || 'Error'}`, 'error');
    }
  } catch (err) {
    showTerminalToast(`❌ Cancel error: ${err.message}`, 'error');
  }
}
window.quickCancelTradeTimer = quickCancelTradeTimer;

export async function submitCancelTradeTimer() {
  if (!currentEditTimerTicket) return;
  const btn = document.getElementById('btnCancelTradeTimer');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'CANCELLING...';
  }
  await quickCancelTradeTimer(null, currentEditTimerTicket);
  closeEditTradeTimerModal();
  if (btn) {
    btn.disabled = false;
    btn.textContent = '❌ CANCEL TIMER';
  }
}
window.submitCancelTradeTimer = submitCancelTradeTimer;

export async function submitUpdateTradeTimer() {
  if (!currentEditTimerTicket) return;
  const inputEl = document.getElementById('editTimerInputMins');
  const mins = Math.max(0, Math.min(1440, Number(inputEl ? inputEl.value : 0) || 0));

  if (mins <= 0) {
    return submitCancelTradeTimer();
  }

  const btn = document.getElementById('btnUpdateTradeTimer');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'SAVING...';
  }

  try {
    const resp = await fetch('/api/trade/auto_close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: Number(currentEditTimerTicket), mins: mins, symbol: 'XAUUSD' })
    });
    const res = await resp.json();
    if (res.status === 'OK') {
      showTerminalToast(`⏱️ Auto-close set to ${mins}m for #${currentEditTimerTicket}`, 'success');
      closeEditTradeTimerModal();
      // Optimistically update memory
      if (window.__lastTelemetry && window.__lastTelemetry.active_positions) {
        const pos = window.__lastTelemetry.active_positions.find(p => Number(p.ticket) === Number(currentEditTimerTicket));
        if (pos) {
          pos.auto_close_mins = mins;
          pos.auto_close_rem_sec = Math.round(mins * 60);
        }
      }
      if (window.__lastTelemetry && window.__lastTelemetry.pending_orders) {
        const ord = window.__lastTelemetry.pending_orders.find(o => Number(o.ticket) === Number(currentEditTimerTicket));
        if (ord) ord.auto_close_mins = mins;
      }
      if (typeof window.renderActiveTradesUI === 'function') {
        window.renderActiveTradesUI(window.__lastTelemetry);
      }
      if (typeof window.fetchTelemetrySnapshot === 'function') {
        window.fetchTelemetrySnapshot();
      }
    } else {
      showTerminalToast(`❌ Update failed: ${res.message || 'Error'}`, 'error');
    }
  } catch (err) {
    showTerminalToast(`❌ Update error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '💾 SET TIMER';
    }
  }
}
window.submitUpdateTradeTimer = submitUpdateTradeTimer;
