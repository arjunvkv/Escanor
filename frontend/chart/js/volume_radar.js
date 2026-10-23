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
export let dailyReversalThreshold = 3500;

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
  if (currentTouches.length > 0) {
    highlightTouch(Math.min(activeTouchIndex, currentTouches.length - 1));
  } else {
    highlightLiveBar();
    hideChartReticle();
  }
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

  // Update Daily Favourable Thresholds Mentions in HUD
  const bullThreshEl = document.getElementById('vrDailyBullThresh');
  const bearThreshEl = document.getElementById('vrDailyBearThresh');
  if (bullThreshEl) bullThreshEl.textContent = `+${dailyReversalThreshold.toLocaleString()}t`;
  if (bearThreshEl) bearThreshEl.textContent = `-${dailyReversalThreshold.toLocaleString()}t`;

  renderVolumeBars();
  if (currentTouches.length > 0) {
    highlightTouch(currentTouches.length - 1);
  } else {
    highlightLiveBar();
    hideChartReticle();
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

  // 1. Gather all line overlays from chart
  let overlays = [];
  if (chart && typeof chart.getOverlays === 'function') {
    overlays = (chart.getOverlays() || []).filter(ov => 
      ov.name === 'segment' || ov.name === 'rayLine' || ov.name === 'straightLine' || ov.name === 'horizontalStraightLine'
    );
  } else {
    // Only query server drawings if chart instance is not yet mounted
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

  // If no user lines drawn, return empty touches array (never fabricate fake phantom touches)
  if (overlays.length === 0) {
    return [];
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
          const isTopTouch = Math.abs(bar.high - lineVal) < Math.abs(bar.low - lineVal);
          const tipPrice = isTopTouch ? bar.high : bar.low;
          touches.push({
            dataIndex: bIdx,
            timestamp: bar.timestamp,
            price: tipPrice,
            linePrice: Math.round(lineVal * 100) / 100,
            tipType: isTopTouch ? 'TOP_WICK_TIP' : 'LOW_WICK_TIP',
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
          const isTopTouch = Math.abs(bar.high - linePrice) < Math.abs(bar.low - linePrice);
          const tipPrice = isTopTouch ? bar.high : bar.low;
          touches.push({
            dataIndex: bIdx,
            timestamp: bar.timestamp,
            price: tipPrice,
            linePrice: Math.round(linePrice * 100) / 100,
            tipType: isTopTouch ? 'TOP_WICK_TIP' : 'LOW_WICK_TIP',
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

  // 6. Map to predictive institutional absorption & level health objects
  const lineHitCounters = {};
  const lineCumulativeVols = {};

  return latest30.map((t, idx) => {
    const lKey = t.line || 'Level';
    lineHitCounters[lKey] = (lineHitCounters[lKey] || 0) + 1;
    lineCumulativeVols[lKey] = (lineCumulativeVols[lKey] || 0) + t.volume;

    const hitNumber = lineHitCounters[lKey];
    const cumVol = lineCumulativeVols[lKey];

    // Compute Wall Health (Remaining Strength of Level)
    // Hit 1: 90%, Hit 2: 60%, Hit 3: 25%, Hit 4+: 10%
    const wallHealthPct = Math.max(10, Math.round(100 - (hitNumber - 1) * 35));

    // Effort vs Progress: Look ahead up to 3 candles in dataList to evaluate price progress
    let maxProgress = 0;
    if (typeof t.dataIndex === 'number' && dataList && dataList.length > 0) {
      const nextBars = dataList.slice(t.dataIndex + 1, t.dataIndex + 4);
      if (nextBars.length > 0) {
        if (t.tipType === 'LOW_WICK_TIP') {
          // Bouncing off support floor: measure maximum upward reach
          const maxHigh = Math.max(...nextBars.map(b => b.high));
          maxProgress = Math.max(0, Math.round((maxHigh - t.linePrice) * 100) / 100);
        } else {
          // Rejecting resistance ceiling: measure maximum downward reach
          const minLow = Math.min(...nextBars.map(b => b.low));
          maxProgress = Math.max(0, Math.round((t.linePrice - minLow) * 100) / 100);
        }
      }
    }

    const isHighEffort = t.volume >= 3000;
    const isWeakProgress = maxProgress < 2.50; // Less than $2.50 displacement on Gold
    const isSupport = t.tipType === 'LOW_WICK_TIP';

    let predictedMove = '';
    let statusText = '';
    let action = '';
    let triggerText = '';
    let healthColor = '#00e676';

    if (isSupport) {
      // SUPPORT FLOOR
      if (hitNumber >= 3 || (isHighEffort && isWeakProgress)) {
        predictedMove = 'WATERFALL_BREAKDOWN';
        statusText = `⚠️ BIDS ${100 - wallHealthPct}% CONSUMED (FRAGILE)`;
        action = '⚡ WATERFALL BREAKDOWN PRIMED';
        triggerText = `Below $${(t.price - 0.50).toFixed(2)} ➜ Targets $${(t.price - 15.0).toFixed(2)}`;
        healthColor = '#ff334b';
      } else if (isHighEffort && !isWeakProgress) {
        predictedMove = 'SUPPORT_REVERSAL';
        statusText = `🟢 STRONG BUY ABSORPTION (WALL DEFENDED)`;
        action = '🟢 ACCUMULATION BOUNCE ACTIVE';
        triggerText = `Holds above $${t.linePrice.toFixed(2)} ➜ Targets $${(t.linePrice + 12.0).toFixed(2)}`;
        healthColor = '#00e676';
      } else {
        predictedMove = 'TESTING_SUPPORT';
        statusText = `🛡️ FRESH SUPPORT TEST (Hit #${hitNumber})`;
        action = 'SUPPORT PROBE';
        triggerText = `Defense at $${t.linePrice.toFixed(2)}`;
        healthColor = '#00e5ff';
      }
    } else {
      // RESISTANCE CEILING
      if (hitNumber >= 3 || (isHighEffort && isWeakProgress)) {
        predictedMove = 'UPSIDE_BREAKOUT';
        statusText = `⚠️ OFFERS ${100 - wallHealthPct}% CONSUMED (FRAGILE)`;
        action = '⚡ UPSIDE BREAKOUT PRIMED';
        triggerText = `Above $${(t.price + 0.50).toFixed(2)} ➜ Targets $${(t.price + 15.0).toFixed(2)}`;
        healthColor = '#00e676';
      } else if (isHighEffort && !isWeakProgress) {
        predictedMove = 'RESISTANCE_REVERSAL';
        statusText = `🔴 STRONG SELL ABSORPTION (CEILING DEFENDED)`;
        action = '🔴 DISTRIBUTION REJECTION ACTIVE';
        triggerText = `Rejects $${t.linePrice.toFixed(2)} ➜ Targets $${(t.linePrice - 12.0).toFixed(2)}`;
        healthColor = '#ff334b';
      } else {
        predictedMove = 'TESTING_RESISTANCE';
        statusText = `🛡️ FRESH CEILING TEST (Hit #${hitNumber})`;
        action = 'RESISTANCE PROBE';
        triggerText = `Rejection at $${t.linePrice.toFixed(2)}`;
        healthColor = '#00e5ff';
      }
    }

    return {
      num: idx + 1,
      dataIndex: t.dataIndex,
      timestamp: t.timestamp,
      price: t.price,
      linePrice: t.linePrice,
      tipType: t.tipType,
      line: t.line,
      hitNumber,
      cumVol,
      wallHealthPct,
      maxProgress,
      isHighEffort,
      isWeakProgress,
      predictedMove,
      statusText,
      action,
      triggerText,
      healthColor,
      volume: t.volume,
      delta: t.delta
    };
  });
}

function renderVolumeBars() {
  const track = document.getElementById('vrBarsTrack');
  if (!track) return;

  track.querySelectorAll('.vr-bar-unit, .vr-empty-state-msg').forEach(el => el.remove());

  // Update HUD Header Title to reflect true number of touches
  const titleEl = document.querySelector('.tv-vr-title span:last-child');
  if (titleEl) {
    titleEl.textContent = currentTouches.length > 0 
      ? `VOLUME CONSUMPTION (${currentTouches.length} TOUCHES + LIVE)`
      : `VOLUME CONSUMPTION (LIVE SPOT ONLY)`;
  }

  // If no user lines drawn, show clear clean indicator
  if (currentTouches.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'vr-empty-state-msg';
    emptyMsg.style.cssText = 'color: #8b949e; font-size: 10px; font-family: var(--font-mono, monospace); padding: 0 16px; white-space: nowrap; display: flex; align-items: center; gap: 6px;';
    emptyMsg.innerHTML = '<span style="color:#00e5ff;">📐</span> <span>NO ACTIVE LINES DRAWN — DRAW A TRENDLINE OR RAY TO TRACK TOUCHES</span>';
    track.appendChild(emptyMsg);
  } else {
    // Render user line touches
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
  }

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

  // Scroll to show apex or live bar
  const win = document.getElementById('vrBarsWindow');
  if (win) win.scrollLeft = currentTouches.length > 0 ? 240 : 0;
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

  if (numEl) numEl.textContent = `TOUCH #${t.num} / 30 • HIT #${t.hitNumber || 1}`;
  if (priceEl) priceEl.textContent = `$${t.price.toFixed(2)}`;
  if (lineEl) lineEl.textContent = `${t.line} ($${t.linePrice.toFixed(2)})`;
  if (volEl) {
    const progStr = typeof t.maxProgress === 'number' ? `$${t.maxProgress.toFixed(2)}` : '--';
    const qual = t.isWeakProgress ? 'Poor' : 'Strong';
    volEl.textContent = `${(t.volume || 0).toLocaleString()}t (Progress: ${progStr} • ${qual})`;
    volEl.style.color = t.isWeakProgress && t.isHighEffort ? '#ffb300' : '#00e676';
  }
  if (verdictEl) {
    verdictEl.textContent = t.action;
    verdictEl.style.color = t.healthColor || '#ff334b';
  }

  updateTriggerIndicator(t);

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

  const hasLines = currentTouches.length > 0;
  if (numEl) numEl.textContent = hasLines ? '● LIVE BAR' : '● LIVE SPOT (0 LINES)';
  if (priceEl) priceEl.textContent = `$${liveSpotPrice.toFixed(2)}`;
  if (lineEl) lineEl.textContent = hasLines 
    ? `Live Spot Active Candle ($${liveSpotPrice.toFixed(2)})` 
    : 'Live Active Spot (Draw trendline or ray to track touches)';
  if (volEl) {
    volEl.textContent = `${liveTickVolume > 0 ? '+' : ''}${liveTickVolume.toLocaleString()} ticks`;
    volEl.style.color = liveTickVolume >= 0 ? '#00e676' : '#ff334b';
  }
  if (verdictEl) {
    const thresh = dailyReversalThreshold || 3500;
    const absVol = Math.abs(liveTickVolume);
    const rem = Math.max(0, thresh - absVol);
    if (absVol >= thresh) {
      verdictEl.textContent = '⚡ REVERSAL THRESHOLD ACTIVE';
      verdictEl.style.color = '#00e676';
    } else {
      verdictEl.textContent = `ACCUMULATING (${rem.toLocaleString()}t to ${liveTickVolume >= 0 ? 'Bull' : 'Bear'} Reversal)`;
      verdictEl.style.color = '#ffb300';
    }
  }

  const liveObj = {
    num: 'LIVE',
    price: liveSpotPrice,
    delta: liveTickVolume,
    line: `Live Spot Active Candle ($${liveSpotPrice.toFixed(2)})`,
    action: 'ACCUMULATING LIVE AT SPOT'
  };
  updateTriggerIndicator(liveObj);

  document.querySelectorAll('.vr-bar-unit').forEach(b => b.classList.remove('active'));
  const liveUnit = document.getElementById('vrBarUnit_live');
  if (liveUnit) liveUnit.classList.add('active');

  const dataList = chartInstanceRef ? (chartInstanceRef.getDataList() || []) : [];
  const lastBar = dataList.length > 0 ? dataList[dataList.length - 1] : null;

  liveObj.timestamp = lastBar ? lastBar.timestamp : undefined;
  liveObj.dataIndex = dataList.length > 0 ? (dataList.length - 1) : undefined;

  if (hasLines) {
    showChartReticle(liveObj, 30);
  } else {
    hideChartReticle();
  }
}

function updateTriggerIndicator(t) {
  const barFill = document.getElementById('vrIndBarFill');
  const statusText = document.getElementById('vrIndStatusText');
  const remText = document.getElementById('vrIndRemText');
  if (!barFill || !statusText || !remText) return;

  if (t.num === 'LIVE') {
    const thresh = dailyReversalThreshold || 3500;
    const absVol = Math.abs(t.delta || liveTickVolume);
    const pct = Math.min(100, Math.round((absVol / thresh) * 100));
    barFill.style.width = `${pct}%`;
    barFill.style.background = pct >= 100 ? '#00e676' : (pct >= 70 ? '#ffb300' : '#00e5ff');
    statusText.textContent = `⚡ LIVE VELOCITY (${pct}%)`;
    statusText.style.color = barFill.style.background;
    remText.textContent = `${absVol.toLocaleString()}t / ${thresh.toLocaleString()}t Boundary`;
    remText.style.color = '#cbd5e1';
    return;
  }

  // Display Wall Wear % (Remaining Strength of Level)
  const healthPct = typeof t.wallHealthPct === 'number' ? t.wallHealthPct : 50;
  const consumedPct = 100 - healthPct;
  barFill.style.width = `${consumedPct}%`;
  barFill.style.background = t.healthColor || (consumedPct >= 70 ? '#ff334b' : '#00e5ff');

  statusText.textContent = t.statusText || `LEVEL WEAR: ${consumedPct}% CONSUMED`;
  statusText.style.color = t.healthColor || '#ff334b';

  remText.textContent = t.triggerText || `Level: $${t.linePrice.toFixed(2)}`;
  remText.style.color = '#cbd5e1';
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

  if (chartInstanceRef && typeof chartInstanceRef.convertToPixel === 'function') {
    try {
      const dataList = chartInstanceRef.getDataList() || [];
      let targetCoord = null;
      if (t.timestamp && t.timestamp > 0) {
        targetCoord = { timestamp: t.timestamp, value: t.price };
      } else if (typeof t.dataIndex === 'number' && t.dataIndex >= 0) {
        targetCoord = { dataIndex: t.dataIndex, value: t.price };
      } else if (idx >= 30 && dataList.length > 0) {
        targetCoord = { dataIndex: dataList.length - 1, value: t.price };
      }

      if (targetCoord) {
        const pCoords = chartInstanceRef.convertToPixel(targetCoord);
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

  // Auto-scroll volume bars HUD track into view (keeps active bar visible in bottom HUD strip)
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
  const isWaterfall = t.predictedMove === 'WATERFALL_BREAKDOWN';
  const color = t.healthColor || (isWaterfall ? '#ff334b' : '#00e676');

  // 1. Position Glowing Outer Beacon Halo at the exact tip of the candle
  const halo = document.getElementById('tvVrDotHalo');
  if (halo) {
    halo.setAttribute('cx', x);
    halo.setAttribute('cy', y);
    halo.setAttribute('stroke', color);
  }

  // 2. Position Solid Core Radar Dot with Drop Shadow at the candle tip
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

  // 4. Attach to the line where it touched
  let lineY = null;
  if (chartInstanceRef && typeof t.linePrice === 'number' && typeof chartInstanceRef.convertToPixel === 'function') {
    try {
      const lp = chartInstanceRef.convertToPixel({ value: t.linePrice });
      if (lp && typeof lp.y === 'number' && !isNaN(lp.y)) lineY = lp.y;
    } catch (_) {}
  }

  const stem = document.getElementById('tvVrDotStem');
  const anchor = document.getElementById('tvVrLineAnchor');
  if (lineY !== null && Math.abs(y - lineY) >= 2) {
    if (stem) {
      stem.style.display = 'block';
      stem.setAttribute('x1', x);
      stem.setAttribute('y1', y);
      stem.setAttribute('x2', x);
      stem.setAttribute('y2', lineY);
      stem.setAttribute('stroke', color);
    }
    if (anchor) {
      anchor.style.display = 'block';
      anchor.setAttribute('cx', x);
      anchor.setAttribute('cy', lineY);
      anchor.setAttribute('stroke', color);
    }
  } else {
    if (stem) stem.style.display = 'none';
    if (anchor) anchor.style.display = 'none';
  }

  // 5. Floating Tag Box On The Candle (Smart Clamping)
  let tagX = x + 20;
  let tagY = y - 25;
  if (tagX + 230 > vpWidth - 60) tagX = x - 240;
  if (tagY < 60) tagY = y + 25;
  if (tagY + 72 > vpHeight - 40) tagY = vpHeight - 80;

  const tagG = document.getElementById('tvVrTagGroup');
  if (tagG) tagG.setAttribute('transform', `translate(${tagX}, ${tagY})`);

  const tagBg = document.getElementById('tvVrTagBg');
  if (tagBg) {
    tagBg.setAttribute('width', '230');
    tagBg.setAttribute('height', '72');
    tagBg.setAttribute('stroke', color);
  }

  const tagTitle = document.getElementById('tvVrTagTitle');
  if (tagTitle) {
    const hitLabel = t.num === 'LIVE' ? 'LIVE' : `Hit #${t.hitNumber || 1}`;
    tagTitle.textContent = `${t.num === 'LIVE' ? 'LIVE SPOT' : 'T' + t.num}: $${t.price.toFixed(2)} (${hitLabel})`;
    tagTitle.setAttribute('fill', color);
  }

  const tagSub = document.getElementById('tvVrTagSub');
  if (tagSub) {
    if (t.num === 'LIVE') {
      tagSub.textContent = `Effort: ${Math.abs(liveTickVolume).toLocaleString()}t active`;
    } else {
      const progStr = typeof t.maxProgress === 'number' ? `$${t.maxProgress.toFixed(2)}` : '--';
      const progQuality = t.isWeakProgress ? 'Poor' : 'Strong';
      tagSub.textContent = `Effort: ${(t.volume || 0).toLocaleString()}t • Progress: ${progStr} (${progQuality})`;
    }
  }

  const tagTrigger = document.getElementById('tvVrTagTrigger');
  if (tagTrigger) {
    if (t.num === 'LIVE') {
      const thresh = dailyReversalThreshold || 3500;
      const absVol = Math.abs(liveTickVolume);
      const rem = Math.max(0, thresh - absVol);
      tagTrigger.textContent = absVol >= thresh ? '⚡ REVERSAL THRESHOLD HIT' : `Accumulating (${rem.toLocaleString()}t to boundary)`;
      tagTrigger.setAttribute('fill', absVol >= thresh ? '#00e676' : '#ffb300');
    } else {
      tagTrigger.textContent = t.statusText || `Wall Wear: ${100 - (t.wallHealthPct || 50)}% Consumed`;
      tagTrigger.setAttribute('fill', color);
    }
  }

  const tagVerdict = document.getElementById('tvVrTagVerdict');
  if (tagVerdict) {
    tagVerdict.textContent = t.action || 'STRUCTURAL LEVEL TEST';
    tagVerdict.setAttribute('fill', isWaterfall ? '#ff334b' : '#00e676');
  }

  const tagNextMove = document.getElementById('tvVrTagNextMove');
  if (tagNextMove) {
    tagNextMove.textContent = `Trigger: ${t.triggerText || 'Monitoring Level'}`;
  }
}

export function hideChartReticle() {
  const overlay = document.getElementById('tvVolumeRadarOverlay');
  if (overlay) overlay.style.display = 'none';
  const reticleGroup = document.getElementById('tvVrReticleGroup');
  if (reticleGroup) reticleGroup.style.display = 'none';
}
