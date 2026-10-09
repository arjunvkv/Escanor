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

import { showChartToast } from './drawings_storage.js';

export const STORAGE_KEY_LINE_TRADING = 'escanor_line_trading_v1';

export class LineTradingManager {
  constructor({ chartEngine, symbol = 'XAUUSD', hudContainerId = 'tvLineTradingHud', modalId = 'tvLineTradingModal' }) {
    this.engine = chartEngine;
    this.symbol = symbol;
    this.hudEl = document.getElementById(hudContainerId);
    this.modalEl = document.getElementById(modalId);

    this.lines = new Map(); // overlayId -> lineConfig
    this.selectedLineId = null;
    this.currentSpot = null;
    this.lastSpotPrice = null;

    this.isDraggingLine = false;
    this.isDrawingLine = false;

    this.countdownTimer = null;
    this.isExecuting = false;

    this._init();
  }

  _init() {
    this.loadFromStorage();
    this._bindModalEvents();
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
    if (this.lines.has(idStr)) {
      this.lines.delete(idStr);
      this.saveToStorage();
    }
    if (this.selectedLineId === idStr) {
      this.selectedLineId = null;
      if (this.modalEl) this.modalEl.style.display = 'none';
    }
  }

  getLineConfig(overlayId) {
    return this.lines.get(String(overlayId)) || null;
  }

  getLineColor(line) {
    if (!line) return '#64748b';
    if (line.triggered) return '#94a3b8'; // Muted for triggered
    if (!line.isArmed) return '#64748b';  // Disarmed gray by default

    if (line.actionType === 'EXECUTE') {
      return line.direction === 'BUY' ? '#00f5a0' : '#ef4444';
    }
    if (line.actionType === 'EXIT') {
      return '#fbbf24'; // Yellow for Close All
    }
    return '#64748b';
  }

  applyLineColor(overlayId) {
    if (!this.engine || !this.engine.chart) return;
    const line = this.lines.get(String(overlayId));
    if (!line) return;

    const col = this.getLineColor(line);
    try {
      this.engine.overrideOverlay({
        id: line.overlayId,
        styles: {
          line: {
            color: col,
            size: line.isArmed ? 2.5 : 1.5,
            style: 'solid'
          }
        }
      });
    } catch (_) {}
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

    const prevPrice = this.lastSpotPrice !== null ? this.lastSpotPrice : bid;
    this.lastSpotPrice = bid;

    // Do NOT trigger while user is actively drawing or dragging a line!
    if (this.isDraggingLine || this.isDrawingLine) {
      this.renderHud();
      return;
    }

    if (!this.engine || !this.engine.chart) return;

    const chartOverlays = this.engine.getOverlays() || [];
    const overlayMap = new Map(chartOverlays.map(o => [String(o.id), o]));

    for (const line of this.lines.values()) {
      if (!line.isArmed || line.triggered) continue;

      const ov = overlayMap.get(String(line.overlayId));
      if (!ov || !ov.points || ov.points.length === 0) continue;

      const linePrice = this._calculateLinePriceAtCurrentTime(ov);
      if (linePrice === null) continue;

      line._lastPriceDist = Math.abs(bid - linePrice);

      // Check collision or crossing
      const crossed = (prevPrice <= linePrice && bid >= linePrice) || (prevPrice >= linePrice && bid <= linePrice);
      const touched = Math.abs(bid - linePrice) <= 0.25; // 0.25 pt tolerance

      if (crossed || touched) {
        this._executeLineTrigger(line, linePrice);
      }
    }

    this.renderHud();
  }

  _calculateLinePriceAtCurrentTime(overlay) {
    const pts = overlay.points;
    if (!pts || pts.length === 0) return null;

    if (pts.length === 1 || overlay.name === 'horizontalStraightLine') {
      return Number(pts[0].value);
    }

    if (pts.length >= 2) {
      const p1 = pts[0];
      const p2 = pts[1];
      const t1 = p1.timestamp || 0;
      const t2 = p2.timestamp || 0;
      const v1 = Number(p1.value) || 0;
      const v2 = Number(p2.value) || 0;

      if (t1 === t2) return (v1 + v2) / 2;

      const nowMs = Date.now();
      const slope = (v2 - v1) / (t2 - t1);
      const curVal = v1 + slope * (nowMs - t1);
      return curVal;
    }

    return null;
  }

