/**
 * Escanor — TradingView Terminal Main Application
 * Boots chart engine, connects live MT5 WebSocket tick stream,
 * restores server drawings, and powers the top ribbon and quick order pad.
 */

import { initTradingViewChart, startCandleCountdown } from './tv_chart_engine.js?v=202610251525';
import { initToolbar, showTvConfirm, evaluateRectangleAlarms, evaluatePositionTriggers, evaluateVerticalLineAlarms } from './toolbar.js?v=202610241430';
import { fetchServerDrawings, restoreDrawings, showChartToast, syncDrawingsToServer } from './drawings_storage.js?v=202610241430';
import { ActiveOrdersEngine } from './active_orders_engine.js?v=202610131355';
import { LineTradingManager } from './line_trading.js?v=202610141545';
import { StructuralLevelsEngine } from './structural_levels_engine.js?v=202610131355';
import { isFootprintEnabled, setFootprintEnabled, computeFootprintMetrics } from './living_candle_engine.js?v=202610141510';
import { initTrapAlerts, evaluateTrapLiveAlert } from './trap_alerts.js?v=202610141615';

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
            updateFootprintIntelligenceUI();
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
  window.__currentTimeframeMinutes = currentTimeframeMinutes;
  startCandleCountdown(currentTimeframeMinutes);

  // 6. Initialize Left Toolbar & Trap Alerts
  initToolbar(chart, currentSymbol);
  initTrapAlerts();

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

  // Global Deactivate All Alarms Anywhere / Any Device Button (Left of Clear Drawings)
  const deactivateAllAlarmsBtn = document.getElementById('tvDeactivateAllAlarmsBtn');
  deactivateAllAlarmsBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    // 1. Immediately deactivate all local chart drawing alarms
    deactivateAllAlarmsGlobally(false);

    // 2. Dispatch to backend to deactivate on server & broadcast across all devices
    try {
      await fetch('/api/alarms/deactivate_all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: currentSymbol })
      });
    } catch (err) {
      console.warn('[Escanor TV] Failed to call /api/alarms/deactivate_all:', err);
    }
  });

  // 5-Hour Living Footprint & POC Toggle Button
  const fpToggleBtn = document.getElementById('toggleFootprintBtn');
  fpToggleBtn?.addEventListener('click', () => {
    const next = !isFootprintEnabled();
    setFootprintEnabled(next);
    fpToggleBtn.classList.toggle('active', next);
    const labelSpan = fpToggleBtn.querySelector('span:last-child');
    if (labelSpan) {
      labelSpan.textContent = next ? '5H FOOTPRINT: ON' : '5H FOOTPRINT: OFF';
    }
    if (chart) {
      try {
        chart.overrideIndicator({ paneId: 'candle_pane', name: 'LivingFootprint' });
      } catch (_e) {}
      chart.resize();
    }
  });

  // 5-Hour Footprint Visual Guide Modal & Ribbon (i) Button
  const fpModal = document.getElementById('tvFootprintLegendModal');
  const openFootprintLegend = () => {
    if (fpModal) fpModal.style.display = 'flex';
  };
  const closeFootprintLegend = () => {
    if (fpModal) fpModal.style.display = 'none';
  };

  document.getElementById('tvFootprintInfoBtn')?.addEventListener('click', openFootprintLegend);
  document.getElementById('tvCloseFootprintModalBtn')?.addEventListener('click', closeFootprintLegend);
  document.getElementById('tvCloseFootprintModalDoneBtn')?.addEventListener('click', closeFootprintLegend);
  fpModal?.addEventListener('click', (e) => {
    if (e.target === fpModal) closeFootprintLegend();
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
      chart.resetData(() => {
        setTimeout(updateFootprintIntelligenceUI, 200);
      });
    });
  });
}

function setupQuickOrderPad() {
  const sellBtn = document.getElementById('tvQuickSellBtn');
  const buyBtn = document.getElementById('tvQuickBuyBtn');

  sellBtn?.addEventListener('click', () => {
    if (window.__isDrawdownLocked) {
      showChartToast('⛔ DAILY DRAWDOWN HIT ($0.00). Trading is LOCKED until manually disabled in settings.');
      return;
    }
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
    if (window.__isDrawdownLocked) {
      showChartToast('⛔ DAILY DRAWDOWN HIT ($0.00). Trading is LOCKED until manually disabled in settings.');
      return;
    }
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

  // Top Bar Breakeven Button inside Active Trade Timer Box
  const topBreakevenBtn = document.getElementById('tvTopBreakevenBtn');
  topBreakevenBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    executeTriggerBreakeven();
  });

  // Floating Round Pill Close All Button in Bottom Right Corner of Chart
  const floatingCloseAllBtn = document.getElementById('tvFloatingCloseAllBtn');
  floatingCloseAllBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    showTvConfirm('Close All Active Trades', 'Are you sure you want to CLOSE ALL open positions immediately?', async () => {
      floatingCloseAllBtn.disabled = true;
      try {
        await executeImmediateCloseAllTrades();
      } finally {
        floatingCloseAllBtn.disabled = false;
      }
    });
  });

  // Daily Max Drawdown Guard Setup
  initDrawdownGuard();

  // Header Dollar Inputs Initialization (SL $, TP $, LOCK/TRAIL $)
  initHeaderDollarInputs();

  // Hotkeys: Alt + PageUp (Immediate BUY), Alt + PageDown (Immediate SELL), Alt + End (Immediate CLOSE ALL), Alt + B (Breakeven + 0.2 pip), Alt + Home (Move/Trail SL)
  // Supports both Left Alt and Right Alt (AltGraph on Windows/international keyboards)
  let lastHotkeyTriggerTime = 0;
  window.addEventListener('keydown', (e) => {
    const isAltActive = Boolean(e.altKey || (typeof e.getModifierState === 'function' && (e.getModifierState('Alt') || e.getModifierState('AltGraph'))));
    if (!isAltActive) return;

    const isPageUp = (e.key === 'PageUp' || e.code === 'PageUp');
    const isPageDown = (e.key === 'PageDown' || e.code === 'PageDown');
    const isEnd = (e.key === 'End' || e.code === 'End');
    const isB = (e.key === 'b' || e.key === 'B' || e.code === 'KeyB');
    const isHome = (e.key === 'Home' || e.code === 'Home');
    if (!isPageUp && !isPageDown && !isEnd && !isB && !isHome) return;

    // Debounce rapid key bounce / OS repeat
    const now = Date.now();
    if (now - lastHotkeyTriggerTime < 500) {
      e.preventDefault();
      return;
    }
    lastHotkeyTriggerTime = now;

    e.preventDefault();
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      document.activeElement.blur();
    }

    if (isPageUp) {
      if (window.__isDrawdownLocked) {
        showChartToast('⛔ DAILY DRAWDOWN HIT ($0.00). Trading is LOCKED until manually disabled in settings.');
        return;
      }
      executeImmediateMarketOrder('BUY');
    } else if (isPageDown) {
      if (window.__isDrawdownLocked) {
        showChartToast('⛔ DAILY DRAWDOWN HIT ($0.00). Trading is LOCKED until manually disabled in settings.');
        return;
      }
      executeImmediateMarketOrder('SELL');
    } else if (isEnd) {
      executeImmediateCloseAllTrades();
    } else if (isB) {
      executeTriggerBreakeven();
    } else if (isHome) {
      executeMoveOrTrailSlToDollars();
    }
  });
}

