/**
 * Escanor — Line-Based Trading & Touch Trigger Engine
 * 
 * Works across ALL line types:
 * - Trend Line (segment)
 * - Ray Line (rayLine)
 * - Extended Line (straightLine)
 * - Horizontal Line (horizontalStraightLine)
 * - Vertical Line (verticalStraightLine)
 * 
 * Features:
 * 1. Disarmed by default upon drawing (prevents accidental execution).
 * 2. Drag & placement immunity: Prevents accidental trigger while moving line over price.
 * 3. Settings modal with mutually exclusive touch triggers:
 *    - ⚡ Execute Trade on Touch (Market BUY/SELL, Volume, SL Pts, TP Pts, Auto-Close Timer)
 *    - 🚨 Exit / Close Position on Touch (Closes all open positions)
 * 4. Calculated Dollar ($) Profit & Loss box and Asymmetry R:R ratio.
 * 5. Redesigned, ultra-compact TradingView-style floating bottom-left HUD.
 * 6. Color codes:
 *    - Gray (#64748b) = Disarmed / Deactivated
 *    - Green (#00f5a0) = Armed BUY
 *    - Red (#ef4444) = Armed SELL
 *    - Amber (#fbbf24) = Armed EXIT (Close All)
 *    - Muted (#94a3b8) = Triggered
 */

import { showChartToast, syncDrawingsToServer } from './drawings_storage.js';

export const STORAGE_KEY_LINE_TRADING = 'escanor_line_trading_v1';

export class LineTradingManager {
  constructor({ chartEngine, symbol = 'XAUUSD', hudContainerId = 'tvLineTradingHud', modalId = 'tvLineTradingModal' }) {
    this.engine = chartEngine;
    this.chart = (chartEngine && chartEngine.chart) ? chartEngine.chart : chartEngine;
    this.symbol = symbol;
    this.hudEl = document.getElementById(hudContainerId);
    this.modalEl = document.getElementById(modalId);

    this.lines = new Map(); // overlayId -> lineConfig
    this.selectedLineId = null;
    this.currentSpot = null;
    this.currentAsk = null;
    this.lastBidPrice = null;
    this.lastAskPrice = null;

    this.isDraggingLine = false;
    this.isDrawingLine = false;

    this.countdownTimer = null;
    this.isExecuting = false;
    this.activePositions = [];

    this._init();
  }

  updatePositions(positions) {
    this.activePositions = Array.isArray(positions) ? positions : [];
    const activeTicketSet = new Set(this.activePositions.map(p => Number(p.ticket)));

    // Monitor trades triggered by our lines:
    for (const line of this.lines.values()) {
      if (line.activeTradeTicket) {
        const ticket = Number(line.activeTradeTicket);
        // If the trade was active and is now no longer in open activePositions:
        if (!activeTicketSet.has(ticket)) {
          line.activeTradeTicket = null;
          this.saveToStorage();
          // Check MT5 closed deal history to see if it was a loss or win
          this._checkClosedTradeResult(line, ticket);
        }
      }
    }

    this.renderHud();
  }

  async _checkClosedTradeResult(line, ticket) {
    try {
      const res = await fetch(`/api/trade/ticket_result?ticket=${ticket}`);
      const data = await res.json();
      if (data && (data.status === 'CLOSED' || data.profit !== undefined)) {
        const isLoss = Boolean(data.is_loss);
        const profit = Number(data.profit || 0);

        if (isLoss) {
          // USER RULE: "when a trade is lost the let the lines be deactivated"
          line.isArmed = false;
          this.applyLineColor(line.overlayId);
          this.saveToStorage();
          this.renderHud();
          showChartToast(`🛑 ${line.name}: Trade #${ticket} lost (-$${Math.abs(profit).toFixed(2)}). Line Deactivated!`);
        } else {
          // Trade won or breakeven: Line remains active!
          line.isArmed = true;
          this.applyLineColor(line.overlayId);
          this.saveToStorage();
          this.renderHud();
          const sign = profit >= 0 ? '+' : '';
          showChartToast(`🟢 ${line.name}: Trade #${ticket} closed in profit (${sign}$${profit.toFixed(2)}). Line remains ACTIVE!`);
        }
      }
    } catch (err) {
      console.warn(`[LineTrading] Error checking ticket result for #${ticket}:`, err);
    }
  }

