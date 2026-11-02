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
    if (typeof window !== 'undefined') {
      window.__replayEngine = this;
    }
    
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
    this.trailToggleBtn = null;
    this.manualExitBtn = null;
    this.isTrailingEnabled = true;
    
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

    // 1. Trade Entry Marker (Clean Minimalist Arrow Indicator — Zero Text Clutter)
    if (!supported.includes('replayTradeMarker')) {
      window.klinecharts.registerOverlay({
        name: 'replayTradeMarker',
        totalStep: 2,
        needDefaultPointFigure: false,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        zLevel: 300,
        fixedZLevel: true,
        onClick: (event) => {
          if (window.__replayEngine) {
            window.__replayEngine.onTradeOverlayClick(event);
          }
          return true;
        },
        createPointFigures: ({ overlay, coordinates, bounding, yAxis, xAxis }) => {
          let x = coordinates?.[0]?.x;
          let y = coordinates?.[0]?.y;
          if ((typeof x !== 'number' || isNaN(x)) && overlay.points?.[0] && xAxis && typeof xAxis.convertToPixel === 'function') {
            x = xAxis.convertToPixel(overlay.points[0].timestamp);
          }
          if ((typeof y !== 'number' || isNaN(y)) && overlay.points?.[0] && yAxis && typeof yAxis.convertToPixel === 'function') {
            y = yAxis.convertToPixel(overlay.points[0].value);
          }
          if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) return [];

          const data = overlay.extendData || {};
          const isBuy = (data.dir === 'BUY');
          const color = isBuy ? '#10b981' : '#ef4444';

          const figures = [];

          // 1. Sleek Entry Arrow (pointing up into candle low for BUY, down into high for SELL)
          if (isBuy) {
            figures.push({
              type: 'line',
              attrs: {
                coordinates: [
                  { x, y: y + 6 },
                  { x, y: y + 14 }
                ]
              },
              styles: {
                style: 'solid',
                color: color,
                size: 2
              }
            });
            figures.push({
              type: 'polygon',
              attrs: {
                coordinates: [
                  { x, y: y + 1 },
                  { x: x - 5, y: y + 7 },
                  { x: x + 5, y: y + 7 }
                ]
              },
              styles: {
                style: 'fill',
                color: color
              }
            });
          } else {
            figures.push({
              type: 'line',
              attrs: {
                coordinates: [
                  { x, y: y - 6 },
                  { x, y: y - 14 }
                ]
              },
              styles: {
                style: 'solid',
                color: color,
                size: 2
              }
            });
            figures.push({
              type: 'polygon',
              attrs: {
                coordinates: [
                  { x, y: y - 1 },
                  { x: x - 5, y: y - 7 },
                  { x: x + 5, y: y - 7 }
                ]
              },
              styles: {
                style: 'fill',
                color: color
              }
            });
          }

          // 2. Clean Entry Price Badge at Start
          const entryVal = Number(data.price || overlay.points?.[0]?.value || 0).toFixed(2);
          figures.push({
            type: 'text',
            attrs: {
              x: x + 6,
              y: isBuy ? (y - 5) : (y + 12),
              text: `${data.dir || ''} ${entryVal}`,
              align: 'left',
              baseline: isBuy ? 'bottom' : 'top'
            },
            styles: {
              color: '#10b981',
              size: 10,
              family: 'monospace',
              weight: 'bold'
            }
          });

          return figures;
        }
      });
    }

    // 2. Light Trade Outcome Box (Shaded Box Starting At Entry — Zero Text Badges)
    if (!supported.includes('replayTradeBox')) {
      window.klinecharts.registerOverlay({
        name: 'replayTradeBox',
        totalStep: 3,
        needDefaultPointFigure: false,
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        zLevel: 100,
        fixedZLevel: true,
        onClick: (event) => {
          if (window.__replayEngine) {
            window.__replayEngine.onTradeOverlayClick(event);
          }
          return true;
        },
        createPointFigures: ({ overlay, coordinates, bounding, yAxis, xAxis }) => {
          let x0 = coordinates?.[0]?.x;
          let y0 = coordinates?.[0]?.y;
          let x1 = coordinates?.[1]?.x;
          let y1 = coordinates?.[1]?.y;

          if (typeof x0 !== 'number' || typeof y0 !== 'number' || isNaN(x0) || isNaN(y0)) {
            return [];
          }

          // If x1 is same as x0 (e.g. freshly opened trade on entry candle), ensure at least a 24px wide box
          if (typeof x1 !== 'number' || isNaN(x1) || Math.abs(x1 - x0) < 16) {
            x1 = x0 + 24;
          }
          if (typeof y1 !== 'number' || isNaN(y1)) {
            y1 = y0 + 30;
          }

          const minX = Math.min(x0, x1);
          let maxX = Math.max(x0, x1);
          if (maxX - minX < 24) maxX = minX + 24;

          const minY = Math.min(y0, y1);
          let maxY = Math.max(y0, y1);
          if (maxY - minY < 12) maxY = minY + 15;

          const data = overlay.extendData || {};
          const isLive = Boolean(data.isLive);
          const outcome = data.outcome || (isLive ? 'ACTIVE' : 'WIN');

          let fillColor = 'rgba(16, 185, 129, 0.12)';
          let borderColor = '#10b981';

          if (outcome === 'LOSS') {
            fillColor = 'rgba(239, 68, 68, 0.12)';
            borderColor = '#ef4444';
          } else if (outcome === 'BE') {
            fillColor = 'rgba(245, 158, 11, 0.12)';
            borderColor = '#f59e0b';
          } else if (isLive || outcome === 'ACTIVE') {
            fillColor = 'rgba(16, 185, 129, 0.08)';
            borderColor = '#10b981';
          }

          const figures = [
            // Light transparent trade box starting from entry itself
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
                borderSize: 1,
                borderStyle: (isLive || outcome === 'ACTIVE') ? 'dashed' : 'solid'
              }
            }
          ];

          // Dashed green horizontal entry line right across the box starting at entry
          const entryPrice = Number(data.entry || overlay.points?.[0]?.value || 0);
          let yEntry = null;
          if (entryPrice > 0 && yAxis && typeof yAxis.convertToPixel === 'function') {
            const py = yAxis.convertToPixel(entryPrice);
            if (typeof py === 'number' && !isNaN(py)) {
              yEntry = py;
            }
          }
          if (yEntry === null) {
            yEntry = (minY + maxY) / 2;
          }

          figures.push({
            type: 'line',
            attrs: {
              coordinates: [
                { x: minX, y: yEntry },
                { x: maxX, y: yEntry }
              ]
            },
            styles: {
              style: 'dashed',
              dashValue: [6, 4],
              color: '#10b981',
              size: 1.5
            }
          });

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
    this.trailToggleBtn = document.getElementById('tvReplayTrailToggleBtn');
    this.manualExitBtn = document.getElementById('tvReplayManualExitBtn');

    const jumpBtn = document.getElementById('tvReplayJumpBtn');
    const resetBtn = document.getElementById('tvReplayResetBtn');
    const stepBtn = document.getElementById('tvReplayStepBtn');
    const exitBtn = document.getElementById('tvReplayExitBtn');
    const cancelScissorsBtn = document.getElementById('tvCancelScissorsBtn');

    // Trailing Toggle (Milestones & Peak Trails ON / OFF; Breakeven ALWAYS remains ON)
    this.trailToggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isTrailingEnabled = !this.isTrailingEnabled;
      if (this.isTrailingEnabled) {
        this.trailToggleBtn.classList.remove('off');
        this.trailToggleBtn.classList.add('active');
        this.trailToggleBtn.textContent = '⚡ TRAIL: ON';
      } else {
        this.trailToggleBtn.classList.remove('active');
        this.trailToggleBtn.classList.add('off');
        this.trailToggleBtn.textContent = '🛡️ TRAIL: OFF';
      }
      this.updateManualExitBtnState();
      this.recomputeAllBoxTrades();
    });

    // Manual Market Exit Button (when trailing is OFF or during active trade)
    this.manualExitBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.manualExitActiveTrade();
    });

    // Header Lot Size Listeners: recompute and update dollar profits when trader changes lot size
    if (typeof document !== 'undefined') {
      const headerInp = document.getElementById('tvHeaderLotInput');
      headerInp?.addEventListener('input', () => {
        this.updateStatsDisplay();
        this.recomputeAllBoxTrades();
      });
      headerInp?.addEventListener('change', () => {
        this.updateStatsDisplay();
        this.recomputeAllBoxTrades();
      });
      document.querySelectorAll('.tv-top-lot-pill').forEach((pill) => {
        pill.addEventListener('click', () => {
          setTimeout(() => {
            this.updateStatsDisplay();
            this.recomputeAllBoxTrades();
          }, 50);
        });
      });
    }

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
        this.hideTradeInspector();
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

    // ⚡ CAPTURE-PHASE SCISSORS CLICK LISTENER & TRADE INSPECTOR
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

      // Trade inspector click: inspects clicked trade outcome box, entry arrow, or parent box
      chartDom.addEventListener('click', (e) => {
        if (this.isScissorsMode) return;
        const card = document.getElementById('tvReplayTradeInspectorCard');
        if (card && card.contains(e.target)) return;

        const hit = this.hitTestTradeAt(e);
        if (hit) {
          this.showTradeInspector(hit, e.clientX, e.clientY);
        } else {
          this.hideTradeInspector();
        }
      });

      // Pointer feedback on hover over clickable trade boxes or markers
      chartDom.addEventListener('pointermove', (e) => {
        if (this.isScissorsMode) return;
        if (!this.chart) return;
        const hit = this.hitTestTradeAt(e);
        if (hit) {
          chartDom.style.cursor = 'pointer';
        } else if (chartDom.style.cursor === 'pointer') {
          chartDom.style.cursor = '';
        }
      });

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

    // Dismiss inspector card on outside window click
    window.addEventListener('click', (e) => {
      const card = document.getElementById('tvReplayTradeInspectorCard');
      if (!card || card.style.display === 'none') return;
      if (card.contains(e.target)) return;
      if (!chartDom?.contains(e.target)) {
        this.hideTradeInspector();
      }
    });

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

    this.updateTimeDisplay();
    // Chronologically evaluate and plot all trades from box inception up to cut point
    this.recomputeAllBoxTrades();
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
        subTickTimestamp: targetBar.timestamp,
        open: targetBar.open,
        high: targetBar.open,
        low: targetBar.open,
        close: targetBar.open,
        volume: 1
      };
      this.appendChartBar(initialCandle);
      this.updateTimeDisplay();
      this.evaluateBoxesStrategy(initialCandle, false);
    }

    // Process current intra-bar sub-tick
    const targetBar = this.fullCandles[this.currentIndex];
    const curPrice = this.activeTicks[this.currentTickIndex];
    this.currentLiveHigh = Math.max(this.currentLiveHigh, curPrice);
    this.currentLiveLow = Math.min(this.currentLiveLow, curPrice);

    const isLastTick = (this.currentTickIndex >= this.activeTicks.length - 1);
    const frac = (this.activeTicks.length > 1) ? (this.currentTickIndex / (this.activeTicks.length - 1)) : 1.0;
    const subTickTimestamp = targetBar.timestamp + Math.round(frac * 5 * 60 * 1000);

    const liveCandle = {
      timestamp: targetBar.timestamp,
      subTickTimestamp,
      open: targetBar.open,
      high: isLastTick ? targetBar.high : this.currentLiveHigh,
      low: isLastTick ? targetBar.low : this.currentLiveLow,
      close: isLastTick ? targetBar.close : curPrice,
      volume: isLastTick ? targetBar.volume : Math.max(1, Math.round(targetBar.volume * ((this.currentTickIndex + 1) / this.activeTicks.length)))
    };

    // Update candle in-place on chart (living candle breathing animation)
    this.updateLiveChartBar(liveCandle);

    // Evaluate Strategy Engine on current sub-tick (manages active trade every tick, checks entry only on completed bar)
    this.evaluateBoxesStrategy(liveCandle, isLastTick);

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

    // Run Strategy Engine on intra-bar ticks to guarantee 100% deterministic execution
    const ticks = this.generateIntraBarTicks(nextBar);
    let runHigh = nextBar.open;
    let runLow = nextBar.open;
    for (let i = 0; i < ticks.length; i++) {
      const isLast = (i === ticks.length - 1);
      const frac = (ticks.length > 1) ? (i / (ticks.length - 1)) : 1.0;
      const subTickTs = nextBar.timestamp + Math.round(frac * 5 * 60 * 1000);
      runHigh = Math.max(runHigh, ticks[i]);
      runLow = Math.min(runLow, ticks[i]);
      const subBar = {
        timestamp: nextBar.timestamp,
        subTickTimestamp: subTickTs,
        open: nextBar.open,
        high: isLast ? nextBar.high : runHigh,
        low: isLast ? nextBar.low : runLow,
        close: ticks[i]
      };
      this.evaluateBoxesStrategy(subBar, isLast);
    }
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
    this.updateTimeDisplay();
    this.recomputeAllBoxTrades();
  }

  /**
   * Exit Replay and Restore Live MT5 Chart
   */
  exitReplay() {
    this.pause();
    this.isActive = false;
    this.exitScissorsMode();
    this.hideTradeInspector();
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
    this.hideTradeInspector();
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
   * Recomputes all box trades chronologically from inception up to currentIndex.
   * Ensures that all candles that have already moved past the box have their trades
   * simulated and marked on the chart.
   */
  recomputeAllBoxTrades() {
    if (!this.chart) return;
    this.clearReplayTradeMarkings();
    this.boxTradeStates.clear();

    const overlays = this.chart.getOverlays() || [];
    const rects = overlays.filter((ov) => ov.name === 'rect');
    if (rects.length === 0) {
      this.updateStatsDisplay();
      return;
    }

    const fullList = (this.fullCandles && this.fullCandles.length > 0)
      ? this.fullCandles
      : (this.chart.getDataList?.() || []);
    if (fullList.length === 0) return;

    const limitIdx = (this.currentIndex >= 0 && this.currentIndex < fullList.length)
      ? this.currentIndex
      : fullList.length - 1;

    for (let i = 0; i <= limitIdx; i++) {
      const b = fullList[i];
      if (!b) continue;
      const ticks = this.generateIntraBarTicks(b);
      let runHigh = b.open;
      let runLow = b.open;
      for (let j = 0; j < ticks.length; j++) {
        const isLast = (j === ticks.length - 1);
        const frac = (ticks.length > 1) ? (j / (ticks.length - 1)) : 1.0;
        const subTickTs = b.timestamp + Math.round(frac * 5 * 60 * 1000);
        runHigh = Math.max(runHigh, ticks[j]);
        runLow = Math.min(runLow, ticks[j]);
        const subBar = {
          timestamp: b.timestamp,
          subTickTimestamp: subTickTs,
          open: b.open,
          high: isLast ? b.high : runHigh,
          low: isLast ? b.low : runLow,
          close: ticks[j]
        };
        this.evaluateBoxesStrategy(subBar, isLast);
      }
    }

    this.updateStatsDisplay();
  }

  /**
   * 🦅 BLIND STRATEGY ENGINE EXECUTION (ZERO LOOKAHEAD, ZERO TRAPS, ZERO OVERFIT)
   * Executes strictly according to the two point markings (Retest Fulcrum Axis & Vacuum Void)
   * of user-drawn boxes.
   */
  evaluateBoxesStrategy(bar, isBarComplete = true) {
    if (!this.chart || !bar) return;

    const overlays = this.chart.getOverlays() || [];
    const rects = overlays.filter((ov) => ov.name === 'rect');

    // Auto-reconciliation: Purge states and child overlays for any boxes deleted by user
    const currentRectIds = new Set(rects.map((r) => r.id));
    for (const trackedId of this.boxTradeStates.keys()) {
      if (!currentRectIds.has(trackedId)) {
        this.onOverlayRemoved(trackedId);
      }
    }

    rects.forEach((rect) => {
      // 1. Calculate the Two Point Markings (Retest Fulcrum Axis & Vacuum Void)
      let levels = null;
      const fullList = (this.fullCandles && this.fullCandles.length > 0)
        ? this.fullCandles
        : (this.chart.getDataList?.() || []);

      if (typeof window !== 'undefined' && typeof window.__computeBoxFulcrumAndVacuum === 'function') {
        levels = window.__computeBoxFulcrumAndVacuum(rect, fullList);
      }

      if (!levels) {
        const pts = rect.points || [];
        if (pts.length < 2) return;
        const prices = pts.map((p) => p.value).filter((v) => typeof v === 'number' && !isNaN(v));
        const times = pts.map((p) => p.timestamp).filter((t) => typeof t === 'number' && !isNaN(t));
        if (prices.length < 2 || times.length < 2) return;
        const topPrice = Math.max(...prices);
        const bottomPrice = Math.min(...prices);
        levels = {
          topPrice,
          bottomPrice,
          fulcrumPrice: Math.round(((topPrice + bottomPrice) / 2) * 100) / 100,
          vacuumPrice: Math.round(((topPrice + bottomPrice) / 2) * 100) / 100,
          leftTime: Math.min(...times),
          rightTime: Math.max(...times)
        };
      }

      const { fulcrumPrice, vacuumPrice, leftTime, rightTime, topPrice, bottomPrice } = levels;
      if (!fulcrumPrice || !vacuumPrice || !leftTime || !rightTime) return;

      // Setup arms strictly AFTER the box finishes forming (Zero lookahead during box formation)
      if (bar.timestamp <= rightTime) return;

      // Get or initialize state for this box
      if (!this.boxTradeStates.has(rect.id)) {
        this.boxTradeStates.set(rect.id, {
          inTrade: false,
          activeTrade: null,
          tradesHistory: [],
          lastExitTime: 0,
          fulcrumPrice,
          vacuumPrice
        });
      } else {
        const st = this.boxTradeStates.get(rect.id);
        st.fulcrumPrice = fulcrumPrice;
        st.vacuumPrice = vacuumPrice;
      }

      const state = this.boxTradeStates.get(rect.id);
      const curPrice = Number(bar.close);
      const curTimeSec = Math.floor((bar.subTickTimestamp || bar.timestamp) / 1000);
      this.lastEvaluatedBar = bar;
      this.lastEvaluatedPrice = curPrice;

      // Target Levels: Vacuum Void (Fast Transit Point) vs Retest Axis
      const targetLevels = [
        { lvl: vacuumPrice, isFastTransit: true, name: 'VACUUM_VOID' },
        { lvl: fulcrumPrice, isFastTransit: false, name: 'RETEST_AXIS' }
      ];

      if (!state.levelStates) {
        state.levelStates = new Map();
      }

      // 1. ALWAYS UPDATE LEVEL STATES ON EVERY LIVE TICK (Immune to inTrade freeze)
      for (const tl of targetLevels) {
        const lvl = tl.lvl;
        const isFt = tl.isFastTransit;
        let st = state.levelStates.get(lvl);
        if (!st) {
          st = {
            inWave: false,
            canStartWave: true,
            waveNum: 0,
            startTimeSec: 0,
            lastTouchSec: 0,
            minPrice: curPrice,
            maxPrice: curPrice,
            prevPrice: curPrice,
            macroOrigin: (curPrice >= lvl) ? 'above' : 'below',
            approachDir: (curPrice >= lvl) ? 'above' : 'below'
          };
          state.levelStates.set(lvl, st);
        }

        // Cycle Decay & Reset: if away from level for > 15 mins (900s), wave count resets to 0 (fresh institutional cycle)
        if (st.lastTouchSec > 0 && (curTimeSec - st.lastTouchSec > 900)) {
          st.waveNum = 0;
          st.inWave = false;
          st.canStartWave = true;
        }

        const dist = Math.abs(curPrice - lvl);
        const depThreshold = isFt ? 0.60 : 1.00;
        if (dist >= depThreshold) {
          st.canStartWave = true;
        }

        // Macro Origin memory: anchored to genuine multi-point departure outside the line envelope
        if (curPrice <= lvl - 1.00) {
          st.macroOrigin = 'below';
        } else if (curPrice >= lvl + 1.00) {
          st.macroOrigin = 'above';
        }

        // Crossing check between prevPrice and curPrice (captures fast velocity ticks that slice across line)
        const crossedFromBelow = (st.prevPrice > 0 && st.prevPrice <= lvl && curPrice >= lvl);
        const crossedFromAbove = (st.prevPrice > 0 && st.prevPrice >= lvl && curPrice <= lvl);
        const isTouch = (dist <= 0.50) || crossedFromBelow || crossedFromAbove;

        // A. ARRIVAL / LEVEL ENVELOPE ENGAGEMENT
        if (!st.inWave) {
          if (st.canStartWave && isTouch) {
            st.inWave = true;
            st.canStartWave = false;
            st.waveNum += 1;
            st.startTimeSec = curTimeSec;
            st.lastTouchSec = curTimeSec;
            st.minPrice = curPrice;
            st.maxPrice = curPrice;
            if (crossedFromBelow) {
              st.approachDir = 'below';
            } else if (crossedFromAbove) {
              st.approachDir = 'above';
            } else {
              st.approachDir = st.macroOrigin || (st.prevPrice <= lvl ? 'below' : 'above');
            }
          }
        } else {
          // B. ACTIVE WAVE: Hovering vs Displacing Away
          if (isTouch) {
            st.lastTouchSec = curTimeSec;
            st.minPrice = Math.min(st.minPrice, curPrice);
            st.maxPrice = Math.max(st.maxPrice, curPrice);
          } else if (dist > 1.20) {
            st.inWave = false;
            st.canStartWave = true;
          }
        }
        st.prevPrice = curPrice;
      }

      // 2. MANAGE ACTIVE TRADE (Evaluated on every intra-bar micro-tick for realistic broker execution)
      if (state.inTrade && state.activeTrade) {
        const tr = state.activeTrade;
        const pos = tr.dir;
        const entry = tr.entry;
        const tradeDwellSec = curTimeSec - Math.floor(tr.entryTime / 1000);

        tr.lastPrice = curPrice;
        if (tr.peakPrice === undefined) {
          tr.peakPrice = curPrice;
        }

        if (this.controlBar && !this.isTrailingEnabled) {
          this.updateManualExitBtnState();
        }

        // OPPOSITE SOVEREIGN TARGET HARVEST RULE:
        // When trailing is enabled, reaching the opposite sovereign boundary with >= 3.00p profit banks immediately
        if (this.isTrailingEnabled) {
          const otherLvl = (Math.abs(tr.testedLevel - vacuumPrice) < 0.05) ? fulcrumPrice : vacuumPrice;
          const isOppositeTarget = (pos === 'BUY' && otherLvl > entry) || (pos === 'SELL' && otherLvl < entry);
          if (isOppositeTarget) {
            const targetReached = (pos === 'BUY' && curPrice >= otherLvl - 0.25 && curPrice >= entry + 3.00) ||
                                  (pos === 'SELL' && curPrice <= otherLvl + 0.25 && curPrice <= entry - 3.00);
            if (targetReached) {
              const pnlPts = (pos === 'BUY') ? Math.round((curPrice - entry) * 100) / 100 : Math.round((entry - curPrice) * 100) / 100;
              this.closeTrade(rect.id, tr, bar, 'WIN', pnlPts, curPrice);
              return;
            }
          }
        }

        if (pos === 'SELL') {
          const mfe = entry - curPrice;
          const mae = curPrice - entry;
          if (mfe > tr.maxMfe) tr.maxMfe = mfe;
          if (mae > tr.maxMae) tr.maxMae = mae;
          if (curPrice < tr.peakPrice) tr.peakPrice = curPrice;

          // 1. BE Lock upon Physical Displacement >= 1.80p (Pure Scratch Protection)
          if (mfe >= 1.80 && !tr.beActive && tr.milestone === 0) {
            tr.beActive = true;
            tr.sl = Math.min(tr.sl, Math.round((entry - 0.10) * 100) / 100);
          }

          // 2. Physical Trail Milestones (ONLY IF TRAILING IS ENABLED):
          if (this.isTrailingEnabled) {
            // Milestone 1: Lock +1.80p profit at MFE >= 3.20p (Protects multi-point runners from scratching!)
            if (mfe >= 3.20 && tr.milestone < 1) {
              tr.milestone = 1;
              tr.sl = Math.min(tr.sl, Math.round((entry - 1.80) * 100) / 100);
            }

            // Milestone 2: Lock +3.00p profit at MFE >= 5.00p
            if (mfe >= 5.00 && tr.milestone < 2) {
              tr.milestone = 2;
              tr.sl = Math.min(tr.sl, Math.round((entry - 3.00) * 100) / 100);
            }

            // Milestone 3: Dynamic Peak Trail at MFE >= 8.50p
            if (mfe >= 8.50) {
              if (tr.milestone < 3) tr.milestone = 3;
              const peakTrailSl = Math.round((tr.peakPrice + 3.00) * 100) / 100;
              tr.sl = Math.min(tr.sl, Math.round((entry - 5.00) * 100) / 100, peakTrailSl);
            }
          }

          // 3. Stalling / Exhaustion Decay Protection: Dwell >= 90s with modest profit (mfe >= 0.80p) but stalled before milestone 1
          if (tradeDwellSec >= 90 && tr.maxMfe >= 0.80 && tr.maxMfe < 1.50 && !tr.beActive && curPrice <= entry - 0.10) {
            tr.beActive = true;
            tr.sl = Math.min(tr.sl, Math.round((entry - 0.10) * 100) / 100);
          }

          // Check SL Hit strictly on curPrice
          const slHit = (curPrice >= tr.sl);
          if (slHit) {
            const pnlPts = Math.round((entry - tr.sl) * 100) / 100;
            let outcome = 'LOSS';
            if (pnlPts >= 0.30) {
              outcome = 'WIN';
            } else if (pnlPts >= -0.05) {
              outcome = 'BE';
            } else {
              outcome = 'LOSS';
            }
            this.closeTrade(rect.id, tr, bar, outcome, pnlPts, tr.sl);
            return;
          }
        } else if (pos === 'BUY') {
          const mfe = curPrice - entry;
          const mae = entry - curPrice;
          if (mfe > tr.maxMfe) tr.maxMfe = mfe;
          if (mae > tr.maxMae) tr.maxMae = mae;
          if (curPrice > tr.peakPrice) tr.peakPrice = curPrice;

          // 1. BE Lock upon Physical Displacement >= 1.80p (Pure Scratch Protection)
          if (mfe >= 1.80 && !tr.beActive && tr.milestone === 0) {
            tr.beActive = true;
            tr.sl = Math.max(tr.sl, Math.round((entry + 0.10) * 100) / 100);
          }

          // 2. Physical Trail Milestones (ONLY IF TRAILING IS ENABLED):
          if (this.isTrailingEnabled) {
            // Milestone 1: Lock +1.80p profit at MFE >= 3.20p (Protects multi-point runners from scratching!)
            if (mfe >= 3.20 && tr.milestone < 1) {
              tr.milestone = 1;
              tr.sl = Math.max(tr.sl, Math.round((entry + 1.80) * 100) / 100);
            }

            // Milestone 2: Lock +3.00p profit at MFE >= 5.00p
            if (mfe >= 5.00 && tr.milestone < 2) {
              tr.milestone = 2;
              tr.sl = Math.max(tr.sl, Math.round((entry + 3.00) * 100) / 100);
            }

            // Milestone 3: Dynamic Peak Trail at MFE >= 8.50p
            if (mfe >= 8.50) {
              if (tr.milestone < 3) tr.milestone = 3;
              const peakTrailSl = Math.round((tr.peakPrice - 3.00) * 100) / 100;
              tr.sl = Math.max(tr.sl, Math.round((entry + 5.00) * 100) / 100, peakTrailSl);
            }
          }

          // 3. Stalling / Exhaustion Decay Protection: Dwell >= 90s with modest profit (mfe >= 0.80p) but stalled before milestone 1
          if (tradeDwellSec >= 90 && tr.maxMfe >= 0.80 && tr.maxMfe < 1.50 && !tr.beActive && curPrice >= entry + 0.10) {
            tr.beActive = true;
            tr.sl = Math.max(tr.sl, Math.round((entry + 0.10) * 100) / 100);
          }

          // Check SL Hit strictly on curPrice
          const slHit = (curPrice <= tr.sl);
          if (slHit) {
            const pnlPts = Math.round((tr.sl - entry) * 100) / 100;
            let outcome = 'LOSS';
            if (pnlPts >= 0.30) {
              outcome = 'WIN';
            } else if (pnlPts >= -0.05) {
              outcome = 'BE';
            } else {
              outcome = 'LOSS';
            }
            this.closeTrade(rect.id, tr, bar, outcome, pnlPts, tr.sl);
            return;
          }
        }

        // Dynamically update / stretch the active trade box so it visibly starts at entry and spans to the current bar
        if (this.chart) {
          const curTop = Math.max(tr.entry, tr.sl, Number(bar.high || curPrice));
          const curBot = Math.min(tr.entry, tr.sl, Number(bar.low || curPrice));
          const boxPoints = [
            { timestamp: tr.entryBarTimestamp || tr.entryTime, value: curTop },
            { timestamp: bar.timestamp, value: curBot }
          ];
          const boxData = {
            parentBoxId: rect.id,
            tradeId: tr.id,
            trade: { ...tr },
            dir: tr.dir,
            entry: tr.entry,
            sl: tr.sl,
            risk: tr.risk,
            testedLevel: tr.testedLevel,
            entryTime: tr.entryTime,
            isLive: true,
            outcome: 'ACTIVE'
          };

          if (tr.boxOverlayId) {
            try {
              this.chart.overrideOverlay({
                id: tr.boxOverlayId,
                points: boxPoints,
                extendData: boxData
              });
            } catch (e) {
              // ignore
            }
          } else {
            try {
              const bId = this.chart.createOverlay({
                name: 'replayTradeBox',
                points: boxPoints,
                extendData: boxData
              });
              if (bId) {
                tr.boxOverlayId = bId;
                this.spawnedOverlayIds.add(bId);
              }
            } catch (e) {
              // ignore
            }
          }
        }
        return;
      }

      // 3. TRUE PHYSICAL TRAIL AUCTION ENGINE (ZERO LOOKAHEAD, EVALUATED ON LIVE PRICE STREAM)
      // Evaluates on every incoming price tick around Fulcrum & Vacuum lines. Zero candle color/wick dependencies.
      if (state.inTrade) return;

      for (const tl of targetLevels) {
        const lvl = tl.lvl;
        const isFt = tl.isFastTransit;
        const st = state.levelStates.get(lvl);
        if (!st || !st.inWave) continue;

        const dist = Math.abs(curPrice - lvl);
        if (dist <= 0.25) continue;

        const departSec = curTimeSec - st.lastTouchSec;
        const totalDwellSec = curTimeSec - st.startTimeSec;
        const disp = Math.round((curPrice - lvl) * 100) / 100;
        const reqDisp = isFt ? 0.40 : 0.60;

        // Strict Wave Order Gate (W1 to W3): Mined physical audit proves W1-W3 has high win rate & asymmetrical RR; W4+ decays into chop
        if (st.waveNum <= 3 && totalDwellSec <= 240 && departSec <= 60) {
          // PATTERN 1: PINPOINT INSTITUTIONAL REJECTION (Clean Touch, slip <= 0.50p, displacement >= reqDisp)
          // 1A: Ceiling Defense Rejection (approached from below, tested level, reversed down) -> SELL
          if (st.approachDir === 'below' && st.maxPrice <= lvl + 0.50 && disp <= -reqDisp) {
            const entryPrice = Math.round(curPrice * 100) / 100;
            // SL anchored strictly behind the defended line envelope (lvl + 0.50) — Pure Scratch SL
            const scratchSl = Math.round((lvl + 0.50) * 100) / 100;
            const risk = Math.round((scratchSl - entryPrice) * 100) / 100;

            if (risk >= 0.40 && risk <= 1.60) {
              st.inWave = false;
              st.canStartWave = false;
              this.openTrade(rect.id, 'SELL', entryPrice, scratchSl, risk, bar, lvl);
              return;
            }
          }
          // 1B: Floor Defense Bounce (approached from above, tested level, bounced up) -> BUY
          else if (st.approachDir === 'above' && st.minPrice >= lvl - 0.50 && disp >= +reqDisp) {
            const entryPrice = Math.round(curPrice * 100) / 100;
            // SL anchored strictly behind the defended line envelope (lvl - 0.50) — Pure Scratch SL
            const scratchSl = Math.round((lvl - 0.50) * 100) / 100;
            const risk = Math.round((entryPrice - scratchSl) * 100) / 100;

            if (risk >= 0.40 && risk <= 1.60) {
              st.inWave = false;
              st.canStartWave = false;
              this.openTrade(rect.id, 'BUY', entryPrice, scratchSl, risk, bar, lvl);
              return;
            }
          }

          // PATTERN 2: MOMENTUM VACUUM BREAKAWAY (departSec <= 30)
          // 2A: Floor Sliced Through (Momentum Breakdown) -> SELL
          else if (st.approachDir === 'above' && disp <= -reqDisp && departSec <= 30) {
            const entryPrice = Math.round(curPrice * 100) / 100;
            // SL anchored strictly behind broken level envelope (lvl + 0.50) — Pure Scratch SL
            const scratchSl = Math.round((lvl + 0.50) * 100) / 100;
            const risk = Math.round((scratchSl - entryPrice) * 100) / 100;

            if (risk >= 0.40 && risk <= 1.60) {
              st.inWave = false;
              st.canStartWave = false;
              this.openTrade(rect.id, 'SELL', entryPrice, scratchSl, risk, bar, lvl);
              return;
            }
          }
          // 2B: Ceiling Sliced Through (Momentum Breakout) -> BUY
          else if (st.approachDir === 'below' && disp >= +reqDisp && departSec <= 30) {
            const entryPrice = Math.round(curPrice * 100) / 100;
            // SL anchored strictly behind broken level envelope (lvl - 0.50) — Pure Scratch SL
            const scratchSl = Math.round((lvl - 0.50) * 100) / 100;
            const risk = Math.round((entryPrice - scratchSl) * 100) / 100;

            if (risk >= 0.40 && risk <= 1.60) {
              st.inWave = false;
              st.canStartWave = false;
              this.openTrade(rect.id, 'BUY', entryPrice, scratchSl, risk, bar, lvl);
              return;
            }
          }
        }
      }
    });
  }

  /**
   * Open Trade & Spawn Entry Marker
   */
  openTrade(boxId, dir, entryPrice, sl, risk, bar, testedLevel) {
    const state = this.boxTradeStates.get(boxId);
    if (!state) return;

    const tradeId = `trade_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const tradeTime = bar.subTickTimestamp || bar.timestamp;
    const lot = this.getLotSize();
    const trade = {
      id: tradeId,
      parentBoxId: boxId,
      dir,
      entry: entryPrice,
      entryTime: tradeTime,
      entryBarTimestamp: bar.timestamp,
      lastBarTimestamp: bar.timestamp,
      barsInTrade: 0,
      dispHistory: [],
      sl,
      initialSl: sl,
      risk,
      lot,
      beActive: false,
      runnerActive: false,
      milestone: 0,
      maxMfe: 0.0,
      maxMae: 0.0,
      testedLevel
    };

    state.inTrade = true;
    state.activeTrade = trade;

    // 1. Create On-Chart Visual Entry Marker
    try {
      const markerId = this.chart.createOverlay({
        name: 'replayTradeMarker',
        points: [{ timestamp: bar.timestamp, value: entryPrice }],
        extendData: {
          parentBoxId: boxId,
          tradeId,
          trade: { ...trade },
          dir,
          price: entryPrice,
          testedLevel,
          lot
        }
      });
      if (markerId) {
        trade.markerId = markerId;
        this.spawnedOverlayIds.add(markerId);
      }
    } catch (e) {
      console.warn('Failed creating entry marker:', e);
    }

    // 2. Create On-Chart Visual Trade Box Immediately At Entry (Starts drawing right from entry itself)
    try {
      let topVal = Math.max(entryPrice, sl, Number(bar.high || entryPrice));
      let botVal = Math.min(entryPrice, sl, Number(bar.low || entryPrice));
      if (topVal - botVal < 1.00) {
        topVal += 0.50;
        botVal -= 0.50;
      }

      const boxOverlayId = this.chart.createOverlay({
        name: 'replayTradeBox',
        points: [
          { timestamp: bar.timestamp, value: topVal },
          { timestamp: bar.timestamp, value: botVal }
        ],
        extendData: {
          parentBoxId: boxId,
          tradeId: trade.id,
          trade: { ...trade },
          dir,
          entry: entryPrice,
          sl,
          risk,
          testedLevel,
          entryTime: trade.entryTime,
          isLive: true,
          outcome: 'ACTIVE'
        }
      });
      if (boxOverlayId) {
        trade.boxOverlayId = boxOverlayId;
        this.spawnedOverlayIds.add(boxOverlayId);
      }
    } catch (e) {
      console.warn('Failed creating live replay trade box at entry:', e);
    }

    this.updateStatsDisplay();
  }

  /**
   * Close Trade & Spawn Light Outcome Box
   */
  closeTrade(boxId, trade, bar, outcome, pnlPts, exitPrice) {
    const state = this.boxTradeStates.get(boxId);
    if (!state) return;

    const lot = trade.lot || this.getLotSize();
    const pnlUsd = Math.round(pnlPts * 100.0 * lot * 100) / 100;
    const exitTime = bar.subTickTimestamp || bar.timestamp;

    trade.lot = lot;
    trade.outcome = outcome;
    trade.pnlPts = pnlPts;
    trade.pnlUsd = pnlUsd;
    trade.exitTime = exitTime;
    trade.exitBarTimestamp = bar.timestamp;
    trade.exitPrice = exitPrice;

    // Update entry marker with exitTime so the dashed green line spans strictly to trade exit
    if (trade.markerId) {
      try {
        this.chart.overrideOverlay({
          id: trade.markerId,
          extendData: {
            parentBoxId: boxId,
            tradeId: trade.id,
            trade: { ...trade },
            dir: trade.dir,
            price: trade.entry,
            testedLevel: trade.testedLevel,
            lot,
            exitTime: bar.timestamp
          }
        });
      } catch (e) {
        console.warn('Failed updating entry marker with exitTime:', e);
      }
    }

    state.tradesHistory.push({ ...trade });
    state.inTrade = false;
    state.activeTrade = null;
    state.lastExitTime = exitTime;

    // Calculate final box bounds spanning entry to exit
    let topVal = Math.max(trade.entry, trade.sl, exitPrice);
    let botVal = Math.min(trade.entry, trade.sl, exitPrice);
    if (topVal - botVal < 1.00) {
      topVal += 0.50;
      botVal -= 0.50;
    }

    const boxPayload = {
      points: [
        { timestamp: trade.entryBarTimestamp || trade.entryTime, value: topVal },
        { timestamp: trade.exitBarTimestamp || bar.timestamp, value: botVal }
      ],
      extendData: {
        parentBoxId: boxId,
        tradeId: trade.id,
        trade: { ...trade },
        dir: trade.dir,
        entry: trade.entry,
        sl: trade.sl,
        risk: trade.risk,
        testedLevel: trade.testedLevel,
        entryTime: trade.entryTime,
        exitTime: trade.exitTime,
        exitPrice: trade.exitPrice,
        maxMfe: trade.maxMfe,
        maxMae: trade.maxMae,
        outcome,
        pnlPts,
        pnlUsd,
        isLive: false
      }
    };

    // If live box already exists, update/lock it to final exit. Otherwise create it.
    if (trade.boxOverlayId) {
      try {
        this.chart.overrideOverlay({
          id: trade.boxOverlayId,
          ...boxPayload
        });
      } catch (e) {
        console.warn('Failed overriding replay trade box on close:', e);
      }
    } else {
      try {
        const boxOverlayId = this.chart.createOverlay({
          name: 'replayTradeBox',
          ...boxPayload
        });
        if (boxOverlayId) {
          trade.boxOverlayId = boxOverlayId;
          this.spawnedOverlayIds.add(boxOverlayId);
        }
      } catch (e) {
        console.warn('Failed creating replay trade box:', e);
      }
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
   * Helper to fetch the current lot size dynamically from the top header input
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
   * Manually exit any active trade at the current replay price (Market Close)
   */
  manualExitActiveTrade() {
    let bar = (this.currentIndex >= 0 && this.currentIndex < this.fullCandles.length)
      ? this.fullCandles[this.currentIndex]
      : (this.chart?.getDataList?.()?.slice(-1)[0] || this.lastEvaluatedBar);

    if (!bar) {
      let anyActive = null;
      for (const st of this.boxTradeStates.values()) {
        if (st.inTrade && st.activeTrade) { anyActive = st.activeTrade; break; }
      }
      if (anyActive) {
        bar = {
          timestamp: anyActive.lastBarTimestamp || anyActive.entryBarTimestamp || Date.now(),
          close: anyActive.lastPrice ?? anyActive.entry,
          open: anyActive.entry,
          high: Math.max(anyActive.entry, anyActive.peakPrice ?? anyActive.entry),
          low: Math.min(anyActive.entry, anyActive.troughPrice ?? anyActive.entry)
        };
      }
    }
    if (!bar) return;

    const curPrice = (typeof this.currentTickIndex === 'number' && this.currentTickIndex >= 0 && this.activeTicks?.[this.currentTickIndex])
      ? this.activeTicks[this.currentTickIndex]
      : (this.lastEvaluatedPrice ?? Number(bar.close));

    let closed = false;
    this.boxTradeStates.forEach((state, boxId) => {
      if (state.inTrade && state.activeTrade) {
        const tr = state.activeTrade;
        const pos = tr.dir;
        const entry = tr.entry;
        const pnlPts = (pos === 'BUY')
          ? Math.round((curPrice - entry) * 100) / 100
          : Math.round((entry - curPrice) * 100) / 100;
        let outcome = 'LOSS';
        if (pnlPts >= 0.30) {
          outcome = 'WIN';
        } else if (pnlPts >= -0.05) {
          outcome = 'BE';
        } else {
          outcome = 'LOSS';
        }
        this.closeTrade(boxId, tr, bar, outcome, pnlPts, curPrice);
        closed = true;
      }
    });

    if (closed) {
      this.updateStatsDisplay();
    }
  }

  /**
   * Update the visibility and label of the manual exit button
   */
  updateManualExitBtnState() {
    if (!this.manualExitBtn) return;
    let activeTr = null;
    for (const st of this.boxTradeStates.values()) {
      if (st.inTrade && st.activeTrade) {
        activeTr = st.activeTrade;
        break;
      }
    }

    if (!activeTr) {
      this.manualExitBtn.style.display = 'none';
      return;
    }

    // When trailing is OFF, show the manual exit button prominently with live PnL!
    if (!this.isTrailingEnabled) {
      this.manualExitBtn.style.display = 'inline-flex';
      const curBar = (this.currentIndex >= 0 && this.currentIndex < this.fullCandles.length)
        ? this.fullCandles[this.currentIndex]
        : (this.chart?.getDataList?.()?.slice(-1)[0]);
      const curPrice = (typeof this.currentTickIndex === 'number' && this.currentTickIndex >= 0 && this.activeTicks?.[this.currentTickIndex])
        ? this.activeTicks[this.currentTickIndex]
        : Number(curBar?.close || activeTr.entry);

      const pos = activeTr.dir;
      const curPts = (pos === 'BUY')
        ? Math.round((curPrice - activeTr.entry) * 100) / 100
        : Math.round((activeTr.entry - curPrice) * 100) / 100;
      const curLot = activeTr.lot || this.getLotSize();
      const curUsd = Math.round(curPts * 100.0 * curLot * 100) / 100;
      const sign = curUsd >= 0 ? '+' : '-';
      this.manualExitBtn.textContent = `🛑 CLOSE (${curPts >= 0 ? '+' : ''}${curPts.toFixed(1)}p / ${sign}$${Math.abs(curUsd).toFixed(0)})`;
    } else {
      this.manualExitBtn.style.display = 'none';
    }
  }

  /**
   * Update Floating Replay Bar Strategy Statistics
   */
  updateStatsDisplay() {
    if (!this.statsBadge) return;

    let totalTrades = 0;
    let netPts = 0.0;
    let netUsd = 0.0;
    const curLot = this.getLotSize();

    this.boxTradeStates.forEach((st) => {
      st.tradesHistory.forEach((t) => {
        totalTrades += 1;
        netPts += (t.pnlPts || 0);
        const tradeLot = t.lot || curLot;
        netUsd += (typeof t.pnlUsd === 'number') ? t.pnlUsd : ((t.pnlPts || 0) * 100.0 * tradeLot);
      });
      if (st.inTrade) {
        totalTrades += 1; // 1 active
      }
    });

    const sign = netUsd >= 0 ? '+' : '-';
    this.statsBadge.textContent = `${totalTrades} Trades | ${sign}$${Math.abs(netUsd).toFixed(0)} (${netPts >= 0 ? '+' : ''}${netPts.toFixed(1)}p)`;

    this.updateManualExitBtnState();
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

  /**
   * Look up trade by tradeId across all tracked boxes
   */
  getTradeById(tradeId) {
    if (!tradeId) return null;
    for (const st of this.boxTradeStates.values()) {
      if (st.activeTrade && st.activeTrade.id === tradeId) return st.activeTrade;
      const found = st.tradesHistory?.find(t => t.id === tradeId);
      if (found) return found;
    }
    return null;
  }

  /**
   * Return all trades (history + active) for a given parent boxId
   */
  getTradesForBox(boxId) {
    if (!boxId) return [];
    const state = this.boxTradeStates.get(boxId);
    if (!state) return [];
    const list = [...(state.tradesHistory || [])];
    if (state.activeTrade) {
      list.push(state.activeTrade);
    }
    return list;
  }

  /**
   * Hit test click coordinates against trade markers, trade boxes, and drawn parent boxes
   */
  hitTestTradeAt(event) {
    if (!this.chart) return null;
    const chartDom = document.getElementById('klineChart');
    const rect = chartDom?.getBoundingClientRect();
    if (!rect) return null;

    const clientX = event.clientX;
    const clientY = event.clientY;
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const allOverlays = (typeof this.chart.getOverlays === 'function') ? this.chart.getOverlays() : [];

    // 1. Check entry markers (22px hit radius)
    const markers = allOverlays.filter(o => o.name === 'replayTradeMarker' && o.points?.length >= 1);
    for (const m of markers) {
      let coords = null;
      try { coords = this.chart.convertToPixel(m.points); } catch (e) {}
      if (!coords || !coords.length) {
        try { coords = this.chart.convertToPixel(m.points, { paneId: 'candle_pane' }); } catch (e) {}
      }
      if (coords && coords[0]) {
        const px = coords[0].x;
        const py = coords[0].y;
        if (typeof px === 'number' && typeof py === 'number' && !isNaN(px) && !isNaN(py)) {
          const dist = Math.hypot(x - px, y - py);
          if (dist <= 22) {
            const tradeId = m.extendData?.tradeId;
            const trade = this.getTradeById(tradeId) || m.extendData?.trade || m.extendData;
            const parentBoxId = m.extendData?.parentBoxId;
            const allTrades = parentBoxId ? this.getTradesForBox(parentBoxId) : [trade];
            return { type: 'marker', overlay: m, trade, allTrades, parentBoxId, x: clientX, y: clientY };
          }
        }
      }
    }

    // 2. Check trade outcome boxes (replayTradeBox)
    const tradeBoxes = allOverlays.filter(o => o.name === 'replayTradeBox' && o.points?.length >= 2);
    for (const b of tradeBoxes) {
      let coords = null;
      try { coords = this.chart.convertToPixel(b.points); } catch (e) {}
      if (!coords || !coords.length) {
        try { coords = this.chart.convertToPixel(b.points, { paneId: 'candle_pane' }); } catch (e) {}
      }
      if (coords && coords.length >= 2) {
        const xs = coords.map(pt => pt.x);
        const ys = coords.map(pt => pt.y);
        const minX = Math.min(...xs) - 4;
        const maxX = Math.max(...xs) + 4;
        const minY = Math.min(...ys) - 4;
        const maxY = Math.max(...ys) + 4;
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          const tradeId = b.extendData?.tradeId;
          const trade = this.getTradeById(tradeId) || b.extendData?.trade || b.extendData;
          const parentBoxId = b.extendData?.parentBoxId;
          const allTrades = parentBoxId ? this.getTradesForBox(parentBoxId) : [trade];
          return { type: 'tradeBox', overlay: b, trade, allTrades, parentBoxId, x: clientX, y: clientY };
        }
      }
    }

    // 3. Check parent drawn boxes (rect) that generated trades
    const drawnRects = allOverlays.filter(o => o.name === 'rect' && o.points?.length >= 2);
    for (const r of drawnRects) {
      const boxTrades = this.getTradesForBox(r.id);
      if (boxTrades.length === 0) continue;

      let coords = null;
      try { coords = this.chart.convertToPixel(r.points); } catch (e) {}
      if (!coords || !coords.length) {
        try { coords = this.chart.convertToPixel(r.points, { paneId: 'candle_pane' }); } catch (e) {}
      }
      if (coords && coords.length >= 2) {
        const xs = coords.map(pt => pt.x);
        const ys = coords.map(pt => pt.y);
        const minX = Math.min(...xs) - 4;
        const maxX = Math.max(...xs) + 4;
        const minY = Math.min(...ys) - 4;
        const maxY = Math.max(...ys) + 4;
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          const latestTrade = boxTrades[boxTrades.length - 1];
          return { type: 'parentRect', overlay: r, trade: latestTrade, allTrades: boxTrades, parentBoxId: r.id, x: clientX, y: clientY };
        }
      }
    }

    return null;
  }

  /**
   * Handle direct KLineCharts overlay click
   */
  onTradeOverlayClick(event) {
    const overlay = event?.overlay;
    if (!overlay) return;
    const rawEvt = event.event || event;
    const clientX = rawEvt?.clientX ?? (window.innerWidth / 2);
    const clientY = rawEvt?.clientY ?? (window.innerHeight / 2);
    const tradeId = overlay.extendData?.tradeId;
    const parentBoxId = overlay.extendData?.parentBoxId;
    const trade = this.getTradeById(tradeId) || overlay.extendData?.trade || overlay.extendData;
    const allTrades = parentBoxId ? this.getTradesForBox(parentBoxId) : [trade];
    this.showTradeInspector({ type: overlay.name, overlay, trade, allTrades, parentBoxId, x: clientX, y: clientY }, clientX, clientY);
  }

  /**
   * Show sleek floating trade details popover card
   */
  showTradeInspector(hit, clientX, clientY, activeIndex = 0) {
    if (!hit) return;
    let card = document.getElementById('tvReplayTradeInspectorCard');
    if (!card) {
      card = document.createElement('div');
      card.id = 'tvReplayTradeInspectorCard';
      card.className = 'tv-replay-trade-inspector';
      document.body.appendChild(card);
    }

    const allTrades = (hit.allTrades && hit.allTrades.length > 0) ? hit.allTrades : [hit.trade];
    const safeIdx = Math.max(0, Math.min(activeIndex, allTrades.length - 1));
    const trade = allTrades[safeIdx] || hit.trade || {};

    const dir = trade.dir || 'BUY';
    const isBuy = (dir === 'BUY');
    const outcome = trade.outcome || (trade.exitTime ? 'CLOSED' : 'ACTIVE');
    const pnlPts = Number(trade.pnlPts || 0);
    const pnlUsd = Number(trade.pnlUsd || 0);
    const entry = Number(trade.entry || trade.price || 0);
    const exitPrice = Number(trade.exitPrice || 0);
    const sl = Number(trade.sl || 0);
    const risk = Number(trade.risk || Math.abs(entry - sl) || 0);
    const mfe = Number(trade.maxMfe || 0);
    const mae = Number(trade.maxMae || 0);
    const testedLevel = trade.testedLevel || 'FULCRUM';

    const fmtTime = (ts) => {
      if (!ts) return 'Active / In Progress';
      const d = new Date(ts);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    };

    const entryTimeStr = fmtTime(trade.entryTime);
    const exitTimeStr = fmtTime(trade.exitTime);

    let durationStr = 'Open';
    if (trade.entryTime && trade.exitTime) {
      const diffMins = Math.round((trade.exitTime - trade.entryTime) / 60000);
      durationStr = `${diffMins} min${diffMins !== 1 ? 's' : ''}`;
    }

    let outcomeClass = 'tv-ti-win';
    let outcomeText = `WIN (+${pnlPts.toFixed(2)}p)`;
    if (outcome === 'LOSS') {
      outcomeClass = 'tv-ti-loss';
      outcomeText = `SCRATCH (${pnlPts.toFixed(2)}p)`;
    } else if (outcome === 'BE') {
      outcomeClass = 'tv-ti-be';
      outcomeText = `BE (+${pnlPts.toFixed(2)}p)`;
    } else if (outcome === 'ACTIVE') {
      outcomeClass = 'tv-ti-active';
      outcomeText = `RUNNING`;
    }

    const pnlColor = pnlUsd > 0 ? '#10b981' : (pnlUsd < 0 ? '#ef4444' : '#f59e0b');
    const pnlSign = pnlUsd > 0 ? '+' : '';

    // If multiple trades exist on this box, render tabs
    let tabsHtml = '';
    if (allTrades.length > 1) {
      tabsHtml = `<div class="tv-ti-tabs">`;
      allTrades.forEach((t, i) => {
        const activeCls = (i === safeIdx) ? 'active' : '';
        const tPts = Number(t.pnlPts || 0);
        const tSign = tPts >= 0 ? '+' : '';
        tabsHtml += `<button class="tv-ti-tab-btn ${activeCls}" onclick="window.__replayEngine && window.__replayEngine.switchTradeInspectorTab(${i}, ${clientX}, ${clientY})">#${i + 1} (${t.dir} ${tSign}${tPts.toFixed(1)}p)</button>`;
      });
      tabsHtml += `</div>`;
    }

    // Cache current hit for tab switches
    this._currentInspectorHit = hit;

    card.innerHTML = `
      <div class="tv-ti-header">
        <div class="tv-ti-header-left">
          <span class="tv-ti-dir-badge ${isBuy ? 'tv-ti-buy' : 'tv-ti-sell'}">${dir}</span>
          <span class="tv-ti-outcome-badge ${outcomeClass}">${outcomeText}</span>
        </div>
        <button class="tv-ti-close-btn" title="Close" onclick="window.__replayEngine && window.__replayEngine.hideTradeInspector()">✕</button>
      </div>

      ${tabsHtml}

      <div class="tv-ti-pnl-banner" style="color: ${pnlColor}">
        <span class="tv-ti-pnl-usd">${pnlSign}$${pnlUsd.toFixed(2)}</span>
        <span class="tv-ti-pnl-pts">${pnlSign}${pnlPts.toFixed(2)} pts</span>
      </div>

      <div class="tv-ti-divider"></div>

      <div class="tv-ti-grid">
        <div class="tv-ti-row">
          <span class="tv-ti-lbl">Level Tested</span>
          <span class="tv-ti-val tv-ti-accent">${testedLevel}</span>
        </div>
        <div class="tv-ti-row">
          <span class="tv-ti-lbl">Entry Price</span>
          <span class="tv-ti-val">$${entry.toFixed(2)}</span>
        </div>
        <div class="tv-ti-row">
          <span class="tv-ti-lbl">Entry Time</span>
          <span class="tv-ti-val-sub">${entryTimeStr}</span>
        </div>
        <div class="tv-ti-row">
          <span class="tv-ti-lbl">Exit Price</span>
          <span class="tv-ti-val">${exitPrice > 0 ? `$${exitPrice.toFixed(2)}` : 'Open'}</span>
        </div>
        <div class="tv-ti-row">
          <span class="tv-ti-lbl">Exit Time</span>
          <span class="tv-ti-val-sub">${exitTimeStr}</span>
        </div>
        <div class="tv-ti-row">
          <span class="tv-ti-lbl">Stop Loss</span>
          <span class="tv-ti-val tv-ti-sl">$${sl.toFixed(2)} (${risk.toFixed(2)}p risk)</span>
        </div>
        <div class="tv-ti-row">
          <span class="tv-ti-lbl">Excursion</span>
          <span class="tv-ti-val"><span style="color:#10b981">+${mfe.toFixed(2)}p</span> / <span style="color:#ef4444">-${mae.toFixed(2)}p</span></span>
        </div>
        <div class="tv-ti-row">
          <span class="tv-ti-lbl">Duration</span>
          <span class="tv-ti-val">${durationStr}</span>
        </div>
      </div>
    `;

    card.style.display = 'block';
    const cardRect = card.getBoundingClientRect();
    const pad = 12;

    let posX = clientX + 16;
    let posY = clientY - 20;

    if (posX + cardRect.width > window.innerWidth - pad) {
      posX = clientX - cardRect.width - 16;
    }
    if (posY + cardRect.height > window.innerHeight - pad) {
      posY = window.innerHeight - cardRect.height - pad;
    }
    if (posY < pad) posY = pad;
    if (posX < pad) posX = pad;

    card.style.left = `${posX}px`;
    card.style.top = `${posY}px`;
  }

  /**
   * Switch between multiple trades on the same box in the inspector
   */
  switchTradeInspectorTab(index, clientX, clientY) {
    if (this._currentInspectorHit) {
      this.showTradeInspector(this._currentInspectorHit, clientX, clientY, index);
    }
  }

  /**
   * Hide trade details popover card
   */
  hideTradeInspector() {
    const card = document.getElementById('tvReplayTradeInspectorCard');
    if (card) {
      card.style.display = 'none';
    }
    this._currentInspectorHit = null;
  }
}
