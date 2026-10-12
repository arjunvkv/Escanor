/**
 * Escanor — TradingView Terminal Main Application
 * Boots chart engine, connects live MT5 WebSocket tick stream,
 * restores server drawings, and powers the top ribbon and quick order pad.
 */

import { initTradingViewChart, startCandleCountdown } from './tv_chart_engine.js?v=202610130040';
import { initToolbar, showTvConfirm, evaluateRectangleAlarms, evaluatePositionTriggers, evaluateVerticalLineAlarms } from './toolbar.js?v=202610130040';
import { fetchServerDrawings, restoreDrawings, showChartToast, syncDrawingsToServer } from './drawings_storage.js?v=202610130040';
import { ActiveOrdersEngine } from './active_orders_engine.js?v=202610130040';
import { LineTradingManager } from './line_trading.js?v=202610130040';
import { StructuralLevelsEngine } from './structural_levels_engine.js?v=202610130040';

let chart = null;
let currentSymbol = 'XAUUSD';
let currentTimeframeMinutes = 5;
let wsConn = null;
let liveBarCallback = null;
let lastKnownSpot = null;
let activeOrders = null;
let lineTrading = null;
let structuralLevels = null;

const TF_MAP = {
  '1': { mult: 1, type: 'minute', span: 1, label: '1m' },
  '5': { mult: 5, type: 'minute', span: 5, label: '5m' },
  '15': { mult: 15, type: 'minute', span: 15, label: '15m' },
  '60': { mult: 60, type: 'minute', span: 60, label: '1h' },
  '240': { mult: 240, type: 'minute', span: 240, label: '4h' },
  '1440': { mult: 1440, type: 'minute', span: 1440, label: 'D' }
};

const MAX_HISTORY_MS = 15 * 24 * 60 * 60 * 1000; // Max 15 days of historical candles

function getInitialCandleCount(tfMinutes) {
  const tf = Number(tfMinutes) || 5;
  const twoDaysMinutes = 2 * 24 * 60; // 2880 mins
  const bars = Math.ceil(twoDaysMinutes / tf);
  // Ensure enough bars to comfortably fill wide screens without reaching edge on boot
  if (tf >= 1440) return 300;
  if (tf >= 240) return 400;
  if (tf >= 60) return 600;
  return Math.max(bars, 800);
}

let hasReachedStart = false;
let chartReady = false;

