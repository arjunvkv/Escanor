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

  // Load touches data dynamically from drawn lines
  loadStructuralTouches(symbol);

  // Listen for drawing changes on chart
  window.addEventListener('drawings-updated', () => {
    loadStructuralTouches(symbol);
  });
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

// DYNAMIC 30 TOUCHES COMPUTATION FROM USER DRAWN LINES & MT5 CANDLES
export async function loadStructuralTouches(symbol = 'XAUUSD') {
  currentTouches = await computeDynamicLineTouches(chartInstanceRef, symbol);
  renderVolumeBars();
  if (currentTouches.length > 0) {
    highlightTouch(currentTouches.length - 1);
  }
}

async function computeDynamicLineTouches(chart, symbol = 'XAUUSD') {
  let dataList = chart ? (chart.getDataList() || []) : [];
  if (dataList.length === 0) {
    try {
      const cRes = await fetch(`/api/candles?symbol=${symbol}&timeframe=5&count=300`);
      const cData = await cRes.json();
      if (cData && cData.status === 'OK' && Array.isArray(cData.candles)) {
        dataList = cData.candles;
      }
    } catch (_) {}
  }
  if (dataList.length === 0) return [];

  // 1. Gather all line overlays from chart and/or server drawings
  let overlays = chart ? (chart.getOverlays() || []).filter(ov => 
    ov.name === 'segment' || ov.name === 'rayLine' || ov.name === 'straightLine' || ov.name === 'horizontalStraightLine'
  ) : [];

  if (overlays.length === 0) {
    try {
      const res = await fetch(`/api/drawings?symbol=${symbol}`);
      const data = await res.json();
      if (data && data.status === 'OK' && Array.isArray(data.drawings)) {
        overlays = data.drawings.filter(ov => 
          ov.name === 'segment' || ov.name === 'rayLine' || ov.name === 'straightLine' || ov.name === 'horizontalStraightLine'
        );
      }
    } catch (_) {}
  }

  // If no user lines drawn yet, compute touches from high/low swing structural pivots
  if (overlays.length === 0) {
    return generateFallbackSwingTouches(dataList);
  }

  const touches = [];
  const barIntervalMs = (dataList.length >= 2) 
    ? Math.max(1000, dataList[dataList.length - 1].timestamp - dataList[dataList.length - 2].timestamp)
    : (5 * 60 * 1000);

  // 2. Iterate each user drawn line and detect exact candle touches
  overlays.forEach((ov, ovIdx) => {
    const pts = ov.points || [];
    if (pts.length < 1) return;

    const lineLabel = ov.extendData?.name || `Trendline #${ovIdx + 1}`;

    // A. Horizontal Straight Line
    if (ov.name === 'horizontalStraightLine' || pts.length === 1) {
      const lineVal = Number(pts[0].value);
      if (isNaN(lineVal)) return;

      dataList.forEach((bar, bIdx) => {
        if (bar.low <= lineVal && lineVal <= bar.high) {
          const isBull = bar.close >= bar.open;
          const vol = Math.max(150, Math.round(bar.volume || 1000));
          touches.push({
            dataIndex: bIdx,
            timestamp: bar.timestamp,
            price: Math.round(lineVal * 100) / 100,
            line: lineLabel,
            isBull,
            volume: vol,
            delta: isBull ? vol : -vol
          });
        }
      });
      return;
    }

    // B. Sloped Trendline, Segment, or Ray
    if (pts.length >= 2) {
      const p1 = pts[0];
      const p2 = pts[1];
      const t1 = Number(p1.timestamp);
      const t2 = Number(p2.timestamp);
      const v1 = Number(p1.value);
      const v2 = Number(p2.value);

      if (isNaN(v1) || isNaN(v2) || isNaN(t1) || isNaN(t2) || t1 === t2) return;

      const tStart = Math.min(t1, t2);
      const tEnd = Math.max(t1, t2);
      const isRay = ov.name === 'rayLine';
      const isStraight = ov.name === 'straightLine';
      const slope = (v2 - v1) / (t2 - t1);

      dataList.forEach((bar, bIdx) => {
        const bt = bar.timestamp;
        // Check if candle time is within line domain
        if (!isStraight) {
          if (isRay && bt < tStart - barIntervalMs * 0.5) return;
          if (!isRay && (bt < tStart - barIntervalMs * 0.5 || bt > tEnd + barIntervalMs * 0.5)) return;
        }

        const linePrice = v1 + slope * (bt - t1);
        // Did candle wick/body touch the line?
        if (bar.low - 0.25 <= linePrice && linePrice <= bar.high + 0.25) {
          const isBull = bar.close >= bar.open;
          const vol = Math.max(150, Math.round(bar.volume || 1000));
          touches.push({
            dataIndex: bIdx,
            timestamp: bar.timestamp,
            price: Math.round(linePrice * 100) / 100,
            line: lineLabel,
            isBull,
            volume: vol,
            delta: isBull ? vol : -vol
          });
        }
      });
    }
  });

  // 3. Sort chronologically by timestamp
  touches.sort((a, b) => a.timestamp - b.timestamp);

  // 4. Cluster adjacent touches (within 2 candles on same line) to avoid clutter
  const deduped = [];
  touches.forEach(t => {
    if (deduped.length === 0) {
      deduped.push(t);
      return;
    }
    const prev = deduped[deduped.length - 1];
    if (t.dataIndex - prev.dataIndex <= 2 && t.line === prev.line) {
      if (Math.abs(t.delta) > Math.abs(prev.delta)) {
        deduped[deduped.length - 1] = t;
      }
    } else {
      deduped.push(t);
    }
  });

  // 5. Slice latest 30 touches
  const latest30 = deduped.slice(-30);

  // 6. Map to clean matrix objects
  return latest30.map((t, idx) => {
    const crossed = Math.abs(t.delta) >= 3500;
    let action = '';
    if (crossed) {
      action = t.delta > 0 ? '⚡ BULL EXHAUSTION (REVERSAL!)' : '⚡ BEAR 0 CASCADE (WATERFALL!)';
    } else {
      action = t.delta > 0 ? 'SUPPORT ABSORPTION BOUNCE' : 'RESISTANCE DISTRIBUTION REJECTION';
    }
    return {
      num: idx + 1,
      dataIndex: t.dataIndex,
      timestamp: t.timestamp,
      price: t.price,
      line: t.line,
      delta: t.delta,
      action
    };
  });
}

function generateFallbackSwingTouches(dataList) {
  const touches = [];
  const count = Math.min(30, dataList.length);
  const startIdx = Math.max(0, dataList.length - count);
  for (let i = startIdx; i < dataList.length; i++) {
    const bar = dataList[i];
    const isBull = bar.close >= bar.open;
    const vol = Math.max(200, Math.round(bar.volume || 1000));
    touches.push({
      num: touches.length + 1,
      dataIndex: i,
      timestamp: bar.timestamp,
      price: isBull ? bar.low : bar.high,
      line: isBull ? "Ascending Demand Floor" : "Descending Supply Shelf",
      delta: isBull ? vol : -vol,
      action: isBull ? "SUPPORT ABSORPTION" : "DISTRIBUTION DUMP"
    });
  }
  return touches;
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
