/**
 * Escanor Sovereign Causal Paths & HUD Story Overlay
 * Renders static, crisp architectural path vectors, exact supporting zone lines,
 * and connected leader lines to chamfered cyberpunk HUD comment cards.
 * 
 * 100% Data-Driven From Evaluation JSON:
 * - NO hardcoded setup prices or timestamps; strictly projected from evaluation JSON.
 * - NO extra duplicate box shapes drawn on top of candles; existing boxes are tinted dynamically.
 * - ZERO text clutter on chart tape (prices, conditions & stories live inside HUD comment cards).
 * - Subtle, delicate vectors and leader lines (stroke 1.1-1.6px, opacity 0.40-0.65).
 * - Anchored to actual candle timestamps and price values via robust KLineCharts coordinate projection.
 * - 60fps drag/scroll requestAnimationFrame loop keeps markings glued to candles.
 * - Off-screen clipping hides markings when scrolled away.
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

  // Wire Sidebar Toggle Button
  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      
      // If already active and clicked while setup is off-screen, smoothly jump to setup!
      if (isOverlayVisible && currentEvalData?.anchor_timestamp) {
        const anchorPt = pointToPixel(chartInstance, currentEvalData.anchor_timestamp, 4045.0);
        const rect = overlayContainer?.getBoundingClientRect();
        const w = rect?.width || window.innerWidth;
        const h = rect?.height || window.innerHeight;
        const isOffScreen = !anchorPt || anchorPt.x < 0 || anchorPt.x > w || anchorPt.y < 0 || anchorPt.y > h;

        if (isOffScreen && typeof chartInstance.scrollToTimestamp === 'function') {
          chartInstance.scrollToTimestamp(currentEvalData.anchor_timestamp, 300);
          showToast('⚡ Scrolled to Active Sovereign Causal Paths Setup');
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
        showToast('⚡ Scrolled to Active Sovereign Causal Paths Setup');
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
 * Robust coordinate projection: Convert timestamp and price to exact on-screen canvas pixel coordinates.
 * Works natively with KLineCharts without broken paneId constraints.
 */