async function init() {
  window.__pageBootTime = Date.now();
  console.log('[Escanor TV] Initializing TradingView terminal...');

  // 1. Initialize Chart
  chart = initTradingViewChart('klineChart');
  if (!chart) return;
  window.__chart = chart;

  window.__currentTimeframeMinutes = currentTimeframeMinutes;

  // 2. Set Symbol and Period
  chart.setSymbol({ ticker: currentSymbol, name: 'Gold Spot' });
  chart.setPeriod({ type: 'minute', span: currentTimeframeMinutes });

  // 3. Initialize Line Trading & Active Orders Engines
  lineTrading = new LineTradingManager({
    chartEngine: { chart },
    symbol: currentSymbol,
    hudContainerId: 'tvLineTradingHud',
    modalId: 'tvLineTradingModal'
  });
  window.__lineTradingManager = lineTrading;

  activeOrders = new ActiveOrdersEngine({
    chartEngine: { chart },
    symbol: currentSymbol
  });
  window.__activeOrdersEngine = activeOrders;

  structuralLevels = new StructuralLevelsEngine({
    chartEngine: { chart }
  });

  // 4. Setup Data Loader (Clean Initial Load, Zero Auto-Looping)
  chart.setDataLoader({
    getBars: async ({ symbol, period, callback }) => {
      try {
        const tf = period?.multiplier || currentTimeframeMinutes;
        window.__currentTimeframeMinutes = tf;

        // Fetch generous initial candle data (2-day minimum 800 bars)
        const initialCount = getInitialCandleCount(tf);
        const res = await fetch(`/api/candles?symbol=${symbol.ticker}&timeframe=${tf}&count=${initialCount}`);
        const json = await res.json();
        const candles = json.candles || [];

        // hasMore is strictly FALSE to prevent KLineCharts from ever auto-fetching in a loop!
        callback(candles, false);

        setTimeout(() => {
          if (chart) {
            chart.setBarSpace(6.0);
            chart.setOffsetRightDistance(80);
            chart.scrollToRealTime();
          }
        }, 50);
      } catch (err) {
        console.error('[Escanor TV] Failed to load candles:', err);
        callback([], false);
      }
    },
    subscribeBar: ({ callback }) => {
      liveBarCallback = callback;
    },
    unsubscribeBar: () => {
      liveBarCallback = null;
    }
  });

  // 4b. Setup Historical Auto-Fill on Scroll Left (TradingView style)
  let isBackfilling = false;
  let lastBackfillTime = 0;

  setTimeout(() => { chartReady = true; }, 1200);

  chart.subscribeAction('onVisibleRangeChange', async (range) => {
    // 1. Initial lock to ensure chart has rendered and settled
    if (!chartReady || !range) return;
    // 2. Only trigger when user has scrolled near the left edge (within 25 bars of oldest loaded bar)
    if (range.from > 25) return;
    if (isBackfilling || hasReachedStart) return;

    const now = Date.now();
    if (now - lastBackfillTime < 600) return; // 600ms cooldown

    const currentBars = chart.getDataList() || [];
    if (currentBars.length === 0) return;

    const oldestBar = currentBars[0];
    const earliestAllowedTime = now - MAX_HISTORY_MS;

    // Boundary check: already reached max 15 days history
    if (oldestBar.timestamp <= earliestAllowedTime) {
      hasReachedStart = true;
      return;
    }

    isBackfilling = true;
    lastBackfillTime = now;

    try {
      const tf = window.__currentTimeframeMinutes || currentTimeframeMinutes;
      const res = await fetch(`/api/candles?symbol=${currentSymbol}&timeframe=${tf}&count=300&end_time=${oldestBar.timestamp}`);
      const json = await res.json();
      let olderCandles = json.candles || [];

      // Clamp to max 15 days
      olderCandles = olderCandles.filter(c => c.timestamp >= earliestAllowedTime);

      if (olderCandles.length > 0) {
        const cs = chart._chartStore || (typeof chart.getChartStore === 'function' ? chart.getChartStore() : null);
        if (cs && typeof cs._addData === 'function') {
          // Compensate scroll offset on the chart store BEFORE prepending
          const currentDiff = typeof cs.getLastBarRightSideDiffBarCount === 'function' ? cs.getLastBarRightSideDiffBarCount() : 0;
          if (typeof cs.setLastBarRightSideDiffBarCount === 'function') {
            cs.setLastBarRightSideDiffBarCount(currentDiff - olderCandles.length);
          }
          // Prepend older candles cleanly
          cs._addData(olderCandles, 'forward', false);
          console.log(`[Escanor TV] Backfilled ${olderCandles.length} candles. Total in chart: ${chart.getDataList().length}`);
        }
      } else {
        hasReachedStart = true;
      }
    } catch (e) {
      console.warn('[Escanor TV] Failed to backfill older candles:', e);
    } finally {
      isBackfilling = false;
    }
  });

  // 5. Start Countdown Timer
  startCandleCountdown(currentTimeframeMinutes);

  // 6. Initialize Left Toolbar
  initToolbar(chart, currentSymbol);

  // 7. Restore Server-Side Drawings
  try {
    const savedDrawings = await fetchServerDrawings(currentSymbol);
    if (savedDrawings && savedDrawings.length > 0) {
      restoreDrawings(chart, savedDrawings);
      console.log(`[Escanor TV] Restored ${savedDrawings.length} drawing(s) from server`);

      // Register restored line overlays (vertical lines are time markers, not execution lines)
      const allOverlays = chart.getOverlays() || [];
      const lineTypes = ['segment', 'rayLine', 'straightLine', 'horizontalStraightLine'];
      for (const ov of allOverlays) {
        if (lineTypes.includes(ov.name)) {
          lineTrading.registerLineOverlay(ov, ov.name);
        }
      }
      lineTrading.reconcileWithChart(allOverlays);
    } else {
      lineTrading.reconcileWithChart([]);
    }
  } catch (err) {
    console.warn('[Escanor TV] Error restoring server drawings:', err);
  }

  // 8. Setup Timeframe Buttons
  setupTimeframeButtons();

  // 9. Setup Quick Buy / Sell Pad
  setupQuickOrderPad();

  // 10. Connect Real-time MT5 WebSocket
  connectWebSocket();

  // 11. Window Resize Handler
  window.addEventListener('resize', () => {
    if (chart) chart.resize();
  });

  // Fullscreen button
  document.getElementById('tvFullscreenBtn')?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });

  // Reset zoom button
  document.getElementById('tvResetZoomBtn')?.addEventListener('click', () => {
    if (chart) {
      chart.setBarSpace(6.0);
      chart.setOffsetRightDistance(80);
      chart.scrollToRealTime();
    }
  });
}

