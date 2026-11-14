/**
 * Escanor — testOne Nodal Orderflow Execution Engine (Live Desk)
 * 
 * Clean, audited implementation of the testOne Nodal Strategy:
 * - Pre-formed in-box nodal geometry extraction (Rank #1 VPOC, VAH, VAL)
 * - Boundary Pressure Ratio (BPR) Retest Depth Predictor (STOP vs LIMIT)
 * - Macro Box Rule (TP1 capped at 15.0p for H > 20p)
 * - Atomic Asymmetric 2-Tranche Execution (T1: Cash Anchor TP1 • T2: Trailing Runner)
 * - Box Energy Exhaustion Gate (One-and-done upon banking TP1)
 * - Zero Ticket Mutation: Dual independent tickets (magic=234001, 234002)
 * - Spread Gate (<= 1.20p) & Stale Price Disarm (> 1.0p past trigger)
 * - Auto-Disarm on box movement / modification
 * - Persistent Top-Right Failure / Alert Toasts
 */

import { showChartToast, showPersistentFailureToast } from './drawings_storage.js';

export class LiveStrategyEngine {
  constructor({ chartEngine, symbol = 'XAUUSD' }) {
    this.engine = chartEngine;
    this.chart = (chartEngine && chartEngine.chart) ? chartEngine.chart : chartEngine;
    this.symbol = symbol;

    this.boxTradeStates = new Map(); // boxId -> { state, setup, inTrade, activeTrade, tradesHistory }
    this.isAutoTradingEnabled = false;
    this.isTrailingEnabled = true;
    this.activeTrade = null; // Strictly 1 active trade sequence
    this.lastEvaluatedPrice = null;
    this.lastTickTimeMs = null;
    this.lastBrokerModifyTime = 0;
    this.lastModifiedSL = 0.0;
    this.lastDisarmNotificationTime = 0;
    this.lastBoxesSnapshot = '';
    this.isExecutingOrder = false;

    // UI Elements
    this.controlBar = null;
    this.autoToggleBtn = null;
    this.trailToggleBtn = null;
    this.manualExitBtn = null;
    this.statsBadge = null;
    this.statusBadge = null;
    this.tranchePill = null;

    this.bindUI();
  }

  /**
   * Helper to fetch current lot size dynamically from the top header input
   */
  getLotSize() {
    if (typeof document !== 'undefined') {
      const headerInp = document.getElementById('tvHeaderLotInput');
      const val = parseFloat(headerInp?.value);
      if (!isNaN(val) && val > 0) return val;
    }
    return 0.50; // fallback default
  }

  /**
   * Bind Floating Live Control Bar UI
   */
  bindUI() {
    if (typeof document === 'undefined') return;

    this.controlBar = document.getElementById('tvLiveControlBar');
    this.autoToggleBtn = document.getElementById('tvLiveAutoToggleBtn');
    this.manualExitBtn = document.getElementById('tvLiveManualExitBtn');
    this.statsBadge = document.getElementById('tvLiveStatsText');
    this.tranchePill = document.getElementById('tvLiveTranchePill');

    // 1. Auto Trading Toggle Switch
    if (this.autoToggleBtn) {
      this.autoToggleBtn.addEventListener('click', () => {
        if (this.isAutoTradingEnabled) {
          this.disarmAutoTrading('Manual User Click');
        } else {
          this.armAutoTrading();
        }
      });
    }

    // 2. Manual Exit Button
    if (this.manualExitBtn) {
      this.manualExitBtn.addEventListener('click', () => {
        this.manualExitActiveTrade();
      });
    }

    // 4. Header Lot Selector Dynamic Listener
    const headerLotInp = document.getElementById('tvHeaderLotInput');
    if (headerLotInp) {
      const updateLotDisplay = () => {
        const lot = this.getLotSize();
        if (this.isAutoTradingEnabled && this.autoToggleBtn && !this.activeTrade) {
          this.autoToggleBtn.textContent = `⚡ AUTO: testOne (${lot}L)`;
        }
        this.updateStatsDisplay();
      };
      headerLotInp.addEventListener('input', updateLotDisplay);
      headerLotInp.addEventListener('change', updateLotDisplay);
    }

    const lotPills = document.querySelectorAll('.tv-top-lot-pill');
    lotPills.forEach((p) => {
      p.addEventListener('click', () => {
        setTimeout(() => {
          const lot = this.getLotSize();
          if (this.isAutoTradingEnabled && this.autoToggleBtn && !this.activeTrade) {
            this.autoToggleBtn.textContent = `⚡ AUTO: testOne (${lot}L)`;
          }
          this.updateStatsDisplay();
        }, 50);
      });
    });

    // 5. Make Live Bar Draggable
    if (this.controlBar) {
      this.makeDraggable(this.controlBar);
    }
  }

