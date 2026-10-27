/**
 * Escanor — Clicked Candle Order Flow VPOC & Volume Inspector
 * Projects an on-demand single-point VPOC laser line across to the right scale,
 * and renders a high-density Total Volume and Buy/Sell Delta pill pinned next to the price axis.
 */

let chartInstance = null;
let svgElement = null;
let pillElement = null;
let selectedBarTimestamp = null;
let selectedBarData = null;
let isDraggingChart = false;
let rafId = null;
let isInspectorEnabled = true;

/**
 * Initialize the Candle VPOC Inspector
 */
export function initCandleVpocInspector(chart) {
  chartInstance = chart;
  if (!chartInstance) return;

  const viewport = document.querySelector('.tv-chart-viewport') || document.getElementById('klineChart');
  if (!viewport) return;

  // 1. Create or bind SVG Layer
  svgElement = document.getElementById('tvCandleVpocSvg');
  if (!svgElement) {
    svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgElement.id = 'tvCandleVpocSvg';
    svgElement.setAttribute('class', 'tv-candle-vpoc-svg');
    svgElement.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 18; overflow: hidden;';
    viewport.appendChild(svgElement);
  }

  // 2. Create or bind Right Scale Pill
  pillElement = document.getElementById('tvCandleVpocPill');
  if (!pillElement) {
    pillElement = document.createElement('div');
    pillElement.id = 'tvCandleVpocPill';
    pillElement.setAttribute('class', 'tv-candle-vpoc-pill');
    pillElement.style.display = 'none';
    viewport.appendChild(pillElement);
  }

  // 3. Attach Chart Click Listener for Candle Selection
  setupChartClickListener();

  // 4. Attach 60fps Sync Listeners for Scroll, Zoom, and Drag
  setupChartSyncListeners();

  // 5. Global Escape Key to Clear Selection
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearCandleVpocSelection();
    }
  });

  console.log('[Candle VPOC Inspector] Initialized successfully');
}

/**
 * Setup Click Listener on KlineChart Canvas
 */
function setupChartClickListener() {
  const chartContainer = document.getElementById('klineChart') || document.querySelector('.tv-chart-viewport');
  if (!chartContainer) return;

  let mouseDownPos = null;
  let mouseDownTime = 0;

  chartContainer.addEventListener('mousedown', (e) => {
    mouseDownPos = { x: e.clientX, y: e.clientY };
    mouseDownTime = Date.now();
  }, { passive: true });

  chartContainer.addEventListener('click', (e) => {
    if (!isInspectorEnabled || !chartInstance) return;

    // Ignore clicks if user was actively dragging or drawing (moved > 5px or held > 400ms)
    if (mouseDownPos) {
      const dist = Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y);
      if (dist > 5 || (Date.now() - mouseDownTime) > 400) return;
    }

    // Ignore if click originated on toolbar, modals, or active buttons
    if (e.target.closest('.tv-toolbar') || e.target.closest('.tv-modal') || e.target.closest('button')) {
      return;
    }

    // Ignore if currently placing a drawing tool (not default crosshair)
    if (window.__currentOverlayMode && window.__currentOverlayMode !== 'default') {
      return;
    }

    const rect = chartContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Convert click pixel to chart coordinate
    let pt = null;
    try {
      pt = chartInstance.convertFromPixel({ x, y });
      if (Array.isArray(pt) && pt.length > 0) pt = pt[0];
    } catch (_) {}

    if (!pt || typeof pt.dataIndex !== 'number') {
      clearCandleVpocSelection();
      return;
    }

    const dataList = chartInstance.getDataList() || [];
    if (pt.dataIndex < 0 || pt.dataIndex >= dataList.length) {
      clearCandleVpocSelection();
      return;
    }

    const clickedCandle = dataList[pt.dataIndex];
    if (!clickedCandle) {
      clearCandleVpocSelection();
      return;
    }

    // Check if clicked the same candle -> Toggle off
    if (selectedBarTimestamp === clickedCandle.timestamp) {
      clearCandleVpocSelection();
      return;
    }

    // Select candle and compute footprint metrics
    selectCandle(clickedCandle, pt.dataIndex);
  });
}