function setupTimeframeButtons() {
  document.querySelectorAll('.tv-tf-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tfKey = btn.getAttribute('data-tf');
      const tfCfg = TF_MAP[tfKey];
      if (!tfCfg) return;

      document.querySelectorAll('.tv-tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      currentTimeframeMinutes = tfCfg.mult;
      window.__currentTimeframeMinutes = currentTimeframeMinutes;
      chart.setPeriod({ type: tfCfg.type, span: tfCfg.span });
      startCandleCountdown(currentTimeframeMinutes);

      // Re-populate chart data with initial load
      hasReachedStart = false;
      chartReady = false;
      setTimeout(() => { chartReady = true; }, 1200);
      chart.resetData(() => {});
    });
  });
}

function setupQuickOrderPad() {
  const sellBtn = document.getElementById('tvQuickSellBtn');
  const buyBtn = document.getElementById('tvQuickBuyBtn');

  sellBtn?.addEventListener('click', () => {
    const lot = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : 1.0;
    showTvConfirm('Market Execution', `Execute MARKET SELL ${lot.toFixed(2)} lot on ${currentSymbol}?`, async () => {
      try {
        sellBtn.disabled = true;
        const curBid = lastKnownSpot?.bid || 0;
        const slVal = curBid > 0 ? Math.round((curBid + 6.0) * 100) / 100 : undefined;
        const tpVal = curBid > 0 ? Math.round((curBid - 12.0) * 100) / 100 : undefined;
        const res = await fetch('/api/trade/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: currentSymbol,
            side: 'SELL',
            volume: lot,
            sl: slVal,
            tp: tpVal
          })
        });
        const data = await res.json();
        const isSuccess = data && (data.status === 'EXECUTED' || data.status === 'OK' || (data.ticket && !data.error && data.status !== 'FAILED'));
        if (isSuccess) {
          const t = data.ticket || data.order;
          if (t && slVal && tpVal) {
            if (!window.__activeTradesSlTp) window.__activeTradesSlTp = {};
            window.__activeTradesSlTp[t] = { sl: slVal, tp: tpVal };
          }
          window.__activeTradeTriggerTime = Date.now();
          window.__posActiveClientStart = Date.now();
          updateActiveTradeTimerUI(window.__lastActivePositions || [{ elapsed_sec: 0 }]);
        }
        showChartToast(isSuccess ? `Sell Filled! Ticket #${data.ticket || data.order}` : `Failed: ${data.error || data.message || 'Error'}`);
      } catch (e) {
        showChartToast(`Error executing sell: ${e.message}`);
      } finally {
        sellBtn.disabled = false;
      }
    });
  });

  buyBtn?.addEventListener('click', () => {
    const lot = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : 1.0;
    showTvConfirm('Market Execution', `Execute MARKET BUY ${lot.toFixed(2)} lot on ${currentSymbol}?`, async () => {
      try {
        buyBtn.disabled = true;
        const curAsk = lastKnownSpot?.ask || lastKnownSpot?.bid || 0;
        const slVal = curAsk > 0 ? Math.round((curAsk - 6.0) * 100) / 100 : undefined;
        const tpVal = curAsk > 0 ? Math.round((curAsk + 12.0) * 100) / 100 : undefined;
        const res = await fetch('/api/trade/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: currentSymbol,
            side: 'BUY',
            volume: lot,
            sl: slVal,
            tp: tpVal
          })
        });
        const data = await res.json();
        const isSuccess = data && (data.status === 'EXECUTED' || data.status === 'OK' || (data.ticket && !data.error && data.status !== 'FAILED'));
        if (isSuccess) {
          const t = data.ticket || data.order;
          if (t && slVal && tpVal) {
            if (!window.__activeTradesSlTp) window.__activeTradesSlTp = {};
            window.__activeTradesSlTp[t] = { sl: slVal, tp: tpVal };
          }
          window.__activeTradeTriggerTime = Date.now();
          window.__posActiveClientStart = Date.now();
          updateActiveTradeTimerUI(window.__lastActivePositions || [{ elapsed_sec: 0 }]);
        }
        showChartToast(isSuccess ? `Buy Filled! Ticket #${data.ticket || data.order}` : `Failed: ${data.error || data.message || 'Error'}`);
      } catch (e) {
        showChartToast(`Error executing buy: ${e.message}`);
      } finally {
        buyBtn.disabled = false;
      }
    });
  });

  // Top Bar Close All Active Trades Button inside Active Trade Timer Box
  const topCloseAllBtn = document.getElementById('tvTopCloseAllTradesBtn');
  topCloseAllBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    showTvConfirm('Close All Active Trades', 'Are you sure you want to CLOSE ALL open positions immediately?', async () => {
      topCloseAllBtn.disabled = true;
      topCloseAllBtn.textContent = 'CLOSING...';
      try {
        await executeImmediateCloseAllTrades();
      } finally {
        topCloseAllBtn.disabled = false;
        topCloseAllBtn.textContent = '✕ CLOSE ALL';
      }
    });
  });

  // Hotkeys: Alt + PageUp (Immediate BUY), Alt + PageDown (Immediate SELL), Alt + End (Immediate CLOSE ALL)
  // Supports both Left Alt and Right Alt (AltGraph on Windows/international keyboards)
  window.addEventListener('keydown', (e) => {
    const isAltActive = Boolean(e.altKey || (typeof e.getModifierState === 'function' && (e.getModifierState('Alt') || e.getModifierState('AltGraph'))));
    if (!isAltActive) return;

    const isPageUp = (e.key === 'PageUp' || e.code === 'PageUp');
    const isPageDown = (e.key === 'PageDown' || e.code === 'PageDown');
    const isEnd = (e.key === 'End' || e.code === 'End');
    if (!isPageUp && !isPageDown && !isEnd) return;

    e.preventDefault();
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      document.activeElement.blur();
    }

    if (isPageUp) {
      executeImmediateMarketOrder('BUY');
    } else if (isPageDown) {
      executeImmediateMarketOrder('SELL');
    } else if (isEnd) {
      executeImmediateCloseAllTrades();
    }
  });
}