  /**
   * Arm Auto Trading for testOne
   */
  async armAutoTrading() {
    if (this.activeTrade) {
      showPersistentFailureToast(
        'CANNOT ARM AUTO TRADING',
        `A trade is already active on XAUUSD (${this.activeTrade.dir} ${this.activeTrade.totalLot}L). Only 1 active trade permitted.`,
        'Wait for current trade to reach TP/SL, or close it via the red button.'
      );
      return;
    }

    // Macro Gate Lockout Pre-check
    try {
      const lockRes = await fetch('/api/macro_lockout');
      const lockData = await lockRes.json();
      if (lockData && lockData.is_locked) {
        showPersistentFailureToast(
          '🛡️ MACRO GATE AUTO-LOCKOUT ACTIVE',
          lockData.reason || 'Auto trading locked during Tier-1 Blackout window.',
          `Time remaining: ~${lockData.minutes_remaining || 15} minutes`
        );
        this.disarmAutoTrading(lockData.reason);
        return;
      }
    } catch (e) {
      // Non-fatal if server offline
    }

    const overlays = this.chart?.getOverlays?.() || [];
    const rects = overlays.filter((ov) => ov.name === 'rect');

    if (rects.length === 0) {
      showPersistentFailureToast(
        'CANNOT ARM AUTO TRADING',
        'No drawn box found on chart. Draw a consolidation box around pre-formed market structure first.',
        'Draw rectangle tool (Alt+B / Box tool)'
      );
      return;
    }

    this.isAutoTradingEnabled = true;
    this.lastBoxesSnapshot = this.getBoxesSnapshot();
    const lot = this.getLotSize();

    if (this.autoToggleBtn) {
      this.autoToggleBtn.classList.remove('off');
      this.autoToggleBtn.classList.add('testone-armed');
      this.autoToggleBtn.textContent = `🎯 HUNTING (${lot}L)`;
      this.autoToggleBtn.title = 'testOne is ARMED & HUNTING. Waiting for Shelf Sweep & Reclaim before entry.';
    }

    if (this.statusBadge) {
      this.statusBadge.classList.add('hunting');
    }

    showChartToast(`🟢 testOne ARMED (${lot}L) — State: HUNTING (Waiting for Shelf Sweep & Reclaim)`);
  }

  /**
   * Snapshot current box coordinates to detect actual displacement vs clicks
   */
  getBoxesSnapshot() {
    const overlays = this.chart?.getOverlays?.() || [];
    const rects = overlays.filter((ov) => ov.name === 'rect' && ov.points && ov.points.length >= 2);
    return rects.map((r) => {
      const validPts = (r.points || []).filter((p) => p && typeof p.value === 'number');
      if (validPts.length < 2) return `${r.id}:empty`;
      const t0 = Math.min(...validPts.map((p) => p.timestamp || 0));
      const t1 = Math.max(...validPts.map((p) => p.timestamp || 0));
      const pHigh = Math.max(...validPts.map((p) => p.value || 0)).toFixed(2);
      const pLow = Math.min(...validPts.map((p) => p.value || 0)).toFixed(2);
      return `${r.id}_${t0}_${t1}_${pHigh}_${pLow}`;
    }).sort().join('|');
  }

  /**
   * Disarm Auto Trading
   */
  disarmAutoTrading(reason = 'Box Modified') {
    const wasActive = this.isAutoTradingEnabled;
    this.isAutoTradingEnabled = false;

    if (this.autoToggleBtn) {
      this.autoToggleBtn.classList.remove('testone-armed', 'in-trade');
      this.autoToggleBtn.classList.add('off');
      this.autoToggleBtn.textContent = '🤖 AUTO: OFF';
      this.autoToggleBtn.title = 'Live Auto Trading is OFF. Click to arm once boxes are configured.';
    }

    if (this.statusBadge && !this.activeTrade) {
      this.statusBadge.classList.remove('hunting', 'in-trade');
    }

    const now = Date.now();
    if (wasActive || (now - this.lastDisarmNotificationTime > 2500)) {
      this.lastDisarmNotificationTime = now;
      showChartToast(`🛡️ ${reason} — Auto Trading turned OFF.`);
    }
  }

  /**
   * Hook called when box coordinates are moved or dragged
   */
  onBoxCoordinatesChanged() {
    const curSnapshot = this.getBoxesSnapshot();
    if (this.lastBoxesSnapshot && this.lastBoxesSnapshot === curSnapshot) {
      // Coordinates have not actually changed (e.g. simple box click, selection, or hover)
      return;
    }
    this.lastBoxesSnapshot = curSnapshot;
    this.disarmAutoTrading('Box Coordinates Moved / Modified');
    this.boxTradeStates.forEach((st) => {
      if (!st.inTrade) {
        st.setup = null; // Recompute nodal geometry on next evaluation
      }
    });
  }

  /**
   * Hook called when an overlay/box is removed or deleted
   */
  onOverlayRemoved(overlayId) {
    if (this.boxTradeStates.has(overlayId)) {
      this.boxTradeStates.delete(overlayId);
      this.disarmAutoTrading('Box Removed');
      this.updateStatsDisplay();
    }
  }

