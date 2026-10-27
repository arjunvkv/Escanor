/**
 * Escanor Sovereign Causal Paths & HUD Story Overlay
 * Renders static, crisp architectural path vectors, exact supporting zone lines,
 * and connected leader lines to chamfered cyberpunk HUD comment cards.
 * 
 * 100% Data-Driven & Viewport-Aware:
 * - NO hardcoded setup prices or timestamps; strictly projected from evaluation JSON.
 * - Robust KLineCharts coordinate projection (works in all panes and viewports).
 * - Safe Airspace Card Placement: Card A at top-right (clearing top ribbon & right Y-axis),
 *   Card B at bottom-left (clearing left sidebar), Card C at bottom-right (clearing right Y-axis).
 * - Off-screen clipping: When setup is scrolled away, markings and cards cleanly hide.
 * - When setup is in view, lines, arrows, leader lines, and cards render crisply glued to candles.
 * - ZERO text clutter on chart tape (prices, conditions & stories live inside HUD comment cards).
 * - Subtle, delicate vectors and leader lines (stroke 1.1-1.6px, opacity 0.40-0.65).
 */

let overlayContainer = null;
let svgElement = null;
let groupA = null;
let groupB = null;
let groupC = null;
let groupBenchmarks = null;
let cardA = null;
let cardB = null;
let cardC = null;
let toggleBtn = null;
let btnCards = null;
let btnBenchmarks = null;
let chartInstance = null;
let currentEvalData = null;
let isOverlayVisible = true;
let isCardsVisible = true;
let isBenchmarksVisible = true;
let isDraggingChart = false;
let rafId = null;

/**
 * Initialize Sovereign Paths Overlay and wire sidebar toggle buttons
 */