export async function executeImmediateMarketOrder(side = 'BUY') {
  const lot = (typeof window.getGlobalLot === 'function')
    ? window.getGlobalLot()
    : (parseFloat(document.getElementById('tvHeaderLotInput')?.value) || 1.0);
  const isBuy = side.toUpperCase() === 'BUY';
  const curPrice = isBuy
    ? (lastKnownSpot?.ask || lastKnownSpot?.bid || 0)
    : (lastKnownSpot?.bid || lastKnownSpot?.ask || 0);
  const slVal = curPrice > 0 ? (isBuy ? Math.round((curPrice - 6.0) * 100) / 100 : Math.round((curPrice + 6.0) * 100) / 100) : undefined;
  const tpVal = curPrice > 0 ? (isBuy ? Math.round((curPrice + 12.0) * 100) / 100 : Math.round((curPrice - 12.0) * 100) / 100) : undefined;

  showChartToast(`⚡ Executing immediate ${side.toUpperCase()} ${lot.toFixed(2)}L...`);

  try {
    const res = await fetch('/api/trade/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: currentSymbol || 'XAUUSD',
        side: side.toUpperCase(),
        volume: lot,
        sl: slVal,
        tp: tpVal,
        comment: `Hotkey Alt+Page${isBuy ? 'Up' : 'Down'} ${side.toUpperCase()}`,
        source: 'hotkey'
      })
    });
    const data = await res.json();
    const isSuccess = data && (data.status === 'EXECUTED' || data.status === 'OK' || (data.ticket && !data.error && data.status !== 'FAILED'));
    if (isSuccess) {
      const ticket = data.ticket || data.order;
      if (ticket && slVal && tpVal) {
        if (!window.__activeTradesSlTp) window.__activeTradesSlTp = {};
        window.__activeTradesSlTp[ticket] = { sl: slVal, tp: tpVal };
      }
      window.__activeTradeTriggerTime = Date.now();
      window.__posActiveClientStart = Date.now();
      updateActiveTradeTimerUI(window.__lastActivePositions || [{ elapsed_sec: 0 }]);
      showChartToast(`⚡ ${side.toUpperCase()} FILLED! ${lot.toFixed(2)}L @ $${(data.price || curPrice || 0).toFixed(2)} [Ticket #${ticket}]`);
    } else {
      showChartToast(`❌ Immediate ${side.toUpperCase()} Failed: ${data.error || data.detail || data.message || 'Rejected'}`);
    }
  } catch (err) {
    showChartToast(`❌ Trade error: ${err.message}`);
  }
}