  /**
   * Hook called when all drawings are cleared
   */
  onClearAllDrawings() {
    this.boxTradeStates.clear();
    this.activeTrade = null;
    this.disarmAutoTrading('All Drawings Cleared');
    this.updateStatsDisplay();
    if (this.controlBar) {
      this.controlBar.style.display = 'none';
    }
  }

  /**
   * Extract in-box volume profile and nodal parameters (pure testOne)
   */
  extractBoxNodalProfile(rect) {
    const pts = rect.points || [];
    if (pts.length < 2) return null;

    const prices = pts.map((p) => p.value).filter((v) => typeof v === 'number' && !isNaN(v));
    const times = pts.map((p) => p.timestamp).filter((t) => typeof t === 'number' && !isNaN(t));
    if (prices.length < 2 || times.length < 2) return null;

    const topPrice = Math.max(...prices);
    const bottomPrice = Math.min(...prices);
    const h = Math.round((topPrice - bottomPrice) * 100) / 100;
    const midPrice = Math.round(((topPrice + bottomPrice) / 2.0) * 100) / 100;
    const tStart = Math.min(...times);
    const tEnd = Math.max(...times);

    const fullList = this.chart?.getDataList?.() || [];
    const inBoxCandles = fullList.filter((c) => c.timestamp >= tStart && c.timestamp <= tEnd);

    if (inBoxCandles.length < 3) {
      return {
        topPrice, bottomPrice, h, midPrice, tStart, tEnd,
        vpoc: midPrice, vah: Math.round((topPrice - 0.2 * h) * 100) / 100, val: Math.round((bottomPrice + 0.2 * h) * 100) / 100,
        bpr: 1.0, volSkew: 1.0, isLong: true,
        orderType: 'LIMIT', entryPrice: midPrice, setupName: 'Origin VPOC Sweep (Fallback)'
      };
    }

    // 1. In-box volume profile across 0.10p bins
    const bins = [];
    for (let p = bottomPrice; p <= topPrice + 0.05; p += 0.10) {
      bins.push(Math.round(p * 100) / 100);
    }

    const vols = [];
    for (let i = 0; i < bins.length - 1; i++) {
      const p0 = bins[i];
      const p1 = bins[i + 1];
      const pm = Math.round(((p0 + p1) / 2.0) * 100) / 100;
      let tv = 0;
      for (const c of inBoxCandles) {
        if (c.low <= p1 && c.high >= p0) {
          tv += (c.volume || 1);
        }
      }
      vols.push({ p: pm, v: tv });
    }

    vols.sort((a, b) => b.v - a.v);
    const vpoc = vols[0]?.p || midPrice;

    vols.sort((a, b) => a.p - b.p);
    const totalVol = vols.reduce((acc, curr) => acc + curr.v, 0);
    let cum = 0;
    let vah = topPrice;
    let val = bottomPrice;
    for (const item of vols) {
      cum += item.v;
      const ratio = cum / (totalVol || 1);
      if (ratio >= 0.20 && val === bottomPrice) {
        val = item.p;
      }
      if (ratio >= 0.80) {
        vah = item.p;
        break;
      }
    }

    // 2. Skew and Boundary Pressure Ratio (BPR)
    let vUpper = 0;
    let vLower = 0;
    for (const c of inBoxCandles) {
      if (c.close >= midPrice) vUpper += (c.volume || 1);
      else vLower += (c.volume || 1);
    }
    const volSkew = Math.round((vUpper / (vLower || 1)) * 100) / 100;

    const topThresh = topPrice - 0.15 * h;
    const botThresh = bottomPrice + 0.15 * h;
    let ceilingTaps = 0;
    let floorTaps = 0;
    for (const c of inBoxCandles) {
      if (c.high >= topThresh) ceilingTaps++;
      if (c.low <= botThresh) floorTaps++;
    }
    const bpr = Math.round((ceilingTaps / (floorTaps || 1)) * 100) / 100;

    // 3. Direction & Retest Depth Predictor
    const isLong = (bpr >= 1.0 || volSkew >= 1.0);
    const boundary = isLong ? topPrice : bottomPrice;
    const vaEdge = isLong ? vah : val;

    let orderType = 'LIMIT';
    let entryPrice = vpoc;
    let slPrice = isLong ? (bottomPrice - 0.50) : (topPrice + 0.50);
    let setupName = '';

    if (bpr >= 3.0) {
      orderType = 'STOP';
      entryPrice = Math.round((isLong ? (boundary + 0.15) : (boundary - 0.15)) * 100) / 100;
      slPrice = Math.round((isLong ? (topPrice - 0.35 * h) : (bottomPrice + 0.35 * h)) * 100) / 100;
      setupName = 'Runaway Boundary Vacuum Stop';
    } else {
      const isHighPressure = (bpr >= 1.20 || volSkew >= 1.80);
      entryPrice = isHighPressure ? vaEdge : vpoc;
      setupName = isHighPressure ? (isLong ? 'VAH Edge Retest' : 'VAL Edge Retest') : 'Origin VPOC Sweep';
    }

    // Hard Stop Cap <= 7.50 points
    const slDist = Math.abs(entryPrice - slPrice);
    if (slDist > 7.50) {
      slPrice = Math.round((isLong ? (entryPrice - 7.50) : (entryPrice + 7.50)) * 100) / 100;
    }

    // Macro Box Cap: TP1 min(h, 15.0p)
    const tp1Dist = h > 20.0 ? Math.min(h, 15.0) : h;
    const tp1Price = Math.round((isLong ? (entryPrice + tp1Dist) : (entryPrice - tp1Dist)) * 100) / 100;
    const tp2Price = Math.round((isLong ? (entryPrice + 1.618 * h) : (entryPrice - 1.618 * h)) * 100) / 100;

    return {
      topPrice, bottomPrice, h, midPrice, tStart, tEnd,
      vpoc, vah, val, bpr, volSkew, ceilingTaps, floorTaps,
      isLong, orderType, entryPrice, slPrice, tp1Price, tp2Price, setupName
    };
  }

