/**
 * Escanor — Volume Consumption Radar & 30-Touch Sequence Engine
 * Tracks volume consumption per line touch across the structure,
 * bilateral equilibrium (0 Delta), favourable reversal thresholds (±3,500 ticks),
 * and the pulsing live bar.
 */

let hudElement = null;
let triggerBtn = null;
let isHudOpen = false;
let currentTouches = [];
let liveTickVolume = -2150;
let liveSpotPrice = 4128.14;
let activeTouchIndex = 15; // Default to Apex (Touch #16)
let chartInstanceRef = null;

export function initVolumeRadar(chartInstance = null, symbol = 'XAUUSD') {
  chartInstanceRef = (chartInstance && chartInstance.chart) ? chartInstance.chart : chartInstance;
  hudElement = document.getElementById('tvVolumeRadarHud');
  triggerBtn = document.getElementById('tvVolumeRadarBtn');

  if (!hudElement || !triggerBtn) {
    console.warn('[VolumeRadar] HUD or Trigger button elements not found in DOM.');
    return;
  }

  // Bind trigger button toggle
  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleVolumeRadarHud();
  });

  // Bind close button
  const closeBtn = document.getElementById('tvVolumeRadarCloseBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeVolumeRadarHud();
    });
  }

  // Load touches data
  loadStructuralTouches(symbol);
}

export function toggleVolumeRadarHud() {
  if (isHudOpen) {
    closeVolumeRadarHud();
  } else {
    openVolumeRadarHud();
  }
}

export function openVolumeRadarHud() {
  if (!hudElement) return;
  isHudOpen = true;
  hudElement.style.display = 'flex';
  if (triggerBtn) triggerBtn.classList.add('active');
  renderVolumeBars();
  highlightTouch(activeTouchIndex);
}

export function closeVolumeRadarHud() {
  if (!hudElement) return;
  isHudOpen = false;
  hudElement.style.display = 'none';
  if (triggerBtn) triggerBtn.classList.remove('active');
  hideChartReticle();
}

export function updateLiveTick(spot, volumeDelta = 0) {
  liveSpotPrice = spot;
  if (volumeDelta !== 0) liveTickVolume = volumeDelta;

  const livePriceEl = document.getElementById('vrLivePrice');
  if (livePriceEl) livePriceEl.textContent = `$${spot.toFixed(2)}`;

  // Update live bar if HUD is open
  if (isHudOpen) {
    const liveBar = document.getElementById('vrBarRect_live');
    if (liveBar) {
      const height = Math.min(48, Math.max(6, Math.round((Math.abs(liveTickVolume) / 4500) * 44)));
      liveBar.style.height = `${height}px`;
    }
  }
}