export async function executeImmediateCloseAllTrades() {
  showChartToast('🚨 Closing all trades immediately...');
  try {
    const res = await fetch('/api/trade/close_all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: currentSymbol || 'XAUUSD', source: 'hotkey_alt_end' })
    });
    const data = await res.json();

    // 1. Deactivate all active drawings (positions & lines)
    deactivateAllTradeDrawings('hotkey_alt_end');

    // 2. Hide active trade timer and reset timer state
    window.__activeTradeTriggerTime = null;
    window.__posActiveClientStart = null;
    window.__lastActivePositions = [];
    try {
      sessionStorage.removeItem('escanor_active_trade_trigger_time');
    } catch (_) {}

    const badgeEl = document.getElementById('tvActiveTradeTimerBadge');
    if (badgeEl) badgeEl.style.display = 'none';

    const closedCount = data?.closed_count ?? data?.closed ?? 0;
    showChartToast(`🚨 Closed all positions! (${closedCount} flattened)`);

    // Refresh line trading HUD if present
    if (lineTrading) {
      lineTrading.activePositions = [];
      lineTrading.renderHud();
    }
  } catch (err) {
    showChartToast(`❌ Error closing all trades: ${err.message}`);
  }
}

window.executeImmediateMarketOrder = executeImmediateMarketOrder;
window.executeImmediateCloseAllTrades = executeImmediateCloseAllTrades;

export function deactivateAllTradeDrawings(reason = 'mobile_close') {
  let count = 0;

  // 1. Deactivate all Long and Short Position drawings on chart
  if (chart) {
    const overlays = chart.getOverlays() || [];
    for (const ov of overlays) {
      if (ov.name === 'longPosition' || ov.name === 'shortPosition') {
        if (ov.extendData && ov.extendData.isArmed) {
          ov.extendData.isArmed = false;
          chart.overrideOverlay({ id: ov.id, extendData: ov.extendData });
          count++;
        }
      }
    }

    // Reset floating toolbar arm button if visible
    const floatArmBtn = document.getElementById('tvFloatArmBtn');
    if (floatArmBtn) {
      floatArmBtn.classList.remove('armed');
      floatArmBtn.title = 'Arm Trade Trigger (DISARMED)';
    }

    // Sync updated disarmed drawings to server
    syncDrawingsToServer(currentSymbol, chart, false, true);
  }

  // 2. Deactivate all Line Trading lines
  if (lineTrading && typeof lineTrading.deactivateAllLines === 'function') {
    count += lineTrading.deactivateAllLines();
  } else if (window.__lineTradingManager && typeof window.__lineTradingManager.deactivateAllLines === 'function') {
    count += window.__lineTradingManager.deactivateAllLines();
  }

  // 3. Clear active trade timer badge
  window.__activeTradeTriggerTime = null;
  try { sessionStorage.removeItem('escanor_active_trade_trigger_time'); } catch (e) {}
  updateActiveTradeTimerUI([]);

  console.log(`[Escanor TV] Deactivated all trade drawings (${count} disarmed, reason: ${reason})`);
  const toastMsg = (reason === 'header_close_all')
    ? '🚨 Closed all positions: Deactivated all trade drawings'
    : '⚡ Closed position from Mobile: Deactivated all trade drawings';
  showChartToast(toastMsg);
}