function initHeaderDollarInputs() {
  const slInp = document.getElementById('tvHeaderSlDollarsInput');
  const tpInp = document.getElementById('tvHeaderTpDollarsInput');
  const lockInp = document.getElementById('tvHeaderLockSlDollarsInput');
  const lockBtn = document.getElementById('tvHeaderLockSlBtn');

  if (slInp) {
    const saved = localStorage.getItem('tv_shortcut_sl_dollars');
    if (saved !== null) slInp.value = saved;
    slInp.addEventListener('input', () => {
      localStorage.setItem('tv_shortcut_sl_dollars', slInp.value);
    });
  }
  if (tpInp) {
    const saved = localStorage.getItem('tv_shortcut_tp_dollars');
    if (saved !== null) tpInp.value = saved;
    tpInp.addEventListener('input', () => {
      localStorage.setItem('tv_shortcut_tp_dollars', tpInp.value);
    });
  }
  if (lockInp) {
    const saved = localStorage.getItem('tv_shortcut_lock_dollars');
    if (saved !== null) lockInp.value = saved;
    lockInp.addEventListener('input', () => {
      localStorage.setItem('tv_shortcut_lock_dollars', lockInp.value);
    });
  }
  if (lockBtn) {
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      executeMoveOrTrailSlToDollars();
    });
  }
}