  /**
   * Fast evaluation on every live MT5 tick
   */
  onPriceTick(bid, ask, tickTimeMs = null) {
    if (typeof window !== 'undefined' && window.__replayActive) return;

    const curBid = Number(bid);
    const curAsk = Number(ask);
    if (!curBid || !curAsk || isNaN(curBid) || isNaN(curAsk)) return;

    this.lastEvaluatedPrice = curBid;
    if (tickTimeMs) this.lastTickTimeMs = Number(tickTimeMs);

    const spread = Math.round((curAsk - curBid) * 100) / 100;

    const overlays = this.chart?.getOverlays?.() || [];
    const rects = overlays.filter((ov) => ov.name === 'rect');

    // Bar visibility
    if (this.controlBar) {
      if (rects.length > 0 || this.activeTrade) {
        if (this.controlBar.style.display === 'none') {
          this.controlBar.style.display = 'flex';
        }
      } else {
        if (this.controlBar.style.display !== 'none') {
          this.controlBar.style.display = 'none';
        }
      }
    }

    // Manage active trade if open
    if (this.activeTrade) {
      this.manageActiveTradeTick(curBid, curAsk);
      this.updateManualExitBtnState();
      this.updateStatsDisplay();
      return;
    }

    // Only evaluate new triggers if Auto Trading is armed
    if (!this.isAutoTradingEnabled || this.isExecutingOrder) return;

    rects.forEach((rect) => {
      this.evaluateBoxForEntry(rect, curBid, curAsk, spread);
    });
  }