window.deactivateAllTradeDrawings = deactivateAllTradeDrawings;

function connectWebSocket() {
  const host = window.location.hostname || '127.0.0.1';
  // Try port 5056 first, or fall back to current port /ws
  const wsUrl = `ws://${host}:5056`;
  console.log(`[Escanor TV] Connecting WebSocket to ${wsUrl}...`);

  try {
    wsConn = new WebSocket(wsUrl);

    wsConn.onopen = () => {
      console.log('[Escanor TV] WebSocket connected');
      const st = document.getElementById('tvStatusText');
      if (st) st.textContent = 'MT5 LIVE • 5056 WS';
    };

    wsConn.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data && (data.type === 'DEACTIVATE_TRADE_DRAWINGS' || data.action === 'DEACTIVATE_ALL')) {
          deactivateAllTradeDrawings(data.source || 'mobile');
          return;
        }
        handleLiveTelemetry(data);
      } catch (e) {
        // Parse error
      }
    };

    wsConn.onclose = () => {
      console.warn('[Escanor TV] WebSocket closed. Reconnecting in 2s...');
      setTimeout(connectWebSocket, 2000);
    };

    wsConn.onerror = () => {
      // Retry
    };
  } catch (err) {
    console.error('[Escanor TV] WebSocket creation error:', err);
    setTimeout(connectWebSocket, 2000);
  }
}

// =========================================================================
// ⏱️ ACTIVE TRADE DURATION TIMER (TOP-RIGHT HEADER BADGE)
// =========================================================================

// Persistent map of start time for each active ticket: ticket -> timestamp_ms
const ticketStartMap = new Map();
let triggerStartTime = null;

// Restore any trigger time saved in sessionStorage
try {
  const savedTrigger = sessionStorage.getItem('escanor_active_trade_trigger_time');
  if (savedTrigger) {
    triggerStartTime = Number(savedTrigger);
    window.__activeTradeTriggerTime = triggerStartTime;
  }
} catch (e) {}

