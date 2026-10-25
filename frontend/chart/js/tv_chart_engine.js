/**
 * Escanor — TradingView Chart Engine (KLineCharts v10 wrapper)
 * Themes the chart to exact TradingView Obsidian (#131722), silver bull (#d1d4dc), rose bear (#e0457b)
 * and registers custom box & measurement ruler tools matching TradingView exactly.
 */

import { expandRectPointsToSix, normalizeRectPoints, handleRectPressedMove, recalculateRectZLevels, showChartToast } from './drawings_storage.js?v=202610241430';
import { registerLivingFootprintIndicator } from './living_candle_engine.js?v=202610140655';

// Global reference for chart instance
let chartInstance = null;

// Global preference: Hide Volume Overlays on all boxes (only rectangle lines shown)
window.__hideAllRectVolumeOverlays = (typeof localStorage !== 'undefined' && localStorage.getItem('escanor_hide_all_rect_volume') === 'true');

// Global preference: Disable transparent fill on all boxes (outline only)
window.__disableAllRectFill = (typeof localStorage !== 'undefined' && localStorage.getItem('escanor_disable_all_rect_fill') === 'true');

// Global preference: Hide Top Extension Ribbon (Favourable Move Series)
window.__hideExtensionRibbon = (typeof localStorage !== 'undefined' && localStorage.getItem('escanor_hide_extension_ribbon') === 'true');

// Global preference: Hide Box Outlines and Fills (keep in-box excursion arrows and chart line markings)
window.__hideBoxBodies = (typeof localStorage !== 'undefined' && localStorage.getItem('escanor_hide_box_bodies') === 'true');

// State tracking for Structural Inflection Reference Lines plotted on the chart canvas
if (typeof window !== 'undefined') {
  window.__inflectionLinesState = window.__inflectionLinesState || {
    ceiling: false,
    mid: false,
    vwap: false,
    anchor: false,
    floor: false
  };
}

export const INFLECTION_LEVEL_KEYS = [
  { key: 'ceiling', id: 'lvl_node_ceiling', prop: 'maxHigh', title: 'CEILING RESISTANCE', color: '#ef4444', lineStyle: 'dashed', lineSize: 1.5, opacity: 0.85 },
  { key: 'mid', id: 'lvl_node_mid', prop: 'eqShelf', title: '50% MID-EQUILIBRIUM', color: '#fbbf24', lineStyle: 'dashed', lineSize: 1.5, opacity: 0.85 },
  { key: 'vwap', id: 'lvl_node_vwap', prop: 'networkVwap', title: 'NETWORK VWAP', color: '#818cf8', lineStyle: 'dashed', lineSize: 1.5, opacity: 0.85 },
  { key: 'anchor', id: 'lvl_node_anchor', prop: 'primaryAnchor', title: 'PEAK VOLUME ANCHOR', color: '#00e5ff', lineStyle: 'solid', lineSize: 2.0, opacity: 0.90 },
  { key: 'floor', id: 'lvl_node_floor', prop: 'minLow', title: 'SUPPORT FLOOR', color: '#10b981', lineStyle: 'dashed', lineSize: 1.5, opacity: 0.85 }
];

export function getChartInstance() {
  return chartInstance;
}