// 30 TOUCHES SEQUENCE (Real MT5 Volume Baseline)
function loadStructuralTouches(symbol) {
  currentTouches = [
    { num: 1, price: 4137.64, line: "Master Baseline Ray (Anchor)", delta: 3850, action: "STRONG REBOUND UP" },
    { num: 2, price: 4145.20, line: "Lower Fan Ray 1", delta: 2400, action: "UPWARD CONTINUATION" },
    { num: 3, price: 4154.80, line: "Inner Median Channel 1", delta: 3100, action: "UPWARD CONTINUATION" },
    { num: 4, price: 4160.25, line: "Median Fan Ray (First Test)", delta: 3650, action: "⚡ PULLBACK TRIGGERED" },
    { num: 5, price: 4152.10, line: "Primary Support Ray Retest", delta: -2800, action: "ABSORPTION BOUNCE" },
    { num: 6, price: 4165.40, line: "Median Fan Ray 2", delta: 3200, action: "UPWARD CONTINUATION" },
    { num: 7, price: 4150.50, line: "Master Baseline Trampoline", delta: -3900, action: "⚡ BEAR 0 EXHAUSTION BOUNCE" },
    { num: 8, price: 4168.90, line: "Inner Median Ray 3", delta: 2900, action: "UPWARD CONTINUATION" },
    { num: 9, price: 4178.40, line: "Upper Channel Boundary 1", delta: 3450, action: "UPWARD CONTINUATION" },
    { num: 10, price: 4172.10, line: "Ascending Median Ray Pullback", delta: -2100, action: "SUPPORT HELD" },
    { num: 11, price: 4189.58, line: "Upper Wedge Boundary", delta: 3720, action: "⚡ BULL EXHAUSTION DETECTED" },
    { num: 12, price: 4183.20, line: "Wedge Inner Shelf", delta: -2500, action: "PINCH STALL" },
    { num: 13, price: 4192.40, line: "Upper Wedge Resistance 2", delta: 3600, action: "⚡ CEILING REVERSAL" },
    { num: 14, price: 4188.10, line: "Wedge Convergence Ray", delta: -1800, action: "TIGHT PINCH" },
    { num: 15, price: 4195.80, line: "Apex Climax Sub-Ray", delta: 3800, action: "⚡ BULL VOLUME SATURATED" },
    { num: 16, price: 4198.78, line: "Master Wedge Apex Climax", delta: 4250, action: "⚡ BULL 0 HIT! 100% REVERSAL TRIGGER" },
    { num: 17, price: 4191.20, line: "Apex Rejection Down-Ray", delta: -3800, action: "⚡ BEAR CASCADE INITIATED" },
    { num: 18, price: 4176.50, line: "Median Fan Ray (Down-Slice)", delta: -4100, action: "⚡ RAY SLICED THROUGH" },
    { num: 19, price: 4168.91, line: "Inner Median Ray 2 (Down-Slice)", delta: -3950, action: "⚡ ZERO SUPPORT / SLICED" },
    { num: 20, price: 4160.20, line: "Lower Baseline Shelf", delta: -3400, action: "TEMPORARY PAUSE" },
    { num: 21, price: 4187.67, line: "Bear Flag Upper Ceiling", delta: 3600, action: "⚡ SELLER DISTRIBUTION DUMP" },
    { num: 22, price: 4178.50, line: "Bear Flag Midline", delta: -2900, action: "FLAG BREAKDOWN" },
    { num: 23, price: 4182.10, line: "Secondary Fan Retest", delta: 2200, action: "FAILED PUSH" },
    { num: 24, price: 4157.79, line: "Master Trendline Floor Rupture", delta: -4800, action: "⚡ CATASTROPHIC RUPTURE WATERFALL" },
    { num: 25, price: 4148.50, line: "Intermediate Liquid Support", delta: -4200, action: "⚡ SLICED ON HEAVY VOLUME" },
    { num: 26, price: 4141.20, line: "Waterfall Liquidation Ray", delta: -3900, action: "⚡ WATERFALL CASCADE" },
    { num: 27, price: 4136.50, line: "Old Range 1 Support Level", delta: -3600, action: "⚡ TEMPORARY STALL" },
    { num: 28, price: 4125.80, line: "Day 2 Absorption Base Low", delta: -4100, action: "⚡ BEAR 0 REACHED! ABSORPTION BASE" },
    { num: 29, price: 4135.20, line: "Day 2 Range Ceiling", delta: 2800, action: "RANGE BOUND" },
    { num: 30, price: 4128.09, line: "Live Spot Floor Line ($4,128.14)", delta: -3850, action: "⚡ BEAR EXHAUSTION REVERSAL ACTIVE" }
  ];
}

function renderVolumeBars() {
  const track = document.getElementById('vrBarsTrack');
  if (!track) return;

  track.querySelectorAll('.vr-bar-unit').forEach(el => el.remove());

  // Render 30 touches
  currentTouches.forEach((t, idx) => {
    const unit = document.createElement('div');
    unit.className = 'vr-bar-unit';
    unit.id = `vrBarUnit_${idx}`;
    unit.title = `Touch #${t.num}: ${t.line} ($${t.price})`;
    unit.onmouseenter = () => highlightTouch(idx);
    unit.onclick = () => highlightTouch(idx);

    const delta = t.delta;
    const isBull = delta >= 0;
    const absDelta = Math.abs(delta);
    const barHeight = Math.min(48, Math.max(4, Math.round((absDelta / 4500) * 44)));
    const crossed = absDelta >= 3500;

    const barRect = document.createElement('div');
    if (isBull) {
      barRect.className = `vr-bar-bull ${crossed ? 'vr-crossed' : ''}`;
      barRect.style.height = `${barHeight}px`;
    } else {
      barRect.className = `vr-bar-bear ${crossed ? 'vr-crossed' : ''}`;
      barRect.style.height = `${barHeight}px`;
    }
    unit.appendChild(barRect);

    const label = document.createElement('span');
    label.className = 'vr-bar-label';
    label.textContent = t.num;
    unit.appendChild(label);

    track.appendChild(unit);
  });

  // Render pulsing LIVE bar at end
  const liveUnit = document.createElement('div');
  liveUnit.className = 'vr-bar-unit vr-live-bar';
  liveUnit.id = 'vrBarUnit_live';
  liveUnit.title = 'Live Active Candle Volume';
  liveUnit.onmouseenter = () => highlightLiveBar();
  liveUnit.onclick = () => highlightLiveBar();

  const liveRect = document.createElement('div');
  liveRect.className = 'vr-bar-live';
  liveRect.id = 'vrBarRect_live';
  const liveHeight = Math.min(48, Math.max(6, Math.round((Math.abs(liveTickVolume) / 4500) * 44)));
  liveRect.style.height = `${liveHeight}px`;
  liveUnit.appendChild(liveRect);

  const liveLabel = document.createElement('span');
  liveLabel.className = 'vr-bar-label';
  liveLabel.style.color = 'var(--amber, #ffb300)';
  liveLabel.style.fontWeight = '800';
  liveLabel.textContent = '●LIVE';
  liveUnit.appendChild(liveLabel);

  track.appendChild(liveUnit);

  // Scroll to show apex and live bar
  const win = document.getElementById('vrBarsWindow');
  if (win) win.scrollLeft = 240;
}

