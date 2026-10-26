/**
 * Escanor Sovereign Causal Paths & HUD Story Overlay
 * Renders static, crisp architectural path vectors, exact supporting zone boxes,
 * and connected leader lines to chamfered cyberpunk HUD comment cards.
 * 
 * Strict Zero Animation / Zero Bubble aesthetic per Sovereign specifications.
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
let resizeDebounce = null;

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
      isOverlayVisible = !isOverlayVisible;
      localStorage.setItem('tv_sovereign_paths_visible', isOverlayVisible ? 'true' : 'false');
      applyVisibilityState();
      if (isOverlayVisible) {
        renderSovereignPaths();
      }
    });
  }

  // Setup Card Hover Isolations
  setupCardInteractions();

  // Subscribe to chart range changes if chart available
  if (chartInstance && typeof chartInstance.subscribeAction === 'function') {
    try {
      chartInstance.subscribeAction('onVisibleRangeChange', () => {
        if (isOverlayVisible && currentEvalData) {
          requestAnimationFrame(renderSovereignPaths);
        }
      });
    } catch (err) {
      console.warn('[Sovereign Paths] Could not subscribe to onVisibleRangeChange:', err);
    }
  }

  // Window resize handler
  window.addEventListener('resize', () => {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      if (isOverlayVisible && currentEvalData) {
        renderSovereignPaths();
      }
    }, 100);
  });
}

function applyVisibilityState() {
  if (toggleBtn) {
    if (isOverlayVisible) {
      toggleBtn.classList.add('active');
      toggleBtn.setAttribute('title', 'Causal Paths & Overlays: ON (Click to Hide)');
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
  if (isOverlayVisible) {
    requestAnimationFrame(renderSovereignPaths);
  }
}

/**
 * Render all static paths, supporting places, and connector leader lines
 */