/**
 * Select a specific candle and render its VPOC & Right-Scale Pill
 */
export function selectCandle(candle, dataIndex) {
  if (!candle) return;
  selectedBarTimestamp = candle.timestamp;
  selectedBarData = computeCandleFootprint(candle, dataIndex);
  renderVpocOverlay();
}

/**
 * Clear current Candle VPOC Selection
 */
export function clearCandleVpocSelection() {
  selectedBarTimestamp = null;
  selectedBarData = null;
  if (svgElement) svgElement.innerHTML = '';
  if (pillElement) pillElement.style.display = 'none';
}

/**
 * Computes exact physical footprint, real VPOC tick, buy/sell volume split and delta
 */
export function computeCandleFootprint(bar, index) {
  const o = Number(bar.open);
  const h = Number(bar.high);
  const l = Number(bar.low);
  const c = Number(bar.close);
  const vol = Number(bar.volume || bar.tick_volume || 1);
  const range = Math.max(0.01, h - l);
  const body = Math.abs(c - o);
  const isUp = c >= o;
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;
  const upperRatio = upperWick / range;
  const lowerRatio = lowerWick / range;

  // Order flow & delta decomposition (matching empirical desk formula)
  const displacement = (c - o) / range;
  const closeLocation = ((c - l) - (h - c)) / range;
  const wickDiff = (lowerWick - upperWick) / range;

  const deltaScore = Math.max(-1.0, Math.min(1.0, displacement * 0.45 + closeLocation * 0.35 + wickDiff * 0.20));
  const bullRatio = Math.max(0.05, Math.min(0.95, (1 + deltaScore) / 2));

  const buyVol = Math.round(vol * bullRatio);
  const sellVol = Math.max(0, vol - buyVol);
  const delta = buyVol - sellVol;

  // VPOC Placement Logic
  let vpocPrice = (o + c) / 2;
  let verdict = "NEUTRAL";
  let themeClass = "neutral";
  let color = "#38bdf8";

  // Case 1: Bullish Absorption (Sweep Wick with massive buyer absorption)
  if (lowerRatio >= 0.32 && c > (l + 0.25 * range)) {
    vpocPrice = l + (lowerWick * 0.40);
    verdict = "ABSORPTION";
    themeClass = "absorption-bull";
    color = "#10b981";
  }
  // Case 2: Bearish Exhaustion (Ceiling Wick with trapped breakout buyers)
  else if (upperRatio >= 0.32 && c < (h - 0.25 * range)) {
    vpocPrice = h - (upperWick * 0.40);
    verdict = "EXHAUSTION";
    themeClass = "absorption-bear";
    color = "#f43f5e";
  }
  // Case 3: High-Velocity Initiative Momentum Expansion
  else if (body >= 0.55 * range) {
    vpocPrice = isUp ? (o + body * 0.38) : (o - body * 0.38);
    verdict = "INITIATIVE";
    themeClass = "initiative";
    color = "#fbbf24";
  }
  // Case 4: Balanced Fair Value Rotation
  else {
    vpocPrice = (h + l + c * 2) / 4;
    verdict = "BALANCED";
    themeClass = "neutral";
    color = "#38bdf8";
  }

  // Round VPOC to 2 decimal places matching broker quote precision
  vpocPrice = Math.round(vpocPrice * 100) / 100;

  return {
    timestamp: bar.timestamp,
    index,
    o, h, l, c,
    vol,
    buyVol,
    sellVol,
    delta,
    bullRatio,
    vpocPrice,
    verdict,
    themeClass,
    color
  };
}

/**
 * Render the Projected Laser Line & Floating Right Scale Pill
 */