// Format compact volume representation (e.g. 42.8K, 1.2M)
function formatVolNumber(v) {
  const abs = Math.abs(v);
  if (abs >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (abs >= 1000) return (v / 1000).toFixed(1) + 'K';
  return String(Math.round(v));
}

/**
 * Computes empirical structural excursion and orderflow metrics for any rectangle overlay:
 * - Observed High (Hb), Observed Low (Lb), Range (Rb)
 * - Reference start price (P0) at t0, Reference end price (P1) at t1, Net movement (Nb)
 * - Favourable Move (Fb, MFE) & Adverse Move (Ab, MAE) based on expected direction (Bullish/Bearish)
 * - Real tick volume (Vb), Net Delta (Δb), CVD Change (ΔCVDb)
 * - Absorption Evidence (Eb) and Subsequent Result (Yb)
 * - Completely excludes POC as requested.
 */
export function computeRectangleVolumeMetrics(overlay, dataList, allRectsList) {
  if (!overlay || !overlay.points || overlay.points.length < 2 || !dataList || dataList.length === 0) {
    return null;
  }

  const validPoints = overlay.points.filter(p => p && typeof p.value === 'number' && !isNaN(p.value));
  if (validPoints.length < 2) return null;

  const values = validPoints.map(p => p.value);
  const topPrice = Math.max(...values);
  const bottomPrice = Math.min(...values);
  const priceRange = topPrice - bottomPrice;
  if (priceRange <= 0.0001) return null;

  const timestamps = validPoints
    .map(p => p.timestamp)
    .filter(t => typeof t === 'number' && !isNaN(t) && t > 0);

  let leftTime = 0;
  let rightTime = Infinity;

  if (timestamps.length >= 2) {
    leftTime = Math.min(...timestamps);
    rightTime = Math.max(...timestamps);
  } else if (timestamps.length === 1) {
    leftTime = timestamps[0];
    rightTime = leftTime + 30 * 60 * 1000;
  } else {
    const indices = validPoints.map(p => p.dataIndex).filter(idx => typeof idx === 'number' && idx >= 0);
    if (indices.length >= 2) {
      const minIdx = Math.max(0, Math.min(...indices));
      const maxIdx = Math.min(dataList.length - 1, Math.max(...indices));
      if (dataList[minIdx]) leftTime = dataList[minIdx].timestamp;
      if (dataList[maxIdx]) rightTime = dataList[maxIdx].timestamp;
    } else {
      return null;
    }
  }

  if (leftTime === rightTime) {
    rightTime = leftTime + 5 * 60 * 1000;
  }

  const tfMins = (typeof window !== 'undefined' && window.__currentTimeframeMinutes) || 5;
  const barMs = tfMins * 60 * 1000;

  // Collect all eligible bars in the time window
  const barsInBox = [];
  let firstBarIndex = null;
  let lastBarIndex = null;

  let totalVol = 0;
  let bullVol = 0;
  let bearVol = 0;
  let candleCount = 0;
  let bullMovePts = 0;
  let bearMovePts = 0;

  let observedHigh = -Infinity;
  let observedLow = Infinity;
  let peakBarIndex = null;
  let troughBarIndex = null;

  for (let i = 0; i < dataList.length; i++) {
    const bar = dataList[i];
    if (!bar || typeof bar.timestamp !== 'number') continue;

    if (bar.timestamp + barMs < leftTime) continue;
    if (bar.timestamp > rightTime + barMs) continue;

    if (firstBarIndex === null) firstBarIndex = i;
    lastBarIndex = i;

    if (bar.high > observedHigh) {
      observedHigh = bar.high;
      peakBarIndex = i;
    }
    if (bar.low < observedLow) {
      observedLow = bar.low;
      troughBarIndex = i;
    }

    const barRange = Math.max(0.01, bar.high - bar.low);
    const overlapLow = Math.max(bar.low, bottomPrice);
    const overlapHigh = Math.min(bar.high, topPrice);
    const overlapRange = Math.max(0, overlapHigh - overlapLow);
    const overlapRatio = Math.min(1.0, overlapRange / barRange);

    const vol = Number(bar.volume || bar.tick_volume || 1);
    const volInBox = overlapRange > 0 ? (vol * overlapRatio) : 0;

    totalVol += volInBox;
    if (volInBox > 0) candleCount++;

    const effTypPrice = (overlapHigh + overlapLow + Math.max(overlapLow, Math.min(overlapHigh, bar.close))) / 3;

    barsInBox.push({
      bar,
      index: i,
      volInBox,
      effectiveLow: overlapLow,
      effectiveHigh: overlapHigh,
      effectiveTypPrice: effTypPrice
    });

    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;

    // Order flow & delta decomposition
    const displacement = (bar.close - bar.open) / barRange;
    const closeLocation = ((bar.close - bar.low) - (bar.high - bar.close)) / barRange;
    const isAtFloor = overlapLow <= bottomPrice + 0.30 * priceRange;
    const isAtCeiling = overlapHigh >= topPrice - 0.30 * priceRange;
    const wickWeight = (isAtFloor || isAtCeiling) ? 1.6 : 1.0;
    const wickDiff = ((lowerWick - upperWick) / barRange) * wickWeight;

    const deltaScore = Math.max(-1.0, Math.min(1.0, displacement * 0.45 + closeLocation * 0.35 + wickDiff * 0.20));
    const bullRatio = (1 + deltaScore) / 2;

    bullVol += volInBox * bullRatio;
    bearVol += volInBox * (1 - bullRatio);

    // Effort vs Movement: track upward and downward displacement within this box
    const effOpen = Math.max(overlapLow, Math.min(overlapHigh, bar.open));
    const effClose = Math.max(overlapLow, Math.min(overlapHigh, bar.close));
    if (effClose > effOpen) {
      bullMovePts += (effClose - effOpen) + Math.max(0, overlapHigh - effClose) * 0.4;
      bearMovePts += Math.max(0, effOpen - overlapLow) * 0.4;
    } else if (effClose < effOpen) {
      bearMovePts += (effOpen - effClose) + Math.max(0, effClose - overlapLow) * 0.4;
      bullMovePts += Math.max(0, overlapHigh - effOpen) * 0.4;
    } else {
      bullMovePts += Math.max(0, overlapHigh - effOpen) * 0.4;
      bearMovePts += Math.max(0, effOpen - overlapLow) * 0.4;
    }
  }

  // Fallbacks if box is drawn in empty future/past space
  if (observedHigh === -Infinity) observedHigh = topPrice;
  if (observedLow === Infinity) observedLow = bottomPrice;
  const H_b = observedHigh;
  const L_b = observedLow;
  const R_b = Math.max(0.01, H_b - L_b);

  const firstBar = barsInBox.length > 0 ? barsInBox[0].bar : null;
  const lastBar = barsInBox.length > 0 ? barsInBox[barsInBox.length - 1].bar : null;

  const P_0 = firstBar ? firstBar.open : bottomPrice;
  const P_1 = lastBar ? lastBar.close : topPrice;
  const netMove = P_1 - P_0;

  // Expected Direction
  const dirSetting = (overlay.extendData && overlay.extendData.direction) || 'AUTO';
  let d = 1; // +1 Bullish, -1 Bearish
  if (dirSetting === 'BULLISH') {
    d = 1;
  } else if (dirSetting === 'BEARISH') {
    d = -1;
  } else {
    d = (netMove >= 0) ? 1 : -1;
  }
  const directionName = (d === 1) ? 'BULLISH' : 'BEARISH';

  // Favourable Move (MFE) & Adverse Move (MAE)
  let favMove = 0;
  let advMove = 0;
  if (d === 1) {
    favMove = Math.max(0, H_b - P_0);
    advMove = Math.max(0, P_0 - L_b);
  } else {
    favMove = Math.max(0, P_0 - L_b);
    advMove = Math.max(0, H_b - P_0);
  }

  // Delta & CVD Change
  const netDelta = Math.round(bullVol - bearVol);
  const netDeltaPct = totalVol > 0 ? Math.round((netDelta / totalVol) * 100) : 0;
  const cvdChg = netDelta; // Box interval CVD change
  const bullPct = totalVol > 0 ? Math.min(99, Math.max(1, Math.round((bullVol / totalVol) * 100))) : 50;
  const bearPct = 100 - bullPct;

  // Empirical Absorption: Eb = 1.0 - (|P1 - P0| / (Rb + 0.001) * 1 / (1 + ln(1 + Vb / (Vavg + 1))))
  const avgVol = Math.max(10, totalVol / Math.max(1, candleCount));
  const effortResultRatio = Math.abs(netMove) / (R_b + 0.001);
  const volDampener = 1.0 / (1.0 + Math.log(1.0 + (totalVol / (avgVol * 2 + 1.0))));
  let rawAbsorption = 1.0 - (effortResultRatio * volDampener);
  rawAbsorption = Math.max(0.10, Math.min(0.99, rawAbsorption));
  const absorbPct = Math.round(rawAbsorption * 100);

  let absorbLevel = 'MODERATE';
  if (absorbPct >= 70) absorbLevel = 'HIGH';
  else if (absorbPct < 45) absorbLevel = 'LOW';

  // Subsequent Price Movement & Result
  let resultText = 'ROTATION / RANGE';
  let resultColor = '#38bdf8';

  if (d === 1) {
    if (absorbPct >= 65 && Math.abs(P_0 - L_b) <= R_b * 0.4) {
      resultText = 'SPRING / REJECTION & EXPANSION';
      resultColor = '#00f0ff';
    } else if (bullPct >= 60 || netDeltaPct >= 15) {
      resultText = 'BULL TREND CONTINUATION';
      resultColor = '#00e676';
    } else if (absorbPct >= 65) {
      resultText = 'CEILING ABSORPTION / REVERSAL RISK';
      resultColor = '#f59e0b';
    } else {
      resultText = 'BULLISH DISPLACEMENT';
      resultColor = '#38bdf8';
    }
  } else {
    if (absorbPct >= 65 && Math.abs(H_b - P_0) <= R_b * 0.4) {
      resultText = 'UPTHRUST / CEILING REJECTION';
      resultColor = '#ffb300';
    } else if (bearPct >= 60 || netDeltaPct <= -15) {
      resultText = 'BEAR BREAKDOWN CONTINUATION';
      resultColor = '#ff334b';
    } else if (absorbPct >= 65) {
      resultText = 'FLOOR ABSORPTION / BOUNCE RISK';
      resultColor = '#f59e0b';
    } else {
      resultText = 'BEARISH DISPLACEMENT';
      resultColor = '#38bdf8';
    }
  }

  // Calculate Volume Point of Control (POC) and VWAP for this box
  let weightedPriceSum = 0;
  let maxBarVol = -1;
  let maxBarPrice = P_0;
  const boxBinCount = 30;
  const boxBinStep = Math.max(0.05, priceRange / boxBinCount);
  const boxBins = new Float64Array(boxBinCount);

  barsInBox.forEach(item => {
    const vol = item.volInBox;
    if (vol <= 0) return;
    const typPrice = item.effectiveTypPrice;
    weightedPriceSum += typPrice * vol;

    if (vol > maxBarVol) {
      maxBarVol = vol;
      maxBarPrice = typPrice;
    }

    const lowBin = Math.max(0, Math.min(boxBinCount - 1, Math.floor((item.effectiveLow - bottomPrice) / boxBinStep)));
    const highBin = Math.max(0, Math.min(boxBinCount - 1, Math.floor((item.effectiveHigh - bottomPrice) / boxBinStep)));
    const span = Math.max(1, highBin - lowBin + 1);
    const volPerBin = vol / span;
    for (let bi = lowBin; bi <= highBin; bi++) {
      boxBins[bi] += volPerBin;
    }
  });

  let maxBinIdx = 0;
  let maxBinVol = -1;
  for (let bi = 0; bi < boxBinCount; bi++) {
    if (boxBins[bi] > maxBinVol) {
      maxBinVol = boxBins[bi];
      maxBinIdx = bi;
    }
  }
  const pocPrice = bottomPrice + (maxBinIdx + 0.5) * boxBinStep;
  const vwapPrice = totalVol > 0 ? (weightedPriceSum / totalVol) : ((topPrice + bottomPrice) / 2);

  // Determine chronological Box Number
  let boxNum = 1;
  const c = (typeof window !== 'undefined' && window.__chartInstance) || null;
  const allOverlays = allRectsList || (c?.getOverlays?.() || []);
  const rects = allOverlays.filter(o => o.name === 'rect' && o.points && o.points.length >= 2);
  if (rects.length > 0) {
    const sorted = rects.map(r => {
      const times = (r.points || []).map(p => p.timestamp).filter(t => typeof t === 'number' && t > 0);
      const t = times.length > 0 ? Math.min(...times) : 0;
      return { id: r.id, t0: t };
    }).sort((a, b) => a.t0 - b.t0);
    const foundIdx = sorted.findIndex(s => s.id === overlay.id);
    if (foundIdx >= 0) {
      boxNum = foundIdx + 1;
    }
  }

  // --- Dynamic Volume Yield & Dominance Engine (What happened INSIDE the box) ---
  // Composite internal directional progress (candle displacement + peak excursion inside box)
  const grossBullProgress = Math.max(0.1, bullMovePts);
  const grossBearProgress = Math.max(0.1, bearMovePts);
  const peakBullProgress = Math.max(0, H_b - P_0);
  const peakBearProgress = Math.max(0, P_0 - L_b);
  const netBullProgress = Math.max(0, P_1 - P_0);
  const netBearProgress = Math.max(0, P_0 - P_1);

  // Effective progress inside the box:
  const effBullMove = Math.max(0.1, grossBullProgress * 0.45 + peakBullProgress * 0.35 + netBullProgress * 0.20);
  const effBearMove = Math.max(0.1, grossBearProgress * 0.45 + peakBearProgress * 0.35 + netBearProgress * 0.20);

  const bullVolK = Math.max(0.1, bullVol / 1000);
  const bearVolK = Math.max(0.1, bearVol / 1000);
  const bullYield = effBullMove / bullVolK;
  const bearYield = effBearMove / bearVolK;

  let domSide = 'NEUTRAL'; // 'BULL' | 'BEAR' | 'NEUTRAL'
  let domRatio = 1.0;
  let isThinning = false;

  if (bearYield > bullYield * 1.15) {
    domSide = 'BEAR';
    domRatio = Math.round((bearYield / Math.max(0.01, bullYield)) * 10) / 10;
  } else if (bullYield > bearYield * 1.15) {
    domSide = 'BULL';
    domRatio = Math.round((bullYield / Math.max(0.01, bearYield)) * 10) / 10;
  } else {
    // When yields are close, examine internal delta score
    if (netDeltaPct <= -10) {
      domSide = 'BEAR';
      domRatio = Math.round((Math.abs(netDeltaPct) / 10) * 10) / 10;
    } else if (netDeltaPct >= 10) {
      domSide = 'BULL';
      domRatio = Math.round((netDeltaPct / 10) * 10) / 10;
    } else {
      domSide = 'NEUTRAL';
      domRatio = 1.0;
    }
  }

  // Multi-box Sequence Context (Ceiling & Floor bounds for Exhaustion / No Demand / No Supply detection)
  let isExhaustion = false;
  let exhaustionType = '';

  if (rects && rects.length >= 2) {
    const allBoxHighs = rects.map(r => {
      const vals = (r.points || []).map(p => p?.value).filter(val => typeof val === 'number' && !isNaN(val));
      return vals.length > 0 ? Math.max(...vals) : 0;
    }).filter(v => v > 0);
    const allBoxLows = rects.map(r => {
      const vals = (r.points || []).map(p => p?.value).filter(val => typeof val === 'number' && !isNaN(val));
      return vals.length > 0 ? Math.min(...vals) : 0;
    }).filter(v => v > 0);

    const seqCeil = allBoxHighs.length > 0 ? Math.max(...allBoxHighs) : topPrice;
    const seqFlr = allBoxLows.length > 0 ? Math.min(...allBoxLows) : bottomPrice;
    const seqRng = Math.max(1.0, seqCeil - seqFlr);

    // Is this box testing the sequence ceiling or floor?
    const isAtCeiling = (H_b >= seqCeil - 0.25 * seqRng || P_1 >= seqCeil - 0.30 * seqRng);
    const isAtFloor = (L_b <= seqFlr + 0.25 * seqRng || P_1 <= seqFlr + 0.30 * seqRng);

    // No Demand at Ceiling: Bulls pushing upward into sequence ceiling, but volume is exhausted / low (< 13.5K) without breakout
    if (totalVol >= 1000 && isAtCeiling && domSide === 'BULL' && bullVol < 13500 && P_1 <= seqCeil + 0.5) {
      isExhaustion = true;
      exhaustionType = 'NO_DEMAND';
      isThinning = true;
    }
    // No Supply at Floor: Bears pushing downward into sequence floor, but volume is exhausted / low (< 13.5K) without breakdown
    else if (totalVol >= 1000 && isAtFloor && domSide === 'BEAR' && bearVol < 13500 && P_1 >= seqFlr - 0.5) {
      isExhaustion = true;
      exhaustionType = 'NO_SUPPLY';
      isThinning = true;
    }
  }

  // Detect Thinning Out / Exhaustion / Absorption Traps
  let isTrap = false;
  let trapType = '';

  // True Wyckoff Trap / Absorption Logic (Requires extreme boundary probe + heavy opposite close rejection + high volume):
  const boxBullPct = totalVol > 0 ? Math.round((bullVol / totalVol) * 100) : 50;
  const boxBearPct = 100 - boxBullPct;

  // Ceiling Trap (Upthrust / Failed breakout): Extreme probe of box ceiling, high bull effort, but violent rejection down
  if (H_b >= topPrice - 0.15 * priceRange && (boxBullPct >= 58 || bullVol >= 18000) && (P_1 <= bottomPrice + 0.35 * priceRange && netMove <= -8.0) && absorbPct >= 75) {
    isTrap = true;
    trapType = 'CEILING_TRAP';
    isThinning = true;
  }
  // Floor Trap (Spring / Failed breakdown): Extreme probe of box floor, high bear effort, but violent rejection up
  else if (L_b <= bottomPrice + 0.15 * priceRange && (boxBearPct >= 58 || bearVol >= 18000) && (P_1 >= topPrice - 0.35 * priceRange && netMove >= +8.0) && absorbPct >= 75) {
    isTrap = true;
    trapType = 'FLOOR_TRAP';
    isThinning = true;
  }
  // General Exhaustion / Thinning Out (Heavy volume with stalled progress):
  else if (domSide === 'BEAR' && bearVol >= 12000 && (bearYield < 0.60 || (absorbPct >= 70 && Math.abs(netMove) < 4.0))) {
    isThinning = true;
  }
  else if (domSide === 'BULL' && bullVol >= 12000 && (bullYield < 0.60 || (absorbPct >= 70 && Math.abs(netMove) < 4.0))) {
    isThinning = true;
  }

  const yieldAnalysis = {
    bullMovePts: Math.round(effBullMove * 10) / 10,
    bearMovePts: Math.round(effBearMove * 10) / 10,
    bullVol: Math.round(bullVol),
    bearVol: Math.round(bearVol),
    bullYield: Math.round(bullYield * 100) / 100,
    bearYield: Math.round(bearYield * 100) / 100,
    domSide,
    domRatio,
    isThinning,
    isTrap,
    trapType,
    isExhaustion,
    exhaustionType
  };

  return {
    boxNum,
    yieldAnalysis,
    topPrice,
    bottomPrice,
    priceRange,
    H_b,
    L_b,
    R_b,
    P_0,
    P_1,
    pocPrice,
    vwapPrice,
    maxBarPrice,
    barsInBox,
    netMove,
    d,
    directionName,
    favMove,
    advMove,
    totalVol: Math.round(totalVol),
    bullVol: Math.round(bullVol),
    bearVol: Math.round(bearVol),
    netDelta,
    netDeltaPct,
    cvdChg,
    bullPct,
    bearPct,
    absorbPct,
    absorbLevel,
    resultText,
    resultColor,
    candleCount,
    leftTime,
    rightTime,
    firstBarIndex,
    lastBarIndex,
    peakBarIndex,
    troughBarIndex
  };
}

// Register custom Rectangle (Box) and Measurement Ruler overlays
function registerCustomOverlays() {
  if (typeof klinecharts === 'undefined') return;

  const supported = klinecharts.getSupportedOverlays();

  // 1. Custom Box / Rectangle overlay: 4 corners resizable + 2 middle vertical handles to adjust width
  klinecharts.registerOverlay({
    name: 'rect',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    zLevel: 10,
    fixedZLevel: true,
    createPointFigures: ({ overlay, coordinates, bounding, yAxis, xAxis }) => {
      if (!coordinates || coordinates.length === 0) return [];
      const isArmed = Boolean(overlay?.extendData?.alarmMode && overlay.extendData.alarmMode !== 'OFF');
      const isBoth = (overlay?.extendData?.alarmMode === 'BOTH');

      const isGlobalFillDisabled = Boolean(window.__disableAllRectFill);
      const isThisBoxFillDisabled = Boolean(overlay?.extendData?.disableFill);
      const isFillDisabled = isGlobalFillDisabled || isThisBoxFillDisabled;

      const polyStyle = {
        style: isFillDisabled ? 'stroke' : 'stroke_fill',
        color: isFillDisabled
          ? 'transparent'
          : (isArmed ? (isBoth ? 'rgba(245, 158, 11, 0.16)' : 'rgba(236, 64, 122, 0.14)') : 'rgba(236, 64, 122, 0.12)'),
        borderColor: isArmed ? (isBoth ? '#f59e0b' : '#ec407a') : '#ec407a',
        borderSize: isArmed ? 2 : 1.5
      };

      if (coordinates.length >= 2) {
        // Enforce 100% geometric rectangle: (minX, minY) to (maxX, maxY)
        const xs = coordinates.map(c => c.x);
        const ys = coordinates.map(c => c.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const boxW = maxX - minX;
        const boxH = maxY - minY;

        const isBoxesDeactivated = Boolean(window.__hideBoxBodies);
        if (isBoxesDeactivated) {
          return [];
        }

        const figures = [
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
            styles: polyStyle
          }
        ];

        // Visual In-Box Trend Excursion Vector (Clean Canvas: Red ✕ Anchor & Cyan/Blue Trend Vector)
        const isGlobalHidden = Boolean(window.__hideAllRectVolumeOverlays);
        const isThisBoxHidden = Boolean(overlay?.extendData?.hideVolumeOverlay);

        if (!isGlobalHidden && !isThisBoxHidden) {
          const dataList = chartInstance?.getDataList?.() || [];
          const m = computeRectangleVolumeMetrics(overlay, dataList);

          if (m && m.totalVol > 0) {
            const isArrowsHidden = Boolean(overlay?.extendData?.hideArrows);
            if (!isArrowsHidden && boxW >= 16 && boxH >= 10) {
              const clampX = (x) => Math.max(minX + 4, Math.min(maxX - 4, x));
              const clampY = (y) => Math.max(minY + 4, Math.min(maxY - 4, y));

              const x0 = (xAxis && typeof xAxis.convertToPixel === 'function' && m.firstBarIndex !== null)
                ? xAxis.convertToPixel(m.firstBarIndex) : minX + 8;
              const y0 = (yAxis && typeof yAxis.convertToPixel === 'function')
                ? yAxis.convertToPixel(m.P_0) : (minY + maxY) / 2;

              const xPeak = (xAxis && typeof xAxis.convertToPixel === 'function' && m.peakBarIndex !== null)
                ? xAxis.convertToPixel(m.peakBarIndex) : minX + boxW * 0.7;
              const yPeak = (yAxis && typeof yAxis.convertToPixel === 'function')
                ? yAxis.convertToPixel(m.H_b) : minY + 4;

              const xTrough = (xAxis && typeof xAxis.convertToPixel === 'function' && m.troughBarIndex !== null)
                ? xAxis.convertToPixel(m.troughBarIndex) : minX + boxW * 0.3;
              const yTrough = (yAxis && typeof yAxis.convertToPixel === 'function')
                ? yAxis.convertToPixel(m.L_b) : maxY - 4;

              const ptStart = { x: clampX(x0), y: clampY(y0) };
              const ptPeak = { x: clampX(xPeak), y: clampY(yPeak) };
              const ptTrough = { x: clampX(xTrough), y: clampY(yTrough) };

              const ptFav = (m.d === 1) ? ptPeak : ptTrough;

              // Red ✕ Start Anchor at (t0, P0)
              figures.push({
                type: 'text',
                attrs: {
                  x: ptStart.x,
                  y: ptStart.y,
                  text: '✕',
                  align: 'center',
                  baseline: 'middle'
                },
                ignoreEvent: true,
                styles: {
                  color: '#ff1744',
                  size: 13,
                  weight: '900',
                  family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
                }
              });

              // Cyan / Blue Diagonal Favourable Excursion Arrow from ptStart to ptFav (Trend Vector)
              if (Math.hypot(ptFav.x - ptStart.x, ptFav.y - ptStart.y) >= 8) {
                figures.push({
                  type: 'line',
                  attrs: {
                    coordinates: [ptStart, ptFav]
                  },
                  ignoreEvent: true,
                  styles: {
                    color: '#00e5ff',
                    size: 1.8
                  }
                });

                // Arrowhead fins at ptFav
                const angle = Math.atan2(ptFav.y - ptStart.y, ptFav.x - ptStart.x);
                const headLen = 7;
                const fin1X = ptFav.x - headLen * Math.cos(angle - 0.45);
                const fin1Y = ptFav.y - headLen * Math.sin(angle - 0.45);
                const fin2X = ptFav.x - headLen * Math.cos(angle + 0.45);
                const fin2Y = ptFav.y - headLen * Math.sin(angle + 0.45);

                figures.push({
                  type: 'line',
                  attrs: {
                    coordinates: [
                      { x: fin1X, y: fin1Y },
                      { x: ptFav.x, y: ptFav.y },
                      { x: fin2X, y: fin2Y }
                    ]
                  },
                  ignoreEvent: true,
                  styles: {
                    color: '#00e5ff',
                    size: 1.8
                  }
                });

                // Numeric badge on the blue trend line showing excursion points
                const midX = (ptStart.x + ptFav.x) / 2;
                const midY = (ptStart.y + ptFav.y) / 2;
                const perpAngle = angle - Math.PI / 2;
                const offsetDist = 10;
                const labelX = clampX(midX + offsetDist * Math.cos(perpAngle));
                const labelY = clampY(midY + offsetDist * Math.sin(perpAngle));

                figures.push({
                  type: 'text',
                  attrs: {
                    x: labelX,
                    y: labelY,
                    text: `+${m.favMove.toFixed(1)}`,
                    align: 'center',
                    baseline: 'middle'
                  },
                  ignoreEvent: true,
                  styles: {
                    color: '#00e5ff',
                    size: 9.5,
                    weight: '800',
                    family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
                    backgroundColor: 'rgba(13, 17, 26, 0.90)',
                    borderColor: 'rgba(0, 229, 255, 0.55)',
                    borderSize: 1,
                    paddingLeft: 4,
                    paddingRight: 4,
                    paddingTop: 1.5,
                    paddingBottom: 1.5,
                    borderRadius: 3
                  }
                });
              }
            }
          }
        }

        return figures;
      }
      return [];
    },
    performEventPressedMove: ({ points, performPointIndex }) => {
      const dataList = chartInstance?.getDataList?.() || [];
      if (dataList.length > 0 && Array.isArray(points)) {
        const lastIdx = dataList.length - 1;
        const lastBar = dataList[lastIdx];
        const firstBar = dataList[0];
        const tfMins = window.__currentTimeframeMinutes || 5;
        const barMs = tfMins * 60 * 1000;
        for (let i = 0; i < points.length; i++) {
          const pt = points[i];
          if (pt && typeof pt.dataIndex === 'number') {
            if (pt.dataIndex > lastIdx) {
              pt.timestamp = lastBar.timestamp + Math.round((pt.dataIndex - lastIdx) * barMs);
            } else if (pt.dataIndex < 0 && firstBar) {
              pt.timestamp = firstBar.timestamp + Math.round(pt.dataIndex * barMs);
            } else if (dataList[pt.dataIndex]) {
              pt.timestamp = dataList[pt.dataIndex].timestamp;
            }
          }
        }
      }
      if (points?.length === 6) {
        handleRectPressedMove(points, performPointIndex, dataList, window.__currentTimeframeMinutes || 5);
      } else if (window.__isShiftPressed && points?.length >= 2 && performPointIndex === 1) {
        points[1].value = points[0].value;
      }
    },
    performEventMoveForDrawing: ({ points, performPointIndex }) => {
      const dataList = chartInstance?.getDataList?.() || [];
      if (dataList.length > 0 && Array.isArray(points)) {
        const lastIdx = dataList.length - 1;
        const lastBar = dataList[lastIdx];
        const firstBar = dataList[0];
        const tfMins = window.__currentTimeframeMinutes || 5;
        const barMs = tfMins * 60 * 1000;
        for (let i = 0; i < points.length; i++) {
          const pt = points[i];
          if (pt && typeof pt.dataIndex === 'number') {
            if (pt.dataIndex > lastIdx) {
              pt.timestamp = lastBar.timestamp + Math.round((pt.dataIndex - lastIdx) * barMs);
            } else if (pt.dataIndex < 0 && firstBar) {
              pt.timestamp = firstBar.timestamp + Math.round(pt.dataIndex * barMs);
            } else if (dataList[pt.dataIndex]) {
              pt.timestamp = dataList[pt.dataIndex].timestamp;
            }
          }
        }
      }
    },
    onDrawEnd: ({ overlay, chart }) => {
      if (overlay?.points && overlay.points.length >= 2) {
        const c = chart || chartInstance;
        const dList = c?.getDataList?.() || [];
        const sixPoints = normalizeRectPoints(overlay.points, dList);
        if (c && typeof c.overrideOverlay === 'function') {
          c.overrideOverlay({ id: overlay.id, points: sixPoints });
        } else {
          overlay.points = sixPoints;
        }
      }
      recalculateRectZLevels(chart || chartInstance);
      updateExtensionSeriesRibbon(chart || chartInstance);
    },
    onPressedMoveEnd: ({ overlay, chart }) => {
      if (overlay?.name === 'rect' && overlay?.points) {
        const c = chart || chartInstance;
        const dList = c?.getDataList?.() || [];
        const sixPoints = normalizeRectPoints(overlay.points, dList);
        if (c && typeof c.overrideOverlay === 'function') {
          c.overrideOverlay({ id: overlay.id, points: sixPoints });
        } else {
          overlay.points = sixPoints;
        }
      }
      recalculateRectZLevels(chart || chartInstance);
      updateExtensionSeriesRibbon(chart || chartInstance);
    },
    onClick: (event) => {
      const overlay = event?.overlay;
      const figure = event?.figure;
      // 1. If a point handle was clicked (circle), it's a resize handle click - do not cycle!
      if (figure && (figure.type === 'circle' || figure.name === 'circle' || String(figure.key || '').includes('point_'))) {
        return true;
      }

      // 2. Check if multiple rectangle overlays overlap at this click point
      const c = event?.chart || chartInstance;
      if (!c || typeof c.getOverlays !== 'function') return true;

      const allOverlays = c.getOverlays() || [];
      const rects = allOverlays.filter(o => o.name === 'rect' && o.points && o.points.length >= 2);
      if (rects.length <= 1) return true;

      // Click coordinates
      const clickX = event?.x ?? event?.clientX;
      const clickY = event?.y ?? event?.clientY;
      if (typeof clickX !== 'number' || typeof clickY !== 'number') return true;

      // Find all rects that contain this coordinate
      const hitRects = [];
      for (const r of rects) {
        if (typeof c.convertToPixel !== 'function') continue;
        const coords = c.convertToPixel(r.points);
        if (!coords || coords.length < 2) continue;
        const xs = coords.map(pt => pt.x);
        const ys = coords.map(pt => pt.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        if (clickX >= minX && clickX <= maxX && clickY >= minY && clickY <= maxY) {
          hitRects.push(r);
        }
      }

      // If multiple rectangles overlap at this click location
      if (hitRects.length > 1) {
        const currentSelectedId = window.__selectedOverlay?.id;
        // If the current rect is already selected, cycle to the next overlapping box!
        if (currentSelectedId && hitRects.some(r => r.id === currentSelectedId)) {
          const curIdx = hitRects.findIndex(r => r.id === currentSelectedId);
          const nextRect = hitRects[(curIdx + 1) % hitRects.length];

          if (nextRect && nextRect.id !== currentSelectedId) {
            if (c._chartStore && typeof c._chartStore.setClickOverlayInfo === 'function') {
              c._chartStore.setClickOverlayInfo({
                paneId: 'candle_pane',
                overlay: nextRect,
                figureType: 'other',
                figureIndex: -1,
                figure: null
              }, (ov) => {
                if (typeof window.__handleOverlaySelected === 'function') {
                  window.__handleOverlaySelected({ overlay: ov });
                }
              }, (ov) => {
                if (typeof window.__handleOverlayDeselected === 'function') {
                  window.__handleOverlayDeselected({ overlay: ov });
                }
              });
              if (typeof c._chartStore._sortOverlays === 'function') {
                c._chartStore._sortOverlays();
              }
              if (typeof c.updatePane === 'function') {
                c.updatePane(1);
              }
              return true;
            }
          }
        }
      }

      return true;
    }
  });

  // 1a-1. Enhanced Vertical Straight Line with Time Alarm support & visual badge
  klinecharts.registerOverlay({
    name: 'verticalStraightLine',
    totalStep: 2,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: false,
    zLevel: 200,
    fixedZLevel: true,
    createPointFigures: ({ overlay, coordinates, bounding }) => {
      if (coordinates && coordinates.length > 0) {
        const x = coordinates[0].x;
        const isArmed = Boolean(overlay?.extendData?.alarmActive);
        const isAlerted = Boolean(overlay?.extendData?.alerted);
        const h = bounding?.height || 2000;

        const figures = [
          {
            type: 'line',
            attrs: {
              coordinates: [
                { x: x, y: 0 },
                { x: x, y: h }
              ]
            },
            styles: {
              style: isArmed ? 'dashed' : 'solid',
              color: isArmed ? '#f59e0b' : (isAlerted ? '#06b6d4' : (overlay?.styles?.line?.color || '#94a3b8')),
              size: isArmed ? 2 : 1.5,
              dashedValue: [4, 4]
            }
          }
        ];

        // If alarm is armed or triggered, render an informative TradingView-style pill tag at the top
        if (isArmed || isAlerted) {
          const pt0 = overlay.points?.[0];
          let timeStr = '';
          if (pt0?.timestamp) {
            timeStr = new Date(pt0.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
          }
          const badgeText = isAlerted ? `✅ TOUCHED ${timeStr}` : `🔔 TIME ALARM ${timeStr}`;
          figures.push({
            type: 'text',
            attrs: {
              x: x + 6,
              y: 28,
              text: badgeText,
              align: 'left',
              baseline: 'top'
            },
            styles: {
              color: isAlerted ? '#06b6d4' : '#f59e0b',
              size: 11,
              weight: 'bold',
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
              paddingLeft: 6,
              paddingRight: 6,
              paddingTop: 3,
              paddingBottom: 3,
              backgroundColor: 'rgba(15, 23, 42, 0.88)',
              borderRadius: 3
            }
          });
        }

        return figures;
      }
      return [];
    }
  });

  // 1a-2. Long Position & Short Position Tools (TradingView Style with Exact Info Box)
  function registerPositionOverlay(posName, isLong) {
    if (supported.includes(posName)) return;

    klinecharts.registerOverlay({
      name: posName,
      totalStep: 2,
      needDefaultPointFigure: true,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: true,
      createPointFigures: ({ overlay, coordinates, yAxis }) => {
        if (!coordinates || coordinates.length === 0) return [];

        const pt0 = overlay.points?.[0];
        const pt1 = overlay.points?.[1];
        const pt2 = overlay.points?.[2];

        const p0Val = Number(pt0?.value) || 0;
        const defaultTargetDelta = 10.0;
        const defaultStopDelta = 5.0;
        const p1Val = (pt1 && typeof pt1.value === 'number') ? pt1.value : (isLong ? (p0Val + defaultTargetDelta) : (p0Val - defaultTargetDelta));
        const p2Val = (pt2 && typeof pt2.value === 'number') ? pt2.value : (isLong ? (p0Val - defaultStopDelta) : (p0Val + defaultStopDelta));

        const entryY = (yAxis && typeof yAxis.convertToPixel === 'function' && p0Val)
          ? yAxis.convertToPixel(p0Val)
          : (coordinates[0]?.y ?? 0);

        const targetY = (yAxis && typeof yAxis.convertToPixel === 'function' && p1Val)
          ? yAxis.convertToPixel(p1Val)
          : (coordinates[1]?.y ?? (entryY + (isLong ? -60 : 60)));

        const stopY = (yAxis && typeof yAxis.convertToPixel === 'function' && p2Val)
          ? yAxis.convertToPixel(p2Val)
          : (coordinates[2]?.y ?? (entryY + (isLong ? 30 : -30)));

        const startX = coordinates[0]?.x ?? 0;
        const endX = coordinates[1]?.x ?? (startX + 140);
        const boxLeft = Math.min(startX, endX);
        const boxRight = Math.max(startX, endX);

        const figures = [];

        // 1. Target (Profit) Shaded Zone (Green #089981)
        figures.push({
          type: 'polygon',
          attrs: {
            coordinates: [
              { x: boxLeft, y: entryY },
              { x: boxRight, y: entryY },
              { x: boxRight, y: targetY },
              { x: boxLeft, y: targetY }
            ]
          },
          styles: {
            style: 'stroke_fill',
            color: 'rgba(8, 153, 129, 0.18)',
            borderColor: '#089981',
            borderSize: 1.2
          }
        });

        // 2. Stop Loss (Risk) Shaded Zone (Red #f23645)
        figures.push({
          type: 'polygon',
          attrs: {
            coordinates: [
              { x: boxLeft, y: entryY },
              { x: boxRight, y: entryY },
              { x: boxRight, y: stopY },
              { x: boxLeft, y: stopY }
            ]
          },
          styles: {
            style: 'stroke_fill',
            color: 'rgba(242, 54, 69, 0.18)',
            borderColor: '#f23645',
            borderSize: 1.2
          }
        });

        // 3. Center Entry Divider Line
        const isArmed = Boolean(overlay.extendData?.isArmed);
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: boxLeft, y: entryY }, { x: boxRight, y: entryY }] },
          styles: {
            color: isArmed ? '#10b981' : '#94a3b8',
            size: isArmed ? 2.5 : 1.5,
            style: 'solid'
          }
        });

        // 4. Lots & Dollar Calculations (Standard Gold XAUUSD: 1 Lot = 100 oz)
        const lots = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : Number(localStorage.getItem('escanor_global_lot') || localStorage.getItem('escanor_measure_lots') || 1.00);
        const targetDiff = isLong ? (p1Val - p0Val) : (p0Val - p1Val);
        const targetDollars = targetDiff * lots * 100;
        const dollarStr = Math.abs(targetDollars).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        const stopDiff = isLong ? (p0Val - p2Val) : (p2Val - p0Val);
        const stopDollars = stopDiff * lots * 100;
        const stopDollarStr = Math.abs(stopDollars).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        const rr = (stopDiff > 0.001) ? (targetDiff / stopDiff) : 0;

        // 5. Target Info Box (TradingView Emerald Pill) — includes target price, lots, dollars, and R:R
        const targetText = `Target: ${p1Val.toFixed(2)}, Lots: ${lots.toFixed(2)}, Amount: $${dollarStr} (R:R ${rr.toFixed(2)})`;
        figures.push({
          type: 'text',
          attrs: {
            x: boxLeft + 6,
            y: isLong ? (targetY - 12) : (targetY + 12),
            text: targetText,
            align: 'left',
            baseline: isLong ? 'bottom' : 'top'
          },
          styles: {
            color: '#ffffff',
            size: 11,
            weight: 'bold',
            family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
            backgroundColor: '#089981',
            borderRadius: 4,
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 4,
            paddingBottom: 4
          }
        });

        // 6. Stop Loss Info Box (TradingView Red Pill) — includes stop price, lots, and dollars
        const stopText = `Stop: ${p2Val.toFixed(2)}, Lots: ${lots.toFixed(2)}, Amount: -$${stopDollarStr}`;
        figures.push({
          type: 'text',
          attrs: {
            x: boxLeft + 6,
            y: isLong ? (stopY + 12) : (stopY - 12),
            text: stopText,
            align: 'left',
            baseline: isLong ? 'top' : 'bottom'
          },
          styles: {
            color: '#ffffff',
            size: 11,
            weight: 'bold',
            family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
            backgroundColor: '#f23645',
            borderRadius: 4,
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 4,
            paddingBottom: 4
          }
        });

        // Center Open R:R box removed per user requirement

        return figures;
      },
      createYAxisFigures: ({ overlay, yAxis }) => {
        if (!yAxis || typeof yAxis.convertToPixel !== 'function') return [];
        const pt0 = overlay.points?.[0];
        const pt1 = overlay.points?.[1];
        const pt2 = overlay.points?.[2];
        const p0Val = Number(pt0?.value) || 0;
        const p1Val = (pt1 && typeof pt1.value === 'number') ? pt1.value : (isLong ? p0Val + 10 : p0Val - 10);
        const p2Val = (pt2 && typeof pt2.value === 'number') ? pt2.value : (isLong ? p0Val - 5 : p0Val + 5);
        const isArmed = Boolean(overlay.extendData?.isArmed);

        const yFigs = [
          {
            type: 'text',
            attrs: { x: yAxis.width || 60, y: yAxis.convertToPixel(p1Val), text: p1Val.toFixed(2), align: 'right', baseline: 'middle' },
            styles: { color: '#ffffff', size: 10, weight: 'bold', backgroundColor: '#089981', borderRadius: 2, paddingLeft: 4, paddingRight: 4, paddingTop: 1.5, paddingBottom: 1.5 }
          },
          {
            type: 'text',
            attrs: { x: yAxis.width || 60, y: yAxis.convertToPixel(p2Val), text: p2Val.toFixed(2), align: 'right', baseline: 'middle' },
            styles: { color: '#ffffff', size: 10, weight: 'bold', backgroundColor: '#f23645', borderRadius: 2, paddingLeft: 4, paddingRight: 4, paddingTop: 1.5, paddingBottom: 1.5 }
          }
        ];

        if (isArmed && p0Val > 0) {
          yFigs.push({
            type: 'text',
            attrs: { x: yAxis.width || 60, y: yAxis.convertToPixel(p0Val), text: `⚡ ${p0Val.toFixed(2)}`, align: 'right', baseline: 'middle' },
            styles: { color: '#ffffff', size: 10, weight: 'bold', backgroundColor: '#059669', borderRadius: 2, paddingLeft: 4, paddingRight: 4, paddingTop: 1.5, paddingBottom: 1.5 }
          });
        }
        return yFigs;
      },
      performEventPressedMove: ({ points, performPointIndex }) => {
        if (!points || points.length < 3) return;

        // Point 1 is Target
        if (performPointIndex === 1) {
          points[2].timestamp = points[1].timestamp;
          if (isLong && points[1].value <= points[0].value) {
            points[1].value = points[0].value + 0.1;
          } else if (!isLong && points[1].value >= points[0].value) {
            points[1].value = points[0].value - 0.1;
          }
        }
        // Point 2 is Stop Loss
        else if (performPointIndex === 2) {
          points[1].timestamp = points[2].timestamp;
          if (isLong && points[2].value >= points[0].value) {
            points[2].value = points[0].value - 0.1;
          } else if (!isLong && points[2].value <= points[0].value) {
            points[2].value = points[0].value + 0.1;
          }
        }
      }
    });
  }

  registerPositionOverlay('longPosition', true);
  registerPositionOverlay('shortPosition', false);

  // 1b. Structural Institutional Levels (PDH, PDL, Asian Levels, VWAP/GEX, FVG Shelves)
  if (!supported.includes('structuralLevel')) {
    klinecharts.registerOverlay({
      name: 'structuralLevel',
      totalStep: 2,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: true,
      createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
        const data = overlay.extendData || {};
        const price = overlay.points[0]?.value;
        const y = (yAxis && typeof yAxis.convertToPixel === 'function' && typeof price === 'number')
          ? yAxis.convertToPixel(price)
          : (coordinates[0]?.y ?? 0);

        const width = bounding.width;
        const color = data.color || '#f59e0b';
        const lineStyle = data.lineStyle || 'dashed';
        const lineSize = data.lineSize || 1.0; // Very thin
        const opacity = data.opacity !== undefined ? data.opacity : 0.30; // 30% opacity
        const title = data.title || '';

        // Helper to convert hex to rgba
        function hexToRgba(hex, a) {
          if (!hex) return `rgba(245, 158, 11, ${a})`;
          if (hex.startsWith('rgba')) return hex;
          let c = hex.replace('#', '');
          if (c.length === 3) c = c.split('').map(x => x + x).join('');
          const num = parseInt(c, 16);
          return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${a})`;
        }

        const lineRgba = hexToRgba(color, opacity);
        const badgeBg = hexToRgba(color, Math.min(0.55, opacity + 0.15));

        const figures = [];

        // Full-width horizontal reference line (ultra-thin, 30% opacity)
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: 0, y }, { x: width, y }] },
          styles: {
            style: lineStyle,
            dashedValue: [4, 4],
            color: lineRgba,
            size: lineSize
          }
        });

        // Pill text badge on the left side of the chart (soft muted 30-45% opacity background)
        if (title) {
          figures.push({
            type: 'text',
            attrs: { x: 12, y: y - 11, text: title, baseline: 'top' },
            styles: {
              color: 'rgba(255, 255, 255, 0.70)',
              size: 9.5,
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
              weight: 'bold',
              backgroundColor: badgeBg,
              borderRadius: 3,
              paddingLeft: 5,
              paddingRight: 5,
              paddingTop: 1.5,
              paddingBottom: 1.5
            }
          });
        }

        return figures;
      },
      createYAxisFigures: ({ overlay, coordinates, bounding, yAxis }) => {
        const data = overlay.extendData || {};
        const price = overlay.points[0]?.value;
        const y = (yAxis && typeof yAxis.convertToPixel === 'function' && typeof price === 'number')
          ? yAxis.convertToPixel(price)
          : (coordinates[0]?.y ?? 0);

        const color = data.color || '#f59e0b';
        const label = data.yLabel || (typeof price === 'number' ? price.toFixed(2) : '');
        const opacity = data.opacity !== undefined ? data.opacity : 0.30;

        function hexToRgba(hex, a) {
          if (!hex) return `rgba(245, 158, 11, ${a})`;
          if (hex.startsWith('rgba')) return hex;
          let c = hex.replace('#', '');
          if (c.length === 3) c = c.split('').map(x => x + x).join('');
          const num = parseInt(c, 16);
          return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${a})`;
        }

        const yAxisBg = hexToRgba(color, Math.min(0.60, opacity + 0.20));

        return [
          {
            type: 'text',
            attrs: { x: bounding.width, y, text: label, align: 'right', baseline: 'middle' },
            styles: {
              color: 'rgba(255, 255, 255, 0.85)',
              size: 9.5,
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
              weight: 'bold',
              backgroundColor: yAxisBg,
              borderRadius: 2,
              paddingLeft: 4,
              paddingRight: 4,
              paddingTop: 1.5,
              paddingBottom: 1.5
            }
          }
        ];
      }
    });
  }

  // 1c. Selected Line SL & TP Projection Markings (Thin draggable lines with dollar calculations)
  if (!supported.includes('lineSlTpMarking')) {
    klinecharts.registerOverlay({
      name: 'lineSlTpMarking',
      totalStep: 2,
      needDefaultPointFigure: false,
      needDefaultXAxisFigure: false,
      needDefaultYAxisFigure: true,
      zLevel: Number.MAX_SAFE_INTEGER,
      fixedZLevel: true,
      createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
        const data = overlay.extendData || {};
        const ptPrice = overlay.points?.[0]?.value;

        // Use coordinates[0].y directly during drag to lock visual figure to the mouse position without jumping
        const y = (coordinates && coordinates[0] && typeof coordinates[0].y === 'number' && !isNaN(coordinates[0].y))
          ? coordinates[0].y
          : ((yAxis && typeof yAxis.convertToPixel === 'function' && typeof ptPrice === 'number')
              ? yAxis.convertToPixel(ptPrice)
              : 0);

        // Derive price dynamically from y coordinate so badge is synchronized with the line position
        const price = (yAxis && typeof yAxis.convertFromPixel === 'function' && typeof y === 'number')
          ? yAxis.convertFromPixel(y)
          : (typeof ptPrice === 'number' ? ptPrice : 0);

        const width = bounding.width;
        const isTp = data.type === 'TP';
        const color = isTp ? '#00f5a0' : '#ef4444';

        // Calculate dynamic real-time badge title during drag
        let title = data.title || '';
        if (typeof price === 'number' && typeof data.linePrice === 'number') {
          const vol = Number(data.volume || 0.50);
          const dist = Math.abs(price - data.linePrice);
          const dollar = dist * vol * 100;
          const isFavorable = isTp;
          const sign = isFavorable ? '+' : '-';
          const prefix = isTp ? '🎯 TP' : '🛑 SL';
          title = `${prefix}: $${price.toFixed(2)} [${sign}$${dollar.toFixed(2)} • ${sign}${dist.toFixed(1)} pt] (${vol.toFixed(2)}L) ⇅`;
        }

        const figures = [];

        // 1. Transparent wide touch/click strike zone (32px vertical grab tolerance across full width)
        figures.push({
          type: 'rect',
          attrs: {
            x: 0,
            y: y - 16,
            width: width,
            height: 32
          },
          styles: {
            style: 'fill',
            color: 'transparent',
            borderColor: 'transparent',
            borderSize: 0
          }
        });

        // 2. Thin horizontal dashed reference line across chart
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: 0, y }, { x: width, y }] },
          styles: {
            style: 'dashed',
            dashedValue: [5, 4],
            color: color,
            size: 1.2
          }
        });

        // 3. Crisp pill badge with dollar calculations & drag indicator
        if (title) {
          const badgeX = Math.max(10, width - 330);
          figures.push({
            type: 'text',
            attrs: {
              x: badgeX,
              y: y - 11,
              text: title,
              baseline: 'top'
            },
            styles: {
              color: '#ffffff',
              size: 10,
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
              weight: 'bold',
              paddingLeft: 8,
              paddingRight: 8,
              paddingTop: 3,
              paddingBottom: 3,
              backgroundColor: isTp ? 'rgba(0, 245, 160, 0.28)' : 'rgba(239, 68, 68, 0.28)',
              borderColor: isTp ? '#00f5a0' : '#ef4444',
              borderRadius: 4,
              borderSize: 1
            }
          });
        }

        return figures;
      },
      createYAxisFigures: ({ overlay, coordinates, bounding, yAxis }) => {
        const data = overlay.extendData || {};
        const price = overlay.points[0]?.value;
        const y = (yAxis && typeof yAxis.convertToPixel === 'function' && typeof price === 'number')
          ? yAxis.convertToPixel(price)
          : (coordinates[0]?.y ?? 0);

        const isTp = data.type === 'TP';
        const text = `${isTp ? 'TP' : 'SL'}: ${typeof price === 'number' ? price.toFixed(2) : ''}`;

        return [
          {
            type: 'text',
            attrs: { x: bounding.width, y, text, align: 'right', baseline: 'middle' },
            styles: {
              color: '#ffffff',
              size: 9.5,
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
              weight: 'bold',
              backgroundColor: isTp ? 'rgba(0, 245, 160, 0.85)' : 'rgba(239, 68, 68, 0.85)',
              borderRadius: 2,
              paddingLeft: 4,
              paddingRight: 4,
              paddingTop: 1.5,
              paddingBottom: 1.5
            }
          }
        ];
      }
    });
  }

  // 2. Active MT5 Position & Pending Order Line (Draggable SL & TP)
  klinecharts.registerOverlay({
    name: 'activeTradeOrder',
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: true,
    zLevel: Number.MAX_SAFE_INTEGER,
    fixedZLevel: true,
    createPointFigures: ({ overlay, coordinates, bounding, yAxis }) => {
      const data = overlay.extendData || {};
      const price = overlay.points[0]?.value;
      const y = (yAxis && typeof yAxis.convertToPixel === 'function' && typeof price === 'number')
        ? yAxis.convertToPixel(price)
        : (coordinates[0]?.y ?? 0);

      const width = bounding.width;
      const isSl = data.orderType === 'SL';
      const isTp = data.orderType === 'TP';
      const isDraggable = isSl || isTp;
      const isPending = Boolean(data.isPending);

      let color = '#38bdf8';
      if (isSl) color = '#ef4444';
      else if (isTp) color = '#10b981';
      else if (isPending) color = '#f59e0b';
      else color = data.isBuy ? '#00f5a0' : '#ef4444';

      const lineStyle = (isSl || isTp || isPending) ? 'dashed' : 'solid';
      const lineSize = isDraggable ? 2 : 1.5;

      // Real-time dynamic calculation of dollar ($) and pips during drag motion
      let title = data.title || '';
      if (isDraggable && typeof price === 'number' && data.openPrice) {
        const vol = Number(data.volume || 0.50);
        const dist = Math.abs(price - data.openPrice);
        const dollar = dist * vol * 100;
        const isFavorable = data.isBuy ? (price >= data.openPrice) : (price <= data.openPrice);
        const sign = isFavorable ? '+' : '-';
        title = `${vol}L  ${sign}$${dollar.toFixed(2)}`;
      }

      const figures = [];

      // 1. Transparent wide touch/click strike zone (32px vertical grab tolerance across full width)
      // Enables effortless one-touch grab on mobile touchscreens and desktop mice
      if (isDraggable) {
        figures.push({
          type: 'rect',
          attrs: {
            x: 0,
            y: y - 16,
            width: width,
            height: 32
          },
          styles: {
            style: 'fill',
            color: 'transparent',
            borderColor: 'transparent',
            borderSize: 0
          }
        });
      }

      // 2. Visible Order Line
      figures.push({
        type: 'line',
        attrs: { coordinates: [{ x: 0, y }, { x: width, y }] },
        styles: {
          style: lineStyle,
          dashedValue: [5, 4],
          color: color,
          size: lineSize
        }
      });

      // 3. Information & Drag Handle Badge with enlarged touch padding
      figures.push({
        type: 'text',
        attrs: { x: 14, y: y - 14, text: title, baseline: 'top' },
        styles: {
          color: '#ffffff',
          size: 11,
          family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          weight: 'bold',
          backgroundColor: color,
          borderRadius: 4,
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 3,
          paddingBottom: 3
        }
      });

      return figures;
    },
    createYAxisFigures: ({ overlay, coordinates, bounding, yAxis }) => {
      const data = overlay.extendData || {};
      const price = overlay.points[0]?.value;
      const y = (yAxis && typeof yAxis.convertToPixel === 'function' && typeof price === 'number')
        ? yAxis.convertToPixel(price)
        : (coordinates[0]?.y ?? 0);

      const isSl = data.orderType === 'SL';
      const isTp = data.orderType === 'TP';
      let color = '#38bdf8';
      if (isSl) color = '#ef4444';
      else if (isTp) color = '#10b981';
      else if (data.isPending) color = '#f59e0b';
      else color = data.isBuy ? '#00f5a0' : '#ef4444';

      // When a trade is active, show only lots and dollars on the order axis label as well
      const text = data.title || `${data.orderType || 'ORDER'}: ${typeof price === 'number' ? price.toFixed(2) : ''}`;

      return [
        {
          type: 'text',
          attrs: { x: bounding.width, y, text, align: 'right', baseline: 'middle' },
          styles: {
            color: '#ffffff',
            size: 10,
            family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            weight: 'bold',
            backgroundColor: color,
            borderRadius: 2,
            paddingLeft: 5,
            paddingRight: 5,
            paddingTop: 2,
            paddingBottom: 2
          }
        }
      ];
    },
    performEventPressedMove: function({ points, performPoint }) {
      if (points[0] && performPoint && typeof performPoint.value === 'number') {
        points[0].value = Math.round(performPoint.value * 100) / 100;
      }
      if (this && this.extendData) {
        this.extendData.isDragging = true;
        if (this.extendData.key) {
          window.__currentDraggingOrderKey = this.extendData.key;
        }
      }
    },
    onPressedMoveStart: function(e) {
      if (this && this.extendData) {
        this.extendData.isDragging = true;
        if (this.extendData.key) {
          window.__currentDraggingOrderKey = this.extendData.key;
        }
      }
    },
    onPressedMoving: function(e) {
      if (this && this.extendData) {
        this.extendData.isDragging = true;
        if (this.extendData.key) {
          window.__currentDraggingOrderKey = this.extendData.key;
        }
      }
    },
    onPressedMoveEnd: function(e) {
      if (this && this.extendData) {
        this.extendData.isDragging = false;
      }
      window.__currentDraggingOrderKey = null;
    }
  });

  // 2. Custom Measurement Ruler Box (Exact Match to TradingView Image 1 & 2)
  klinecharts.registerOverlay({
    name: 'measureBox',
    totalStep: 3,
    needDefaultPointFigure: false,
    createPointFigures: ({ coordinates, overlay, xAxis }) => {
      if (coordinates.length === 2 && overlay.points?.length === 2) {
        const [p1, p2] = coordinates;
        const [pt1, pt2] = overlay.points;

        const val1 = Number(pt1.value) || 0;
        const val2 = Number(pt2.value) || 0;
        const valDiff = val2 - val1;
        const pctDiff = val1 !== 0 ? (valDiff / val1) * 100 : 0;
        const isUp = valDiff >= 0;

        // Subtle shaded box & border (TradingView style)
        const boxColor = isUp ? 'rgba(8, 153, 129, 0.16)' : 'rgba(236, 64, 122, 0.16)';
        const borderColor = isUp ? '#089981' : '#ec407a';

        // Precise Bar Count from dataIndex or xAxis pixel conversion
        let idx1 = pt1.dataIndex;
        let idx2 = pt2.dataIndex;
        if (!Number.isFinite(idx1) && xAxis && coordinates[0]) {
          idx1 = xAxis.convertFromPixel(coordinates[0].x);
        }
        if (!Number.isFinite(idx2) && xAxis && coordinates[1]) {
          idx2 = xAxis.convertFromPixel(coordinates[1].x);
        }
        if (!Number.isFinite(idx1)) idx1 = 0;
        if (!Number.isFinite(idx2)) idx2 = 0;
        idx1 = Math.round(idx1);
        idx2 = Math.round(idx2);

        const barsCount = Math.max(1, Math.abs(idx2 - idx1) + 1);

        // Time duration = barsCount * timeframeMinutes (accurate even into future empty space)
        const tfMins = window.__currentTimeframeMinutes || 5;
        const totalMinutes = barsCount * tfMins;
        const days = Math.floor(totalMinutes / 1440);
        const hours = Math.floor((totalMinutes % 1440) / 60);
        const mins = totalMinutes % 60;
        let timeStr = '';
        if (days > 0) {
          timeStr = `${days}d ${hours}h`;
        } else if (hours > 0) {
          timeStr = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        } else {
          timeStr = `${mins}m`;
        }

        // Ticks for Gold (1 pt = 100 ticks)
        const ticks = valDiff * 100;
        const sign = valDiff >= 0 ? '+' : '-';
        const absVal = Math.abs(valDiff).toFixed(3);
        const absPct = Math.abs(pctDiff).toFixed(2);
        const absTicks = Math.abs(ticks).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

        // Volume calculation within actual bar boundaries
        const allBars = chartInstance?.getDataList() || [];
        const startIdx = Math.max(0, Math.min(idx1, idx2));
        const endIdx = Math.min(allBars.length - 1, Math.max(idx1, idx2));
        let totalVol = 0;
        if (allBars.length > 0 && startIdx <= endIdx) {
          for (let i = startIdx; i <= endIdx; i++) {
            totalVol += Number(allBars[i]?.volume || 0);
          }
        }
        let volStr = '';
        if (totalVol >= 1000000) {
          volStr = `${(totalVol / 1000000).toFixed(3)}M`;
        } else if (totalVol >= 1000) {
          volStr = `${(totalVol / 1000).toFixed(3)}K`;
        } else {
          volStr = `${totalVol.toFixed(0)}`;
        }

        // Configured Lots from Global Header Setting (defaults to 1.00 lot)
        const lots = (typeof window.getGlobalLot === 'function') ? window.getGlobalLot() : Number(localStorage.getItem('escanor_global_lot') || localStorage.getItem('escanor_measure_lots') || 1.00);
        // Gold (XAUUSD): 1.00 lot = 100 oz. Dollar P&L = price move * lots * 100
        const dollars = valDiff * lots * 100;
        const absDollars = Math.abs(dollars).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const dollarSign = dollars >= 0 ? '+' : '-';
        const lotStr = lots.toFixed(2);

        // Badge lines:
        // Line 1: TradingView price move & ticks (-10.256 (-0.25%) -1,025.6)
        // Line 2: Dollar P&L with active lot size (-$1,025.60 • 1.00 lot)
        // Line 3: Bar count, duration & volume (7 bars, 35m • Vol 14.65K)
        const line1 = `${sign}${absVal} (${sign}${absPct}%) ${sign}${absTicks}`;
        const line2 = `${dollarSign}$${absDollars} (${lotStr} lot${lots === 1 ? '' : 's'})`;
        const line3 = `${barsCount} bars, ${timeStr} • Vol ${volStr}`;

        // Crosshairs & arrow
        const midY = (p1.y + p2.y) / 2;
        const arrowDir = p2.x >= p1.x ? -1 : 1;
        const arrowHead = [
          { x: p2.x + arrowDir * 7, y: midY - 4 },
          { x: p2.x, y: midY },
          { x: p2.x + arrowDir * 7, y: midY + 4 }
        ];

        // Badge placement (Centered horizontally, pinned below or above box)
        const boxMinX = Math.min(p1.x, p2.x);
        const boxMaxX = Math.max(p1.x, p2.x);
        const boxMaxY = Math.max(p1.y, p2.y);
        const boxMinY = Math.min(p1.y, p2.y);

        const badgeW = 236;
        const badgeH = 76;
        let badgeX = boxMinX + (boxMaxX - boxMinX) / 2 - (badgeW / 2);
        let badgeY = boxMaxY + 10;

        if (badgeY + badgeH > window.innerHeight - 60) {
          badgeY = Math.max(50, boxMinY - badgeH - 10);
        }

        const badgeBgColor = isUp ? '#089981' : '#f43f5e';

        return [
          // 1. Shaded Measurement Area
          {
            type: 'polygon',
            attrs: {
              coordinates: [
                { x: p1.x, y: p1.y },
                { x: p2.x, y: p1.y },
                { x: p2.x, y: p2.y },
                { x: p1.x, y: p2.y }
              ]
            },
            styles: {
              style: 'stroke_fill',
              color: boxColor,
              borderColor: borderColor,
              borderSize: 1,
              borderStyle: 'solid'
            }
          },
          // 2. Horizontal Center Crosshair
          {
            type: 'line',
            attrs: {
              coordinates: [
                { x: p1.x, y: midY },
                { x: p2.x, y: midY }
              ]
            },
            styles: {
              color: borderColor,
              size: 1,
              style: 'solid'
            }
          },
          // 3. Directional Arrow Head
          {
            type: 'line',
            attrs: {
              coordinates: arrowHead
            },
            styles: {
              color: borderColor,
              size: 1.5,
              style: 'solid'
            }
          },
          // 4. Vertical Crosshair
          {
            type: 'line',
            attrs: {
              coordinates: [
                { x: p2.x, y: p1.y },
                { x: p2.x, y: p2.y }
              ]
            },
            styles: {
              color: borderColor,
              size: 1,
              style: 'solid'
            }
          },
          // 5. Solid Rounded Badge Background (Matching user image)
          {
            type: 'rect',
            attrs: {
              x: badgeX,
              y: badgeY,
              width: badgeW,
              height: badgeH
            },
            styles: {
              style: 'stroke_fill',
              color: badgeBgColor,
              borderColor: 'rgba(255, 255, 255, 0.25)',
              borderSize: 1,
              borderRadius: 8
            }
          },
          // 6. Badge Text Line 1: Price (Pct) Ticks
          {
            type: 'text',
            attrs: {
              x: badgeX + badgeW / 2,
              y: badgeY + 14,
              text: line1,
              align: 'center'
            },
            styles: {
              color: '#ffffff',
              backgroundColor: 'transparent',
              borderColor: 'transparent',
              borderSize: 0,
              paddingLeft: 0,
              paddingRight: 0,
              paddingTop: 0,
              paddingBottom: 0,
              size: 12.5,
              weight: 'bold',
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }
          },
          // 7. Badge Text Line 2: Dollars P&L & Lot
          {
            type: 'text',
            attrs: {
              x: badgeX + badgeW / 2,
              y: badgeY + 34,
              text: line2,
              align: 'center'
            },
            styles: {
              color: '#ffffff',
              backgroundColor: 'transparent',
              borderColor: 'transparent',
              borderSize: 0,
              paddingLeft: 0,
              paddingRight: 0,
              paddingTop: 0,
              paddingBottom: 0,
              size: 12,
              weight: 'bold',
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }
          },
          // 8. Badge Text Line 3: Bars, Duration, Volume
          {
            type: 'text',
            attrs: {
              x: badgeX + badgeW / 2,
              y: badgeY + 54,
              text: line3,
              align: 'center'
            },
            styles: {
              color: 'rgba(255, 255, 255, 0.90)',
              backgroundColor: 'transparent',
              borderColor: 'transparent',
              borderSize: 0,
              paddingLeft: 0,
              paddingRight: 0,
              paddingTop: 0,
              paddingBottom: 0,
              size: 10.5,
              weight: '500',
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }
          }
        ];
      }
      return [];
    }
  });
}

