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

// State tracking for Structural Inflection Reference Lines plotted on the chart canvas
if (typeof window !== 'undefined') {
  window.__inflectionLinesState = window.__inflectionLinesState || {
    ceiling: false,
    mid: false,
    anchor: false,
    floor: false
  };
}

export const INFLECTION_LEVEL_KEYS = [
  { key: 'ceiling', id: 'lvl_node_ceiling', prop: 'maxHigh', title: 'CEILING RESISTANCE', color: '#ef4444', lineStyle: 'dashed', lineSize: 1.5, opacity: 0.85 },
  { key: 'mid', id: 'lvl_node_mid', prop: 'eqShelf', title: '50% MID-EQUILIBRIUM', color: '#fbbf24', lineStyle: 'dashed', lineSize: 1.5, opacity: 0.85 },
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
    barsInBox.push({ bar, index: i });

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
    const volInBox = vol * (overlapRatio > 0 ? overlapRatio : 1.0);

    totalVol += volInBox;
    candleCount++;

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

  return {
    boxNum,
    topPrice,
    bottomPrice,
    priceRange,
    H_b,
    L_b,
    R_b,
    P_0,
    P_1,
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

  let pillsHtml = '';
  let lastFav = 0;
  sortedRects.forEach((item, idx) => {
    const fav = item.metrics ? item.metrics.favMove : 0;
    lastFav = fav;
    const isCurrent = (idx === sortedRects.length - 1);
    const label = isCurrent ? `Current: +${fav.toFixed(1)}` : `+${fav.toFixed(1)}`;
    const cls = isCurrent ? 'tv-ext-pill active' : 'tv-ext-pill';
    pillsHtml += `<span class="${cls}">[${label}]</span>`;
    pillsHtml += `<span class="tv-ext-arrow">→</span>`;
  });

  // Calculate projected Next Target: round up to nearest structural 50/100 or 1.5x
  let nextTarget = 200;
  if (lastFav > 0) {
    if (lastFav < 50) nextTarget = 50;
    else if (lastFav < 100) nextTarget = 100;
    else if (lastFav < 150) nextTarget = 150;
    else if (lastFav < 200) nextTarget = 200;
    else nextTarget = Math.ceil((lastFav + 25) / 50) * 50;
  }
  pillsHtml += `<span class="tv-ext-pill target">[Next: ${nextTarget} (Watch Zone)]</span>`;
  pillsHtml += `<span class="tv-ext-pill dossier-btn" id="tvTriggerDossierPill" title="Open Structural Sample Network Dossier">🌐 Deep Dossier ↗</span>`;

  trackEl.innerHTML = pillsHtml;
  ribbonEl.style.display = 'flex';

  if (typeof syncStructuralInflectionLines === 'function') {
    syncStructuralInflectionLines(c);
  }
}
window.__updateExtensionSeriesRibbon = updateExtensionSeriesRibbon;

/**
 * Computes deep multi-sample empirical network dossier across all connected rectangles.
 * Audits:
 * 1. Who is playing out (Aggressor vs. Passive Absorption, Cumulative Delta divergence)
 * 2. Effort vs. Result (Fuel Burn Engine: EVR = V / R, friction shift)
 * 3. Strongest Structural Inflection Nodes (Anchors, Peak Volume Shelves, Mid-Structure Eq)
 * 4. Structural Runway & Liquidity Vacuum (Distance to historical ceilings/floors, Invalidation Tripwires)
 */
export function computeNetworkDossier(customRects = null, customDataList = null) {
  const c = chartInstance;
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
  }).filter(s => s.metrics && s.metrics.totalVol > 0).sort((a, b) => a.t0 - b.t0);

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
      frictionCls
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
  const lastBar = dataList.length > 0 ? dataList[dataList.length - 1] : null;
  const livePrice = lastBar ? lastBar.close : lastSample.P_1;

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

  // Strongest Structural Inflection Nodes
  const primaryAnchor = highestVolSample ? highestVolSample.metrics.P_0 : (maxHigh + minLow) / 2;
  const eqShelf = (maxHigh + minLow) / 2;

  // Runway & Vacuum
  const distCeiling = Math.max(0, maxHigh - livePrice);
  const distFloor = Math.max(0, livePrice - minLow);
  const distEq = Math.abs(livePrice - eqShelf);
  const distAnchor = Math.abs(livePrice - primaryAnchor);
  const invalidationTripwire = lastSample.d === 1 ? minLow : maxHigh;

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
    highestVolSample,
    highestEvrSample,
    eqShelf,
    distCeiling,
    distFloor,
    distEq,
    distAnchor,
    pricePinPct,
    upperRunwayPct,
    lowerRunwayPct,
    maxEvr,
    maxFav,
    invalidationTripwire
  };
}
window.__computeNetworkDossier = computeNetworkDossier;