  /**
   * Evaluate a single box for live entry trigger via Order Flow Shelf Sweep & Absorption Reclaim
   */
  evaluateBoxForEntry(rect, curBid, curAsk, spread) {
    if (!this.boxTradeStates.has(rect.id)) {
      this.boxTradeStates.set(rect.id, {
        retired: false,
        setup: null,
        tradesHistory: [],
        phase: 'HUNTING', // 'HUNTING' | 'SWEEPING' | 'EXECUTED'
        sweepExtreme: null,
        sweepStartTime: 0
      });
    }

    const state = this.boxTradeStates.get(rect.id);
    if (state.retired || state.phase === 'EXECUTED') return; // Box Energy Exhausted

    if (!state.setup) {
      state.setup = this.extractBoxNodalProfile(rect);
      state.phase = 'HUNTING';
    }

    const s = state.setup;
    if (!s) return;

    // 1. Spread Gate: Must be <= 1.20 points
    if (spread > 1.20) {
      return; // Skip execution during spread spike
    }

    const shelfPrice = s.entryPrice;
    let shouldTrigger = false;

    // 2. TRIGGER LOGIC: Physical Formation Check (ZERO Immediate Tick-1 Entries)
    if (s.orderType === 'STOP') {
      // Runaway Breakout Vacuum: Price must physically cross beyond the box boundary + 0.15p
      if (s.isLong) {
        if (curAsk >= s.topPrice + 0.15) shouldTrigger = true;
      } else {
        if (curBid <= s.bottomPrice - 0.15) shouldTrigger = true;
      }
    } else {
      // LIMIT / Shelf Sweep & Absorption Reclaim:
      if (s.isLong) {
        // Phase A: Detect Liquidity Sweep (price penetrates below the Core Shelf by >= 0.20p)
        if (curBid <= shelfPrice - 0.20) {
          if (state.phase !== 'SWEEPING') {
            state.phase = 'SWEEPING';
            state.sweepExtreme = curBid;
            state.sweepStartTime = Date.now();
            showChartToast(`🎯 testOne: Shelf Liquidity Sweep Active at $${curBid.toFixed(2)} — Waiting for Absorption Reclaim`);
          } else {
            if (curBid < state.sweepExtreme) state.sweepExtreme = curBid;
          }
        }

        // Phase B: Confirm Absorption Reclaim (price snaps back and closes above shelf by >= +0.15p)
        if (state.phase === 'SWEEPING' && curAsk >= shelfPrice + 0.15) {
          const sweepDepth = Math.round((shelfPrice - state.sweepExtreme) * 100) / 100;
          if (sweepDepth >= 0.20 && sweepDepth <= 7.50) {
            // Anti-Fakeout: Check candle upper rejection wick
            const dataList = this.chart?.getDataList?.() || [];
            const curCandle = dataList.length > 0 ? dataList[dataList.length - 1] : null;
            if (curCandle) {
              const cRange = Math.max(0.01, curCandle.high - curCandle.low);
              const upperWick = curCandle.high - Math.max(curCandle.open, curCandle.close);
              if (upperWick / cRange > 0.45) {
                return; // Upper rejection wick > 45%: fakeout risk, skip entry
              }
            }

            shouldTrigger = true;
            // Dynamically anchor SL 0.70p below the sweep tip (Anti-Spread Minor Scratch Stop)
            s.slPrice = Math.round((state.sweepExtreme - 0.70) * 100) / 100;
            s.entryPrice = Math.round(curAsk * 100) / 100;
            state.phase = 'EXECUTED';
            showChartToast(`🏛️ Absorption Reclaim Confirmed! Long entry at $${s.entryPrice.toFixed(2)} (Sweep: -$${sweepDepth.toFixed(2)}p, SL: $${s.slPrice.toFixed(2)})`);
          }
        }
      } else {
        // SHORT: Sweep above shelf by >= +0.20p, then reclaim below shelf by >= -0.15p
        if (curAsk >= shelfPrice + 0.20) {
          if (state.phase !== 'SWEEPING') {
            state.phase = 'SWEEPING';
            state.sweepExtreme = curAsk;
            state.sweepStartTime = Date.now();
            showChartToast(`🎯 testOne: Shelf Liquidity Sweep Active at $${curAsk.toFixed(2)} — Waiting for Distribution Reclaim`);
          } else {
            if (curAsk > state.sweepExtreme) state.sweepExtreme = curAsk;
          }
        }

        if (state.phase === 'SWEEPING' && curBid <= shelfPrice - 0.15) {
          const sweepDepth = Math.round((state.sweepExtreme - shelfPrice) * 100) / 100;
          if (sweepDepth >= 0.20 && sweepDepth <= 7.50) {
            // Anti-Fakeout: Check candle lower rejection wick
            const dataList = this.chart?.getDataList?.() || [];
            const curCandle = dataList.length > 0 ? dataList[dataList.length - 1] : null;
            if (curCandle) {
              const cRange = Math.max(0.01, curCandle.high - curCandle.low);
              const lowerWick = Math.min(curCandle.open, curCandle.close) - curCandle.low;
              if (lowerWick / cRange > 0.45) {
                return; // Lower rejection wick > 45%: fakeout risk, skip entry
              }
            }

            shouldTrigger = true;
            s.slPrice = Math.round((state.sweepExtreme + 0.70) * 100) / 100;
            s.entryPrice = Math.round(curBid * 100) / 100;
            state.phase = 'EXECUTED';
            showChartToast(`🏛️ Distribution Reclaim Confirmed! Short entry at $${s.entryPrice.toFixed(2)} (Sweep: +$${sweepDepth.toFixed(2)}p, SL: $${s.slPrice.toFixed(2)})`);
          }
        }
      }
    }

    if (!shouldTrigger) return;

    // 3. Stale-Price Runaway Check (> 1.0p past trigger)
    const slipDist = s.isLong ? (curAsk - s.entryPrice) : (s.entryPrice - curBid);
    if (slipDist > 1.00) {
      state.retired = true;
      this.disarmAutoTrading('Stale Price Missed');
      showPersistentFailureToast(
        'STALE PRICE RUNAWAY — DISARMED',
        `Live price escaped by +${slipDist.toFixed(2)}p past intended entry (${s.entryPrice.toFixed(2)}).`,
        `Prevented chasing the high at $${curAsk.toFixed(2)}. Structure marked RETIRED.`
      );
      return;
    }

    // 4. Fire Dual-Tranche Execution
    this.executeDualTrancheTrade(rect, s, curBid, curAsk);
  }