export function initTradingViewChart(containerId = 'klineChart') {
  registerCustomOverlays();

  const chart = klinecharts.init(containerId);
  if (!chart) {
    console.error('[TV Engine] Failed to initialize chart on', containerId);
    return null;
  }

  // Patch removeOverlay to safely normalize string ID or object with id
  // KLineCharts chart.removeOverlay expects an OverlayFilter object ({ id }).
  // If a string ID is passed directly, KLineCharts evaluates filter.id as undefined,
  // which matches and deletes EVERY overlay on the entire chart!
  const rawRemoveOverlay = chart.removeOverlay.bind(chart);
  chart.removeOverlay = function (target) {
    if (typeof target === 'string' || typeof target === 'number') {
      return rawRemoveOverlay({ id: String(target) });
    }
    if (target && typeof target === 'object' && target.id !== undefined) {
      return rawRemoveOverlay({ ...target, id: String(target.id) });
    }
    return rawRemoveOverlay(target || {});
  };

  // Fix KLineCharts future time extrapolation for drawings & right-margin space
  // Ensures lines dragged past latest candle into empty space never hit a wall
  if (chart._chartStore) {
    const cs = chart._chartStore;

    const origDataIndexToTimestamp = cs.dataIndexToTimestamp.bind(cs);
    cs.dataIndexToTimestamp = function (dataIndex) {
      const res = origDataIndexToTimestamp(dataIndex);
      if (typeof res === 'number' && !isNaN(res)) return res;

      const list = cs.getDataList() || [];
      if (list.length > 0 && typeof dataIndex === 'number') {
        const lastIdx = list.length - 1;
        const lastBar = list[lastIdx];
        const firstBar = list[0];
        const tfMins = window.__currentTimeframeMinutes || 5;
        const barMs = tfMins * 60 * 1000;
        if (dataIndex > lastIdx) {
          return lastBar.timestamp + Math.round((dataIndex - lastIdx) * barMs);
        } else if (dataIndex < 0 && firstBar) {
          return firstBar.timestamp + Math.round(dataIndex * barMs);
        }
      }
      return res;
    };

    const origTimestampToDataIndex = cs.timestampToDataIndex.bind(cs);
    cs.timestampToDataIndex = function (timestamp) {
      const list = cs.getDataList() || [];
      if (list.length > 0 && typeof timestamp === 'number') {
        const lastIdx = list.length - 1;
        const lastBar = list[lastIdx];
        const firstBar = list[0];
        const tfMins = window.__currentTimeframeMinutes || 5;
        const barMs = tfMins * 60 * 1000;
        if (timestamp > lastBar.timestamp) {
          return lastIdx + Math.round((timestamp - lastBar.timestamp) / barMs);
        } else if (firstBar && timestamp < firstBar.timestamp) {
          return Math.round((timestamp - firstBar.timestamp) / barMs);
        }
      }
      return origTimestampToDataIndex(timestamp);
    };

    const origFloatIndexToTimestamp = cs.floatIndexToTimestamp.bind(cs);
    cs.floatIndexToTimestamp = function (floatIndex) {
      const res = origFloatIndexToTimestamp(floatIndex);
      if (typeof res === 'number' && !isNaN(res)) return res;

      const list = cs.getDataList() || [];
      if (list.length > 0 && typeof floatIndex === 'number') {
        const lastIdx = list.length - 1;
        const lastBar = list[lastIdx];
        const firstBar = list[0];
        const tfMins = window.__currentTimeframeMinutes || 5;
        const barMs = tfMins * 60 * 1000;
        if (floatIndex > lastIdx) {
          return Math.round(lastBar.timestamp + (floatIndex - lastIdx) * barMs);
        } else if (floatIndex < 0 && firstBar) {
          return Math.round(firstBar.timestamp + floatIndex * barMs);
        }
      }
      return res;
    };

    const origTimestampToFloatIndex = cs.timestampToFloatIndex.bind(cs);
    cs.timestampToFloatIndex = function (timestamp) {
      const list = cs.getDataList() || [];
      if (list.length > 0 && typeof timestamp === 'number') {
        const lastIdx = list.length - 1;
        const lastBar = list[lastIdx];
        const firstBar = list[0];
        const tfMins = window.__currentTimeframeMinutes || 5;
        const barMs = tfMins * 60 * 1000;
        if (timestamp > lastBar.timestamp) {
          return lastIdx + (timestamp - lastBar.timestamp) / barMs;
        } else if (firstBar && timestamp < firstBar.timestamp) {
          return (timestamp - firstBar.timestamp) / barMs;
        }
      }
      return origTimestampToFloatIndex(timestamp);
    };
  }

  chartInstance = chart;
  if (typeof window !== 'undefined') {
    window.__chartInstance = chart;
  }

  // Exact TradingView Dark Slate Theme Matching Image 2 (#1c1c1c)
  chart.setStyles({
    grid: {
      show: true,
      horizontal: { show: true, size: 1, color: '#262626', style: 'dashed', dashedValue: [2, 2] },
      vertical: { show: true, size: 1, color: '#262626', style: 'dashed', dashedValue: [2, 2] }
    },
    candle: {
      type: 'candle_solid',
      bar: {
        upColor: '#d1d4dc',         // Bull silver
        downColor: '#e0457b',       // Bear rose/pink matching image 1 & 2
        noChangeColor: '#787b86',
        upBorderColor: '#e0e3eb',   // Crisp HD edge
        downBorderColor: '#e0457b', // Crisp HD edge
        noChangeBorderColor: '#787b86',
        upWickColor: '#d1d4dc',
        downWickColor: '#e0457b',
        noChangeWickColor: '#787b86'
      },
      priceMark: {
        show: true,
        high: { show: false },
        low: { show: false },
        last: {
          show: true,
          upColor: '#ffffff',
          downColor: '#ffffff',
          noChangeColor: '#ffffff',
          line: { show: true, style: 'dashed', dashedValue: [3, 3], size: 1, color: 'rgba(255, 255, 255, 0.65)' },
          text: {
            show: true,
            color: '#000000',
            size: 11,
            weight: 'bold',
            paddingLeft: 5,
            paddingRight: 5,
            paddingTop: 2,
            paddingBottom: 2,
            borderRadius: 2
          }
        }
      },
      tooltip: {
        showRule: 'none',           // Hide Time, Open, High, Low, Close, Volume box completely
        showType: 'standard'
      }
    },
    xAxis: {
      show: true,
      size: 'auto',
      axisLine: { show: true, color: '#262626', size: 1 },
      tickLine: { show: true, size: 1, length: 3, color: '#262626' },
      tickText: { show: true, color: '#787b86', size: 11, family: 'sans-serif' }
    },
    yAxis: {
      show: true,
      size: 'auto',
      position: 'right',
      type: 'normal',
      inside: false,
      axisLine: { show: true, color: '#262626', size: 1 },
      tickLine: { show: true, size: 1, length: 3, color: '#262626' },
      tickText: { show: true, color: '#787b86', size: 11, family: 'sans-serif' }
    },
    crosshair: {
      show: true,
      horizontal: {
        show: true,
        line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: '#555555' },
        text: { show: true, color: '#ffffff', size: 11, backgroundColor: '#2a2a2a', borderColor: '#333333' }
      },
      vertical: {
        show: true,
        line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: '#555555' },
        text: { show: true, color: '#ffffff', size: 11, backgroundColor: '#2a2a2a', borderColor: '#333333' }
      }
    },
    separator: {
      size: 1,
      color: '#262626',
      fill: true
    },
    overlay: {
      point: {
        color: '#94a3b8',
        borderColor: '#94a3b8',
        borderSize: 1,
        activeColor: '#cbd5e1',
        activeBorderColor: '#cbd5e1',
        radius: 4.5
      },
      line: {
        style: 'solid',
        color: '#94a3b8',
        size: 1.5
      },
      rect: {
        style: 'stroke_fill',
        color: 'rgba(236, 64, 122, 0.12)',
        borderColor: '#ec407a',
        borderSize: 1.5
      },
      polygon: {
        style: 'stroke_fill',
        color: 'rgba(236, 64, 122, 0.12)',
        borderColor: '#ec407a',
        borderSize: 1.5
      },
      text: {
        style: 'fill',
        color: '#ffffff',
        size: 11,
        family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        borderStyle: 'none',
        borderSize: 0,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0
      }
    }
  });

  // TradingView Standard Candle Spacing & Right Margin (HD crisp rendering)
  chart.setBarSpace(6.0);
  chart.setOffsetRightDistance(120);

  // Set internal timezone to UTC so candle timestamps are processed linearly
  try {
    chart.setTimezone('UTC');
  } catch (err) {
    console.warn('[TV Engine] setTimezone UTC failed:', err);
  }

  // IST Time Conversion Math:
  // Candle timestamps from broker are EEST (UTC+3). Net adjustment to IST (UTC+5:30) is rawTs + 2.5 hours (+9,000,000 ms).
  const BROKER_OFFSET_MS = 3 * 3600 * 1000;
  const IST_OFFSET_MS = 5.5 * 3600 * 1000;
  const RAW_TO_IST_MS = IST_OFFSET_MS - BROKER_OFFSET_MS; // +2.5 hours

  // Ensure bottom time ruler (xAxis) and crosshair display exact IST time with clean single-letter a/p format (e.g. 11:30p, 2:30p, 9:15a)
  try {
    chart.setFormatter({
      formatDate: ({ timestamp, template, type }) => {
        if (!timestamp) return '';
        const istDate = new Date(timestamp + RAW_TO_IST_MS);
        const YYYY = istDate.getUTCFullYear();
        const MM = (istDate.getUTCMonth() + 1).toString().padStart(2, '0');
        const DD = istDate.getUTCDate().toString().padStart(2, '0');
        let h = istDate.getUTCHours();
        const mm = istDate.getUTCMinutes().toString().padStart(2, '0');
        const ss = istDate.getUTCSeconds().toString().padStart(2, '0');
        const ap = h >= 12 ? 'p' : 'a';
        let h12 = h % 12;
        if (h12 === 0) h12 = 12;
        const HH = h.toString().padStart(2, '0');

        const timeWithAp = `${h12}:${mm}${ap}`;
        const timeWithApSec = `${h12}:${mm}:${ss}${ap}`;

        const templ = template || 'HH:mm';
        if (templ === 'HH:mm') {
          return timeWithAp;
        }
        if (templ === 'HH:mm:ss') {
          return timeWithApSec;
        }
        if (templ === 'YYYY-MM-DD HH:mm') {
          return `${YYYY}-${MM}-${DD} ${timeWithAp}`;
        }
        if (templ === 'MM-DD HH:mm') {
          return `${MM}-${DD} ${timeWithAp}`;
        }
        if (templ === 'YYYY-MM-DD') {
          return `${YYYY}-${MM}-${DD}`;
        }
        return templ
          .replace('HH:mm:ss', timeWithApSec)
          .replace('HH:mm', timeWithAp)
          .replace('YYYY', YYYY)
          .replace('MM', MM)
          .replace('DD', DD)
          .replace('HH', HH)
          .replace('mm', mm)
          .replace('ss', ss);
      }
    });
  } catch (err) {
    console.warn('[TV Engine] Custom IST formatter failed:', err);
  }

  // Ensure any session timeline overlay is cleanly removed
  try {
    chart.removeOverlay({ id: 'sys_session_timeline' });
  } catch (_e) {}

  // Register and initialize Living Footprint indicator directly on candle pane (single unified chart)
  try {
    registerLivingFootprintIndicator();
    try {
      chart.removeIndicator({ name: 'LivingFootprint' });
    } catch (_e) {}
    chart.createIndicator({ name: 'LivingFootprint', paneId: 'candle_pane' }, true);
  } catch (err) {
    console.warn('[TV Engine] LivingFootprint indicator init failed:', err);
  }

  // Patch Overlay Views to guarantee that all resize handles ('circle') are prioritized above polygon bodies
  try {
    patchOverlayViews(chart);
    updateExtensionSeriesRibbon(chart);
  } catch (err) {
    console.warn('[TV Engine] patchOverlayViews / ribbon init failed:', err);
  }

  return chart;
}