export function renderSovereignPaths() {
  if (!overlayContainer || !currentEvalData || !isOverlayVisible) return;

  const rect = overlayContainer.getBoundingClientRect();
  const width = rect.width || 1024;
  const height = rect.height || 576;

  if (width < 200 || height < 150) return;

  // Set viewBox to current viewport pixels
  if (svgElement) {
    svgElement.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }

  const paths = currentEvalData.paths || [];
  const pathAData = paths.find(p => p.id === 'path_a') || paths[0];
  const pathBData = paths.find(p => p.id === 'path_b') || paths[1];
  const pathCData = paths.find(p => p.id === 'path_c') || paths[2];

  // Try to find candle coordinates or compute proportional airspace anchors
  let dataList = [];
  try {
    if (chartInstance && typeof chartInstance.getDataList === 'function') {
      dataList = chartInstance.getDataList() || [];
    }
  } catch (e) {}

  // Calculate anchor coordinates for latest candle
  let apexX = width * 0.68;
  let apexY = height * 0.55;

  // If chart.convertToPixel is available, find exact price coordinate pixels
  const getYForPrice = (price, fallbackRatio) => {
    try {
      if (chartInstance && typeof chartInstance.convertToPixel === 'function') {
        const px = chartInstance.convertToPixel([{ value: price }]);
        if (px && px[0] && typeof px[0].y === 'number' && !isNaN(px[0].y) && px[0].y > 20 && px[0].y < height - 30) {
          return px[0].y;
        }
      }
    } catch (e) {}
    return height * fallbackRatio;
  };

  const getXForBar = (barOffset, fallbackRatio) => {
    try {
      if (chartInstance && typeof chartInstance.convertToPixel === 'function' && dataList.length > 0) {
        const lastBar = dataList[dataList.length - 1];
        if (lastBar && lastBar.timestamp) {
          const px = chartInstance.convertToPixel([{ timestamp: lastBar.timestamp, value: lastBar.close }]);
          if (px && px[0] && typeof px[0].x === 'number' && !isNaN(px[0].x)) {
            return Math.max(80, Math.min(width - 120, px[0].x + barOffset));
          }
        }
      }
    } catch (e) {}
    return width * fallbackRatio;
  };

  apexX = getXForBar(0, 0.67);
  apexY = getYForPrice(4092.0, 0.55);

  // Position Coordinates for Cards (Zero-Overlap Airspace)
  // Card A: Top-Right
  const cardAW = Math.min(340, width * 0.33);
  const cardATop = 55;
  const cardALeft = width - cardAW - 25;

  // Card B: Bottom-Left
  const cardBW = Math.min(320, width * 0.31);
  const cardBTop = Math.max(cardATop + 160, height - 175);
  const cardBLeft = 35;

  // Card C: Bottom-Right
  const cardCW = Math.min(345, width * 0.33);
  const cardCTop = Math.max(cardATop + 160, height - 175);
  const cardCLeft = width - cardCW - 25;

  // -------------------------------------------------------------------------
  // 1. RENDER PATH A (Electric Violet Squeeze)
  // -------------------------------------------------------------------------
  if (pathAData && groupA && cardA) {
    const triggerY = getYForPrice(pathAData.trigger_level || 4094.0, 0.535);
    const targetTopY = getYForPrice(pathAData.target_box?.top || 4103.5, 0.495);
    const targetBottomY = getYForPrice(pathAData.target_box?.bottom || 4099.0, 0.518);
    const targetBoxH = Math.max(14, targetBottomY - targetTopY);

    const trigX1 = Math.max(50, apexX - 10);
    const trigX2 = Math.min(width - 50, apexX + 70);
    const targetBoxX = trigX2 + 8;
    const targetBoxW = Math.min(105, width - targetBoxX - 20);

    const vecStartX = trigX1 + 5;
    const vecStartY = apexY;
    const vecEndX = targetBoxX + targetBoxW * 0.35;
    const vecEndY = targetTopY + targetBoxH * 0.5;

    // Leader Line: Target Box right edge -> Card A left edge
    const leaderStartX = targetBoxX + targetBoxW * 0.5;
    const leaderStartY = targetTopY;
    const leaderCardX = cardALeft + 140;
    const leaderCardY = cardATop + 140;

    groupA.innerHTML = `
      <!-- 1. Breakout Trigger Shelf Line at $4,094.00 -->
      <line x1="${trigX1}" y1="${triggerY}" x2="${trigX2}" y2="${triggerY}" stroke="#f0abfc" stroke-width="1.6" stroke-dasharray="3 3" opacity="0.9" />
      <text x="${trigX1 + 2}" y="${triggerY - 4}" fill="#f5d0fe" font-size="9" font-family="'JetBrains Mono', monospace" font-weight="700">TRIGGER: $4,094.00</text>

      <!-- 2. Target Zone Box (Dual-Tops $4,099.00 - $4,103.50) -->
      <rect x="${targetBoxX}" y="${targetTopY}" width="${targetBoxW}" height="${targetBoxH}" fill="rgba(217, 70, 239, 0.16)" stroke="#e879f9" stroke-width="1.5" stroke-dasharray="4 2" rx="2" />
      <text x="${targetBoxX + 4}" y="${targetTopY + targetBoxH * 0.68}" fill="#f5d0fe" font-size="8" font-family="'JetBrains Mono', monospace" font-weight="700">TARGET: $4,099-$4,103.50</text>

      <!-- 3. Squeeze Path Vector (Clean Solid Arrow) -->
      <path d="M ${vecStartX} ${vecStartY} C ${vecStartX + 30} ${vecStartY - 5}, ${vecEndX - 25} ${vecEndY + 10}, ${vecEndX} ${vecEndY}" fill="none" stroke="#f0abfc" stroke-width="2.6" marker-end="url(#arrowViolet)" />

      <!-- 4. Connector Line: Target Box -> Top-Right HUD Card A -->
      <polyline points="${leaderStartX},${leaderStartY} ${leaderStartX},${cardATop + 15} ${cardALeft},${cardATop + 15}" fill="none" stroke="#e879f9" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.85" />
      <rect x="${leaderStartX - 3}" y="${leaderStartY - 3}" width="6" height="6" fill="#f0abfc" />
      <rect x="${cardALeft - 3}" y="${cardATop + 12}" width="6" height="6" fill="#e879f9" />
    `;

    // Render HTML Card A
    const c = pathAData.card || {};
    cardA.style.top = `${cardATop}px`;
    cardA.style.left = `${cardALeft}px`;
    cardA.style.width = `${cardAW}px`;
    cardA.style.display = 'block';
    cardA.innerHTML = `
      <div class="flex items-center justify-between border-b border-fuchsia-500/35 pb-1.5 mb-2" style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(217,70,239,0.35); padding-bottom: 6px; margin-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="width: 9px; height: 9px; border-radius: 2px; background: #d946ef; display: inline-block;"></span>
          <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #f0abfc; text-transform: uppercase;">${c.title || 'PATH A: ASCENDING SQUEEZE'}</span>
        </div>
        <span style="padding: 2px 6px; font-size: 10px; font-family: monospace; font-weight: 800; background: rgba(217,70,239,0.25); color: #fdf4ff; border: 1px solid rgba(217,70,239,0.45); border-radius: 3px;">
          ${c.badge || 'TARGET: $4,103.50'}
        </span>
      </div>
      <div style="font-size: 11.5px; line-height: 1.5; color: #cbd5e1; font-weight: 500;">
        ${c.body || 'A clean 5m candle close <strong>above $4,094.00</strong> breaks compression lid into target pool.'}
      </div>
      <div style="margin-top: 8px; pt: 6px; border-top: 1px solid rgba(217,70,239,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 10px; font-family: monospace; color: #94a3b8; padding-top: 6px;">
        <span class="cyber-stripes-violet" style="padding: 2px 6px; border-radius: 3px; color: #f0abfc; font-weight: 700;">${c.footer_left || 'TRIGGER: 5M C > $4,094.00'}</span>
        <span style="color: #34d399; font-weight: 800;">${c.footer_right || '+10.5 PT RUNWAY'}</span>
      </div>
    `;
  }

  // -------------------------------------------------------------------------
  // 2. RENDER PATH B (Solar Coral Base Retest)
  // -------------------------------------------------------------------------
  if (pathBData && groupB && cardB) {
    const floorTopY = getYForPrice(pathBData.supporting_box?.top || 4087.5, 0.57);
    const floorBottomY = getYForPrice(pathBData.supporting_box?.bottom || 4083.0, 0.59);
    const floorBoxH = Math.max(12, floorBottomY - floorTopY);

    const floorBoxX = Math.max(cardBLeft + cardBW + 15, apexX - 15);
    const floorBoxW = Math.min(100, width - floorBoxX - 40);

    const vecStartX = apexX;
    const vecStartY = apexY;
    const vecEndX = floorBoxX + floorBoxW * 0.45;
    const vecEndY = floorTopY + floorBoxH * 0.5;

    // Leader Line: Floor Box left edge -> Card B right edge
    const leaderStartX = floorBoxX;
    const leaderStartY = floorTopY + floorBoxH * 0.5;
    const leaderCardX = cardBLeft + cardBW;
    const leaderCardY = cardBTop + 25;

    groupB.innerHTML = `
      <!-- 1. Supporting Demand Floor Zone Box ($4,083.00 - $4,087.50) -->
      <rect x="${floorBoxX}" y="${floorTopY}" width="${floorBoxW}" height="${floorBoxH}" fill="rgba(245, 158, 11, 0.18)" stroke="#fbbf24" stroke-width="1.5" rx="2" />
      <text x="${floorBoxX + 4}" y="${floorTopY + floorBoxH * 0.72}" fill="#fef08a" font-size="8" font-family="'JetBrains Mono', monospace" font-weight="700">FLOOR: $4,083-$4,087.50</text>

      <!-- 2. Retest Path Vector (Clean Solid Arrow) -->
      <path d="M ${vecStartX} ${vecStartY} C ${vecStartX + 12} ${vecStartY + 2}, ${vecEndX - 10} ${vecEndY - 6}, ${vecEndX} ${vecEndY}" fill="none" stroke="#fbbf24" stroke-width="2.2" marker-end="url(#arrowAmber)" />

      <!-- 3. Connector Line: Floor Box -> Bottom-Left HUD Card B -->
      <polyline points="${leaderStartX},${leaderStartY} ${leaderStartX - 25},${leaderStartY} ${leaderStartX - 25},${leaderCardY} ${leaderCardX},${leaderCardY}" fill="none" stroke="#fbbf24" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.85" />
      <rect x="${leaderStartX - 3}" y="${leaderStartY - 3}" width="6" height="6" fill="#fde68a" />
      <rect x="${leaderCardX - 3}" y="${leaderCardY - 3}" width="6" height="6" fill="#fbbf24" />
    `;

    // Render HTML Card B
    const c = pathBData.card || {};
    cardB.style.top = `${cardBTop}px`;
    cardB.style.left = `${cardBLeft}px`;
    cardB.style.width = `${cardBW}px`;
    cardB.style.display = 'block';
    cardB.innerHTML = `
      <div class="flex items-center justify-between border-b border-amber-500/35 pb-1.5 mb-2" style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(245,158,11,0.35); padding-bottom: 6px; margin-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="width: 9px; height: 9px; border-radius: 2px; background: #fbbf24; display: inline-block;"></span>
          <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #fde68a; text-transform: uppercase;">${c.title || 'PATH B: COIL BASE RETEST'}</span>
        </div>
        <span style="padding: 2px 6px; font-size: 10px; font-family: monospace; font-weight: 800; background: rgba(245,158,11,0.25); color: #fef08a; border: 1px solid rgba(245,158,11,0.45); border-radius: 3px;">
          ${c.badge || 'FLOOR: $4,083.00'}
        </span>
      </div>
      <div style="font-size: 11.5px; line-height: 1.5; color: #cbd5e1; font-weight: 500;">
        ${c.body || 'Rejection off $4,093.50 rotates price down to test ascending higher-low shelf in Floor Box ($4,083 – $4,087.50).'}
      </div>
      <div style="margin-top: 8px; border-top: 1px solid rgba(245,158,11,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 10px; font-family: monospace; color: #94a3b8; padding-top: 6px;">
        <span class="cyber-stripes-amber" style="padding: 2px 6px; border-radius: 3px; color: #fef08a; font-weight: 700;">${c.footer_left || 'SUPPORT: $4,083 – $4,087.50'}</span>
        <span style="color: #f59e0b; font-weight: 800;">${c.footer_right || 'LPS ACCUMULATION'}</span>
      </div>
    `;
  }

  // -------------------------------------------------------------------------
  // 3. RENDER PATH C (Hazard Neon Red Invalidation)
  // -------------------------------------------------------------------------
  if (pathCData && groupC && cardC) {
    const tripwireY = getYForPrice(pathCData.tripwire_level || 4082.5, 0.60);
    const downTopY = getYForPrice(pathCData.target_box?.top || 4070.0, 0.65);
    const downBottomY = getYForPrice(pathCData.target_box?.bottom || 4066.5, 0.67);
    const downBoxH = Math.max(12, downBottomY - downTopY);

    const tripX1 = Math.max(60, apexX - 25);
    const tripX2 = Math.min(cardCLeft - 15, apexX + 80);

    const downBoxX = Math.min(width - 150, tripX2 + 10);
    const downBoxW = Math.min(95, width - downBoxX - 20);

    const vecStartX = tripX1 + 50;
    const vecStartY = tripwireY;
    const vecEndX = downBoxX + downBoxW * 0.3;
    const vecEndY = downTopY + downBoxH * 0.5;

    // Leader Line: Tripwire Line right edge -> Card C left edge
    const leaderStartX = tripX2;
    const leaderStartY = tripwireY;
    const leaderCardX = cardCLeft;
    const leaderCardY = cardCTop + 25;

    groupC.innerHTML = `
      <!-- 1. Tripwire Level Line at $4,082.50 -->
      <line x1="${tripX1}" y1="${tripwireY}" x2="${tripX2}" y2="${tripwireY}" stroke="#f43f5e" stroke-width="1.8" stroke-dasharray="4 2" />
      <text x="${tripX1 + 2}" y="${tripwireY - 4}" fill="#fecdd3" font-size="8.5" font-family="'JetBrains Mono', monospace" font-weight="800">TRIPWIRE: $4,082.50</text>

      <!-- 2. Downside Target Markdown Zone Box ($4,066.50 - $4,070.00) -->
      <rect x="${downBoxX}" y="${downTopY}" width="${downBoxW}" height="${downBoxH}" fill="rgba(239, 68, 68, 0.2)" stroke="#f43f5e" stroke-width="1.5" stroke-dasharray="3 2" rx="2" />
      <text x="${downBoxX + 4}" y="${downTopY + downBoxH * 0.72}" fill="#fecdd3" font-size="7.5" font-family="'JetBrains Mono', monospace" font-weight="700">DOWN: $4,066.50-$4,070</text>

      <!-- 3. Breakdown Cascade Vector (Clean Solid Arrow) -->
      <path d="M ${vecStartX} ${vecStartY} C ${vecStartX + 20} ${vecStartY + 6}, ${vecEndX - 15} ${vecEndY - 4}, ${vecEndX} ${vecEndY}" fill="none" stroke="#f43f5e" stroke-width="2.2" marker-end="url(#arrowRed)" />

      <!-- 4. Connector Line: Tripwire Line -> Bottom-Right HUD Card C -->
      <polyline points="${leaderStartX},${leaderStartY} ${leaderStartX + 20},${leaderStartY} ${leaderStartX + 20},${leaderCardY} ${leaderCardX},${leaderCardY}" fill="none" stroke="#f43f5e" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.85" />
      <rect x="${leaderStartX - 3}" y="${leaderStartY - 3}" width="6" height="6" fill="#fecdd3" />
      <rect x="${leaderCardX - 3}" y="${leaderCardY - 3}" width="6" height="6" fill="#f43f5e" />
    `;

    // Render HTML Card C
    const c = pathCData.card || {};
    cardC.style.top = `${cardCTop}px`;
    cardC.style.left = `${cardCLeft}px`;
    cardC.style.width = `${cardCW}px`;
    cardC.style.display = 'block';
    cardC.innerHTML = `
      <div class="flex items-center justify-between border-b border-rose-500/35 pb-1.5 mb-2" style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(244,63,94,0.35); padding-bottom: 6px; margin-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="width: 9px; height: 9px; border-radius: 2px; background: #f43f5e; display: inline-block;"></span>
          <span style="font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #fecdd3; text-transform: uppercase;">${c.title || 'TRIPWIRE: ASCENDING FLOOR BREACH'}</span>
        </div>
        <span style="padding: 2px 6px; font-size: 10px; font-family: monospace; font-weight: 800; background: rgba(244,63,94,0.25); color: #fecdd3; border: 1px solid rgba(244,63,94,0.45); border-radius: 3px;">
          ${c.badge || 'CANCEL: $4,082.50'}
        </span>
      </div>
      <div style="font-size: 11.5px; line-height: 1.5; color: #ffe4e6; font-weight: 500;">
        ${c.body || 'A 5m candle body close below $4,082.50 shatters ascending structure into cascade target ($4,070 – $4,066).'}
      </div>
      <div style="margin-top: 8px; border-top: 1px solid rgba(244,63,94,0.25); display: flex; align-items: center; justify-content: space-between; font-size: 10px; font-family: monospace; color: #94a3b8; padding-top: 6px;">
        <span class="cyber-stripes-red" style="padding: 2px 6px; border-radius: 3px; color: #fecdd3; font-weight: 700;">${c.footer_left || 'TRIPWIRE: 5M C < $4,082.50'}</span>
        <span style="color: #fb7185; font-weight: 800;">${c.footer_right || 'FULL CANCELLATION'}</span>
      </div>
    `;
  }
}