  /**
   * Execute live dual-tranche order via /api/testone/execute_dual
   */
  async executeDualTrancheTrade(rect, setup, curBid, curAsk) {
    if (this.isExecutingOrder || this.activeTrade) return;
    this.isExecutingOrder = true;

    const lot = this.getLotSize();

    // Macro Gate Lockout Pre-flight Execution Guard
    try {
      const lockRes = await fetch('/api/macro_lockout');
      const lockData = await lockRes.json();
      if (lockData && lockData.is_locked) {
        showPersistentFailureToast(
          '🛡️ MACRO GATE AUTO-LOCKOUT',
          `Execution Blocked: ${lockData.reason}`,
          'Refusing to execute order during high-impact news / rollover window.'
        );
        this.disarmAutoTrading(lockData.reason);
        return;
      }
    } catch (e) {}

    try {
      const payload = {
        symbol: this.symbol,
        side: setup.isLong ? 'BUY' : 'SELL',
        volume: lot,
        sl_price: setup.slPrice,
        tp1_price: setup.tp1Price,
        tp2_price: setup.tp2Price,
        trailing_enabled: this.isTrailingEnabled
      };

      const res = await fetch('/api/testone/execute_dual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (!data || data.status !== 'OK') {
        const errMsg = data?.error || 'Broker execution rejected';
        showPersistentFailureToast(
          'ORDER EXECUTION FAILED',
          errMsg,
          `Setup: ${setup.setupName} | Lots: ${lot}L | Side: ${setup.isLong ? 'BUY' : 'SELL'}`
        );
        this.disarmAutoTrading('Execution Error');
        return;
      }

      // Successful Execution
      const t1Ticket = data.t1?.ticket;
      const t2Ticket = data.t2?.ticket;
      const fillPrice = Number(data.fill_price || (setup.isLong ? curAsk : curBid));

      this.activeTrade = {
        boxId: rect.id,
        setupName: setup.setupName,
        isLong: setup.isLong,
        dir: setup.isLong ? 'BUY' : 'SELL',
        totalLot: lot,
        t1Ticket,
        t2Ticket,
        t1Lot: data.t1?.volume || (lot / 2),
        t2Lot: data.t2?.volume || (lot / 2),
        entry: fillPrice,
        sl: setup.slPrice,
        tp1: setup.tp1Price,
        tp2: setup.tp2Price,
        tp1Banked: false,
        peakPrice: fillPrice,
        minPrice: fillPrice,
        openTime: Date.now(),
        lastSlModifyPrice: setup.slPrice
      };

      if (this.autoToggleBtn) {
        this.autoToggleBtn.classList.remove('testone-armed');
        this.autoToggleBtn.classList.add('in-trade');
        this.autoToggleBtn.textContent = `🔥 IN TRADE (${this.activeTrade.dir} ${lot}L)`;
      }

      // Immediately render Trigger, SL, and TP lines on chart via ActiveOrdersEngine
      if (typeof window !== 'undefined' && window.__activeOrdersEngine) {
        const positions = [];
        if (t1Ticket) {
          positions.push({
            ticket: t1Ticket,
            type: setup.isLong ? 'BUY' : 'SELL',
            volume: data.t1?.volume || (lot / 2),
            price_open: fillPrice,
            sl: setup.slPrice,
            tp: setup.tp1Price,
            profit_pts: 0.0
          });
        }
        if (t2Ticket) {
          positions.push({
            ticket: t2Ticket,
            type: setup.isLong ? 'BUY' : 'SELL',
            volume: data.t2?.volume || (lot / 2),
            price_open: fillPrice,
            sl: setup.slPrice,
            tp: setup.tp2Price,
            profit_pts: 0.0
          });
        }
        if (positions.length > 0) {
          window.__activeOrdersEngine.updateData({
            positions,
            bid: curBid,
            ask: curAsk
          });
        }
      }

      showChartToast(`🏛️ testOne Filled! T1 #${t1Ticket} (TP1: $${setup.tp1Price.toFixed(2)}) • T2 #${t2Ticket || 'N/A'} (Trail)`);
    } catch (err) {
      showPersistentFailureToast(
        'NETWORK / EXECUTION ERROR',
        err.message || 'Failed to communicate with MT5 backend',
        'Verify Escanor server is running on port 5055'
      );
      this.disarmAutoTrading('Network Error');
    } finally {
      this.isExecutingOrder = false;
    }
  }

