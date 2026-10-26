/**
 * Escanor Sovereign Causal Paths & HUD Story Overlay
 * Renders static, crisp architectural path vectors, exact supporting zone lines,
 * and connected leader lines to chamfered cyberpunk HUD comment cards.
 * 
 * 100% Clean Chart Tape:
 * - NO extra duplicate boxes drawn over candles; existing box borders are tinted to match the path story.
 * - ZERO text inside or around chart lines/boxes (all text is inside the HUD comment cards).
 * - Subtle, delicate vectors and leader lines (stroke 1.1-1.6px, opacity 0.40-0.65) so live tape is clear.
 * - Anchored to actual candle timestamps and price values via KLineCharts coordinate projection.
 * - Stays 100% fixed to the candles when scrolled, zoomed, or panned (60fps drag loop).
 * - Off-screen clipping: when scrolled away from the setup, off-screen markings and cards hide naturally.
 * - Single click / double click to focus and jump chart directly to the setup coordinates.
 */

let overlayContainer = null;
let svgElement = null;
let groupA = null;
let groupB = null;
let groupC = null;
let cardA = null;
let cardB = null;
let cardC = null;
let toggleBtn = null;
let chartInstance = null;
let currentEvalData = null;
let isOverlayVisible = true;
let isDraggingChart = false;
let rafId = null;

/**
 * Initialize Sovereign Paths Overlay and wire sidebar toggle button
 */
export function initSovereignPathsOverlay(chart) {
  chartInstance = chart;
  overlayContainer = document.getElementById('tvSovereignPathsOverlay');
  svgElement = document.getElementById('tvSovereignPathsSvg');
  groupA = document.getElementById('svgGroupPathA');
  groupB = document.getElementById('svgGroupPathB');
  groupC = document.getElementById('svgGroupPathC');
  cardA = document.getElementById('hudCardPathA');
  cardB = document.getElementById('hudCardPathB');
  cardC = document.getElementById('hudCardPathC');
  toggleBtn = document.getElementById('tvSidebarPathsToggleBtn');

  // Load saved visibility state from localStorage (default: true)
  const savedState = localStorage.getItem('tv_sovereign_paths_visible');
  if (savedState !== null) {
    isOverlayVisible = (savedState === 'true');
  } else {
    isOverlayVisible = true;
  }

  applyVisibilityState();
  applyBoxBorderOverrides(isOverlayVisible);

  // Wire Sidebar Toggle Button
  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      
      // If already active and clicked while setup is off-screen, smoothly jump to setup!
      if (isOverlayVisible && currentEvalData?.anchor_timestamp) {
        const anchorPt = pointToPixel(chartInstance, currentEvalData.anchor_timestamp, 4092.0);
        const rect = overlayContainer?.getBoundingClientRect();
        const w = rect?.width || window.innerWidth;
        const h = rect?.height || window.innerHeight;
        const isOffScreen = !anchorPt || anchorPt.x < 0 || anchorPt.x > w || anchorPt.y < 0 || anchorPt.y > h;

        if (isOffScreen && typeof chartInstance.scrollToTimestamp === 'function') {
          chartInstance.scrollToTimestamp(currentEvalData.anchor_timestamp, 300);
          showToast('⚡ Scrolled to Sovereign Causal Paths Setup ($4,090 - $4,094)');
          requestAnimationFrame(renderSovereignPaths);
          return;
        }
      }

      isOverlayVisible = !isOverlayVisible;
      localStorage.setItem('tv_sovereign_paths_visible', isOverlayVisible ? 'true' : 'false');
      applyVisibilityState();
      applyBoxBorderOverrides(isOverlayVisible);
      if (isOverlayVisible) {
        renderSovereignPaths();
      }
    });

    // Double click always focuses setup
    toggleBtn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (currentEvalData?.anchor_timestamp && typeof chartInstance?.scrollToTimestamp === 'function') {
        chartInstance.scrollToTimestamp(currentEvalData.anchor_timestamp, 300);
        showToast('⚡ Scrolled to Sovereign Causal Paths Setup ($4,090 - $4,094)');
        requestAnimationFrame(renderSovereignPaths);
      }
    });
  }

  // Setup Card Hover Isolations
  setupCardInteractions();

  // Wire 60fps drag and scroll loop on chart canvas to keep lines 100% glued to candles
  setupChartInteractionListeners();

  // Window resize handler
  window.addEventListener('resize', () => {
    if (isOverlayVisible && currentEvalData) {
      requestAnimationFrame(renderSovereignPaths);
    }
  });
}

