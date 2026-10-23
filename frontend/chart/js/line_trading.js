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
import { evaluateCandleTrapState } from './living_candle_engine.js';

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
    this.slOverlayId = null;
    this.tpOverlayId = null;
    this.currentSpot = null;
    this.currentAsk = null;
    this.lastBidPrice = null;
    this.lastAskPrice = null;

    this.isDraggingLine = false;
    this.isDrawingLine = false;
    this.isDraggingSlTp = false;

    this.countdownTimer = null;
    this.isExecuting = false;
    this.hudMinimized = localStorage.getItem('escanor_hud_minimized') !== 'false'; // Compact pill by default
    this.activePositions = [];
    this.posStartTimes = new Map();

    this._init();
  }

  updatePositions(positions) {
    this.activePositions = Array.isArray(positions) ? positions : [];
    const activeTicketSet = new Set(this.activePositions.map(p => Number(p.ticket)));

    // Clean up start times for closed positions
    for (const ticket of this.posStartTimes.keys()) {
      if (!activeTicketSet.has(Number(ticket))) {
        this.posStartTimes.delete(Number(ticket));
      }
    }

    // Initialize or preserve start time for each active position
    const now = Date.now();
    for (const pos of this.activePositions) {
      const ticket = Number(pos.ticket);
      if (!this.posStartTimes.has(ticket)) {
        let startTime = now;
        if (pos.open_epoch_utc && pos.open_epoch_utc > 0) {
          startTime = pos.open_epoch_utc * 1000;
        } else if (pos.elapsed_sec !== undefined && pos.elapsed_sec > 0) {
          startTime = now - (pos.elapsed_sec * 1000);
        } else if (pos.time && pos.time > 0) {
          const nowSec = Math.floor(now / 1000);
          if (pos.time > 1500000000 && Math.abs(nowSec - pos.time) < 86400 * 30) {
            startTime = pos.time * 1000;
          }
        }
        this.posStartTimes.set(ticket, startTime);
      }
    }

    // Monitor trades triggered by our lines:
    for (const line of this.lines.values()) {
      // Auto-link activeTradeTicket if MT5 position comment matches line.name (e.g. across reloads)
      if (!line.activeTradeTicket) {
        for (const pos of this.activePositions) {
          if (pos.comment && (pos.comment.includes(line.name) || pos.comment.includes(`Line Touch ${line.name}`))) {
            line.activeTradeTicket = Number(pos.ticket);
            line.triggeredTicket = Number(pos.ticket);
            line._lastTradeTicket = Number(pos.ticket);
            line._tradeActive = true;
            if (!line._tradeActiveStartTime) {
              line._tradeActiveStartTime = this.posStartTimes.get(Number(pos.ticket)) || now;
            }
            break;
          }
        }
      }

      if (line.activeTradeTicket) {
        const ticket = Number(line.activeTradeTicket);
        // If the trade was active and is now no longer in open activePositions:
        if (!activeTicketSet.has(ticket)) {
          line._tradeActive = false;
          line._tradeActiveStartTime = null;
          line.activeTradeTicket = null;
          line.triggeredTicket = null;
          line._trapAutoBeArmed = false;
          line._trapAutoBeTicket = null;
          // USER RULE: Only THIS particular line trigger gets deactivated when its trade closes (even if in profit)
          line.isArmed = false;
          this.applyLineColor(line.overlayId);
          this._updateModalQuickArmBtn(line);
          this._updateFloatingToolbarArmBtn(line);
          this.saveToStorage();
          if (this.chart) {
            syncDrawingsToServer(this.symbol, this.chart, false);
          }
          this.renderHud(true);
          // Check MT5 closed deal history to see if it was a loss or win for notification toast
          this._checkClosedTradeResult(line, ticket);
        } else {
          // Trade is actively open: ensure trigger line overlay is hidden (prevents double line)
          this.applyLineColor(line.overlayId);
        }
      }
    }

    // Turn off prospective line SL/TP when active positions exist, or restore when clear
    this.updateSlTpProjections();
    this.renderHud();
  }

  deactivateLine(line, reason = '') {
    if (!line) return false;
    line.isArmed = false;
    line._tradeActive = false;
    line._tradeActiveStartTime = null;
    line.activeTradeTicket = null;
    line.triggeredTicket = null;
    line._trapAutoBeArmed = false;
    line._trapAutoBeTicket = null;
    this.applyLineColor(line.overlayId);
    this._updateModalQuickArmBtn(line);
    this._updateFloatingToolbarArmBtn(line);
    this.saveToStorage();
    if (this.chart) {
      syncDrawingsToServer(this.symbol, this.chart, false);
    }
    this.renderHud(true);
    if (reason) {
      console.log(`[LineTrading] Deactivated line ${line.name}: ${reason}`);
    }
    return true;
  }

  deactivateLineByTicket(ticket, reason = '') {
    if (!ticket) return false;
    const numTicket = Number(ticket);
    let matchedLine = null;
    for (const line of this.lines.values()) {
      if (Number(line.activeTradeTicket) === numTicket || Number(line.triggeredTicket) === numTicket || Number(line._lastTradeTicket) === numTicket) {
        matchedLine = line;
        break;
      }
    }
    if (matchedLine) {
      this.deactivateLine(matchedLine, `Trade #${numTicket} closed (${reason})`);
      showChartToast(`🔒 ${matchedLine.name}: Trade #${numTicket} closed. Line trigger deactivated.`);
      return true;
    }
    return false;
  }

  async _checkClosedTradeResult(line, ticket) {
    try {
      // USER RULE: The line trigger that activated this trade MUST be deactivated even if closed in profit.
      line.isArmed = false;
      this.applyLineColor(line.overlayId);
      this._updateModalQuickArmBtn(line);
      this._updateFloatingToolbarArmBtn(line);
      this.saveToStorage();
      if (this.chart) {
        syncDrawingsToServer(this.symbol, this.chart, false);
      }
      this.renderHud(true);

      const res = await fetch(`/api/trade/ticket_result?ticket=${ticket}`);
      const data = await res.json();
      if (data && (data.status === 'CLOSED' || data.profit !== undefined)) {
        const isLoss = Boolean(data.is_loss);
        const profit = Number(data.profit || 0);

        if (isLoss) {
          showChartToast(`🛑 ${line.name}: Trade #${ticket} lost (-$${Math.abs(profit).toFixed(2)}). Line trigger deactivated.`);
        } else {
          const sign = profit > 0 ? '+' : '';
          const icon = profit > 0 ? '🟢' : '⚪';
          showChartToast(`${icon} ${line.name}: Trade #${ticket} closed in profit (${sign}$${profit.toFixed(2)}). Line trigger deactivated.`);
        }
      } else {
        showChartToast(`🔒 ${line.name}: Trade #${ticket} closed. Line trigger deactivated.`);
      }
    } catch (err) {
      console.warn(`[LineTrading] Error checking ticket result for #${ticket}:`, err);
      line.isArmed = false;
      this.applyLineColor(line.overlayId);
      this.saveToStorage();
      this.renderHud(true);
    }
  }

  async killTrade(ticket) {
    if (!ticket) return;
    const numTicket = Number(ticket);
    try {
      showChartToast(`Closing #${numTicket}...`);
      const res = await fetch('/api/trade/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: numTicket })
      });
      const data = await res.json();
      const isSuccess = data && (
        data.status === 'CLOSED' ||
        data.status === 'OK' ||
        data.success ||
        (data.error && data.error.toLowerCase().includes('not found'))
      );
      if (isSuccess) {
        showChartToast(`🚨 Closed #${numTicket}!`);
        this.deactivateLineByTicket(numTicket, 'manual_kill');
        this.activePositions = this.activePositions.filter(p => Number(p.ticket) !== numTicket);
        this.posStartTimes.delete(numTicket);
        if (window.__lastActivePositions) {
          window.__lastActivePositions = window.__lastActivePositions.filter(p => Number(p.ticket) !== numTicket);
        }
        if (window.__activeOrdersEngine) {
          window.__activeOrdersEngine.updateData({ positions: this.activePositions });
        }
        this.renderHud(true);
      } else {
        showChartToast(`Close rejected: ${data?.error || data?.message || 'Execution rejected'}`);
      }
    } catch (err) {
      showChartToast(`Error closing #${numTicket}: ${err.message}`);
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
      this.posStartTimes.clear();
      if (window.__lastActivePositions) {
        window.__lastActivePositions = [];
      }
      if (window.__activeOrdersEngine) {
        window.__activeOrdersEngine.updateData({ positions: [] });
      }
      this.renderHud(true);
    } catch (err) {
      showChartToast(`Error closing all: ${err.message}`);
    }
  }

  deactivateAllLines() {
    let count = 0;
    for (const line of this.lines.values()) {
      if (line.isArmed) {
        line.isArmed = false;
        this.applyLineColor(line.overlayId);
        count++;
      }
    }
    this.saveToStorage();
    this.renderHud();
    return count;
  }

  toggleHudMinimize(forceState = null) {
    const now = Date.now();
    if (this._lastToggleTime && (now - this._lastToggleTime < 150)) {
      return;
    }
    this._lastToggleTime = now;

    if (typeof forceState === 'boolean') {
      this.hudMinimized = forceState;
    } else {
      this.hudMinimized = !this.hudMinimized;
    }
    try {
      localStorage.setItem('escanor_hud_minimized', String(this.hudMinimized));
    } catch (_) {}

    const sidebarPill = document.getElementById('tvSidebarHudPill');
    if (sidebarPill) {
      sidebarPill.classList.toggle('open', !this.hudMinimized);
    }

    if (this.hudEl) {
      this.hudEl.style.display = this.hudMinimized ? 'none' : 'flex';
      this.hudEl.classList.toggle('closed', Boolean(this.hudMinimized));
    }
    this.renderHud(true);
  }

  _init() {
    this.loadFromStorage();
    this._bindModalEvents();
    this._bindHudEvents();
    this._startCountdownWatchdog();
    window.killTrade = (ticket) => this.killTrade(ticket);
    window.killAllTrades = () => this.killAllTrades();
    window.toggleHudMinimize = (forceState = null) => this.toggleHudMinimize(forceState);

    const sidebarPill = document.getElementById('tvSidebarHudPill');
    sidebarPill?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHudMinimize();
    });
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_LINE_TRADING);
      if (raw) {
        const arr = JSON.parse(raw);
        let cleaned = false;
        for (const item of arr) {
          if (item && item.overlayId) {
            if (item.lineType === 'verticalStraightLine' || item.name === 'verticalStraightLine') {
              cleaned = true;
              continue;
            }
            if (item.slPts === 6.0 || item.slPts === undefined || item.slPts === null) {
              item.slPts = 3.0;
              cleaned = true;
            }
            if (item.trapAutoSlToTip === undefined) {
              item.trapAutoSlToTip = true;
              cleaned = true;
            }
            if (item.trapImmediateTrigger === undefined) {
              item.trapImmediateTrigger = true;
              cleaned = true;
            }
            if (item.trapBeEnabled === undefined) {
              item.trapBeEnabled = false;
              cleaned = true;
            }
            if (item.trapBeDispPips === undefined) {
              item.trapBeDispPips = (item.trapBeDispPts !== undefined) ? Math.round(Number(item.trapBeDispPts) * 10 * 10) / 10 : 15.0;
              cleaned = true;
            }
            if (item.trapBeDispPts === undefined) {
              item.trapBeDispPts = Math.round(item.trapBeDispPips * 0.10 * 100) / 100;
              cleaned = true;
            }
            if (item.trapBeOffsetPips === undefined) {
              item.trapBeOffsetPips = 0.3;
              cleaned = true;
            }
            this.lines.set(String(item.overlayId), item);
          }
        }
        if (cleaned) {
          this.saveToStorage();
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
    this.renderHud(true);
  }

  // Update all lines when global lot changes from top header
  updateAllVolumes(newLot) {
    if (!newLot || isNaN(newLot)) return;
    const vol = Number(newLot);
    for (const line of this.lines.values()) {
      line.volume = vol;
    }
    this.saveToStorage();
    this.updateSlTpProjections();
    this.renderHud(true);
  }

  // Register a line overlay when created or restored
  registerLineOverlay(overlay, lineType = 'segment') {
    if (!overlay || !overlay.id || overlay.name === 'verticalStraightLine' || lineType === 'verticalStraightLine') return;
    const idStr = String(overlay.id);

    if (!this.lines.has(idStr)) {
      const defLots = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : Number(localStorage.getItem('escanor_global_lot') || 1.00);
      const newLine = {
        overlayId: idStr,
        lineType: lineType,
        name: `Line #${this.lines.size + 1}`,
        isArmed: false, // DEACTIVATED BY DEFAULT!
        actionType: 'EXECUTE', // 'EXECUTE' or 'EXIT'
        direction: 'BUY',      // 'BUY' or 'SELL'
        volume: defLots,
        slPts: 3.0,
        tpPts: 12.0,
        timerEnabled: false,
        autoCloseMins: 5.0,
        trapColorEnabled: false,
        trapAutoSlToTip: true,   // Auto SL to tip of triggered trap candle (default: ON)
        trapImmediateTrigger: true, // Immediate trigger on trap candle form (default: ON)
        trapBeEnabled: false,    // Trap auto-breakeven toggle (default: OFF)
        trapBeDispPips: 15.0,    // BE trigger displacement in pips (default: 15.0 pips = 1.5 points)
        trapBeDispPts: 1.5,      // Equivalent points
        trapBeOffsetPips: 0.3,   // BE+ value in pips (default: 0.3 pips)
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
      this.clearSlTpProjections();
      if (this.modalEl) this.modalEl.style.display = 'none';
    }
    syncDrawingsToServer(this.symbol, this.chart, false, true);
  }

  clearAllLines() {
    this.lines.clear();
    this.selectedLineId = null;
    this.clearSlTpProjections();
    this.saveToStorage();
    if (this.modalEl) this.modalEl.style.display = 'none';
    syncDrawingsToServer(this.symbol, this.chart, false, true);
  }

  deactivateAllLines() {
    let count = 0;
    for (const [id, line] of this.lines.entries()) {
      if (line.isArmed) {
        line.isArmed = false;
        line._tradeActive = false;
        this.applyLineColor(id);
        this._updateModalQuickArmBtn(line);
        this._updateFloatingToolbarArmBtn(line);
        count++;
      }
    }
    this.saveToStorage();
    this.renderHud(true);
    if (this.chart) {
      syncDrawingsToServer(this.symbol, this.chart, false);
    }
    return count;
  }

  reconcileWithChart(chartOverlays = []) {
    let changed = false;
    for (const [id, item] of Array.from(this.lines.entries())) {
      if (item.lineType === 'verticalStraightLine' || item.name === 'verticalStraightLine') {
        this.lines.delete(id);
        changed = true;
      }
    }
    const activeOverlayIds = new Set(
      (chartOverlays || [])
        .filter(ov => ov.name !== 'verticalStraightLine')
        .map(ov => String(ov.id))
    );
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

  toggleLineArmed(overlayId) {
    const idStr = String(overlayId);
    let line = this.lines.get(idStr);
    if (!line) {
      this.registerLineOverlay({ id: overlayId });
      line = this.lines.get(idStr);
    }
    if (!line) return false;

    line.isArmed = !line.isArmed;
    if (line.isArmed) {
      line.activeTradeTicket = null;
      line._tradeActive = false;
      line._lastExecuteTrigger = 0;
      line._lastExitTrigger = 0;
      line.triggered = false;
      line.triggeredAt = null;
      line._lastTickBid = null;
    }

    this.applyLineColor(idStr);
    this.saveToStorage();
    this.updateSlTpProjections();
    this.renderHud(true);

    if (this.chart) {
      syncDrawingsToServer(this.symbol, this.chart, false);
    }

    this._updateModalQuickArmBtn(line);
    this._updateFloatingToolbarArmBtn(line);

    return line.isArmed;
  }

  _updateFloatingToolbarArmBtn(line) {
    const floatArmBtn = document.getElementById('tvFloatArmBtn');
    if (!floatArmBtn || !line) return;
    const isArmed = Boolean(line.isArmed);
    floatArmBtn.classList.toggle('armed', isArmed);
    floatArmBtn.classList.remove('buy', 'sell');
    if (isArmed) {
      if (line.direction === 'BUY') floatArmBtn.classList.add('buy');
      else if (line.direction === 'SELL') floatArmBtn.classList.add('sell');
    }
    floatArmBtn.title = isArmed ? '⚡ ACTIVE / ARMED (Click to Deactivate)' : '⚪ DEACTIVATED (Click to Activate)';
  }

  _updateModalQuickArmBtn(line) {
    const quickArmBtn = document.getElementById('tvLineQuickArmBtn');
    if (!quickArmBtn || !line) return;
    const isArmed = Boolean(line.isArmed);
    quickArmBtn.classList.toggle('active', isArmed);
    quickArmBtn.classList.toggle('armed', isArmed);
    quickArmBtn.classList.remove('buy', 'sell');
    if (isArmed) {
      if (line.direction === 'BUY') quickArmBtn.classList.add('buy');
      else if (line.direction === 'SELL') quickArmBtn.classList.add('sell');
    }
    const iconEl = document.getElementById('tvLineQuickArmIcon');
    const textEl = document.getElementById('tvLineQuickArmText');
    if (iconEl) iconEl.textContent = isArmed ? '⚡' : '⚪';
    if (textEl) textEl.textContent = isArmed ? 'ACTIVE' : 'ACTIVATE';
    quickArmBtn.title = isArmed ? 'Line Trigger is ACTIVE (Click to Deactivate)' : 'Line Trigger is DEACTIVATED (Click to Activate)';
  }

  getLineColor(line) {
    if (!line) return '#94a3b8';

    // If line is armed, or if currently being configured in modal
    const isConfiguring = Boolean(this.selectedLineId && String(this.selectedLineId) === String(line.overlayId) && this.modalEl && this.modalEl.style.display !== 'none');
    const isActivated = Boolean(line.isArmed || (isConfiguring && this._trapColorEnabled));

    if (!isActivated) {
      return '#94a3b8';  // Clean disarmed silver-gray
    }

    if (line.actionType === 'EXECUTE') {
      return line.direction === 'BUY' ? '#00e5ff' : '#f59e0b';
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

    const isSelected = (this.selectedLineId === String(overlayId));
    const baseColor = this.getLineColor(line);
    const coreSize = line.isArmed ? 2.5 : 1.5;

    try {

      this.chart.overrideOverlay({
        id: line.overlayId,
        zLevel: 100,
        styles: {
          line: {
            color: baseColor,
            size: coreSize,
            style: 'solid'
          },
          point: {
            color: isSelected ? '#ffffff' : baseColor,
            borderColor: isSelected ? '#ffffff' : baseColor,
            activeColor: '#ffffff',
            activeBorderColor: '#ffffff',
            radius: isSelected ? 5.5 : (line.isArmed ? 5 : 4)
          }
        }
      });
      syncDrawingsToServer(this.symbol, this.chart, false);
      if (isSelected) {
        this._updateFloatingToolbarArmBtn(line);
      }
    } catch (e) {
      console.warn('[LineTrading] Error applying line color:', e);
    }
  }

  toggleSelectLine(overlayId) {
    const idStr = String(overlayId);
    const newId = (this.selectedLineId === idStr) ? null : idStr;
    this.setSelectedLineId(newId);
  }

  setSelectedLineId(overlayId) {
    const prevId = this.selectedLineId;
    this.selectedLineId = overlayId ? String(overlayId) : null;
    if (prevId && prevId !== this.selectedLineId) {
      this.applyLineColor(prevId);
    }
    if (this.selectedLineId) {
      this.applyLineColor(this.selectedLineId);
    }
    this.updateSlTpProjections();
    this.renderHud(true);
  }

  clearSlTpProjections() {
    if (!this.chart) return;
    if (this.slOverlayId) {
      try { this.chart.removeOverlay({ id: this.slOverlayId }); } catch (_) {}
      this.slOverlayId = null;
    }
    if (this.tpOverlayId) {
      try { this.chart.removeOverlay({ id: this.tpOverlayId }); } catch (_) {}
      this.tpOverlayId = null;
    }
  }

  updateSlTpProjections() {
    // While user is dragging SL or TP line, never override overlays from background tick updates!
    if (this.isDraggingSlTp || window.__isDraggingSlTp) {
      return;
    }

    if (!this.chart || !this.selectedLineId) {
      this.clearSlTpProjections();
      return;
    }

    // 1. USER RULE: When a trade is active, turn OFF prospective SL/TP for lines
    const hasActiveTrade = (this.activePositions && this.activePositions.length > 0);
    if (hasActiveTrade) {
      this.clearSlTpProjections();
      return;
    }

    const line = this.lines.get(this.selectedLineId);
    // 2. USER RULE: SL/TP show ONLY when the line is armed and configured for execution
    if (!line || !line.isArmed || line.actionType !== 'EXECUTE') {
      this.clearSlTpProjections();
      return;
    }

    let linePrice = line._lastCalculatedPrice;
    if (!linePrice) {
      const overlays = this.chart.getOverlays() || [];
      const ov = overlays.find(o => String(o.id) === String(line.overlayId));
      if (ov) {
        linePrice = this._calculateLinePriceAtCurrentTime(ov);
      }
    }
    if (!linePrice || isNaN(linePrice) || linePrice <= 0) {
      linePrice = this.currentSpot || this.lastBidPrice;
    }
    if (!linePrice || isNaN(linePrice) || linePrice <= 0) {
      this.clearSlTpProjections();
      return;
    }

    const isBuy = (line.direction === 'BUY');
    const volume = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : Math.max(0.01, Number(line.volume || 1.00));
    const slPts = Math.max(0.1, Number(line.slPts || 3.0));
    const tpPts = Math.max(0.1, Number(line.tpPts || 12.0));

    const tpPrice = isBuy ? (linePrice + tpPts) : (linePrice - tpPts);
    const slPrice = isBuy ? (linePrice - slPts) : (linePrice + slPts);

    const rewardDollars = tpPts * volume * 100;
    const riskDollars = slPts * volume * 100;

    const tpTitle = `🎯 TP: $${tpPrice.toFixed(2)} [+$${rewardDollars.toFixed(2)} • +${tpPts.toFixed(1)} pt] (${volume.toFixed(2)}L)`;
    const slTitle = `🛑 SL: $${slPrice.toFixed(2)} [-$${riskDollars.toFixed(2)} • -${slPts.toFixed(1)} pt] (${volume.toFixed(2)}L)`;

    const tpId = `sltp_tp_${line.overlayId}`;
    const slId = `sltp_sl_${line.overlayId}`;

    const tpOptions = {
      id: tpId,
      name: 'lineSlTpMarking',
      points: [{ value: tpPrice }],
      lock: false,
      zLevel: Number.MAX_SAFE_INTEGER,
      fixedZLevel: true,
      extendData: {
        type: 'TP',
        title: tpTitle,
        price: tpPrice,
        linePrice: linePrice,
        volume: volume,
        direction: line.direction,
        parentLineId: line.overlayId
      },
      onPressedMoveStart: (e) => {
        this._onSlTpDragStart(e);
      },
      onPressedMoving: (e) => {
        this._onSlTpDragMoving(e);
      },
      onPressedMoveEnd: (e) => {
        this._onSlTpDragEnd(e);
      }
    };

    const slOptions = {
      id: slId,
      name: 'lineSlTpMarking',
      points: [{ value: slPrice }],
      lock: false,
      zLevel: Number.MAX_SAFE_INTEGER,
      fixedZLevel: true,
      extendData: {
        type: 'SL',
        title: slTitle,
        price: slPrice,
        linePrice: linePrice,
        volume: volume,
        direction: line.direction,
        parentLineId: line.overlayId
      },
      onPressedMoveStart: (e) => {
        this._onSlTpDragStart(e);
      },
      onPressedMoving: (e) => {
        this._onSlTpDragMoving(e);
      },
      onPressedMoveEnd: (e) => {
        this._onSlTpDragEnd(e);
      }
    };

    const allOverlays = this.chart.getOverlays() || [];

    const hasTp = allOverlays.some(o => o.id === tpId);
    if (hasTp) {
      try {
        this.chart.overrideOverlay(tpOptions);
        this.tpOverlayId = tpId;
      } catch (_) {}
    } else {
      if (this.tpOverlayId) {
        try { this.chart.removeOverlay({ id: this.tpOverlayId }); } catch (_) {}
      }
      try {
        const id = this.chart.createOverlay(tpOptions);
        this.tpOverlayId = id || tpId;
      } catch (err) {
        console.warn('[LineTrading] Error creating TP overlay:', err);
      }
    }

    const hasSl = allOverlays.some(o => o.id === slId);
    if (hasSl) {
      try {
        this.chart.overrideOverlay(slOptions);
        this.slOverlayId = slId;
      } catch (_) {}
    } else {
      if (this.slOverlayId) {
        try { this.chart.removeOverlay({ id: this.slOverlayId }); } catch (_) {}
      }
      try {
        const id = this.chart.createOverlay(slOptions);
        this.slOverlayId = id || slId;
      } catch (err) {
        console.warn('[LineTrading] Error creating SL overlay:', err);
      }
    }
  }

  _onSlTpDragStart(e) {
    this.isDraggingSlTp = true;
    window.__isDraggingSlTp = true;
    this._draggingSlTpStartTime = Date.now();
    const parentId = e?.overlay?.extendData?.parentLineId;
    if (parentId) {
      this.selectedLineId = String(parentId);
    }
  }

  _onSlTpDragMoving(e) {
    this.isDraggingSlTp = true;
    window.__isDraggingSlTp = true;
    const ov = e?.overlay;
    const price = ov?.points?.[0]?.value;
    const data = ov?.extendData;
    if (!price || !data) return;
    if (data.parentLineId && !this.selectedLineId) {
      this.selectedLineId = String(data.parentLineId);
    }
    if (!this.selectedLineId) return;

    const line = this.lines.get(this.selectedLineId);
    if (!line || line.actionType !== 'EXECUTE') return;

    const isTp = (data.type === 'TP');
    const isBuy = (line.direction === 'BUY');
    const linePrice = Number(data.linePrice || line._lastCalculatedPrice);
    if (!linePrice || isNaN(linePrice)) return;

    let distPts = 0;
    if (isTp) {
      if (isBuy) {
        distPts = (price > linePrice) ? (price - linePrice) : 0.5;
      } else {
        distPts = (linePrice > price) ? (linePrice - price) : 0.5;
      }
    } else {
      if (isBuy) {
        distPts = (linePrice > price) ? (linePrice - price) : 0.5;
      } else {
        distPts = (price > linePrice) ? (price - linePrice) : 0.5;
      }
    }
    distPts = Math.max(0.5, Math.round(distPts * 10) / 10);

    // If settings modal is open for this line, sync inputs in real time
    if (this.modalEl && this.modalEl.style.display !== 'none' && this.selectedLineId === line.overlayId) {
      if (isTp) {
        const tpInp = document.getElementById('tvLineTpPts');
        if (tpInp) tpInp.value = distPts.toFixed(1);
      } else {
        const slInp = document.getElementById('tvLineSlPts');
        if (slInp) slInp.value = distPts.toFixed(1);
      }
      this._updateDollarPnlBox();
    }
  }

  _onSlTpDragEnd(e) {
    const ov = e?.overlay;
    const data = ov?.extendData;
    if (data?.parentLineId) {
      this.selectedLineId = String(data.parentLineId);
    }

    this._draggingSlTpStartTime = null;
    setTimeout(() => {
      this.isDraggingSlTp = false;
      window.__isDraggingSlTp = false;
    }, 250);

    const price = ov?.points?.[0]?.value;
    if (!price || !data || !this.selectedLineId) return;

    const line = this.lines.get(this.selectedLineId);
    if (!line || line.actionType !== 'EXECUTE') return;

    const isTp = (data.type === 'TP');
    const isBuy = (line.direction === 'BUY');
    const linePrice = Number(data.linePrice || line._lastCalculatedPrice);
    if (!linePrice || isNaN(linePrice)) return;

    let distPts = 0;
    if (isTp) {
      if (isBuy) {
        distPts = (price > linePrice) ? (price - linePrice) : 0.5;
      } else {
        distPts = (linePrice > price) ? (linePrice - price) : 0.5;
      }
    } else {
      if (isBuy) {
        distPts = (linePrice > price) ? (linePrice - price) : 0.5;
      } else {
        distPts = (price > linePrice) ? (price - linePrice) : 0.5;
      }
    }
    distPts = Math.max(0.5, Math.round(distPts * 10) / 10);

    if (isTp) {
      line.tpPts = distPts;
    } else {
      line.slPts = distPts;
    }

    this.saveToStorage();

    // If modal open, sync and update preview
    if (this.modalEl && this.modalEl.style.display !== 'none' && this.selectedLineId === line.overlayId) {
      const slInp = document.getElementById('tvLineSlPts');
      const tpInp = document.getElementById('tvLineTpPts');
      if (slInp) slInp.value = line.slPts.toFixed(1);
      if (tpInp) tpInp.value = line.tpPts.toFixed(1);
      this._updateDollarPnlBox();
    }

    this.updateSlTpProjections();
    this.renderHud();

    const finalPrice = Math.round(price * 100) / 100;
    const volume = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : Number(line.volume || 1.00);
    const dollars = distPts * volume * 100;
    const icon = isTp ? '🎯' : '🛑';
    const sign = isTp ? '+' : '-';
    showChartToast(`${icon} ${line.name} ${isTp ? 'TP' : 'SL'} updated: $${finalPrice.toFixed(2)} [${sign}$${dollars.toFixed(2)} • ${sign}${distPts.toFixed(1)} pt] (${volume.toFixed(2)}L)`);
  }

  // Set drag / draw flags to prevent accidental trigger
  setDragging(isDragging) {
    this.isDraggingLine = Boolean(isDragging);
    this._draggingStartTime = isDragging ? Date.now() : null;
    if (!this.isDraggingLine) {
      this._updateAllLineDistances();
      this.updateSlTpProjections();
      this.renderHud(true);
    }
  }

  setDrawing(isDrawing) {
    this.isDrawingLine = Boolean(isDrawing);
    this._drawingStartTime = isDrawing ? Date.now() : null;
    if (!this.isDrawingLine) {
      this._updateAllLineDistances();
      this.updateSlTpProjections();
      this.renderHud(true);
    }
  }

  _updateAllLineDistances() {
    if (!this.chart) return;
    const curSpot = this.currentSpot || this.lastBidPrice;
    if (!curSpot) return;

    const chartOverlays = this.chart.getOverlays() || [];
    const overlayMap = new Map(chartOverlays.map(o => [String(o.id), o]));

    for (const line of this.lines.values()) {
      const ov = overlayMap.get(String(line.overlayId));
      if (!ov || !ov.points || ov.points.length === 0) continue;

      const linePrice = this._calculateLinePriceAtCurrentTime(ov);
      if (linePrice === null || isNaN(linePrice) || linePrice <= 0) continue;

      line._lastCalculatedPrice = linePrice;
      const isBuyAction = (line.actionType === 'EXECUTE' && line.direction === 'BUY');
      const testPrice = isBuyAction ? (this.currentAsk || curSpot) : curSpot;
      line._lastPriceDist = Math.abs(testPrice - linePrice);
    }
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

    // Safety auto-reset if any drag or drawing state was left stuck (e.g. mouseup missed or escape)
    const now = Date.now();
    if (this._drawingStartTime && now - this._drawingStartTime > 6000) {
      this.isDrawingLine = false;
      this._drawingStartTime = null;
    }
    if (this._draggingStartTime && now - this._draggingStartTime > 6000) {
      this.isDraggingLine = false;
      this._draggingStartTime = null;
    }
    if (this._draggingSlTpStartTime && now - this._draggingSlTpStartTime > 6000) {
      this.isDraggingSlTp = false;
      window.__isDraggingSlTp = false;
      this._draggingSlTpStartTime = null;
    }

    // Do NOT trigger while user is actively drawing or dragging a line or SL/TP!
    if (this.isDraggingLine || this.isDrawingLine || this.isDraggingSlTp || window.__isDraggingSlTp) {
      this.renderHud();
      return;
    }

    if (!this.chart) return;

    const chartOverlays = this.chart.getOverlays() || [];
    const overlayMap = new Map(chartOverlays.map(o => [String(o.id), o]));

    const dataList = this.chart.getDataList() || [];
    const latestBar = dataList.length > 0 ? dataList[dataList.length - 1] : null;

    // 🛡️ REAL-TIME TRAP CANDLE AUTO-BREAKEVEN WATCHDOG (+0.3p at +1.5pt displacement):
    // USER RULE: "let it break even at 1.5 points instead of 2.5 and break even + 0.3 pips"
    for (const line of this.lines.values()) {
      if (line._trapAutoBeArmed && line._trapAutoBeTicket) {
        const ticketNum = Number(line._trapAutoBeTicket);
        const posIsOpen = this.activePositions && this.activePositions.some(p => Number(p.ticket) === ticketNum);
        if (!posIsOpen) {
          line._trapAutoBeArmed = false;
          line._trapAutoBeTicket = null;
          continue;
        }

        const isBuy = line._trapAutoBeSide === 'BUY';
        const threshold = line._trapDispThreshold;
        const targetSl = line._trapTargetSl;
        const curPrice = isBuy ? bid : (ask || bid);
        const hitDisplacement = isBuy ? (curPrice >= threshold) : (curPrice <= threshold);

        if (hitDisplacement && targetSl) {
          line._trapAutoBeArmed = false; // Disarm immediately to prevent duplicate firing
          console.log(`[LineTrading] 🛡️ Trap Auto-BE displacement reached (${isBuy ? '+' : '-'}1.5pt @ $${curPrice})! Modifying #${ticketNum} -> SL $${targetSl}`);
          fetch('/api/trade/modify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket: ticketNum, sl: targetSl })
          }).then(r => r.json()).then(res => {
            if (res && res.status === 'OK') {
              showChartToast(`🛡️ Trap Auto-Breakeven (+0.3p)! #${ticketNum} SL moved to $${targetSl.toFixed(2)}`);
              if (!window.__activeTradesSlTp) window.__activeTradesSlTp = {};
              window.__activeTradesSlTp[ticketNum] = { ...(window.__activeTradesSlTp[ticketNum] || {}), sl: targetSl };
              if (window.__activeOrdersEngine) {
                const pos = window.__activeOrdersEngine.activePositions?.find(p => Number(p.ticket) === ticketNum);
                if (pos) pos.sl = targetSl;
                window.__activeOrdersEngine.render();
              }
              this.renderHud();
            }
          }).catch(e => console.warn('[LineTrading] Trap auto-BE error:', e));
        }
      }
    }

    for (const line of this.lines.values()) {
      const ov = overlayMap.get(String(line.overlayId));
      if (!ov || !ov.points || ov.points.length === 0) continue;

      const linePrice = this._calculateLinePriceAtCurrentTime(ov);
      if (linePrice === null || isNaN(linePrice) || linePrice <= 0) continue;

      line._lastCalculatedPrice = linePrice;

      // Price distance from live chart spot (Bid)
      line._lastPriceDist = Math.abs(bid - linePrice);

      // ONLY armed lines trigger collision execution:
      if (!line.isArmed) continue;

      if (window.__isDrawdownLocked) {
        line.isArmed = false;
        continue;
      }

      // USER RULE: "only one trade should be active at a time even it touches any line"
      // USER RULE: "only 1 trade should be active at a time"
      // If ANY position is currently open in MT5 or currently executing, DO NOT trigger any entry line!
      const hasActivePositions = (this.activePositions && this.activePositions.length > 0) ||
                                 (window.__lastActivePositions && window.__lastActivePositions.length > 0) ||
                                 Boolean(this.isExecuting) ||
                                 Boolean(window.__isExecutingTrade);
      if (line.actionType === 'EXECUTE' && hasActivePositions) {
        continue;
      }

      // COLLISION CHECK:
      // The chart price space is BID (all candles & wicks are rendered at Bid).
      if (line.trapColorEnabled && line.actionType === 'EXECUTE') {
        // ⚡ CANDLE TRAP COLOR TRIGGER MODE:
        // USER RULE: It MUST be the CURRENT touched candle that forms Cyan or Yellow (NOT previous candles)!
        // Triggers the split-second the CURRENT touching candle forms Cyan (for BUY) or Yellow (for SELL)
        // even if price has moved away from the line, as long as any part of the candle is touching/overlapping the line.
        let trapTriggered = false;

        if (latestBar) {
          // Bar deduplication: Do not re-trigger on the exact same bar that already fired
          if (line._lastTriggeredBarTime && line._lastTriggeredBarTime === latestBar.timestamp) {
            continue;
          }

          // Evaluate the current living candle (dataList.length - 1)
          const trapStateCurr = evaluateCandleTrapState(dataList, dataList.length - 1, linePrice);
          const isImmediate = (line.trapImmediateTrigger !== false);

          if (isImmediate) {
            // Immediate Trigger Mode: Fires immediately on trap form & line touch
            if (trapStateCurr.candleOverlapsLine) {
              if (line.direction === 'BUY' && trapStateCurr.isCyan) {
                trapTriggered = true;
              } else if (line.direction === 'SELL' && trapStateCurr.isYellow) {
                trapTriggered = true;
              }
            }
          } else {
            // Ignition Mode: Registers trap and waits for price to break the trap candle's extreme
            if (!line._pendingTrapCandle) {
              if (trapStateCurr.candleOverlapsLine) {
                if (line.direction === 'BUY' && trapStateCurr.isCyan) {
                  line._pendingTrapCandle = { high: latestBar.high, low: latestBar.low, barTime: latestBar.timestamp, dir: 'BUY' };
                } else if (line.direction === 'SELL' && trapStateCurr.isYellow) {
                  line._pendingTrapCandle = { high: latestBar.high, low: latestBar.low, barTime: latestBar.timestamp, dir: 'SELL' };
                }
              }
            } else {
              if (line.direction === 'BUY') {
                if (bid > line._pendingTrapCandle.high) {
                  trapTriggered = true;
                  line._pendingTrapCandle = null;
                } else if (bid < (line._pendingTrapCandle.low - 0.20)) {
                  line._pendingTrapCandle = null; // Breached below trap low, invalidated
                }
              } else if (line.direction === 'SELL') {
                if (bid < line._pendingTrapCandle.low) {
                  trapTriggered = true;
                  line._pendingTrapCandle = null;
                } else if (bid > (line._pendingTrapCandle.high + 0.20)) {
                  line._pendingTrapCandle = null; // Breached above trap high, invalidated
                }
              }
            }
          }
        }

        if (trapTriggered) {
          line._lastTriggeredBarTime = latestBar ? latestBar.timestamp : Date.now();
          line._lastTriggeredBar = latestBar;
          this._executeLineTrigger(line, linePrice);
          break; // Stop evaluating further lines on this tick! Only 1 trade active at a time!
        }
      } else {
        // Standard touch trigger (when candle trap trigger is INACTIVE):
        // ⚡ DIRECTIONAL SPREAD-COMPENSATED PRICING: BUY fills at Ask, SELL fills at Bid!
        const isBuyAction = (line.direction === 'BUY');
        const triggerTestPrice = isBuyAction ? (ask || bid) : bid;

        // 1. Initial tick anchor guard: Never trigger on the first tick after arming!
        if (line._lastTickTestPrice === undefined || line._lastTickTestPrice === null) {
          line._lastTickTestPrice = triggerTestPrice;
          continue;
        }

        const prevPrice = line._lastTickTestPrice;
        line._lastTickTestPrice = triggerTestPrice; // update for next tick

        // 2. Strict touch threshold: 0.05 pt ($0.05 / 0.5 pip) - must be an actual physical touch!
        const isTouched = Math.abs(triggerTestPrice - linePrice) <= 0.05;

        // 3. Directional cross: price must have moved across the line from one side to the other
        const crossedFromBelow = (prevPrice < linePrice && triggerTestPrice >= linePrice);
        const crossedFromAbove = (prevPrice > linePrice && triggerTestPrice <= linePrice);
        const isCrossed = crossedFromBelow || crossedFromAbove;

        if (isTouched || isCrossed) {
          this._executeLineTrigger(line, linePrice);
          break; // Stop evaluating further lines on this tick! Only 1 trade active at a time!
        }
      }
    }

    if (this.selectedLineId && !this.isDraggingSlTp) {
      this.updateSlTpProjections();
    }

    this.renderHud();
  }

  _calculateLinePriceAtCurrentTime(overlay) {
    if (!overlay || overlay.name === 'verticalStraightLine' || !overlay.points || overlay.points.length === 0) return null;
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
      if (dataList.length === 0) return (v1 + v2) / 2;

      const latestBar = dataList[dataList.length - 1];
      const latestIndex = dataList.length - 1;
      const latestTime = latestBar ? latestBar.timestamp : Date.now();

      const t1 = (p1.timestamp !== undefined && p1.timestamp > 0) ? Number(p1.timestamp) : null;
      const t2 = (p2.timestamp !== undefined && p2.timestamp > 0) ? Number(p2.timestamp) : null;

      const isSegment = (overlay.name === 'segment');
      const lineObj = this.lines.get(String(overlay.id));
      const isExtended = Boolean(lineObj?.extendRay) || (overlay.name === 'rayLine') || (overlay.name === 'straightLine');

      const barMs = (dataList.length >= 2)
        ? Math.max(1000, dataList[dataList.length - 1].timestamp - dataList[dataList.length - 2].timestamp)
        : ((window.__currentTimeframeMinutes || 5) * 60 * 1000);

      // Interpolate with timestamps (most robust across scrolls and timeframes)
      if (t1 !== null && t2 !== null && t1 !== t2) {
        const pLeft = (t1 <= t2) ? p1 : p2;
        const pRight = (t1 <= t2) ? p2 : p1;
        const vLeft = Number(pLeft.value);
        const vRight = Number(pRight.value);
        const tLeft = Number(pLeft.timestamp);
        const tRight = Number(pRight.timestamp);

        // If it's a finite segment (NOT extended ray):
        // If current candle is past the end of the segment, it has expired in the past!
        if (isSegment && !isExtended) {
          if (latestTime > (tRight + barMs * 0.75)) {
            return null; // Segment ended in the past; cannot trigger on current candle!
          }
          if (latestTime < (tLeft - barMs * 0.75)) {
            return null; // Segment starts in the future!
          }
        }

        const timeDelta = tRight - tLeft;
        if (timeDelta > 0) {
          const slopePerMs = (vRight - vLeft) / timeDelta;
          const curVal = vRight + slopePerMs * (latestTime - tRight);
          if (!isNaN(curVal) && curVal > 0) return curVal;
        }
      }

      // Fallback with dataIndex relative to current bar
      const idx1 = (p1.dataIndex !== undefined) ? Number(p1.dataIndex) : null;
      const idx2 = (p2.dataIndex !== undefined) ? Number(p2.dataIndex) : null;
      if (idx1 !== null && idx2 !== null && idx1 !== idx2) {
        const pLeft = (idx1 <= idx2) ? p1 : p2;
        const pRight = (idx1 <= idx2) ? p2 : p1;
        const idxLeft = Math.min(idx1, idx2);
        const idxRight = Math.max(idx1, idx2);

        if (isSegment && !isExtended && latestIndex > idxRight) {
          return null; // Segment ended in the past
        }

        const slope = (Number(pRight.value) - Number(pLeft.value)) / (idxRight - idxLeft);
        const curVal = Number(pRight.value) + slope * (latestIndex - idxRight);
        if (!isNaN(curVal) && curVal > 0) return curVal;
      }

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

    // 2. Trade Entry Line (EXECUTE): USER RULE: "only 1 trade should be active at a time"
    if (window.__isDrawdownLocked) {
      console.warn(`[LineTrading] ⛔ Drawdown locked: blocked trade on ${line.name}`);
      showChartToast('⛔ DAILY DRAWDOWN HIT ($0.00). Trading is LOCKED until manually disabled in settings.');
      line.isArmed = false;
      this.applyLineColor(line.overlayId);
      this.renderHud();
      return;
    }

    const hasActivePositions = (this.activePositions && this.activePositions.length > 0) ||
                               (window.__lastActivePositions && window.__lastActivePositions.length > 0) ||
                               Boolean(this.isExecuting) ||
                               Boolean(window.__isExecutingTrade);
    if (hasActivePositions) {
      console.log(`[LineTrading] 🛑 Blocked entry on ${line.name}: only 1 trade active at a time!`);
      return;
    }

    // Cooldown check (6 seconds)
    if (line._lastExecuteTrigger && (now - line._lastExecuteTrigger < 6000)) return;
    line._lastExecuteTrigger = now;

    this.isExecuting = true;
    window.__isExecutingTrade = true;
    console.log(`[LineTrading] ⚡ ENTRY TRIGGER HIT on ${line.name} @ $${triggerPrice.toFixed(2)} (${line.direction})`);

    try {
      const side = line.direction || 'BUY';
      const vol = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : (line.volume || 1.00);
      const slPts = line.slPts || 3.0;
      const tpPts = line.tpPts || 12.0;

      let slPrice = side === 'BUY' ? triggerPrice - slPts : triggerPrice + slPts;
      const tpPrice = side === 'BUY' ? triggerPrice + tpPts : triggerPrice - tpPts;

      // Auto SL to tip of triggered trap candle (default: ON)
      const isTrap = Boolean(line.trapColorEnabled);
      const autoSlToTip = isTrap && (line.trapAutoSlToTip !== false);
      const triggeredBar = line._lastTriggeredBar;
      if (autoSlToTip && triggeredBar) {
        if (side === 'BUY' && typeof triggeredBar.low === 'number' && triggeredBar.low < triggerPrice) {
          slPrice = Math.round(triggeredBar.low * 100) / 100;
          console.log(`[LineTrading] 🎯 Auto SL placed at Cyan candle tip (Low: $${slPrice.toFixed(2)})`);
        } else if (side === 'SELL' && typeof triggeredBar.high === 'number' && triggeredBar.high > triggerPrice) {
          slPrice = Math.round(triggeredBar.high * 100) / 100;
          console.log(`[LineTrading] 🎯 Auto SL placed at Yellow candle tip (High: $${slPrice.toFixed(2)})`);
        }
      }

      // Trap Auto-Breakeven toggle (default: OFF) & displacement/offset (both in pips)
      const trapBeOn = isTrap && Boolean(line.trapBeEnabled);
      const dispPips = (typeof line.trapBeDispPips === 'number' && line.trapBeDispPips > 0) ? line.trapBeDispPips : ((typeof line.trapBeDispPts === 'number' && line.trapBeDispPts > 0) ? line.trapBeDispPts * 10 : 15.0);
      const dispPts = Math.round(dispPips * 0.10 * 100) / 100;
      const offsetPips = (typeof line.trapBeOffsetPips === 'number' && line.trapBeOffsetPips >= 0) ? line.trapBeOffsetPips : 0.3;

      const tradePayload = {
        action: 'EXECUTE_LINE',
        request_id: 'exec_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        symbol: this.symbol,
        side: side,
        volume: vol,
        sl: Math.round(slPrice * 100) / 100,
        tp: Math.round(tpPrice * 100) / 100,
        comment: isTrap ? `Trap ${side === 'BUY' ? 'CYAN' : 'YELLOW'} ${line.name}` : `Line Touch ${line.name}`,
        source: 'line',
        trap_trade: trapBeOn,
        trap_be_enabled: trapBeOn,
        trigger_price: triggerPrice,
        auto_be_displacement: dispPts,
        auto_be_displacement_pips: dispPips,
        auto_be_offset_pips: offsetPips
      };

      // ⚡ Fast execution route: Send directly over open WebSocket (<1ms) or fallback to HTTP POST
      let data = null;
      const ws = window.__escanorWs;
      if (ws && ws.readyState === WebSocket.OPEN) {
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

      if (!data) {
        const res = await fetch('/api/trade/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tradePayload)
        });
        data = await res.json();
      }
      if (data && (data.status === 'EXECUTED' || data.ticket)) {
        const ticket = data.ticket;
        line.activeTradeTicket = ticket;
        line.triggeredTicket = ticket;
        line._tradeActive = true;
        line._tradeActiveStartTime = Date.now();
        this.posStartTimes.set(Number(ticket), Date.now());
        // Optimistically record position to prevent any subsequent trade trigger
        const finalSl = Math.round(slPrice * 100) / 100;
        const finalTp = Math.round(tpPrice * 100) / 100;
        if (!this.activePositions.some(p => Number(p.ticket) === Number(ticket))) {
          this.activePositions.push({
            ticket: ticket,
            type: side,
            price: triggerPrice,
            volume: vol,
            sl: finalSl,
            tp: finalTp,
            comment: line.trapColorEnabled ? `Trap ${side === 'BUY' ? 'CYAN' : 'YELLOW'} ${line.name}` : `Line Touch ${line.name}`
          });
        }
        window.__lastActivePositions = this.activePositions;
        window.__activeTradeTriggerTime = Date.now();
        window.__posActiveClientStart = Date.now();
        if (!window.__activeTradesSlTp) window.__activeTradesSlTp = {};
        window.__activeTradesSlTp[ticket] = { sl: finalSl, tp: finalTp };
        if (window.__activeOrdersEngine) {
          window.__activeOrdersEngine.updateData({
            positions: this.activePositions,
            bid: this.currentSpot,
            ask: this.currentAsk
          });
        }
        // THE LINE REMAINS ARMED AND ACTIVE (AND FULLY VISIBLE ON CHART)!
        line.isArmed = true;
        if (line.trapColorEnabled) {
          const trapName = side === 'BUY' ? 'CYAN BUY TRAP' : 'YELLOW SELL TRAP';
          if (trapBeOn) {
            line._trapAutoBeTicket = ticket;
            line._trapTriggerPrice = triggerPrice;
            line._trapAutoBeSide = side;
            line._trapAutoBeArmed = true;
            // 0.3 pips on Gold = 0.03 point ($0.03) -> delta = offsetPips * 0.10
            const offsetDelta = Math.round(offsetPips * 0.10 * 100) / 100;
            line._trapDispThreshold = side === 'BUY' ? Math.round((triggerPrice + dispPts) * 100) / 100 : Math.round((triggerPrice - dispPts) * 100) / 100;
            line._trapTargetSl = side === 'BUY' ? Math.round((triggerPrice + offsetDelta) * 100) / 100 : Math.round((triggerPrice - offsetDelta) * 100) / 100;
            showChartToast(`⚡ ${line.name} [${trapName}]: Filled ${side} ${vol}L! #${ticket}. Auto-BE +${offsetPips}p armed @ ${dispPips}p disp ($${line._trapDispThreshold.toFixed(2)})`);
          } else {
            line._trapAutoBeArmed = false;
            line._trapAutoBeTicket = null;
            showChartToast(`⚡ ${line.name} [${trapName}]: Filled ${side} ${vol}L! #${ticket}. Line remains ARMED!`);
          }
        } else {
          showChartToast(`⚡ ${line.name}: Filled ${side} ${vol}L! Ticket #${ticket}. Line remains ARMED!`);
        }

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
      window.__isExecutingTrade = false;
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
    if (slInput) slInput.value = line.slPts || 3.0;
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

    // Candle Trap Trigger toggle (Cyan Buy / Yellow Sell)
    this._trapColorEnabled = Boolean(line.trapColorEnabled);

    // Auto-SL to Tip of Triggered Trap Candle (default: true / ON)
    this._trapAutoSlToTip = line.trapAutoSlToTip !== undefined ? Boolean(line.trapAutoSlToTip) : true;
    const btnTrapAutoSl = document.getElementById('tvBtnToggleTrapAutoSl');
    if (btnTrapAutoSl) {
      btnTrapAutoSl.textContent = this._trapAutoSlToTip ? 'ON' : 'OFF';
      btnTrapAutoSl.classList.toggle('active', this._trapAutoSlToTip);
    }

    // Trap Auto-Breakeven toggle (default: false / OFF)
    this._trapBeEnabled = line.trapBeEnabled !== undefined ? Boolean(line.trapBeEnabled) : false;
    const btnTrapBe = document.getElementById('tvBtnToggleTrapBe');
    const grpTrapBe = document.getElementById('tvTrapBeControls');
    const trapBeDispInput = document.getElementById('tvLineTrapBeDispPips') || document.getElementById('tvLineTrapBeDispPts');
    const trapBeOffsetInput = document.getElementById('tvLineTrapBeOffsetPips');

    if (btnTrapBe) {
      btnTrapBe.textContent = this._trapBeEnabled ? 'ON' : 'OFF';
      btnTrapBe.classList.toggle('active', this._trapBeEnabled);
    }
    if (grpTrapBe) {
      grpTrapBe.style.display = this._trapBeEnabled ? 'grid' : 'none';
    }
    if (trapBeDispInput) {
      const dispP = line.trapBeDispPips !== undefined ? line.trapBeDispPips : (line.trapBeDispPts !== undefined ? line.trapBeDispPts * 10 : 15.0);
      trapBeDispInput.value = dispP;
    }
    if (trapBeOffsetInput) trapBeOffsetInput.value = line.trapBeOffsetPips !== undefined ? line.trapBeOffsetPips : 0.3;

    // Immediate Trigger on Trap Form toggle (default: true / ON)
    this._trapImmediateTrigger = line.trapImmediateTrigger !== undefined ? Boolean(line.trapImmediateTrigger) : true;
    const btnTrapImm = document.getElementById('tvBtnToggleTrapImmediate');
    if (btnTrapImm) {
      btnTrapImm.textContent = this._trapImmediateTrigger ? 'ON' : 'OFF';
      btnTrapImm.classList.toggle('active', this._trapImmediateTrigger);
    }

    this._updateTrapColorUI();

    this._updateDollarPnlBox();
    this._updateColorIndicator();
    this._updateModalQuickArmBtn(line);
    this.applyLineColor(idStr);
    this.updateSlTpProjections();
    this.renderHud(true);

    this.modalEl.style.display = 'flex';
  }

  _updateTrapColorUI() {
    const isBuy = document.getElementById('tvLineDirBuy')?.classList.contains('active');
    const pill = document.getElementById('tvTrapColorPill');
    const btn = document.getElementById('tvBtnToggleTrapColor');
    const grpSub = document.getElementById('tvTrapSubSettingsGroup');

    if (pill) {
      if (isBuy) {
        pill.textContent = 'Cyan BUY';
        pill.className = 'tv-trap-badge cyan';
      } else {
        pill.textContent = 'Yellow SELL';
        pill.className = 'tv-trap-badge yellow';
      }
    }

    if (btn) {
      btn.textContent = this._trapColorEnabled ? 'ON' : 'OFF';
      btn.className = 'tv-btn-toggle';
      if (this._trapColorEnabled) {
        btn.classList.add(isBuy ? 'trap-active-cyan' : 'trap-active-yellow');
      }
    }

    if (grpSub) {
      grpSub.style.display = this._trapColorEnabled ? 'flex' : 'none';
    }

    this._updateColorIndicator();
  }

  _bindModalEvents() {
    if (!this.modalEl) return;

    // Close button
    document.getElementById('tvCloseLineModalBtn')?.addEventListener('click', () => {
      this.modalEl.style.display = 'none';
      this.loadFromStorage();
      this.updateSlTpProjections();
      this.renderHud(true);
    });

    // Quick Arm / Deactivate Toggle Button in Header
    document.getElementById('tvLineQuickArmBtn')?.addEventListener('click', () => {
      if (!this.selectedLineId) return;
      const isArmed = this.toggleLineArmed(this.selectedLineId);
      const line = this.lines.get(this.selectedLineId);
      const name = line?.name || 'Line Trigger';
      const dir = line?.direction || 'BUY';
      const lots = line?.volume || (typeof window.getGlobalLot === 'function' ? window.getGlobalLot() : 1.0);
      if (isArmed) {
        showChartToast(`⚡ ACTIVE: ${name} (${dir} ${Number(lots).toFixed(2)}L)`);
      } else {
        showChartToast(`⚪ DEACTIVATED: ${name}`);
      }
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
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) {
        line.actionType = 'EXECUTE';
        this.updateSlTpProjections();
      }
    });

    tabExit?.addEventListener('click', () => {
      this._currentActionType = 'EXIT';
      tabExit.classList.add('active');
      tabExec?.classList.remove('active');
      if (grpExec) grpExec.style.display = 'none';
      if (grpExit) grpExit.style.display = 'block';
      this._updateColorIndicator();
      this.clearSlTpProjections();
    });

    // Direction Toggle Buttons
    const btnBuy = document.getElementById('tvLineDirBuy');
    const btnSell = document.getElementById('tvLineDirSell');
    btnBuy?.addEventListener('click', () => {
      btnBuy.classList.add('active');
      btnSell?.classList.remove('active');
      this._updateTrapColorUI();
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) {
        line.direction = 'BUY';
        this.applyLineColor(line.overlayId);
        this.updateSlTpProjections();
      }
    });
    btnSell?.addEventListener('click', () => {
      btnSell.classList.add('active');
      btnBuy?.classList.remove('active');
      this._updateTrapColorUI();
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) {
        line.direction = 'SELL';
        this.applyLineColor(line.overlayId);
        this.updateSlTpProjections();
      }
    });

    // Candle Trap Color Trigger Toggle Button
    const btnTrap = document.getElementById('tvBtnToggleTrapColor');
    btnTrap?.addEventListener('click', () => {
      this._trapColorEnabled = !this._trapColorEnabled;
      this._updateTrapColorUI();
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) {
        line.trapColorEnabled = Boolean(this._trapColorEnabled);
        this.applyLineColor(line.overlayId);
      }
    });

    // Auto-SL to Trap Candle Tip toggle button (Default: ON)
    const btnTrapAutoSl = document.getElementById('tvBtnToggleTrapAutoSl');
    btnTrapAutoSl?.addEventListener('click', () => {
      this._trapAutoSlToTip = !this._trapAutoSlToTip;
      btnTrapAutoSl.textContent = this._trapAutoSlToTip ? 'ON' : 'OFF';
      btnTrapAutoSl.classList.toggle('active', this._trapAutoSlToTip);
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) line.trapAutoSlToTip = Boolean(this._trapAutoSlToTip);
    });

    // Trap Auto-Breakeven toggle button (Default: OFF)
    const btnTrapBe = document.getElementById('tvBtnToggleTrapBe');
    const grpTrapBe = document.getElementById('tvTrapBeControls');
    btnTrapBe?.addEventListener('click', () => {
      this._trapBeEnabled = !this._trapBeEnabled;
      btnTrapBe.textContent = this._trapBeEnabled ? 'ON' : 'OFF';
      btnTrapBe.classList.toggle('active', this._trapBeEnabled);
      if (grpTrapBe) grpTrapBe.style.display = this._trapBeEnabled ? 'grid' : 'none';
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) line.trapBeEnabled = Boolean(this._trapBeEnabled);
    });

    const onTrapDispInput = (e) => {
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) {
        line.trapBeDispPips = Math.max(0.1, Number(e.target.value || 15.0));
        line.trapBeDispPts = Math.round(line.trapBeDispPips * 0.10 * 100) / 100;
      }
    };
    document.getElementById('tvLineTrapBeDispPips')?.addEventListener('input', onTrapDispInput);
    document.getElementById('tvLineTrapBeDispPts')?.addEventListener('input', onTrapDispInput);
    document.getElementById('tvLineTrapBeOffsetPips')?.addEventListener('input', (e) => {
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) line.trapBeOffsetPips = Math.max(0.1, Number(e.target.value || 0.3));
    });

    // Immediate Trigger on Trap Form toggle button (Default: ON)
    const btnTrapImm = document.getElementById('tvBtnToggleTrapImmediate');
    btnTrapImm?.addEventListener('click', () => {
      this._trapImmediateTrigger = !this._trapImmediateTrigger;
      btnTrapImm.textContent = this._trapImmediateTrigger ? 'ON' : 'OFF';
      btnTrapImm.classList.toggle('active', this._trapImmediateTrigger);
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) line.trapImmediateTrigger = Boolean(this._trapImmediateTrigger);
    });

    // Recalculate dollar PnL and live projections on input changes
    ['tvLineSlPts', 'tvLineTpPts'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => {
        this._updateDollarPnlBox();
        const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
        if (line) {
          line.slPts = Math.max(0.1, Number(document.getElementById('tvLineSlPts')?.value || line.slPts));
          line.tpPts = Math.max(0.1, Number(document.getElementById('tvLineTpPts')?.value || line.tpPts));
          this.updateSlTpProjections();
        }
      });
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
    const vol = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : Math.max(0.01, Number(localStorage.getItem('escanor_global_lot') || 1.00));
    const slPts = Math.max(0.1, Number(document.getElementById('tvLineSlPts')?.value || 3.0));
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
    const armBtn = document.getElementById('tvLineArmBtn');

    if (ind) {
      if (isExec) {
        if (isBuy) {
          ind.textContent = '⚡ CYAN (BUY DIRECTION)';
          ind.className = 'line-color-badge-cyan';
        } else {
          ind.textContent = '⚡ YELLOW (SELL DIRECTION)';
          ind.className = 'line-color-badge-yellow';
        }
      } else {
        ind.textContent = '🟡 AMBER (EXIT ALL)';
        ind.className = 'line-color-badge-yellow';
      }
    }

    if (armBtn) {
      if (isExec) {
        if (isBuy) {
          armBtn.textContent = '⚡ Arm & Activate (CYAN BUY)';
          armBtn.style.background = '#00e5ff';
          armBtn.style.color = '#061118';
          armBtn.style.boxShadow = '0 0 14px rgba(0, 229, 255, 0.45)';
        } else {
          armBtn.textContent = '⚡ Arm & Activate (YELLOW SELL)';
          armBtn.style.background = '#f59e0b';
          armBtn.style.color = '#061118';
          armBtn.style.boxShadow = '0 0 14px rgba(245, 158, 11, 0.45)';
        }
      } else {
        armBtn.textContent = '🚨 Arm & Activate (EXIT ALL)';
        armBtn.style.background = '#fbbf24';
        armBtn.style.color = '#061118';
        armBtn.style.boxShadow = '0 0 14px rgba(251, 191, 36, 0.45)';
      }
    }
  }

  _saveCurrentModalValues(isArmed = false) {
    if (!this.selectedLineId) return;
    const line = this.lines.get(this.selectedLineId);
    if (!line) return;

    const nameInput = document.getElementById('tvLineNameInput');
    const isBuy = document.getElementById('tvLineDirBuy')?.classList.contains('active');
    const slInput = document.getElementById('tvLineSlPts');
    const tpInput = document.getElementById('tvLineTpPts');
    const timerMins = document.getElementById('tvLineTimerMins');
    const globalLot = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : Math.max(0.01, Number(localStorage.getItem('escanor_global_lot') || 1.00));

    line.name = nameInput?.value?.trim() || line.name;
    line.actionType = this._currentActionType || 'EXECUTE';
    line.direction = isBuy ? 'BUY' : 'SELL';
    line.volume = globalLot;
    line.slPts = Math.max(0.1, Number(slInput?.value || 3.0));
    line.tpPts = Math.max(0.1, Number(tpInput?.value || 12.0));
    line.timerEnabled = Boolean(this._timerEnabled);
    line.autoCloseMins = Number(timerMins?.value || 5.0);
    line.extendRay = Boolean(this._extendRay);
    line.trapColorEnabled = Boolean(this._trapColorEnabled);
    line.trapAutoSlToTip = this._trapAutoSlToTip !== undefined ? Boolean(this._trapAutoSlToTip) : true;
    line.trapImmediateTrigger = this._trapImmediateTrigger !== undefined ? Boolean(this._trapImmediateTrigger) : true;
    line.trapBeEnabled = Boolean(this._trapBeEnabled);
    const dispPipsVal = Math.max(0.1, Number(document.getElementById('tvLineTrapBeDispPips')?.value || document.getElementById('tvLineTrapBeDispPts')?.value || 15.0));
    line.trapBeDispPips = dispPipsVal;
    line.trapBeDispPts = Math.round(dispPipsVal * 0.10 * 100) / 100;
    line.trapBeOffsetPips = Math.max(0.1, Number(document.getElementById('tvLineTrapBeOffsetPips')?.value || 0.3));
    line.isArmed = isArmed;
    line.triggered = false; // Reset trigger state on re-arming
    if (isArmed) {
      line.activeTradeTicket = null;
      line._tradeActive = false;
      line._lastExecuteTrigger = 0;
      line._lastExitTrigger = 0;
      line._lastTickBid = null;
    }

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
    this.updateSlTpProjections();
    this.renderHud(true);
    this._updateModalQuickArmBtn(line);
    this._updateFloatingToolbarArmBtn(line);
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
          const isArmed = this.toggleLineArmed(id);
          const dir = line.direction || 'BUY';
          const lots = line.volume || (typeof window.getGlobalLot === 'function' ? window.getGlobalLot() : 1.0);
          showChartToast(isArmed ? `⚡ ACTIVE: ${line.name} (${dir} ${Number(lots).toFixed(2)}L)` : `⚪ DEACTIVATED: ${line.name}`);
        } else if (act === 'delete' && line) {
          this.removeLineOverlay(id);
          showChartToast(`Deleted ${line.name}`);
        }
        return;
      }

      // 4. Minimize / Expand Toggle Button or Header click
      const minBtn = e.target.closest('#tvHudMinBtn');
      const headerBox = e.target.closest('.tv-hud-header');
      if (minBtn || headerBox) {
        e.stopPropagation();
        e.preventDefault();
        this.toggleHudMinimize();
        return;
      }

      // 5. Select / Deselect Line Item on Click (White Border / Highlight)
      const lineItem = e.target.closest('.tv-hud-item');
      if (lineItem) {
        e.stopPropagation();
        e.preventDefault();
        const id = lineItem.getAttribute('data-line-id');
        if (id) {
          this.toggleSelectLine(id);
        }
        return;
      }
    });
  }

  _ensureLineDistances() {
    if (!this.chart) return;
    const curSpot = this.currentSpot || this.lastBidPrice;
    if (!curSpot) return;

    const chartOverlays = this.chart.getOverlays() || [];
    const overlayMap = new Map(chartOverlays.map(o => [String(o.id), o]));

    for (const line of this.lines.values()) {
      if (line._lastPriceDist === undefined || line._lastCalculatedPrice === undefined) {
        const ov = overlayMap.get(String(line.overlayId));
        if (!ov || !ov.points || ov.points.length === 0) continue;

        const linePrice = this._calculateLinePriceAtCurrentTime(ov);
        if (linePrice !== null && !isNaN(linePrice) && linePrice > 0) {
          line._lastCalculatedPrice = linePrice;
          const isBuyAction = (line.actionType === 'EXECUTE' && line.direction === 'BUY');
          const testPrice = isBuyAction ? (this.currentAsk || curSpot) : curSpot;
          line._lastPriceDist = Math.abs(testPrice - linePrice);
        }
      }
    }
  }

  _formatElapsedSec(sec) {
    const totalSec = Math.max(0, Math.floor(sec));
    const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const s = (totalSec % 60).toString().padStart(2, '0');
    if (totalSec >= 3600) {
      const h = Math.floor(totalSec / 3600).toString().padStart(2, '0');
      const remM = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
      return `${h}:${remM}:${s}`;
    }
    return `${m}:${s}`;
  }

  _getPosElapsedStr(pos) {
    if (!pos) return '00:00';
    const ticket = Number(pos.ticket);
    const start = this.posStartTimes.get(ticket) || (pos.open_epoch_utc ? pos.open_epoch_utc * 1000 : (pos.elapsed_sec ? Date.now() - (pos.elapsed_sec * 1000) : Date.now()));
    const elapsedSec = Math.max(0, (Date.now() - start) / 1000);
    return this._formatElapsedSec(elapsedSec);
  }

  _getLineElapsedStr(line) {
    if (!line) return '00:00';
    if (line.activeTradeTicket && this.posStartTimes.has(Number(line.activeTradeTicket))) {
      const start = this.posStartTimes.get(Number(line.activeTradeTicket));
      return this._formatElapsedSec(Math.max(0, (Date.now() - start) / 1000));
    }
    if (line._tradeActiveStartTime) {
      return this._formatElapsedSec(Math.max(0, (Date.now() - line._tradeActiveStartTime) / 1000));
    }
    return '00:00';
  }

  _updateSidebarPill(activePositions = [], allLines = [], armedCount = 0) {
    const pill = document.getElementById('tvSidebarHudPill');
    const iconEl = document.getElementById('tvSidebarHudIcon');
    const summaryEl = document.getElementById('tvSidebarHudSummary');
    if (!pill || !iconEl || !summaryEl) return;

    pill.classList.toggle('open', !this.hudMinimized);
    pill.classList.remove('has-trades', 'loss', 'has-armed');

    if (activePositions.length > 0) {
      let totalPnl = 0;
      for (const pos of activePositions) {
        const isBuy = pos.type === 'BUY' || pos.type === 0 || String(pos.type).toUpperCase().includes('BUY');
        const openPrice = Number(pos.price_open !== undefined ? pos.price_open : pos.price);
        const volume = Number(pos.volume || 0.50);
        let profitDollar = Number(pos.profit !== undefined ? pos.profit : 0);
        if (this.currentSpot && openPrice > 0) {
          const curP = isBuy ? this.currentSpot : (this.currentAsk || this.currentSpot);
          const profitPts = isBuy ? (curP - openPrice) : (openPrice - curP);
          profitDollar = profitPts * volume * 100;
        }
        totalPnl += profitDollar;
      }

      pill.classList.add('has-trades');
      if (totalPnl < 0) pill.classList.add('loss');
      iconEl.textContent = '🟢';
      const sign = totalPnl >= 0 ? '+' : '-';
      summaryEl.textContent = `${activePositions.length}T ${sign}$${Math.abs(totalPnl).toFixed(0)}`;
      pill.title = `Active Trades: ${activePositions.length} (${sign}$${Math.abs(totalPnl).toFixed(2)}) • Click to ${this.hudMinimized ? 'Open' : 'Close'} HUD`;
    } else if (armedCount > 0) {
      pill.classList.add('has-armed');
      iconEl.textContent = '⚡';
      summaryEl.textContent = `${armedCount}L`;
      pill.title = `Armed Lines: ${armedCount} • Click to ${this.hudMinimized ? 'Open' : 'Close'} HUD`;
    } else if (allLines.length > 0) {
      iconEl.textContent = '📐';
      summaryEl.textContent = `${allLines.length}L`;
      pill.title = `Drawn Lines: ${allLines.length} • Click to ${this.hudMinimized ? 'Open' : 'Close'} HUD`;
    } else {
      iconEl.textContent = '⚡';
      summaryEl.textContent = 'HUD';
      pill.title = `Desk HUD • Click to ${this.hudMinimized ? 'Open' : 'Close'}`;
    }
  }

  renderHud(forceFull = false) {
    if (!this.hudEl) return;

    this._ensureLineDistances();

    const allLines = Array.from(this.lines.values());
    const activePositions = this.activePositions || [];
    const armedCount = allLines.filter(l => l.isArmed).length;

    // Always update the compact sidebar pill
    this._updateSidebarPill(activePositions, allLines, armedCount);

    if (allLines.length === 0 && activePositions.length === 0) {
      this.hudEl.style.display = 'none';
      this._lastHudStructureKey = null;
      return;
    }

    if (this.hudMinimized) {
      this.hudEl.style.display = 'none';
      return;
    }

    this.hudEl.style.display = 'flex';

    // Header title and count badge
    let headerTitle = armedCount > 0 ? 'ARMED LINES' : 'DESK HUD';
    let headerCount = armedCount > 0 ? `${armedCount} ARMED` : `${allLines.length} LINES`;

    if (activePositions.length > 0 && allLines.length > 0) {
      headerTitle = 'DESK HUD';
      headerCount = `${activePositions.length} POS • ${armedCount}/${allLines.length} ARMED`;
    } else if (activePositions.length > 0) {
      headerTitle = 'ACTIVE TRADES';
      headerCount = String(activePositions.length);
    }

    // Build unique structural signature (including selection state, volume, SL, TP, and trade active state)
    const structureKey = `${this.selectedLineId || 'none'}|${activePositions.map(p => p.ticket).join(',')}|${allLines.map(l => `${l.overlayId}:${l.isArmed}:${l._tradeActive}:${l.actionType}:${l.direction}:${l.trapColorEnabled}:${l.volume}:${l.slPts}:${l.tpPts}:${l.name}`).join(',')}`;

    // If structure is identical and body exists, perform non-destructive in-place DOM update!
    const bodyList = document.getElementById('tvHudBodyList');
    if (!forceFull && this._lastHudStructureKey === structureKey && bodyList) {
      if (this.hudMinimized) {
        this.hudEl.style.display = 'none';
        return;
      }
      this.hudEl.style.display = 'flex';

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

        const elapsedText = `⏱ ${this._getPosElapsedStr(pos)}`;
        const posTimerEl = itemEl.querySelector('.tv-hud-pos-timer');
        if (posTimerEl) {
          if (posTimerEl.textContent !== elapsedText) posTimerEl.textContent = elapsedText;
        } else {
          const rowBottom = itemEl.querySelector('.tv-hud-pos-row-bottom');
          if (rowBottom) {
            rowBottom.insertAdjacentHTML('beforeend', `<span class="tv-hud-pos-timer" title="Active Trade Duration">${elapsedText}</span>`);
          }
        }

        const beBtn = itemEl.querySelector('.tv-hud-be-btn');
        if (beBtn) {
          const isArmed = Array.isArray(window.__armedBreakevenTickets) && window.__armedBreakevenTickets.map(Number).includes(ticket);
          if (isArmed) {
            if (!beBtn.classList.contains('armed')) {
              beBtn.classList.add('armed');
              beBtn.innerHTML = '<span>🛡️ BE (ARMED)</span>';
              beBtn.style.background = 'rgba(0, 229, 255, 0.25)';
              beBtn.style.border = '1px solid #00e5ff';
              beBtn.style.color = '#00e5ff';
              beBtn.style.fontWeight = 'bold';
              beBtn.title = 'Breakeven is ARMED (+0.2 pip) — Click to disarm (Alt + B)';
            }
          } else {
            if (beBtn.classList.contains('armed')) {
              beBtn.classList.remove('armed');
              beBtn.innerHTML = '<span>🛡️ BE</span>';
              beBtn.style.background = '';
              beBtn.style.border = '';
              beBtn.style.color = '';
              beBtn.style.fontWeight = '';
              beBtn.title = 'Move SL to Breakeven + 0.2 pip (Alt + B)';
            }
          }
        }
      }

      // 3. Update line badges, distances & countdowns in-place
      for (const line of allLines) {
        const itemEl = this.hudEl.querySelector(`.tv-hud-item[data-line-id="${line.overlayId}"]`);
        if (!itemEl) continue;

        const isSelected = (this.selectedLineId === String(line.overlayId));
        if (isSelected) {
          if (!itemEl.classList.contains('selected')) itemEl.classList.add('selected');
        } else {
          if (itemEl.classList.contains('selected')) itemEl.classList.remove('selected');
        }

        const isArmed = Boolean(line.isArmed);
        const isExit = line.actionType === 'EXIT';
        const color = this.getLineColor(line);

        if (isArmed) {
          itemEl.classList.remove('paused-item');
        } else {
          itemEl.classList.add('paused-item');
        }

        const dotEl = itemEl.querySelector('.tv-hud-item-dot');
        if (dotEl) {
          dotEl.style.backgroundColor = isSelected ? '#ffffff' : color;
        }

        const nameEl = itemEl.querySelector('.tv-hud-item-name');
        if (nameEl && nameEl.textContent !== line.name) {
          nameEl.textContent = line.name;
          nameEl.title = line.name;
        }

        let actionBadge = '';
        let actionClass = '';
        const trapNote = line.trapColorEnabled ? (line.direction === 'BUY' ? ' [CYAN]' : ' [YELLOW]') : '';
        if (isArmed) {
          actionBadge = isExit ? 'CLOSE ALL' : `${line.direction} ${line.volume}L${trapNote}`;
          actionClass = isExit ? 'exit' : (line.trapColorEnabled ? (line.direction === 'BUY' ? 'trap-cyan' : 'trap-yellow') : (line.direction === 'BUY' ? 'buy' : 'sell'));
        } else {
          actionBadge = isExit ? 'CLOSE ALL (PAUSED)' : `${line.direction} ${line.volume}L${trapNote} (PAUSED)`;
          actionClass = 'paused';
        }

        const badgeEl = itemEl.querySelector('.tv-hud-badge');
        if (badgeEl) {
          if (badgeEl.textContent !== actionBadge) badgeEl.textContent = actionBadge;
          badgeEl.className = `tv-hud-badge ${actionClass}`;
        }

        const toggleBtn = itemEl.querySelector('.tv-hud-act-btn[data-act="toggle"]');
        if (toggleBtn) {
          const expectedIcon = isArmed ? '⚡' : '⚪';
          if (toggleBtn.textContent.trim() !== expectedIcon) toggleBtn.textContent = expectedIcon;
          toggleBtn.title = isArmed ? '⚡ ACTIVE (Click to Deactivate)' : '⚪ DEACTIVATED (Click to Activate)';
          toggleBtn.classList.toggle('armed', isArmed);
          toggleBtn.classList.remove('buy', 'sell');
          if (isArmed) {
            if (line.direction === 'BUY') toggleBtn.classList.add('buy');
            else if (line.direction === 'SELL') toggleBtn.classList.add('sell');
          }
        }

        let distStr = '-- pt';
        if (line._lastPriceDist !== undefined) {
          const priceStr = line._lastCalculatedPrice ? `$${line._lastCalculatedPrice.toFixed(2)} • ` : '';
          distStr = `${priceStr}${line._lastPriceDist.toFixed(1)} pt away`;
        } else if (line._lastCalculatedPrice) {
          distStr = `@ $${line._lastCalculatedPrice.toFixed(2)}`;
        }

        const distEl = itemEl.querySelector('.tv-hud-item-dist');
        if (distEl && distEl.textContent !== distStr) distEl.textContent = distStr;

        // Trade active counter on line item
        const lineHasActiveTrade = Boolean(line._tradeActive || (line.activeTradeTicket && activePositions.some(p => Number(p.ticket) === Number(line.activeTradeTicket))));
        const lineCounterEl = itemEl.querySelector('.tv-hud-line-trade-counter');
        if (lineHasActiveTrade) {
          const lineElapsedText = `⚡ ACTIVE ⏱ ${this._getLineElapsedStr(line)}`;
          if (lineCounterEl) {
            if (lineCounterEl.textContent !== lineElapsedText) lineCounterEl.textContent = lineElapsedText;
          } else {
            const distNode = itemEl.querySelector('.tv-hud-item-dist');
            if (distNode) {
              distNode.insertAdjacentHTML('afterend', `<span class="tv-hud-line-trade-counter" title="Trade Active Duration">${lineElapsedText}</span>`);
            }
          }
        } else if (lineCounterEl) {
          lineCounterEl.remove();
        }

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
          <span class="tv-hud-dot" style="color: ${activePositions.length > 0 ? '#00e5ff' : (armedCount > 0 ? '#00e5ff' : '#787b86')};">●</span>
          <span class="tv-hud-title">${headerTitle}</span>
          <span class="tv-hud-count">${headerCount}</span>
        </div>
        <button id="tvHudCloseBtn" class="tv-hud-close-x" onclick="window.toggleHudMinimize && window.toggleHudMinimize(true); event.stopPropagation();" title="Close Desk HUD">✕</button>
      </div>
      <div class="tv-hud-body" id="tvHudBodyList">
    `;

    // 1. Render Active Trades Section
    if (activePositions.length > 0) {
      html += `
        <div class="tv-hud-section-label-row">
          <span class="tv-hud-section-label">⚡ ACTIVE TRADES (${activePositions.length})</span>
          ${activePositions.length > 1 ? `<button class="tv-hud-kill-all-btn" id="tvHudKillAllBtn" onclick="window.killAllTrades && window.killAllTrades(); event.stopPropagation();" title="Flatten All Positions" style="touch-action: manipulation; cursor: pointer;">KILL ALL</button>` : ''}
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
              <div class="tv-hud-pos-actions" style="display: flex; align-items: center; gap: 4px;">
                ${(Array.isArray(window.__armedBreakevenTickets) && window.__armedBreakevenTickets.map(Number).includes(ticket)) ? `
                <button class="tv-hud-be-btn armed" data-ticket="${ticket}" onclick="window.executeTriggerBreakeven && window.executeTriggerBreakeven('${ticket}'); event.stopPropagation();" title="Breakeven is ARMED (+0.2 pip) — Click to disarm (Alt + B)" style="touch-action: manipulation; cursor: pointer; background: rgba(0, 229, 255, 0.25); border: 1px solid #00e5ff; color: #00e5ff; font-weight: bold;">
                  <span>🛡️ BE (ARMED)</span>
                </button>
                ` : `
                <button class="tv-hud-be-btn" data-ticket="${ticket}" onclick="window.executeTriggerBreakeven && window.executeTriggerBreakeven('${ticket}'); event.stopPropagation();" title="Move SL to Breakeven + 0.2 pip (Alt + B)" style="touch-action: manipulation; cursor: pointer;">
                  <span>🛡️ BE</span>
                </button>
                `}
                <button class="tv-hud-kill-btn" data-ticket="${ticket}" onclick="window.killTrade && window.killTrade('${ticket}'); event.stopPropagation();" title="Kill / Close #${ticket} immediately" style="touch-action: manipulation; cursor: pointer;">
                  <span class="tv-kill-icon">✕</span>
                  <span>KILL</span>
                </button>
              </div>
            </div>
            <div class="tv-hud-pos-row-bottom">
              <div class="tv-hud-pos-pnl ${pnlClass}">
                <span class="tv-pnl-dollar">${dollarStr}</span>
                <span class="tv-pnl-pips">${pipsStr}</span>
              </div>
              <span class="tv-hud-pos-timer" title="Active Trade Duration">⏱ ${this._getPosElapsedStr(pos)}</span>
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
        const trapNote = line.trapColorEnabled ? (line.direction === 'BUY' ? ' [CYAN]' : ' [YELLOW]') : '';
        if (isArmed) {
          actionBadge = isExit ? 'CLOSE ALL' : `${line.direction} ${line.volume}L${trapNote}`;
          actionClass = isExit ? 'exit' : (line.trapColorEnabled ? (line.direction === 'BUY' ? 'trap-cyan' : 'trap-yellow') : (line.direction === 'BUY' ? 'buy' : 'sell'));
        } else {
          actionBadge = isExit ? 'CLOSE ALL (PAUSED)' : `${line.direction} ${line.volume}L${trapNote} (PAUSED)`;
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

        const isSelected = (this.selectedLineId === String(line.overlayId));
        const lineHasActiveTrade = Boolean(line._tradeActive || (line.activeTradeTicket && activePositions.some(p => Number(p.ticket) === Number(line.activeTradeTicket))));
        const activeCounterHtml = lineHasActiveTrade ? `<span class="tv-hud-line-trade-counter" title="Trade Active Duration">⚡ ACTIVE ⏱ ${this._getLineElapsedStr(line)}</span>` : '';

        html += `
          <div class="tv-hud-item ${isArmed ? '' : 'paused-item'} ${isSelected ? 'selected' : ''}" data-line-id="${line.overlayId}">
            <div class="tv-hud-item-top">
              <span class="tv-hud-item-dot" style="background-color: ${isSelected ? '#ffffff' : color};"></span>
              <span class="tv-hud-item-name" title="${line.name}">${line.name}</span>
              <span class="tv-hud-badge ${actionClass}">${actionBadge}</span>
            </div>
            <div class="tv-hud-item-bottom">
              <span class="tv-hud-item-dist">${distStr}</span>
              ${activeCounterHtml}
              ${timerHtml}
              <div class="tv-hud-item-actions">
                <button class="tv-hud-act-btn" data-act="settings" data-id="${line.overlayId}" title="Settings" style="touch-action: manipulation; cursor: pointer;">⚙</button>
                <button class="tv-hud-act-btn ${isArmed ? 'armed' : ''} ${isArmed ? (line.direction === 'BUY' ? 'buy' : 'sell') : ''}" data-act="toggle" data-id="${line.overlayId}" title="${isArmed ? '⚡ ACTIVE (Click to Deactivate)' : '⚪ DEACTIVATED (Click to Activate)'}" style="touch-action: manipulation; cursor: pointer;">
                  ${isArmed ? '⚡' : '⚪'}
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