export async function executeImmediateMarketOrder(side = 'BUY') {
  if (window.__isDrawdownLocked) {
    showChartToast('⛔ DAILY DRAWDOWN HIT ($0.00). Trading is LOCKED until manually disabled in settings.');
    return;
  }

  // 1. STRICT SINGLE ACTIVE POSITION & IN-FLIGHT MUTEX: Only 1 trade allowed active at a time!
  if (window.__isExecutingTrade) {
    console.log('[Hotkey] Trade execution already in flight — blocked duplicate trigger.');
    return;
  }

  const hasActivePositions = (window.__lastActivePositions && window.__lastActivePositions.length > 0) ||
                             (lineTrading && lineTrading.activePositions && lineTrading.activePositions.length > 0);
  if (hasActivePositions) {
    showChartToast('🛑 Trade blocked: 1 trade already active. Only 1 active trade allowed!');
    return;
  }

  window.__isExecutingTrade = true;

  const lot = (typeof window.getGlobalLot === 'function')
    ? window.getGlobalLot()
    : (parseFloat(document.getElementById('tvHeaderLotInput')?.value) || 1.0);
  const isBuy = side.toUpperCase() === 'BUY';
  const curPrice = isBuy
    ? (lastKnownSpot?.ask || lastKnownSpot?.bid || 0)
    : (lastKnownSpot?.bid || lastKnownSpot?.ask || 0);

  // Read SL & TP dollar inputs from header (Applies strictly to shortcut trigger Alt+PgUp/PgDn)
  const slDollarsInput = document.getElementById('tvHeaderSlDollarsInput');
  const tpDollarsInput = document.getElementById('tvHeaderTpDollarsInput');
  const slDollars = slDollarsInput ? parseFloat(slDollarsInput.value) : 0;
  const tpDollars = tpDollarsInput ? parseFloat(tpDollarsInput.value) : 0;

  // Gold contract size: 100 oz per standard lot
  // 1 standard lot (1.00) = 100 units. A $1.00 move in XAUUSD price = $100.00 per lot.
  // For 'lot' size: Dollar change per $1.00 price move = lot * 100
  const contractSize = 100.0;
  const dollarPerDollarMove = lot * contractSize;

  let slVal = undefined;
  let tpVal = undefined;

  if (curPrice > 0 && dollarPerDollarMove > 0) {
    if (!isNaN(slDollars) && slDollars > 0) {
      const slDist = slDollars / dollarPerDollarMove;
      slVal = isBuy
        ? Math.round((curPrice - slDist) * 100) / 100
        : Math.round((curPrice + slDist) * 100) / 100;
    }
    if (!isNaN(tpDollars) && tpDollars > 0) {
      const tpDist = tpDollars / dollarPerDollarMove;
      tpVal = isBuy
        ? Math.round((curPrice + tpDist) * 100) / 100
        : Math.round((curPrice - tpDist) * 100) / 100;
    }
  }

  const slDesc = (slVal && slDollars > 0) ? ` | SL -$${slDollars.toFixed(0)} ($${slVal.toFixed(2)})` : '';
  const tpDesc = (tpVal && tpDollars > 0) ? ` | TP +$${tpDollars.toFixed(0)} ($${tpVal.toFixed(2)})` : '';

  showChartToast(`⚡ Executing immediate ${side.toUpperCase()} ${lot.toFixed(2)}L${slDesc}${tpDesc}...`);

  const tradePayload = {
    action: 'EXECUTE_HOTKEY',
    request_id: 'hotkey_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    symbol: currentSymbol || 'XAUUSD',
    side: side.toUpperCase(),
    volume: lot,
    sl: slVal,
    tp: tpVal,
    comment: `Hotkey Alt+Page${isBuy ? 'Up' : 'Down'} ${side.toUpperCase()}`,
    source: 'hotkey'
  };

  try {
    let data = null;
    const ws = window.__escanorWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send once over WebSocket and wait up to 8000ms for MT5 broker fill confirmation
      data = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (window.__pendingWsExecutions) window.__pendingWsExecutions.delete(tradePayload.request_id);
          resolve({ status: 'FAILED', error: 'Execution timeout after 8000ms' });
        }, 8000);

        if (!window.__pendingWsExecutions) window.__pendingWsExecutions = new Map();
        window.__pendingWsExecutions.set(tradePayload.request_id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });

        try {
          ws.send(JSON.stringify(tradePayload));
        } catch (e) {
          clearTimeout(timer);
          if (window.__pendingWsExecutions) window.__pendingWsExecutions.delete(tradePayload.request_id);
          resolve(null);
        }
      });
    }

    // ONLY fallback to HTTP if WebSocket was closed or threw an exception
    if (!data) {
      const res = await fetch('/api/trade/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tradePayload)
      });
      data = await res.json();
    }

    const isSuccess = data && (data.status === 'EXECUTED' || data.status === 'OK' || (data.ticket && !data.error && data.status !== 'FAILED'));
    if (isSuccess) {
      const ticket = data.ticket || data.order;
      if (ticket && (slVal || tpVal)) {
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
  } finally {
    setTimeout(() => {
      window.__isExecutingTrade = false;
    }, 400);
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

export function updateTopBreakevenBtnUI() {
  const topBeBtn = document.getElementById('tvTopBreakevenBtn');
  if (!topBeBtn) return;
  const isAnyArmed = Array.isArray(window.__armedBreakevenTickets) && window.__armedBreakevenTickets.length > 0;
  if (isAnyArmed) {
    topBeBtn.innerHTML = '<span>🛡️ BE (ARMED)</span>';
    topBeBtn.style.background = 'rgba(0, 229, 255, 0.25)';
    topBeBtn.style.borderColor = '#00e5ff';
    topBeBtn.style.color = '#00e5ff';
    topBeBtn.style.fontWeight = 'bold';
    topBeBtn.title = 'Breakeven is ARMED (+0.2 pip) — Click to disarm (Alt + B)';
  } else {
    topBeBtn.innerHTML = '<span>🛡️ BE</span>';
    topBeBtn.style.background = '';
    topBeBtn.style.borderColor = '';
    topBeBtn.style.color = '';
    topBeBtn.style.fontWeight = '';
    topBeBtn.title = 'Move Stop Loss to Breakeven + 0.2 pip (Alt + B)';
  }
}
window.updateTopBreakevenBtnUI = updateTopBreakevenBtnUI;

export async function executeTriggerBreakeven(ticket = null, action = 'toggle') {
  showChartToast('🛡️ Checking Breakeven (+0.2 pip)...');
  try {
    const payload = {
      symbol: currentSymbol || 'XAUUSD',
      offset_pips: 0.2,
      action: action
    };
    if (ticket) payload.ticket = Number(ticket);

    const res = await fetch('/api/trade/breakeven', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data && data.status === 'OK') {
      if (data.action === 'MODIFIED' || data.modified_count > 0) {
        const details = (data.results || []).filter(r => r.status === 'MODIFIED').map(r => `#${r.ticket} SL -> $${Number(r.sl).toFixed(2)}`).join(', ');
        showChartToast(`🛡️ Breakeven Set (+0.2 pip)! ${details}`);

        // Optimistically update active positions SL on frontend immediately
        if (lineTrading && Array.isArray(lineTrading.activePositions)) {
          for (const r of data.results || []) {
            if (r.status === 'MODIFIED') {
              const p = lineTrading.activePositions.find(pos => Number(pos.ticket) === Number(r.ticket));
              if (p) p.sl = Number(r.sl);
              if (!window.__activeTradesSlTp) window.__activeTradesSlTp = {};
              window.__activeTradesSlTp[r.ticket] = { ...(window.__activeTradesSlTp[r.ticket] || {}), sl: Number(r.sl) };
            }
          }
          lineTrading.renderHud();
        }
        if (activeOrdersEngine && Array.isArray(activeOrdersEngine.activePositions)) {
          for (const r of data.results || []) {
            if (r.status === 'MODIFIED') {
              const p = activeOrdersEngine.activePositions.find(pos => Number(pos.ticket) === Number(r.ticket));
              if (p) p.sl = Number(r.sl);
            }
          }
          activeOrdersEngine.render();
        }
        if (window.__armedBreakevenTickets) {
          for (const r of data.results || []) {
            if (r.status === 'MODIFIED') {
              window.__armedBreakevenTickets = window.__armedBreakevenTickets.filter(t => Number(t) !== Number(r.ticket));
            }
          }
        }
        updateTopBreakevenBtnUI();
      } else if (data.action === 'ARMED' || data.armed_count > 0) {
        const armed = (data.results || []).find(r => r.status === 'ARMED') || {};
        const cond = armed.target_condition ? ` (${armed.target_condition})` : '';
        const targetPrice = armed.sl ? ` at $${Number(armed.sl).toFixed(2)}` : '';
        showChartToast(`🛡️ Breakeven Armed (+0.2 pip)! Will auto-set SL${targetPrice} once in profit${cond}`);

        if (!window.__armedBreakevenTickets) window.__armedBreakevenTickets = [];
        for (const r of data.results || []) {
          if (r.status === 'ARMED' && !window.__armedBreakevenTickets.map(Number).includes(Number(r.ticket))) {
            window.__armedBreakevenTickets.push(Number(r.ticket));
          }
        }
        if (lineTrading) lineTrading.renderHud();
        updateTopBreakevenBtnUI();
      } else if (data.action === 'DISARMED' || data.disarmed_count > 0) {
        showChartToast('🛡️ Breakeven Disarmed');
        if (window.__armedBreakevenTickets && ticket) {
          window.__armedBreakevenTickets = window.__armedBreakevenTickets.filter(t => Number(t) !== Number(ticket));
        } else if (data.disarmed_count > 0) {
          window.__armedBreakevenTickets = [];
        }
        if (lineTrading) lineTrading.renderHud();
        updateTopBreakevenBtnUI();
      }
    } else {
      const err = data?.error || 'Could not move to Breakeven';
      showChartToast(`⚠️ ${err}`);
    }
  } catch (err) {
    showChartToast(`❌ Breakeven error: ${err.message}`);
  }
}

window.executeTriggerBreakeven = executeTriggerBreakeven;

export async function executeMoveOrTrailSlToDollars() {
  const inputEl = document.getElementById('tvHeaderLockSlDollarsInput');
  const rawVal = inputEl ? inputEl.value.trim() : '';
  const dollars = parseFloat(rawVal);

  if (isNaN(dollars) || dollars < 0) {
    showChartToast('⚠️ Please specify a valid dollar value in the TRAIL/LOCK $ box.');
    inputEl?.focus();
    return;
  }

  showChartToast(`🛡️ Moving / Trailing SL into $${dollars.toFixed(2)} for open positions...`);

  try {
    const res = await fetch('/api/trade/move_sl_dollars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: currentSymbol || 'XAUUSD',
        dollars: dollars
      })
    });
    const data = await res.json();
    if (data && data.status === 'OK') {
      const results = data.results || [];
      const modItems = results.filter(r => r.status === 'MODIFIED');
      const armItems = results.filter(r => r.status === 'ARMED');

      if (modItems.length > 0) {
        const details = modItems.map(r => `#${r.ticket} SL -> $${Number(r.sl).toFixed(2)} (+$${dollars})`).join(', ');
        showChartToast(`🛡️ SL Moved to +$${dollars}! ${details}`);
      } else if (armItems.length > 0) {
        const details = armItems.map(r => `#${r.ticket} Target SL $${Number(r.sl).toFixed(2)}`).join(', ');
        showChartToast(`🎯 Auto-Lock +$${dollars} ARMED! ${details}`);
      } else {
        showChartToast(`🛡️ Move SL updated (${results.length} position(s)).`);
      }

      // Optimistically update active positions SL on frontend
      if (lineTrading && Array.isArray(lineTrading.activePositions)) {
        for (const r of results) {
          if (r.status === 'MODIFIED') {
            const p = lineTrading.activePositions.find(pos => Number(pos.ticket) === Number(r.ticket));
            if (p) p.sl = Number(r.sl);
            if (!window.__activeTradesSlTp) window.__activeTradesSlTp = {};
            window.__activeTradesSlTp[r.ticket] = { ...(window.__activeTradesSlTp[r.ticket] || {}), sl: Number(r.sl) };
          }
        }
        lineTrading.renderHud();
      }
      if (activeOrdersEngine && Array.isArray(activeOrdersEngine.activePositions)) {
        for (const r of results) {
          if (r.status === 'MODIFIED') {
            const p = activeOrdersEngine.activePositions.find(pos => Number(pos.ticket) === Number(r.ticket));
            if (p) p.sl = Number(r.sl);
          }
        }
        activeOrdersEngine.render();
      }
    } else {
      showChartToast(`❌ Move SL failed: ${data?.error || 'Unknown error'}`);
    }
  } catch (err) {
    console.error('executeMoveOrTrailSlToDollars error:', err);
    showChartToast(`❌ Move SL error: ${err.message}`);
  }
}