export function patchOverlayViews(chartRef) {
  if (!chartRef || typeof chartRef.getDrawPanes !== 'function') return;
  const panes = chartRef.getDrawPanes() || [];
  panes.forEach(pane => {
    const widget = typeof pane.getMainWidget === 'function' ? pane.getMainWidget() : null;
    const ovView = widget?._overlayView;
    if (ovView && !ovView.__enhancedHandles) {
      ovView.__enhancedHandles = true;

      const origDrawOverlay = ovView._drawOverlay.bind(ovView);
      ovView._drawOverlay = function (ctx, overlay) {
        this.__currentDrawingOverlay = overlay;
        origDrawOverlay(ctx, overlay);
        this.__currentDrawingOverlay = null;
      };

      const origCreateFigure = ovView.createFigure.bind(ovView);
      ovView.createFigure = function (figureParam, events) {
        const fig = origCreateFigure(figureParam, events);
        if (fig && this.__currentDrawingOverlay) {
          fig._overlay = this.__currentDrawingOverlay;
          fig._overlayId = this.__currentDrawingOverlay.id;
          fig._overlayName = this.__currentDrawingOverlay.name;
        }
        return fig;
      };

      const origDrawImp = ovView.drawImp.bind(ovView);
      ovView.drawImp = function (ctx) {
        origDrawImp(ctx);

        // Prioritize resize handles: keep all point handle circles at the END of _children
        // so that hit-testing tests point handles BEFORE any polygon body!
        if (Array.isArray(this._children) && this._children.length > 1) {
          const bodies = [];
          const normalPoints = [];
          const activePoints = [];
          const selectedId = window.__selectedOverlay?.id;

          for (let i = 0; i < this._children.length; i++) {
            const child = this._children[i];
            if (child && child.name === 'circle') {
              if (selectedId && child._overlayId === selectedId) {
                activePoints.push(child);
              } else {
                normalPoints.push(child);
              }
            } else {
              bodies.push(child);
            }
          }
          this._children = bodies.concat(normalPoints).concat(activePoints);
        }
      };
    }
  });
}

export function updateExtensionSeriesRibbon(chart) {
  const ribbonEl = document.getElementById('tvExtensionSeriesRibbon');
  const trackEl = document.getElementById('tvExtensionTrack');
  if (!ribbonEl || !trackEl) return;

  const isGlobalRibbonHidden = Boolean(window.__hideExtensionRibbon);
  if (isGlobalRibbonHidden) {
    ribbonEl.style.display = 'none';
    return;
  }

  const c = chart || chartInstance;
  if (!c || typeof c.getOverlays !== 'function') {
    ribbonEl.style.display = 'none';
    return;
  }

  const all = c.getOverlays() || [];
  const rects = all.filter(o => o.name === 'rect' && o.points && o.points.length >= 2);
  if (rects.length === 0) {
    ribbonEl.style.display = 'none';
    if (typeof syncStructuralInflectionLines === 'function') {
      syncStructuralInflectionLines(c);
    }
    return;
  }

  const dataList = c.getDataList?.() || [];

  // Sort rects chronologically by t0
  const sortedRects = rects.map(r => {
    const validPts = (r.points || []).filter(p => p && typeof p.value === 'number');
    const times = validPts.map(p => p.timestamp).filter(t => typeof t === 'number' && t > 0);
    const t0 = times.length > 0 ? Math.min(...times) : 0;
    const metrics = computeRectangleVolumeMetrics(r, dataList, rects);
    return { overlay: r, t0, metrics };
  }).sort((a, b) => a.t0 - b.t0);

  // Compute dossier to derive empirical Delta, EVR Friction shift, Fuel, and Regime
  const dossier = computeNetworkDossier(rects, dataList);
  const isBear = dossier ? dossier.isBear : true;

  // Sleek cyber/terminal SVG symbols matching the modal theme (replaces cartoon emojis)
  const SVG_BULL = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block;vertical-align:-1px;margin-right:2px;"><path d="M12 2 L22 20 L12 15 L2 20 Z"/></svg>`;
  const SVG_BEAR = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block;vertical-align:-1px;margin-right:2px;"><path d="M12 22 L2 4 L12 9 L22 4 Z"/></svg>`;
  const SVG_BAL = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block;vertical-align:-1px;margin-right:2px;"><rect x="4" y="4" width="16" height="16" transform="rotate(45 12 12)"/></svg>`;

  const getBoxTagStyle = (m, isLast) => {
    if (!m || !m.yieldAnalysis || m.totalVol === 0) {
      const volNum = m ? ((m.totalVol || 0) / 1000).toFixed(1) : '0';
      return {
        color: '#94a3b8',
        bg: 'rgba(148, 163, 184, 0.12)',
        border: 'rgba(148, 163, 184, 0.30)',
        shadow: 'none',
        shortTag: m && m.totalVol === 0 ? 'SYNCING...' : `${SVG_BAL} ${volNum}K`,
        domLabel: m && m.totalVol === 0 ? 'Awaiting Candle History' : 'Balanced Auction (Equal Yield)',
        fullTooltip: m && m.totalVol === 0 ? 'Historical candle data for this box interval is loading...' : 'Balanced Auction (Equal Yield)'
      };
    }

    const y = m.yieldAnalysis;
    const domSide = y.domSide;
    const domRatio = y.domRatio;
    const isThinning = y.isThinning;
    const isTrap = y.isTrap;
    const trapType = y.trapType;
    const bullVolK = (y.bullVol / 1000).toFixed(1);
    const bearVolK = (y.bearVol / 1000).toFixed(1);
    const bYieldStr = y.bullYield.toFixed(2);
    const sYieldStr = y.bearYield.toFixed(2);
    const bullMoveStr = y.bullMovePts.toFixed(1);
    const bearMoveStr = y.bearMovePts.toFixed(1);

    const maxSideVol = Math.max(y.bullVol, y.bearVol);
    const maxSideVolK = (maxSideVol / 1000).toFixed(1);
    let shortTag = `${SVG_BAL} ${maxSideVolK}K`;
    let domLabel = 'Balanced Auction (Equal Yield)';
    let color = '#94a3b8';
    let bg = 'rgba(148, 163, 184, 0.12)';
    let border = 'rgba(148, 163, 184, 0.30)';
    let shadow = 'none';

    if (isTrap) {
      const trapSide = trapType === 'CEILING_TRAP' ? 'Ceiling Absorption (Bull Trap)' : 'Floor Absorption (Bear Trap)';
      const trapVolK = trapType === 'CEILING_TRAP' ? bullVolK : bearVolK;
      shortTag = `⚠️ ${trapVolK}K TRAP`;
      domLabel = `${trapSide} — Heavy Effort Absorbed at Barrier`;
      color = '#fb923c';
      bg = 'rgba(251, 146, 60, 0.18)';
      border = 'rgba(251, 146, 60, 0.60)';
      shadow = '0 0 10px rgba(251, 146, 60, 0.50)';
    } else if (y.isExhaustion) {
      const exhLabel = y.exhaustionType === 'NO_DEMAND' ? 'No Demand (Ceiling Exhaustion)' : 'No Supply (Floor Exhaustion)';
      const exhVolK = y.exhaustionType === 'NO_DEMAND' ? bullVolK : bearVolK;
      const exhIcon = y.exhaustionType === 'NO_DEMAND' ? SVG_BULL : SVG_BEAR;
      shortTag = `⚠️ ${exhIcon} ${exhVolK}K EXH`;
      domLabel = `${exhLabel} — Price at barrier with low conviction / no follow-through (Reversal Risk)`;
      color = '#fb923c';
      bg = 'rgba(251, 146, 60, 0.18)';
      border = 'rgba(251, 146, 60, 0.60)';
      shadow = isLast ? '0 0 10px rgba(251, 146, 60, 0.75)' : 'none';
    } else if (domSide === 'BEAR') {
      shortTag = isThinning ? `${SVG_BEAR} ${bearVolK}K ⚠️` : `${SVG_BEAR} ${bearVolK}K`;
      domLabel = isThinning
        ? `Bears Thinning Out (Effort High, Yield Collapsing)`
        : `Bears Dominating (${domRatio}x Efficiency Advantage)`;

      if (isThinning) {
        color = '#fb923c';
        bg = 'rgba(251, 146, 60, 0.18)';
        border = 'rgba(251, 146, 60, 0.60)';
        shadow = isLast ? '0 0 10px rgba(251, 146, 60, 0.75)' : '0 0 4px rgba(251, 146, 60, 0.30)';
      } else if (domRatio >= 2.5) {
        color = '#f43f5e';
        bg = 'rgba(244, 63, 94, 0.18)';
        border = 'rgba(244, 63, 94, 0.60)';
        shadow = isLast ? '0 0 10px rgba(244, 63, 94, 0.70)' : '0 0 4px rgba(244, 63, 94, 0.25)';
      } else if (domRatio >= 1.5) {
        color = '#ef4444';
        bg = 'rgba(239, 68, 68, 0.16)';
        border = 'rgba(239, 68, 68, 0.45)';
        shadow = isLast ? '0 0 8px rgba(239, 68, 68, 0.60)' : 'none';
      } else {
        color = '#fca5a5';
        bg = 'rgba(252, 165, 165, 0.12)';
        border = 'rgba(252, 165, 165, 0.35)';
        shadow = isLast ? '0 0 8px rgba(252, 165, 165, 0.55)' : 'none';
      }
    } else if (domSide === 'BULL') {
      shortTag = isThinning ? `${SVG_BULL} ${bullVolK}K ⚠️` : `${SVG_BULL} ${bullVolK}K`;
      domLabel = isThinning
        ? `Bulls Thinning Out (Effort High, Yield Collapsing)`
        : `Bulls Dominating (${domRatio}x Efficiency Advantage)`;

      if (isThinning) {
        color = '#fb923c';
        bg = 'rgba(251, 146, 60, 0.18)';
        border = 'rgba(251, 146, 60, 0.60)';
        shadow = isLast ? '0 0 10px rgba(251, 146, 60, 0.75)' : '0 0 4px rgba(251, 146, 60, 0.30)';
      } else if (domRatio >= 2.5) {
        color = '#00f5a0';
        bg = 'rgba(0, 245, 160, 0.18)';
        border = 'rgba(0, 245, 160, 0.60)';
        shadow = isLast ? '0 0 10px rgba(0, 245, 160, 0.70)' : '0 0 4px rgba(0, 245, 160, 0.25)';
      } else if (domRatio >= 1.5) {
        color = '#22c55e';
        bg = 'rgba(34, 197, 94, 0.16)';
        border = 'rgba(34, 197, 94, 0.45)';
        shadow = isLast ? '0 0 8px rgba(34, 197, 94, 0.60)' : 'none';
      } else {
        color = '#86efac';
        bg = 'rgba(134, 239, 172, 0.12)';
        border = 'rgba(134, 239, 172, 0.35)';
        shadow = isLast ? '0 0 8px rgba(134, 239, 172, 0.55)' : 'none';
      }
    }

    let eqFormula = '';
    if (domSide === 'BEAR') {
      eqFormula = `Bear Yield (${sYieldStr} pt/K) ÷ Bull Yield (${bYieldStr} pt/K) = ${domRatio}x Bear Advantage`;
    } else if (domSide === 'BULL') {
      eqFormula = `Bull Yield (${bYieldStr} pt/K) ÷ Bear Yield (${sYieldStr} pt/K) = ${domRatio}x Bull Advantage`;
    } else {
      eqFormula = `Bull Yield (${bYieldStr} pt/K) ≈ Bear Yield (${sYieldStr} pt/K) = 1.0x (Balanced Yield)`;
    }

    const fullTooltip = `${domLabel}
• Bull Effort: ${bullVolK}K vol → ${bullMoveStr}pt movement = ${bYieldStr} pt/K yield
• Bear Effort: ${bearVolK}K vol → ${bearMoveStr}pt movement = ${sYieldStr} pt/K yield
• Full Equation: ${eqFormula}${isThinning ? '\n⚠️ WARNING: Heavy volume consumed with collapsing yield — Power Thinning Out!' : ''}
(Click to inspect)`;

    return {
      color,
      bg,
      border,
      shadow,
      shortTag,
      domLabel,
      fullTooltip
    };
  };

  // Inter-box efficiency flip analysis (detect distribution churn / bracket rotation)
  let flipCount = 0;
  let prevWinner = null;
  const transitionWinners = [];
  for (let i = 0; i < sortedRects.length - 1; i++) {
    const currY = sortedRects[i].metrics?.yieldAnalysis;
    const nextY = sortedRects[i + 1].metrics?.yieldAnalysis;
    if (currY && nextY) {
      let win = 'NONE';
      const isBullExh = nextY.isExhaustion && nextY.exhaustionType === 'NO_DEMAND';
      const isBearExh = nextY.isExhaustion && nextY.exhaustionType === 'NO_SUPPLY';
      if (!isBullExh && nextY.bullYield > nextY.bearYield * 1.15 && (nextY.bullMovePts || 0) >= 3.0) {
        win = 'BULL';
      } else if (!isBearExh && nextY.bearYield > nextY.bullYield * 1.15 && (nextY.bearMovePts || 0) >= 3.0) {
        win = 'BEAR';
      }
      transitionWinners.push(win);
      if (prevWinner && win !== 'NONE' && win !== prevWinner) {
        flipCount++;
      }
      if (win !== 'NONE') prevWinner = win;
    }
  }
  const isBracketChop = (flipCount >= 2 && transitionWinners.length >= 3);

  // 1. Build Sequence Micro-Group (Dynamic Dominant Volume Number & Inter-Box Domination Rate Connector)
  let seqHtml = '<div class="tv-ext-seq-group" title="Dynamic Volume Yield Sequence (Click to inspect)">';
  sortedRects.forEach((item, idx) => {
    const m = item.metrics;
    const isLast = (idx === sortedRects.length - 1);
    const styleObj = getBoxTagStyle(m, isLast);
    const boxTagLabel = `B${idx + 1}: ${styleObj.shortTag}`;
    const boxTooltip = `Box ${idx + 1}: ${styleObj.fullTooltip}`;

    seqHtml += `
      <span class="tv-ext-box-tag" data-box-idx="${idx}" title="${boxTooltip}" style="color: ${styleObj.color}; background: ${styleObj.bg}; border: 1px solid ${styleObj.border}; ${styleObj.shadow !== 'none' ? 'box-shadow: ' + styleObj.shadow + ';' : ''}">
        ${boxTagLabel}
      </span>
    `;
    if (!isLast) {
      const nextM = sortedRects[idx + 1]?.metrics;
      const nextY = nextM?.yieldAnalysis;
      const currY = m?.yieldAnalysis;
      if (nextY && currY) {
        // Delta Effort between boxes for Bull and Bear (% change)
        const deltaBullEffort = Math.round(((nextY.bullVol - currY.bullVol) / Math.max(1, currY.bullVol)) * 100);
        const deltaBearEffort = Math.round(((nextY.bearVol - currY.bearVol) / Math.max(1, currY.bearVol)) * 100);
        const bullSign = deltaBullEffort >= 0 ? '+' : '';
        const bearSign = deltaBearEffort >= 0 ? '+' : '';

        const bullMovePts = (nextY.bullMovePts || 0).toFixed(1).replace(/\.0$/, '');
        const bearMovePts = (nextY.bearMovePts || 0).toFixed(1).replace(/\.0$/, '');

        const bullTopText = `${bullSign}${deltaBullEffort}% / ${bullMovePts}pt`;
        const bearBottomText = `${bearSign}${deltaBearEffort}% / ${bearMovePts}pt`;

        // Highlight in a boxed badge (Electric Cyan) whichever side took LESS effort to move BIG
        // Guard: If the move is an exhaustion push (No Demand / No Supply), do NOT award it as an efficiency winner!
        let bullHighlightCls = '';
        let bearHighlightCls = '';
        const isBullExh = nextY.isExhaustion && nextY.exhaustionType === 'NO_DEMAND';
        const isBearExh = nextY.isExhaustion && nextY.exhaustionType === 'NO_SUPPLY';

        if (!isBullExh && nextY.bullYield > nextY.bearYield * 1.15 && (nextY.bullMovePts || 0) >= 3.0) {
          bullHighlightCls = ' conn-highlight-efficient';
        } else if (!isBearExh && nextY.bearYield > nextY.bullYield * 1.15 && (nextY.bearMovePts || 0) >= 3.0) {
          bearHighlightCls = ' conn-highlight-efficient';
        }

        const connTooltip = `Inter-Box Effort vs Movement Shift (B${idx + 1} → B${idx + 2}):
• Bull Effort Delta: ${bullSign}${deltaBullEffort}% Vol → Upward Movement: ${bullMovePts}pt (${nextY.bullYield} pt/K)
• Bear Effort Delta: ${bearSign}${deltaBearEffort}% Vol → Downward Movement: ${bearMovePts}pt (${nextY.bearYield} pt/K)${bullHighlightCls ? '\n⚡ Bull took LESS effort to move BIG (Superior Yield)' : ''}${bearHighlightCls ? '\n⚡ Bear took LESS effort to move BIG (Superior Yield)' : ''}${isBullExh ? '\n⚠️ WARNING: Bull upward push is an Exhaustion / No Demand retest at ceiling!' : ''}${isBearExh ? '\n⚠️ WARNING: Bear downward push is an Exhaustion / No Supply retest at floor!' : ''}`;

        seqHtml += `
          <div class="tv-ext-connector" title="${connTooltip}">
            <span class="tv-ext-conn-bull${bullHighlightCls}">${bullTopText}</span>
            <span class="tv-ext-conn-arrow">→</span>
            <span class="tv-ext-conn-bear${bearHighlightCls}">${bearBottomText}</span>
          </div>
        `;
      } else {
        seqHtml += `<span class="tv-ext-arrow">→</span>`;
      }
    }
  });
  seqHtml += '</div>';

  // 2. Friction Shift Capsule (Traffic Light: Green = Vacuum, Yellow = Balanced, Red = Wall)
  const shiftVal = dossier ? dossier.deltaEvr : 0;
  const shiftSign = shiftVal >= 0 ? '+' : '';
  let frictionCls = 'friction-yellow';
  let frictionIcon = '⚖️';
  let frictionNote = 'BALANCED';

  if (isBracketChop) {
    frictionCls = 'friction-yellow';
    frictionIcon = '⚖️';
    frictionNote = `${flipCount}x ROTATION`;
  } else if (shiftVal <= -20) {
    frictionCls = 'friction-green';
    frictionIcon = '⚡';
    frictionNote = 'VACUUM';
  } else if (shiftVal >= 30) {
    frictionCls = 'friction-red';
    frictionIcon = '🔥';
    frictionNote = 'WALL';
  }

  const frictionHtml = `
    <div class="tv-ext-chip ${frictionCls}" title="${isBracketChop ? `⚠️ BRACKET ROTATION: Inter-box efficiency has flipped ${flipCount} times. Market is in two-sided distribution/bracket rotation, not a directional breakout!` : `Effort vs Result Friction Shift: ${shiftSign}${shiftVal}% (${frictionNote})`}">
      <span>${frictionIcon} ${isBracketChop ? `${flipCount}x ROTATION` : `${shiftSign}${shiftVal}% FRICTION`}</span>
    </div>
  `;

  // 3. Dominant Volume Number Pill (Replaces verbose label with high-contrast colored volume number)
  const startPrice = dossier?.firstSample?.P_0 || (sortedRects[0]?.metrics?.P_0 || 4000);
  const currentPrice = (dossier?.livePrice && dossier.livePrice > 100) ? dossier.livePrice : (sortedRects[sortedRects.length - 1]?.metrics?.P_1 || startPrice);
  const netDisplacement = currentPrice - startPrice;
  const dispSign = netDisplacement >= 0 ? '+' : '';
  const lastBoxMetrics = sortedRects.length > 0 ? sortedRects[sortedRects.length - 1]?.metrics : null;
  const lastYield = lastBoxMetrics?.yieldAnalysis;

  const netDeltaVal = dossier ? dossier.totalNetDelta : (lastBoxMetrics ? lastBoxMetrics.netDelta : 0);
  const deltaSignVal = netDeltaVal >= 0 ? '+' : '';
  const cvdDeltaFormatted = `${deltaSignVal}${formatVolNumber(netDeltaVal)}`;
  const cvdColor = netDeltaVal >= 0 ? '#22c55e' : '#ef4444';

  let dispCls = 'dominant-neutral';
  let dispIcon = SVG_BAL;
  let domVolK = lastBoxMetrics ? ((lastYield?.domSide === 'BEAR' ? lastYield.bearVol : (lastYield?.bullVol || lastBoxMetrics.totalVol)) / 1000).toFixed(1) + 'K' : '0K';

  // Format: "17.5K / -/+ cvd delta" with high-contrast colored CVD delta
  let dispText = `${domVolK} / <span style="color: ${cvdColor}; font-weight: 800;">${cvdDeltaFormatted} CVD Δ</span>`;
  let dispTitle = `Net Sequence Price Ground: ${dispSign}${netDisplacement.toFixed(1)} pts (from $${startPrice.toFixed(2)} to $${currentPrice.toFixed(2)}) • Cumulative Delta: ${cvdDeltaFormatted} Δ (Box Delta: ${lastBoxMetrics ? (lastBoxMetrics.netDelta >= 0 ? '+' : '') + formatVolNumber(lastBoxMetrics.netDelta) : '0'} Δ)`;

  if (lastYield) {
    if (lastYield.isTrap) {
      dispCls = 'dominant-thinning';
      dispIcon = '⚠️';
      const trapName = lastYield.trapType === 'CEILING_TRAP' ? 'CEILING TRAP' : 'FLOOR TRAP';
      dispTitle = `⚠️ ${trapName}: ${domVolK} volume absorbed at barrier with stalled progress • CVD: ${cvdDeltaFormatted} • Reversal Risk! • Net Ground: ${dispSign}${netDisplacement.toFixed(1)}pt`;
    } else if (lastYield.isExhaustion) {
      dispCls = 'dominant-thinning';
      dispIcon = '⚠️';
      const exhName = lastYield.exhaustionType === 'NO_DEMAND' ? 'NO DEMAND' : 'NO SUPPLY';
      dispTitle = `⚠️ ${exhName} AT BARRIER: Low-volume test at boundary without breakout (${domVolK} vol) • CVD: ${cvdDeltaFormatted} • High Reversal Risk! • Net Ground: ${dispSign}${netDisplacement.toFixed(1)}pt`;
    } else if (isBracketChop) {
      dispCls = 'dominant-thinning';
      dispIcon = '⚖️';
      dispTitle = `⚖️ BRACKET ROTATION: Multi-box distribution churn (${flipCount}x efficiency flips). Vol: ${domVolK} • CVD: ${cvdDeltaFormatted} • Neither side has directional runway! • Net Ground: ${dispSign}${netDisplacement.toFixed(1)}pt`;
    } else if (lastYield.isThinning) {
      dispCls = 'dominant-thinning';
      dispIcon = '⚠️';
      dispTitle = `${lastYield.domSide} THINNING OUT: ${domVolK} consumed with collapsing yield • CVD: ${cvdDeltaFormatted} • Net Ground: ${dispSign}${netDisplacement.toFixed(1)}pt`;
    } else if (lastYield.domSide === 'BEAR') {
      dispCls = 'dominant-bear';
      dispIcon = SVG_BEAR;
      dispTitle = `BEAR DOMINANT: ${domVolK} volume (${lastYield.domRatio}x yield advantage) • CVD: ${cvdDeltaFormatted} • Net Ground: ${dispSign}${netDisplacement.toFixed(1)}pt`;
    } else if (lastYield.domSide === 'BULL') {
      dispCls = 'dominant-bull';
      dispIcon = SVG_BULL;
      dispTitle = `BULL DOMINANT: ${domVolK} volume (${lastYield.domRatio}x yield advantage) • CVD: ${cvdDeltaFormatted} • Net Ground: ${dispSign}${netDisplacement.toFixed(1)}pt`;
    } else {
      dispCls = 'dominant-neutral';
      dispIcon = SVG_BAL;
      dispTitle = `BALANCED AUCTION: ${domVolK} volume • CVD: ${cvdDeltaFormatted} • Equal Yield • Net Ground: ${dispSign}${netDisplacement.toFixed(1)}pt`;
    }
  }

  const displacementHtml = `
    <div class="tv-ext-chip ${dispCls}" title="${dispTitle}">
      <span>${dispIcon} ${dispText}</span>
    </div>
  `;

  // 4. Box Show / Hide Toggle Capsule (📦 BOXES: ON / OFF) replaces fuel button
  const isBoxesDeactivated = Boolean(window.__hideBoxBodies);
  const boxToggleCls = isBoxesDeactivated ? 'box-toggle-off' : 'box-toggle-on';
  const boxToggleText = isBoxesDeactivated ? 'BOXES: OFF' : 'BOXES: ON';
  const boxToggleTitle = isBoxesDeactivated
    ? 'Boxes deactivated — Click to activate boxes & excursion vectors'
    : 'Boxes active — Click to deactivate boxes & excursion vectors';
  const boxToggleHtml = `
    <div id="tvBoxToggleChip" class="tv-ext-chip ${boxToggleCls}" title="${boxToggleTitle}">
      <span>📦 ${boxToggleText}</span>
    </div>
  `;

  // Assemble all capsules in track (zero dossier button, zero bull/bear text, zero runway, zero poc)
  trackEl.innerHTML = `${seqHtml}${frictionHtml}${displacementHtml}${boxToggleHtml}`;
  ribbonEl.style.display = 'flex';

  // Dedicated click handler on the toggle button with full propagation arrest
  const boxToggleChip = document.getElementById('tvBoxToggleChip');
  if (boxToggleChip) {
    boxToggleChip.onclick = function(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') {
          e.stopImmediatePropagation();
        }
      }
      toggleBoxVisibility(c);
    };
  }

  // Clicking on the ribbon or ANY item inside it opens the modal, EXCEPT the box toggle chip!
  ribbonEl.onclick = function(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (e?.target?.closest?.('#tvBoxToggleChip')) {
      return;
    }
    const targetTag = e?.target?.closest?.('.tv-ext-box-tag');
    if (targetTag && targetTag.hasAttribute('data-box-idx')) {
      const bIdx = targetTag.getAttribute('data-box-idx');
      openExtensionNetworkModal(c);
      if (typeof window.__selectNexusTab === 'function') {
        window.__selectNexusTab(`box_${bIdx}`);
      }
    } else {
      openExtensionNetworkModal(c);
    }
  };

  if (typeof syncStructuralInflectionLines === 'function') {
    syncStructuralInflectionLines(c);
  }
}
window.__updateExtensionSeriesRibbon = updateExtensionSeriesRibbon;

