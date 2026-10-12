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
    this.hudMinimized = localStorage.getItem('escanor_hud_minimized') === 'true';
    this.activePositions = [];

    this._init();
  }

  updatePositions(positions) {
    this.activePositions = Array.isArray(positions) ? positions : [];
    const activeTicketSet = new Set(this.activePositions.map(p => Number(p.ticket)));

    // Monitor trades triggered by our lines:
    for (const line of this.lines.values()) {
      // Auto-link activeTradeTicket if MT5 position comment matches line.name (e.g. across reloads)
      if (!line.activeTradeTicket) {
        for (const pos of this.activePositions) {
          if (pos.comment && (pos.comment.includes(line.name) || pos.comment.includes(`Line Touch ${line.name}`))) {
            line.activeTradeTicket = Number(pos.ticket);
            line._tradeActive = true;
            break;
          }
        }
      }

      if (line.activeTradeTicket) {
        const ticket = Number(line.activeTradeTicket);
        // If the trade was active and is now no longer in open activePositions:
        if (!activeTicketSet.has(ticket)) {
          line._tradeActive = false;
          line.activeTradeTicket = null;
          this.applyLineColor(line.overlayId);
          this.saveToStorage();
          // Check MT5 closed deal history to see if it was a loss or win
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
        this.activePositions = this.activePositions.filter(p => Number(p.ticket) !== numTicket);
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

    if (this.hudEl) {
      this.hudEl.classList.toggle('minimized', Boolean(this.hudMinimized));
    }
    const bodyList = document.getElementById('tvHudBodyList');
    if (bodyList) {
      bodyList.style.display = this.hudMinimized ? 'none' : 'flex';
    }
    const btn = this.hudEl?.querySelector('#tvHudMinBtn');
    if (btn) {
      btn.textContent = this.hudMinimized ? '▲' : '▼';
      btn.title = this.hudMinimized ? 'Expand' : 'Minimize';
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
    window.toggleHudMinimize = () => this.toggleHudMinimize();
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

    // Check if a trade triggered by this line is currently running in MT5
    const isTradeActive = Boolean(
      line._tradeActive ||
      (line.activeTradeTicket && (this.activePositions || []).some(p => Number(p.ticket) === Number(line.activeTradeTicket)))
    );

    if (isTradeActive) {
      // HIDE TRIGGER LINE OVERLAY WHILE TRADE IS ACTIVE:
      // ActiveOrdersEngine renders the live active MT5 position entry line at the fill price
      // with its live PnL badge and draggable SL/TP.
      // Hiding the trigger line prevents duplicate parallel lines on the chart.
      try {
        const overlays = this.chart.getOverlays() || [];
        const ov = overlays.find(o => String(o.id) === String(overlayId));
        if (ov) {
          if (!ov._origCpf && ov.createPointFigures) {
            ov._origCpf = ov.createPointFigures;
          }
          ov.createPointFigures = () => [];
        }
        this.chart.overrideOverlay({
          id: line.overlayId,
          styles: {
            line: {
              color: 'transparent',
              size: 0,
              style: 'none'
            },
            point: {
              color: 'transparent',
              borderColor: 'transparent',
              activeColor: 'transparent',
              activeBorderColor: 'transparent',
              radius: 0
            }
          }
        });
      } catch (e) {
        console.warn('[LineTrading] Error hiding active trade line:', e);
      }
      return;
    }

    const isSelected = (this.selectedLineId === String(overlayId));
    const baseColor = this.getLineColor(line);
    const coreSize = line.isArmed ? 2.0 : 1.5;
    const borderSize = coreSize + 1.0; // 0.5px white border on either side (thinner than line)

    try {
      const overlays = this.chart.getOverlays() || [];
      const ov = overlays.find(o => String(o.id) === String(overlayId));

      if (ov) {
        // Restore origCpf if it was overridden or hidden
        if (ov._origCpf && !isSelected) {
          ov.createPointFigures = ov._origCpf;
          delete ov._origCpf;
        }

        if (isSelected) {
          if (!ov._origCpf) {
            ov._origCpf = ov.createPointFigures;
          }
          const origCpf = ov._origCpf || ((args) => {
            const coords = args.coordinates || [];
            if (coords.length >= 2) {
              return [{ type: 'line', attrs: { coordinates: coords } }];
            }
            const y = coords[0]?.y ?? 0;
            return [{ type: 'line', attrs: { coordinates: [{ x: 0, y }, { x: args.bounding.width, y }] } }];
          });

          ov.createPointFigures = (args) => {
            const baseFigs = origCpf ? origCpf(args) : [];
            const res = [];
            for (const f of baseFigs) {
              if (f.type === 'line') {
                // 1. Outer thin white border (thinner than the line itself)
                res.push({
                  type: 'line',
                  attrs: { ...f.attrs },
                  styles: {
                    ...(f.styles || {}),
                    color: 'rgba(255, 255, 255, 0.95)',
                    size: borderSize,
                    style: 'solid'
                  }
                });
                // 2. Core original grey line
                res.push({
                  type: 'line',
                  attrs: { ...f.attrs },
                  styles: {
                    ...(f.styles || {}),
                    color: baseColor,
                    size: coreSize,
                    style: 'solid'
                  }
                });
              } else {
                res.push(f);
              }
            }
            return res;
          };
        }
      }

      this.chart.overrideOverlay({
        id: line.overlayId,
        styles: {
          line: {
            color: baseColor,
            size: coreSize,
            style: 'solid'
          },
          point: {
            color: isSelected ? '#ffffff' : baseColor,
            borderColor: isSelected ? baseColor : baseColor,
            activeColor: '#ffffff',
            activeBorderColor: '#ffffff',
            radius: isSelected ? 5.5 : (line.isArmed ? 5 : 4)
          }
        }
      });
      syncDrawingsToServer(this.symbol, this.chart, false);
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
    const slPts = Math.max(0.1, Number(line.slPts || 6.0));
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

      // USER RULE: "only one trade should be active at a time even it touches any line"
      // If ANY position is currently open in MT5, DO NOT trigger any entry line!
      // (EXIT / Close lines can still trigger to close positions)
      const hasActivePositions = (this.activePositions && this.activePositions.length > 0) ||
                                 (window.__lastActivePositions && window.__lastActivePositions.length > 0) ||
                                 Boolean(this.isExecuting);
      if (line.actionType === 'EXECUTE' && hasActivePositions) {
        continue;
      }

      // COLLISION CHECK:
      // The chart price space is BID (all candles & wicks are rendered at Bid).
      // A trigger occurs when:
      // 1. Bid crossed the line between the previous tick and current tick
      // 2. Bid touched within 0.08 pt (float tolerance < 1 pip, exact touch)
      // 3. Or current candle's high/low physically encompasses linePrice and live bid is close (within 0.20 pt)
      const crossed = (prevBid <= linePrice && bid >= linePrice) ||
                      (prevBid >= linePrice && bid <= linePrice);
      const touched = Math.abs(bid - linePrice) <= 0.08;
      const candleTouched = Boolean(latestBar && latestBar.low <= linePrice && latestBar.high >= linePrice && Math.abs(bid - linePrice) <= 0.20);

      if (crossed || touched || candleTouched) {
        this._executeLineTrigger(line, linePrice);
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

    // 2. Trade Entry Line (EXECUTE): USER RULE: "only one trade should be active at a time even it touches any line"
    const hasActivePositions = (this.activePositions && this.activePositions.length > 0) ||
                               (window.__lastActivePositions && window.__lastActivePositions.length > 0);
    if (hasActivePositions) {
      console.log(`[LineTrading] 🛑 Blocked entry on ${line.name}: only 1 trade active at a time!`);
      return;
    }

    // Cooldown check (6 seconds)
    if (line._lastExecuteTrigger && (now - line._lastExecuteTrigger < 6000)) return;
    line._lastExecuteTrigger = now;

    this.isExecuting = true;
    console.log(`[LineTrading] ⚡ ENTRY TRIGGER HIT on ${line.name} @ $${triggerPrice.toFixed(2)} (${line.direction})`);

    try {
      const side = line.direction || 'BUY';
      const vol = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : (line.volume || 1.00);
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
        line._tradeActive = true;
        // Optimistically record position so applyLineColor immediately hides the trigger line
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
            comment: `Line Touch ${line.name}`
          });
        }
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
    this.applyLineColor(idStr);
    this.updateSlTpProjections();
    this.renderHud(true);

    this.modalEl.style.display = 'flex';
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
      this._updateColorIndicator();
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) {
        line.direction = 'BUY';
        this.updateSlTpProjections();
      }
    });
    btnSell?.addEventListener('click', () => {
      btnSell.classList.add('active');
      btnBuy?.classList.remove('active');
      this._updateColorIndicator();
      const line = this.selectedLineId ? this.lines.get(this.selectedLineId) : null;
      if (line) {
        line.direction = 'SELL';
        this.updateSlTpProjections();
      }
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
    const slInput = document.getElementById('tvLineSlPts');
    const tpInput = document.getElementById('tvLineTpPts');
    const timerMins = document.getElementById('tvLineTimerMins');
    const globalLot = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : Math.max(0.01, Number(localStorage.getItem('escanor_global_lot') || 1.00));

    line.name = nameInput?.value?.trim() || line.name;
    line.actionType = this._currentActionType || 'EXECUTE';
    line.direction = isBuy ? 'BUY' : 'SELL';
    line.volume = globalLot;
    line.slPts = Math.max(0.1, Number(slInput?.value || 6.0));
    line.tpPts = Math.max(0.1, Number(tpInput?.value || 12.0));
    line.timerEnabled = Boolean(this._timerEnabled);
    line.autoCloseMins = Number(timerMins?.value || 5.0);
    line.extendRay = Boolean(this._extendRay);
    line.isArmed = isArmed;
    line.triggered = false; // Reset trigger state on re-arming
    if (isArmed) {
      line.activeTradeTicket = null;
      line._tradeActive = false;
      line._lastExecuteTrigger = 0;
      line._lastExitTrigger = 0;
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
          if (line.isArmed) {
            line.activeTradeTicket = null;
            line._tradeActive = false;
            line._lastExecuteTrigger = 0;
            line._lastExitTrigger = 0;
          }
          this.applyLineColor(id);
          this.saveToStorage();
          this.updateSlTpProjections();
          showChartToast(line.isArmed ? `🟢 Armed ${line.name}` : `⚪ Paused ${line.name}`);
          this.renderHud(true);
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

  renderHud(forceFull = false) {
    if (!this.hudEl) return;

    this._ensureLineDistances();

    const allLines = Array.from(this.lines.values());
    const activePositions = this.activePositions || [];

    if (allLines.length === 0 && activePositions.length === 0) {
      this.hudEl.style.display = 'none';
      this._lastHudStructureKey = null;
      return;
    }

    this.hudEl.style.display = 'flex';
    this.hudEl.classList.toggle('minimized', Boolean(this.hudMinimized));

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

    // Build unique structural signature (including selection state, volume, SL, and TP)
    const structureKey = `${this.selectedLineId || 'none'}|${activePositions.map(p => p.ticket).join(',')}|${allLines.map(l => `${l.overlayId}:${l.isArmed}:${l.actionType}:${l.direction}:${l.volume}:${l.slPts}:${l.tpPts}:${l.name}`).join(',')}`;

    // If structure is identical and body exists, perform non-destructive in-place DOM update!
    const bodyList = document.getElementById('tvHudBodyList');
    if (!forceFull && this._lastHudStructureKey === structureKey && bodyList) {
      bodyList.style.display = this.hudMinimized ? 'none' : 'flex';
      const minBtn = this.hudEl.querySelector('#tvHudMinBtn');
      if (minBtn) {
        minBtn.textContent = this.hudMinimized ? '▲' : '▼';
        minBtn.title = this.hudMinimized ? 'Expand' : 'Minimize';
      }

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
        if (isArmed) {
          actionBadge = isExit ? 'CLOSE ALL' : `${line.direction} ${line.volume}L`;
          actionClass = isExit ? 'exit' : (line.direction === 'BUY' ? 'buy' : 'sell');
        } else {
          actionBadge = isExit ? 'CLOSE ALL (PAUSED)' : `${line.direction} ${line.volume}L (PAUSED)`;
          actionClass = 'paused';
        }

        const badgeEl = itemEl.querySelector('.tv-hud-badge');
        if (badgeEl) {
          if (badgeEl.textContent !== actionBadge) badgeEl.textContent = actionBadge;
          badgeEl.className = `tv-hud-badge ${actionClass}`;
        }

        const toggleBtn = itemEl.querySelector('.tv-hud-act-btn[data-act="toggle"]');
        if (toggleBtn) {
          const expectedIcon = isArmed ? '⏸' : '▶';
          if (toggleBtn.textContent.trim() !== expectedIcon) toggleBtn.textContent = expectedIcon;
          toggleBtn.title = isArmed ? 'Pause / Disarm' : 'Activate / Arm';
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
      <div class="tv-hud-header" onclick="window.toggleHudMinimize && window.toggleHudMinimize();" title="Click to minimize or expand">
        <div class="tv-hud-title-box">
          <span class="tv-hud-dot" style="color: ${activePositions.length > 0 ? '#00f5a0' : (armedCount > 0 ? '#00f5a0' : '#787b86')};">●</span>
          <span class="tv-hud-title">${headerTitle}</span>
          <span class="tv-hud-count">${headerCount}</span>
        </div>
        <button id="tvHudMinBtn" class="tv-hud-min-btn" onclick="window.toggleHudMinimize && window.toggleHudMinimize(); event.stopPropagation();" title="${this.hudMinimized ? 'Expand' : 'Minimize'}" style="touch-action: manipulation; cursor: pointer;">${this.hudMinimized ? '▲' : '▼'}</button>
      </div>
      <div class="tv-hud-body" id="tvHudBodyList" style="display: ${this.hudMinimized ? 'none' : 'flex'};">
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
              <button class="tv-hud-kill-btn" data-ticket="${ticket}" onclick="window.killTrade && window.killTrade('${ticket}'); event.stopPropagation();" title="Kill / Close #${ticket} immediately" style="touch-action: manipulation; cursor: pointer;">
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

        const isSelected = (this.selectedLineId === String(line.overlayId));

        html += `
          <div class="tv-hud-item ${isArmed ? '' : 'paused-item'} ${isSelected ? 'selected' : ''}" data-line-id="${line.overlayId}">
            <div class="tv-hud-item-top">
              <span class="tv-hud-item-dot" style="background-color: ${isSelected ? '#ffffff' : color};"></span>
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