window.executeMoveOrTrailSlToDollars = executeMoveOrTrailSlToDollars;

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

export function deactivateAllAlarmsGlobally(isRemote = false) {
  let count = 0;
  window.__allAlarmsDeactivated = true;

  // Clear any persistent gauge alarms from local storage
  try {
    localStorage.removeItem('escanor_gauge_alarms_v1');
    localStorage.setItem('escanor_gauge_alarms_v1', '[]');
  } catch (_e) {}

  // 1. Deactivate all chart drawings alarms and reset styling to unarmed
  if (chart) {
    const overlays = chart.getOverlays() || [];
    for (const ov of overlays) {
      let changed = false;

      // Rectangle alarms
      if (ov.name === 'rect') {
        if (ov.extendData) {
          if (ov.extendData.alarmMode && ov.extendData.alarmMode !== 'OFF') count++;
          ov.extendData.alarmMode = 'OFF';
          ov.extendData.telegramAlert = false;
          ov.extendData.alarmActive = false;
          ov.extendData.alerted = true;
          ov.extendData.isArmed = false;
          delete ov.extendData._lastInside;
          delete ov.extendData._lastFired;
          changed = true;
        }
        // Revert style to unarmed pink
        ov.styles = {
          style: 'stroke_fill',
          color: 'rgba(236, 64, 122, 0.12)',
          borderColor: '#ec407a',
          borderSize: 1.5
        };
        changed = true;
      }

      // Vertical line alarms
      if (ov.name === 'verticalStraightLine' || ov.name === 'verticalLine') {
        if (ov.extendData) {
          if (ov.extendData.alarmActive) count++;
          ov.extendData.alarmActive = false;
          ov.extendData.alerted = true;
          ov.extendData.alarmMode = 'OFF';
          ov.extendData.telegramAlert = false;
          changed = true;
        }
      }

      // Position tools
      if (ov.name === 'longPosition' || ov.name === 'shortPosition') {
        if (ov.extendData && ov.extendData.isArmed) {
          ov.extendData.isArmed = false;
          changed = true;
          count++;
        }
      }

      // Any generic drawing alarms
      if (ov.extendData) {
        if (ov.extendData.alarmMode && ov.extendData.alarmMode !== 'OFF') {
          ov.extendData.alarmMode = 'OFF';
          changed = true;
          count++;
        }
        if (ov.extendData.alarmActive) {
          ov.extendData.alarmActive = false;
          ov.extendData.alerted = true;
          changed = true;
          count++;
        }
        if (ov.extendData.isArmed) {
          ov.extendData.isArmed = false;
          changed = true;
          count++;
        }
        if (ov.extendData.armedSide) {
          ov.extendData.armedSide = null;
          changed = true;
        }
        if (ov.extendData.telegramAlert) {
          ov.extendData.telegramAlert = false;
          changed = true;
        }
      }

      if (changed) {
        try {
          chart.overrideOverlay(ov);
        } catch (_e) {}
      }
    }

    // Reset floating toolbar buttons if visible
    const floatRectAlarmBtn = document.getElementById('tvFloatRectAlarmBtn');
    if (floatRectAlarmBtn) {
      floatRectAlarmBtn.classList.remove('active');
      floatRectAlarmBtn.textContent = 'Alarm: OFF';
    }
    const floatVertAlarmBtn = document.getElementById('tvFloatVertAlarmBtn');
    if (floatVertAlarmBtn) {
      floatVertAlarmBtn.classList.remove('active');
      floatVertAlarmBtn.textContent = 'Time Alarm: OFF';
    }
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

  // 3. Clear active trade duration timer badge
  window.__activeTradeTriggerTime = null;
  try { sessionStorage.removeItem('escanor_active_trade_trigger_time'); } catch (e) {}
  updateActiveTradeTimerUI([]);

  console.log(`[Escanor TV] Deactivated all alarms everywhere (${count} disarmed, remote: ${isRemote})`);
  showChartToast('🔕 All Alarms Deactivated (All Devices)');
}

window.deactivateAllAlarmsGlobally = deactivateAllAlarmsGlobally;

function connectWebSocket() {
  const host = window.location.hostname || '127.0.0.1';
  // Try port 5056 first, or fall back to current port /ws
  const wsUrl = `ws://${host}:5056`;
  console.log(`[Escanor TV] Connecting WebSocket to ${wsUrl}...`);

  try {
    wsConn = new WebSocket(wsUrl);

    wsConn.onopen = () => {
      console.log('[Escanor TV] WebSocket connected');
      window.__escanorWs = wsConn;
      const st = document.getElementById('tvStatusText');
      if (st) st.textContent = 'MT5 LIVE • 5056 WS';
    };

    wsConn.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);

        // ⚡ ULTRA-FAST 15ms TICK STREAM: Feed Line Trading & Chart Immediately!
        if (data && data.type === 'TICK') {
          const bid = Number(data.bid);
          const ask = Number(data.ask);
          if (bid && !isNaN(bid)) {
            lastKnownSpot = { bid, ask: ask || bid };
            window.__lastKnownSpot = lastKnownSpot;
            // 1. Immediately evaluate Line Trading triggers (15ms tick cadence!)
            if (lineTrading) {
              lineTrading.onPriceTick(bid, ask || bid);
            }
            // 2. Immediately update candle chart live bar
            if (typeof liveBarCallback === 'function') {
              liveBarCallback({ bid, ask: ask || bid, time: data.time_msc || Date.now() });
            }
            // 3. ⚡ Real-Time Trap Candle Alert Evaluation (Cyan & Yellow)
            if (window.__trapAlertActive && chart) {
              const dataList = chart.getDataList() || [];
              evaluateTrapLiveAlert(dataList, bid);
            }
          }
          return;
        }

        // Fast WebSocket Direct Trade Execution Result
        if (data && data.type === 'TRADE_EXECUTION_RESULT') {
          if (window.__pendingWsExecutions && data.request_id && window.__pendingWsExecutions.has(data.request_id)) {
            const cb = window.__pendingWsExecutions.get(data.request_id);
            window.__pendingWsExecutions.delete(data.request_id);
            cb(data.result);
          }
          return;
        }

        if (data && data.type === 'DEACTIVATE_ALL_ALARMS') {
          deactivateAllAlarmsGlobally(true);
          return;
        }
        if (data && (data.type === 'DEACTIVATE_TRADE_DRAWINGS' || data.action === 'DEACTIVATE_ALL')) {
          if (data.action === 'DEACTIVATE_TICKET' && data.closed_ticket) {
            const ticket = Number(data.closed_ticket);
            if (lineTrading && typeof lineTrading.deactivateLineByTicket === 'function') {
              lineTrading.deactivateLineByTicket(ticket, data.source || 'server_close');
            } else if (window.__lineTradingManager && typeof window.__lineTradingManager.deactivateLineByTicket === 'function') {
              window.__lineTradingManager.deactivateLineByTicket(ticket, data.source || 'server_close');
            }
          } else {
            deactivateAllTradeDrawings(data.source || 'mobile');
          }
          return;
        }
        if (data && data.type === 'BREAKEVEN_TRIGGERED') {
          const isTrap = Boolean(data.is_trap);
          const pipsText = data.offset_pips !== undefined ? `${data.offset_pips}p` : (isTrap ? '0.3p' : '0.2 pip');
          const label = isTrap ? `Trap Auto-Breakeven (+${pipsText})` : `Breakeven (+${pipsText})`;
          showChartToast(`🛡️ ${label} Activated! #${data.ticket} SL moved to $${Number(data.sl).toFixed(2)}`);
          if (window.__armedBreakevenTickets) {
            window.__armedBreakevenTickets = window.__armedBreakevenTickets.filter(t => Number(t) !== Number(data.ticket));
          }
          if (lineTrading && Array.isArray(lineTrading.activePositions)) {
            const p = lineTrading.activePositions.find(pos => Number(pos.ticket) === Number(data.ticket));
            if (p) p.sl = Number(data.sl);
            if (!window.__activeTradesSlTp) window.__activeTradesSlTp = {};
            window.__activeTradesSlTp[data.ticket] = { ...(window.__activeTradesSlTp[data.ticket] || {}), sl: Number(data.sl) };
            lineTrading.renderHud();
          }
          if (activeOrdersEngine && Array.isArray(activeOrdersEngine.activePositions)) {
            const p = activeOrdersEngine.activePositions.find(pos => Number(pos.ticket) === Number(data.ticket));
            if (p) p.sl = Number(data.sl);
            activeOrdersEngine.render();
          }
          updateTopBreakevenBtnUI();
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

  // Floating Round Pill Close All Button in Bottom Right Corner of Chart
  const floatingCloseBtn = document.getElementById('tvFloatingCloseAllBtn');
  const floatingBadge = document.getElementById('tvFloatingCloseAllBadge');
  const floatingPnl = document.getElementById('tvFloatingCloseAllPnl');

  if (hasPositions && floatingCloseBtn) {
    floatingCloseBtn.style.display = 'inline-flex';
    if (floatingBadge) floatingBadge.textContent = String(activePositions.length);
    let totalPnl = 0;
    for (const p of activePositions) {
      totalPnl += Number(p.profit !== undefined ? p.profit : (p.pnl !== undefined ? p.pnl : 0));
    }
    if (floatingPnl) {
      const sign = totalPnl >= 0 ? '+' : '-';
      floatingPnl.textContent = `${sign}$${Math.abs(totalPnl).toFixed(2)}`;
      floatingPnl.className = `tv-rc-pnl ${totalPnl >= 0 ? 'profit' : 'loss'}`;
    }
  } else if (floatingCloseBtn) {
    floatingCloseBtn.style.display = 'none';
  }

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

// =========================================================================
// 🛡️ DAILY MAX DRAWDOWN PROTECTION & COUNTDOWN GUARD
// =========================================================================

let currentDrawdownData = null;
window.__isDrawdownLocked = false;

export function initDrawdownGuard() {
  const ddBtn = document.getElementById('tvDrawdownCountdownBtn');
  const ddModal = document.getElementById('tvDrawdownModal');
  const closeBtn = document.getElementById('tvCloseDrawdownModalBtn');
  const cancelBtn = document.getElementById('tvCancelDdModalBtn');
  const saveBtn = document.getElementById('tvSaveDdModalBtn');
  const toggleBtn = document.getElementById('tvBtnToggleDd');
  const unlockBtn = document.getElementById('tvDdUnlockBtn');
  const inputMax = document.getElementById('tvInputMaxDd');
  const presetBtns = document.querySelectorAll('.tv-dd-preset-btn');

  // Open modal on countdown button click
  ddBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (ddModal) {
      window.__ddToggleUserModified = false;
      ddModal.style.display = 'flex';
      fetchDrawdownConfig();
    }
  });

  // Close modal
  const closeModal = () => {
    window.__ddToggleUserModified = false;
    if (ddModal) ddModal.style.display = 'none';
  };
  closeBtn?.addEventListener('click', closeModal);
  cancelBtn?.addEventListener('click', closeModal);
  ddModal?.addEventListener('click', (e) => {
    if (e.target === ddModal) closeModal();
  });

  // Toggle button (ON / OFF)
  toggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const isActive = toggleBtn.classList.contains('active');
    toggleBtn.classList.toggle('active', !isActive);
    toggleBtn.textContent = !isActive ? 'ON' : 'OFF';
    window.__ddToggleUserModified = true;
  });

  // Preset buttons
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-val');
      if (val && inputMax) {
        inputMax.value = val;
      }
    });
  });

  // Save Settings
  saveBtn?.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      const maxVal = parseFloat(inputMax?.value) || 500;
      const isEnabled = toggleBtn?.classList.contains('active') ?? true;
      const res = await fetch('/api/drawdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          max_drawdown: maxVal,
          enabled: isEnabled,
          is_locked: isEnabled ? undefined : false
        })
      });
      const data = await res.json();
      const stats = data?.stats || data;
      if (stats && (stats.max_drawdown !== undefined || stats.status === 'OK')) {
        window.__ddToggleUserModified = false;
        if (!isEnabled) {
          window.__isDrawdownLocked = false;
        }
        updateDrawdownUI(stats);
        showChartToast(`🛡️ Daily Drawdown ${isEnabled ? 'ON ($' + maxVal.toFixed(2) + ')' : 'TURNED OFF'}`);
        closeModal();
      } else {
        showChartToast('⚠️ Failed to update drawdown settings');
      }
    } catch (err) {
      showChartToast(`Error: ${err.message}`);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Settings';
    }
  });

  // Manual Unlock button
  unlockBtn?.addEventListener('click', async () => {
    unlockBtn.disabled = true;
    unlockBtn.textContent = 'Unlocking...';
    try {
      const res = await fetch('/api/drawdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_locked: false })
      });
      const data = await res.json();
      const stats = data?.stats || data;
      if (stats) {
        window.__isDrawdownLocked = false;
        updateDrawdownUI(stats);
        showChartToast('🔓 Daily Drawdown Lock Released! Trading re-enabled.');
      }
    } catch (err) {
      showChartToast(`Unlock error: ${err.message}`);
    } finally {
      unlockBtn.disabled = false;
      unlockBtn.textContent = '🔓 UNLOCK / OVERRIDE LOCK';
    }
  });

  // Initial fetch
  fetchDrawdownConfig();
}