/**
 * Toggles visibility of all box bodies and outlines while strictly preserving
 * all line markings (in-box excursion arrows/fins/numbers, red ✕ anchors,
 * trend lines, rays, horizontal lines, and structural inflection lines).
 */
export function toggleBoxVisibility(chart = chartInstance) {
  const c = chart || chartInstance;
  window.__hideBoxBodies = !Boolean(window.__hideBoxBodies);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('escanor_hide_box_bodies', window.__hideBoxBodies ? 'true' : 'false');
    }
  } catch (_) {}

  if (c && typeof c.getOverlays === 'function') {
    const all = c.getOverlays() || [];
    all.filter(o => o.name === 'rect').forEach(r => {
      try {
        c.overrideOverlay({ id: r.id });
      } catch (err) {}
    });
  }

  updateExtensionSeriesRibbon(c);
  const stateStr = window.__hideBoxBodies ? 'Deactivated' : 'Active';
  if (typeof showChartToast === 'function') {
    showChartToast(`Boxes & In-Box Vectors: ${stateStr}`, 2500);
  }
}
window.__toggleBoxVisibility = toggleBoxVisibility;

/**
 * Computes deep multi-sample empirical network dossier across all connected rectangles.
 * Audits:
 * 1. Who is playing out (Aggressor vs. Passive Absorption, Cumulative Delta divergence)
 * 2. Effort vs. Result (Fuel Burn Engine: EVR = V / R, friction shift)
 * 3. Strongest Structural Inflection Nodes (Anchors, Peak Volume Shelves, Mid-Structure Eq)
 * 4. Structural Runway & Liquidity Vacuum (Distance to historical ceilings/floors, Invalidation Tripwires)
 */
export function computeNetworkDossier(customRects = null, customDataList = null, customChart = null) {
  const c = customChart || chartInstance || (typeof window !== 'undefined' && (window.__chartInstance || window.__chart)) || null;
  const allOverlays = customRects || (c?.getOverlays?.() || []).filter(o => o.name === 'rect' && o.points && o.points.length >= 2);
  const dataList = customDataList || (c?.getDataList?.() || []);

  if (!allOverlays || allOverlays.length === 0) {
    return null;
  }

  // Sort boxes chronologically by start timestamp t0
  const samples = allOverlays.map(r => {
    const validPts = (r.points || []).filter(p => p && typeof p.value === 'number');
    const times = validPts.map(p => p.timestamp).filter(t => typeof t === 'number' && t > 0);
    const t0 = times.length > 0 ? Math.min(...times) : 0;
    const m = computeRectangleVolumeMetrics(r, dataList, allOverlays);
    return { overlay: r, t0, metrics: m };
  }).filter(s => s.metrics).sort((a, b) => a.t0 - b.t0);

  if (samples.length === 0) {
    return null;
  }

  const N = samples.length;
  let totalNetDelta = 0;
  let totalVolume = 0;
  let totalBullVol = 0;
  let totalBearVol = 0;
  let maxHigh = -Infinity;
  let minLow = Infinity;
  let highestEvrSample = null;
  let highestEvrVal = -1;
  let highestVolSample = null;
  let highestVolVal = -1;

  const sampleAudits = samples.map((s, idx) => {
    const m = s.metrics;
    totalNetDelta += m.netDelta;
    totalVolume += m.totalVol;
    const bullV = (typeof m.bullVol === 'number') ? m.bullVol : m.totalVol * ((m.bullPct || 50) / 100);
    const bearV = (typeof m.bearVol === 'number') ? m.bearVol : m.totalVol * ((m.bearPct || 50) / 100);
    totalBullVol += bullV;
    totalBearVol += bearV;

    if (m.H_b > maxHigh) maxHigh = m.H_b;
    if (m.L_b < minLow) minLow = m.L_b;

    // Effort vs Result (EVR): Volume per 1.0 point of price range
    const evr = Math.round(m.totalVol / Math.max(0.1, m.R_b));
    let frictionTag = 'CLEAN FLOW ⚡';
    let frictionCls = 'bull';
    if (evr >= 2400) {
      frictionTag = 'EXTREME BURN 🔥';
      frictionCls = 'bear';
    } else if (evr >= 1200) {
      frictionTag = 'HIGH FRICTION ⚠️';
      frictionCls = 'warn';
    }

    if (evr > highestEvrVal) {
      highestEvrVal = evr;
      highestEvrSample = { idx: idx + 1, metrics: m, evr };
    }
    if (m.totalVol > highestVolVal) {
      highestVolVal = m.totalVol;
      highestVolSample = { idx: idx + 1, metrics: m, vol: m.totalVol };
    }

    return {
      boxNum: idx + 1,
      direction: m.d === 1 ? 'UP' : 'DOWN',
      d: m.d,
      favMove: m.favMove,
      advMove: m.advMove,
      netMove: m.netMove,
      H_b: m.H_b,
      L_b: m.L_b,
      R_b: m.R_b,
      P_0: m.P_0,
      P_1: m.P_1,
      totalVol: m.totalVol,
      netDelta: m.netDelta,
      netDeltaPct: m.netDeltaPct,
      bullPct: m.bullPct || 50,
      bearPct: m.bearPct || 50,
      absorbPct: m.absorbPct,
      absorbLevel: m.absorbLevel,
      evr,
      frictionTag,
      frictionCls,
      metrics: m,
      overlay: s.overlay
    };
  });

  const firstSample = sampleAudits[0];
  const lastSample = sampleAudits[N - 1];

  // Effort vs Result Shift across sequence
  const deltaEvr = Math.round(((lastSample.evr - firstSample.evr) / Math.max(1, firstSample.evr)) * 100);
  let evrStatusBadge = 'BALANCED FLOW';
  if (deltaEvr > 40) {
    evrStatusBadge = 'FRICTION SPIKE 🔥';
  } else if (deltaEvr < -30) {
    evrStatusBadge = 'VACUUM ACCELERATION ⚡';
  } else {
    evrStatusBadge = 'SUSTAINED FLOW ⚖️';
  }

  // Who is actually playing out
  const lastSampleTimes = (lastSample.overlay?.points || []).map(p => p.timestamp).filter(t => typeof t === 'number' && t > 0);
  const maxSampleTime = lastSampleTimes.length > 0 ? Math.max(...lastSampleTimes) : 0;
  const lastBar = dataList.length > 0 ? dataList[dataList.length - 1] : null;
  const isConcurrent = Boolean(lastBar && maxSampleTime > 0 && Math.abs(lastBar.timestamp - maxSampleTime) <= (120 * 60 * 1000));
  const livePrice = (isConcurrent && typeof lastBar.close === 'number')
    ? lastBar.close
    : (typeof lastSample.P_1 === 'number' ? lastSample.P_1 : (lastBar?.close || 4000));

  const netDeltaPct = totalVolume > 0 ? Math.round((totalNetDelta / totalVolume) * 100) : 0;
  const netBullPct = totalVolume > 0 ? Math.max(5, Math.min(95, Math.round((totalBullVol / totalVolume) * 100))) : 50;
  const netBearPct = 100 - netBullPct;

  let whoBadge = 'PASSIVE ABSORPTION';
  const networkRange = Math.max(0.1, maxHigh - minLow);
  const nearCeiling = (livePrice >= maxHigh - 0.25 * networkRange);
  const nearFloor = (livePrice <= minLow + 0.25 * networkRange);

  if (nearCeiling && (lastSample.absorbPct >= 60 || totalNetDelta < 0 || lastSample.netDeltaPct < -5)) {
    whoBadge = 'PASSIVE CEILING DEFENSE (LIMIT SELLER)';
  } else if (nearFloor && (lastSample.absorbPct >= 60 || totalNetDelta > 0 || lastSample.netDeltaPct > 5)) {
    whoBadge = 'PASSIVE FLOOR DEFENSE (LIMIT BUYER)';
  } else if (lastSample.d === 1 && totalNetDelta > 0) {
    whoBadge = 'AGGRESSIVE BUYER INITIATIVE';
  } else if (lastSample.d === -1 && totalNetDelta < 0) {
    whoBadge = 'AGGRESSIVE SELLER INITIATIVE';
  } else {
    whoBadge = 'ROTATIONAL INVENTORY EXCHANGE';
  }

  // Strongest Structural Inflection Nodes: True Volume Point of Control (POC)
  const netBinCount = 50;
  const netBinStep = Math.max(0.1, networkRange / netBinCount);
  const netBins = new Float64Array(netBinCount);
  let netWeightedPrice = 0;
  let netTotalVolCount = 0;
  const seenBarTimes = new Set();

  samples.forEach(s => {
    const m = s.metrics;
    if (m && Array.isArray(m.barsInBox)) {
      m.barsInBox.forEach(item => {
        const b = item.bar;
        if (!b || seenBarTimes.has(b.timestamp)) return;
        seenBarTimes.add(b.timestamp);

        const vol = (item.volInBox !== undefined) ? item.volInBox : Number(b.volume || b.tick_volume || 1);
        if (vol <= 0) return;

        const effLow = (item.effectiveLow !== undefined) ? item.effectiveLow : Math.max(b.low, minLow);
        const effHigh = (item.effectiveHigh !== undefined) ? item.effectiveHigh : Math.min(b.high, maxHigh);
        const typPrice = (item.effectiveTypPrice !== undefined)
          ? item.effectiveTypPrice
          : (effHigh + effLow + Math.max(effLow, Math.min(effHigh, b.close))) / 3;

        netWeightedPrice += typPrice * vol;
        netTotalVolCount += vol;

        const lowBin = Math.max(0, Math.min(netBinCount - 1, Math.floor((effLow - minLow) / netBinStep)));
        const highBin = Math.max(0, Math.min(netBinCount - 1, Math.floor((effHigh - minLow) / netBinStep)));
        const span = Math.max(1, highBin - lowBin + 1);
        const volPerBin = vol / span;
        for (let bi = lowBin; bi <= highBin; bi++) {
          netBins[bi] += volPerBin;
        }
      });
    }
  });

  let peakNetBinIdx = 0;
  let peakNetBinVol = -1;
  for (let bi = 0; bi < netBinCount; bi++) {
    if (netBins[bi] > peakNetBinVol) {
      peakNetBinVol = netBins[bi];
      peakNetBinIdx = bi;
    }
  }

  // True Point of Control (POC) of the multi-box network
  const networkPoc = (peakNetBinVol > 0)
    ? (minLow + (peakNetBinIdx + 0.5) * netBinStep)
    : (highestVolSample && highestVolSample.metrics.pocPrice ? highestVolSample.metrics.pocPrice : (maxHigh + minLow) / 2);

  // Reliable network VWAP calculation: compute from detailed bars or sample weighted averages
  let networkVwap = 0;
  if (netTotalVolCount > 0) {
    networkVwap = netWeightedPrice / netTotalVolCount;
  } else if (totalVolume > 0) {
    const sumVwap = sampleAudits.reduce((acc, s) => {
      const p = s.metrics.vwap || s.metrics.pocPrice || ((s.H_b + s.L_b) / 2);
      return acc + (p * s.totalVol);
    }, 0);
    networkVwap = sumVwap / totalVolume;
  } else {
    networkVwap = (maxHigh + minLow) / 2;
  }

  // The Peak Volume Anchor is the empirical Volume POC shelf
  const primaryAnchor = networkPoc;
  const eqShelf = (maxHigh + minLow) / 2;

  // Multi-factor directional evaluation for the whole network
  const startPrice = firstSample.P_0;
  const endPrice = livePrice;
  const netDisplacement = endPrice - startPrice;
  const lastYield = lastSample.metrics?.yieldAnalysis;
  const lastDomSide = lastYield?.domSide;

  let bullScore = 0;
  let bearScore = 0;

  // 1. Net price ground displaced across the network
  if (netDisplacement >= 1.5) bullScore += 2;
  else if (netDisplacement <= -1.5) bearScore += 2;

  // 2. Cumulative volume delta across the network
  if (totalNetDelta > 1000) bullScore += 1.5;
  else if (totalNetDelta < -1000) bearScore += 1.5;

  // 3. Volume effort share (Bull Vol vs Bear Vol)
  if (totalBullVol > totalBearVol * 1.08) bullScore += 1;
  else if (totalBearVol > totalBullVol * 1.08) bearScore += 1;

  // 4. Terminal Box Dominance & Direction
  if (lastSample.d === 1) bullScore += 1;
  else if (lastSample.d === -1) bearScore += 1;

  if (lastDomSide === 'BULL') bullScore += 1.5;
  else if (lastDomSide === 'BEAR') bearScore += 1.5;

  // 5. Breakout vs Breakdown beyond boundary
  if (livePrice > maxHigh) bullScore += 3;
  if (livePrice < minLow) bearScore += 3;

  const isBear = (bearScore > bullScore);
  const isBull = (bullScore > bearScore);

  let runwayGapPts = 0;
  let runwayGapText = '';
  let runwayHeaderColor = '#00f5d4';

  if (isBear) {
    runwayHeaderColor = '#f43f5e';
    if (livePrice < minLow) {
      // Breakdown past floor into open runway
      runwayGapPts = -(minLow - livePrice);
      runwayGapText = `${runwayGapPts.toFixed(1)} PTS BEAR RUNWAY`;
    } else {
      // In-range drop towards floor
      runwayGapPts = -(livePrice - minLow);
      runwayGapText = `${runwayGapPts.toFixed(1)} PTS BEAR BREAK`;
    }
  } else {
    runwayHeaderColor = '#00f5d4';
    if (livePrice > maxHigh) {
      // Breakout past ceiling into open runway
      runwayGapPts = +(livePrice - maxHigh);
      runwayGapText = `+${runwayGapPts.toFixed(1)} PTS OPEN BULL RUNWAY`;
    } else {
      // In-range climb towards ceiling
      runwayGapPts = +(maxHigh - livePrice);
      runwayGapText = `+${runwayGapPts.toFixed(1)} PTS BULL RUNWAY`;
    }
  }

  const invalidationTripwire = isBear ? maxHigh : minLow;
  const invalidationSign = isBear ? '>' : '<';
  const invalidationText = `${invalidationSign} $${invalidationTripwire.toFixed(2)} (${isBear ? 'BEAR INVAL' : 'BULL INVAL'})`;

  // Runway & Vacuum
  const distCeiling = Math.max(0, maxHigh - livePrice);
  const distFloor = Math.max(0, livePrice - minLow);
  const distEq = Math.abs(livePrice - eqShelf);
  const distAnchor = Math.abs(livePrice - primaryAnchor);

  const pricePinPct = Math.max(2, Math.min(98, Math.round(((livePrice - minLow) / networkRange) * 100)));
  const upperRunwayPct = Math.max(5, Math.min(95, Math.round((distCeiling / networkRange) * 100)));
  const lowerRunwayPct = Math.max(5, Math.min(95, Math.round((distFloor / networkRange) * 100)));
  const maxEvr = Math.max(3000, ...sampleAudits.map(s => s.evr));
  const maxFav = Math.max(1, ...sampleAudits.map(s => s.favMove));

  return {
    symbol: window.__currentSymbol || 'XAUUSD',
    sampleCount: N,
    samples: sampleAudits,
    totalVolume,
    totalNetDelta,
    netDeltaPct,
    netBullPct,
    netBearPct,
    maxHigh,
    minLow,
    networkRange,
    livePrice,
    firstSample,
    lastSample,
    deltaEvr,
    evrStatusBadge,
    whoBadge,
    primaryAnchor,
    networkPoc,
    networkVwap,
    highestVolSample,
    highestEvrSample,
    eqShelf,
    isBear,
    isBull,
    netDisplacement,
    runwayGapPts,
    runwayGapText,
    runwayHeaderColor,
    invalidationTripwire,
    invalidationText,
    distCeiling,
    distFloor,
    distEq,
    distAnchor,
    pricePinPct,
    upperRunwayPct,
    lowerRunwayPct,
    maxEvr,
    maxFav
  };
}
window.__computeNetworkDossier = computeNetworkDossier;