export function updateActiveTradeTimerUI(activePositions) {
  const badgeEl = document.getElementById('tvActiveTradeTimerBadge');
  const clockEl = document.getElementById('tvActiveTradeTimerClock');
  if (!badgeEl || !clockEl) return;

  const hasPositions = Array.isArray(activePositions) && activePositions.length > 0;
  
  if (window.__activeTradeTriggerTime) {
    triggerStartTime = window.__activeTradeTriggerTime;
    try {
      sessionStorage.setItem('escanor_active_trade_trigger_time', String(triggerStartTime));
    } catch (e) {}
  }

  const now = Date.now();

  // 1. Maintain ticketStartMap for current open positions
  if (hasPositions) {
    const currentTicketSet = new Set();
    for (const pos of activePositions) {
      const ticket = pos.ticket || pos.order || 'default';
      currentTicketSet.add(ticket);

      if (!ticketStartMap.has(ticket)) {
        // Priority 1: If this trade was launched by a recent trigger, anchor with trigger start time!
        if (triggerStartTime && (now - triggerStartTime < 120000)) {
          ticketStartMap.set(ticket, triggerStartTime);
        }
        // Priority 2: Use open_epoch_utc from MT5 server
        else if (pos.open_epoch_utc && pos.open_epoch_utc > 0) {
          ticketStartMap.set(ticket, pos.open_epoch_utc * 1000);
        }
        // Priority 3: Use elapsed_sec from MT5 server
        else if (typeof pos.elapsed_sec === 'number' && pos.elapsed_sec > 0) {
          ticketStartMap.set(ticket, now - (pos.elapsed_sec * 1000));
        }
        // Priority 4: Use broker tick time offset
        else if (pos.time && pos.time > 0) {
          const brokerNow = window.__lastBrokerTime || Math.floor(now / 1000);
          const diffSec = Math.max(0, brokerNow - pos.time);
          ticketStartMap.set(ticket, now - (diffSec * 1000));
        }
        // Fallback: Current time
        else {
          ticketStartMap.set(ticket, now);
        }
      }
    }

    // Remove closed positions from map
    for (const key of ticketStartMap.keys()) {
      if (!currentTicketSet.has(key)) {
        ticketStartMap.delete(key);
      }
    }
  } else {
    ticketStartMap.clear();
  }

  // 2. Check if a trade is currently active or triggered
  // If positions exist: active!
  // If recent trigger occurred within last 2 minutes: active!
  const isTriggerRecent = triggerStartTime && (now - triggerStartTime < 120000);
  const isTradeActive = hasPositions || isTriggerRecent;

  if (!isTradeActive) {
    badgeEl.style.display = 'none';
    window.__activeTradeTriggerTime = null;
    triggerStartTime = null;
    try { sessionStorage.removeItem('escanor_active_trade_trigger_time'); } catch (e) {}
    return;
  }

  // 3. Find earliest start timestamp
  let earliestStartMs = null;
  if (hasPositions && ticketStartMap.size > 0) {
    for (const t of ticketStartMap.values()) {
      if (!earliestStartMs || t < earliestStartMs) {
        earliestStartMs = t;
      }
    }
  } else if (triggerStartTime) {
    earliestStartMs = triggerStartTime;
  }

  if (!earliestStartMs) {
    earliestStartMs = now;
  }

  // 4. Calculate exact elapsed seconds from immutable start timestamp
  const elapsedSec = Math.max(0, Math.floor((now - earliestStartMs) / 1000));
  const hrs = Math.floor(elapsedSec / 3600);
  const mins = Math.floor((elapsedSec % 3600) / 60);
  const secs = elapsedSec % 60;

  let timeFormatted = '';
  if (hrs > 0) {
    timeFormatted = `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    timeFormatted = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  clockEl.textContent = timeFormatted;
  badgeEl.style.display = 'flex';
}

window.updateActiveTradeTimerUI = updateActiveTradeTimerUI;

// Continuous 1-second ticker for smooth active trade timer clock
setInterval(() => {
  const badgeEl = document.getElementById('tvActiveTradeTimerBadge');
  if (badgeEl) {
    updateActiveTradeTimerUI(window.__lastActivePositions || []);
  }
}, 1000);

function handleLiveTelemetry(tel) {
  if (!tel || tel.status !== 'OK') return;

  if (tel.server_time || tel.tick_time) {
    window.__lastBrokerTime = Number(tel.server_time || tel.tick_time);
  }

  const bid = tel.bid;
  const ask = tel.ask;
  const spread = tel.spread_pts;

  lastKnownSpot = { bid, ask, spread };

  // Evaluate rectangle box alarms (hits box, out of box, both)
  if (bid && chart) {
    evaluateRectangleAlarms(bid, chart);
  }

  // Evaluate armed long and short position triggers
  if (bid && ask && chart) {
    evaluatePositionTriggers(bid, ask, chart);
  }

  // Evaluate armed vertical line time alarms (touched by time / candle progress)
  if (chart) {
    evaluateVerticalLineAlarms(bid || ask, chart);
  }

  // 1. Update Top Bar Quick Buttons
  const sellP = document.getElementById('tvTopSellPrice');
  const buyP = document.getElementById('tvTopBuyPrice');
  const spreadTag = document.getElementById('tvTopSpread');

  if (sellP && bid) sellP.textContent = bid.toFixed(2);
  if (buyP && ask) buyP.textContent = ask.toFixed(2);
  if (spreadTag && spread !== undefined) spreadTag.textContent = `${spread} pt`;

  // 2. Feed Live Bar to Chart synchronized with current timeframe and MT5 broker time
  if (liveBarCallback && bid) {
    const tfMinutes = window.__currentTimeframeMinutes || currentTimeframeMinutes || 5;
    const tfSec = tfMinutes * 60;

    const allBars = chart ? chart.getDataList() : [];
    const lastBar = (allBars && allBars.length > 0) ? allBars[allBars.length - 1] : null;

    // MT5 broker server time in seconds (UTC+3 / broker server time)
    let brokerSec = tel.server_time || tel.tick_time || tel.spot?.server_time || tel.spot?.chart_bar?.time;
    if (!brokerSec && lastBar) {
      brokerSec = Math.floor(lastBar.timestamp / 1000);
    }
    if (!brokerSec) {
      brokerSec = Math.floor(Date.now() / 1000);
    }

    // Current bar timestamp aligned with timeframe boundaries in broker time
    let currentBarTs = Math.floor(brokerSec / tfSec) * tfSec * 1000;

    // Ensure live bar timestamp never falls behind the latest candle already rendered on chart
    if (lastBar && currentBarTs < lastBar.timestamp) {
      currentBarTs = lastBar.timestamp;
    }

    let barOpen = bid;
    let barHigh = bid;
    let barLow = bid;
    let barClose = bid;
    let barVolume = 1;

    if (lastBar && lastBar.timestamp === currentBarTs) {
      // Intra-bar live price update on the active candle
      barOpen = lastBar.open;
      barHigh = Math.max(lastBar.high, bid);
      barLow = Math.min(lastBar.low, bid);
      barClose = bid;
      barVolume = (lastBar.volume || 0) + 1;
    } else if (lastBar && currentBarTs > lastBar.timestamp) {
      // Brand new candle opened!
      barOpen = bid;
      barHigh = bid;
      barLow = bid;
      barClose = bid;
      barVolume = 1;
    } else if (tel.spot?.chart_bar) {
      const cb = tel.spot.chart_bar;
      barOpen = cb.open || bid;
      barHigh = Math.max(cb.high || bid, bid);
      barLow = Math.min(cb.low || bid, bid);
      barClose = bid;
    }

    liveBarCallback({
      timestamp: currentBarTs,
      open: barOpen,
      high: barHigh,
      low: barLow,
      close: barClose,
      volume: barVolume
    });

    // Synchronize top countdown timer to exact broker candle close
    const countdownEl = document.getElementById('tvCountdownTimer');
    if (countdownEl) {
      const remSec = tfSec - (brokerSec % tfSec);
      const m = Math.floor(remSec / 60).toString().padStart(2, '0');
      const s = (remSec % 60).toString().padStart(2, '0');
      countdownEl.textContent = `${m}:${s}`;
    }
  }

  const activePositions = tel.active_positions || tel.positions || [];
  const pendingOrders = tel.pending_orders || tel.orders || [];

  window.__lastActivePositions = activePositions;
  updateActiveTradeTimerUI(activePositions);

  // 3. Feed Live Spot & Positions to Line Trading & Bottom HUD Engine
  if (lineTrading) {
    lineTrading.updatePositions(activePositions);
    if (bid) {
      lineTrading.onPriceTick(bid, ask);
    }
  }

  // 4. Update Active Trades & Pending Orders on Chart
  if (activeOrders) {
    activeOrders.updateData({
      positions: activePositions,
      orders: pendingOrders,
      bid: bid,
      ask: ask
    });
  }

  // 5. Update Structural Institutional Levels on Chart (PDH, PDL, Asian, VWAP, FVG)
  if (structuralLevels) {
    structuralLevels.updateLevels(tel);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