async function fetchDrawdownConfig() {
  try {
    const res = await fetch('/api/drawdown');
    const data = await res.json();
    const stats = data?.stats || data;
    if (stats) {
      updateDrawdownUI(stats);
    }
  } catch (_e) {}
}

export function updateDrawdownUI(dd) {
  if (!dd) return;
  currentDrawdownData = dd;
  const isEnabled = (dd.enabled !== false);
  const isLocked = Boolean(dd.is_locked) && isEnabled;
  const wasLocked = Boolean(window.__isDrawdownLocked);
  window.__isDrawdownLocked = isLocked;

  // If newly locked, trigger immediate disarm of everything
  if (isLocked && !wasLocked) {
    deactivateAllTradeDrawings('drawdown_locked');
    deactivateAllAlarmsGlobally(false);
    showChartToast('🔒 DAILY DRAWDOWN LIMIT HIT! All trades flattened & triggers deactivated.');
  }

  // Update Countdown Button outside LOTS section in top header
  const btn = document.getElementById('tvDrawdownCountdownBtn');
  const valEl = document.getElementById('tvDrawdownCountdownVal');
  const iconEl = btn ? btn.querySelector('.tv-dd-icon') : null;

  if (btn && valEl) {
    // Clear previous shade classes
    btn.classList.remove(
      'locked', 'warning', 'off',
      'dd-shade-blue-full', 'dd-shade-blue-mid',
      'dd-shade-orange-amber', 'dd-shade-orange-mid', 'dd-shade-orange-deep',
      'dd-shade-red-crit', 'dd-shade-locked', 'dd-shade-off'
    );

    const maxDd = (typeof dd.max_drawdown === 'number' && dd.max_drawdown > 0) ? dd.max_drawdown : 500.0;
    const remaining = typeof dd.remaining === 'number' ? Math.max(0, dd.remaining) : Math.max(0, maxDd - (dd.today_loss || 0));
    const ratio = maxDd > 0 ? Math.max(0, Math.min(1, remaining / maxDd)) : 0;

    if (!isEnabled) {
      valEl.textContent = 'OFF';
      btn.classList.add('dd-shade-off', 'off');
      btn.style.removeProperty('--dd-bg');
      btn.style.removeProperty('--dd-border');
      btn.style.removeProperty('--dd-color');
      btn.style.removeProperty('--dd-glow');
      btn.style.removeProperty('--dd-label-color');
      if (iconEl) iconEl.textContent = '🛡️';
      btn.title = 'Daily Drawdown Protection is OFF (Click to Open Settings)';
    } else if (isLocked || remaining <= 0.001) {
      valEl.textContent = '$0.00 LOCKED';
      btn.classList.add('dd-shade-locked', 'locked');
      btn.style.removeProperty('--dd-bg');
      btn.style.removeProperty('--dd-border');
      btn.style.removeProperty('--dd-color');
      btn.style.removeProperty('--dd-glow');
      btn.style.removeProperty('--dd-label-color');
      if (iconEl) iconEl.textContent = '🔒';
      btn.title = `DAILY DRAWDOWN LIMIT HIT ($0.00)! Trading is LOCKED — limit: $${maxDd.toFixed(2)} (Click to Unlock/Settings)`;
    } else {
      valEl.textContent = `$${remaining.toFixed(2)}`;

      // Calculate dynamic color shade: BLUE -> ORANGE -> RED for FULL -> LOW -> LOCKED
      let shadeClass = 'dd-shade-blue-full';
      let r, g, b;
      let labelColor = '#7dd3fc';

      if (ratio >= 0.65) {
        // BLUE SHADES (Full buffer: 0.65 to 1.0)
        shadeClass = ratio >= 0.85 ? 'dd-shade-blue-full' : 'dd-shade-blue-mid';
        const t = (ratio - 0.65) / 0.35; // 0 to 1
        r = Math.round(96 + (56 - 96) * t);
        g = Math.round(165 + (189 - 165) * t);
        b = Math.round(250 + (248 - 250) * t);
        labelColor = ratio >= 0.85 ? '#7dd3fc' : '#93c5fd';
        if (iconEl) iconEl.textContent = '🛡️';
      } else if (ratio >= 0.20) {
        // ORANGE / AMBER SHADES (Moderate to Low buffer: 0.20 to 0.65)
        if (ratio >= 0.45) {
          shadeClass = 'dd-shade-orange-amber';
          labelColor = '#fde68a';
        } else if (ratio >= 0.30) {
          shadeClass = 'dd-shade-orange-mid';
          labelColor = '#fdba74';
        } else {
          shadeClass = 'dd-shade-orange-deep';
          labelColor = '#fed7aa';
        }

        const t = (ratio - 0.20) / 0.45; // 0 (Deep Orange) to 1 (Warm Gold)
        r = Math.round(249 + (251 - 249) * t);
        g = Math.round(115 + (191 - 115) * t);
        b = Math.round(22 + (36 - 22) * t);
        if (iconEl) iconEl.textContent = ratio < 0.35 ? '⚠️' : '🛡️';
      } else {
        // RED CRITICAL SHADES (Critical Low buffer: 0.0 to 0.20)
        shadeClass = 'dd-shade-red-crit';
        const t = ratio / 0.20; // 0 (Crimson Red) to 1 (Deep Orange)
        r = Math.round(239 + (249 - 239) * t);
        g = Math.round(68 + (115 - 68) * t);
        b = Math.round(68 + (22 - 68) * t);
        labelColor = '#fca5a5';
        if (iconEl) iconEl.textContent = '⚠️';
      }

      btn.classList.add(shadeClass);

      // Real-time smooth dynamic CSS variables
      btn.style.setProperty('--dd-color', `rgb(${r}, ${g}, ${b})`);
      btn.style.setProperty('--dd-bg', `rgba(${r}, ${g}, ${b}, 0.16)`);
      btn.style.setProperty('--dd-border', `rgba(${r}, ${g}, ${b}, 0.65)`);
      btn.style.setProperty('--dd-glow', `0 0 10px rgba(${r}, ${g}, ${b}, 0.35)`);
      btn.style.setProperty('--dd-label-color', labelColor);

      const pct = Math.round(ratio * 100);
      btn.title = `Daily Drawdown Buffer: $${remaining.toFixed(2)} / $${maxDd.toFixed(2)} (${pct}% remaining) — Click to Open Settings`;
    }
  }

  // Update Modal if open
  updateDrawdownModalUI(dd);
}