export function openExtensionNetworkModal(chart) {
  const modal = document.getElementById('tvExtensionNetworkModal');
  if (!modal) return;

  const c = chart || chartInstance;
  const dossier = computeNetworkDossier(null, c?.getDataList?.());
  const symbol = dossier?.symbol || window.__currentSymbol || 'XAUUSD';

  const subtitleEl = document.getElementById('tvNetworkModalSubtitle');
  if (subtitleEl) {
    subtitleEl.textContent = `EMPIRICAL MULTI-BOX ORDER-FLOW & STRUCTURAL FRICTION AUDIT — ${symbol}`;
  }

  const badgeEl = document.getElementById('tvNetworkSampleCountBadge');
  const trackEl = document.getElementById('tvNetworkTimelineTrack');
  const whoContent = document.getElementById('tvAuditWhoPlaying');
  const whoBadge = document.getElementById('tvAuditWhoBadge');
  const fuelContent = document.getElementById('tvAuditFuelBurn');
  const fuelBadge = document.getElementById('tvAuditFuelBadge');
  const nodesContent = document.getElementById('tvAuditStructuralNodes');
  const nodesBadge = document.getElementById('tvAuditNodesBadge');
  const runwayContent = document.getElementById('tvAuditRunwayVacuum');
  const runwayBadge = document.getElementById('tvAuditRunwayBadge');

  if (!dossier || dossier.sampleCount === 0) {
    if (badgeEl) badgeEl.textContent = '0 SAMPLES';
    if (trackEl) {
      trackEl.innerHTML = `
        <div style="padding: 16px; color: #94a3b8; font-size: 12px; text-align: center; width: 100%;">
          No rectangle sample boxes detected on chart canvas. Draw 1 or more boxes (Shortcut 'R') to audit structural order-flow.
        </div>
      `;
    }
    if (whoContent) whoContent.innerHTML = `<div style="color: #94a3b8;">Draw sample boxes to audit aggressor vs. passive absorption.</div>`;
    if (fuelContent) fuelContent.innerHTML = `<div style="color: #94a3b8;">Draw sample boxes to measure fuel burn and friction shift.</div>`;
    if (nodesContent) nodesContent.innerHTML = `<div style="color: #94a3b8;">Draw sample boxes to identify structural anchors and shelves.</div>`;
    if (runwayContent) runwayContent.innerHTML = `<div style="color: #94a3b8;">Draw sample boxes to calculate manual trade runway.</div>`;
    modal.style.display = 'flex';
    return;
  }

  // Update sample count badge
  if (badgeEl) badgeEl.textContent = `${dossier.sampleCount} SAMPLE${dossier.sampleCount > 1 ? 'S' : ''} CONNECTED`;

  // Render Connected Sample Timeline Cards with Mini Bars & Fuel Gauges
  if (trackEl) {
    let cardsHtml = '';
    dossier.samples.forEach((s, idx) => {
      const isLast = (idx === dossier.samples.length - 1);
      const activeCls = isLast ? 'active' : '';
      const dirCls = s.d === 1 ? 'bull' : 'bear';
      const dirIcon = s.d === 1 ? '↗ UP' : '↘ DOWN';
      const deltaCls = s.netDelta > 0 ? 'bull' : (s.netDelta < 0 ? 'bear' : '');
      const deltaSign = s.netDelta > 0 ? '+' : '';
      const excursionBarPct = Math.max(8, Math.min(100, Math.round((s.favMove / dossier.maxFav) * 100)));

      cardsHtml += `
        <div class="tv-network-sample-card ${activeCls}">
          <div class="tv-network-sample-header">
            <span class="tv-network-sample-title">SAMPLE #${s.boxNum}${isLast ? ' • LATEST' : ''}</span>
            <span class="tv-network-sample-dir ${dirCls}">${dirIcon} +${s.favMove.toFixed(1)}</span>
          </div>

          <!-- Mini Excursion Bar -->
          <div class="tv-visual-bar-wrap" title="Excursion Progress: +${s.favMove.toFixed(1)} pts">
            <div class="tv-visual-bar-fill ${dirCls}" style="width: ${excursionBarPct}%;"></div>
          </div>

          <!-- Mini Tug-of-War Split Bar -->
          <div class="tv-mini-split-bar" title="Buy: ${s.bullPct}% | Sell: ${s.bearPct}%">
            <div class="tv-split-bull" style="width: ${s.bullPct}%;"></div>
            <div class="tv-split-bear" style="width: ${s.bearPct}%;"></div>
          </div>

          <div class="tv-network-stat-row">
            <span class="tv-network-stat-label">Volume & Δ</span>
            <span class="tv-network-stat-val ${deltaCls}">${formatVolNumber(s.totalVol)} | ${deltaSign}${formatVolNumber(s.netDelta)}</span>
          </div>

          <div class="tv-network-stat-row">
            <span class="tv-network-stat-label">Fuel Burn</span>
            <span class="tv-fuel-badge ${s.frictionCls}">${s.evr.toLocaleString()} v/pt</span>
          </div>

          <!-- Absorption Shield Mini Bar -->
          <div class="tv-absorb-bar-wrap" title="Absorption Shield: ${s.absorbPct}%">
            <div class="tv-absorb-bar-label">
              <span>Absorption Shield</span>
              <span class="${s.absorbPct >= 65 ? 'bear' : 'highlight'}">${s.absorbPct}%</span>
            </div>
            <div class="tv-absorb-bar-track">
              <div class="tv-absorb-bar-fill ${s.absorbPct >= 65 ? 'high' : 'normal'}" style="width: ${s.absorbPct}%;"></div>
            </div>
          </div>
        </div>
      `;
    });
    trackEl.innerHTML = cardsHtml;
  }

  // Card 1: WHO IS ACTUALLY PLAYING OUT (Interactive Tug-of-War & Shield Meter)
  if (whoBadge) whoBadge.textContent = dossier.whoBadge;
  if (whoContent) {
    const totalDeltaSign = dossier.totalNetDelta > 0 ? '+' : '';
    const totalDeltaCls = dossier.totalNetDelta > 0 ? 'bull' : (dossier.totalNetDelta < 0 ? 'bear' : '');
    const isShieldActive = dossier.lastSample.absorbPct >= 65;

    whoContent.innerHTML = `
      <!-- Tug-of-War Split Bar Widget -->
      <div class="tv-tow-container">
        <div class="tv-tow-header">
          <span class="tv-tow-side bull">⚡ BUYERS ${dossier.netBullPct}%</span>
          <span class="tv-tow-side bear">SELLERS ${dossier.netBearPct}% ⚡</span>
        </div>
        <div class="tv-tow-bar-outer" title="Aggressor Ratio: ${dossier.netBullPct}% Buy vs ${dossier.netBearPct}% Sell">
          <div class="tv-tow-bull-fill" style="width: ${dossier.netBullPct}%;"></div>
          <div class="tv-tow-bear-fill" style="width: ${dossier.netBearPct}%;"></div>
          <div class="tv-tow-needle" style="left: ${dossier.netBullPct}%;"></div>
        </div>
        <div class="tv-network-stat-row" style="border: none; padding: 0;">
          <span class="tv-network-stat-label">Net Delta Pull</span>
          <span class="tv-network-stat-val ${totalDeltaCls}">${totalDeltaSign}${formatVolNumber(dossier.totalNetDelta)} (${dossier.netDeltaPct}%)</span>
        </div>
      </div>

      <!-- Segmented Absorption Shield Gauge Widget -->
      <div class="tv-shield-gauge-wrap">
        <div class="tv-shield-gauge-header">
          <span>INSTITUTIONAL ABSORPTION SHIELD</span>
          <span class="tv-network-stat-val ${isShieldActive ? 'bear' : 'highlight'}">${dossier.lastSample.absorbPct}% (${dossier.lastSample.absorbLevel})</span>
        </div>
        <div class="tv-shield-segments" title="Absorption Intensity: ${dossier.lastSample.absorbPct}%">
          <div class="tv-shield-seg ${dossier.lastSample.absorbPct >= 20 ? 'active-low' : ''}"></div>
          <div class="tv-shield-seg ${dossier.lastSample.absorbPct >= 40 ? 'active-low' : ''}"></div>
          <div class="tv-shield-seg ${dossier.lastSample.absorbPct >= 60 ? 'active-mid' : ''}"></div>
          <div class="tv-shield-seg ${dossier.lastSample.absorbPct >= 75 ? 'active-high' : ''}"></div>
          <div class="tv-shield-seg ${dossier.lastSample.absorbPct >= 90 ? 'active-high' : ''}"></div>
        </div>
        <div class="tv-status-banner ${isShieldActive ? 'shield' : (dossier.totalNetDelta > 0 ? 'wave' : 'balanced')}">
          <span>${isShieldActive ? '🛡️' : (dossier.totalNetDelta > 0 ? '🚀' : '⚖️')}</span>
          <span>${dossier.whoBadge}</span>
        </div>
      </div>

      <!-- Boundary Range Pinpoint Locator -->
      <div class="tv-range-track-wrap">
        <div class="tv-range-track-labels">
          <span>FLOOR $${dossier.minLow.toFixed(2)}</span>
          <span>50% EQ $${dossier.eqShelf.toFixed(2)}</span>
          <span>CEILING $${dossier.maxHigh.toFixed(2)}</span>
        </div>
        <div class="tv-range-track-bar" title="Live Price Relative to Range: ${dossier.pricePinPct}%">
          <div class="tv-range-pin" style="left: ${dossier.pricePinPct}%;" title="Live: $${dossier.livePrice.toFixed(2)}"></div>
        </div>
      </div>
    `;
  }

  // Card 2: EFFORT VS RESULT (Speedometer Gauge & Shift Bars)
  if (fuelBadge) fuelBadge.textContent = dossier.evrStatusBadge;
  if (fuelContent) {
    const evrCls = dossier.deltaEvr > 40 ? 'spike' : (dossier.deltaEvr < -30 ? 'vacuum' : 'stable');
    const needlePct = Math.max(5, Math.min(95, Math.round((dossier.lastSample.evr / 3000) * 100)));
    const firstBarPct = Math.max(5, Math.min(100, Math.round((dossier.firstSample.evr / dossier.maxEvr) * 100)));
    const lastBarPct = Math.max(5, Math.min(100, Math.round((dossier.lastSample.evr / dossier.maxEvr) * 100)));

    fuelContent.innerHTML = `
      <!-- Friction Speedometer Meter -->
      <div class="tv-speedo-box">
        <div class="tv-speedo-labels">
          <span style="color: #34d399;">⚡ Clean (<1.2k)</span>
          <span style="color: #fbbf24;">⚠️ High (1.2k-2.4k)</span>
          <span style="color: #f87171;">🔥 Extreme (>2.4k)</span>
        </div>
        <div class="tv-speedo-track" title="Current Burn: ${dossier.lastSample.evr.toLocaleString()} v/pt">
          <div class="tv-speedo-needle" style="left: ${needlePct}%;"></div>
        </div>
        <div class="tv-network-stat-row" style="border: none; padding: 0;">
          <span class="tv-network-stat-label">Active Burn Rate</span>
          <span class="tv-network-stat-val ${dossier.lastSample.frictionCls}">${dossier.lastSample.evr.toLocaleString()} VOL / PT (${dossier.lastSample.frictionTag})</span>
        </div>
      </div>

      <!-- Sequence Shift Dual Comparison Bars -->
      <div class="tv-shift-box">
        <div class="tv-shift-bars-row">
          <div class="tv-shift-bar-item">
            <div class="tv-shift-bar-label">
              <span>Sample #1 (Baseline)</span>
              <span>${dossier.firstSample.evr.toLocaleString()} v/pt</span>
            </div>
            <div class="tv-shift-bar-track">
              <div class="tv-shift-bar-fill first" style="width: ${firstBarPct}%;"></div>
            </div>
          </div>
          <div class="tv-shift-bar-item">
            <div class="tv-shift-bar-label">
              <span>Latest Sample #${dossier.sampleCount}</span>
              <span>${dossier.lastSample.evr.toLocaleString()} v/pt</span>
            </div>
            <div class="tv-shift-bar-track">
              <div class="tv-shift-bar-fill last" style="width: ${lastBarPct}%;"></div>
            </div>
          </div>
        </div>

        <div class="tv-shift-pill ${evrCls}">
          ${dossier.deltaEvr > 40 ? '🔥 +' + dossier.deltaEvr + '% FRICTION ESCALATION • LIMIT CLOGGING' : (dossier.deltaEvr < -30 ? '⚡ ' + dossier.deltaEvr + '% FRICTION COLLAPSE • LIQUIDITY VACUUM' : '⚖️ ' + (dossier.deltaEvr >= 0 ? '+' : '') + dossier.deltaEvr + '% PROPORTIONAL FLOW')}
        </div>
      </div>
    `;
  }

  // Card 3: STRONGEST STRUCTURAL INFLECTION NODES (Vertical Depth Ladder)
  if (nodesBadge) nodesBadge.textContent = 'CRITICAL SHELVES';
  if (nodesContent) {
    const s = (typeof window !== 'undefined' && window.__inflectionLinesState) || {
      ceiling: false,
      mid: false,
      anchor: false,
      floor: false
    };
    nodesContent.innerHTML = `
      <div class="tv-depth-ladder">
        <div class="tv-ladder-node ceiling ${s.ceiling ? 'line-active' : ''}" data-level-key="ceiling" title="Click to show/hide Ceiling Resistance on chart">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="tv-node-eye-pill" title="Toggle line on chart">${s.ceiling ? '👁️' : '👁️‍🗨️'}</span>
            <span class="tv-node-badge bear">🔴 CEILING RESISTANCE</span>
          </div>
          <span class="tv-node-price">$${dossier.maxHigh.toFixed(2)}</span>
          <span class="tv-node-dist">+${dossier.distCeiling.toFixed(1)} pts</span>
        </div>

        <div class="tv-ladder-node mid ${s.mid ? 'line-active' : ''}" data-level-key="mid" title="Click to show/hide 50% Mid-Equilibrium on chart">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="tv-node-eye-pill" title="Toggle line on chart">${s.mid ? '👁️' : '👁️‍🗨️'}</span>
            <span class="tv-node-badge warn">⚡ 50% MID-EQUILIBRIUM</span>
          </div>
          <span class="tv-node-price">$${dossier.eqShelf.toFixed(2)}</span>
          <span class="tv-node-dist">${dossier.livePrice >= dossier.eqShelf ? '-' : '+'}${dossier.distEq.toFixed(1)} pts</span>
        </div>

        <div class="tv-ladder-live-pointer">
          <span>► LIVE MARKET REFERENCE</span>
          <span class="tv-node-price" style="color: #00e5ff;">$${dossier.livePrice.toFixed(2)}</span>
        </div>

        <div class="tv-ladder-node anchor ${s.anchor ? 'line-active' : ''}" data-level-key="anchor" title="Click to show/hide Peak Volume Anchor on chart">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="tv-node-eye-pill" title="Toggle line on chart">${s.anchor ? '👁️' : '👁️‍🗨️'}</span>
            <span class="tv-node-badge highlight">⚓ PEAK VOLUME ANCHOR</span>
          </div>
          <span class="tv-node-price">$${dossier.primaryAnchor.toFixed(2)}</span>
          <span class="tv-node-dist">${dossier.livePrice >= dossier.primaryAnchor ? '-' : '+'}${dossier.distAnchor.toFixed(1)} pts</span>
        </div>

        <div class="tv-ladder-node floor ${s.floor ? 'line-active' : ''}" data-level-key="floor" title="Click to show/hide Support Floor on chart">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="tv-node-eye-pill" title="Toggle line on chart">${s.floor ? '👁️' : '👁️‍🗨️'}</span>
            <span class="tv-node-badge bull">🟢 SUPPORT FLOOR</span>
          </div>
          <span class="tv-node-price">$${dossier.minLow.toFixed(2)}</span>
          <span class="tv-node-dist">-${dossier.distFloor.toFixed(1)} pts</span>
        </div>
      </div>
    `;

    // Attach click listeners to individual depth ladder nodes
    nodesContent.querySelectorAll('.tv-ladder-node[data-level-key]').forEach(nodeEl => {
      nodeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = nodeEl.getAttribute('data-level-key');
        toggleSingleInflectionLine(key, c);
      });
    });
  }

  // Synchronize button in header
  updateInflectionLinesButtonUI();

  // Card 4: STRUCTURAL RUNWAY & LIQUIDITY VACUUM (Runway Meters, Hazard Box, Vacuum Dial)
  if (runwayBadge) runwayBadge.textContent = 'MANUAL PLANNING RUNWAY';
  if (runwayContent) {
    const isAbsorbing = dossier.lastSample.absorbPct >= 65;
    const isVacuum = dossier.deltaEvr <= -30;
    const isRange = !isAbsorbing && !isVacuum;

    runwayContent.innerHTML = `
      <div class="tv-runway-box">
        <div class="tv-runway-item">
          <div class="tv-runway-header upper">
            <span>⬆ UPPER RUNWAY TO CEILING</span>
            <span>${dossier.distCeiling.toFixed(1)} PTS</span>
          </div>
          <div class="tv-runway-track">
            <div class="tv-runway-fill upper" style="width: ${dossier.upperRunwayPct}%;"></div>
          </div>
        </div>

        <div class="tv-runway-item">
          <div class="tv-runway-header lower">
            <span>⬇ LOWER RUNWAY TO FLOOR</span>
            <span>${dossier.distFloor.toFixed(1)} PTS</span>
          </div>
          <div class="tv-runway-track">
            <div class="tv-runway-fill lower" style="width: ${dossier.lowerRunwayPct}%;"></div>
          </div>
        </div>
      </div>

      <div class="tv-hazard-box">
        <span class="tv-hazard-icon">⚠️</span>
        <div>
          <div class="tv-hazard-title">CRITICAL TRIPWIRE: $${dossier.invalidationTripwire.toFixed(2)}</div>
          <div class="tv-hazard-sub">Clean close beyond this invalidates the active structural sequence</div>
        </div>
      </div>

      <div class="tv-vacuum-dial">
        <div class="tv-vacuum-pill ${isAbsorbing ? 'active' : ''}">🛡️ LIMIT ABSORPTION</div>
        <div class="tv-vacuum-pill ${isRange ? 'active' : ''}">🔄 RANGE ROTATION</div>
        <div class="tv-vacuum-pill ${isVacuum ? 'active' : ''}">🚀 LIQUIDITY VACUUM</div>
      </div>
    `;
  }

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

  const state = (typeof window !== 'undefined' && window.__inflectionLinesState) || {
    ceiling: false,
    mid: false,
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

  const dossier = computeNetworkDossier(null, c.getDataList?.());
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
    anchor: 'ANCHOR',
    floor: 'FLOOR'
  };

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
      points: [{ value: price }],
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
  const state = (typeof window !== 'undefined' && window.__inflectionLinesState) || {
    ceiling: false,
    mid: false,
    anchor: false,
    floor: false
  };
  const anyActive = Object.values(state).some(Boolean);

  if (btn) {
    if (anyActive) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
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

/**
 * Toggles all 4 structural inflection reference lines simultaneously.
 */
export function toggleStructuralInflectionLines(chart, forceState = null) {
  const c = chart || chartInstance || (typeof window !== 'undefined' && window.__chartInstance);
  const state = (typeof window !== 'undefined' && window.__inflectionLinesState) || {
    ceiling: false,
    mid: false,
    anchor: false,
    floor: false
  };
  const anyActive = Object.values(state).some(Boolean);

  const targetState = (forceState !== null) ? forceState : !anyActive;
  state.ceiling = targetState;
  state.mid = targetState;
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
  const state = (typeof window !== 'undefined' && window.__inflectionLinesState) || {
    ceiling: false,
    mid: false,
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