  /**
   * Monitor and trail active position on live ticks
   */
  async manageActiveTradeTick(curBid, curAsk) {
    const tr = this.activeTrade;
    if (!tr) return;

    const pEval = tr.isLong ? curBid : curAsk;

    // Track extremes
    if (tr.isLong) {
      if (curBid > tr.peakPrice) tr.peakPrice = curBid;
      if (curBid < tr.minPrice) tr.minPrice = curBid;
    } else {
      if (curAsk < tr.peakPrice) tr.peakPrice = curAsk;
      if (curAsk > tr.minPrice) tr.minPrice = curAsk;
    }

    const mfe = tr.isLong ? (tr.peakPrice - tr.entry) : (tr.entry - tr.peakPrice);

    // 0A. Ratchet 1: Risk Compression at +1.20p MFE (Cuts initial risk down to an ultra-tight -0.80p scratch)
    if (!tr.riskCompressed && mfe >= 1.20) {
      tr.riskCompressed = true;
      const tightSL = Math.round((tr.isLong ? (tr.entry - 0.80) : (tr.entry + 0.80)) * 100) / 100;
      const isTighter = tr.isLong ? (tightSL > tr.sl) : (tightSL < tr.sl);
      if (isTighter) {
        tr.sl = tightSL;
        tr.lastSlModifyPrice = tightSL;
        if (tr.t1Ticket) await this.modifyBrokerSL(tr.t1Ticket, tightSL);
        if (tr.t2Ticket) await this.modifyBrokerSL(tr.t2Ticket, tightSL);
        showChartToast(`🛡️ Risk Compressed (+1.20p MFE)! Max loss capped at -0.80p`);
      }
    }

    // 0B. Ratchet 2: Early Universal Scratch Lock at +2.50p MFE (BE+0.20p)
    // Ensures any trade reaching +2.50p to +4.80p profit CANNOT turn into a loss!
    if (!tr.earlyBeLocked && mfe >= 2.50) {
      tr.earlyBeLocked = true;
      const beSL = Math.round((tr.isLong ? (tr.entry + 0.20) : (tr.entry - 0.20)) * 100) / 100;
      tr.sl = beSL;
      tr.lastSlModifyPrice = beSL;

      if (tr.t1Ticket) await this.modifyBrokerSL(tr.t1Ticket, beSL);
      if (tr.t2Ticket) await this.modifyBrokerSL(tr.t2Ticket, beSL);

      showChartToast(`🛡️ Early Scratch Lock Activated (+${mfe.toFixed(2)}p MFE)! Broker SL locked at BE+ ($${beSL.toFixed(2)})`);
    }

    // 1. Check TP1 Hit (Tranche 1 Banked)
    const tp1Hit = tr.isLong ? (curBid >= tr.tp1) : (curAsk <= tr.tp1);
    if (!tr.tp1Banked && tp1Hit) {
      tr.tp1Banked = true;
      const beSL = Math.round((tr.isLong ? (tr.entry + 0.20) : (tr.entry - 0.20)) * 100) / 100;
      tr.sl = beSL;

      // Promote Tranche 2 SL to Breakeven+
      if (tr.t2Ticket) {
        await this.modifyBrokerSL(tr.t2Ticket, beSL);
      }

      showChartToast(`🎯 Tranche 1 BANKED at TP1 (+${Math.abs(tr.tp1 - tr.entry).toFixed(2)}p)! Tranche 2 locked at BE+ ($${beSL.toFixed(2)})`);
    }

    // 2. Dynamic Trailing on Tranche 2 AFTER TP1
    if (tr.tp1Banked && this.isTrailingEnabled && mfe >= 8.50 && tr.t2Ticket) {
      const peakSL = Math.round((tr.isLong ? (tr.peakPrice - 3.00) : (tr.peakPrice + 3.00)) * 100) / 100;

      // Trailing Hysteresis check (delta SL >= 0.30p)
      if (Math.abs(peakSL - tr.lastSlModifyPrice) >= 0.30) {
        tr.sl = peakSL;
        tr.lastSlModifyPrice = peakSL;
        await this.modifyBrokerSL(tr.t2Ticket, peakSL);
      }
    }

    // Trailing check complete for this tick
  }