export function updateDrawdownModalUI(dd) {
  if (!dd) return;
  const lockBanner = document.getElementById('tvDdLockBanner');
  if (lockBanner) {
    const isLockedAndEnabled = Boolean(dd.is_locked) && (dd.enabled !== false);
    lockBanner.style.display = isLockedAndEnabled ? 'block' : 'none';
  }

  const statRealized = document.getElementById('tvDdStatRealized');
  const statFloating = document.getElementById('tvDdStatFloating');
  const statNet = document.getElementById('tvDdStatNet');
  const statRemaining = document.getElementById('tvDdStatRemaining');

  const r = (dd.today_realized !== undefined) ? Number(dd.today_realized) : Number(dd.realized || 0);
  const f = (dd.today_floating !== undefined) ? Number(dd.today_floating) : Number(dd.floating || 0);
  const n = (dd.today_net !== undefined) ? Number(dd.today_net) : Number(dd.net_today || 0);
  const rem = (dd.remaining !== undefined) ? Number(dd.remaining) : 0;
  const maxDd = Number(dd.max_drawdown || 500);

  if (statRealized) {
    statRealized.textContent = `${r >= 0 ? '+' : '-'}$${Math.abs(r).toFixed(2)}`;
    statRealized.className = `tv-dd-stat-val ${r >= 0 ? 'pos' : 'neg'}`;
  }
  if (statFloating) {
    statFloating.textContent = `${f >= 0 ? '+' : '-'}$${Math.abs(f).toFixed(2)}`;
    statFloating.className = `tv-dd-stat-val ${f >= 0 ? 'pos' : 'neg'}`;
  }
  if (statNet) {
    statNet.textContent = `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
    statNet.className = `tv-dd-stat-val ${n >= 0 ? 'pos' : 'neg'}`;
  }
  if (statRemaining) {
    statRemaining.textContent = `$${rem.toFixed(2)}`;
    statRemaining.className = `tv-dd-stat-val ${rem <= 0 ? 'neg' : (rem < (maxDd * 0.25) ? 'warn' : 'pos')}`;
  }

  // Populate input and toggle only if user is not actively editing them in open modal
  const isModalOpen = (document.getElementById('tvDrawdownModal')?.style.display !== 'none');
  const inputMax = document.getElementById('tvInputMaxDd');
  if (inputMax && document.activeElement !== inputMax && (!isModalOpen || !inputMax.value)) {
    inputMax.value = dd.max_drawdown;
  }
  const toggleBtn = document.getElementById('tvBtnToggleDd');
  if (toggleBtn && (!isModalOpen || !window.__ddToggleUserModified)) {
    const isAct = dd.enabled !== false;
    toggleBtn.classList.toggle('active', isAct);
    toggleBtn.textContent = isAct ? 'ON' : 'OFF';
  }
}

function handleLiveTelemetry(tel) {
  if (!tel || tel.status !== 'OK') return;

  if (tel.drawdown) {
    updateDrawdownUI(tel.drawdown);
  }

  if (tel.server_time || tel.tick_time) {
    window.__lastBrokerTime = Number(tel.server_time || tel.tick_time);
  }

  const bid = tel.bid;
  const ask = tel.ask;
  const spread = tel.spread_pts;

  lastKnownSpot = { bid, ask, spread };

  if (Array.isArray(tel.armed_breakevens)) {
    window.__armedBreakevenTickets = tel.armed_breakevens;
    updateTopBreakevenBtnUI();
  }

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

    updateFootprintIntelligenceUI(barClose);

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

  // 6. Update 5H Footprint Intelligence Ribbon & Session Badge
  updateFootprintIntelligenceUI(bid || lastKnownSpot?.bid);
  updateActiveSessionUI(tel.sessions);
}

function updateFootprintIntelligenceUI(spotPrice = null) {
  if (!chart) return;
  const dataList = chart.getDataList() || [];
  if (!dataList || dataList.length < 5) return;

  const curSpot = (typeof spotPrice === 'number' && spotPrice > 0)
    ? spotPrice
    : (lastKnownSpot?.bid || lastKnownSpot?.ask || (dataList.length > 0 ? dataList[dataList.length - 1].close : 0));

  const metrics = computeFootprintMetrics(dataList, curSpot);

  // ⚡ Evaluate Real-Time Trap Candle Alert (Cyan & Yellow)
  if (window.__trapAlertActive) {
    evaluateTrapLiveAlert(dataList, curSpot);
  }

  // 1. Trap Counts Pill: e.g. "● 1 (2✕) / ● 1" showing surviving vs dead traps
  const cyanEl = document.getElementById('fpCyanCount');
  const yellowEl = document.getElementById('fpYellowCount');
  if (cyanEl) {
    const deadText = (metrics.brokenCyan > 0) ? ` (${metrics.brokenCyan}✕)` : '';
    cyanEl.textContent = `● ${metrics.activeCyan ?? metrics.cyanTraps}${deadText}`;
    cyanEl.title = `${metrics.activeCyan ?? metrics.cyanTraps} active surviving Cyan traps, ${metrics.brokenCyan || 0} broken/swept traps`;
  }
  if (yellowEl) {
    const deadText = (metrics.brokenYellow > 0) ? ` (${metrics.brokenYellow}✕)` : '';
    yellowEl.textContent = `● ${metrics.activeYellow ?? metrics.yellowTraps}${deadText}`;
    yellowEl.title = `${metrics.activeYellow ?? metrics.yellowTraps} active surviving Yellow traps, ${metrics.brokenYellow || 0} broken/swept traps`;
  }

  // 2. Pure Cyan / Yellow Candle Domination Pill with Net Survival calculation
  const pillEl = document.getElementById('fpPressurePill');
  const cyanDomEl = document.getElementById('fpBullPressure');
  const yellowDomEl = document.getElementById('fpBearPressure');
  const cPct = (metrics.cyanDomPct !== undefined) ? metrics.cyanDomPct : metrics.bullPressurePct;
  const yPct = (metrics.yellowDomPct !== undefined) ? metrics.yellowDomPct : metrics.bearPressurePct;

  if (cyanDomEl) cyanDomEl.textContent = `${cPct}%`;
  if (yellowDomEl) yellowDomEl.textContent = `${yPct}%`;

  if (pillEl) {
    pillEl.classList.remove('cyan-dominant', 'yellow-dominant', 'bear-cascade', 'bull-expansion');
    cyanDomEl?.classList.remove('leader', 'trailing');
    yellowDomEl?.classList.remove('leader', 'trailing');

    if (metrics.dominant === 'BEAR_CASCADE') {
      pillEl.classList.add('bear-cascade', 'yellow-dominant');
      yellowDomEl?.classList.add('leader');
      cyanDomEl?.classList.add('trailing');
      pillEl.title = `5H Orderflow: 🔴 BEAR CASCADE ACTIVE (${metrics.brokenCyan || 0} bottom traps failed/dead). Sellers dominating tape.`;
    } else if (metrics.dominant === 'BULL_EXPANSION') {
      pillEl.classList.add('bull-expansion', 'cyan-dominant');
      cyanDomEl?.classList.add('leader');
      yellowDomEl?.classList.add('trailing');
      pillEl.title = `5H Orderflow: 🟢 BULL EXPANSION ACTIVE (${metrics.brokenYellow || 0} top traps failed/dead). Buyers dominating tape.`;
    } else if (cPct > 55) {
      pillEl.classList.add('cyan-dominant');
      cyanDomEl?.classList.add('leader');
      yellowDomEl?.classList.add('trailing');
      pillEl.title = `5H Net Domination: ${cPct}% CYAN Absorption vs ${yPct}% YELLOW Distribution (${metrics.activeCyan || 0} active Cyan vs ${metrics.activeYellow || 0} active Yellow traps) — Buyers Dominating`;
    } else if (yPct > 55) {
      pillEl.classList.add('yellow-dominant');
      yellowDomEl?.classList.add('leader');
      cyanDomEl?.classList.add('trailing');
      pillEl.title = `5H Net Domination: ${yPct}% YELLOW Distribution vs ${cPct}% CYAN Absorption (${metrics.activeYellow || 0} active Yellow vs ${metrics.activeCyan || 0} active Cyan traps) — Sellers Dominating`;
    } else {
      pillEl.title = `5H Net Domination: Balanced ${cPct}% / ${yPct}% (${metrics.activeCyan || 0} Cyan vs ${metrics.activeYellow || 0} Yellow traps)`;
    }
  }

  // 3. Session VWAP Institutional Regime Pill
  const vwapPill = document.getElementById('fpVwapRegimePill');
  const vwapText = document.getElementById('fpVwapRegimeText');
  if (vwapPill && vwapText) {
    vwapPill.classList.remove('markdown', 'markup');
    if (metrics.sessionVwap) {
      const vVal = metrics.sessionVwap.toFixed(2);
      if (metrics.isBelowVwap) {
        vwapPill.classList.add('markdown');
        vwapText.textContent = `VWAP: $${vVal} • MARKDOWN`;
        vwapPill.title = `Session VWAP: $${vVal}. Spot is below VWAP — Institutional Markdown Regime (Sell bias)`;
      } else if (metrics.isAboveVwap) {
        vwapPill.classList.add('markup');
        vwapText.textContent = `VWAP: $${vVal} • MARKUP`;
        vwapPill.title = `Session VWAP: $${vVal}. Spot is above VWAP — Institutional Markup Regime (Buy bias)`;
      } else {
        vwapText.textContent = `VWAP: $${vVal} • VALUE`;
        vwapPill.title = `Session VWAP: $${vVal}. Spot is at volume-weighted value equilibrium.`;
      }
    } else {
      vwapText.textContent = 'VWAP: --';
    }
  }
}

window.updateFootprintIntelligenceUI = updateFootprintIntelligenceUI;

function updateActiveSessionUI(sessions) {
  const badge = document.getElementById('activeSessionBadge');
  const txt = document.getElementById('activeSessionText');
  if (!badge || !txt) return;

  let activeName = null;
  if (Array.isArray(sessions)) {
    const act = sessions.find(s => s.active || s.is_active);
    if (act) activeName = (act.name || act.title || 'ACTIVE').toUpperCase() + ' ACTIVE';
  } else if (typeof sessions === 'object' && sessions !== null) {
    for (const [k, v] of Object.entries(sessions)) {
      if (v && (v.active || v.is_active)) {
        activeName = `${k.toUpperCase()} ACTIVE`;
        break;
      }
    }
  }

  // Fallback to accurate IST time clock calculation
  if (!activeName) {
    const now = new Date();
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const istMinutes = (utcMinutes + 330) % 1440;

    if (istMinutes >= 18 * 60 && istMinutes <= 21 * 60 + 30) {
      activeName = '⚡ LONDON-NY OVERLAP ACTIVE';
    } else if (istMinutes >= 12 * 60 + 30 && istMinutes <= 21 * 60 + 30) {
      activeName = '🟢 LONDON EXPANSION ACTIVE';
    } else if (istMinutes >= 18 * 60 || istMinutes <= 2 * 60 + 30) {
      activeName = '🟢 NEW YORK SESSION ACTIVE';
    } else if (istMinutes >= 5 * 60 + 30 && istMinutes <= 14 * 60 + 30) {
      activeName = '🌐 ASIAN CORE ACTIVE';
    } else {
      activeName = '🌐 GLOBAL SESSIONS ACTIVE';
    }
  }

  txt.textContent = activeName;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
