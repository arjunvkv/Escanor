/**
 * Escanor — TradingView Bar Replay & Blind Strategy Engine
 * 
 * Features:
 * 1. TradingView-authentic Bar Replay:
 *    - Click "Replay" -> triggers Scissors cursor mode.
 *    - Click on any candle bar on the chart -> chart trims to that exact selected bar.
 *    - Floating, draggable TradingView Replay control bar (Jump, Reset, Play/Pause, Step 1 Bar, Speed, Exit).
 * 2. Blind Strategy Execution Engine (0 traps, 0 lookaheads, 0 overfit):
 *    - Monitors drawn boxes (with Fulcrum / Retest Axis top point & Vacuum Void bottom point).
 *    - Runs purely forward in time with ZERO lookahead.
 *    - Level Arrival Gate (within 0.80p) eliminates chop traps and hidden fires.
 *    - Coiling dwell exhaustion breakout/rejection triggers.
 *    - Scratch SL placed behind local stall extreme + 0.20p buffer.
 *    - Trailing SL moves to Breakeven (+0.10p) once profit reaches +1.80p.
 *    - Take Profit targets: +5.00p base TP and +10.00p milestone runner.
 * 3. Visual On-Chart Markings:
 *    - Entry Marker badge (▲ BUY / ▼ SELL) placed on entry bar.
 *    - Light Outcome Box (Green for WIN, Red for SCRATCH, Amber for BE) spanning entry to exit with PnL.
 * 4. Box Association & Clean Deletion:
 *    - Every trade marker and outcome box is linked to its parentBoxId.
 *    - When the parent box is deleted or removed from the chart, all of its trade markings are automatically erased!
 */

export class ReplayStrategyEngine {
  constructor(options = {}) {
    this.chart = options.chart || null;
    this.symbol = options.symbol || 'XAUUSD';
    
    // State
    this.isActive = false;
    this.isScissorsMode = false;
    this.isPlaying = false;
    this.speedMs = 500; // default 500ms per bar
    this.timerId = null;
    
    // Data buffers
    this.fullCandles = [];
    this.cutIndex = -1;
    this.currentIndex = -1;
    
    // Strategy & Box Trade tracking: { boxId: { inTrade: bool, trade: {...}, history: [] } }
    this.boxTradeStates = new Map();
    this.spawnedOverlayIds = new Set();
    
    // UI Elements
    this.replayBtn = null;
    this.controlBar = null;
    this.scissorsBanner = null;
    this.timeBadge = null;
    this.statsBadge = null;
    this.playBtn = null;
    this.speedSelect = null;
    
    // Crosshair hover tracker
    this.hoveredBar = null;
    this.hoveredIndex = -1;
    
    // Intra-bar Tick Replay Engine
    this.activeTicks = [];
    this.currentTickIndex = -1;
    this.currentLiveHigh = 0;
    this.currentLiveLow = 0;
    this.subTickTimerId = null;
    
    this.initOverlays();
  }

  /**
   * Helper to set full candle dataset in KLineCharts v10 via chartStore
   */
  setChartData(dataList) {
    if (!this.chart || !Array.isArray(dataList) || dataList.length === 0) return;
    try {
      const cs = this.chart._chartStore || (typeof this.chart.getChartStore === 'function' ? this.chart.getChartStore() : null);
      if (cs && typeof cs._addData === 'function') {
        const prevBarSpace = this.chart.getBarSpace?.()?.bar || 6.0;
        cs._addData(dataList, 'init', false);
        if (typeof this.chart.setBarSpace === 'function') {
          this.chart.setBarSpace(prevBarSpace > 1.0 ? prevBarSpace : 6.0);
        }
        if (typeof this.chart.setOffsetRightDistance === 'function') {
          this.chart.setOffsetRightDistance(80);
        }
        if (typeof this.chart.scrollToRealTime === 'function') {
          this.chart.scrollToRealTime();
        }
      }
    } catch (err) {
      console.warn('[Replay] setChartData error:', err);
    }
  }

  /**
   * Helper to smoothly append a single candle bar in KLineCharts v10
   */
  appendChartBar(bar) {
    if (!this.chart || !bar) return;
    try {
      const cs = this.chart._chartStore || (typeof this.chart.getChartStore === 'function' ? this.chart.getChartStore() : null);
      if (cs && typeof cs._addData === 'function') {
        cs._addData([bar], 'backward', false);
        if (typeof this.chart.scrollToRealTime === 'function') {
          this.chart.scrollToRealTime();
        }
      }
    } catch (err) {
      console.warn('[Replay] appendChartBar error:', err);
    }
  }