  async killTrade(ticket) {
    if (!ticket) return;
    try {
      showChartToast(`Closing #${ticket}...`);
      const res = await fetch('/api/trade/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: Number(ticket) })
      });
      const data = await res.json();
      if (data && (data.status === 'CLOSED' || data.status === 'OK')) {
        showChartToast(`🚨 Closed #${ticket}!`);
        this.activePositions = this.activePositions.filter(p => Number(p.ticket) !== Number(ticket));
        this.renderHud();
      } else {
        showChartToast(`Close rejected: ${data?.error || 'Execution rejected'}`);
      }
    } catch (err) {
      showChartToast(`Error closing #${ticket}: ${err.message}`);
    }
  }

  async killAllTrades() {
    try {
      showChartToast('Closing all positions...');
      const res = await fetch('/api/trade/close_all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: this.symbol })
      });
      const data = await res.json();
      showChartToast(`🚨 Closed all positions! (${data.closed_count || 0} flattened)`);
      this.activePositions = [];
      this.renderHud();
    } catch (err) {
      showChartToast(`Error closing all: ${err.message}`);
    }
  }

  _init() {
    this.loadFromStorage();
    this._bindModalEvents();
    this._bindHudEvents();
    this._startCountdownWatchdog();
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_LINE_TRADING);
      if (raw) {
        const arr = JSON.parse(raw);
        for (const item of arr) {
          if (item && item.overlayId) {
            this.lines.set(String(item.overlayId), item);
          }
        }
      }
    } catch (e) {
      console.warn('[LineTrading] Error loading storage:', e);
    }
  }

  saveToStorage() {
    try {
      const arr = Array.from(this.lines.values());
      localStorage.setItem(STORAGE_KEY_LINE_TRADING, JSON.stringify(arr));
    } catch (e) {
      console.warn('[LineTrading] Error saving storage:', e);
    }
    this.renderHud();
  }

  // Register a line overlay when created or restored
  registerLineOverlay(overlay, lineType = 'segment') {
    if (!overlay || !overlay.id) return;
    const idStr = String(overlay.id);

    if (!this.lines.has(idStr)) {
      const newLine = {
        overlayId: idStr,
        lineType: lineType,
        name: `Line #${this.lines.size + 1}`,
        isArmed: false, // DEACTIVATED BY DEFAULT!
        actionType: 'EXECUTE', // 'EXECUTE' or 'EXIT'
        direction: 'BUY',      // 'BUY' or 'SELL'
        volume: 0.50,
        slPts: 6.0,
        tpPts: 12.0,
        timerEnabled: false,
        autoCloseMins: 5.0,
        triggered: false,
        triggeredAt: null,
        triggeredTicket: null,
        triggeredCountdownEnd: null,
        extendRay: false
      };
      this.lines.set(idStr, newLine);
      this.saveToStorage();
    }

    this.applyLineColor(idStr);
  }

  removeLineOverlay(overlayId) {
    const idStr = String(overlayId);
    if (this.chart) {
      try {
        this.chart.removeOverlay({ id: idStr });
      } catch (_) {}
    }
    if (this.lines.has(idStr)) {
      this.lines.delete(idStr);
      this.saveToStorage();
    }
    if (this.selectedLineId === idStr) {
      this.selectedLineId = null;
      if (this.modalEl) this.modalEl.style.display = 'none';
    }
    syncDrawingsToServer(this.symbol, this.chart, false, true);
  }

  clearAllLines() {
    this.lines.clear();
    this.selectedLineId = null;
    this.saveToStorage();
    if (this.modalEl) this.modalEl.style.display = 'none';
    syncDrawingsToServer(this.symbol, this.chart, false, true);
  }

  reconcileWithChart(chartOverlays = []) {
    const activeOverlayIds = new Set((chartOverlays || []).map(ov => String(ov.id)));
    let changed = false;
    for (const id of Array.from(this.lines.keys())) {
      if (!activeOverlayIds.has(id)) {
        this.lines.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.saveToStorage();
    }
  }

  getLineConfig(overlayId) {
    return this.lines.get(String(overlayId)) || null;
  }

  getLineColor(line) {
    if (!line) return '#94a3b8';
    if (!line.isArmed) return '#94a3b8';  // Clean disarmed silver-gray

    if (line.actionType === 'EXECUTE') {
      return line.direction === 'BUY' ? '#00f5a0' : '#ef4444';
    }
    if (line.actionType === 'EXIT') {
      return '#fbbf24'; // Yellow/Amber for Close All
    }
    return '#94a3b8';
  }

  applyLineColor(overlayId) {
    if (!this.chart) return;
    const line = this.lines.get(String(overlayId));
    if (!line) return;

    const col = this.getLineColor(line);
    const size = line.isArmed ? 2.5 : 1.5;
    try {
      this.chart.overrideOverlay({
        id: line.overlayId,
        styles: {
          line: {
            color: col,
            size: size,
            style: 'solid'
          },
          point: {
            color: col,
            borderColor: col,
            activeColor: col,
            activeBorderColor: col,
            radius: line.isArmed ? 5 : 4
          }
        }
      });
      syncDrawingsToServer(this.symbol, this.chart, false);
    } catch (e) {
      console.warn('[LineTrading] Error applying line color:', e);
    }
  }

  // Set drag / draw flags to prevent accidental trigger
  setDragging(isDragging) {
    this.isDraggingLine = Boolean(isDragging);
  }

  setDrawing(isDrawing) {
    this.isDrawingLine = Boolean(isDrawing);
  }

  // =========================================================================
  // ⚡ LIVE PRICE TICK COLLISION & TRIGGER LOGIC
  // =========================================================================
  onPriceTick(bid, ask) {
    if (!bid || isNaN(bid)) return;
    this.currentSpot = bid;
    const currentAsk = (ask && !isNaN(ask)) ? ask : bid;

    const prevBid = this.lastBidPrice !== null ? this.lastBidPrice : bid;
    const prevAsk = this.lastAskPrice !== null ? this.lastAskPrice : currentAsk;
    this.lastBidPrice = bid;
    this.lastAskPrice = currentAsk;

    // Do NOT trigger while user is actively drawing or dragging a line!
    if (this.isDraggingLine || this.isDrawingLine) {
      this.renderHud();
      return;
    }

    if (!this.chart) return;

    const chartOverlays = this.chart.getOverlays() || [];
    const overlayMap = new Map(chartOverlays.map(o => [String(o.id), o]));

    for (const line of this.lines.values()) {
      if (!line.isArmed) continue;

      const ov = overlayMap.get(String(line.overlayId));
      if (!ov || !ov.points || ov.points.length === 0) continue;

      const linePrice = this._calculateLinePriceAtCurrentTime(ov);
      if (linePrice === null || isNaN(linePrice) || linePrice <= 0) continue;

      line._lastCalculatedPrice = linePrice;

      // Select relevant price based on direction:
      // BUY market orders fill at ASK; SELL market orders fill at BID
      const isBuyAction = (line.actionType === 'EXECUTE' && line.direction === 'BUY');
      const testPrice = isBuyAction ? currentAsk : bid;
      const prevTestPrice = isBuyAction ? prevAsk : prevBid;

      line._lastPriceDist = Math.abs(testPrice - linePrice);

      // Collision checks:
      // 1. Direct price cross (prevPrice to testPrice jumped over linePrice)
      const crossed = (prevTestPrice <= linePrice && testPrice >= linePrice) ||
                      (prevTestPrice >= linePrice && testPrice <= linePrice);

      // 2. Touch tolerance: 0.35 pt buffer (covers Gold spread and sub-pip wicks)
      const touched = Math.abs(testPrice - linePrice) <= 0.35;

      // 3. Bid/Ask span check: If line is between bid and ask
      const inSpread = (bid <= linePrice && currentAsk >= linePrice);

      // 4. Other price (bid or ask) touched or crossed
      const otherPrice = isBuyAction ? bid : currentAsk;
      const otherPrev = isBuyAction ? prevBid : prevAsk;
      const otherCrossed = (otherPrev <= linePrice && otherPrice >= linePrice) ||
                           (otherPrev >= linePrice && otherPrice <= linePrice);
      const otherTouched = Math.abs(otherPrice - linePrice) <= 0.35;

      if (crossed || touched || inSpread || otherCrossed || otherTouched) {
        this._executeLineTrigger(line, linePrice);
      }
    }

    this.renderHud();
  }

  _calculateLinePriceAtCurrentTime(overlay) {
    if (!overlay || !overlay.points || overlay.points.length === 0) return null;
    const pts = overlay.points;

    // 1. Single-point or horizontal straight line
    if (pts.length === 1 || overlay.name === 'horizontalStraightLine') {
      const v = Number(pts[0]?.value);
      return (!isNaN(v) && v > 0) ? v : null;
    }

    if (pts.length >= 2) {
      const p1 = pts[0];
      const p2 = pts[1];
      const v1 = Number(p1?.value);
      const v2 = Number(p2?.value);

      if (isNaN(v1) || isNaN(v2)) return null;

      // Pure horizontal line or identical values (e.g. drawn with Shift key)
      if (Math.abs(v1 - v2) < 0.0001) {
        return v1;
      }

      // Vertical line: price is not defined
      if (overlay.name === 'verticalStraightLine') {
        return null;
      }

      // 2. Sloped Lines (Segment, Ray, Trend Line, etc.)
      const dataList = this.chart ? (this.chart.getDataList() || []) : [];
      const latestBar = dataList.length > 0 ? dataList[dataList.length - 1] : null;
      const latestIndex = dataList.length > 0 ? dataList.length - 1 : 0;
      const latestTime = latestBar ? latestBar.timestamp : Date.now();

      const idx1 = (p1.dataIndex !== undefined) ? Number(p1.dataIndex) : null;
      const idx2 = (p2.dataIndex !== undefined) ? Number(p2.dataIndex) : null;
      const t1 = (p1.timestamp !== undefined && p1.timestamp > 0) ? Number(p1.timestamp) : null;
      const t2 = (p2.timestamp !== undefined && p2.timestamp > 0) ? Number(p2.timestamp) : null;

      // Method A: Interpolate by dataIndex (most accurate for chart candles)
      if (idx1 !== null && idx2 !== null && idx1 !== idx2) {
        const slope = (v2 - v1) / (idx2 - idx1);
        const curVal = v1 + slope * (latestIndex - idx1);
        if (!isNaN(curVal) && curVal > 0) return curVal;
      }

      // Method B: Interpolate by timestamp
      if (t1 !== null && t2 !== null && t1 !== t2) {
        const slope = (v2 - v1) / (t2 - t1);
        const curVal = v1 + slope * (latestTime - t1);
        if (!isNaN(curVal) && curVal > 0) return curVal;
      }

      // Method C: Mixed (one has timestamp, other only has dataIndex)
      if (dataList.length >= 2) {
        const barDuration = Math.max(1000, dataList[dataList.length - 1].timestamp - dataList[dataList.length - 2].timestamp);
        let time1 = t1;
        let time2 = t2;
        if (time1 === null && idx1 !== null) {
          time1 = latestTime - (latestIndex - idx1) * barDuration;
        }
        if (time2 === null && idx2 !== null) {
          time2 = latestTime - (latestIndex - idx2) * barDuration;
        }
        if (time1 !== null && time2 !== null && time1 !== time2) {
          const slope = (v2 - v1) / (time2 - time1);
          const curVal = v1 + slope * (latestTime - time1);
          if (!isNaN(curVal) && curVal > 0) return curVal;
        }
      }

      // Fallback: Average of the two values
      return (v1 + v2) / 2;
    }

    return null;
  }

  async _executeLineTrigger(line, triggerPrice) {
    if (this.isExecuting) return;

    const isExit = line.actionType === 'EXIT';
    const now = Date.now();

    // 1. Close Position Line (EXIT): USER RULE: "let the close position line dont deactivate at all"
    if (isExit) {
      if (line._lastExitTrigger && (now - line._lastExitTrigger < 6000)) return;
      line._lastExitTrigger = now;

      console.log(`[LineTrading] 🚨 EXIT TRIGGER HIT on ${line.name} @ $${triggerPrice.toFixed(2)}`);
      try {
        const res = await fetch('/api/trade/close_all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: this.symbol })
        });
        const data = await res.json();
        showChartToast(`🚨 ${line.name}: Closed all positions! (${data.closed_count || 0} flattened). Line remains ARMED.`);
      } catch (err) {
        console.error('[LineTrading] Close all error:', err);
        showChartToast(`⚠️ Error closing positions`);
      }
      return;
    }

    // 2. Trade Entry Line (EXECUTE): USER RULE: "the lines should not deactivate on price touch they should be always active unless a trade is lost"
    if (line.activeTradeTicket) {
      const isStillOpen = (this.activePositions || []).some(p => Number(p.ticket) === Number(line.activeTradeTicket));
      if (isStillOpen) {
        return; // Current trade is still running!
      }
    }

    // Cooldown check (6 seconds)
    if (line._lastExecuteTrigger && (now - line._lastExecuteTrigger < 6000)) return;
    line._lastExecuteTrigger = now;

    this.isExecuting = true;
    console.log(`[LineTrading] ⚡ ENTRY TRIGGER HIT on ${line.name} @ $${triggerPrice.toFixed(2)} (${line.direction})`);

    try {
      const side = line.direction || 'BUY';
      const vol = line.volume || 0.50;
      const slPts = line.slPts || 6.0;
      const tpPts = line.tpPts || 12.0;

      const slPrice = side === 'BUY' ? triggerPrice - slPts : triggerPrice + slPts;
      const tpPrice = side === 'BUY' ? triggerPrice + tpPts : triggerPrice - tpPts;

      const res = await fetch('/api/trade/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: this.symbol,
          side: side,
          volume: vol,
          sl: Math.round(slPrice * 100) / 100,
          tp: Math.round(tpPrice * 100) / 100,
          comment: `Line Touch ${line.name}`
        })
      });

      const data = await res.json();
      if (data && (data.status === 'EXECUTED' || data.ticket)) {
        const ticket = data.ticket;
        line.activeTradeTicket = ticket;
        line.triggeredTicket = ticket;
        // THE LINE REMAINS ARMED AND ACTIVE!
        line.isArmed = true;
        showChartToast(`⚡ ${line.name}: Filled ${side} ${vol}L! Ticket #${ticket}. Line remains ARMED!`);

        if (line.timerEnabled && line.autoCloseMins > 0) {
          line.triggeredCountdownEnd = Date.now() + (line.autoCloseMins * 60 * 1000);
          showChartToast(`⏳ Auto-close armed: ${line.autoCloseMins}m countdown`);
        }
      } else {
        showChartToast(`⚠️ Line Trigger failed: ${data?.error || 'Execution rejected'}`);
      }
    } catch (err) {
      console.error('[LineTrading] Trigger execution error:', err);
      showChartToast(`⚠️ Network error executing trigger`);
    } finally {
      this.isExecuting = false;
      this.applyLineColor(line.overlayId);
      this.saveToStorage();
      this.renderHud();
    }
  }

  _startCountdownWatchdog() {
    this.countdownTimer = setInterval(() => {
      const now = Date.now();
      for (const line of this.lines.values()) {
        if (line.triggered && line.triggeredCountdownEnd) {
          const remMs = line.triggeredCountdownEnd - now;
          if (remMs <= 0) {
            line.triggeredCountdownEnd = null;
            this._handleAutoCloseExpired(line);
          }
        }
      }
      this.renderHud();
    }, 1000);
  }

  async _handleAutoCloseExpired(line) {
    if (!line.triggeredTicket) return;
    const ticket = line.triggeredTicket;
    line.triggeredTicket = null;
    this.saveToStorage();

    try {
      await fetch('/api/trade/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: ticket })
      });
      showChartToast(`⏳ Timer expired: Closed #${ticket}`);
    } catch (e) {
      console.warn('Auto close failed:', e);
    }
  }

  // =========================================================================
  // 🎛️ SETTINGS MODAL INTERACTION
  // =========================================================================
  openSettingsModal(overlayId) {
    const idStr = String(overlayId);
    let line = this.lines.get(idStr);
    if (!line) {
      this.registerLineOverlay({ id: overlayId });
      line = this.lines.get(idStr);
    }

    this.selectedLineId = idStr;
    if (!this.modalEl) return;

    this._currentActionType = line.actionType || 'EXECUTE';
    this._timerEnabled = Boolean(line.timerEnabled);
    this._extendRay = Boolean(line.extendRay);

    // Line name
    const nameInput = document.getElementById('tvLineNameInput');
    if (nameInput) nameInput.value = line.name || '';

    // Segmented trigger tabs (Buttons / tabs instead of checkboxes)
    const tabExec = document.getElementById('tvTabTriggerExec');
    const tabExit = document.getElementById('tvTabTriggerExit');
    const grpExec = document.getElementById('tvLineExecGroup');
    const grpExit = document.getElementById('tvLineExitGroup');

    if (this._currentActionType === 'EXECUTE') {
      tabExec?.classList.add('active');
      tabExit?.classList.remove('active');
      if (grpExec) grpExec.style.display = 'block';
      if (grpExit) grpExit.style.display = 'none';
    } else {
      tabExit?.classList.add('active');
      tabExec?.classList.remove('active');
      if (grpExec) grpExec.style.display = 'none';
      if (grpExit) grpExit.style.display = 'block';
    }

    // Direction buttons
    const btnBuy = document.getElementById('tvLineDirBuy');
    const btnSell = document.getElementById('tvLineDirSell');
    if (btnBuy && btnSell) {
      btnBuy.classList.toggle('active', line.direction === 'BUY');
      btnSell.classList.toggle('active', line.direction === 'SELL');
    }

    // Volume, SL, TP (3-column grid inputs)
    const volInput = document.getElementById('tvLineVolume');
    const slInput = document.getElementById('tvLineSlPts');
    const tpInput = document.getElementById('tvLineTpPts');
    if (volInput) volInput.value = line.volume || 0.50;
    if (slInput) slInput.value = line.slPts || 6.0;
    if (tpInput) tpInput.value = line.tpPts || 12.0;

    // Auto-Close Timer toggle button (Button instead of checkbox)
    const btnTimer = document.getElementById('tvBtnToggleTimer');
    const grpTimer = document.getElementById('tvLineTimerControls');
    const timerMins = document.getElementById('tvLineTimerMins');
    if (btnTimer) {
      btnTimer.textContent = this._timerEnabled ? 'ON' : 'OFF';
      btnTimer.classList.toggle('active', this._timerEnabled);
    }
    if (grpTimer) grpTimer.style.display = this._timerEnabled ? 'block' : 'none';
    if (timerMins) timerMins.value = line.autoCloseMins || 5.0;

    // Extend Ray toggle button (Button instead of checkbox)
    const btnRay = document.getElementById('tvBtnToggleRay');
    if (btnRay) {
      btnRay.textContent = this._extendRay ? 'ON' : 'OFF';
      btnRay.classList.toggle('active', this._extendRay);
    }

    this._updateDollarPnlBox();
    this._updateColorIndicator();

    this.modalEl.style.display = 'flex';
  }

  _bindModalEvents() {
    if (!this.modalEl) return;

    // Close button
    document.getElementById('tvCloseLineModalBtn')?.addEventListener('click', () => {
      this.modalEl.style.display = 'none';
    });

    // Touch Trigger Action: Segmented Tabs (Buttons/tabs instead of checkboxes)
    const tabExec = document.getElementById('tvTabTriggerExec');
    const tabExit = document.getElementById('tvTabTriggerExit');
    const grpExec = document.getElementById('tvLineExecGroup');
    const grpExit = document.getElementById('tvLineExitGroup');

    tabExec?.addEventListener('click', () => {
      this._currentActionType = 'EXECUTE';
      tabExec.classList.add('active');
      tabExit?.classList.remove('active');
      if (grpExec) grpExec.style.display = 'block';
      if (grpExit) grpExit.style.display = 'none';
      this._updateColorIndicator();
    });

    tabExit?.addEventListener('click', () => {
      this._currentActionType = 'EXIT';
      tabExit.classList.add('active');
      tabExec?.classList.remove('active');
      if (grpExec) grpExec.style.display = 'none';
      if (grpExit) grpExit.style.display = 'block';
      this._updateColorIndicator();
    });

    // Direction Toggle Buttons
    const btnBuy = document.getElementById('tvLineDirBuy');
    const btnSell = document.getElementById('tvLineDirSell');
    btnBuy?.addEventListener('click', () => {
      btnBuy.classList.add('active');
      btnSell?.classList.remove('active');
      this._updateColorIndicator();
    });
    btnSell?.addEventListener('click', () => {
      btnSell.classList.add('active');
      btnBuy?.classList.remove('active');
      this._updateColorIndicator();
    });

    // Recalculate dollar PnL on input changes
    ['tvLineVolume', 'tvLineSlPts', 'tvLineTpPts'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => this._updateDollarPnlBox());
    });

    // Auto-Close Timer button toggle (Button instead of checkbox)
    const btnTimer = document.getElementById('tvBtnToggleTimer');
    const grpTimer = document.getElementById('tvLineTimerControls');
    btnTimer?.addEventListener('click', () => {
      this._timerEnabled = !this._timerEnabled;
      btnTimer.textContent = this._timerEnabled ? 'ON' : 'OFF';
      btnTimer.classList.toggle('active', this._timerEnabled);
      if (grpTimer) grpTimer.style.display = this._timerEnabled ? 'block' : 'none';
    });

    // Extend Ray button toggle (Button instead of checkbox)
    const btnRay = document.getElementById('tvBtnToggleRay');
    btnRay?.addEventListener('click', () => {
      this._extendRay = !this._extendRay;
      btnRay.textContent = this._extendRay ? 'ON' : 'OFF';
      btnRay.classList.toggle('active', this._extendRay);
    });

    // Timer Duration Pills
    document.querySelectorAll('.tv-timer-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.tv-timer-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const mins = Number(pill.getAttribute('data-mins') || 5);
        const timerInput = document.getElementById('tvLineTimerMins');
        if (timerInput) timerInput.value = mins;
      });
    });

    // Delete Line
    document.getElementById('tvLineDeleteBtn')?.addEventListener('click', () => {
      if (this.selectedLineId) {
        const idToDelete = this.selectedLineId;
        this.removeLineOverlay(idToDelete);
        this.modalEl.style.display = 'none';
        showChartToast('Line deleted');
      }
    });

    // Save (Disarmed)
    document.getElementById('tvLineSaveDisarmBtn')?.addEventListener('click', () => {
      this._saveCurrentModalValues(false);
      this.modalEl.style.display = 'none';
      showChartToast('Line saved (Disarmed)');
    });

    // Arm & Activate
    document.getElementById('tvLineArmBtn')?.addEventListener('click', () => {
      this._saveCurrentModalValues(true);
      this.modalEl.style.display = 'none';
      showChartToast('🟢 Line Armed & Active!');
    });
  }

  _updateDollarPnlBox() {
    const vol = Math.max(0.01, Number(document.getElementById('tvLineVolume')?.value || 0.50));
    const slPts = Math.max(0.1, Number(document.getElementById('tvLineSlPts')?.value || 6.0));
    const tpPts = Math.max(0.1, Number(document.getElementById('tvLineTpPts')?.value || 12.0));

    const dollarTp = (tpPts * vol * 100);
    const dollarSl = (slPts * vol * 100);
    const rr = (tpPts / slPts).toFixed(1);

    const lblTp = document.getElementById('tvLineDollarTp');
    const lblTpSub = document.getElementById('tvLineDollarTpSub');
    const lblSl = document.getElementById('tvLineDollarSl');
    const lblSlSub = document.getElementById('tvLineDollarSlSub');
    const lblRr = document.getElementById('tvLineRrRatio');

    if (lblTp) lblTp.textContent = `+$${dollarTp.toFixed(2)}`;
    if (lblTpSub) lblTpSub.textContent = `+${tpPts.toFixed(1)} pt`;
    if (lblSl) lblSl.textContent = `-$${dollarSl.toFixed(2)}`;
    if (lblSlSub) lblSlSub.textContent = `-${slPts.toFixed(1)} pt`;
    if (lblRr) lblRr.textContent = `1 : ${rr}`;
  }

  _updateColorIndicator() {
    const isExec = this._currentActionType === 'EXECUTE';
    const isBuy = document.getElementById('tvLineDirBuy')?.classList.contains('active');

    const ind = document.getElementById('tvLineColorIndicator');
    if (!ind) return;

    if (isExec) {
      if (isBuy) {
        ind.textContent = '🟢 GREEN (BUY TRADE)';
        ind.className = 'line-color-badge-green';
      } else {
        ind.textContent = '🔴 RED (SELL TRADE)';
        ind.className = 'line-color-badge-red';
      }
    } else {
      ind.textContent = '🟡 YELLOW (EXIT ALL)';
      ind.className = 'line-color-badge-yellow';
    }
  }

  _saveCurrentModalValues(isArmed = false) {
    if (!this.selectedLineId) return;
    const line = this.lines.get(this.selectedLineId);
    if (!line) return;

    const nameInput = document.getElementById('tvLineNameInput');
    const isBuy = document.getElementById('tvLineDirBuy')?.classList.contains('active');
    const volInput = document.getElementById('tvLineVolume');
    const slInput = document.getElementById('tvLineSlPts');
    const tpInput = document.getElementById('tvLineTpPts');
    const timerMins = document.getElementById('tvLineTimerMins');

    line.name = nameInput?.value?.trim() || line.name;
    line.actionType = this._currentActionType || 'EXECUTE';
    line.direction = isBuy ? 'BUY' : 'SELL';
    line.volume = Number(volInput?.value || 0.50);
    line.slPts = Number(slInput?.value || 6.0);
    line.tpPts = Number(tpInput?.value || 12.0);
    line.timerEnabled = Boolean(this._timerEnabled);
    line.autoCloseMins = Number(timerMins?.value || 5.0);
    line.extendRay = Boolean(this._extendRay);
    line.isArmed = isArmed;
    line.triggered = false; // Reset trigger state on re-arming

    // Calculate initial price and point distance immediately
    if (this.chart) {
      const overlays = this.chart.getOverlays() || [];
      const ov = overlays.find(o => String(o.id) === String(line.overlayId));
      if (ov) {
        const lp = this._calculateLinePriceAtCurrentTime(ov);
        if (lp && !isNaN(lp)) {
          line._lastCalculatedPrice = lp;
          if (this.currentSpot) {
            line._lastPriceDist = Math.abs(this.currentSpot - lp);
          }
        }
      }
    }

    this.applyLineColor(line.overlayId);
    this.saveToStorage();
    this.renderHud();
  }

  // =========================================================================
  // 🧭 REDESIGNED COMPACT BOTTOM-LEFT FLOATING HUD
  // =========================================================================
  _bindHudEvents() {
    if (!this.hudEl) return;

    // Use permanent event delegation so buttons ALWAYS receive events on the very first click
    this.hudEl.addEventListener('click', (e) => {
      // 1. Position Kill Button
      const killBtn = e.target.closest('.tv-hud-kill-btn');
      if (killBtn) {
        e.stopPropagation();
        e.preventDefault();
        const ticket = killBtn.getAttribute('data-ticket');
        if (ticket) this.killTrade(ticket);
        return;
      }

      // 2. Kill All Positions Button
      const killAllBtn = e.target.closest('#tvHudKillAllBtn');
      if (killAllBtn) {
        e.stopPropagation();
        e.preventDefault();
        this.killAllTrades();
        return;
      }

      // 3. Line Action Buttons (Settings, Toggle/Pause, Delete)
      const actBtn = e.target.closest('.tv-hud-act-btn');
      if (actBtn) {
        e.stopPropagation();
        e.preventDefault();
        const act = actBtn.getAttribute('data-act');
        const id = actBtn.getAttribute('data-id');
        const line = this.lines.get(id);

        if (act === 'settings') {
          this.openSettingsModal(id);
        } else if (act === 'toggle' && line) {
          line.isArmed = !line.isArmed;
          this.applyLineColor(id);
          this.saveToStorage();
          showChartToast(line.isArmed ? `🟢 Armed ${line.name}` : `⚪ Paused ${line.name}`);
          this.renderHud(true);
        } else if (act === 'delete' && line) {
          this.removeLineOverlay(id);
          showChartToast(`Deleted ${line.name}`);
        }
        return;
      }

      // 4. Minimize / Expand Toggle Button
      const minBtn = e.target.closest('#tvHudMinBtn');
      if (minBtn) {
        e.stopPropagation();
        e.preventDefault();
        const bodyList = document.getElementById('tvHudBodyList');
        if (bodyList) {
          const isHidden = bodyList.style.display === 'none';
          bodyList.style.display = isHidden ? 'flex' : 'none';
          minBtn.textContent = isHidden ? '▼' : '▲';
        }
        return;
      }
    });
  }

  renderHud(forceFull = false) {
    if (!this.hudEl) return;

    const allLines = Array.from(this.lines.values());
    const activePositions = this.activePositions || [];

    if (allLines.length === 0 && activePositions.length === 0) {
      this.hudEl.style.display = 'none';
      this._lastHudStructureKey = null;
      return;
    }

    this.hudEl.style.display = 'flex';

    // Header title and count badge
    const armedCount = allLines.filter(l => l.isArmed).length;
    let headerTitle = armedCount > 0 ? 'ARMED LINES' : 'DESK HUD';
    let headerCount = armedCount > 0 ? `${armedCount} ARMED` : `${allLines.length} LINES`;

    if (activePositions.length > 0 && allLines.length > 0) {
      headerTitle = 'DESK HUD';
      headerCount = `${activePositions.length} POS • ${armedCount}/${allLines.length} ARMED`;
    } else if (activePositions.length > 0) {
      headerTitle = 'ACTIVE TRADES';
      headerCount = String(activePositions.length);
    }

    // Build unique structural signature
    const structureKey = `${activePositions.map(p => p.ticket).join(',')}|${allLines.map(l => `${l.overlayId}:${l.isArmed}:${l.actionType}:${l.direction}:${l.name}`).join(',')}`;

    // If structure is identical and body exists, perform non-destructive in-place DOM update!
    const bodyList = document.getElementById('tvHudBodyList');
    if (!forceFull && this._lastHudStructureKey === structureKey && bodyList) {
      // 1. Update header title & count
      const titleEl = this.hudEl.querySelector('.tv-hud-title');
      const countEl = this.hudEl.querySelector('.tv-hud-count');
      if (titleEl && titleEl.textContent !== headerTitle) titleEl.textContent = headerTitle;
      if (countEl && countEl.textContent !== headerCount) countEl.textContent = headerCount;

      // 2. Update active trades in-place
      for (const pos of activePositions) {
        const ticket = Number(pos.ticket);
        const itemEl = this.hudEl.querySelector(`.tv-hud-pos-item[data-ticket="${ticket}"]`);
        if (!itemEl) continue;

        const isBuy = pos.type === 'BUY' || pos.type === 0 || String(pos.type).toUpperCase().includes('BUY');
        const openPrice = Number(pos.price_open !== undefined ? pos.price_open : pos.price);
        const volume = Number(pos.volume || 0.50);

        let profitPts = Number(pos.profit_pts !== undefined ? pos.profit_pts : 0);
        let profitDollar = Number(pos.profit !== undefined ? pos.profit : 0);
        if (this.currentSpot && openPrice > 0) {
          const curP = isBuy ? this.currentSpot : (this.currentAsk || this.currentSpot);
          profitPts = isBuy ? (curP - openPrice) : (openPrice - curP);
          profitDollar = profitPts * volume * 100;
        }

        const profitPips = profitPts * 10;
        const isProfit = profitDollar >= 0;
        const sign = isProfit ? '+' : '-';
        const dollarStr = `${sign}$${Math.abs(profitDollar).toFixed(2)}`;
        const pipsStr = `${sign}${Math.abs(profitPips).toFixed(1)} pips (${sign}${Math.abs(profitPts).toFixed(1)} pt)`;

        const pnlEl = itemEl.querySelector('.tv-hud-pos-pnl');
        if (pnlEl) {
          pnlEl.className = `tv-hud-pos-pnl ${isProfit ? 'profit' : 'loss'}`;
          const dollarEl = pnlEl.querySelector('.tv-pnl-dollar');
          const pipsEl = pnlEl.querySelector('.tv-pnl-pips');
          if (dollarEl && dollarEl.textContent !== dollarStr) dollarEl.textContent = dollarStr;
          if (pipsEl && pipsEl.textContent !== pipsStr) pipsEl.textContent = pipsStr;
        }
      }

      // 3. Update line distances & countdowns in-place
      for (const line of allLines) {
        const itemEl = this.hudEl.querySelector(`.tv-hud-item[data-line-id="${line.overlayId}"]`);
        if (!itemEl) continue;

        let distStr = '-- pt';
        if (line._lastPriceDist !== undefined) {
          const priceStr = line._lastCalculatedPrice ? `$${line._lastCalculatedPrice.toFixed(2)} • ` : '';
          distStr = `${priceStr}${line._lastPriceDist.toFixed(1)} pt away`;
        } else if (line._lastCalculatedPrice) {
          distStr = `@ $${line._lastCalculatedPrice.toFixed(2)}`;
        }

        const distEl = itemEl.querySelector('.tv-hud-item-dist');
        if (distEl && distEl.textContent !== distStr) distEl.textContent = distStr;

        let timerHtml = '';
        if (line.triggeredCountdownEnd) {
          const remSec = Math.max(0, Math.floor((line.triggeredCountdownEnd - Date.now()) / 1000));
          if (remSec > 0) {
            const m = Math.floor(remSec / 60).toString().padStart(2, '0');
            const s = (remSec % 60).toString().padStart(2, '0');
            timerHtml = `⏳ ${m}:${s}`;
          }
        }
        const timerEl = itemEl.querySelector('.tv-hud-timer');
        if (timerEl) {
          if (timerHtml) {
            if (timerEl.textContent !== timerHtml) timerEl.textContent = timerHtml;
          } else {
            timerEl.remove();
          }
        } else if (timerHtml) {
          const distNode = itemEl.querySelector('.tv-hud-item-dist');
          if (distNode) {
            distNode.insertAdjacentHTML('afterend', `<span class="tv-hud-timer">${timerHtml}</span>`);
          }
        }
      }
      return;
    }

    // Structure changed or forced full rebuild:
    this._lastHudStructureKey = structureKey;

    let html = `
      <div class="tv-hud-header">
        <div class="tv-hud-title-box">
          <span class="tv-hud-dot" style="color: ${activePositions.length > 0 ? '#00f5a0' : (armedCount > 0 ? '#00f5a0' : '#787b86')};">●</span>
          <span class="tv-hud-title">${headerTitle}</span>
          <span class="tv-hud-count">${headerCount}</span>
        </div>
        <button id="tvHudMinBtn" class="tv-hud-min-btn" title="Minimize" style="touch-action: manipulation; cursor: pointer;">▼</button>
      </div>
      <div class="tv-hud-body" id="tvHudBodyList">
    `;

    // 1. Render Active Trades Section
    if (activePositions.length > 0) {
      html += `
        <div class="tv-hud-section-label-row">
          <span class="tv-hud-section-label">⚡ ACTIVE TRADES (${activePositions.length})</span>
          ${activePositions.length > 1 ? `<button class="tv-hud-kill-all-btn" id="tvHudKillAllBtn" title="Flatten All Positions" style="touch-action: manipulation; cursor: pointer;">KILL ALL</button>` : ''}
        </div>
      `;

      for (const pos of activePositions) {
        const ticket = Number(pos.ticket);
        const isBuy = pos.type === 'BUY' || pos.type === 0 || String(pos.type).toUpperCase().includes('BUY');
        const openPrice = Number(pos.price_open !== undefined ? pos.price_open : pos.price);
        const volume = Number(pos.volume || 0.50);

        let profitPts = Number(pos.profit_pts !== undefined ? pos.profit_pts : 0);
        let profitDollar = Number(pos.profit !== undefined ? pos.profit : 0);

        if (this.currentSpot && openPrice > 0) {
          const curP = isBuy ? this.currentSpot : (this.currentAsk || this.currentSpot);
          profitPts = isBuy ? (curP - openPrice) : (openPrice - curP);
          profitDollar = profitPts * volume * 100;
        }

        const profitPips = profitPts * 10;
        const isProfit = profitDollar >= 0;
        const sign = isProfit ? '+' : '-';
        const dollarStr = `${sign}$${Math.abs(profitDollar).toFixed(2)}`;
        const pipsStr = `${sign}${Math.abs(profitPips).toFixed(1)} pips (${sign}${Math.abs(profitPts).toFixed(1)} pt)`;
        const pnlClass = isProfit ? 'profit' : 'loss';

        html += `
          <div class="tv-hud-pos-item ${isBuy ? 'buy' : 'sell'}" data-ticket="${ticket}">
            <div class="tv-hud-pos-row-top">
              <div class="tv-hud-pos-info">
                <span class="tv-hud-pos-dot ${isBuy ? 'buy' : 'sell'}"></span>
                <span class="tv-hud-pos-type ${isBuy ? 'buy' : 'sell'}">${isBuy ? 'BUY' : 'SELL'} ${volume}L</span>
                <span class="tv-hud-pos-ticket">#${ticket}</span>
                <span class="tv-hud-pos-open">@ $${openPrice.toFixed(2)}</span>
              </div>
              <button class="tv-hud-kill-btn" data-ticket="${ticket}" title="Kill / Close #${ticket} immediately" style="touch-action: manipulation; cursor: pointer;">
                <span class="tv-kill-icon">✕</span>
                <span>KILL</span>
              </button>
            </div>
            <div class="tv-hud-pos-row-bottom">
              <div class="tv-hud-pos-pnl ${pnlClass}">
                <span class="tv-pnl-dollar">${dollarStr}</span>
                <span class="tv-pnl-pips">${pipsStr}</span>
              </div>
            </div>
          </div>
        `;
      }
    }

    // 2. Render Drawn / Armed Lines Section (All lines remain in HUD)
    if (allLines.length > 0) {
      if (activePositions.length > 0) {
        html += `
          <div class="tv-hud-section-label-row" style="margin-top: 6px;">
            <span class="tv-hud-section-label">📐 DRAWN LINES (${armedCount}/${allLines.length} ARMED)</span>
          </div>
        `;
      }

      for (const line of allLines) {
        const isArmed = Boolean(line.isArmed);
        const color = this.getLineColor(line);
        const isExit = line.actionType === 'EXIT';

        let actionBadge = '';
        let actionClass = '';
        if (isArmed) {
          actionBadge = isExit ? 'CLOSE ALL' : `${line.direction} ${line.volume}L`;
          actionClass = isExit ? 'exit' : (line.direction === 'BUY' ? 'buy' : 'sell');
        } else {
          actionBadge = isExit ? 'CLOSE ALL (PAUSED)' : `${line.direction} ${line.volume}L (PAUSED)`;
          actionClass = 'paused';
        }

        let distStr = '-- pt';
        if (line._lastPriceDist !== undefined) {
          const priceStr = line._lastCalculatedPrice ? `$${line._lastCalculatedPrice.toFixed(2)} • ` : '';
          distStr = `${priceStr}${line._lastPriceDist.toFixed(1)} pt away`;
        } else if (line._lastCalculatedPrice) {
          distStr = `@ $${line._lastCalculatedPrice.toFixed(2)}`;
        }

        let timerHtml = '';
        if (line.triggeredCountdownEnd) {
          const remSec = Math.max(0, Math.floor((line.triggeredCountdownEnd - Date.now()) / 1000));
          if (remSec > 0) {
            const m = Math.floor(remSec / 60).toString().padStart(2, '0');
            const s = (remSec % 60).toString().padStart(2, '0');
            timerHtml = `<span class="tv-hud-timer">⏳ ${m}:${s}</span>`;
          }
        }

        html += `
          <div class="tv-hud-item ${isArmed ? '' : 'paused-item'}" data-line-id="${line.overlayId}">
            <div class="tv-hud-item-top">
              <span class="tv-hud-item-dot" style="background-color: ${color};"></span>
              <span class="tv-hud-item-name" title="${line.name}">${line.name}</span>
              <span class="tv-hud-badge ${actionClass}">${actionBadge}</span>
            </div>
            <div class="tv-hud-item-bottom">
              <span class="tv-hud-item-dist">${distStr}</span>
              ${timerHtml}
              <div class="tv-hud-item-actions">
                <button class="tv-hud-act-btn" data-act="settings" data-id="${line.overlayId}" title="Settings" style="touch-action: manipulation; cursor: pointer;">⚙</button>
                <button class="tv-hud-act-btn" data-act="toggle" data-id="${line.overlayId}" title="${isArmed ? 'Pause / Disarm' : 'Activate / Arm'}" style="touch-action: manipulation; cursor: pointer;">
                  ${isArmed ? '⏸' : '▶'}
                </button>
                <button class="tv-hud-act-btn delete" data-act="delete" data-id="${line.overlayId}" title="Delete" style="touch-action: manipulation; cursor: pointer;">✕</button>
              </div>
            </div>
          </div>
        `;
      }
    }

    html += `</div>`;
    this.hudEl.innerHTML = html;
  }
}