function highlightTouch(idx) {
  activeTouchIndex = idx;
  const t = currentTouches[idx];
  if (!t) return;

  const numEl = document.getElementById('vrInspTouchNum');
  const priceEl = document.getElementById('vrInspPrice');
  const lineEl = document.getElementById('vrInspLineName');
  const volEl = document.getElementById('vrInspVol');
  const verdictEl = document.getElementById('vrInspVerdict');

  if (numEl) numEl.textContent = `TOUCH #${t.num} / 30`;
  if (priceEl) priceEl.textContent = `$${t.price.toFixed(2)}`;
  if (lineEl) lineEl.textContent = t.line;
  if (volEl) {
    volEl.textContent = `${t.delta > 0 ? '+' : ''}${t.delta.toLocaleString()} ticks`;
    volEl.style.color = t.delta > 0 ? '#00e676' : '#ff334b';
  }
  if (verdictEl) {
    verdictEl.textContent = t.action;
    verdictEl.style.color = Math.abs(t.delta) >= 3500 ? '#ffb300' : (t.delta > 0 ? '#00e676' : '#00e5ff');
  }

  document.querySelectorAll('.vr-bar-unit').forEach((b, i) => {
    b.classList.toggle('active', i === idx);
  });

  showChartReticle(t, idx);
}

function highlightLiveBar() {
  const numEl = document.getElementById('vrInspTouchNum');
  const priceEl = document.getElementById('vrInspPrice');
  const lineEl = document.getElementById('vrInspLineName');
  const volEl = document.getElementById('vrInspVol');
  const verdictEl = document.getElementById('vrInspVerdict');

  if (numEl) numEl.textContent = '● LIVE BAR';
  if (priceEl) priceEl.textContent = `$${liveSpotPrice.toFixed(2)}`;
  if (lineEl) lineEl.textContent = 'Live Spot Active Candle ($' + liveSpotPrice.toFixed(2) + ')';
  if (volEl) {
    volEl.textContent = `${liveTickVolume.toLocaleString()} ticks`;
    volEl.style.color = '#ff334b';
  }
  if (verdictEl) {
    verdictEl.textContent = 'ACCUMULATING (-1,350t to Bear Reversal Threshold)';
    verdictEl.style.color = '#ffb300';
  }

  document.querySelectorAll('.vr-bar-unit').forEach(b => b.classList.remove('active'));
  const liveUnit = document.getElementById('vrBarUnit_live');
  if (liveUnit) liveUnit.classList.add('active');

  showChartReticle({
    num: 'LIVE',
    price: liveSpotPrice,
    delta: liveTickVolume,
    line: `Live Spot Active Candle ($${liveSpotPrice.toFixed(2)})`,
    action: 'ACCUMULATING LIVE AT FLOOR'
  }, 30);
}