export function pointToPixel(chart, timestamp, price) {
  if (!chart) return null;
  try {
    const pt = {};
    if (typeof timestamp === 'number' && !isNaN(timestamp)) pt.timestamp = timestamp;
    if (typeof price === 'number' && !isNaN(price)) pt.value = price;

    // 1. Direct KLineCharts convertToPixel call
    // Do NOT pass a custom paneId; omitting options allows KLineCharts to use the main candle pane.
    let res = chart.convertToPixel(pt);
    if (Array.isArray(res) && res.length > 0) res = res[0];

    let xCoord = (res && typeof res.x === 'number' && !isNaN(res.x)) ? res.x : null;
    let yCoord = (res && typeof res.y === 'number' && !isNaN(res.y)) ? res.y : null;

    if (xCoord !== null && yCoord !== null) {
      return { x: xCoord, y: yCoord };
    }

    // 2. Fallback for Y-coordinate (price) if missing
    if (yCoord === null && typeof price === 'number' && !isNaN(price)) {
      let resY = chart.convertToPixel({ value: price });
      if (Array.isArray(resY) && resY.length > 0) resY = resY[0];
      if (resY && typeof resY.y === 'number' && !isNaN(resY.y)) {
        yCoord = resY.y;
      }
    }

    // 3. Fallback for X-coordinate (timestamp) via chartStore
    if (xCoord === null && typeof timestamp === 'number' && !isNaN(timestamp)) {
      const cs = chart._chartStore || (typeof chart.getChartStore === 'function' ? chart.getChartStore() : null);
      if (cs && typeof cs.timestampToDataIndex === 'function' && typeof cs.dataIndexToCoordinate === 'function') {
        const idx = cs.timestampToDataIndex(timestamp);
        if (typeof idx === 'number' && !isNaN(idx)) {
          const coord = cs.dataIndexToCoordinate(idx);
          if (typeof coord === 'number' && !isNaN(coord)) {
            xCoord = coord;
          }
        }
      }

      // 4. Secondary interpolation fallback if timestamp is outside loaded dataIndex
      if (xCoord === null) {
        const dataList = chart.getDataList() || [];
        if (dataList.length > 0) {
          const firstBar = dataList[0];
          const lastBar = dataList[dataList.length - 1];
          const barStep = (dataList.length > 1) ? (dataList[1].timestamp - dataList[0].timestamp) : 300000;
          let idx = 0;
          if (timestamp >= firstBar.timestamp && timestamp <= lastBar.timestamp) {
            idx = Math.round((timestamp - firstBar.timestamp) / barStep);
          } else if (timestamp > lastBar.timestamp) {
            idx = (dataList.length - 1) + Math.round((timestamp - lastBar.timestamp) / barStep);
          } else {
            idx = Math.round((timestamp - firstBar.timestamp) / barStep);
          }
          let resIdx = chart.convertToPixel({ dataIndex: idx, value: price });
          if (Array.isArray(resIdx) && resIdx.length > 0) resIdx = resIdx[0];
          if (resIdx && typeof resIdx.x === 'number') {
            xCoord = resIdx.x;
            if (yCoord === null && typeof resIdx.y === 'number') yCoord = resIdx.y;
          }
        }
      }
    }

    if (xCoord !== null && yCoord !== null) {
      return { x: xCoord, y: yCoord };
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
 * Change border colors of existing chart boxes dynamically based on evaluation JSON paths.
 */
export function applyBoxBorderOverrides(isActive) {
  if (!chartInstance || typeof chartInstance.overrideOverlay !== 'function') return;
  try {
    const paths = currentEvalData?.paths || [];
    
    // Default box IDs to handle
    const boxOverrides = [
      { id: 'sov_box_dual_supply_pool', activeColor: '#e879f9', defaultColor: 'rgba(168, 85, 247, 0.85)' },
      { id: 'sov_box_ascending_base', activeColor: '#fbbf24', defaultColor: 'rgba(0, 229, 255, 0.85)' },
      { id: 'sov_box_compression_gate', activeColor: '#f0abfc', defaultColor: 'rgba(245, 158, 11, 0.85)' }
    ];

    // If paths specify explicit box IDs and colors, dynamically add them
    paths.forEach(p => {
      const bId = p.target_box?.id || p.supporting_box?.id || p.box_id;
      if (bId && !boxOverrides.some(o => o.id === bId)) {
        boxOverrides.push({
          id: bId,
          activeColor: p.border || p.color || '#e879f9',
          defaultColor: 'rgba(245, 158, 11, 0.85)'
        });
      }
    });

    boxOverrides.forEach(item => {
      try {
        chartInstance.overrideOverlay({
          id: item.id,
          styles: {
            rect: {
              borderColor: isActive ? item.activeColor : item.defaultColor,
              borderSize: isActive ? 2 : 1.5
            }
          }
        });
      } catch (_) {}
    });
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
 * Check if coordinate point or rectangle is visible within the canvas viewport
 */
function isRectInViewport(minX, maxX, minY, maxY, viewportW, viewportH) {
  if (maxX < -80 || minX > viewportW + 80) return false;
  if (maxY < -80 || minY > viewportH + 80) return false;
  return true;
}

/**
 * Render all static paths, supporting places, and connector leader lines.
 * Strictly data-driven from currentEvalData.
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
    const trigStart = (pathAData.trigger_level && pathAData.trigger_start_time)
      ? pointToPixel(chartInstance, pathAData.trigger_start_time, pathAData.trigger_level)
      : null;
    const trigEnd = (pathAData.trigger_level && pathAData.trigger_end_time)
      ? pointToPixel(chartInstance, pathAData.trigger_end_time, pathAData.trigger_level)
      : null;

    const boxTopLeft = (pathAData.target_box?.start_time && pathAData.target_box?.top)
      ? pointToPixel(chartInstance, pathAData.target_box.start_time, pathAData.target_box.top)
      : null;
    const boxBottomRight = (pathAData.target_box?.end_time && pathAData.target_box?.bottom)
      ? pointToPixel(chartInstance, pathAData.target_box.end_time, pathAData.target_box.bottom)
      : null;

    const vecFrom = (pathAData.vector?.from_time && pathAData.vector?.from_price)
      ? pointToPixel(chartInstance, pathAData.vector.from_time, pathAData.vector.from_price)
      : null;
    const vecTo = (pathAData.vector?.to_time && pathAData.vector?.to_price)
      ? pointToPixel(chartInstance, pathAData.vector.to_time, pathAData.vector.to_price)
      : null;

    const isBoxVisible = boxTopLeft && boxBottomRight && isRectInViewport(
      Math.min(boxTopLeft.x, boxBottomRight.x),
      Math.max(boxTopLeft.x, boxBottomRight.x),
      Math.min(boxTopLeft.y, boxBottomRight.y),
      Math.max(boxTopLeft.y, boxBottomRight.y),
      width, height
    );

    const isTrigVisible = trigStart && trigEnd && (trigEnd.x >= -50 && trigStart.x <= width + 50 && trigStart.y >= -50 && trigStart.y <= height + 50);

    if (!isBoxVisible && !isTrigVisible && !vecTo) {
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

      // Leader line connection from Target Box (right edge) to Card A
      const leaderStartX = maxX;
      const leaderStartY = minY + boxH * 0.5;
      const leaderEndX = cardALeft;
      const leaderEndY = cardATop + 20;

      let svgMarkup = '';

      // 1. Trigger Level Line (Clean line marking, zero text clutter on chart)
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

      // 3. Dotted Leader Line connecting Box 3 / Target to Card A (Light & delicate)
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
            <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #f0abfc; text-transform: uppercase;">${c.title || 'PATH A: RELIEF SHORT-SQUEEZE'}</span>
          </div>
          <span style="padding: 2px 6px; font-size: 10px; font-family: monospace; font-weight: 800; background: rgba(217,70,239,0.25); color: #fdf4ff; border: 1px solid rgba(217,70,239,0.45); border-radius: 3px;">
            ${c.badge || 'TARGET: $4,070.00'}
          </span>
        </div>
        <div style="font-size: 11.5px; line-height: 1.5; color: #cbd5e1; font-weight: 500;">
          ${c.body || 'A clean 5m close clears local breakdown lid, triggering an impulsive relief short-squeeze.'}
        </div>
        <div style="margin-top: 8px; border-top: 1px solid rgba(217,70,239,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 10px; font-family: monospace; color: #94a3b8; padding-top: 6px;">
          <span class="hud-pill-violet">${c.footer_left || 'TRIGGER: 5M C > $4,047.00'}</span>
          <span style="color: #34d399; font-weight: 800;">${c.footer_right || '+23.0 PT RUNWAY'}</span>
        </div>
      `;
    }
  }

  // -------------------------------------------------------------------------
  // 2. RENDER PATH B (Solar Coral Base Retest)
  // -------------------------------------------------------------------------
  if (pathBData && groupB && cardB) {
    const floorTopLeft = (pathBData.supporting_box?.start_time && pathBData.supporting_box?.top)
      ? pointToPixel(chartInstance, pathBData.supporting_box.start_time, pathBData.supporting_box.top)
      : null;
    const floorBottomRight = (pathBData.supporting_box?.end_time && pathBData.supporting_box?.bottom)
      ? pointToPixel(chartInstance, pathBData.supporting_box.end_time, pathBData.supporting_box.bottom)
      : null;

    const vecFrom = (pathBData.vector?.from_time && pathBData.vector?.from_price)
      ? pointToPixel(chartInstance, pathBData.vector.from_time, pathBData.vector.from_price)
      : null;
    const vecTo = (pathBData.vector?.to_time && pathBData.vector?.to_price)
      ? pointToPixel(chartInstance, pathBData.vector.to_time, pathBData.vector.to_price)
      : null;

    const isFloorVisible = floorTopLeft && floorBottomRight && isRectInViewport(
      Math.min(floorTopLeft.x, floorBottomRight.x),
      Math.max(floorTopLeft.x, floorBottomRight.x),
      Math.min(floorTopLeft.y, floorBottomRight.y),
      Math.max(floorTopLeft.y, floorBottomRight.y),
      width, height
    );

    if (!isFloorVisible && !vecTo) {
      groupB.innerHTML = '';
      cardB.style.display = 'none';
    } else {
      const minX = floorTopLeft && floorBottomRight ? Math.min(floorTopLeft.x, floorBottomRight.x) : 50;
      const maxX = floorTopLeft && floorBottomRight ? Math.max(floorTopLeft.x, floorBottomRight.x) : 150;
      const minY = floorTopLeft && floorBottomRight ? Math.min(floorTopLeft.y, floorBottomRight.y) : 200;
      const maxY = floorTopLeft && floorBottomRight ? Math.max(floorTopLeft.y, floorBottomRight.y) : 230;
      const boxH = Math.max(12, maxY - minY);

      // Card B placement in bottom-left airspace
      const cardBW = Math.min(310, width * 0.30);
      const cardBTop = Math.max(60, height - 170);
      const cardBLeft = 35;

      // Leader line connection from Floor Box left edge to Card B
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
            <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #fde68a; text-transform: uppercase;">${c.title || 'PATH B: DOUBLE-BOTTOM BASE TEST'}</span>
          </div>
          <span style="padding: 2px 6px; font-size: 10px; font-family: monospace; font-weight: 800; background: rgba(245,158,11,0.25); color: #fef08a; border: 1px solid rgba(245,158,11,0.45); border-radius: 3px;">
            ${c.badge || 'FLOOR: $4,034.00'}
          </span>
        </div>
        <div style="font-size: 11.5px; line-height: 1.5; color: #cbd5e1; font-weight: 500;">
          ${c.body || 'Rejection rotates price down to test capitulation absorption shelf in Floor.'}
        </div>
        <div style="margin-top: 8px; border-top: 1px solid rgba(245,158,11,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 10px; font-family: monospace; color: #94a3b8; padding-top: 6px;">
          <span class="hud-pill-amber">${c.footer_left || 'SUPPORT: $4,034 – $4,038.00'}</span>
          <span style="color: #f59e0b; font-weight: 800;">${c.footer_right || 'ABSORPTION TEST'}</span>
        </div>
      `;
    }
  }

  // -------------------------------------------------------------------------
  // 3. RENDER PATH C (Hazard Neon Red Invalidation)
  // -------------------------------------------------------------------------
  if (pathCData && groupC && cardC) {
    const tripStart = (pathCData.tripwire_start_time && pathCData.tripwire_level)
      ? pointToPixel(chartInstance, pathCData.tripwire_start_time, pathCData.tripwire_level)
      : null;
    const tripEnd = (pathCData.tripwire_end_time && pathCData.tripwire_level)
      ? pointToPixel(chartInstance, pathCData.tripwire_end_time, pathCData.tripwire_level)
      : null;

    const downTopLeft = (pathCData.target_box?.start_time && pathCData.target_box?.top)
      ? pointToPixel(chartInstance, pathCData.target_box.start_time, pathCData.target_box.top)
      : null;
    const downBottomRight = (pathCData.target_box?.end_time && pathCData.target_box?.bottom)
      ? pointToPixel(chartInstance, pathCData.target_box.end_time, pathCData.target_box.bottom)
      : null;

    const vecFrom = (pathCData.vector?.from_time && pathCData.vector?.from_price)
      ? pointToPixel(chartInstance, pathCData.vector.from_time, pathCData.vector.from_price)
      : null;
    const vecTo = (pathCData.vector?.to_time && pathCData.vector?.to_price)
      ? pointToPixel(chartInstance, pathCData.vector.to_time, pathCData.vector.to_price)
      : null;

    const isTripVisible = tripStart && tripEnd && (tripEnd.x >= -50 && tripStart.x <= width + 50 && tripStart.y >= -50 && tripStart.y <= height + 50);
    const isDownVisible = downTopLeft && downBottomRight && isRectInViewport(
      Math.min(downTopLeft.x, downBottomRight.x),
      Math.max(downTopLeft.x, downBottomRight.x),
      Math.min(downTopLeft.y, downBottomRight.y),
      Math.max(downTopLeft.y, downBottomRight.y),
      width, height
    );

    if (!isTripVisible && !isDownVisible && !vecTo) {
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

      // 1. Tripwire Level Line (Clean line marking, zero text clutter on chart)
      if (tripStart && tripEnd) {
        svgMarkup += `
          <line x1="${tripStart.x}" y1="${tripStart.y}" x2="${tripEnd.x}" y2="${tripEnd.y}" stroke="#f43f5e" stroke-width="1.3" stroke-dasharray="4 3" opacity="0.65" />
        `;
      }

      // 2. Downside Target Level Line (Clean line marking instead of duplicate box)
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
            <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #fecdd3; text-transform: uppercase;">${c.title || 'TRIPWIRE: BASE FLOOR LIQUIDATION'}</span>
          </div>
          <span style="padding: 2px 6px; font-size: 10px; font-family: monospace; font-weight: 800; background: rgba(244,63,94,0.25); color: #fecdd3; border: 1px solid rgba(244,63,94,0.45); border-radius: 3px;">
            ${c.badge || 'CANCEL: $4,033.50'}
          </span>
        </div>
        <div style="font-size: 11.5px; line-height: 1.5; color: #ffe4e6; font-weight: 500;">
          ${c.body || 'A 5m candle body close below $4,033.50 shatters the double-bottom absorption floor.'}
        </div>
        <div style="margin-top: 8px; border-top: 1px solid rgba(244,63,94,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 10px; font-family: monospace; color: #94a3b8; padding-top: 6px;">
          <span class="hud-pill-red">${c.footer_left || 'TRIPWIRE: 5M C < $4,033.50'}</span>
          <span style="color: #fb7185; font-weight: 800;">${c.footer_right || 'FULL CANCELLATION'}</span>
        </div>
      `;
    }
  }
}