  /**
   * Helper to update currently active forming candle in-place in KLineCharts v10
   */
  updateLiveChartBar(liveBar) {
    if (!this.chart || !liveBar) return;
    try {
      const cs = this.chart._chartStore || (typeof this.chart.getChartStore === 'function' ? this.chart.getChartStore() : null);
      if (cs && typeof cs._addData === 'function') {
        cs._addData(liveBar, 'update', false);
      }
    } catch (err) {
      console.warn('[Replay] updateLiveChartBar error:', err);
    }
  }

  /**
   * Register custom KLineCharts overlays for Replay
   */
  initOverlays() {
    if (typeof window.klinecharts === 'undefined') return;
    const supported = window.klinecharts.getSupportedOverlays() || [];

    // 1. Trade Entry Marker (Triangle Arrow & Price Badge)
    if (!supported.includes('replayTradeMarker')) {
      window.klinecharts.registerOverlay({
        name: 'replayTradeMarker',
        totalStep: 2,
        needDefaultPointFigure: false,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        zLevel: 150,
        fixedZLevel: true,
        createPointFigures: ({ overlay, coordinates, yAxis }) => {
          if (!coordinates || coordinates.length === 0) return [];
          const coord = coordinates[0];
          const data = overlay.extendData || {};
          const isBuy = (data.dir === 'BUY');
          const price = Number(data.price || overlay.points?.[0]?.value || 0);
          const color = isBuy ? '#10b981' : '#ef4444';
          const bgColor = isBuy ? 'rgba(6, 78, 59, 0.90)' : 'rgba(127, 29, 29, 0.90)';
          const text = isBuy ? `▲ BUY $${price.toFixed(2)}` : `▼ SELL $${price.toFixed(2)}`;

          const figures = [];
          const yOffset = isBuy ? 24 : -24;

          // Connecting line
          figures.push({
            type: 'line',
            attrs: {
              coordinates: [
                { x: coord.x, y: coord.y },
                { x: coord.x, y: coord.y + yOffset }
              ]
            },
            styles: {
              style: 'solid',
              color: color,
              size: 1.5
            }
          });

          // Text pill badge
          figures.push({
            type: 'text',
            attrs: {
              x: coord.x,
              y: coord.y + yOffset,
              text: text,
              align: 'center',
              baseline: isBuy ? 'top' : 'bottom'
            },
            styles: {
              color: '#ffffff',
              size: 10,
              weight: 'bold',
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
              backgroundColor: bgColor,
              borderColor: color,
              borderSize: 1,
              borderRadius: 3,
              paddingLeft: 6,
              paddingRight: 6,
              paddingTop: 2,
              paddingBottom: 2
            }
          });

          return figures;
        }
      });
    }

    // 2. Light Trade Outcome Box (Spanning from Entry Bar to Exit Bar)
    if (!supported.includes('replayTradeBox')) {
      window.klinecharts.registerOverlay({
        name: 'replayTradeBox',
        totalStep: 3,
        needDefaultPointFigure: false,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        zLevel: 25,
        fixedZLevel: true,
        createPointFigures: ({ overlay, coordinates }) => {
          if (!coordinates || coordinates.length < 2) return [];
          const x0 = coordinates[0].x;
          const y0 = coordinates[0].y;
          const x1 = coordinates[1].x;
          const y1 = coordinates[1].y;

          const minX = Math.min(x0, x1);
          const maxX = Math.max(x0, x1);
          const minY = Math.min(y0, y1);
          const maxY = Math.max(y0, y1);

          const data = overlay.extendData || {};
          const outcome = data.outcome || 'WIN';
          const pnlPts = Number(data.pnlPts || 0);
          const pnlUsd = Number(data.pnlUsd || 0);

          let fillColor = 'rgba(16, 185, 129, 0.16)';
          let borderColor = '#10b981';
          let labelText = `✓ WIN +${pnlPts.toFixed(2)}p (+$${pnlUsd.toFixed(0)})`;

          if (outcome === 'LOSS') {
            fillColor = 'rgba(239, 68, 68, 0.16)';
            borderColor = '#ef4444';
            labelText = `✕ SCRATCH ${pnlPts.toFixed(2)}p (-$${Math.abs(pnlUsd).toFixed(0)})`;
          } else if (outcome === 'BE') {
            fillColor = 'rgba(245, 158, 11, 0.16)';
            borderColor = '#f59e0b';
            labelText = `🛡️ BE +${pnlPts.toFixed(2)}p (+$${pnlUsd.toFixed(0)})`;
          }

          const figures = [
            // Light transparent box
            {
              type: 'polygon',
              attrs: {
                coordinates: [
                  { x: minX, y: minY },
                  { x: maxX, y: minY },
                  { x: maxX, y: maxY },
                  { x: minX, y: maxY }
                ]
              },
              styles: {
                style: 'stroke_fill',
                color: fillColor,
                borderColor: borderColor,
                borderSize: 1.5,
                borderStyle: 'solid'
              }
            },
            // Pill tag in top-left of box
            {
              type: 'text',
              attrs: {
                x: minX + 6,
                y: minY + 6,
                text: labelText,
                align: 'left',
                baseline: 'top'
              },
              styles: {
                color: borderColor,
                size: 9.5,
                weight: 'bold',
                family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
                backgroundColor: 'rgba(15, 23, 42, 0.88)',
                borderColor: borderColor,
                borderSize: 1,
                borderRadius: 2,
                paddingLeft: 5,
                paddingRight: 5,
                paddingTop: 1.5,
                paddingBottom: 1.5
              }
            }
          ];

          return figures;
        }
      });
    }
  }