export function renderVpocOverlay() {
  if (!chartInstance || !svgElement || !pillElement || !selectedBarData) {
    if (svgElement) svgElement.innerHTML = '';
    if (pillElement) pillElement.style.display = 'none';
    return;
  }

  const d = selectedBarData;
  const viewport = document.querySelector('.tv-chart-viewport') || document.getElementById('klineChart');
  if (!viewport) return;

  const width = viewport.clientWidth;
  const height = viewport.clientHeight;

  // Convert Candle & VPOC to Screen Coordinates
  let candlePt = null;
  let vpocPt = null;

  try {
    candlePt = chartInstance.convertToPixel({ timestamp: d.timestamp, value: d.c });
    vpocPt = chartInstance.convertToPixel({ timestamp: d.timestamp, value: d.vpocPrice });
    if (Array.isArray(candlePt) && candlePt.length > 0) candlePt = candlePt[0];
    if (Array.isArray(vpocPt) && vpocPt.length > 0) vpocPt = vpocPt[0];
  } catch (err) {
    console.warn('[Candle VPOC Inspector] convertToPixel failed:', err);
  }

  if (!candlePt || !vpocPt || typeof candlePt.x !== 'number' || typeof vpocPt.y !== 'number') {
    svgElement.innerHTML = '';
    pillElement.style.display = 'none';
    return;
  }

  const candleX = candlePt.x;
  const vpocY = vpocPt.y;

  // Check if candle is within visible canvas (allow horizontal laser to trace even if candle scrolled left)
  const lineStartX = Math.max(0, candleX);
  const lineEndX = width - 82; // Space reserved for right price scale (75-80px)

  if (lineStartX >= lineEndX || vpocY < 0 || vpocY > height) {
    svgElement.innerHTML = '';
    pillElement.style.display = 'none';
    return;
  }

  // 1. Draw Laser Filament on SVG Layer
  svgElement.innerHTML = `
    <defs>
      <linearGradient id="vpocGrad_${d.themeClass}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${d.color}" stop-opacity="0.25" />
        <stop offset="70%" stop-color="${d.color}" stop-opacity="0.95" />
        <stop offset="100%" stop-color="${d.color}" stop-opacity="1.0" />
      </linearGradient>
    </defs>

    <!-- Vertical Column Scanner Beam over selected candle -->
    ${candleX >= 0 && candleX <= width ? `
      <rect x="${candleX - 10}" y="10" width="20" height="${height - 20}" fill="${d.color}" fill-opacity="0.07" rx="3" />
      <line x1="${candleX}" y1="10" x2="${candleX}" y2="${height - 20}" stroke="${d.color}" stroke-width="0.8" stroke-dasharray="2 3" opacity="0.35" />
      <!-- Anchor Dot at exact VPOC tick -->
      <circle cx="${candleX}" cy="${vpocY}" r="4.5" fill="${d.color}" stroke="#ffffff" stroke-width="1.5" />
    ` : ''}

    <!-- Glow Ray Underneath -->
    <line x1="${lineStartX}" y1="${vpocY}" x2="${lineEndX}" y2="${vpocY}" stroke="${d.color}" stroke-width="4.5" opacity="0.28" />

    <!-- Thin Crisp Laser Line -->
    <line x1="${lineStartX}" y1="${vpocY}" x2="${lineEndX}" y2="${vpocY}" stroke="url(#vpocGrad_${d.themeClass})" stroke-width="1.6" stroke-dasharray="4 3" opacity="0.95" />

    <!-- Right Terminal Arrow Pointing into the Price Scale -->
    <polygon points="${lineEndX},${vpocY} ${lineEndX - 7},${vpocY - 4.5} ${lineEndX - 7},${vpocY + 4.5}" fill="${d.color}" opacity="0.95" />
  `;

  // 2. Render and Position the Right-Scale Cyber Data Pill
  const buyPct = Math.round((d.buyVol / d.vol) * 100);
  const sellPct = 100 - buyPct;
  const deltaFormatted = (d.delta >= 0 ? `+${d.delta.toLocaleString()}` : `${d.delta.toLocaleString()}`) + ' Δ';
  const deltaColor = d.delta >= 0 ? '#34d399' : '#f87171';

  pillElement.className = `tv-candle-vpoc-pill ${d.themeClass}`;
  pillElement.style.display = 'block';

  // Format compact volume counts (e.g. 14.8K)
  const formatCompact = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
  };

  pillElement.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 5px; margin-bottom: 6px;">
      <div style="display: flex; align-items: center; gap: 6px;">
        <span style="width: 7px; height: 7px; border-radius: 50%; background: ${d.color}; display: inline-block; box-shadow: 0 0 8px ${d.color};"></span>
        <span style="font-size: 11px; font-weight: 800; color: #ffffff; letter-spacing: 0.05em;">VPOC $${d.vpocPrice.toFixed(2)}</span>
      </div>
      <div style="display: flex; align-items: center; gap: 6px;">
        <span style="padding: 1.5px 5px; font-size: 9.5px; font-family: monospace; font-weight: 800; background: rgba(255, 255, 255, 0.08); color: ${d.color}; border: 1px solid ${d.color}; border-radius: 3px;">
          ${d.verdict}
        </span>
        <span class="tv-vpoc-pill-close" onclick="window.__clearCandleVpoc()" title="Close Inspector (Esc)">✕</span>
      </div>
    </div>

    <!-- Total Volume Row -->
    <div style="display: flex; justify-content: space-between; font-size: 11.5px; font-family: monospace; margin-bottom: 4px;">
      <span style="color: #94a3b8;">📊 Total Vol:</span>
      <span style="font-weight: 800; color: #f8fafc;">${d.vol.toLocaleString()} v</span>
    </div>

    <!-- Buy vs Sell Split Bar -->
    <div style="width: 100%; height: 6px; background: rgba(255, 255, 255, 0.08); border-radius: 3px; display: flex; overflow: hidden; margin: 4px 0;">
      <div style="width: ${buyPct}%; background: #10b981;"></div>
      <div style="width: ${sellPct}%; background: #f43f5e;"></div>
    </div>

    <!-- Buy vs Sell Counts -->
    <div style="display: flex; justify-content: space-between; font-size: 10.5px; font-family: monospace; margin-bottom: 5px;">
      <span style="color: #34d399; font-weight: 700;">🟢 ${formatCompact(d.buyVol)} (${buyPct}%)</span>
      <span style="color: #fb7185; font-weight: 700;">🔴 ${formatCompact(d.sellVol)} (${sellPct}%)</span>
    </div>

    <!-- Net Delta Row -->
    <div style="display: flex; justify-content: space-between; border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 4px; font-size: 11px; font-family: monospace;">
      <span style="color: #94a3b8;">Candle Delta:</span>
      <span style="font-weight: 800; color: ${deltaColor};">${deltaFormatted}</span>
    </div>
  `;

  // Clamp Pill Vertically so it never overflows top or bottom edge of viewport
  const pillHeight = 110;
  let pillTop = vpocY - (pillHeight / 2);
  pillTop = Math.max(12, Math.min(height - pillHeight - 12, pillTop));
  pillElement.style.top = `${pillTop}px`;
  pillElement.style.right = '84px';
}

/**
 * Setup 60fps drag, scroll, and zoom sync listeners to keep lines locked to candles
 */
function setupChartSyncListeners() {
  const chartContainer = document.getElementById('klineChart') || document.querySelector('.tv-chart-viewport');
  if (!chartContainer) return;

  const onActivity = () => {
    if (selectedBarData) {
      renderVpocOverlay();
    }
  };

  chartContainer.addEventListener('mousedown', () => {
    isDraggingChart = true;
    cancelAnimationFrame(rafId);
    const loop = () => {
      if (!isDraggingChart) return;
      onActivity();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  });

  window.addEventListener('mouseup', () => {
    isDraggingChart = false;
    cancelAnimationFrame(rafId);
    onActivity();
  });

  chartContainer.addEventListener('wheel', () => {
    requestAnimationFrame(onActivity);
  }, { passive: true });

  window.addEventListener('resize', onActivity);

  if (chartInstance && typeof chartInstance.subscribeAction === 'function') {
    try {
      chartInstance.subscribeAction('onVisibleRangeChange', onActivity);
      chartInstance.subscribeAction('onScroll', onActivity);
      chartInstance.subscribeAction('onZoom', onActivity);
    } catch (_) {}
  }
}

// Global window handle for clearing
if (typeof window !== 'undefined') {
  window.__clearCandleVpoc = clearCandleVpocSelection;
}