  /**
   * Modify Broker SL on MT5 via /api/trade/modify
   */
  async modifyBrokerSL(ticket, newSL) {
    if (!ticket || ticket <= 0) return;
    try {
      await fetch('/api/trade/modify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, sl: newSL })
      });
    } catch (e) {
      console.warn('[testOne] Failed to modify broker SL:', e);
    }
  }

  /**
   * Reconcile position state with MT5 history
   */
  async reconcileActivePosition() {
    const tr = this.activeTrade;
    if (!tr || this._isReconcilingClose) return;

    try {
      this._isReconcilingClose = true;
      const checkTicket = tr.t2Ticket || tr.t1Ticket;
      const res = await fetch(`/api/trade/ticket_result?ticket=${checkTicket}`);
      const data = await res.json();

      if (data && data.status === 'CLOSED') {
        // Trade closed!
        const profit = data.profit || 0.0;
        const state = tr.boxId ? this.boxTradeStates.get(tr.boxId) : null;
        if (state) {
          state.retired = true; // Box Energy Exhaustion: RETIRED
          state.tradesHistory.push({
            dir: tr.dir,
            lot: tr.totalLot,
            pnlUsd: profit,
            pnlPts: profit / (tr.totalLot * 100.0)
          });
        }

        this.activeTrade = null;
        this.disarmAutoTrading('Trade Sequence Complete (Structure Retired)');
        this.updateStatsDisplay();
        showChartToast(`🏁 Trade Closed: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} USD. Structure RETIRED.`);
      }
    } catch (e) {
      // Reconcile network error (non-fatal)
    } finally {
      this._isReconcilingClose = false;
    }
  }

  /**
   * Reconcile active trade state with MT5 active positions list
   */
  reconcileWithPositions(activePositions = []) {
    const posList = Array.isArray(activePositions) ? activePositions : [];

    // 1. If activeTrade is null (e.g. page refreshed) but MT5 has open position, restore activeTrade
    if (!this.activeTrade && posList.length > 0) {
      const p = posList[0];
      const isLong = p.type === 'BUY' || p.type === 0;
      this.activeTrade = {
        boxId: null,
        setupName: 'Restored Active Position',
        isLong,
        dir: isLong ? 'BUY' : 'SELL',
        totalLot: Number(p.volume || 0.01),
        t1Ticket: Number(p.ticket),
        t2Ticket: null,
        t1Lot: Number(p.volume || 0.01),
        t2Lot: 0.0,
        entry: Number(p.price_open),
        sl: Number(p.sl || 0),
        tp1: Number(p.tp || 0),
        tp2: Number(p.tp || 0),
        tp1Banked: false,
        peakPrice: Number(p.price_open),
        minPrice: Number(p.price_open),
        openTime: Number(p.time ? p.time * 1000 : Date.now()),
        lastSlModifyPrice: Number(p.sl || 0)
      };

      this.updateManualExitBtnState();
      this.updateStatsDisplay();
      return;
    }

    if (!this.activeTrade) return;

    // 2. Position is active: check if our tickets are still open in broker
    const openTickets = new Set(posList.map((p) => Number(p.ticket)));
    const t1Open = this.activeTrade.t1Ticket ? openTickets.has(Number(this.activeTrade.t1Ticket)) : false;
    const t2Open = this.activeTrade.t2Ticket ? openTickets.has(Number(this.activeTrade.t2Ticket)) : false;

    // If neither ticket is found in active positions, the trade has closed on broker
    if (!t1Open && !t2Open && posList.length === 0) {
      this.reconcileActivePosition();
    } else {
      // Ensure button and display stay locked solidly in IN TRADE state without flickering
      this.updateManualExitBtnState();
      this.updateStatsDisplay();
    }
  }

  /**
   * Manually exit active trade (Ctrl+End or button click)
   */
  async manualExitActiveTrade() {
    const tr = this.activeTrade;
    if (!tr) return;

    try {
      if (tr.t1Ticket) {
        await fetch('/api/trade/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: tr.t1Ticket })
        });
      }
      if (tr.t2Ticket) {
        await fetch('/api/trade/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: tr.t2Ticket })
        });
      }
      this.reconcileActivePosition();
    } catch (err) {
      showPersistentFailureToast('MANUAL CLOSE ERROR', err.message);
    }
  }

  /**
   * Update manual exit button visibility & text
   */
  updateManualExitBtnState() {
    if (!this.manualExitBtn) return;
    const tr = this.activeTrade;

    if (!tr) {
      this.manualExitBtn.style.display = 'none';
      if (this.autoToggleBtn && !this.isAutoTradingEnabled) {
        this.autoToggleBtn.classList.remove('in-trade');
        this.autoToggleBtn.classList.add('off');
        this.autoToggleBtn.textContent = '🤖 AUTO: OFF';
      }
      return;
    }

    this.manualExitBtn.style.display = 'inline-flex';
    const curPrice = this.lastEvaluatedPrice || tr.entry;
    const curPts = tr.isLong ? (curPrice - tr.entry) : (tr.entry - curPrice);
    const curUsd = curPts * 100.0 * tr.totalLot;
    const sign = curUsd >= 0 ? '+' : '';
    this.manualExitBtn.textContent = `🛑 CLOSE (${sign}${curPts.toFixed(2)}p / ${sign}$${curUsd.toFixed(2)})`;

    if (this.autoToggleBtn) {
      this.autoToggleBtn.classList.remove('off', 'testone-armed');
      this.autoToggleBtn.classList.add('in-trade');
      this.autoToggleBtn.textContent = `🔥 IN TRADE (${tr.dir} ${tr.totalLot}L)`;
    }
  }

  /**
   * Update stats display (accurately reports active trade progress or completed history)
   */
  updateStatsDisplay() {
    if (!this.statsBadge) return;
    let totalTrades = 0;
    let netUsd = 0.0;
    let netPts = 0.0;

    this.boxTradeStates.forEach((st) => {
      (st.tradesHistory || []).forEach((t) => {
        totalTrades++;
        netUsd += (t.pnlUsd || 0);
        netPts += (t.pnlPts || 0);
      });
    });

    if (this.activeTrade) {
      const curPrice = this.lastEvaluatedPrice || this.activeTrade.entry;
      const curPts = this.activeTrade.isLong ? (curPrice - this.activeTrade.entry) : (this.activeTrade.entry - curPrice);
      const curUsd = curPts * 100.0 * this.activeTrade.totalLot;
      const sign = curUsd >= 0 ? '+' : '';
      const closedPart = totalTrades > 0 ? ` • ${totalTrades} Done` : '';
      this.statsBadge.textContent = `1 Active | ${sign}$${curUsd.toFixed(2)} (${sign}${curPts.toFixed(1)}p)${closedPart}`;
      return;
    }

    const sign = netUsd >= 0 ? '+' : '';
    this.statsBadge.textContent = `${totalTrades} Trades | ${sign}$${netUsd.toFixed(2)} (${sign}${netPts.toFixed(2)}p)`;
  }

  /**
   * Draggable utility
   */
  makeDraggable(element) {
    if (!element || typeof window === 'undefined') return;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    const dragHandle = element.querySelector('.tv-replay-drag-handle') || element;

    dragHandle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = element.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      element.style.bottom = 'auto';
      element.style.transform = 'none';
      element.style.left = `${initialLeft}px`;
      element.style.top = `${initialTop}px`;
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      element.style.left = `${initialLeft + dx}px`;
      element.style.top = `${initialTop + dy}px`;
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        document.body.style.userSelect = '';
      }
    });
  }
}
