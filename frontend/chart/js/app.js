/**
 * Escanor — TradingView Terminal Main Application
 * Boots chart engine, connects live MT5 WebSocket tick stream,
 * restores server drawings, and powers the top ribbon and quick order pad.
 */

import { initTradingViewChart, startCandleCountdown } from './tv_chart_engine.js';
import { initToolbar, showTvConfirm } from './toolbar.js';
import { fetchServerDrawings, restoreDrawings, showChartToast } from './drawings_storage.js';

let chart = null;
let currentSymbol = 'XAUUSD';
let currentTimeframeMinutes = 5;
let wsConn = null;
let liveBarCallback = null;
let lastKnownSpot = null;

const TF_MAP = {
  '1': { mult: 1, span: 'minute', label: '1m' },
  '5': { mult: 5, span: 'minute', label: '5m' },
  '15': { mult: 15, span: 'minute', label: '15m' },
  '60': { mult: 60, span: 'minute', label: '1h' },
  '240': { mult: 240, span: 'minute', label: '4h' },
  '1440': { mult: 1440, span: 'minute', label: 'D' }
};

async function init() {
  console.log('[Escanor TV] Initializing TradingView terminal...');

  // 1. Initialize Chart
  chart = initTradingViewChart('klineChart');
  if (!chart) return;

  window.__currentTimeframeMinutes = currentTimeframeMinutes;

  // 2. Set Symbol and Period
  chart.setSymbol({ ticker: currentSymbol, name: 'Gold Spot' });
  chart.setPeriod({ multiplier: currentTimeframeMinutes, span: 'minute' });

  // 3. Setup Data Loader
  chart.setDataLoader({
    getBars: async ({ symbol, period, callback }) => {
      try {
        const tf = period?.multiplier || currentTimeframeMinutes;
        window.__currentTimeframeMinutes = tf;
        const res = await fetch(`/api/candles?symbol=${symbol.ticker}&timeframe=${tf}&count=300`);
        const json = await res.json();
        callback(json.candles || [], false);
        setTimeout(() => {
          if (chart) {
            chart.setBarSpace(7.5);
            chart.setOffsetRightDistance(80);
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

  // 4. Start Countdown Timer
  startCandleCountdown(currentTimeframeMinutes);

  // 5. Initialize Left Toolbar
  initToolbar(chart, currentSymbol);

  // 6. Restore Server-Side Drawings
  try {
    const savedDrawings = await fetchServerDrawings(currentSymbol);
    if (savedDrawings && savedDrawings.length > 0) {
      restoreDrawings(chart, savedDrawings);
      console.log(`[Escanor TV] Restored ${savedDrawings.length} drawing(s) from server`);
    }
  } catch (err) {
    console.warn('[Escanor TV] Error restoring server drawings:', err);
  }

  // 7. Setup Timeframe Buttons
  setupTimeframeButtons();

  // 8. Setup Quick Buy / Sell Pad
  setupQuickOrderPad();

  // 9. Connect Real-time MT5 WebSocket
  connectWebSocket();

  // 10. Window Resize Handler
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
      chart.setBarSpace(7.5);
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
      chart.setPeriod({ multiplier: tfCfg.mult, span: tfCfg.span });
      startCandleCountdown(currentTimeframeMinutes);

      // Re-fetch candles for new timeframe
      try {
        const res = await fetch(`/api/candles?symbol=${currentSymbol}&timeframe=${tfKey}&count=300`);
        const json = await res.json();
        if (json.candles && json.candles.length > 0) {
          // Re-populate chart data
          chart.resetData(() => {});
        }
      } catch (e) {
        console.error('[Escanor TV] Failed to switch timeframe:', e);
      }
    });
  });
}

function setupQuickOrderPad() {
  const sellBtn = document.getElementById('tvQuickSellBtn');
  const buyBtn = document.getElementById('tvQuickBuyBtn');

  sellBtn?.addEventListener('click', () => {
    showTvConfirm('Market Execution', `Execute MARKET SELL 1.0 lot on ${currentSymbol}?`, async () => {
      try {
        sellBtn.disabled = true;
        const res = await fetch('/api/trade/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: currentSymbol, side: 'SELL', volume: 1.0 })
        });
        const data = await res.json();
        showChartToast(data.status === 'EXECUTED' ? `Sell Filled! Ticket #${data.ticket}` : `Failed: ${data.error}`);
      } catch (e) {
        showChartToast(`Error executing sell: ${e.message}`);
      } finally {
        sellBtn.disabled = false;
      }
    });
  });

  buyBtn?.addEventListener('click', () => {
    showTvConfirm('Market Execution', `Execute MARKET BUY 1.0 lot on ${currentSymbol}?`, async () => {
      try {
        buyBtn.disabled = true;
        const res = await fetch('/api/trade/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: currentSymbol, side: 'BUY', volume: 1.0 })
        });
        const data = await res.json();
        showChartToast(data.status === 'EXECUTED' ? `Buy Filled! Ticket #${data.ticket}` : `Failed: ${data.error}`);
      } catch (e) {
        showChartToast(`Error executing buy: ${e.message}`);
      } finally {
        buyBtn.disabled = false;
      }
    });
  });
}

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

function handleLiveTelemetry(tel) {
  if (!tel || tel.status !== 'OK') return;

  const bid = tel.bid;
  const ask = tel.ask;
  const spread = tel.spread_pts;

  lastKnownSpot = { bid, ask, spread };

  // 1. Update Top Bar Quick Buttons
  const sellP = document.getElementById('tvTopSellPrice');
  const buyP = document.getElementById('tvTopBuyPrice');
  const spreadTag = document.getElementById('tvTopSpread');

  if (sellP && bid) sellP.textContent = bid.toFixed(2);
  if (buyP && ask) buyP.textContent = ask.toFixed(2);
  if (spreadTag && spread !== undefined) spreadTag.textContent = `${spread} pt`;

  // 2. Feed Live Bar to Chart
  if (liveBarCallback && tel.spot?.chart_bar) {
    const cb = tel.spot.chart_bar;
    liveBarCallback({
      timestamp: cb.time * 1000,
      open: cb.open,
      high: cb.high,
      low: cb.low,
      close: cb.close,
      volume: 1
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