export function initSovereignPathsOverlay(chart) {
  chartInstance = chart;
  overlayContainer = document.getElementById('tvSovereignPathsOverlay');
  svgElement = document.getElementById('tvSovereignPathsSvg');
  groupA = document.getElementById('svgGroupPathA');
  groupB = document.getElementById('svgGroupPathB');
  groupC = document.getElementById('svgGroupPathC');
  groupBenchmarks = document.getElementById('svgGroupBenchmarks');
  cardA = document.getElementById('hudCardPathA');
  cardB = document.getElementById('hudCardPathB');
  cardC = document.getElementById('hudCardPathC');
  toggleBtn = document.getElementById('tvSidebarPathsToggleBtn');
  btnCards = document.getElementById('tvSidebarCardsToggleBtn');
  btnBenchmarks = document.getElementById('tvSidebarBenchmarksBtn');

  // Load saved visibility states from localStorage (defaults: true)
  const savedState = localStorage.getItem('tv_sovereign_paths_visible');
  isOverlayVisible = (savedState !== null) ? (savedState === 'true') : true;

  const savedCards = localStorage.getItem('tv_cards_visible');
  isCardsVisible = (savedCards !== null) ? (savedCards === 'true') : true;

  const savedBenchmarks = localStorage.getItem('tv_benchmarks_visible');
  isBenchmarksVisible = (savedBenchmarks !== null) ? (savedBenchmarks === 'true') : true;

  applyVisibilityState();

  // Wire Sidebar Toggle Button (Causal Paths)
  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      
      // If already active and clicked while setup is off-screen, smoothly jump to setup!
      if (isOverlayVisible && currentEvalData?.anchor_timestamp) {
        const anchorPt = pointToPixel(chartInstance, currentEvalData.anchor_timestamp, 4020.0);
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

  // Wire Discrete Feature Toggle Buttons
  if (btnCards) {
    btnCards.classList.toggle('active', isCardsVisible);
    btnCards.addEventListener('click', (e) => {
      e.stopPropagation();
      isCardsVisible = !isCardsVisible;
      localStorage.setItem('tv_cards_visible', isCardsVisible ? 'true' : 'false');
      btnCards.classList.toggle('active', isCardsVisible);
      applyVisibilityState();
      showToast(isCardsVisible ? '⚡ Strategy HUD Boxes: ON' : 'Strategy HUD Boxes: OFF');
      requestAnimationFrame(renderSovereignPaths);
    });
  }

  if (btnBenchmarks) {
    btnBenchmarks.classList.toggle('active', isBenchmarksVisible);
    btnBenchmarks.addEventListener('click', (e) => {
      e.stopPropagation();
      isBenchmarksVisible = !isBenchmarksVisible;
      localStorage.setItem('tv_benchmarks_visible', isBenchmarksVisible ? 'true' : 'false');
      btnBenchmarks.classList.toggle('active', isBenchmarksVisible);
      applyVisibilityState();
      showToast(isBenchmarksVisible ? '📏 Canonical Benchmarks (PDH/PDL): ON' : 'Canonical Benchmarks: OFF');
      requestAnimationFrame(renderSovereignPaths);
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

  window.__renderSovereignPaths = renderSovereignPaths;
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
 * Robust Y-pixel projection: Convert price to exact on-screen canvas Y pixel coordinate.
 * Multi-tier fallback guarantees coordinate retrieval regardless of whether chart has loaded bars or data indices.
 */
export function priceToPixelY(chart, price) {
  if (!chart || typeof price !== 'number' || isNaN(price)) return null;
  try {
    // 1. Direct convertToPixel on main candle pane
    let res = chart.convertToPixel({ value: price });
    if (Array.isArray(res) && res.length > 0) res = res[0];
    if (res && typeof res.y === 'number' && !isNaN(res.y)) {
      return res.y;
    }

    // 2. Fallback with dataIndex 0
    let res2 = chart.convertToPixel({ dataIndex: 0, value: price });
    if (Array.isArray(res2) && res2.length > 0) res2 = res2[0];
    if (res2 && typeof res2.y === 'number' && !isNaN(res2.y)) {
      return res2.y;
    }

    // 3. Fallback with current anchor timestamp
    if (currentEvalData?.anchor_timestamp) {
      let res3 = chart.convertToPixel({ timestamp: currentEvalData.anchor_timestamp, value: price });
      if (Array.isArray(res3) && res3.length > 0) res3 = res3[0];
      if (res3 && typeof res3.y === 'number' && !isNaN(res3.y)) {
        return res3.y;
      }
    }

    // 4. Fallback with latest candle timestamp
    const dataList = (typeof chart.getDataList === 'function') ? (chart.getDataList() || []) : [];
    if (dataList.length > 0) {
      const lastCandle = dataList[dataList.length - 1];
      if (lastCandle && lastCandle.timestamp) {
        let res4 = chart.convertToPixel({ timestamp: lastCandle.timestamp, value: price });
        if (Array.isArray(res4) && res4.length > 0) res4 = res4[0];
        if (res4 && typeof res4.y === 'number' && !isNaN(res4.y)) {
          return res4.y;
        }
      }
    }
  } catch (e) {
    console.warn('[Sovereign Paths] priceToPixelY error:', e);
  }
  return null;
}

/**
 * Robust coordinate projection: Convert timestamp and price to exact on-screen canvas pixel coordinates.
 */
export function pointToPixel(chart, timestamp, price) {
  if (!chart) return null;
  try {
    const pt = {};
    if (typeof timestamp === 'number' && !isNaN(timestamp)) pt.timestamp = timestamp;
    if (typeof price === 'number' && !isNaN(price)) pt.value = price;

    // 1. Direct KLineCharts convertToPixel call on main pane
    let res = chart.convertToPixel(pt);
    if (Array.isArray(res) && res.length > 0) res = res[0];

    let xCoord = (res && typeof res.x === 'number' && !isNaN(res.x)) ? res.x : null;
    let yCoord = (res && typeof res.y === 'number' && !isNaN(res.y)) ? res.y : null;

    if (xCoord !== null && yCoord !== null) {
      return { x: xCoord, y: yCoord };
    }

    // If only price was requested (timestamp null/undefined) and yCoord exists, return it immediately
    if ((timestamp === null || timestamp === undefined) && yCoord !== null) {
      return { x: null, y: yCoord };
    }

    // 2. Fallback for Y-coordinate (price) if missing
    if (yCoord === null && typeof price === 'number' && !isNaN(price)) {
      yCoord = priceToPixelY(chart, price);
    }

    if ((timestamp === null || timestamp === undefined) && yCoord !== null) {
      return { x: null, y: yCoord };
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
    if ((timestamp === null || timestamp === undefined) && yCoord !== null) {
      return { x: null, y: yCoord };
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

  const isAnyActive = () => isOverlayVisible || isBenchmarksVisible;

  const startDrag = () => {
    isDraggingChart = true;
    cancelAnimationFrame(rafId);
    const loop = () => {
      if (!isDraggingChart) return;
      if (isAnyActive()) {
        renderSovereignPaths();
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  };

  const stopDrag = () => {
    isDraggingChart = false;
    cancelAnimationFrame(rafId);
    if (isAnyActive()) {
      renderSovereignPaths();
    }
  };

  chartContainer.addEventListener('mousedown', startDrag);
  window.addEventListener('mouseup', stopDrag);
  chartContainer.addEventListener('touchstart', startDrag, { passive: true });
  window.addEventListener('touchend', stopDrag);

  chartContainer.addEventListener('wheel', () => {
    if (isAnyActive()) {
      requestAnimationFrame(renderSovereignPaths);
    }
  }, { passive: true });

  if (chartInstance && typeof chartInstance.subscribeAction === 'function') {
    try {
      chartInstance.subscribeAction('onVisibleRangeChange', () => {
        if (isAnyActive()) {
          requestAnimationFrame(renderSovereignPaths);
        }
      });
      chartInstance.subscribeAction('onScroll', () => {
        if (isAnyActive()) {
          requestAnimationFrame(renderSovereignPaths);
        }
      });
      chartInstance.subscribeAction('onZoom', () => {
        if (isAnyActive()) {
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
  const isAnyLayerVisible = isOverlayVisible || isCardsVisible || isBenchmarksVisible;

  if (toggleBtn) {
    if (isOverlayVisible) {
      toggleBtn.classList.add('active');
      toggleBtn.setAttribute('title', 'Causal Paths & Overlays: ON (Click to Hide, DblClick to Focus Setup)');
    } else {
      toggleBtn.classList.remove('active');
      toggleBtn.setAttribute('title', 'Causal Paths & Overlays: OFF (Click to Show)');
    }
  }

  if (btnCards) btnCards.classList.toggle('active', isCardsVisible);
  if (btnBenchmarks) btnBenchmarks.classList.toggle('active', isBenchmarksVisible);

  if (overlayContainer) {
    if (isAnyLayerVisible) {
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
    
    // Default box IDs to handle with light and thin (1.0px) solid borders (matching dashed markings)
    const boxOverrides = [
      { id: 'sov_box_ascending_base', activeColor: 'rgba(251, 191, 36, 0.45)', defaultColor: 'rgba(0, 229, 255, 0.35)', fillColor: 'rgba(251, 191, 36, 0.03)' },
      { id: 'sov_box_dual_supply_pool', activeColor: 'rgba(232, 121, 249, 0.45)', defaultColor: 'rgba(236, 64, 122, 0.35)', fillColor: 'rgba(232, 121, 249, 0.03)' },
      { id: 'sov_box_compression_gate', activeColor: 'rgba(240, 171, 252, 0.45)', defaultColor: 'rgba(245, 158, 11, 0.35)', fillColor: 'rgba(240, 171, 252, 0.03)' },
      { id: 'box_phase_1_flush', activeColor: 'rgba(244, 63, 94, 0.65)', defaultColor: 'rgba(244, 63, 94, 0.35)', fillColor: 'rgba(244, 63, 94, 0.03)' },
      { id: 'box_phase_2_impulse', activeColor: 'rgba(0, 229, 255, 0.65)', defaultColor: 'rgba(0, 229, 255, 0.35)', fillColor: 'rgba(0, 229, 255, 0.03)' },
      { id: 'box_phase_3_climax', activeColor: 'rgba(251, 191, 36, 0.65)', defaultColor: 'rgba(251, 191, 36, 0.35)', fillColor: 'rgba(251, 191, 36, 0.03)' },
      { id: 'box_phase_4_coil', activeColor: 'rgba(168, 85, 247, 0.65)', defaultColor: 'rgba(168, 85, 247, 0.35)', fillColor: 'rgba(168, 85, 247, 0.03)' }
    ];

    // If paths specify explicit box IDs and colors, dynamically add them
    paths.forEach(p => {
      const bId = p.target_box?.id || p.supporting_box?.id || p.box_id;
      if (bId && !boxOverrides.some(o => o.id === bId)) {
        boxOverrides.push({
          id: bId,
          activeColor: p.border || p.color || 'rgba(232, 121, 249, 0.45)',
          defaultColor: 'rgba(245, 158, 11, 0.35)',
          fillColor: 'rgba(232, 121, 249, 0.03)'
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
              borderSize: 1.0,
              color: item.fillColor || 'rgba(0, 0, 0, 0.02)'
            }
          }
        });
      } catch (_) {}
    });

    // Also match any user-drawn rect overlay by price coordinates!
    const allOverlays = (typeof chartInstance.getOverlays === 'function') ? (chartInstance.getOverlays() || []) : [];
    const rects = allOverlays.filter(ov => ov.name === 'rect');
    rects.forEach(r => {
      if (boxOverrides.some(o => o.id === r.id)) return; // already handled by exact ID
      const pts = r.points || [];
      if (pts.length < 2) return;
      const vals = pts.map(p => p.value).filter(v => typeof v === 'number');
      if (vals.length < 2) return;
      const rMin = Math.min(...vals);
      const rMax = Math.max(...vals);

      paths.forEach(p => {
        const box = p.target_box || p.supporting_box;
        if (box && typeof box.bottom === 'number' && typeof box.top === 'number') {
          const bMin = Math.min(box.bottom, box.top);
          const bMax = Math.max(box.bottom, box.top);
          const overlap = Math.max(0, Math.min(rMax, bMax) - Math.max(rMin, bMin));
          const span = Math.min(rMax - rMin, bMax - bMin);
          if (span > 0 && (overlap / span) >= 0.45) {
            try {
              chartInstance.overrideOverlay({
                id: r.id,
                styles: {
                  rect: {
                    borderColor: isActive ? (p.border || p.color || 'rgba(232, 121, 249, 0.50)') : 'rgba(236, 64, 122, 0.40)',
                    borderSize: 1.0
                  }
                }
              });
            } catch (_) {}
          }
        }
      });
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
  window.__lastEvaluationData = evalData;
  applyBoxBorderOverrides(isOverlayVisible);
  if (isOverlayVisible) {
    requestAnimationFrame(renderSovereignPaths);
  }
}

/**
 * Check if coordinate point or rectangle is visible horizontally within the canvas viewport (with 120px tolerance)
 */
function isHorizontallyInViewport(minX, maxX, viewportW) {
  if (maxX < -120 || minX > viewportW + 120) return false;
  return true;
}

/**
 * Check if coordinate rectangle is visible within the canvas viewport
 */
function isRectInViewport(minX, maxX, minY, maxY, viewportW, viewportH) {
  return isHorizontallyInViewport(minX, maxX, viewportW);
}

/**
 * Check if a vector is in viewport
 */
function isVectorInViewport(vFrom, vTo, viewportW, viewportH) {
  if (!vFrom && !vTo) return false;
  const x1 = vFrom ? vFrom.x : vTo.x;
  const x2 = vTo ? vTo.x : vFrom.x;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  return isHorizontallyInViewport(minX, maxX, viewportW);
}

/**
 * Render all static paths, supporting places, and connector leader lines.
 * Strictly data-driven from currentEvalData.
 */
export function renderSovereignPaths() {
  if (!overlayContainer || !chartInstance) return;

  const rect = overlayContainer.getBoundingClientRect();
  const width = rect.width || 1024;
  const height = rect.height || 576;

  if (width < 200 || height < 150) return;

  // Set viewBox to current viewport pixels
  if (svgElement) {
    svgElement.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  // Safe Airspace Dimensions (Avoid top ribbon and right price-axis scale)
  const rightAxisMargin = 75; // Right price scale width + margin
  const topRibbonMargin = 95; // Top macro ribbon height + margin
  const leftSidebarMargin = 65; // Left toolbar width + margin

  // -------------------------------------------------------------------------
  // 1, 2, 3: RENDER CAUSAL PATHS & HUD COMMENT CARDS (if active & eval data exists)
  // -------------------------------------------------------------------------
  if (!isOverlayVisible || !currentEvalData) {
    if (groupA) groupA.innerHTML = '';
    if (groupB) groupB.innerHTML = '';
    if (groupC) groupC.innerHTML = '';
    if (cardA) cardA.style.display = 'none';
    if (cardB) cardB.style.display = 'none';
    if (cardC) cardC.style.display = 'none';
    applyBoxBorderOverrides(false);
  } else {
    // Ensure box border colors remain tinted
    applyBoxBorderOverrides(true);

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

    const targetStart = (pathAData.target_level && pathAData.target_start_time)
      ? pointToPixel(chartInstance, pathAData.target_start_time, pathAData.target_level)
      : null;
    const targetEnd = (pathAData.target_level && pathAData.target_end_time)
      ? pointToPixel(chartInstance, pathAData.target_end_time, pathAData.target_level)
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

    const isBoxVisible = boxTopLeft && boxBottomRight && isHorizontallyInViewport(
      Math.min(boxTopLeft.x, boxBottomRight.x),
      Math.max(boxTopLeft.x, boxBottomRight.x),
      width
    );

    const isTrigVisible = trigStart && trigEnd && isHorizontallyInViewport(
      Math.min(trigStart.x, trigEnd.x),
      Math.max(trigStart.x, trigEnd.x),
      width
    );

    const isTargetVisible = targetStart && targetEnd && isHorizontallyInViewport(
      Math.min(targetStart.x, targetEnd.x),
      Math.max(targetStart.x, targetEnd.x),
      width
    );

    const isVecVisible = isVectorInViewport(vecFrom, vecTo, width, height);

    if (!isBoxVisible && !isTrigVisible && !isTargetVisible && !isVecVisible) {
      groupA.innerHTML = '';
      cardA.style.display = 'none';
    } else {
      const minX = boxTopLeft && boxBottomRight ? Math.min(boxTopLeft.x, boxBottomRight.x) : (targetStart ? targetStart.x : (trigStart ? trigStart.x : 0));
      const maxX = boxTopLeft && boxBottomRight ? Math.max(boxTopLeft.x, boxBottomRight.x) : (targetEnd ? targetEnd.x : (trigEnd ? trigEnd.x : 100));
      const minY = boxTopLeft && boxBottomRight ? Math.min(boxTopLeft.y, boxBottomRight.y) : (targetStart ? targetStart.y : (trigStart ? trigStart.y - 15 : 0));
      const maxY = boxTopLeft && boxBottomRight ? Math.max(boxTopLeft.y, boxBottomRight.y) : (targetEnd ? targetEnd.y : (trigStart ? trigStart.y + 15 : 30));
      const boxH = Math.max(12, maxY - minY);

      // Card A placement in top-right airspace (Clearing top ribbon and right price-axis)
      const cardAW = Math.min(310, Math.max(260, width * 0.28));
      const cardATop = topRibbonMargin;
      const cardALeft = width - cardAW - rightAxisMargin;

      // Leader line connection from Target Line / Target Box to Card A
      const leaderStartX = Math.max(10, Math.min(width - rightAxisMargin, targetEnd ? targetEnd.x : maxX));
      const rawStartY = targetEnd ? targetEnd.y : (boxTopLeft ? (minY + boxH * 0.5) : (trigEnd ? trigEnd.y : 50));
      const leaderStartY = Math.max(15, Math.min(height - 25, rawStartY));
      const leaderEndX = cardALeft;
      const leaderEndY = cardATop + 20;

      let svgMarkup = '';

      // 1. Trigger Level Line (Clean line marking, zero text clutter on chart)
      if (trigStart && trigEnd) {
        svgMarkup += `
          <line x1="${trigStart.x}" y1="${trigStart.y}" x2="${trigEnd.x}" y2="${trigEnd.y}" stroke="rgba(240, 171, 252, 0.70)" stroke-width="1.2" stroke-dasharray="4 3" />
        `;
      }

      // 2. Target Level Line (Clean line marking instead of empty-space box)
      if (targetStart && targetEnd) {
        svgMarkup += `
          <line x1="${targetStart.x}" y1="${targetStart.y}" x2="${targetEnd.x}" y2="${targetEnd.y}" stroke="rgba(232, 121, 249, 0.75)" stroke-width="1.2" stroke-dasharray="4 3" />
        `;
      }

      // 3. Squeeze Vector Arrow (Light & subtle)
      if (vecFrom && vecTo) {
        svgMarkup += `
          <path d="M ${vecFrom.x} ${vecFrom.y} C ${vecFrom.x + (vecTo.x - vecFrom.x) * 0.5} ${vecFrom.y - 4}, ${vecTo.x - 20} ${vecTo.y + 8}, ${vecTo.x} ${vecTo.y}" fill="none" stroke="rgba(240, 171, 252, 0.65)" stroke-width="1.5" marker-end="url(#arrowViolet)" />
        `;
      }

      // 4. Dotted Leader Line connecting Target Line / Box to Card A (Light & delicate)
      if (isCardsVisible && (isBoxVisible || isTrigVisible || isTargetVisible)) {
        svgMarkup += `
          <polyline points="${leaderStartX},${leaderStartY} ${leaderStartX + 20},${leaderStartY} ${leaderStartX + 20},${leaderEndY} ${leaderEndX},${leaderEndY}" fill="none" stroke="rgba(232, 121, 249, 0.40)" stroke-width="1.1" stroke-dasharray="3 3" opacity="0.40" />
          <circle cx="${leaderStartX}" cy="${leaderStartY}" r="2" fill="#f0abfc" opacity="0.6" />
          <circle cx="${leaderEndX}" cy="${leaderEndY}" r="2" fill="#e879f9" opacity="0.6" />
        `;
      }

      groupA.innerHTML = svgMarkup;

      // Update Card A HUD (Minimal, intelligent, zero-loss)
      const c = pathAData.card || {};
      cardA.style.top = `${cardATop}px`;
      cardA.style.bottom = 'auto';
      cardA.style.left = `${cardALeft}px`;
      cardA.style.width = `${cardAW}px`;
      cardA.style.display = isCardsVisible ? 'block' : 'none';
      cardA.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(217,70,239,0.35); padding-bottom: 5px; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="width: 8px; height: 8px; border-radius: 2px; background: #d946ef; display: inline-block;"></span>
            <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #f0abfc; text-transform: uppercase;">${c.title || 'PATH A: CEILING SWEEP FADE'}</span>
          </div>
          <span style="padding: 1.5px 6px; font-size: 9.5px; font-family: monospace; font-weight: 800; background: rgba(217,70,239,0.25); color: #fdf4ff; border: 1px solid rgba(217,70,239,0.45); border-radius: 3px;">
            ${c.badge || 'TP1: $4,018.12 | BE LOCK'}
          </span>
        </div>
        <div style="font-size: 11px; line-height: 1.45; color: #cbd5e1; font-weight: 500;">
          ${c.body || 'Trigger: Sweep $4,026.75 ➔ M5 Close &lt; $4,026.00'}
        </div>
        <div style="margin-top: 6px; border-top: 1px solid rgba(217,70,239,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 9.5px; font-family: monospace; color: #94a3b8; padding-top: 5px; gap: 8px;">
          <span class="hud-pill-violet" style="white-space: nowrap;">${c.footer_left || 'ENTRY: $4,026.00 | SL: $4,028.50'}</span>
          <span style="color: #34d399; font-weight: 800; white-space: nowrap;">${c.footer_right || '0-LOSS PROTOCOL 🛡️'}</span>
        </div>
      `;
    }
  }

  // -------------------------------------------------------------------------
  // 2. RENDER PATH B (Solar Coral Base Retest)
  // -------------------------------------------------------------------------
  if (pathBData && groupB && cardB) {
    const floorStart = (pathBData.floor_level && pathBData.floor_start_time)
      ? pointToPixel(chartInstance, pathBData.floor_start_time, pathBData.floor_level)
      : null;
    const floorEnd = (pathBData.floor_level && pathBData.floor_end_time)
      ? pointToPixel(chartInstance, pathBData.floor_end_time, pathBData.floor_level)
      : null;

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

    const isFloorLineVisible = floorStart && floorEnd && isHorizontallyInViewport(
      Math.min(floorStart.x, floorEnd.x),
      Math.max(floorStart.x, floorEnd.x),
      width
    );
    const isFloorVisible = floorTopLeft && floorBottomRight && isHorizontallyInViewport(
      Math.min(floorTopLeft.x, floorBottomRight.x),
      Math.max(floorTopLeft.x, floorBottomRight.x),
      width
    );
    const isVecVisible = isVectorInViewport(vecFrom, vecTo, width, height);

    if (!isFloorLineVisible && !isFloorVisible && !isVecVisible) {
      groupB.innerHTML = '';
      cardB.style.display = 'none';
    } else {
      const minX = floorTopLeft && floorBottomRight ? Math.min(floorTopLeft.x, floorBottomRight.x) : (floorStart ? floorStart.x : 50);
      const maxX = floorTopLeft && floorBottomRight ? Math.max(floorTopLeft.x, floorBottomRight.x) : (floorEnd ? floorEnd.x : 150);
      const minY = floorTopLeft && floorBottomRight ? Math.min(floorTopLeft.y, floorBottomRight.y) : (floorStart ? floorStart.y : 200);
      const maxY = floorTopLeft && floorBottomRight ? Math.max(floorTopLeft.y, floorBottomRight.y) : (floorEnd ? floorEnd.y : 230);
      const boxH = Math.max(12, maxY - minY);

      // Card B placement in bottom-left airspace (Clearing left sidebar, anchored to bottom to NEVER overflow)
      const cardBW = Math.min(320, Math.max(270, width * 0.28));
      const cardBLeft = leftSidebarMargin;
      const cardBTopApprox = Math.max(topRibbonMargin + 20, height - (cardB.offsetHeight || 115) - 28);

      // Leader line connection from Floor Line / Box left edge to Card B
      const leaderStartX = Math.max(10, Math.min(width - 50, floorStart ? floorStart.x : minX));
      const rawStartY = floorTopLeft ? (minY + boxH * 0.5) : (floorStart ? floorStart.y : (vecTo ? vecTo.y : height - 100));
      const leaderStartY = Math.max(15, Math.min(height - 25, rawStartY));
      const leaderEndX = cardBLeft + cardBW;
      const leaderEndY = cardBTopApprox + 20;

      let svgMarkup = '';

      // 1. Floor Line Marking (Clean dashed line, zero text clutter)
      if (floorStart && floorEnd) {
        svgMarkup += `
          <line x1="${floorStart.x}" y1="${floorStart.y}" x2="${floorEnd.x}" y2="${floorEnd.y}" stroke="#fbbf24" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.65" />
        `;
      }

      // 2. Retest Path Vector (Light & subtle)
      if (vecFrom && vecTo) {
        svgMarkup += `
          <path d="M ${vecFrom.x} ${vecFrom.y} C ${vecFrom.x + 10} ${vecFrom.y + 2}, ${vecTo.x - 10} ${vecTo.y - 6}, ${vecTo.x} ${vecTo.y}" fill="none" stroke="#fbbf24" stroke-width="1.6" opacity="0.65" marker-end="url(#arrowAmber)" />
        `;
      }

      // 3. Connector Line: Box 1 / Floor Line left edge -> Bottom-Left HUD Card B (Light & delicate)
      if (isCardsVisible && (isFloorVisible || isFloorLineVisible)) {
        svgMarkup += `
          <polyline points="${leaderStartX},${leaderStartY} ${leaderStartX - 25},${leaderStartY} ${leaderStartX - 25},${leaderEndY} ${leaderEndX},${leaderEndY}" fill="none" stroke="#fbbf24" stroke-width="1.1" stroke-dasharray="3 3" opacity="0.40" />
          <circle cx="${leaderStartX}" cy="${leaderStartY}" r="2" fill="#fde68a" opacity="0.6" />
          <circle cx="${leaderEndX}" cy="${leaderEndY}" r="2" fill="#fbbf24" opacity="0.6" />
        `;
      }

      groupB.innerHTML = svgMarkup;

      // Update Card B HUD (Anchor to bottom: 28px so it never overflows viewport)
      const c = pathBData.card || {};
      cardB.style.top = 'auto';
      cardB.style.bottom = '28px';
      cardB.style.left = `${cardBLeft}px`;
      cardB.style.width = `${cardBW}px`;
      cardB.style.display = isCardsVisible ? 'block' : 'none';
      cardB.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(245,158,11,0.35); padding-bottom: 5px; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="width: 8px; height: 8px; border-radius: 2px; background: #fbbf24; display: inline-block;"></span>
            <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #fde68a; text-transform: uppercase;">${c.title || 'PATH B: DEMAND SHELF RETEST'}</span>
          </div>
          <span style="padding: 1.5px 6px; font-size: 9.5px; font-family: monospace; font-weight: 800; background: rgba(245,158,11,0.25); color: #fef08a; border: 1px solid rgba(245,158,11,0.45); border-radius: 3px;">
            ${c.badge || 'FLOOR: $4,021.50'}
          </span>
        </div>
        <div style="font-size: 11px; line-height: 1.45; color: #cbd5e1; font-weight: 500;">
          ${c.body || 'Entry: $4,018.00 POC (Dry Vol)'}
        </div>
        <div style="margin-top: 6px; border-top: 1px solid rgba(245,158,11,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 9.5px; font-family: monospace; color: #94a3b8; padding-top: 5px; gap: 8px;">
          <span class="hud-pill-amber" style="white-space: nowrap;">${c.footer_left || 'ENTRY: $4,018.00 | SL: $4,013.75'}</span>
          <span style="color: #f59e0b; font-weight: 800; white-space: nowrap;">${c.footer_right || '1:7+ RR ASYMMETRY 🛡️'}</span>
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

    const targetStart = (pathCData.target_level && pathCData.target_start_time)
      ? pointToPixel(chartInstance, pathCData.target_start_time, pathCData.target_level)
      : null;
    const targetEnd = (pathCData.target_level && pathCData.target_end_time)
      ? pointToPixel(chartInstance, pathCData.target_end_time, pathCData.target_level)
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

    const isTripVisible = tripStart && tripEnd && isHorizontallyInViewport(
      Math.min(tripStart.x, tripEnd.x),
      Math.max(tripStart.x, tripEnd.x),
      width
    );
    const isTargetVisible = targetStart && targetEnd && isHorizontallyInViewport(
      Math.min(targetStart.x, targetEnd.x),
      Math.max(targetStart.x, targetEnd.x),
      width
    );
    const isDownVisible = downTopLeft && downBottomRight && isHorizontallyInViewport(
      Math.min(downTopLeft.x, downBottomRight.x),
      Math.max(downTopLeft.x, downBottomRight.x),
      width
    );
    const isVecVisible = isVectorInViewport(vecFrom, vecTo, width, height);

    if (!isTripVisible && !isTargetVisible && !isDownVisible && !isVecVisible) {
      groupC.innerHTML = '';
      cardC.style.display = 'none';
    } else {
      const minX = downTopLeft && downBottomRight ? Math.min(downTopLeft.x, downBottomRight.x) : (targetStart ? targetStart.x : (tripStart ? tripStart.x : 0));
      const maxX = downTopLeft && downBottomRight ? Math.max(downTopLeft.x, downBottomRight.x) : (targetEnd ? targetEnd.x : (tripEnd ? tripEnd.x : 100));
      const minY = downTopLeft && downBottomRight ? Math.min(downTopLeft.y, downBottomRight.y) : (targetStart ? targetStart.y : (tripStart ? tripStart.y + 10 : 0));
      const maxY = downTopLeft && downBottomRight ? Math.max(downTopLeft.y, downBottomRight.y) : (targetEnd ? targetEnd.y : (tripStart ? tripStart.y + 25 : 30));
      const downLineY = (minY + maxY) * 0.5;

      // Card C placement in bottom-right airspace (Clearing right price axis, anchored to bottom to NEVER overflow)
      const cardCW = Math.min(320, Math.max(260, width * 0.28));
      const cardCLeft = width - cardCW - rightAxisMargin;
      const cardCTopApprox = Math.max(topRibbonMargin + 20, height - (cardC.offsetHeight || 115) - 28);

      // Leader line connection from Target / Tripwire Line right coordinate to Card C
      const leaderStartX = Math.max(10, Math.min(width - rightAxisMargin, targetEnd ? targetEnd.x : (tripEnd ? tripEnd.x : maxX)));
      const rawStartY = targetEnd ? targetEnd.y : (tripEnd ? tripEnd.y : downLineY);
      const leaderStartY = Math.max(15, Math.min(height - 25, rawStartY));
      const leaderEndX = cardCLeft;
      const leaderEndY = cardCTopApprox + 20;

      let svgMarkup = '';

      // 1. Tripwire Level Line (Clean line marking, zero text clutter on chart)
      if (tripStart && tripEnd) {
        svgMarkup += `
          <line x1="${tripStart.x}" y1="${tripStart.y}" x2="${tripEnd.x}" y2="${tripEnd.y}" stroke="#f43f5e" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.65" />
        `;
      }

      // 2. Downside Target Level Line (Clean line marking instead of duplicate box)
      if (targetStart && targetEnd) {
        svgMarkup += `
          <line x1="${targetStart.x}" y1="${targetStart.y}" x2="${targetEnd.x}" y2="${targetEnd.y}" stroke="#f43f5e" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.60" />
        `;
      } else if (downTopLeft && downBottomRight) {
        svgMarkup += `
          <line x1="${minX}" y1="${downLineY}" x2="${maxX}" y2="${downLineY}" stroke="#f43f5e" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.55" />
        `;
      }

      // 3. Breakdown Cascade Vector (Light & subtle)
      if (vecFrom && vecTo) {
        svgMarkup += `
          <path d="M ${vecFrom.x} ${vecFrom.y} C ${vecFrom.x + 15} ${vecFrom.y + 4}, ${vecTo.x - 10} ${vecTo.y - 4}, ${vecTo.x} ${vecTo.y}" fill="none" stroke="#f43f5e" stroke-width="1.6" opacity="0.65" marker-end="url(#arrowRed)" />
        `;
      }

      // 4. Connector Line: Tripwire Line -> Bottom-Right HUD Card C (Light & delicate)
      if (isCardsVisible && (isTripVisible || isTargetVisible || isDownVisible)) {
        svgMarkup += `
          <polyline points="${leaderStartX},${leaderStartY} ${leaderStartX + 20},${leaderStartY} ${leaderStartX + 20},${leaderEndY} ${leaderEndX},${leaderEndY}" fill="none" stroke="#f43f5e" stroke-width="1.1" stroke-dasharray="3 3" opacity="0.40" />
          <circle cx="${leaderStartX}" cy="${leaderStartY}" r="2" fill="#fecdd3" opacity="0.6" />
          <circle cx="${leaderEndX}" cy="${leaderEndY}" r="2" fill="#f43f5e" opacity="0.6" />
        `;
      }

      groupC.innerHTML = svgMarkup;

      // Update Card C HUD (Anchor to bottom: 28px so it never overflows viewport)
      const c = pathCData.card || {};
      cardC.style.top = 'auto';
      cardC.style.bottom = '28px';
      cardC.style.left = `${cardCLeft}px`;
      cardC.style.width = `${cardCW}px`;
      cardC.style.display = isCardsVisible ? 'block' : 'none';
      cardC.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(244,63,94,0.35); padding-bottom: 5px; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="width: 8px; height: 8px; border-radius: 2px; background: #f43f5e; display: inline-block;"></span>
            <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #fecdd3; text-transform: uppercase;">${c.title || 'PATH C: COIL BREAKDOWN (ZERO-LOSS SHORT)'}</span>
          </div>
          <span style="padding: 1.5px 6px; font-size: 9.5px; font-family: monospace; font-weight: 800; background: rgba(244,63,94,0.25); color: #fecdd3; border: 1px solid rgba(244,63,94,0.45); border-radius: 3px;">
            ${c.badge || 'TP1: $4,008.00 | BE LOCK'}
          </span>
        </div>
        <div style="font-size: 11px; line-height: 1.45; color: #ffe4e6; font-weight: 500;">
          ${c.body || 'Tripwire: M5 Close &lt; $4,014.50 (Coil Floor Break)'}
        </div>
        <div style="margin-top: 6px; border-top: 1px solid rgba(244,63,94,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 9.5px; font-family: monospace; color: #94a3b8; padding-top: 5px; gap: 8px;">
          <span class="hud-pill-red" style="white-space: nowrap;">${c.footer_left || 'ENTRY: $4,014.25 | SL: $4,016.50'}</span>
          <span style="color: #fb7185; font-weight: 800; white-space: nowrap;">${c.footer_right || 'FULL CANCELLATION 🛡️'}</span>
        </div>
      `;
    }
  }
  }

  // -------------------------------------------------------------------------
  // 4. RENDER CANONICAL BENCHMARKS (PDH / PDL)
  // -------------------------------------------------------------------------
  renderBenchmarks(width, height);
}

/**
 * Render Canonical Benchmarks (PDH $4,034.07, PDL $3,975.58)
 */
function renderBenchmarks(width, height) {
  if (!groupBenchmarks) return;
  if (!isBenchmarksVisible) {
    groupBenchmarks.innerHTML = '';
    return;
  }
  const pdhPrice = window.__liveTelemetry?.pdh || currentEvalData?.pdh || 4034.07;
  const pdlPrice = window.__liveTelemetry?.pdl || currentEvalData?.pdl || 3975.58;

  const pdhY = priceToPixelY(chartInstance, pdhPrice);
  const pdlY = priceToPixelY(chartInstance, pdlPrice);
  let markup = '';
  const startX = 65;
  const endX = width - 75;

  // 1. PDH Benchmark Line
  if (pdhY !== null) {
    if (pdhY >= 0 && pdhY <= height) {
      markup += `
        <line x1="${startX}" y1="${pdhY}" x2="${endX}" y2="${pdhY}" stroke="#c084fc" stroke-width="1.0" stroke-dasharray="5 4" opacity="0.75" />
        <circle cx="${startX}" cy="${pdhY}" r="2.5" fill="#c084fc" opacity="0.9" />
        <circle cx="${endX}" cy="${pdhY}" r="2.5" fill="#c084fc" opacity="0.9" />
        <polygon points="${endX},${pdhY} ${endX - 6},${pdhY - 4} ${endX - 12},${pdhY} ${endX - 6},${pdhY + 4}" fill="#c084fc" opacity="0.95" />
      `;
    } else if (pdhY < 0) {
      markup += `
        <polygon points="${width - 105},13 ${width - 100},5 ${width - 95},13" fill="#c084fc" opacity="0.9" />
        <line x1="${width - 125}" y1="13" x2="${width - 75}" y2="13" stroke="#c084fc" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.8" />
      `;
    }
  }

  // 2. PDL Benchmark Line
  if (pdlY !== null) {
    if (pdlY >= 0 && pdlY <= height) {
      markup += `
        <line x1="${startX}" y1="${pdlY}" x2="${endX}" y2="${pdlY}" stroke="#10b981" stroke-width="1.0" stroke-dasharray="5 4" opacity="0.70" />
        <circle cx="${startX}" cy="${pdlY}" r="2.5" fill="#10b981" opacity="0.9" />
        <circle cx="${endX}" cy="${pdlY}" r="2.5" fill="#10b981" opacity="0.9" />
        <polygon points="${endX},${pdlY} ${endX - 6},${pdlY - 4} ${endX - 12},${pdlY} ${endX - 6},${pdlY + 4}" fill="#10b981" opacity="0.95" />
      `;
    } else if (pdlY > height) {
      markup += `
        <polygon points="${width - 105},${height - 13} ${width - 100},${height - 5} ${width - 95},${height - 13}" fill="#10b981" opacity="0.9" />
        <line x1="${width - 125}" y1="${height - 13}" x2="${width - 75}" y2="${height - 13}" stroke="#10b981" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.8" />
      `;
    }
  }

  groupBenchmarks.innerHTML = markup;
}
