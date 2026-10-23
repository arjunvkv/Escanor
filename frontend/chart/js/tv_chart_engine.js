/**
 * Escanor — TradingView Chart Engine (KLineCharts v10 wrapper)
 * Themes the chart to exact TradingView Obsidian (#131722), silver bull (#d1d4dc), rose bear (#e0457b)
 * and registers custom box & measurement ruler tools matching TradingView exactly.
 */

import { expandRectPointsToSix, normalizeRectPoints, handleRectPressedMove, recalculateRectZLevels } from './drawings_storage.js?v=202610232220';
import { registerLivingFootprintIndicator } from './living_candle_engine.js?v=202610140655';

// Global reference for chart instance
let chartInstance = null;

// Global preference: Hide Volume Overlays on all boxes (only rectangle lines shown)
window.__hideAllRectVolumeOverlays = (typeof localStorage !== 'undefined' && localStorage.getItem('escanor_hide_all_rect_volume') === 'true');

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
 * Computes true volume consumption, aggressive bull vs bear delta,
 * Point of Control (POC), and Wyckoff auction verdict inside the spatial
 * bounds of any rectangle overlay.
 */
export function computeRectangleVolumeMetrics(overlay, dataList) {
  if (!overlay || !overlay.points || overlay.points.length < 2 || !dataList || dataList.length === 0) {
    return null;
  }

  const validPoints = overlay.points.filter(p => p && typeof p.value === 'number' && !isNaN(p.value));
  if (validPoints.length < 2) return null;

  const values = validPoints.map(p => p.value);
  const topPrice = Math.max(...values);
  const bottomPrice = Math.min(...values);
  const priceRange = topPrice - bottomPrice;
  if (priceRange <= 0.001) return null;

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

  const tfMins = window.__currentTimeframeMinutes || 5;
  const barMs = tfMins * 60 * 1000;

  let totalVol = 0;
  let bullVol = 0;
  let bearVol = 0;
  let candleCount = 0;
  let upperWickSum = 0;
  let lowerWickSum = 0;
  let lastClose = null;

  // Discrete price tiers for POC inside the box
  const numBins = 14;
  const binStep = priceRange / numBins;
  const bins = new Array(numBins).fill(0);

  for (let i = 0; i < dataList.length; i++) {
    const bar = dataList[i];
    if (!bar || typeof bar.timestamp !== 'number') continue;

    if (bar.timestamp + barMs < leftTime) continue;
    if (bar.timestamp > rightTime + barMs) continue;
    if (bar.high < bottomPrice || bar.low > topPrice) continue;

    const barRange = Math.max(0.01, bar.high - bar.low);
    const overlapLow = Math.max(bar.low, bottomPrice);
    const overlapHigh = Math.min(bar.high, topPrice);
    const overlapRange = Math.max(0, overlapHigh - overlapLow);
    const overlapRatio = Math.min(1.0, overlapRange / barRange);

    const vol = Number(bar.volume || bar.tick_volume || 1);
    const volInBox = vol * overlapRatio;

    totalVol += volInBox;
    candleCount++;
    lastClose = bar.close;

    const body = Math.abs(bar.close - bar.open);
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;

    upperWickSum += upperWick * overlapRatio;
    lowerWickSum += lowerWick * overlapRatio;

    let barBull = 0;
    let barBear = 0;

    if (bar.close >= bar.open) {
      const bullWeight = body + lowerWick * 1.25;
      const bearWeight = upperWick * 1.25;
      const totalWeight = bullWeight + bearWeight;
      const bullRatio = totalWeight > 0 ? (bullWeight / totalWeight) : 0.65;
      barBull = volInBox * bullRatio;
      barBear = volInBox * (1 - bullRatio);
    } else {
      const bearWeight = body + upperWick * 1.25;
      const bullWeight = lowerWick * 1.25;
      const totalWeight = bearWeight + bullWeight;
      const bearRatio = totalWeight > 0 ? (bearWeight / totalWeight) : 0.65;
      barBear = volInBox * bearRatio;
      barBull = volInBox * (1 - bearRatio);
    }

    bullVol += barBull;
    bearVol += barBear;

    const binStart = Math.max(0, Math.min(numBins - 1, Math.floor((overlapLow - bottomPrice) / binStep)));
    const binEnd = Math.max(0, Math.min(numBins - 1, Math.floor((overlapHigh - bottomPrice) / binStep)));
    const spannedBins = Math.max(1, binEnd - binStart + 1);
    const volPerBin = volInBox / spannedBins;
    for (let b = binStart; b <= binEnd; b++) {
      bins[b] += volPerBin;
    }
  }

  if (totalVol <= 0) return null;

  let maxBinVol = -1;
  let pocBinIdx = Math.floor(numBins / 2);
  for (let b = 0; b < numBins; b++) {
    if (bins[b] > maxBinVol) {
      maxBinVol = bins[b];
      pocBinIdx = b;
    }
  }
  const pocPrice = Number((bottomPrice + (pocBinIdx + 0.5) * binStep).toFixed(2));

  const netDelta = Math.round(bullVol - bearVol);
  const bullPct = Math.min(99, Math.max(1, Math.round((bullVol / totalVol) * 100)));
  const bearPct = 100 - bullPct;

  let verdict = 'BALANCED AUCTION';
  let verdictColor = '#38bdf8';

  const isNearCeiling = (lastClose !== null && lastClose >= bottomPrice + 0.65 * priceRange);
  const isNearFloor = (lastClose !== null && lastClose <= bottomPrice + 0.35 * priceRange);

  if (upperWickSum > lowerWickSum * 1.35 && isNearCeiling && bullPct >= 52) {
    verdict = 'BEAR ABSORPTION / CEILING';
    verdictColor = '#ffb300';
  } else if (lowerWickSum > upperWickSum * 1.35 && isNearFloor && bearPct >= 52) {
    verdict = 'BULL ABSORPTION / SPRING';
    verdictColor = '#00f0ff';
  } else if (bullPct >= 62) {
    verdict = 'BULL INITIATIVE';
    verdictColor = '#00e676';
  } else if (bearPct >= 62) {
    verdict = 'BEAR INITIATIVE';
    verdictColor = '#ff334b';
  } else if (bullPct >= 54) {
    verdict = 'BULL DOMINANT';
    verdictColor = '#10b981';
  } else if (bearPct >= 54) {
    verdict = 'BEAR DOMINANT';
    verdictColor = '#f43f5e';
  }

  return {
    totalVol: Math.round(totalVol),
    bullVol: Math.round(bullVol),
    bearVol: Math.round(bearVol),
    netDelta,
    bullPct,
    bearPct,
    pocPrice,
    candleCount,
    verdict,
    verdictColor,
    topPrice,
    bottomPrice,
    priceRange
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
    createPointFigures: ({ overlay, coordinates, yAxis }) => {
      if (!coordinates || coordinates.length === 0) return [];
      const isArmed = Boolean(overlay?.extendData?.alarmMode && overlay.extendData.alarmMode !== 'OFF');
      const isBoth = (overlay?.extendData?.alarmMode === 'BOTH');

      const polyStyle = {
        style: 'stroke_fill',
        color: isArmed ? (isBoth ? 'rgba(245, 158, 11, 0.16)' : 'rgba(236, 64, 122, 0.14)') : 'rgba(236, 64, 122, 0.12)',
        borderColor: isArmed ? (isBoth ? '#f59e0b' : '#ec407a') : '#ec407a',
        borderSize: isArmed ? 2 : 1.5
      };

      if (coordinates.length >= 2) {
        // Enforce 100% geometric rectangle: (minX, minY) to (maxX, maxY)
        // Guaranteed to NEVER deform into a trapezoid or sloped polygon!
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

        // Dynamic Volume Consumption & Delta Metrics inside Rectangle
        // Respect settings: hide volume overlay if disabled globally or on this specific box
        const isGlobalHidden = Boolean(window.__hideAllRectVolumeOverlays);
        const isThisBoxHidden = Boolean(overlay?.extendData?.hideVolumeOverlay);

        if (!isGlobalHidden && !isThisBoxHidden) {
          const dataList = chartInstance?.getDataList?.() || [];
          const volMetrics = computeRectangleVolumeMetrics(overlay, dataList);

          if (volMetrics && volMetrics.totalVol > 0) {
          // 1. Render Volume POC Line (Point of Control)
          let pocY = null;
          if (yAxis && typeof yAxis.convertToPixel === 'function') {
            pocY = yAxis.convertToPixel(volMetrics.pocPrice);
          } else if (volMetrics.priceRange > 0) {
            const ratio = (volMetrics.topPrice - volMetrics.pocPrice) / volMetrics.priceRange;
            pocY = minY + ratio * boxH;
          }

          if (pocY !== null && pocY >= minY + 2 && pocY <= maxY - 2) {
            figures.push({
              type: 'line',
              attrs: {
                coordinates: [
                  { x: minX, y: pocY },
                  { x: maxX, y: pocY }
                ]
              },
              ignoreEvent: true,
              styles: {
                style: 'dashed',
                color: '#ffb300',
                size: 1.2,
                dashedValue: [4, 4]
              }
            });

            if (boxW >= 75) {
              figures.push({
                type: 'text',
                attrs: {
                  x: maxX - 4,
                  y: pocY,
                  text: `POC $${volMetrics.pocPrice.toFixed(2)}`,
                  align: 'right',
                  baseline: 'middle'
                },
                ignoreEvent: true,
                styles: {
                  color: '#ffb300',
                  size: 9.5,
                  weight: '700',
                  family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
                  backgroundColor: 'rgba(15, 23, 42, 0.88)',
                  borderColor: 'rgba(255, 179, 0, 0.35)',
                  borderSize: 1,
                  paddingLeft: 4,
                  paddingRight: 4,
                  paddingTop: 1,
                  paddingBottom: 1,
                  borderRadius: 2
                }
              });
            }
          }

          // 2. Render HUD Badge inside the rectangle (Top-Left corner)
          const deltaSign = volMetrics.netDelta > 0 ? '+' : '';
          const deltaColor = volMetrics.netDelta > 0 ? '#00e676' : (volMetrics.netDelta < 0 ? '#ff334b' : '#38bdf8');
          const volStr = formatVolNumber(volMetrics.totalVol);
          const deltaStr = `${deltaSign}${formatVolNumber(volMetrics.netDelta)}`;

          if (boxW >= 120 && boxH >= 48) {
            // Full multi-line HUD badge
            const line1 = `📊 ${volStr} | Δ ${deltaStr}`;
            const line2 = `🟢 ${volMetrics.bullPct}%  |  ${volMetrics.bearPct}% 🔴`;

            figures.push({
              type: 'text',
              attrs: {
                x: minX + 6,
                y: minY + 6,
                text: line1,
                align: 'left',
                baseline: 'top'
              },
              ignoreEvent: true,
              styles: {
                color: '#00e5ff',
                size: 10,
                weight: '700',
                family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
                backgroundColor: 'rgba(13, 17, 26, 0.90)',
                borderColor: 'rgba(0, 229, 255, 0.25)',
                borderSize: 1,
                paddingLeft: 5,
                paddingRight: 5,
                paddingTop: 2,
                paddingBottom: 2,
                borderRadius: 3
              }
            });

            figures.push({
              type: 'text',
              attrs: {
                x: minX + 6,
                y: minY + 22,
                text: line2,
                align: 'left',
                baseline: 'top'
              },
              ignoreEvent: true,
              styles: {
                color: '#e2e8f0',
                size: 9.5,
                weight: '600',
                family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
                backgroundColor: 'rgba(13, 17, 26, 0.85)',
                paddingLeft: 4,
                paddingRight: 4,
                paddingTop: 1,
                paddingBottom: 1,
                borderRadius: 2
              }
            });

            if (boxH >= 68 && boxW >= 140) {
              figures.push({
                type: 'text',
                attrs: {
                  x: minX + 6,
                  y: minY + 37,
                  text: volMetrics.verdict,
                  align: 'left',
                  baseline: 'top'
                },
                ignoreEvent: true,
                styles: {
                  color: volMetrics.verdictColor,
                  size: 8.5,
                  weight: '800',
                  family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
                  backgroundColor: 'rgba(0, 0, 0, 0.70)',
                  paddingLeft: 4,
                  paddingRight: 4,
                  paddingTop: 1,
                  paddingBottom: 1,
                  borderRadius: 2
                }
              });
            }
          } else if (boxW >= 85 && boxH >= 28) {
            // Compact 2-line badge
            figures.push({
              type: 'text',
              attrs: {
                x: minX + 5,
                y: minY + 4,
                text: `${volStr} (Δ${deltaStr})`,
                align: 'left',
                baseline: 'top'
              },
              ignoreEvent: true,
              styles: {
                color: '#00e5ff',
                size: 9.5,
                weight: '700',
                family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
                backgroundColor: 'rgba(13, 17, 26, 0.90)',
                paddingLeft: 4,
                paddingRight: 4,
                paddingTop: 1,
                paddingBottom: 1,
                borderRadius: 2
              }
            });
            figures.push({
              type: 'text',
              attrs: {
                x: minX + 5,
                y: minY + 16,
                text: `${volMetrics.bullPct}%🟢 ${volMetrics.bearPct}%🔴`,
                align: 'left',
                baseline: 'top'
              },
              ignoreEvent: true,
              styles: {
                color: '#cbd5e1',
                size: 8.5,
                weight: '600',
                family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
                backgroundColor: 'rgba(13, 17, 26, 0.85)',
                paddingLeft: 3,
                paddingRight: 3,
                paddingTop: 1,
                paddingBottom: 1,
                borderRadius: 2
              }
            });
          } else if (boxW >= 55 && boxH >= 18) {
            // Micro 1-line tag for small sub-boxes
            figures.push({
              type: 'text',
              attrs: {
                x: minX + 4,
                y: minY + 3,
                text: `${volStr} Δ${deltaStr}`,
                align: 'left',
                baseline: 'top'
              },
              ignoreEvent: true,
              styles: {
                color: deltaColor,
                size: 8.5,
                weight: '700',
                family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
                backgroundColor: 'rgba(13, 17, 26, 0.88)',
                paddingLeft: 3,
                paddingRight: 3,
                paddingTop: 1,
                paddingBottom: 1,
                borderRadius: 2
              }
            });
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

  return chart;
}

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