  /**
   * Bind DOM elements and listeners
   */
  bindUI() {
    this.replayBtn = document.getElementById('tvBarReplayBtn');
    this.controlBar = document.getElementById('tvReplayControlBar');
    this.scissorsBanner = document.getElementById('tvScissorsPromptBanner');
    this.timeBadge = document.getElementById('tvReplayTimeBadge');
    this.statsBadge = document.getElementById('tvReplayStatsText');
    this.playBtn = document.getElementById('tvReplayPlayBtn');
    this.speedSelect = document.getElementById('tvReplaySpeedSelect');

    const jumpBtn = document.getElementById('tvReplayJumpBtn');
    const resetBtn = document.getElementById('tvReplayResetBtn');
    const stepBtn = document.getElementById('tvReplayStepBtn');
    const exitBtn = document.getElementById('tvReplayExitBtn');
    const cancelScissorsBtn = document.getElementById('tvCancelScissorsBtn');

    // Header Replay Button Toggle
    this.replayBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isActive) {
        this.exitReplay();
      } else {
        this.enterScissorsMode();
      }
    });

    // Scissors Mode Actions
    cancelScissorsBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exitScissorsMode();
    });
    jumpBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.enterScissorsMode();
    });

    // Controls
    resetBtn?.addEventListener('click', () => this.resetToCut());
    this.playBtn?.addEventListener('click', () => this.togglePlay());
    stepBtn?.addEventListener('click', () => this.stepForward());
    exitBtn?.addEventListener('click', () => this.exitReplay());

    // Speed Selector
    this.speedSelect?.addEventListener('change', (e) => {
      this.speedMs = Number(e.target.value) || 500;
      if (this.isPlaying) {
        this.pause();
        this.play();
      }
    });

    // Keyboard Shortcuts (Space = Play/Pause, Right Arrow = Step Forward, Esc = Cancel Scissors/Exit)
    window.addEventListener('keydown', (e) => {
      if (!this.isActive && !this.isScissorsMode) return;
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      if (e.key === 'Escape') {
        if (this.isScissorsMode) {
          this.exitScissorsMode();
        } else if (this.isActive) {
          this.exitReplay();
        }
      } else if (e.key === ' ' && this.isActive) {
        e.preventDefault();
        this.togglePlay();
      } else if (e.key === 'ArrowRight' && this.isActive) {
        e.preventDefault();
        this.stepForward();
      }
    });

    // ⚡ CAPTURE-PHASE SCISSORS CLICK LISTENER
    // KLineCharts attaches canvas pointer listeners that stop propagation in bubble phase.
    // Capturing phase ensures our scissors click intercepts the event immediately!
    const chartDom = document.getElementById('klineChart');
    if (chartDom) {
      const handleScissorsTrigger = (e) => {
        if (this.isScissorsMode) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          this.onScissorsClick(e);
        }
      };

      chartDom.addEventListener('pointerdown', handleScissorsTrigger, true);
      chartDom.addEventListener('click', handleScissorsTrigger, true);

      // Live hovered bar feedback in scissors banner
      chartDom.addEventListener('pointermove', (e) => {
        if (!this.isScissorsMode || !this.chart) return;
        try {
          const cs = this.chart._chartStore || (typeof this.chart.getChartStore === 'function' ? this.chart.getChartStore() : null);
          const b = this.hoveredBar || (cs && typeof cs.getCrosshair === 'function' && cs.getCrosshair()?.kLineData);
          if (b && b.timestamp) {
            const dt = new Date(b.timestamp);
            const timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            const dateStr = dt.toISOString().slice(5, 10);
            const bannerText = document.querySelector('.tv-scissors-text');
            if (bannerText) {
              bannerText.innerHTML = `<b>JUMP TO BAR:</b> Click bar at <code>${dateStr} ${timeStr}</code> ($${Number(b.close || 0).toFixed(2)}) to cut.`;
            }
          }
        } catch (err) {}
      }, true);
    }

    if (this.chart) {
      this.chart.subscribeAction('onCrosshairChange', (data) => {
        if (data && data.kLineData) {
          this.hoveredBar = data.kLineData;
          this.hoveredIndex = (typeof data.dataIndex === 'number') ? data.dataIndex : -1;
        }
      });
    }

    // Draggable Floating Bar
    this.makeDraggable(this.controlBar);
  }

  /**
   * Enter TradingView Scissors Mode
   */
  enterScissorsMode() {
    this.isScissorsMode = true;
    const dataList = this.chart?.getDataList() || [];
    if (!this.isActive && dataList.length > 0) {
      this.fullCandles = [...dataList];
    }

    const chartDom = document.getElementById('klineChart');
    if (chartDom) {
      chartDom.classList.add('tv-scissors-mode');
    }
    if (this.scissorsBanner) {
      this.scissorsBanner.style.display = 'flex';
      const bannerText = document.querySelector('.tv-scissors-text');
      if (bannerText) {
        bannerText.innerHTML = `<b>JUMP TO BAR:</b> Click on any candle bar to trim the chart and start replay from that point.`;
      }
    }
    if (this.replayBtn) {
      this.replayBtn.classList.add('active');
    }
  }

  /**
   * Exit Scissors Mode (cancel cut)
   */
  exitScissorsMode() {
    this.isScissorsMode = false;
    const chartDom = document.getElementById('klineChart');
    if (chartDom) {
      chartDom.classList.remove('tv-scissors-mode');
    }
    if (this.scissorsBanner) {
      this.scissorsBanner.style.display = 'none';
    }
    if (!this.isActive && this.replayBtn) {
      this.replayBtn.classList.remove('active');
    }
  }

  /**
   * Handle Scissors Click: Trim chart to clicked candle
   */
  onScissorsClick(evt) {
    if (!this.chart) return;
    const dataList = this.chart.getDataList() || [];
    if (dataList.length === 0 && this.fullCandles.length === 0) return;

    // Capture complete dataset before any trimming
    if (this.fullCandles.length === 0 || !this.isActive) {
      this.fullCandles = [...dataList];
    }
    const fullList = this.fullCandles;
    if (fullList.length === 0) return;

    let targetIndex = -1;
    let clickedTimestamp = null;

    // 1. Primary: Use hoveredBar or internal crosshair bar (exact bar under mouse pointer)
    const cs = this.chart._chartStore || (typeof this.chart.getChartStore === 'function' ? this.chart.getChartStore() : null);
    const chBar = (cs && typeof cs.getCrosshair === 'function' && cs.getCrosshair()?.kLineData) || this.hoveredBar;
    if (chBar && chBar.timestamp) {
      clickedTimestamp = chBar.timestamp;
    }

    if (clickedTimestamp) {
      targetIndex = fullList.findIndex(b => b.timestamp === clickedTimestamp);
    }

    // 2. Secondary: If crosshair coordinate available, convert to bar
    if (targetIndex < 0 && evt) {
      try {
        const chartDom = document.getElementById('klineChart');
        const rect = chartDom?.getBoundingClientRect();
        if (rect && typeof this.chart.convertFromPixel === 'function') {
          const x = evt.clientX - rect.left;
          const y = evt.clientY - rect.top;
          const res = this.chart.convertFromPixel({ x, y });
          if (res && res.timestamp) {
            targetIndex = fullList.findIndex(b => b.timestamp === res.timestamp);
          } else if (res && typeof res.dataIndex === 'number' && !isNaN(res.dataIndex)) {
            const idx = Math.round(res.dataIndex);
            if (idx >= 0 && idx < fullList.length) {
              targetIndex = idx;
            }
          }
        }
      } catch (err) {
        console.warn('[Replay] convertFromPixel fallback error:', err);
      }
    }

    // 3. Tertiary: Fallback to hoveredIndex
    if (targetIndex < 0 && this.hoveredIndex >= 0 && this.hoveredIndex < fullList.length) {
      targetIndex = this.hoveredIndex;
    }

    // 4. Default: If clicked far right, use latest bar
    if (targetIndex < 0) {
      targetIndex = fullList.length - 1;
    }

    targetIndex = Math.max(0, Math.min(targetIndex, fullList.length - 1));

    this.cutIndex = targetIndex;
    this.currentIndex = targetIndex;

    // Trim candles up to clicked bar
    const trimmed = this.fullCandles.slice(0, this.cutIndex + 1);
    this.setChartData(trimmed);

    // Pause live WebSocket bar updates
    window.__replayActive = true;
    this.isActive = true;
    this.exitScissorsMode();

    // Clear live orders & structural levels from chart so historical view is 100% clean
    if (window.__activeOrdersEngine && typeof window.__activeOrdersEngine.clearAll === 'function') {
      window.__activeOrdersEngine.clearAll();
    }
    if (window.__structuralLevels && typeof window.__structuralLevels.clearAll === 'function') {
      window.__structuralLevels.clearAll();
    }

    // Show Floating Replay Bar
    if (this.controlBar) {
      this.controlBar.style.display = 'flex';
    }

    this.clearReplayTradeMarkings();
    this.updateTimeDisplay();
    this.updateStatsDisplay();

    // Initial evaluation of existing boxes at cut point
    this.evaluateBoxesStrategy(trimmed[trimmed.length - 1]);
  }

  /**
   * Decompose completed bar into realistic, truthful intra-bar auction path micro-ticks:
   * Open -> Initial Probe Wick -> Expansion Surge across body -> Opposite Wick -> Close
   */
  generateIntraBarTicks(bar) {
    const O = Number(bar.open);
    const H = Number(bar.high);
    const L = Number(bar.low);
    const C = Number(bar.close);

    const isBull = (C >= O);
    // 4 Key Auction Milestones
    const m1 = O;
    const m2 = isBull ? L : H; // Initial probe / sweep
    const m3 = isBull ? H : L; // Expansion extreme
    const m4 = C;             // Close settlement

    const ticks = [];

    // Helper to generate interpolated sub-steps with micro-fluctuations
    const interpolate = (pStart, pEnd, steps) => {
      const pts = [];
      for (let i = 1; i <= steps; i++) {
        const frac = i / steps;
        let p = pStart + (pEnd - pStart) * frac;
        if (i < steps) {
          const noise = (Math.sin(i * 2.3) * 0.04);
          p = Math.max(L, Math.min(H, p + noise));
        }
        pts.push(Math.round(p * 100) / 100);
      }
      return pts;
    };

    ticks.push(O);
    // 4 ticks from Open to first extreme
    ticks.push(...interpolate(m1, m2, 4));
    // 8 ticks across body to second extreme
    ticks.push(...interpolate(m2, m3, 8));
    // 4 ticks to Close
    ticks.push(...interpolate(m3, m4, 4));

    return ticks;
  }

  /**
   * Toggle Play / Pause
   */
  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    if (this.playBtn) {
      this.playBtn.textContent = '⏸';
      this.playBtn.classList.add('playing');
    }

    this.scheduleNextTick();
  }

  pause() {
    this.isPlaying = false;
    if (this.subTickTimerId) {
      clearTimeout(this.subTickTimerId);
      this.subTickTimerId = null;
    }
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.playBtn) {
      this.playBtn.textContent = '▶';
      this.playBtn.classList.remove('playing');
    }
  }

  /**
   * Schedule next smooth intra-bar micro-tick
   */
  scheduleNextTick() {
    if (!this.isPlaying || !this.chart || this.fullCandles.length === 0) return;

    // Check if we need to start a brand new candle
    if (this.currentTickIndex < 0 || !this.activeTicks || this.currentTickIndex >= this.activeTicks.length) {
      if (this.currentIndex >= this.fullCandles.length - 1) {
        this.pause();
        return;
      }

      this.currentIndex += 1;
      const targetBar = this.fullCandles[this.currentIndex];
      this.activeTicks = this.generateIntraBarTicks(targetBar);
      this.currentTickIndex = 0;
      this.currentLiveHigh = targetBar.open;
      this.currentLiveLow = targetBar.open;

      // Start the new live candle at Open
      const initialCandle = {
        timestamp: targetBar.timestamp,
        open: targetBar.open,
        high: targetBar.open,
        low: targetBar.open,
        close: targetBar.open,
        volume: 1
      };
      this.appendChartBar(initialCandle);
      this.updateTimeDisplay();
      this.evaluateBoxesStrategy(initialCandle);
    }

    // Process current intra-bar sub-tick
    const targetBar = this.fullCandles[this.currentIndex];
    const curPrice = this.activeTicks[this.currentTickIndex];
    this.currentLiveHigh = Math.max(this.currentLiveHigh, curPrice);
    this.currentLiveLow = Math.min(this.currentLiveLow, curPrice);

    const isLastTick = (this.currentTickIndex >= this.activeTicks.length - 1);
    const liveCandle = {
      timestamp: targetBar.timestamp,
      open: targetBar.open,
      high: isLastTick ? targetBar.high : this.currentLiveHigh,
      low: isLastTick ? targetBar.low : this.currentLiveLow,
      close: isLastTick ? targetBar.close : curPrice,
      volume: isLastTick ? targetBar.volume : Math.max(1, Math.round(targetBar.volume * ((this.currentTickIndex + 1) / this.activeTicks.length)))
    };

    // Update candle in-place on chart (living candle breathing animation)
    this.updateLiveChartBar(liveCandle);

    // Evaluate Strategy Engine on current sub-tick
    this.evaluateBoxesStrategy(liveCandle);

    this.currentTickIndex += 1;

    // Compute tick interval based on selected speed
    const tickInterval = Math.max(12, Math.floor(this.speedMs / Math.max(1, this.activeTicks.length)));

    this.subTickTimerId = setTimeout(() => {
      if (this.isPlaying) {
        this.scheduleNextTick();
      }
    }, tickInterval);
  }

  /**
   * Advance 1 Full Bar Forward (Instant Step)
   */
  stepForward() {
    if (!this.chart || this.fullCandles.length === 0) return;

    if (this.currentIndex >= this.fullCandles.length - 1) {
      this.pause();
      return;
    }

    if (this.subTickTimerId) {
      clearTimeout(this.subTickTimerId);
      this.subTickTimerId = null;
    }

    this.currentIndex += 1;
    const nextBar = this.fullCandles[this.currentIndex];

    // Smoothly append full completed candle to chart
    this.appendChartBar(nextBar);

    this.activeTicks = [];
    this.currentTickIndex = -1;

    this.updateTimeDisplay();

    // Run Strategy Engine on completed bar
    this.evaluateBoxesStrategy(nextBar);
  }

  /**
   * Reset Replay back to initial cut bar
   */
  resetToCut() {
    this.pause();
    this.activeTicks = [];
    this.currentTickIndex = -1;
    this.currentIndex = this.cutIndex;
    const trimmed = this.fullCandles.slice(0, this.cutIndex + 1);
    this.setChartData(trimmed);
    this.clearReplayTradeMarkings();
    this.updateTimeDisplay();
    this.updateStatsDisplay();
    if (trimmed.length > 0) {
      this.evaluateBoxesStrategy(trimmed[trimmed.length - 1]);
    }
  }

  /**
   * Exit Replay and Restore Live MT5 Chart
   */
  exitReplay() {
    this.pause();
    this.isActive = false;
    this.exitScissorsMode();
    window.__replayActive = false;

    if (this.subTickTimerId) {
      clearTimeout(this.subTickTimerId);
      this.subTickTimerId = null;
    }
    this.activeTicks = [];
    this.currentTickIndex = -1;

    // Clean up temporary trade overlays
    this.clearReplayTradeMarkings();

    // Restore full original candles
    if (this.fullCandles.length > 0) {
      this.setChartData(this.fullCandles);
      this.fullCandles = [];
    }

    if (this.controlBar) {
      this.controlBar.style.display = 'none';
    }
    if (this.replayBtn) {
      this.replayBtn.classList.remove('active');
    }
  }

  /**
   * Clean all trade markers & outcome boxes spawned by replay
   */
  clearReplayTradeMarkings() {
    if (!this.chart) return;
    this.spawnedOverlayIds.forEach((id) => {
      try {
        this.chart.removeOverlay({ id });
      } catch (e) {
        // ignore
      }
    });
    this.spawnedOverlayIds.clear();
    this.boxTradeStates.clear();
  }

  /**
   * Called when any overlay is removed from the chart.
   * If a box is removed, instantly remove all associated trade markers and outcome boxes!
   */
  onOverlayRemoved(removedOverlayId) {
    if (!this.chart || !removedOverlayId) return;

    const toRemove = [];
    const overlays = this.chart.getOverlays() || [];

    overlays.forEach((ov) => {
      if (ov.extendData && ov.extendData.parentBoxId === removedOverlayId) {
        toRemove.push(ov.id);
      }
    });

    toRemove.forEach((id) => {
      try {
        this.chart.removeOverlay({ id });
        this.spawnedOverlayIds.delete(id);
      } catch (e) {
        console.warn('Failed removing child overlay:', e);
      }
    });

    if (this.boxTradeStates.has(removedOverlayId)) {
      this.boxTradeStates.delete(removedOverlayId);
      this.updateStatsDisplay();
    }
  }

  /**
   * 🦅 BLIND STRATEGY ENGINE EXECUTION (ZERO LOOKAHEAD, ZERO TRAPS, ZERO OVERFIT)
   * Evaluates all visible boxes on the current bar
   */
  evaluateBoxesStrategy(bar) {
    if (!this.chart || !bar) return;

    const overlays = this.chart.getOverlays() || [];
    const rects = overlays.filter((ov) => ov.name === 'rect');

    rects.forEach((rect) => {
      const pts = rect.points || [];
      if (pts.length < 2) return;

      const prices = pts.map((p) => p.value).filter((v) => typeof v === 'number' && !isNaN(v));
      const times = pts.map((p) => p.timestamp).filter((t) => typeof t === 'number' && !isNaN(t));
      if (prices.length < 2 || times.length < 2) return;

      const boxTop = Math.max(...prices);
      const boxBottom = Math.min(...prices);
      const boxStart = Math.min(...times);

      // Only evaluate if current bar is at or after box start
      if (bar.timestamp < boxStart) return;

      // Get or initialize state for this box
      if (!this.boxTradeStates.has(rect.id)) {
        this.boxTradeStates.set(rect.id, {
          inTrade: false,
          activeTrade: null,
          tradesHistory: [],
          lastExitTime: 0
        });
      }

      const state = this.boxTradeStates.get(rect.id);

      // 1. MANAGE ACTIVE TRADE
      if (state.inTrade && state.activeTrade) {
        const tr = state.activeTrade;
        const pos = tr.dir;
        const entry = tr.entry;

        if (pos === 'SELL') {
          const mfe = entry - bar.low;
          const mae = bar.high - entry;
          if (mfe > tr.maxMfe) tr.maxMfe = mfe;
          if (mae > tr.maxMae) tr.maxMae = mae;

          // Breakeven Gate: Move SL to BE + 0.10p once MFE >= +1.80p
          if (mfe >= 1.80 && !tr.beActive) {
            tr.beActive = true;
            tr.sl = Math.round((entry - 0.10) * 100) / 100;
          }

          // Check TP Hit (+10p milestone or +5p base)
          if (mfe >= 10.0) {
            this.closeTrade(rect.id, tr, bar, 'WIN', 7.50, entry - 10.0);
            return;
          } else if (mfe >= 5.0 && bar.high >= entry - 3.50) {
            this.closeTrade(rect.id, tr, bar, 'WIN', 5.00, entry - 5.0);
            return;
          }

          // Check SL Hit
          if (bar.high >= tr.sl) {
            const outcome = tr.beActive ? 'BE' : 'LOSS';
            const pnlPts = tr.beActive ? 0.10 : -(tr.sl - entry);
            this.closeTrade(rect.id, tr, bar, outcome, pnlPts, tr.sl);
            return;
          }
        } else if (pos === 'BUY') {
          const mfe = bar.high - entry;
          const mae = entry - bar.low;
          if (mfe > tr.maxMfe) tr.maxMfe = mfe;
          if (mae > tr.maxMae) tr.maxMae = mae;

          // Breakeven Gate: Move SL to BE + 0.10p once MFE >= +1.80p
          if (mfe >= 1.80 && !tr.beActive) {
            tr.beActive = true;
            tr.sl = Math.round((entry + 0.10) * 100) / 100;
          }

          // Check TP Hit (+10p milestone or +5p base)
          if (mfe >= 10.0) {
            this.closeTrade(rect.id, tr, bar, 'WIN', 7.50, entry + 10.0);
            return;
          } else if (mfe >= 5.0 && bar.low <= entry + 3.50) {
            this.closeTrade(rect.id, tr, bar, 'WIN', 5.00, entry + 5.0);
            return;
          }

          // Check SL Hit
          if (bar.low <= tr.sl) {
            const outcome = tr.beActive ? 'BE' : 'LOSS';
            const pnlPts = tr.beActive ? 0.10 : -(entry - tr.sl);
            this.closeTrade(rect.id, tr, bar, outcome, pnlPts, tr.sl);
            return;
          }
        }
        return;
      }

      // 2. ENTRY EVALUATION (ZERO LOOKAHEAD, FIRST TOUCH LEVEL ARRIVAL GATE)
      // Enforce 30-min cooldown after previous trade exit on this box
      if (bar.timestamp - state.lastExitTime < 30 * 60 * 1000) return;

      const distTop = Math.abs(bar.high - boxTop);
      const distBottom = Math.abs(bar.low - boxBottom);

      // LEVEL ARRIVAL GATE: Price must be within 0.80p of the two points
      if (distTop > 0.80 && distBottom > 0.80) return;

      // Retest Axis Exhaustion Rejection (Top Edge: SELL)
      if (distTop <= 0.80 && bar.high >= (boxTop - 0.40)) {
        // Candle rejection signal (close <= open, upper probe)
        if (bar.close <= bar.open) {
          const entryPrice = Math.round(bar.close * 100) / 100;
          const scratchSl = Math.round((bar.high + 0.20) * 100) / 100;
          const risk = Math.round((scratchSl - entryPrice) * 100) / 100;

          if (risk >= 0.60 && risk <= 2.20) {
            this.openTrade(rect.id, 'SELL', entryPrice, scratchSl, risk, bar);
          }
        }
      }
      // Vacuum Void Floor Bounce (Bottom Edge: BUY)
      else if (distBottom <= 0.80 && bar.low <= (boxBottom + 0.40)) {
        // Candle bounce signal (close >= open, lower rejection wick)
        if (bar.close >= bar.open) {
          const entryPrice = Math.round(bar.close * 100) / 100;
          const scratchSl = Math.round((bar.low - 0.20) * 100) / 100;
          const risk = Math.round((entryPrice - scratchSl) * 100) / 100;

          if (risk >= 0.60 && risk <= 2.20) {
            this.openTrade(rect.id, 'BUY', entryPrice, scratchSl, risk, bar);
          }
        }
      }
    });
  }

  /**
   * Open Trade & Spawn Entry Marker
   */
  openTrade(boxId, dir, entryPrice, sl, risk, bar) {
    const state = this.boxTradeStates.get(boxId);
    if (!state) return;

    const tradeId = `trade_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const trade = {
      id: tradeId,
      parentBoxId: boxId,
      dir,
      entry: entryPrice,
      entryTime: bar.timestamp,
      sl,
      risk,
      beActive: false,
      maxMfe: 0.0,
      maxMae: 0.0
    };

    state.inTrade = true;
    state.activeTrade = trade;

    // Create On-Chart Visual Entry Marker
    try {
      const markerId = this.chart.createOverlay({
        name: 'replayTradeMarker',
        points: [{ timestamp: bar.timestamp, value: entryPrice }],
        extendData: {
          parentBoxId: boxId,
          tradeId,
          dir,
          price: entryPrice,
          lot: 0.50
        }
      });
      if (markerId) {
        this.spawnedOverlayIds.add(markerId);
      }
    } catch (e) {
      console.warn('Failed creating entry marker:', e);
    }

    this.updateStatsDisplay();
  }

  /**
   * Close Trade & Spawn Light Outcome Box
   */
  closeTrade(boxId, trade, bar, outcome, pnlPts, exitPrice) {
    const state = this.boxTradeStates.get(boxId);
    if (!state) return;

    const lot = 0.50; // standard default
    const pnlUsd = pnlPts * 100.0 * lot;

    trade.outcome = outcome;
    trade.pnlPts = pnlPts;
    trade.pnlUsd = pnlUsd;
    trade.exitTime = bar.timestamp;
    trade.exitPrice = exitPrice;

    state.tradesHistory.push({ ...trade });
    state.inTrade = false;
    state.activeTrade = null;
    state.lastExitTime = bar.timestamp;

    // Create On-Chart Light Outcome Box
    try {
      const boxOverlayId = this.chart.createOverlay({
        name: 'replayTradeBox',
        points: [
          { timestamp: trade.entryTime, value: trade.entry },
          { timestamp: bar.timestamp, value: exitPrice }
        ],
        extendData: {
          parentBoxId: boxId,
          tradeId: trade.id,
          outcome,
          pnlPts,
          pnlUsd
        }
      });
      if (boxOverlayId) {
        this.spawnedOverlayIds.add(boxOverlayId);
      }
    } catch (e) {
      console.warn('Failed creating replay trade box:', e);
    }

    this.updateStatsDisplay();
  }

  /**
   * Update Floating Replay Bar Time Display
   */
  updateTimeDisplay() {
    if (!this.timeBadge || this.currentIndex < 0 || this.currentIndex >= this.fullCandles.length) return;
    const bar = this.fullCandles[this.currentIndex];
    const dt = new Date(bar.timestamp);
    // Format: 2026-10-28 07:25 AM
    const dateStr = dt.toISOString().slice(0, 10);
    const timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    this.timeBadge.textContent = `${dateStr} ${timeStr}`;
  }

  /**
   * Update Floating Replay Bar Strategy Statistics
   */
  updateStatsDisplay() {
    if (!this.statsBadge) return;

    let totalTrades = 0;
    let netPts = 0.0;
    let netUsd = 0.0;

    this.boxTradeStates.forEach((st) => {
      st.tradesHistory.forEach((t) => {
        totalTrades += 1;
        netPts += (t.pnlPts || 0);
        netUsd += (t.pnlUsd || 0);
      });
      if (st.inTrade) {
        totalTrades += 1; // 1 active
      }
    });

    const sign = netUsd >= 0 ? '+' : '-';
    this.statsBadge.textContent = `${totalTrades} Trades | ${sign}$${Math.abs(netUsd).toFixed(0)} (${netPts >= 0 ? '+' : ''}${netPts.toFixed(1)}p)`;
  }

  /**
   * Make any DOM element draggable
   */
  makeDraggable(element) {
    if (!element) return;
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