export function openExtensionNetworkModal(chart = null) {
  const modal = document.getElementById('tvExtensionNetworkModal');
  if (!modal) return;

  const c = chart || chartInstance || (typeof window !== 'undefined' && (window.__chartInstance || window.__chart)) || null;
  const allOverlays = (c?.getOverlays?.() || []).filter(o => o.name === 'rect' && o.points && o.points.length >= 2);
  const dataList = c?.getDataList?.() || [];
  const dossier = computeNetworkDossier(allOverlays.length > 0 ? allOverlays : null, dataList, c);
  const symbol = dossier?.symbol || window.__currentSymbol || 'XAUUSD';

  const subtitleEl = document.getElementById('tvNetworkModalSubtitle');
  if (subtitleEl) {
    subtitleEl.textContent = `${symbol} M5 • VOLUME POC NETWORK // SYNC: 100%`;
  }

  // Handle empty state if no sample boxes exist
  if (!dossier || dossier.sampleCount === 0) {
    const tabTrack = document.getElementById('tvNexusTabTrack');
    if (tabTrack) {
      tabTrack.innerHTML = '<span style="color: #94a3b8; font-size: 11px;">Draw 1+ sample boxes (Key "R") to audit</span>';
    }
    const pill = document.getElementById('tvNexusStatusPill');
    if (pill) {
      pill.textContent = 'NO SAMPLES';
      pill.style.background = '#1e293b';
      pill.style.color = '#94a3b8';
    }
    modal.style.display = 'flex';
    return;
  }

  // Store active dossier and chart reference on window
  window.__activeNetworkDossier = dossier;
  window.__activeChartForDossier = c;

  // Build dynamic sample tab buttons
  const tabTrack = document.getElementById('tvNexusTabTrack');
  if (tabTrack) {
    let tabsHtml = `
      <button type="button" class="tv-nexus-tab-btn active" data-tab-key="network" onclick="window.__selectNexusTab('network')">
        ⚡ ALL NETWORK
      </button>
    `;
    dossier.samples.forEach((s, idx) => {
      tabsHtml += `
        <button type="button" class="tv-nexus-tab-btn" data-tab-key="box_${idx}" onclick="window.__selectNexusTab('box_${idx}')">
          📦 BOX #${s.boxNum}
        </button>
      `;
    });
    if (dossier.distCeiling <= 1.0) {
      tabsHtml += `
        <button type="button" class="tv-nexus-tab-btn" data-tab-key="ceiling" onclick="window.__selectNexusTab('ceiling')">
          🧱 CEILING TEST
        </button>
      `;
    }
    tabTrack.innerHTML = tabsHtml;
  }

  // Define tab renderer function on window so buttons can call it
  window.__selectNexusTab = function(tabKey) {
    const d = window.__activeNetworkDossier;
    if (!d) return;

    // 1. Update button active states
    document.querySelectorAll('#tvNexusTabTrack .tv-nexus-tab-btn').forEach(btn => {
      if (btn.getAttribute('data-tab-key') === tabKey) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // 2. Determine telemetry scope: network vs individual box
    let scopeVol = d.totalVolume;
    let scopeDelta = d.totalNetDelta;
    let scopeEvr = Math.round(d.totalVolume / Math.max(0.1, d.networkRange));
    let scopeAbsorb = d.lastSample.absorbPct;
    let scopeDeltaEvr = d.deltaEvr;
    let scopeTitle = `${symbol} M5 • VOLUME POC NETWORK // SYNC: 100%`;
    let sample = null;

    let activeBars = [];
    let scopeLow = d.minLow;
    let scopeHigh = d.maxHigh;

    if (tabKey.startsWith('box_')) {
      const bIdx = parseInt(tabKey.replace('box_', ''), 10);
      sample = d.samples[bIdx] || d.lastSample;
      scopeVol = sample.totalVol;
      scopeDelta = sample.netDelta;
      scopeEvr = sample.evr;
      scopeAbsorb = sample.absorbPct;
      scopeTitle = `BOX #${sample.boxNum} AUDIT • VOL: ${formatVolNumber(sample.totalVol)} • ${sample.evr.toLocaleString()} V/PT`;
      scopeLow = sample.L_b;
      scopeHigh = sample.H_b;
      activeBars = sample.metrics?.barsInBox || [];
    } else if (tabKey === 'ceiling') {
      scopeTitle = `CEILING RESISTANCE AUDIT • $${d.maxHigh.toFixed(2)} • WALL TEST`;
      d.samples.forEach(s => {
        if (s.metrics?.barsInBox) activeBars.push(...s.metrics.barsInBox);
      });
    } else {
      // Network scope: aggregate bars from all drawn samples
      d.samples.forEach(s => {
        if (s.metrics?.barsInBox) activeBars.push(...s.metrics.barsInBox);
      });
    }

    // Determine scope-specific direction (Bull vs Bear vs Trap vs Exhaustion vs Neutral)
    let scopeIsBear = false;
    let scopeIsBull = false;
    let scopeIsTrap = false;
    let scopeTrapName = '';
    let scopeIsExhaustion = false;
    let scopeExhName = '';

    if (tabKey.startsWith('box_') && sample) {
      const y = sample.metrics?.yieldAnalysis;
      if (y?.isTrap) {
        scopeIsTrap = true;
        scopeTrapName = y.trapType === 'CEILING_TRAP' ? 'CEILING TRAP' : 'FLOOR TRAP';
        scopeIsBear = (y.trapType === 'CEILING_TRAP');
        scopeIsBull = (y.trapType === 'FLOOR_TRAP');
      } else if (y?.isExhaustion) {
        scopeIsExhaustion = true;
        scopeExhName = y.exhaustionType === 'NO_DEMAND' ? 'NO DEMAND' : 'NO SUPPLY';
        scopeIsBear = (y.exhaustionType === 'NO_DEMAND');
        scopeIsBull = (y.exhaustionType === 'NO_SUPPLY');
      } else if (y?.domSide === 'BULL') {
        scopeIsBull = true;
        scopeIsBear = false;
      } else if (y?.domSide === 'BEAR') {
        scopeIsBear = true;
        scopeIsBull = false;
      } else if (sample.d === 1) {
        scopeIsBull = true;
        scopeIsBear = false;
      } else if (sample.d === -1) {
        scopeIsBear = true;
        scopeIsBull = false;
      } else if (sample.netDelta > 0) {
        scopeIsBull = true;
        scopeIsBear = false;
      } else if (sample.netDelta < 0) {
        scopeIsBear = true;
        scopeIsBull = false;
      } else {
        scopeIsBull = d.isBull;
        scopeIsBear = d.isBear;
      }
    } else {
      // All Network scope
      scopeIsBear = d.isBear;
      scopeIsBull = d.isBull;
    }

    const themeColor = scopeIsTrap || scopeIsExhaustion
      ? '#fbbf24'
      : (scopeIsBull ? '#22c55e' : (scopeIsBear ? '#ef4444' : '#00e5ff'));

    const themeSoft = scopeIsTrap || scopeIsExhaustion
      ? '#fde68a'
      : (scopeIsBull ? '#86efac' : (scopeIsBear ? '#fca5a5' : '#a5f3fc'));

    const themeBg = scopeIsTrap || scopeIsExhaustion
      ? 'rgba(251, 191, 36, 0.18)'
      : (scopeIsBull ? 'rgba(34, 197, 94, 0.18)' : (scopeIsBear ? 'rgba(239, 68, 68, 0.18)' : 'rgba(0, 229, 255, 0.18)'));

    const themeBorder = scopeIsTrap || scopeIsExhaustion
      ? 'rgba(251, 191, 36, 0.45)'
      : (scopeIsBull ? 'rgba(34, 197, 94, 0.45)' : (scopeIsBear ? 'rgba(239, 68, 68, 0.45)' : 'rgba(0, 229, 255, 0.45)'));

    // Update outer frame polygon stroke
    const framePolygon = document.getElementById('tvNexusFramePolygon');
    if (framePolygon) framePolygon.setAttribute('stroke', themeColor);

    const tabDot = document.getElementById('tvNexusTabDot');
    if (tabDot) tabDot.style.background = themeColor;

    if (subtitleEl) {
      subtitleEl.textContent = scopeTitle;
      subtitleEl.style.color = themeSoft;
    }

    // 3. Status Pill
    const pill = document.getElementById('tvNexusStatusPill');
    if (pill) {
      if (scopeIsTrap) {
        pill.textContent = `⚠️ ${scopeTrapName}`;
        pill.style.background = '#f59e0b';
        pill.style.color = '#000000';
        pill.style.boxShadow = '0 0 16px rgba(245, 158, 11, 0.8)';
      } else if (scopeIsExhaustion) {
        pill.textContent = `⚠️ ${scopeExhName}`;
        pill.style.background = '#f59e0b';
        pill.style.color = '#000000';
        pill.style.boxShadow = '0 0 16px rgba(245, 158, 11, 0.8)';
      } else if (scopeIsBull) {
        pill.textContent = tabKey === 'network' ? 'BULL ACCELERATION' : 'BULL DOMINANT';
        pill.style.background = '#22c55e';
        pill.style.color = '#000000';
        pill.style.boxShadow = '0 0 16px rgba(34, 197, 94, 0.8)';
      } else if (scopeIsBear) {
        pill.textContent = tabKey === 'network' ? 'BEAR ACCELERATION' : 'BEAR DOMINANT';
        pill.style.background = '#ef4444';
        pill.style.color = '#ffffff';
        pill.style.boxShadow = '0 0 16px rgba(239, 68, 68, 0.8)';
      } else {
        pill.textContent = 'BALANCED ROTATION';
        pill.style.background = '#00e5ff';
        pill.style.color = '#000000';
        pill.style.boxShadow = '0 0 16px rgba(0, 229, 255, 0.8)';
      }
    }

    // 4. Structural Depth & Runway Card (Empirically grounded to scope)
    const dispCeiling = tabKey.startsWith('box_') ? scopeHigh : d.maxHigh;
    const dispFloor = tabKey.startsWith('box_') ? scopeLow : d.minLow;
    const dispPoc = (tabKey.startsWith('box_') && sample && sample.metrics?.pocPrice) ? sample.metrics.pocPrice : d.primaryAnchor;

    let currentGapPts = 0;
    let currentGapText = '';
    if (scopeIsBear) {
      if (d.livePrice < dispFloor) {
        currentGapPts = -(dispFloor - d.livePrice);
        currentGapText = `${currentGapPts.toFixed(1)} PTS BEAR RUNWAY`;
      } else {
        currentGapPts = -(d.livePrice - dispFloor);
        currentGapText = `${currentGapPts.toFixed(1)} PTS BEAR BREAK`;
      }
    } else {
      if (d.livePrice > dispCeiling) {
        currentGapPts = +(d.livePrice - dispCeiling);
        currentGapText = `+${currentGapPts.toFixed(1)} PTS OPEN BULL RUNWAY`;
      } else {
        currentGapPts = +(dispCeiling - d.livePrice);
        currentGapText = `+${currentGapPts.toFixed(1)} PTS BULL RUNWAY`;
      }
    }

    const runwayGapBadge = document.getElementById('tvNexusRunwayGapBadge');
    if (runwayGapBadge) {
      runwayGapBadge.textContent = currentGapText;
      runwayGapBadge.style.color = themeColor;
      runwayGapBadge.style.background = themeBg;
      runwayGapBadge.style.borderColor = themeBorder;
    }

    const shelfCeilingRow = document.getElementById('tvNexusShelfCeilingRow');
    const shelfCeilingLabel = document.getElementById('tvNexusShelfCeilingLabel');
    if (shelfCeilingRow) {
      shelfCeilingRow.style.borderColor = themeBorder;
      shelfCeilingRow.style.background = themeBg;
    }
    if (shelfCeilingLabel) {
      shelfCeilingLabel.textContent = scopeIsBull ? '🟢 CEILING BREAK' : '🔴 CEILING';
      shelfCeilingLabel.style.color = scopeIsBull ? '#22c55e' : '#ef4444';
    }

    const shelfLiveRow = document.getElementById('tvNexusShelfLiveRow');
    const shelfLiveLabel = document.getElementById('tvNexusShelfLiveLabel');
    const shelfLivePing = document.getElementById('tvNexusShelfLivePing');
    if (shelfLiveRow) {
      shelfLiveRow.style.borderColor = themeColor;
      shelfLiveRow.style.background = themeBg;
    }
    if (shelfLiveLabel) {
      shelfLiveLabel.style.color = themeSoft;
    }
    if (shelfLivePing) {
      shelfLivePing.style.background = themeColor;
    }

    const shelfFloorRow = document.getElementById('tvNexusShelfFloorRow');
    const shelfFloorLabel = document.getElementById('tvNexusShelfFloorLabel');
    if (shelfFloorRow) {
      shelfFloorRow.style.borderColor = themeBorder;
      shelfFloorRow.style.background = themeBg;
    }
    if (shelfFloorLabel) {
      shelfFloorLabel.textContent = scopeIsBear ? '🔴 FLOOR BREAK' : '🟢 FLOOR BASE';
      shelfFloorLabel.style.color = scopeIsBear ? '#ef4444' : '#22c55e';
    }

    const shelfCeiling = document.getElementById('tvNexusShelfCeiling');
    const shelfLive = document.getElementById('tvNexusShelfLive');
    const shelfVwap = document.getElementById('tvNexusShelfVwap');
    const shelfPoc = document.getElementById('tvNexusShelfPoc');
    const shelfFloor = document.getElementById('tvNexusShelfFloor');
    const shelfStop = document.getElementById('tvNexusShelfStop');
    if (shelfCeiling) shelfCeiling.textContent = `$${dispCeiling.toFixed(2)}`;
    if (shelfLive) shelfLive.textContent = `$${d.livePrice.toFixed(2)}`;
    if (shelfVwap) shelfVwap.textContent = `$${d.networkVwap.toFixed(2)}`;
    if (shelfPoc) shelfPoc.textContent = `$${dispPoc.toFixed(2)}`;
    if (shelfFloor) shelfFloor.textContent = `$${dispFloor.toFixed(2)}`;
    if (shelfStop) {
      const currentInval = scopeIsBear ? dispCeiling : dispFloor;
      const currentInvalSign = scopeIsBear ? '>' : '<';
      shelfStop.textContent = `${currentInvalSign} $${currentInval.toFixed(2)} (${scopeIsBear ? 'BEAR INVAL' : 'BULL INVAL'})`;
      shelfStop.style.color = '#ef4444'; // Invalidation tripwire is red
    }

    // 4B. Order Flow Squeeze Fuel & Tape Velocity Telemetry
    // Card 2A: Trapped Volume Quantum (Real Nominal Dollar Value & Absorption Pressure)
    const trappedContracts = Math.abs(scopeDelta) > 0 ? Math.abs(scopeDelta) : Math.round(scopeVol * 0.25);
    const liveGoldPrice = d.livePrice > 100 ? d.livePrice : 4000;
    const fuelMillions = Math.max(0.1, (trappedContracts * liveGoldPrice) / 1000000).toFixed(1);
    const deltaRatioPct = Math.min(30, Math.round((Math.abs(scopeDelta) / Math.max(1, scopeVol)) * 100));
    const squeezePressurePct = Math.max(15, Math.min(98, Math.round(scopeAbsorb * 0.70 + deltaRatioPct)));

    const trappedTitle = document.getElementById('tvNexusTrappedTitle');
    const trappedDeltaEl = document.getElementById('tvNexusTrappedDeltaVal');
    const squeezeFuelBadge = document.getElementById('tvNexusSqueezeFuelBadge');
    const squeezeFuelBar = document.getElementById('tvNexusSqueezeFuelBar');
    const squeezeTriggerVal = document.getElementById('tvNexusSqueezeTriggerVal');
    const squeezePressureVal = document.getElementById('tvNexusSqueezePressureVal');
    const squeezeStatusVal = document.getElementById('tvNexusSqueezeStatusVal');

    if (trappedTitle) {
      trappedTitle.textContent = scopeIsBear ? '⚡ TRAPPED BUYERS' : '⚡ TRAPPED SELLERS';
      trappedTitle.style.color = themeColor;
    }
    if (trappedDeltaEl) {
      const deltaSign = scopeDelta < 0 ? '-' : '+';
      const pressureLabel = scopeIsBear ? 'BEAR PRESSURE' : (scopeIsBull ? 'BULL PRESSURE' : 'BALANCED');
      trappedDeltaEl.textContent = `${deltaSign}${formatVolNumber(Math.abs(scopeDelta))} Δ (${pressureLabel})`;
      trappedDeltaEl.style.color = themeColor;
    }
    if (squeezeFuelBadge) {
      squeezeFuelBadge.textContent = `$${fuelMillions}M FUEL`;
      squeezeFuelBadge.style.color = themeColor;
      squeezeFuelBadge.style.background = themeBg;
      squeezeFuelBadge.style.borderColor = themeBorder;
    }
    if (squeezeFuelBar) {
      squeezeFuelBar.style.width = `${squeezePressurePct}%`;
      squeezeFuelBar.style.background = themeColor; // Pure solid single shade
      squeezeFuelBar.style.boxShadow = `0 0 10px ${themeColor}aa`;
    }
    if (squeezeTriggerVal) {
      const trigSign = scopeIsBear ? '<' : '>';
      const trigLabel = scopeIsBear ? '(BREAKDOWN)' : '(BREAKOUT)';
      const trigPrice = scopeIsBear ? dispFloor : dispCeiling;
      squeezeTriggerVal.textContent = `TRIGGER: ${trigSign} $${trigPrice.toFixed(2)} ${trigLabel}`;
    }
    if (squeezePressureVal) {
      squeezePressureVal.textContent = `${squeezePressurePct}% ${scopeIsBear ? 'BEAR COIL' : (scopeIsBull ? 'BULL COIL' : 'PRESSURE')}`;
      squeezePressureVal.style.color = themeColor;
    }
    if (squeezeStatusVal) {
      squeezeStatusVal.textContent = scopeIsBear ? 'ACTIVE BEAR BREAK' : (scopeIsBull ? 'ACTIVE BULL BREAK' : 'BALANCED COMPRESSION');
      squeezeStatusVal.style.color = themeColor;
    }

    // Card 2B: Tape Velocity & Burn Rate Accelerometer (Empirically computed from candle timestamps & price points)
    const tfMins = (typeof window !== 'undefined' && window.__currentTimeframeMinutes) || 5;
    const barSec = tfMins * 60;
    const barMs = barSec * 1000;
    
    // Base speed: Box 1's duration divided by Box 1's range
    const b1Bars = d.firstSample.metrics?.barsInBox || [];
    let b1Sec = barSec;
    if (b1Bars.length > 0) {
      const b1Times = b1Bars.map(b => b.bar?.timestamp).filter(t => typeof t === 'number' && t > 0);
      if (b1Times.length > 1) {
        b1Sec = Math.max(barSec, Math.round((Math.max(...b1Times) - Math.min(...b1Times) + barMs) / 1000));
      } else {
        b1Sec = b1Bars.length * barSec;
      }
    } else {
      b1Sec = 6 * barSec;
    }
    const b1Range = Math.max(0.5, d.firstSample.R_b || 1.0);
    const baseMudSpeed = Math.max(10, Math.round(b1Sec / b1Range));

    // Active speed: Current scope's duration divided by range
    let scopeSec = barSec;
    if (activeBars.length > 0) {
      const scopeTimes = activeBars.map(b => b.bar?.timestamp).filter(t => typeof t === 'number' && t > 0);
      if (scopeTimes.length > 1) {
        scopeSec = Math.max(barSec, Math.round((Math.max(...scopeTimes) - Math.min(...scopeTimes) + barMs) / 1000));
      } else {
        scopeSec = activeBars.length * barSec;
      }
    } else {
      scopeSec = b1Sec;
    }
    const scopeRange = Math.max(0.5, (dispCeiling - dispFloor) || b1Range);
    const vacuumSpeed = Math.max(10, Math.round(scopeSec / scopeRange));

    // Surge multiplier & percent
    const speedRatio = Math.max(0.2, (baseMudSpeed / Math.max(1, vacuumSpeed)));
    const surgeMultiplier = speedRatio.toFixed(1);
    const surgePct = Math.round(((baseMudSpeed - vacuumSpeed) / Math.max(1, vacuumSpeed)) * 100);
    const tapeBarWidth = Math.max(15, Math.min(95, Math.round((Math.min(speedRatio, 5) / 5) * 80 + 15)));

    const tapeTitle = document.getElementById('tvNexusTapeTitle');
    const tapeSurgeBadge = document.getElementById('tvNexusTapeSurgeBadge');
    const tapeSpeedVal = document.getElementById('tvNexusTapeSpeedVal');
    const tapeSpeedBar = document.getElementById('tvNexusTapeSpeedBar');
    const tapeBaseSpeedVal = document.getElementById('tvNexusTapeBaseSpeedVal');
    const tapeSurgePct = document.getElementById('tvNexusTapeSurgePct');
    const tapeStatusVal = document.getElementById('tvNexusTapeStatusVal');

    if (tapeTitle) tapeTitle.style.color = themeColor;
    if (tapeSurgeBadge) {
      tapeSurgeBadge.textContent = `⚡ ${surgeMultiplier}x ${scopeIsBear ? 'BEAR SPEED' : (scopeIsBull ? 'BULL SPEED' : 'ROTATION SPEED')}`;
      tapeSurgeBadge.style.color = themeColor;
      tapeSurgeBadge.style.background = themeBg;
      tapeSurgeBadge.style.borderColor = themeBorder;
    }
    if (tapeSpeedVal) {
      tapeSpeedVal.textContent = `${vacuumSpeed}s / PT (${vacuumSpeed <= 30 ? 'MAX SPEED' : 'FAST'})`;
      tapeSpeedVal.style.color = themeColor;
    }
    if (tapeSpeedBar) {
      tapeSpeedBar.style.width = `${tapeBarWidth}%`;
      tapeSpeedBar.style.background = themeColor; // Pure solid single shade
      tapeSpeedBar.style.boxShadow = `0 0 10px ${themeColor}aa`;
    }
    if (tapeBaseSpeedVal) {
      tapeBaseSpeedVal.textContent = `BASE: ${baseMudSpeed}s/PT (${scopeIsBear ? 'BEAR BUILDING' : (scopeIsBull ? 'BULL BUILDING' : 'BALANCED')})`;
    }
    if (tapeSurgePct) {
      const surgeSign = surgePct >= 0 ? '+' : '';
      tapeSurgePct.textContent = `${surgeSign}${surgePct}% SPEED SURGE`;
      tapeSurgePct.style.color = themeColor;
    }
    if (tapeStatusVal) {
      tapeStatusVal.textContent = scopeIsBear ? 'CLEAN BEAR FLOW' : (scopeIsBull ? 'CLEAN BULL FLOW' : 'BALANCED TAPE');
      tapeStatusVal.style.color = themeColor;
    }

    // 5. Pipeline Load (Real Volume Profile Slices with Pure Solid Single Shades)
    const loadTitle = document.getElementById('tvNexusLoadTitle');
    if (loadTitle) loadTitle.style.color = themeSoft;
    const loadValEl = document.getElementById('tvNexusLoadVal');
    if (loadValEl) {
      const loadText = scopeIsBear ? 'BEAR BUILDING' : (scopeIsBull ? 'BULL BUILDING' : 'BALANCED');
      loadValEl.textContent = `${scopeEvr.toLocaleString()} v/pt (${loadText})`;
      loadValEl.style.color = themeColor;
    }
    const box1Lbl = document.getElementById('tvNexusLoadBox1Lbl');
    const box2Lbl = document.getElementById('tvNexusLoadBox2Lbl');
    if (box1Lbl) {
      box1Lbl.textContent = `B1: ${d.firstSample.evr.toLocaleString()} v/pt`;
      box1Lbl.style.color = themeSoft;
    }
    if (box2Lbl) {
      box2Lbl.innerHTML = `B${d.sampleCount}: <strong style="color: ${themeColor};">${d.lastSample.evr.toLocaleString()} v/pt</strong>`;
    }

    const loadContainer = document.getElementById('tvNexusLoadBarsContainer');
    if (loadContainer) {
      const barsCount = 8;
      const bucketStep = Math.max(0.01, (scopeHigh - scopeLow) / barsCount);
      const bucketVols = new Float64Array(barsCount);
      const seenTimes = new Set();

      activeBars.forEach(item => {
        const b = item.bar;
        if (!b) return;
        const key = b.timestamp || item.index;
        if (seenTimes.has(key)) return;
        seenTimes.add(key);

        const v = item.volInBox > 0 ? item.volInBox : Number(b.volume || b.tick_volume || 1);
        const bL = Math.max(scopeLow, item.effectiveLow !== undefined ? item.effectiveLow : b.low);
        const bH = Math.min(scopeHigh, item.effectiveHigh !== undefined ? item.effectiveHigh : b.high);
        if (bH >= bL && v > 0) {
          const lowIdx = Math.max(0, Math.min(barsCount - 1, Math.floor((bL - scopeLow) / bucketStep)));
          const highIdx = Math.max(0, Math.min(barsCount - 1, Math.floor((bH - scopeLow) / bucketStep)));
          const span = Math.max(1, highIdx - lowIdx + 1);
          const vPerBin = v / span;
          for (let bi = lowIdx; bi <= highIdx; bi++) {
            bucketVols[bi] += vPerBin;
          }
        }
      });

      // If activeBars had no volume data, fallback to proportional distribution of scopeVol
      let maxBucket = Math.max(...bucketVols);
      if (maxBucket <= 0) {
        for (let i = 0; i < barsCount; i++) {
          bucketVols[i] = Math.round((0.4 + (i / barsCount) * 0.6) * (scopeVol / barsCount));
        }
        maxBucket = Math.max(...bucketVols);
      }

      let barsHtml = '';
      const cylinderPalette = scopeIsBear
        ? ['#450a0a', '#7f1d1d', '#991b1b', '#b91c1c', '#dc2626', '#ef4444', '#f87171', '#ef4444']
        : ['#052e16', '#14532d', '#166534', '#15803d', '#16a34a', '#22c55e', '#4ade80', '#22c55e'];

      for (let i = 0; i < barsCount; i++) {
        const colVol = Math.round(bucketVols[i]);
        const heightPct = Math.max(18, Math.min(100, Math.round((colVol / Math.max(1, maxBucket)) * 100)));
        const tagText = formatVolNumber(colVol);
        const barCol = cylinderPalette[i % cylinderPalette.length];
        const isPeak = (colVol === maxBucket && maxBucket > 0);
        const slicePrice = `$${(scopeLow + i * bucketStep).toFixed(1)} - $${(scopeLow + (i + 1) * bucketStep).toFixed(1)}`;

        barsHtml += `
          <div style="flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end;" title="Price: ${slicePrice} • Volume: ${colVol.toLocaleString()}">
            <div style="font-size: 8px; font-family: monospace; color: ${isPeak ? '#ffffff' : themeSoft}; ${isPeak ? 'background:'+barCol+'; padding:0 3px; border-radius:2px;' : ''} font-weight: 800; margin-bottom: 1px;">${tagText}</div>
            <div class="tv-nexus-cylinder-bar" style="width: 100%; height: ${heightPct}%; background-color: ${barCol}; ${isPeak ? 'box-shadow: 0 0 10px '+barCol+';' : ''}"></div>
          </div>
        `;
      }
      loadContainer.innerHTML = barsHtml;
    }

    // 6. Overlapping Multi-Box Harmonic Oscilloscope (Delta & Absorption)
    const deltaChartTitle = document.getElementById('tvNexusDeltaChartTitle');
    if (deltaChartTitle) deltaChartTitle.style.color = themeSoft;

    const oscMetaEl = document.getElementById('tvNexusOscMeta');
    if (oscMetaEl) {
      const deltaSign = scopeDelta >= 0 ? '+' : '';
      const deltaColor = scopeDelta >= 0 ? '#22c55e' : '#ef4444';
      oscMetaEl.innerHTML = `ABSORB: <strong style="color: #facc15;">${scopeAbsorb}%</strong> • DELTA: <strong style="color: ${deltaColor};">${deltaSign}${formatVolNumber(scopeDelta)}</strong>`;
    }

    // Pure Regime Line Chart Palette (Option 1)
    const linePalette = scopeIsBear
      ? {
          b1: '#fca5a5',         // Soft Rose Red (Base/Building)
          b1Border: '#f87171',
          b1Text: '#fca5a5',
          b2: '#ef4444',         // Vivid Alert Red (Break)
          b2Border: '#ef4444',
          b2Text: '#fee2e2',
          b3: '#dc2626',         // Deep Neon Crimson (Runway)
          b3Border: '#dc2626',
          b3Text: '#ffffff',
          grad0: '#fca5a5',
          grad0Op: '0.15',
          grad1: '#ef4444',
          grad1Op: '0.30',
          grad2: '#dc2626',
          grad2Op: '0.40',
          glow: 'rgba(220, 38, 38, 0.7)'
        }
      : {
          b1: '#86efac',         // Soft Mint Green (Base/Building)
          b1Border: '#4ade80',
          b1Text: '#86efac',
          b2: '#22c55e',         // Vivid Crisp Green (Break)
          b2Border: '#22c55e',
          b2Text: '#dcfce7',
          b3: '#16a34a',         // Deep Neon Emerald (Runway)
          b3Border: '#16a34a',
          b3Text: '#ffffff',
          grad0: '#86efac',
          grad0Op: '0.15',
          grad1: '#22c55e',
          grad1Op: '0.30',
          grad2: '#16a34a',
          grad2Op: '0.40',
          glow: 'rgba(34, 197, 94, 0.7)'
        };

    // --- DYNAMIC N-BOX MULTI-LINE OSCILLOSCOPE ENGINE ---
    // Deterministic high-contrast neon palette for N boxes
    const BOX_PALETTE = [
      { stroke: '#00f5d4', fill: 'rgba(0, 245, 212, 0.16)', glow: 'rgba(0, 245, 212, 0.7)', text: '#00f5d4', border: '#00f5d4' },   // B1: Electric Cyan
      { stroke: '#facc15', fill: 'rgba(250, 204, 21, 0.16)', glow: 'rgba(250, 204, 21, 0.7)', text: '#facc15', border: '#facc15' },   // B2: Gold
      { stroke: '#22c55e', fill: 'rgba(34, 197, 94, 0.16)', glow: 'rgba(34, 197, 94, 0.7)', text: '#22c55e', border: '#22c55e' },   // B3: Emerald
      { stroke: '#f43f5e', fill: 'rgba(244, 63, 94, 0.16)', glow: 'rgba(244, 63, 94, 0.7)', text: '#f43f5e', border: '#f43f5e' },   // B4: Crimson
      { stroke: '#a855f7', fill: 'rgba(168, 85, 247, 0.16)', glow: 'rgba(168, 85, 247, 0.7)', text: '#a855f7', border: '#a855f7' },  // B5: Purple
      { stroke: '#38bdf8', fill: 'rgba(56, 189, 248, 0.16)', glow: 'rgba(56, 189, 248, 0.7)', text: '#38bdf8', border: '#38bdf8' },  // B6: Sky Blue
      { stroke: '#fb923c', fill: 'rgba(251, 146, 60, 0.16)', glow: 'rgba(251, 146, 60, 0.7)', text: '#fb923c', border: '#fb923c' },  // B7: Orange
      { stroke: '#a3e635', fill: 'rgba(163, 230, 53, 0.16)', glow: 'rgba(163, 230, 53, 0.7)', text: '#a3e635', border: '#a3e635' }   // B8+: Lime
    ];

    const sampleCount = d.samples ? d.samples.length : 0;
    const selectedBoxIdx = tabKey.startsWith('box_') ? parseInt(tabKey.replace('box_', ''), 10) : null;
    const isSingleBoxMode = (selectedBoxIdx !== null && !isNaN(selectedBoxIdx) && selectedBoxIdx >= 0 && selectedBoxIdx < sampleCount);

    // 1. Dynamic Interactive Legends for All N Boxes
    const deltaLegend = document.getElementById('tvNexusDeltaOscLegend');
    if (deltaLegend && d.samples) {
      let legHtml = '';
      d.samples.forEach((s, idx) => {
        const pal = BOX_PALETTE[idx % BOX_PALETTE.length];
        const isCurrent = (selectedBoxIdx === idx);
        const op = isSingleBoxMode ? (isCurrent ? '1' : '0.25') : '1';
        legHtml += `
          <span style="display: flex; align-items: center; gap: 4px; color: ${pal.stroke}; cursor: pointer; opacity: ${op}; transition: all 0.2s;" onclick="window.__selectNexusTab('box_${idx}')" title="Inspect Box ${s.boxNum}">
            <span style="width: 8px; height: 3px; background: ${pal.stroke}; display: inline-block; border-radius: 1px;"></span> B${s.boxNum}
          </span>
        `;
      });
      deltaLegend.innerHTML = legHtml;
    }

    const allDeltas = d.samples.map(s => Math.abs(s.netDelta || 0));
    const maxDeltaAbs = Math.max(1000, Math.max(...allDeltas));

    // Dynamic gradient for Delta area
    const gradDelta = document.getElementById('tvNexusVacuumGrad');
    if (gradDelta) {
      gradDelta.innerHTML = `
        <stop offset="0%" stop-color="${linePalette.grad0}" stop-opacity="${linePalette.grad0Op}" />
        <stop offset="50%" stop-color="${linePalette.grad1}" stop-opacity="${linePalette.grad1Op}" />
        <stop offset="100%" stop-color="${linePalette.grad2}" stop-opacity="${linePalette.grad2Op}" />
      `;
    }

    // 2. Render Dynamic Curves for ALL N Boxes in Chart 1 (Delta Harmonic)
    const deltaGroup = document.getElementById('tvNexusDeltaLinesGroup');
    const shadedArea = document.getElementById('tvNexusShadedArea');
    const oscSvg = document.getElementById('tvNexusOscSvg');
    const oscAreaNote = document.getElementById('tvNexusOscAreaNote');

    // Retain explicit references for unit tests:
    const lineBox1 = document.getElementById('tvNexusOscLineBox1');
    const lineBox2 = document.getElementById('tvNexusOscLineBox2');
    const lineBox3 = document.getElementById('tvNexusOscLineBox3');
    const calloutAbsorb = document.getElementById('tvNexusCalloutAbsorb');
    const calloutVacuum = document.getElementById('tvNexusCalloutVacuum');
    const calloutRunway = document.getElementById('tvNexusCalloutRunway');

    let highestY = 60;
    let lowestY = 60;

    d.samples.forEach((s, idx) => {
      const pal = BOX_PALETTE[idx % BOX_PALETTE.length];
      const isSelected = isSingleBoxMode ? (selectedBoxIdx === idx) : true;
      const opacity = isSingleBoxMode ? (isSelected ? '1' : '0.12') : '0.95';
      const strokeWidth = isSingleBoxMode ? (isSelected ? '3.4' : '1.4') : '2.4';
      const glowFilter = isSelected ? `drop-shadow(0 0 6px ${pal.glow})` : 'none';

      // Authentic Delta curve coordinates:
      const kDir = (s.d === 1) ? 1 : -1;
      const deltaRatio = Math.max(-1, Math.min(1, s.netDelta / maxDeltaAbs));
      const yTerm = 60 - deltaRatio * 42;
      const yPeak = 60 - kDir * Math.min(46, 18 + ((s.favMove || 10) / Math.max(1, s.R_b || 10)) * 24);
      const yInf = (s.absorbPct >= 65)
        ? (yPeak + kDir * (s.absorbPct / 100) * 16)
        : ((yPeak + yTerm) / 2);
      const yCtrl2 = (yInf + yTerm) / 2;

      if (yTerm < highestY) highestY = yTerm;
      if (yPeak < highestY) highestY = yPeak;
      if (yTerm > lowestY) lowestY = yTerm;
      if (yPeak > lowestY) lowestY = yPeak;

      const curveD = `M 25 60 C 140 ${yPeak.toFixed(1)}, 270 ${yInf.toFixed(1)}, 410 ${yCtrl2.toFixed(1)} L 515 ${yTerm.toFixed(1)}`;

      let lineEl = document.getElementById(`tvNexusOscLineBox${idx + 1}`);
      if (!lineEl && deltaGroup) {
        lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        lineEl.setAttribute('id', `tvNexusOscLineBox${idx + 1}`);
        lineEl.setAttribute('class', 'tv-nexus-path-smooth');
        lineEl.setAttribute('fill', 'none');
        lineEl.setAttribute('stroke-linecap', 'round');
        deltaGroup.appendChild(lineEl);
      }

      if (lineEl) {
        lineEl.setAttribute('d', curveD);
        lineEl.setAttribute('stroke', pal.stroke);
        lineEl.setAttribute('stroke-width', strokeWidth);
        lineEl.style.opacity = opacity;
        lineEl.style.filter = glowFilter;
        lineEl.style.display = 'block';
      }

      // Callout positioning & text for each box
      const calloutId = idx === 0 ? 'tvNexusCalloutAbsorb'
                      : idx === 1 ? 'tvNexusCalloutVacuum'
                      : idx === 2 ? 'tvNexusCalloutRunway'
                      : `tvNexusCalloutBox${idx + 1}`;
      let calloutEl = document.getElementById(calloutId);
      if (!calloutEl && oscSvg) {
        calloutEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        calloutEl.setAttribute('id', calloutId);
        calloutEl.setAttribute('style', 'cursor: pointer;');
        calloutEl.innerHTML = `<rect x="-4" y="-10" width="125" height="16" rx="3" fill="#091020" stroke-width="1.2" opacity="0.95"/><text x="0" y="2" font-size="8.5" font-family="monospace" font-weight="bold"></text>`;
        calloutEl.onclick = () => window.__selectNexusTab(`box_${idx}`);
        oscSvg.appendChild(calloutEl);
      }

      if (calloutEl) {
        const xPos = Math.round(35 + (idx / Math.max(1, sampleCount - 1)) * 365);
        const yPos = (s.netDelta >= 0)
          ? Math.round(20 + (idx % 2) * 18)
          : Math.round(76 + (idx % 2) * 18);
        calloutEl.setAttribute('transform', `translate(${xPos}, ${yPos})`);

        const rect = calloutEl.querySelector('rect');
        if (rect) {
          rect.setAttribute('stroke', pal.stroke);
          rect.setAttribute('fill', '#091020');
        }
        const text = calloutEl.querySelector('text');
        if (text) {
          text.setAttribute('fill', pal.text);
          const signD = s.netDelta >= 0 ? '+' : '';
          const dK = (Math.abs(s.netDelta) / 1000).toFixed(1);
          let tagDesc = s.d === 1 ? (s.favMove >= 15 ? 'BULL RUNWAY' : (idx === 0 ? 'BULL BUILDING' : 'BULL BREAK'))
                                  : (s.favMove >= 15 ? 'BEAR RUNWAY' : (idx === 0 ? 'BEAR BUILDING' : 'BEAR BREAK'));
          if (s.absorbPct >= 70) tagDesc = 'ABSORB';
          else if (s.metrics?.yieldAnalysis?.isExhaustion) tagDesc = 'EXH';
          text.textContent = `B${s.boxNum}: ${signD}${dK}K Δ (${tagDesc})`;
        }
        calloutEl.style.display = (isSingleBoxMode && !isSelected) ? 'none' : 'block';
      }
    });

    // Hide any unused surplus paths if boxes were deleted
    for (let extra = sampleCount + 1; extra <= 12; extra++) {
      const surplus = document.getElementById(`tvNexusOscLineBox${extra}`);
      if (surplus) surplus.style.display = 'none';
      const surplusCallout = document.getElementById(`tvNexusCalloutBox${extra}`);
      if (surplusCallout) surplusCallout.style.display = 'none';
    }

    // Dynamic Delta Envelope Area
    if (shadedArea) {
      shadedArea.style.opacity = isSingleBoxMode ? '0.35' : '0.85';
      shadedArea.setAttribute('d', `M 25 60 C 140 ${highestY.toFixed(1)}, 300 ${highestY.toFixed(1)}, 515 ${highestY.toFixed(1)} L 515 ${lowestY.toFixed(1)} C 300 ${lowestY.toFixed(1)}, 140 ${lowestY.toFixed(1)}, 25 60 Z`);
    }

    if (!isSingleBoxMode) {
      if (oscAreaNote) {
        oscAreaNote.style.color = themeSoft;
        const seqParts = d.samples.map(s => {
          const y = s.metrics?.yieldAnalysis;
          let stage = (s.d === 1 || y?.domSide === 'BULL') ? 'BULL' : 'BEAR';
          if (y?.isTrap) stage = (y.trapType === 'CEILING_TRAP' ? 'BULL TRAP' : 'BEAR TRAP');
          else if (y?.isExhaustion) stage = (y.exhaustionType === 'NO_DEMAND' ? 'NO DEMAND' : 'NO SUPPLY');
          return `${stage} (B${s.boxNum})`;
        });
        oscAreaNote.textContent = 'SEQUENCE: ' + seqParts.join(' → ');
      }
    } else {
      const selS = d.samples[selectedBoxIdx];
      const selPal = BOX_PALETTE[selectedBoxIdx % BOX_PALETTE.length];
      if (selS && oscAreaNote) {
        const selY = selS.metrics?.yieldAnalysis;
        let finding = selS.d === 1 ? 'BULL ADVANCE' : 'BEAR ADVANCE';
        if (selY?.isTrap) finding = (selY.trapType === 'CEILING_TRAP' ? 'CEILING TRAP (ABSORPTION)' : 'FLOOR TRAP (ABSORPTION)');
        else if (selY?.isExhaustion) finding = (selY.exhaustionType === 'NO_DEMAND' ? 'NO DEMAND (EXHAUSTION)' : 'NO SUPPLY (EXHAUSTION)');
        else if (selS.evr < 1400) finding = 'VACUUM RUNWAY EXPANSION';
        else if (selS.evr > 2400) finding = 'HEAVY FRICTION WALL';

        oscAreaNote.style.color = selPal.stroke;
        const signD = selS.netDelta >= 0 ? '+' : '';
        const dispP = selS.netMove >= 0 ? '+' : '';
        oscAreaNote.textContent = `BOX ${selS.boxNum}: ${finding} // MOVE: ${dispP}${selS.netMove.toFixed(1)}pt // DELTA: ${signD}${selS.netDelta.toLocaleString()} Δ (${selS.absorbPct}% Absorb)`;
      }
    }

    // 7. Second Command Oscillation Line Chart (EVR & Effort vs Result Friction Harmonic)
    const evrChartTitle = document.getElementById('tvNexusEvrChartTitle');
    if (evrChartTitle) evrChartTitle.style.color = themeSoft;

    const evrMetaEl = document.getElementById('tvNexusEvrOscMeta');
    if (evrMetaEl) {
      const evrTag = scopeIsBear ? 'EXTREME BURN 🔥' : 'CLEAN EXPANSION ⚡';
      const evrSign = d.deltaEvr >= 0 ? '+' : '';
      evrMetaEl.innerHTML = `EFFORT: <strong style="color: ${themeColor};">${evrTag}</strong> • SHIFT: <strong style="color: #facc15;">${evrSign}${d.deltaEvr}%</strong>`;
    }

    const evrLegend = document.getElementById('tvNexusEvrOscLegend');
    if (evrLegend && d.samples) {
      let evrLegHtml = '';
      d.samples.forEach((s, idx) => {
        const pal = BOX_PALETTE[idx % BOX_PALETTE.length];
        const isSel = isSingleBoxMode && selectedBoxIdx === idx;
        const op = isSingleBoxMode ? (isSel ? '1' : '0.35') : '1';
        evrLegHtml += `
          <span style="display: flex; align-items: center; gap: 3px; color: ${pal.stroke}; opacity: ${op}; cursor: pointer; transition: opacity 0.2s;" onclick="window.__selectNexusTab('box_${idx}')" title="Click to isolate Box ${s.boxNum}">
            <span style="width: 7px; height: 2px; background: ${pal.stroke}; display: inline-block;"></span> B${s.boxNum}
          </span>
        `;
      });
      evrLegend.innerHTML = evrLegHtml;
    }

    const evrLineBox1 = document.getElementById('tvNexusEvrLineBox1');
    const evrLineBox2 = document.getElementById('tvNexusEvrLineBox2');
    const evrLineBox3 = document.getElementById('tvNexusEvrLineBox3');
    const evrShadedArea = document.getElementById('tvNexusEvrShadedArea');
    const evrAreaNote = document.getElementById('tvNexusEvrAreaNote');
    const evrCalloutMud = document.getElementById('tvNexusEvrCalloutMud');
    const evrCalloutShift = document.getElementById('tvNexusEvrCalloutShift');
    const evrCalloutRunway = document.getElementById('tvNexusEvrCalloutRunway');
    const evrSvg = document.getElementById('tvNexusEvrOscSvg');
    const evrLinesGroup = document.getElementById('tvNexusEvrLinesGroup');

    // Dynamic gradient for EVR area
    const gradEvr = document.getElementById('tvNexusEvrGrad');
    if (gradEvr) {
      gradEvr.innerHTML = `
        <stop offset="0%" stop-color="${linePalette.grad0}" stop-opacity="${linePalette.grad0Op}" />
        <stop offset="50%" stop-color="${linePalette.grad1}" stop-opacity="${linePalette.grad1Op}" />
        <stop offset="100%" stop-color="${linePalette.grad2}" stop-opacity="${linePalette.grad2Op}" />
      `;
    }

    // Dynamic N-Box EVR Curves
    let highestEvrY = 20;
    let lowestEvrY = 90;

    d.samples.forEach((s, idx) => {
      const pal = BOX_PALETTE[idx % BOX_PALETTE.length];
      const isSelected = isSingleBoxMode && selectedBoxIdx === idx;

      // EVR calculation: lower EVR = frictionless runway (top Y~20), high EVR = thick friction wall (bottom Y~90)
      const evrVal = s.evr || 2000;
      const normEvr = Math.min(1, Math.max(0, (evrVal - 1000) / 2800));
      const targetY = Math.round(20 + normEvr * 70);

      const prevEvr = idx > 0 ? (d.samples[idx - 1].evr || evrVal) : evrVal;
      const prevNorm = Math.min(1, Math.max(0, (prevEvr - 1000) / 2800));
      const startY = Math.round(20 + prevNorm * 70);
      const midY = Math.round((startY + targetY) / 2);

      if (targetY < lowestEvrY) lowestEvrY = targetY;
      if (targetY > highestEvrY) highestEvrY = targetY;

      const pathD = `M 25 ${startY} C 140 ${midY}, 320 ${targetY}, 515 ${targetY}`;

      // Get or create EVR path element
      let lineEl = null;
      if (idx === 0) lineEl = evrLineBox1;
      else if (idx === 1) lineEl = evrLineBox2;
      else if (idx === 2) lineEl = evrLineBox3;
      else {
        lineEl = document.getElementById(`tvNexusEvrLineBox${idx + 1}`);
        if (!lineEl && evrLinesGroup) {
          lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          lineEl.setAttribute('id', `tvNexusEvrLineBox${idx + 1}`);
          lineEl.setAttribute('fill', 'none');
          lineEl.setAttribute('stroke-linecap', 'round');
          lineEl.setAttribute('class', 'tv-nexus-path-smooth');
          evrLinesGroup.appendChild(lineEl);
        }
      }

      if (lineEl) {
        lineEl.setAttribute('d', pathD);
        lineEl.setAttribute('stroke', pal.stroke);
        lineEl.setAttribute('stroke-width', isSelected ? '3.2' : (isSingleBoxMode ? '1.8' : (idx === sampleCount - 1 ? '2.8' : '2.3')));
        lineEl.style.opacity = (isSingleBoxMode && !isSelected) ? '0.15' : '1';
        lineEl.style.display = 'block';
        if (isSelected || (idx === sampleCount - 1 && !isSingleBoxMode)) {
          lineEl.style.filter = `drop-shadow(0 0 6px ${pal.glow})`;
        } else {
          lineEl.style.filter = 'none';
        }
      }

      // Dynamic EVR Callout Chip for each box
      let calloutEl = null;
      if (idx === 0) calloutEl = evrCalloutMud;
      else if (idx === 1) calloutEl = evrCalloutShift;
      else if (idx === 2) calloutEl = evrCalloutRunway;
      else {
        calloutEl = document.getElementById(`tvNexusEvrCalloutBox${idx + 1}`);
        if (!calloutEl && evrSvg) {
          calloutEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          calloutEl.setAttribute('id', `tvNexusEvrCalloutBox${idx + 1}`);
          calloutEl.setAttribute('style', 'cursor: pointer;');
          calloutEl.innerHTML = `<rect x="-4" y="-10" width="135" height="16" rx="3" fill="#091020" stroke-width="1.2" opacity="0.95"/><text x="0" y="2" font-size="8.5" font-family="monospace" font-weight="bold"></text>`;
          calloutEl.onclick = () => window.__selectNexusTab(`box_${idx}`);
          evrSvg.appendChild(calloutEl);
        }
      }

      if (calloutEl) {
        const xPos = Math.round(30 + (idx / Math.max(1, sampleCount - 1)) * 360);
        const yPos = targetY < 55 ? Math.round(targetY + 22) : Math.round(targetY - 14);
        calloutEl.setAttribute('transform', `translate(${xPos}, ${yPos})`);

        const rect = calloutEl.querySelector('rect');
        if (rect) {
          rect.setAttribute('stroke', pal.stroke);
          rect.setAttribute('fill', '#091020');
        }
        const text = calloutEl.querySelector('text');
        if (text) {
          text.setAttribute('fill', pal.text);
          if (idx === 0) {
            const b1Term = (s.d === 1 || s.metrics?.yieldAnalysis?.domSide === 'BULL') ? 'BULL BASE' : 'BEAR BASE';
            text.textContent = `🔥 B1: ${s.evr.toLocaleString()} V/PT (${b1Term})`;
          } else {
            const prevBoxEvr = d.samples[idx - 1].evr || s.evr;
            const shiftVal = Math.round(((s.evr - prevBoxEvr) / Math.max(1, prevBoxEvr)) * 100);
            const shiftSign = shiftVal >= 0 ? '+' : '';
            let term = s.evr < 1400 ? 'VACUUM' : (s.evr > 2400 ? 'ABSORB' : 'FLOW');
            if (idx === sampleCount - 1) {
              term = (s.d === 1 || s.metrics?.yieldAnalysis?.domSide === 'BULL') ? 'BULL RUNWAY' : 'BEAR RUNWAY';
            }
            text.textContent = `⚡ B${s.boxNum}: ${s.evr.toLocaleString()} V/PT (${shiftSign}${shiftVal}%)`;
          }
        }
        calloutEl.style.display = (isSingleBoxMode && !isSelected) ? 'none' : 'block';
      }
    });

    // Hide any unused surplus EVR paths if boxes were deleted
    for (let extra = sampleCount + 1; extra <= 12; extra++) {
      const surplusLine = document.getElementById(`tvNexusEvrLineBox${extra}`);
      if (surplusLine) surplusLine.style.display = 'none';
      const surplusCallout = document.getElementById(`tvNexusEvrCalloutBox${extra}`);
      if (surplusCallout) surplusCallout.style.display = 'none';
    }

    // Dynamic EVR Envelope Shaded Area
    if (evrShadedArea) {
      evrShadedArea.style.opacity = isSingleBoxMode ? '0.35' : '0.80';
      evrShadedArea.setAttribute('d', `M 25 60 C 140 ${lowestEvrY}, 320 ${lowestEvrY}, 515 ${lowestEvrY} L 515 ${highestEvrY} C 320 ${highestEvrY}, 140 ${highestEvrY}, 25 60 Z`);
    }

    // EVR Area Note (Footer subline)
    if (!isSingleBoxMode) {
      if (evrAreaNote) {
        evrAreaNote.style.color = themeSoft;
        const evrParts = d.samples.map(s => {
          let tag = s.evr < 1400 ? 'VACUUM' : (s.evr > 2400 ? 'ABSORB' : 'FLOW');
          return `B${s.boxNum} ${s.evr.toLocaleString()} v/pt (${tag})`;
        });
        evrAreaNote.textContent = 'EFFORT SHIFT: ' + evrParts.join(' → ');
      }
    } else {
      const selS = d.samples[selectedBoxIdx];
      const selPal = BOX_PALETTE[selectedBoxIdx % BOX_PALETTE.length];
      if (selS && evrAreaNote) {
        let tag = selS.evr < 1400 ? 'VACUUM RUNWAY EXPANSION' : (selS.evr > 2400 ? 'HEAVY FRICTION WALL' : 'NORMAL AUCTION FLOW');
        const prevEvr = selectedBoxIdx > 0 ? d.samples[selectedBoxIdx - 1].evr : selS.evr;
        const shift = Math.round(((selS.evr - prevEvr) / Math.max(1, prevEvr)) * 100);
        const sSign = shift >= 0 ? '+' : '';
        evrAreaNote.style.color = selPal.stroke;
        evrAreaNote.textContent = `BOX ${selS.boxNum} EFFORT: ${selS.evr.toLocaleString()} V/PT // ${tag} (${sSign}${shift}% FRICTION)`;
      }
    }

    // Update Matrix Table if currently maximized
    if (window.__renderNexusMaxTable) {
      window.__renderNexusMaxTable();
    }

    // 8. Footer Reference Levels
    const footCeiling = document.getElementById('tvNexusFootCeiling');
    const footMid = document.getElementById('tvNexusFootMid');
    const footVwap = document.getElementById('tvNexusFootVwap');
    const footPoc = document.getElementById('tvNexusFootPoc');
    const footFloor = document.getElementById('tvNexusFootFloor');
    if (footCeiling) {
      footCeiling.textContent = `$${d.maxHigh.toFixed(2)}`;
      footCeiling.style.color = '#ef4444'; // Ceiling resistance is always red
    }
    if (footMid) {
      footMid.textContent = `$${d.eqShelf.toFixed(2)}`;
      footMid.style.color = '#facc15'; // Mid eq shelf is yellow
    }
    if (footVwap) {
      footVwap.textContent = `$${d.networkVwap.toFixed(2)}`;
      footVwap.style.color = '#818cf8'; // Network VWAP is indigo
    }
    if (footPoc) {
      footPoc.textContent = `$${d.primaryAnchor.toFixed(2)}`;
      footPoc.style.color = '#00e5ff'; // Primary POC anchor is cyan
    }
    if (footFloor) {
      footFloor.textContent = `$${d.minLow.toFixed(2)}`;
      footFloor.style.color = '#10b981'; // Support floor is green
    }
  };

  // Multi-Box Comparative Findings Matrix Table Generator
  window.__renderNexusMaxTable = function() {
    const maxTable = document.getElementById('tvNexusMaxTable');
    if (!maxTable || maxTable.style.display === 'none') return;

    let overallTag = scopeIsBear ? 'BEAR ADVANCE & VACUUM EXPANSION' : 'BULL ADVANCE & VACUUM EXPANSION';
    if (d.netDelta > 0 && scopeIsBear) overallTag = 'ABSORPTION DEFENSE (BEAR MOVE ON BULL DELTA)';
    else if (d.netDelta < 0 && !scopeIsBear) overallTag = 'ABSORPTION DEFENSE (BULL MOVE ON BEAR DELTA)';

    let rowsHtml = '';
    d.samples.forEach((s, idx) => {
      const pal = BOX_PALETTE[idx % BOX_PALETTE.length];
      const signD = s.netDelta >= 0 ? '+' : '';
      const dispP = s.netMove >= 0 ? '+' : '';
      const moveColor = s.netMove >= 0 ? '#10b981' : '#f43f5e';
      const deltaColor = s.netDelta >= 0 ? '#10b981' : '#f43f5e';
      const deltaK = (s.netDelta / 1000).toFixed(1);

      const y = s.metrics?.yieldAnalysis;
      let finding = s.d === 1 ? 'BULL ADVANCE' : 'BEAR ADVANCE';
      let badgeStyle = 'background: rgba(16,185,129,0.15); border: 1px solid #10b981; color: #34d399;';
      if (s.d === -1) {
        badgeStyle = 'background: rgba(244,63,94,0.15); border: 1px solid #f43f5e; color: #fda4af;';
      }

      if (y?.isTrap) {
        finding = y.trapType === 'CEILING_TRAP' ? 'CEILING TRAP (ABSORPTION)' : 'FLOOR TRAP (ABSORPTION)';
        badgeStyle = 'background: rgba(245,158,11,0.15); border: 1px solid #f59e0b; color: #facc15;';
      } else if (y?.isExhaustion) {
        finding = y.exhaustionType === 'NO_DEMAND' ? 'NO DEMAND (EXHAUSTION)' : 'NO SUPPLY (EXHAUSTION)';
        badgeStyle = 'background: rgba(148,163,184,0.15); border: 1px solid #64748b; color: #cbd5e1;';
      } else if (s.evr < 1400) {
        finding = s.d === 1 ? 'OPEN BULL RUNWAY (VACUUM)' : 'OPEN BEAR RUNWAY (VACUUM)';
        badgeStyle = 'background: rgba(0,229,255,0.15); border: 1px solid #00e5ff; color: #00e5ff; font-weight: 800;';
      } else if (s.evr > 2400) {
        finding = 'HEAVY FRICTION WALL (ABSORPTION)';
        badgeStyle = 'background: rgba(220,38,38,0.15); border: 1px solid #dc2626; color: #fca5a5;';
      }

      const prevEvr = idx > 0 ? d.samples[idx - 1].evr : s.evr;
      const shiftVal = Math.round(((s.evr - prevEvr) / Math.max(1, prevEvr)) * 100);
      const shiftSign = shiftVal >= 0 ? '+' : '';
      const shiftColor = shiftVal < -15 ? '#00e5ff' : (shiftVal > 20 ? '#f43f5e' : '#94a3b8');

      rowsHtml += `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: background 0.15s;" onclick="window.__selectNexusTab('box_${idx}')" onmouseover="this.style.background='rgba(255,255,255,0.04)'" onmouseout="this.style.background='transparent'">
          <td style="padding: 6px 8px; font-weight: 800; color: ${pal.stroke}; display: flex; align-items: center; gap: 6px;">
            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${pal.stroke}; box-shadow: 0 0 6px ${pal.glow};"></span>
            BOX #${s.boxNum}
          </td>
          <td style="padding: 6px 8px;">
            <span style="color: ${moveColor}; font-weight: 700;">${dispP}${s.netMove.toFixed(1)} pt</span>
            <span style="color: #64748b; font-size: 9px; margin-left: 4px;">(Max: ${s.favMove.toFixed(1)})</span>
          </td>
          <td style="padding: 6px 8px; color: #cbd5e1;">${s.totalVol.toLocaleString()}</td>
          <td style="padding: 6px 8px; color: ${deltaColor}; font-weight: 700;">${signD}${deltaK}K Δ <span style="font-size: 9px; color: #64748b;">(${signD}${s.netDeltaPct}%)</span></td>
          <td style="padding: 6px 8px;">
            <span style="color: #ffffff; font-weight: 700;">${s.evr.toLocaleString()}</span>
            <span style="color: ${shiftColor}; font-size: 9px; margin-left: 4px;">(${idx === 0 ? 'BASE' : shiftSign + shiftVal + '%'})</span>
          </td>
          <td style="padding: 6px 8px; color: ${s.absorbPct > 60 ? '#facc15' : '#94a3b8'};">${s.absorbPct}%</td>
          <td style="padding: 6px 8px; color: #818cf8;">${s.metrics?.yieldAnalysis?.yieldRatio ? s.metrics.yieldAnalysis.yieldRatio.toFixed(2) : '1.00'}x</td>
          <td style="padding: 6px 8px;">
            <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 9.5px; ${badgeStyle}">
              ${finding}
            </span>
          </td>
        </tr>
      `;
    });

    maxTable.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <span style="font-size: 11px; font-weight: 900; color: #00f5d4; letter-spacing: 0.5px;">
          📊 MULTI-BOX COMPARATIVE FINDINGS MATRIX (${sampleCount} BOXES ANALYZED)
        </span>
        <span style="font-size: 10px; font-family: monospace; color: #94a3b8;">
          PANORAMIC SYNTHESIS: <strong style="color: ${themeColor};">${overallTag}</strong>
        </span>
      </div>
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse; font-family: monospace; font-size: 10.5px; text-align: left;">
          <thead>
            <tr style="border-bottom: 1px solid #1e293b; color: #64748b; font-size: 9px; text-transform: uppercase;">
              <th style="padding: 5px 8px;">BOX #</th>
              <th style="padding: 5px 8px;">PRICE MOVE</th>
              <th style="padding: 5px 8px;">TOTAL VOL</th>
              <th style="padding: 5px 8px;">NET DELTA</th>
              <th style="padding: 5px 8px;">EVR (FRICTION)</th>
              <th style="padding: 5px 8px;">ABSORB %</th>
              <th style="padding: 5px 8px;">YIELD RATIO</th>
              <th style="padding: 5px 8px;">AUTHENTIC STRUCTURAL FINDING</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `;
  };

  // Wire Maximize / Restore Toggle
  window.__toggleNexusMaximized = function() {
    const frame = modal.querySelector('.tv-nexus-chamfer-frame');
    if (!frame) return;
    const isMax = frame.classList.toggle('tv-nexus-maximized');
    const toggleBtn = document.getElementById('tvNexusStudioToggleBtn');
    if (toggleBtn) {
      toggleBtn.innerHTML = isMax ? '<span>🗗 RESTORE STUDIO</span>' : '<span>⛶ MAXIMIZE STUDIO</span>';
      toggleBtn.title = isMax ? 'Restore Standard Dimensions' : 'Maximize Chart Studio & Findings Matrix';
    }

    const maxTable = document.getElementById('tvNexusMaxTable');
    if (maxTable) {
      maxTable.style.display = isMax ? 'block' : 'none';
      if (isMax && window.__renderNexusMaxTable) {
        window.__renderNexusMaxTable();
      }
    }
  };

  // Wire Chart Lines Toggle Button
  const toggleLinesBtn = document.getElementById('tvToggleInflectionLinesBtn');
  if (toggleLinesBtn) {
    toggleLinesBtn.onclick = function(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      toggleStructuralInflectionLines(c);
    };
  }
  updateInflectionLinesButtonUI();

  // Wire Close Buttons & Escape key
  const closeBtn = document.getElementById('tvCloseNetworkModalBtn');
  const closeBtnDone = document.getElementById('tvCloseNetworkModalBtnDone');
  if (closeBtn) closeBtn.onclick = () => { modal.style.display = 'none'; };
  if (closeBtnDone) closeBtnDone.onclick = () => { modal.style.display = 'none'; };

  const handleKeydown = (e) => {
    if (e.key === 'Escape') {
      const frame = modal.querySelector('.tv-nexus-chamfer-frame');
      if (frame && frame.classList.contains('tv-nexus-maximized')) {
        window.__toggleNexusMaximized();
      } else {
        modal.style.display = 'none';
      }
    }
  };
  window.addEventListener('keydown', handleKeydown);

  // Render initial Network tab on open
  window.__selectNexusTab('network');

  modal.style.display = 'flex';
}

window.__openExtensionNetworkModal = openExtensionNetworkModal;

/**
 * Synchronizes structural inflection reference lines directly onto the chart canvas.
 * Lines are plotted using the 'structuralLevel' overlay:
 * - Ceiling Resistance (#ef4444 Crimson Red, dashed)
 * - 50% Mid-Equilibrium (#fbbf24 Warm Yellow, dashed)
 * - Peak Volume Anchor (#00e5ff Cyan, solid)
 * - Support Floor (#10b981 Emerald Green, dashed)
 */
export function syncStructuralInflectionLines(chart) {
  const c = chart || chartInstance || (typeof window !== 'undefined' && window.__chartInstance);
  if (!c || typeof c.getOverlays !== 'function') return;

  if (typeof window !== 'undefined') {
    window.__inflectionLinesState = window.__inflectionLinesState || {
      ceiling: false,
      mid: false,
      vwap: false,
      anchor: false,
      floor: false
    };
  }
  const state = (typeof window !== 'undefined' && window.__inflectionLinesState) ? window.__inflectionLinesState : {
    ceiling: false,
    mid: false,
    vwap: false,
    anchor: false,
    floor: false
  };
  const isAnyActive = Object.values(state).some(Boolean);

  if (!isAnyActive) {
    for (const lvl of INFLECTION_LEVEL_KEYS) {
      try { c.removeOverlay({ id: lvl.id }); } catch (_) {}
    }
    return;
  }

  const dataList = c.getDataList?.() || [];
  const dossier = computeNetworkDossier(null, dataList);
  if (!dossier) {
    for (const lvl of INFLECTION_LEVEL_KEYS) {
      try { c.removeOverlay({ id: lvl.id }); } catch (_) {}
    }
    return;
  }

  const existingOverlays = c.getOverlays() || [];

  const shortNames = {
    ceiling: 'CEILING',
    mid: '50% EQ',
    vwap: 'NET VWAP',
    anchor: 'ANCHOR',
    floor: 'FLOOR'
  };

  const lastBar = dataList.length > 0 ? dataList[dataList.length - 1] : null;
  const lastTs = lastBar?.timestamp || Date.now();

  for (const lvl of INFLECTION_LEVEL_KEYS) {
    const isActive = !!state[lvl.key];
    const price = dossier[lvl.prop];

    if (!isActive || price === undefined || price === null || isNaN(price)) {
      try { c.removeOverlay({ id: lvl.id }); } catch (_) {}
      continue;
    }

    const options = {
      id: lvl.id,
      name: 'structuralLevel',
      points: [{ timestamp: lastTs, value: price }],
      lock: true,
      extendData: {
        key: lvl.id,
        title: lvl.title,
        yLabel: `${shortNames[lvl.key] || 'LEVEL'} $${price.toFixed(2)}`,
        color: lvl.color,
        lineStyle: lvl.lineStyle,
        lineSize: lvl.lineSize,
        opacity: lvl.opacity
      }
    };

    const exists = existingOverlays.some(o => o.id === lvl.id);
    if (exists) {
      try {
        c.overrideOverlay(options);
      } catch (_) {
        try { c.removeOverlay({ id: lvl.id }); } catch (e) {}
        try { c.createOverlay(options); } catch (e) {}
      }
    } else {
      try {
        c.createOverlay(options);
      } catch (err) {
        console.warn(`[syncStructuralInflectionLines] Error creating ${lvl.id}:`, err);
      }
    }
  }
}
window.__syncStructuralInflectionLines = syncStructuralInflectionLines;

/**
 * Updates UI state of Card 3 master toggle button and individual depth ladder nodes.
 */
export function updateInflectionLinesButtonUI() {
  const btn = document.getElementById('tvToggleInflectionLinesBtn');
  const btnText = document.getElementById('tvToggleInflectionLinesBtnText');
  if (typeof window !== 'undefined') {
    window.__inflectionLinesState = window.__inflectionLinesState || {
      ceiling: false,
      mid: false,
      vwap: false,
      anchor: false,
      floor: false
    };
  }
  const state = (typeof window !== 'undefined' && window.__inflectionLinesState) ? window.__inflectionLinesState : {
    ceiling: false,
    mid: false,
    vwap: false,
    anchor: false,
    floor: false
  };
  const anyActive = Object.values(state).some(Boolean);

  if (btn) {
    if (anyActive) {
      btn.classList.add('active');
      btn.style.background = 'rgba(239, 68, 68, 0.16)';
      btn.style.border = '1px solid #ef4444';
      btn.style.color = '#ef4444';
    } else {
      btn.classList.remove('active');
      btn.style.background = 'rgba(0, 245, 212, 0.12)';
      btn.style.border = '1px solid #00f5d4';
      btn.style.color = '#00f5d4';
    }
  }

  if (btnText) {
    btnText.textContent = anyActive ? 'HIDE LINES ON CHART' : 'SHOW LINES ON CHART';
  }

  // Update individual depth ladder rows in the modal if currently open
  const nodes = document.querySelectorAll('.tv-ladder-node[data-level-key]');
  nodes.forEach(el => {
    const k = el.getAttribute('data-level-key');
    const isAct = !!state[k];
    if (isAct) {
      el.classList.add('line-active');
    } else {
      el.classList.remove('line-active');
    }
    const eye = el.querySelector('.tv-node-eye-pill');
    if (eye) {
      eye.textContent = isAct ? '👁️' : '👁️‍🗨️';
      eye.title = isAct ? 'Line plotted on chart (click to hide)' : 'Line hidden (click to plot on chart)';
    }
  });
}
window.__updateInflectionLinesButtonUI = updateInflectionLinesButtonUI;

let lastToggleTime = 0;

/**
 * Toggles all 4 structural inflection reference lines simultaneously.
 */
export function toggleStructuralInflectionLines(chart, forceState = null) {
  const now = Date.now();
  if (forceState === null && (now - lastToggleTime) < 150) {
    return;
  }
  lastToggleTime = now;

  const c = chart || chartInstance || (typeof window !== 'undefined' && window.__chartInstance);
  if (typeof window !== 'undefined') {
    window.__inflectionLinesState = window.__inflectionLinesState || {
      ceiling: false,
      mid: false,
      vwap: false,
      anchor: false,
      floor: false
    };
  }
  const state = (typeof window !== 'undefined' && window.__inflectionLinesState) ? window.__inflectionLinesState : {
    ceiling: false,
    mid: false,
    vwap: false,
    anchor: false,
    floor: false
  };
  const anyActive = Object.values(state).some(Boolean);

  const targetState = (forceState !== null) ? forceState : !anyActive;
  state.ceiling = targetState;
  state.mid = targetState;
  state.vwap = targetState;
  state.anchor = targetState;
  state.floor = targetState;

  syncStructuralInflectionLines(c);
  updateInflectionLinesButtonUI();

  if (typeof showChartToast === 'function') {
    showChartToast(targetState ? '👁️ Reference Lines Plotted on Chart' : '👁️ Reference Lines Hidden');
  }
}
window.__toggleStructuralInflectionLines = toggleStructuralInflectionLines;

/**
 * Toggles a single inflection reference line on/off.
 */
export function toggleSingleInflectionLine(key, chart) {
  const c = chart || chartInstance || (typeof window !== 'undefined' && window.__chartInstance);
  if (typeof window !== 'undefined') {
    window.__inflectionLinesState = window.__inflectionLinesState || {
      ceiling: false,
      mid: false,
      vwap: false,
      anchor: false,
      floor: false
    };
  }
  const state = (typeof window !== 'undefined' && window.__inflectionLinesState) ? window.__inflectionLinesState : {
    ceiling: false,
    mid: false,
    vwap: false,
    anchor: false,
    floor: false
  };
  if (!state || !(key in state)) return;

  state[key] = !state[key];
  syncStructuralInflectionLines(c);
  updateInflectionLinesButtonUI();

  const labels = {
    ceiling: 'Ceiling Resistance',
    mid: '50% Mid-Equilibrium',
    vwap: 'Multi-Box Network VWAP',
    anchor: 'Peak Volume Anchor',
    floor: 'Support Floor'
  };

  if (typeof showChartToast === 'function') {
    const name = labels[key] || key;
    showChartToast(state[key] ? `👁️ Plotted ${name} on chart` : `👁️ Hidden ${name}`);
  }
}
window.__toggleSingleInflectionLine = toggleSingleInflectionLine;

export function startCandleCountdown(timeframeMinutes = 5) {
  const el = document.getElementById('tvCountdownTimer');
  if (!el) return;

  function tick() {
    const nowSec = Math.floor(Date.now() / 1000);
    const tfSec = timeframeMinutes * 60;
    const remSec = tfSec - (nowSec % tfSec);

    const m = Math.floor(remSec / 60).toString().padStart(2, '0');
    const s = (remSec % 60).toString().padStart(2, '0');
    el.textContent = `${m}:${s}`;
  }

  tick();
  clearInterval(window.__countdownTimerInterval);
  window.__countdownTimerInterval = setInterval(tick, 1000);
}