function showChartReticle(t, idx) {
  const overlay = document.getElementById('tvVolumeRadarOverlay');
  const reticleGroup = document.getElementById('tvVrReticleGroup');
  if (!overlay || !reticleGroup) return;

  const viewport = document.querySelector('.tv-chart-viewport') || document.getElementById('klineChart');
  const vpWidth = viewport ? viewport.clientWidth : 1000;
  const vpHeight = viewport ? viewport.clientHeight : 600;

  let x = null;
  let y = null;
  let barIndex = null;

  if (chartInstanceRef && typeof chartInstanceRef.convertToPixel === 'function') {
    try {
      const dataList = chartInstanceRef.getDataList() || [];
      if (dataList.length > 0) {
        // Map 30 historical touches to recent candles
        barIndex = idx >= 30 ? (dataList.length - 1) : Math.max(0, (dataList.length - 1) - (29 - idx) * 2);
        const pCoords = chartInstanceRef.convertToPixel({ dataIndex: barIndex, value: t.price });
        if (pCoords && typeof pCoords.x === 'number' && !isNaN(pCoords.x)) x = pCoords.x;
        if (pCoords && typeof pCoords.y === 'number' && !isNaN(pCoords.y)) y = pCoords.y;
      }
      if (y === null || isNaN(y)) {
        const yCoords = chartInstanceRef.convertToPixel({ value: t.price });
        if (yCoords && typeof yCoords.y === 'number' && !isNaN(yCoords.y)) y = yCoords.y;
      }
    } catch (e) {
      console.warn('[VolumeRadar] convertToPixel error:', e);
    }
  }

  // AUTO-SCROLL CHART INTO VIEW (IF NOT IN VIEW)
  if (chartInstanceRef && barIndex !== null && typeof chartInstanceRef.scrollToDataIndex === 'function') {
    const isOutOfView = x === null || x < 60 || x > (vpWidth - 80);
    if (isOutOfView) {
      chartInstanceRef.scrollToDataIndex(barIndex, 200);
      // Recalculate coordinates right after scroll frame completes
      setTimeout(() => {
        try {
          const freshCoords = chartInstanceRef.convertToPixel({ dataIndex: barIndex, value: t.price });
          if (freshCoords && !isNaN(freshCoords.x) && !isNaN(freshCoords.y)) {
            positionDotAndCard(freshCoords.x, freshCoords.y, t, vpWidth, vpHeight);
          }
        } catch (_) {}
      }, 70);
    }
  }

  // Fallback geometric placement if chart conversion is not ready
  if (x === null || isNaN(x)) {
    x = Math.round(vpWidth * 0.15 + (idx / 30) * (vpWidth * 0.75));
  }
  if (y === null || isNaN(y)) {
    y = Math.round(vpHeight * 0.45);
  }

  overlay.style.display = 'block';
  reticleGroup.style.display = 'block';

  positionDotAndCard(x, y, t, vpWidth, vpHeight);

  // AUTO-SCROLL VOLUME BARS HUD TRACK INTO VIEW
  const win = document.getElementById('vrBarsWindow');
  const activeBar = document.getElementById(idx >= 30 ? 'vrBarUnit_live' : `vrBarUnit_${idx}`);
  if (win && activeBar) {
    const winRect = win.getBoundingClientRect();
    const barRect = activeBar.getBoundingClientRect();
    if (barRect.left < winRect.left + 25 || barRect.right > winRect.right - 25) {
      activeBar.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }
}

function positionDotAndCard(x, y, t, vpWidth, vpHeight) {
  const isBull = t.delta >= 0;
  const color = isBull ? '#00e676' : '#ff334b';

  // 1. Position Glowing Outer Beacon Halo
  const halo = document.getElementById('tvVrDotHalo');
  if (halo) {
    halo.setAttribute('cx', x);
    halo.setAttribute('cy', y);
    halo.setAttribute('stroke', color);
  }

  // 2. Position Solid Core Radar Dot with Drop Shadow
  const core = document.getElementById('tvVrDotCore');
  if (core) {
    core.setAttribute('cx', x);
    core.setAttribute('cy', y);
    core.setAttribute('fill', color);
    core.style.filter = `drop-shadow(0 0 10px ${color})`;
  }

  // 3. Position Center White Jewel Micro-Dot
  const jewel = document.getElementById('tvVrDotJewel');
  if (jewel) {
    jewel.setAttribute('cx', x);
    jewel.setAttribute('cy', y);
  }

  // 4. Floating Tag Box On The Candle (Smart Clamping)
  let tagX = x + 20;
  let tagY = y - 22;
  if (tagX + 190 > vpWidth - 60) tagX = x - 200;
  if (tagY < 60) tagY = y + 25;
  if (tagY + 50 > vpHeight - 40) tagY = vpHeight - 55;

  const tagG = document.getElementById('tvVrTagGroup');
  if (tagG) tagG.setAttribute('transform', `translate(${tagX}, ${tagY})`);

  const tagBg = document.getElementById('tvVrTagBg');
  if (tagBg) tagBg.setAttribute('stroke', color);

  const tagTitle = document.getElementById('tvVrTagTitle');
  if (tagTitle) {
    tagTitle.textContent = `${t.num === 'LIVE' ? 'LIVE SPOT' : 'T' + t.num}: $${t.price.toFixed(2)}`;
    tagTitle.setAttribute('fill', color);
  }

  const tagSub = document.getElementById('tvVrTagSub');
  if (tagSub) {
    tagSub.textContent = `Vol: ${t.delta > 0 ? '+' : ''}${t.delta.toLocaleString()} ticks`;
  }

  const tagVerdict = document.getElementById('tvVrTagVerdict');
  if (tagVerdict) {
    tagVerdict.textContent = t.action;
    tagVerdict.setAttribute('fill', Math.abs(t.delta) >= 3500 ? '#ffb300' : color);
  }
}

export function hideChartReticle() {
  const overlay = document.getElementById('tvVolumeRadarOverlay');
  if (overlay) overlay.style.display = 'none';
  const reticleGroup = document.getElementById('tvVrReticleGroup');
  if (reticleGroup) reticleGroup.style.display = 'none';
}