  async _executeLineTrigger(line, triggerPrice) {
    if (this.isExecuting || line.triggered) return;
    this.isExecuting = true;

    line.triggered = true;
    line.triggeredAt = Date.now();
    this.applyLineColor(line.overlayId);

    console.log(`[LineTrading] ⚡ TRIGGER HIT on ${line.name} @ $${triggerPrice.toFixed(2)} (${line.actionType})`);

    try {
      if (line.actionType === 'EXECUTE') {
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
          line.triggeredTicket = ticket;
          showChartToast(`⚡ ${line.name}: Filled ${side} ${vol}L! Ticket #${ticket}`);

          if (line.timerEnabled && line.autoCloseMins > 0) {
            line.triggeredCountdownEnd = Date.now() + (line.autoCloseMins * 60 * 1000);
            showChartToast(`⏳ Auto-close armed: ${line.autoCloseMins}m countdown`);
          }
        } else {
          showChartToast(`⚠️ Line Trigger failed: ${data?.error || 'Execution rejected'}`);
          line.triggered = false;
        }
      } else if (line.actionType === 'EXIT') {
        const res = await fetch('/api/trade/close_all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: this.symbol })
        });
        const data = await res.json();
        showChartToast(`🚨 ${line.name}: Closed all positions! (${data.closed_count || 0} flattened)`);
      }
    } catch (err) {
      console.error('[LineTrading] Trigger execution error:', err);
      showChartToast(`⚠️ Network error executing trigger`);
      line.triggered = false;
    } finally {
      this.isExecuting = false;
      this.applyLineColor(line.overlayId);
      this.saveToStorage();
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

    // Line name
    const nameInput = document.getElementById('tvLineNameInput');
    if (nameInput) nameInput.value = line.name || '';

    // Action choice
    const chkExec = document.getElementById('tvLineChkExecute');
    const chkExit = document.getElementById('tvLineChkExit');
    const grpExec = document.getElementById('tvLineExecGroup');
    const grpExit = document.getElementById('tvLineExitGroup');

    const isExec = line.actionType === 'EXECUTE';
    if (chkExec) chkExec.checked = isExec;
    if (chkExit) chkExit.checked = !isExec;
    if (grpExec) grpExec.style.display = isExec ? 'block' : 'none';
    if (grpExit) grpExit.style.display = isExec ? 'none' : 'block';

    // Direction
    const btnBuy = document.getElementById('tvLineDirBuy');
    const btnSell = document.getElementById('tvLineDirSell');
    if (btnBuy && btnSell) {
      btnBuy.classList.toggle('active', line.direction === 'BUY');
      btnSell.classList.toggle('active', line.direction === 'SELL');
    }

    // Volume, SL, TP
    const volInput = document.getElementById('tvLineVolume');
    const slInput = document.getElementById('tvLineSlPts');
    const tpInput = document.getElementById('tvLineTpPts');
    if (volInput) volInput.value = line.volume || 0.50;
    if (slInput) slInput.value = line.slPts || 6.0;
    if (tpInput) tpInput.value = line.tpPts || 12.0;

    // Auto-Close Timer
    const chkTimer = document.getElementById('tvLineChkTimer');
    const grpTimer = document.getElementById('tvLineTimerControls');
    const timerMins = document.getElementById('tvLineTimerMins');
    if (chkTimer) chkTimer.checked = Boolean(line.timerEnabled);
    if (grpTimer) grpTimer.style.display = line.timerEnabled ? 'block' : 'none';
    if (timerMins) timerMins.value = line.autoCloseMins || 5.0;

    // Extend Ray
    const chkRay = document.getElementById('tvLineChkExtendRay');
    if (chkRay) chkRay.checked = Boolean(line.extendRay);

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

    // Mutually exclusive touch triggers
    const chkExec = document.getElementById('tvLineChkExecute');
    const chkExit = document.getElementById('tvLineChkExit');
    const grpExec = document.getElementById('tvLineExecGroup');
    const grpExit = document.getElementById('tvLineExitGroup');

    chkExec?.addEventListener('change', () => {
      if (chkExec.checked) {
        if (chkExit) chkExit.checked = false;
        if (grpExec) grpExec.style.display = 'block';
        if (grpExit) grpExit.style.display = 'none';
      } else {
        if (chkExit) chkExit.checked = true;
        if (grpExec) grpExec.style.display = 'none';
        if (grpExit) grpExit.style.display = 'block';
      }
      this._updateColorIndicator();
    });

    chkExit?.addEventListener('change', () => {
      if (chkExit.checked) {
        if (chkExec) chkExec.checked = false;
        if (grpExec) grpExec.style.display = 'none';
        if (grpExit) grpExit.style.display = 'block';
      } else {
        if (chkExec) chkExec.checked = true;
        if (grpExec) grpExec.style.display = 'block';
        if (grpExit) grpExit.style.display = 'none';
      }
      this._updateColorIndicator();
    });

    // Direction Toggle
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

    // Auto-Close Timer toggle
    const chkTimer = document.getElementById('tvLineChkTimer');
    const grpTimer = document.getElementById('tvLineTimerControls');
    chkTimer?.addEventListener('change', () => {
      if (grpTimer) grpTimer.style.display = chkTimer.checked ? 'block' : 'none';
    });

    // Timer Pills
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
        try { this.engine.chart.removeOverlay(idToDelete); } catch (_) {}
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
    const chkExec = document.getElementById('tvLineChkExecute');
    const isExec = chkExec ? chkExec.checked : true;
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
    const chkExec = document.getElementById('tvLineChkExecute');
    const isBuy = document.getElementById('tvLineDirBuy')?.classList.contains('active');
    const volInput = document.getElementById('tvLineVolume');
    const slInput = document.getElementById('tvLineSlPts');
    const tpInput = document.getElementById('tvLineTpPts');
    const chkTimer = document.getElementById('tvLineChkTimer');
    const timerMins = document.getElementById('tvLineTimerMins');
    const chkRay = document.getElementById('tvLineChkExtendRay');

    line.name = nameInput?.value?.trim() || line.name;
    line.actionType = (chkExec && chkExec.checked) ? 'EXECUTE' : 'EXIT';
    line.direction = isBuy ? 'BUY' : 'SELL';
    line.volume = Number(volInput?.value || 0.50);
    line.slPts = Number(slInput?.value || 6.0);
    line.tpPts = Number(tpInput?.value || 12.0);
    line.timerEnabled = Boolean(chkTimer && chkTimer.checked);
    line.autoCloseMins = Number(timerMins?.value || 5.0);
    line.extendRay = Boolean(chkRay && chkRay.checked);
    line.isArmed = isArmed;
    line.triggered = false; // Reset trigger state on re-arming

    this.applyLineColor(line.overlayId);
    this.saveToStorage();
  }

  // =========================================================================
  // 🧭 REDESIGNED COMPACT BOTTOM-LEFT FLOATING HUD
  // =========================================================================
  renderHud() {
    if (!this.hudEl) return;

    const activeLines = Array.from(this.lines.values()).filter(l => l.isArmed || l.triggered);
    if (activeLines.length === 0) {
      this.hudEl.style.display = 'none';
      return;
    }

    this.hudEl.style.display = 'flex';

    let html = `
      <div class="tv-hud-header">
        <div class="tv-hud-title-box">
          <span class="tv-hud-dot">●</span>
          <span class="tv-hud-title">ARMED LINES</span>
          <span class="tv-hud-count">${activeLines.length}</span>
        </div>
        <button id="tvHudMinBtn" class="tv-hud-min-btn" title="Minimize">▼</button>
      </div>
      <div class="tv-hud-body" id="tvHudBodyList">
    `;

    for (const line of activeLines) {
      const color = this.getLineColor(line);
      const isExit = line.actionType === 'EXIT';
      const actionBadge = isExit ? 'CLOSE ALL' : `${line.direction} ${line.volume}L`;
      const actionClass = isExit ? 'exit' : (line.direction === 'BUY' ? 'buy' : 'sell');

      const distStr = line._lastPriceDist !== undefined ? `${line._lastPriceDist.toFixed(1)} pt away` : '-- pt';

      let timerHtml = '';
      if (line.triggered && line.triggeredCountdownEnd) {
        const remSec = Math.max(0, Math.floor((line.triggeredCountdownEnd - Date.now()) / 1000));
        const m = Math.floor(remSec / 60).toString().padStart(2, '0');
        const s = (remSec % 60).toString().padStart(2, '0');
        timerHtml = `<span class="tv-hud-timer">⏳ ${m}:${s}</span>`;
      }

      html += `
        <div class="tv-hud-item" data-line-id="${line.overlayId}">
          <div class="tv-hud-item-top">
            <span class="tv-hud-item-dot" style="background-color: ${color};"></span>
            <span class="tv-hud-item-name" title="${line.name}">${line.name}</span>
            <span class="tv-hud-badge ${actionClass}">${actionBadge}</span>
          </div>
          <div class="tv-hud-item-bottom">
            <span class="tv-hud-item-dist">${distStr}</span>
            ${timerHtml}
            <div class="tv-hud-item-actions">
              <button class="tv-hud-act-btn" data-act="settings" data-id="${line.overlayId}" title="Settings">⚙</button>
              <button class="tv-hud-act-btn" data-act="toggle" data-id="${line.overlayId}" title="${line.isArmed ? 'Disarm' : 'Arm'}">
                ${line.isArmed ? '⏸' : '▶'}
              </button>
              <button class="tv-hud-act-btn delete" data-act="delete" data-id="${line.overlayId}" title="Delete">✕</button>
            </div>
          </div>
        </div>
      `;
    }

    html += `</div>`;
    this.hudEl.innerHTML = html;

    // Attach actions
    this.hudEl.querySelectorAll('.tv-hud-act-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-id');
        const line = this.lines.get(id);

        if (act === 'settings') {
          this.openSettingsModal(id);
        } else if (act === 'toggle' && line) {
          line.isArmed = !line.isArmed;
          this.applyLineColor(id);
          this.saveToStorage();
          showChartToast(line.isArmed ? `🟢 Armed ${line.name}` : `⚪ Disarmed ${line.name}`);
        } else if (act === 'delete' && line) {
          try { this.engine.chart.removeOverlay(id); } catch (_) {}
          this.removeLineOverlay(id);
          showChartToast(`Deleted ${line.name}`);
        }
      });
    });

    // Minimize toggle
    document.getElementById('tvHudMinBtn')?.addEventListener('click', () => {
      const bodyList = document.getElementById('tvHudBodyList');
      if (bodyList) {
        const isHidden = bodyList.style.display === 'none';
        bodyList.style.display = isHidden ? 'flex' : 'none';
        const minBtn = document.getElementById('tvHudMinBtn');
        if (minBtn) minBtn.textContent = isHidden ? '▼' : '▲';
      }
    });
  }
}