/**
 * Toast helper fallback
 */
function showToast(msg) {
  if (typeof window.showChartToast === 'function') {
    window.showChartToast(msg);
  }
}

/**
 * Convert timestamp and price to exact on-screen canvas pixel coordinates
 */
export function pointToPixel(chart, timestamp, price) {
  if (!chart) return null;
  try {
    const pt = {};
    if (typeof timestamp === 'number' && !isNaN(timestamp)) pt.timestamp = timestamp;
    if (typeof price === 'number' && !isNaN(price)) pt.value = price;

    // Call KLineCharts convertToPixel
    const res = chart.convertToPixel(pt, { paneId: 'candle_pane', absolute: true });
    if (res && typeof res.y === 'number' && !isNaN(res.y)) {
      if (typeof res.x === 'number' && !isNaN(res.x)) {
        return res;
      }
      // If x is not defined (e.g. timestamp beyond loaded bars), compute from dataIndex
      const dataList = chart.getDataList() || [];
      if (dataList.length > 0 && typeof timestamp === 'number') {
        const firstBar = dataList[0];
        const lastBar = dataList[dataList.length - 1];
        const barStep = (dataList.length > 1) ? (dataList[1].timestamp - dataList[0].timestamp) : 300000;
        let idx = -1;
        if (timestamp >= firstBar.timestamp && timestamp <= lastBar.timestamp) {
          idx = Math.round((timestamp - firstBar.timestamp) / barStep);
        } else if (timestamp > lastBar.timestamp) {
          idx = (dataList.length - 1) + Math.round((timestamp - lastBar.timestamp) / barStep);
        } else {
          idx = Math.round((timestamp - firstBar.timestamp) / barStep);
        }
        const resIdx = chart.convertToPixel({ dataIndex: idx, value: price }, { paneId: 'candle_pane', absolute: true });
        if (resIdx && typeof resIdx.x === 'number' && !isNaN(resIdx.x)) {
          return { x: resIdx.x, y: res.y };
        }
      }
    }
  } catch (e) {
    console.warn('[Sovereign Paths] pointToPixel error:', e);
  }
  return null;
}

/**
 * Setup continuous 60fps drag and scroll listeners on chart canvas
 */
function setupChartInteractionListeners() {
  const chartContainer = document.getElementById('klineChart') || document.querySelector('.tv-chart-viewport');
  if (!chartContainer) return;

  const startDrag = () => {
    isDraggingChart = true;
    cancelAnimationFrame(rafId);
    const loop = () => {
      if (!isDraggingChart) return;
      if (isOverlayVisible && currentEvalData) {
        renderSovereignPaths();
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  };

  const stopDrag = () => {
    isDraggingChart = false;
    cancelAnimationFrame(rafId);
    if (isOverlayVisible && currentEvalData) {
      renderSovereignPaths();
    }
  };

  chartContainer.addEventListener('mousedown', startDrag);
  window.addEventListener('mouseup', stopDrag);
  chartContainer.addEventListener('touchstart', startDrag, { passive: true });
  window.addEventListener('touchend', stopDrag);

  chartContainer.addEventListener('wheel', () => {
    if (isOverlayVisible && currentEvalData) {
      requestAnimationFrame(renderSovereignPaths);
    }
  }, { passive: true });

  if (chartInstance && typeof chartInstance.subscribeAction === 'function') {
    try {
      chartInstance.subscribeAction('onVisibleRangeChange', () => {
        if (isOverlayVisible && currentEvalData) {
          requestAnimationFrame(renderSovereignPaths);
        }
      });
      chartInstance.subscribeAction('onScroll', () => {
        if (isOverlayVisible && currentEvalData) {
          requestAnimationFrame(renderSovereignPaths);
        }
      });
      chartInstance.subscribeAction('onZoom', () => {
        if (isOverlayVisible && currentEvalData) {
          requestAnimationFrame(renderSovereignPaths);
        }
      });
    } catch (err) {}
  }
}

/**
 * Toggle visibility of SVG canvas and HUD cards
 */
function applyVisibilityState() {
  if (toggleBtn) {
    if (isOverlayVisible) {
      toggleBtn.classList.add('active');
      toggleBtn.setAttribute('title', 'Causal Paths & Overlays: ON (Click to Hide, DblClick to Focus Setup)');
    } else {
      toggleBtn.classList.remove('active');
      toggleBtn.setAttribute('title', 'Causal Paths & Overlays: OFF (Click to Show)');
    }
  }

  if (overlayContainer) {
    if (isOverlayVisible) {
      overlayContainer.classList.remove('hidden');
    } else {
      overlayContainer.classList.add('hidden');
    }
  }
}

/**
 * Change border colors of existing chart boxes to match path story,
 * without drawing duplicate box shapes on top of candles.
 */
export function applyBoxBorderOverrides(isActive) {
  if (!chartInstance || typeof chartInstance.overrideOverlay !== 'function') return;
  try {
    if (isActive) {
      // Tint Box 3 (Dual-Top Supply Pool at $4,099 - $4,103.50) to Electric Violet
      chartInstance.overrideOverlay({
        id: 'sov_box_dual_supply_pool',
        styles: {
          rect: {
            borderColor: '#e879f9',
            borderSize: 2
          }
        }
      });
      // Tint Box 1 (Ascending Demand Base at $4,083 - $4,087.50) to Solar Amber
      chartInstance.overrideOverlay({
        id: 'sov_box_ascending_base',
        styles: {
          rect: {
            borderColor: '#fbbf24',
            borderSize: 2
          }
        }
      });
    } else {
      // Restore original box borders
      chartInstance.overrideOverlay({
        id: 'sov_box_dual_supply_pool',
        styles: {
          rect: {
            borderColor: 'rgba(168, 85, 247, 0.85)',
            borderSize: 1.5
          }
        }
      });
      chartInstance.overrideOverlay({
        id: 'sov_box_ascending_base',
        styles: {
          rect: {
            borderColor: 'rgba(0, 229, 255, 0.85)',
            borderSize: 1.5
          }
        }
      });
    }
  } catch (err) {
    console.warn('[Sovereign Paths] applyBoxBorderOverrides error:', err);
  }
}

/**
 * Setup hover and click isolation on HUD comment cards
 */
function setupCardInteractions() {
  const cards = [
    { card: cardA, group: groupA },
    { card: cardB, group: groupB },
    { card: cardC, group: groupC }
  ];

  cards.forEach(({ card, group }) => {
    if (!card) return;

    card.addEventListener('mouseenter', () => {
      cards.forEach(item => {
        if (item.group) {
          item.group.style.opacity = (item.group === group) ? '1' : '0.12';
        }
        if (item.card) {
          item.card.style.opacity = (item.card === card) ? '1' : '0.25';
        }
      });
    });

    card.addEventListener('mouseleave', () => {
      cards.forEach(item => {
        if (item.group) item.group.style.opacity = '1';
        if (item.card) item.card.style.opacity = '1';
      });
    });
  });
}

/**
 * Update evaluation data and re-render
 */
export function updateSovereignPathsData(evalData) {
  if (!evalData) return;
  currentEvalData = evalData;
  applyBoxBorderOverrides(isOverlayVisible);
  if (isOverlayVisible) {
    requestAnimationFrame(renderSovereignPaths);
  }
}

/**
 * Check if coordinate point or rectangle is visible on the canvas
 */
function isRectInViewport(minX, maxX, minY, maxY, viewportW, viewportH) {
  if (maxX < 0 || minX > viewportW) return false;
  if (maxY < 0 || minY > viewportH) return false;
  return true;
}

/**
 * Render all static paths, supporting places, and connector leader lines
 * Strictly anchored to candle timestamps and price values
 */
export function renderSovereignPaths() {
  if (!overlayContainer || !currentEvalData || !isOverlayVisible || !chartInstance) return;

  const rect = overlayContainer.getBoundingClientRect();
  const width = rect.width || 1024;
  const height = rect.height || 576;

  if (width < 200 || height < 150) return;

  // Ensure box border colors remain tinted
  applyBoxBorderOverrides(true);

  // Set viewBox to current viewport pixels
  if (svgElement) {
    svgElement.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  const paths = currentEvalData.paths || [];
  const pathAData = paths.find(p => p.id === 'path_a') || paths[0];
  const pathBData = paths.find(p => p.id === 'path_b') || paths[1];
  const pathCData = paths.find(p => p.id === 'path_c') || paths[2];

  // -------------------------------------------------------------------------
  // 1. RENDER PATH A (Electric Violet Squeeze)
  // -------------------------------------------------------------------------
  if (pathAData && groupA && cardA) {
    const trigStart = pointToPixel(chartInstance, pathAData.trigger_start_time || 1792668000000, pathAData.trigger_level || 4094.0);
    const trigEnd = pointToPixel(chartInstance, pathAData.trigger_end_time || 1792675800000, pathAData.trigger_level || 4094.0);

    const boxTopLeft = pointToPixel(chartInstance, pathAData.target_box?.start_time || 1792665000000, pathAData.target_box?.top || 4103.5);
    const boxBottomRight = pointToPixel(chartInstance, pathAData.target_box?.end_time || 1792675800000, pathAData.target_box?.bottom || 4099.0);

    const vecFrom = pointToPixel(chartInstance, pathAData.vector?.from_time || 1792672000000, pathAData.vector?.from_price || 4092.5);
    const vecTo = pointToPixel(chartInstance, pathAData.vector?.to_time || 1792675800000, pathAData.vector?.to_price || 4101.5);

    const isBoxVisible = boxTopLeft && boxBottomRight && isRectInViewport(
      Math.min(boxTopLeft.x, boxBottomRight.x),
      Math.max(boxTopLeft.x, boxBottomRight.x),
      Math.min(boxTopLeft.y, boxBottomRight.y),
      Math.max(boxTopLeft.y, boxBottomRight.y),
      width, height
    );

    const isTrigVisible = trigStart && trigEnd && (trigEnd.x >= 0 && trigStart.x <= width && trigStart.y >= 0 && trigStart.y <= height);

    if (!isBoxVisible && !isTrigVisible) {
      // Scrolled off-screen: cleanly hide path A SVG and card!
      groupA.innerHTML = '';
      cardA.style.display = 'none';
    } else {
      const minX = boxTopLeft && boxBottomRight ? Math.min(boxTopLeft.x, boxBottomRight.x) : (trigStart ? trigStart.x : 0);
      const maxX = boxTopLeft && boxBottomRight ? Math.max(boxTopLeft.x, boxBottomRight.x) : (trigEnd ? trigEnd.x : 100);
      const minY = boxTopLeft && boxBottomRight ? Math.min(boxTopLeft.y, boxBottomRight.y) : (trigStart ? trigStart.y - 15 : 0);
      const maxY = boxTopLeft && boxBottomRight ? Math.max(boxTopLeft.y, boxBottomRight.y) : (trigStart ? trigStart.y + 15 : 30);
      const boxH = Math.max(12, maxY - minY);

      // Card A placement in top-right airspace
      const cardAW = Math.min(330, width * 0.32);
      const cardATop = 50;
      const cardALeft = width - cardAW - 25;

      // Leader line connection from Target Box (Box 3 right edge) to Card A
      const leaderStartX = maxX;
      const leaderStartY = minY + boxH * 0.5;
      const leaderEndX = cardALeft;
      const leaderEndY = cardATop + 20;

      let svgMarkup = '';

      // 1. Trigger Level Line at $4,094.00 (Clean, light, no text clutter)
      if (trigStart && trigEnd) {
        svgMarkup += `
          <line x1="${trigStart.x}" y1="${trigStart.y}" x2="${trigEnd.x}" y2="${trigEnd.y}" stroke="#f0abfc" stroke-width="1.3" stroke-dasharray="4 3" opacity="0.65" />
        `;
      }

      // 2. Squeeze Vector Arrow (Light & subtle)
      if (vecFrom && vecTo) {
        svgMarkup += `
          <path d="M ${vecFrom.x} ${vecFrom.y} C ${vecFrom.x + (vecTo.x - vecFrom.x) * 0.5} ${vecFrom.y - 4}, ${vecTo.x - 20} ${vecTo.y + 8}, ${vecTo.x} ${vecTo.y}" fill="none" stroke="#f0abfc" stroke-width="1.6" opacity="0.65" marker-end="url(#arrowViolet)" />
        `;
      }

      // 3. Dotted Leader Line connecting Box 3 to Card A (Light & delicate)
      svgMarkup += `
        <polyline points="${leaderStartX},${leaderStartY} ${leaderStartX + 20},${leaderStartY} ${leaderStartX + 20},${leaderEndY} ${leaderEndX},${leaderEndY}" fill="none" stroke="#e879f9" stroke-width="1.1" stroke-dasharray="3 3" opacity="0.40" />
        <circle cx="${leaderStartX}" cy="${leaderStartY}" r="2" fill="#f0abfc" opacity="0.6" />
        <circle cx="${leaderEndX}" cy="${leaderEndY}" r="2" fill="#e879f9" opacity="0.6" />
      `;

      groupA.innerHTML = svgMarkup;

      // Update Card A HUD
      const c = pathAData.card || {};
      cardA.style.top = `${cardATop}px`;
      cardA.style.left = `${cardALeft}px`;
      cardA.style.width = `${cardAW}px`;
      cardA.style.display = 'block';
      cardA.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(217,70,239,0.35); padding-bottom: 6px; margin-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="width: 9px; height: 9px; border-radius: 2px; background: #d946ef; display: inline-block;"></span>
            <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #f0abfc; text-transform: uppercase;">${c.title || 'PATH A: ASCENDING SQUEEZE'}</span>
          </div>
          <span style="padding: 2px 6px; font-size: 10px; font-family: monospace; font-weight: 800; background: rgba(217,70,239,0.25); color: #fdf4ff; border: 1px solid rgba(217,70,239,0.45); border-radius: 3px;">
            ${c.badge || 'TARGET: $4,103.50'}
          </span>
        </div>
        <div style="font-size: 11.5px; line-height: 1.5; color: #cbd5e1; font-weight: 500;">
          ${c.body || 'A clean 5m candle close <strong>above $4,094.00</strong> breaks compression lid.'}
        </div>
        <div style="margin-top: 8px; border-top: 1px solid rgba(217,70,239,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 10px; font-family: monospace; color: #94a3b8; padding-top: 6px;">
          <span class="hud-pill-violet">${c.footer_left || 'TRIGGER: 5M C > $4,094.00'}</span>
          <span style="color: #34d399; font-weight: 800;">${c.footer_right || '+10.5 PT RUNWAY'}</span>
        </div>
      `;
    }
  }

  // -------------------------------------------------------------------------
  // 2. RENDER PATH B (Solar Coral Base Retest)
  // -------------------------------------------------------------------------
  if (pathBData && groupB && cardB) {
    const floorTopLeft = pointToPixel(chartInstance, pathBData.supporting_box?.start_time || 1792671000000, pathBData.supporting_box?.top || 4087.5);
    const floorBottomRight = pointToPixel(chartInstance, pathBData.supporting_box?.end_time || 1792675800000, pathBData.supporting_box?.bottom || 4083.0);

    const vecFrom = pointToPixel(chartInstance, pathBData.vector?.from_time || 1792673100000, pathBData.vector?.from_price || 4092.0);
    const vecTo = pointToPixel(chartInstance, pathBData.vector?.to_time || 1792675800000, pathBData.vector?.to_price || 4085.0);

    const isFloorVisible = floorTopLeft && floorBottomRight && isRectInViewport(
      Math.min(floorTopLeft.x, floorBottomRight.x),
      Math.max(floorTopLeft.x, floorBottomRight.x),
      Math.min(floorTopLeft.y, floorBottomRight.y),
      Math.max(floorTopLeft.y, floorBottomRight.y),
      width, height
    );

    if (!isFloorVisible) {
      // Scrolled off-screen: cleanly hide path B SVG and card!
      groupB.innerHTML = '';
      cardB.style.display = 'none';
    } else {
      const minX = Math.min(floorTopLeft.x, floorBottomRight.x);
      const maxX = Math.max(floorTopLeft.x, floorBottomRight.x);
      const minY = Math.min(floorTopLeft.y, floorBottomRight.y);
      const maxY = Math.max(floorTopLeft.y, floorBottomRight.y);
      const boxH = Math.max(12, maxY - minY);

      // Card B placement in bottom-left airspace
      const cardBW = Math.min(310, width * 0.30);
      const cardBTop = Math.max(60, height - 170);
      const cardBLeft = 35;

      // Leader line connection from Box 1 left edge to Card B
      const leaderStartX = minX;
      const leaderStartY = minY + boxH * 0.5;
      const leaderEndX = cardBLeft + cardBW;
      const leaderEndY = cardBTop + 20;

      let svgMarkup = '';

      // 1. Retest Path Vector (Light & subtle)
      if (vecFrom && vecTo) {
        svgMarkup += `
          <path d="M ${vecFrom.x} ${vecFrom.y} C ${vecFrom.x + 10} ${vecFrom.y + 2}, ${vecTo.x - 10} ${vecTo.y - 6}, ${vecTo.x} ${vecTo.y}" fill="none" stroke="#fbbf24" stroke-width="1.6" opacity="0.65" marker-end="url(#arrowAmber)" />
        `;
      }

      // 2. Connector Line: Box 1 left edge -> Bottom-Left HUD Card B (Light & delicate)
      svgMarkup += `
        <polyline points="${leaderStartX},${leaderStartY} ${leaderStartX - 25},${leaderStartY} ${leaderStartX - 25},${leaderEndY} ${leaderEndX},${leaderEndY}" fill="none" stroke="#fbbf24" stroke-width="1.1" stroke-dasharray="3 3" opacity="0.40" />
        <circle cx="${leaderStartX}" cy="${leaderStartY}" r="2" fill="#fde68a" opacity="0.6" />
        <circle cx="${leaderEndX}" cy="${leaderEndY}" r="2" fill="#fbbf24" opacity="0.6" />
      `;

      groupB.innerHTML = svgMarkup;

      // Update Card B HUD (Clean, ultra-readable pill)
      const c = pathBData.card || {};
      cardB.style.top = `${cardBTop}px`;
      cardB.style.left = `${cardBLeft}px`;
      cardB.style.width = `${cardBW}px`;
      cardB.style.display = 'block';
      cardB.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(245,158,11,0.35); padding-bottom: 6px; margin-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="width: 9px; height: 9px; border-radius: 2px; background: #fbbf24; display: inline-block;"></span>
            <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #fde68a; text-transform: uppercase;">${c.title || 'PATH B: COIL BASE RETEST'}</span>
          </div>
          <span style="padding: 2px 6px; font-size: 10px; font-family: monospace; font-weight: 800; background: rgba(245,158,11,0.25); color: #fef08a; border: 1px solid rgba(245,158,11,0.45); border-radius: 3px;">
            ${c.badge || 'FLOOR: $4,083.00'}
          </span>
        </div>
        <div style="font-size: 11.5px; line-height: 1.5; color: #cbd5e1; font-weight: 500;">
          ${c.body || 'Rejection off $4,093.50 rotates price down to test ascending floor shelf in Box 1.'}
        </div>
        <div style="margin-top: 8px; border-top: 1px solid rgba(245,158,11,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 10px; font-family: monospace; color: #94a3b8; padding-top: 6px;">
          <span class="hud-pill-amber">${c.footer_left || 'SUPPORT: $4,083 – $4,087.50'}</span>
          <span style="color: #f59e0b; font-weight: 800;">${c.footer_right || 'LPS ACCUMULATION'}</span>
        </div>
      `;
    }
  }

  // -------------------------------------------------------------------------
  // 3. RENDER PATH C (Hazard Neon Red Invalidation)
  // -------------------------------------------------------------------------
  if (pathCData && groupC && cardC) {
    const tripStart = pointToPixel(chartInstance, pathCData.tripwire_start_time || 1792670000000, pathCData.tripwire_level || 4082.5);
    const tripEnd = pointToPixel(chartInstance, pathCData.tripwire_end_time || 1792675800000, pathCData.tripwire_level || 4082.5);

    const downTopLeft = pointToPixel(chartInstance, pathCData.target_box?.start_time || 1792673100000, pathCData.target_box?.top || 4070.0);
    const downBottomRight = pointToPixel(chartInstance, pathCData.target_box?.end_time || 1792675800000, pathCData.target_box?.bottom || 4066.5);

    const vecFrom = pointToPixel(chartInstance, pathCData.vector?.from_time || 1792674000000, pathCData.vector?.from_price || 4082.5);
    const vecTo = pointToPixel(chartInstance, pathCData.vector?.to_time || 1792675800000, pathCData.vector?.to_price || 4068.5);

    const isTripVisible = tripStart && tripEnd && (tripEnd.x >= 0 && tripStart.x <= width && tripStart.y >= 0 && tripStart.y <= height);
    const isDownVisible = downTopLeft && downBottomRight && isRectInViewport(
      Math.min(downTopLeft.x, downBottomRight.x),
      Math.max(downTopLeft.x, downBottomRight.x),
      Math.min(downTopLeft.y, downBottomRight.y),
      Math.max(downTopLeft.y, downBottomRight.y),
      width, height
    );

    if (!isTripVisible && !isDownVisible) {
      // Scrolled off-screen: cleanly hide path C SVG and card!
      groupC.innerHTML = '';
      cardC.style.display = 'none';
    } else {
      const minX = downTopLeft && downBottomRight ? Math.min(downTopLeft.x, downBottomRight.x) : (tripStart ? tripStart.x : 0);
      const maxX = downTopLeft && downBottomRight ? Math.max(downTopLeft.x, downBottomRight.x) : (tripEnd ? tripEnd.x : 100);
      const minY = downTopLeft && downBottomRight ? Math.min(downTopLeft.y, downBottomRight.y) : (tripStart ? tripStart.y + 10 : 0);
      const maxY = downTopLeft && downBottomRight ? Math.max(downTopLeft.y, downBottomRight.y) : (tripStart ? tripStart.y + 25 : 30);
      const downLineY = (minY + maxY) * 0.5;

      // Card C placement in bottom-right airspace
      const cardCW = Math.min(340, width * 0.33);
      const cardCTop = Math.max(60, height - 170);
      const cardCLeft = width - cardCW - 25;

      // Leader line connection from Tripwire Line right coordinate to Card C
      const leaderStartX = tripEnd ? tripEnd.x : maxX;
      const leaderStartY = tripEnd ? tripEnd.y : downLineY;
      const leaderEndX = cardCLeft;
      const leaderEndY = cardCTop + 20;

      let svgMarkup = '';

      // 1. Tripwire Level Line at $4,082.50 (Clean line marking, no text clutter)
      if (tripStart && tripEnd) {
        svgMarkup += `
          <line x1="${tripStart.x}" y1="${tripStart.y}" x2="${tripEnd.x}" y2="${tripEnd.y}" stroke="#f43f5e" stroke-width="1.3" stroke-dasharray="4 3" opacity="0.65" />
        `;
      }

      // 2. Downside Target Level Line at $4,068.50 (Clean line marking instead of extra box)
      if (downTopLeft && downBottomRight) {
        svgMarkup += `
          <line x1="${minX}" y1="${downLineY}" x2="${maxX}" y2="${downLineY}" stroke="#f43f5e" stroke-width="1.3" stroke-dasharray="4 3" opacity="0.55" />
        `;
      }

      // 3. Breakdown Cascade Vector (Light & subtle)
      if (vecFrom && vecTo) {
        svgMarkup += `
          <path d="M ${vecFrom.x} ${vecFrom.y} C ${vecFrom.x + 15} ${vecFrom.y + 4}, ${vecTo.x - 10} ${vecTo.y - 4}, ${vecTo.x} ${vecTo.y}" fill="none" stroke="#f43f5e" stroke-width="1.6" opacity="0.65" marker-end="url(#arrowRed)" />
        `;
      }

      // 4. Connector Line: Tripwire Line -> Bottom-Right HUD Card C (Light & delicate)
      svgMarkup += `
        <polyline points="${leaderStartX},${leaderStartY} ${leaderStartX + 20},${leaderStartY} ${leaderStartX + 20},${leaderEndY} ${leaderEndX},${leaderEndY}" fill="none" stroke="#f43f5e" stroke-width="1.1" stroke-dasharray="3 3" opacity="0.40" />
        <circle cx="${leaderStartX}" cy="${leaderStartY}" r="2" fill="#fecdd3" opacity="0.6" />
        <circle cx="${leaderEndX}" cy="${leaderEndY}" r="2" fill="#f43f5e" opacity="0.6" />
      `;

      groupC.innerHTML = svgMarkup;

      // Update Card C HUD (Clean, ultra-readable pill)
      const c = pathCData.card || {};
      cardC.style.top = `${cardCTop}px`;
      cardC.style.left = `${cardCLeft}px`;
      cardC.style.width = `${cardCW}px`;
      cardC.style.display = 'block';
      cardC.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(244,63,94,0.35); padding-bottom: 6px; margin-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="width: 9px; height: 9px; border-radius: 2px; background: #f43f5e; display: inline-block;"></span>
            <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #fecdd3; text-transform: uppercase;">${c.title || 'TRIPWIRE: ASCENDING FLOOR BREACH'}</span>
          </div>
          <span style="padding: 2px 6px; font-size: 10px; font-family: monospace; font-weight: 800; background: rgba(244,63,94,0.25); color: #fecdd3; border: 1px solid rgba(244,63,94,0.45); border-radius: 3px;">
            ${c.badge || 'CANCEL: $4,082.50'}
          </span>
        </div>
        <div style="font-size: 11.5px; line-height: 1.5; color: #ffe4e6; font-weight: 500;">
          ${c.body || 'A 5m candle body close below $4,082.50 shatters ascending structure into cascade target.'}
        </div>
        <div style="margin-top: 8px; border-top: 1px solid rgba(244,63,94,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 10px; font-family: monospace; color: #94a3b8; padding-top: 6px;">
          <span class="hud-pill-red">${c.footer_left || 'TRIPWIRE: 5M C < $4,082.50'}</span>
          <span style="color: #fb7185; font-weight: 800;">${c.footer_right || 'FULL CANCELLATION'}</span>
        </div>
      `;
    }
  }
}
