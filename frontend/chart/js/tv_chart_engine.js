/**
 * Escanor — TradingView Chart Engine (KLineCharts v10 wrapper)
 * Themes the chart to exact TradingView Obsidian (#131722), silver bull (#d1d4dc), rose bear (#e0457b)
 * and registers custom box & measurement ruler tools matching TradingView exactly.
 */

// Global reference for chart instance
let chartInstance = null;

export function getChartInstance() {
  return chartInstance;
}

// Register custom Rectangle (Box) and Measurement Ruler overlays
function registerCustomOverlays() {
  if (typeof klinecharts === 'undefined') return;

  const supported = klinecharts.getSupportedOverlays();

  // 1. Custom Box / Rectangle overlay with Shift-horizontal lock & styles
  if (!supported.includes('rect')) {
    klinecharts.registerOverlay({
      name: 'rect',
      totalStep: 3,
      needDefaultPointFigure: true,
      needDefaultXAxisFigure: true,
      needDefaultYAxisFigure: true,
      createPointFigures: ({ coordinates }) => {
        if (coordinates.length === 2) {
          const [p1, p2] = coordinates;
          const y2 = window.__isShiftPressed ? p1.y : p2.y;
          return [
            {
              type: 'polygon',
              attrs: {
                coordinates: [
                  { x: p1.x, y: p1.y },
                  { x: p2.x, y: p1.y },
                  { x: p2.x, y: y2 },
                  { x: p1.x, y: y2 }
                ]
              },
              styles: {
                style: 'stroke_fill',
                color: 'rgba(41, 98, 255, 0.15)',
                borderColor: '#2962ff',
                borderSize: 1
              }
            }
          ];
        }
        return [];
      },
      performEventPressedMove: ({ points, performPointIndex }) => {
        if (window.__isShiftPressed && points.length >= 2 && performPointIndex === 1) {
          points[1].value = points[0].value;
        }
      }
    });
  }

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

        // Badge lines (TradingView format: -19.383 (-0.46%) -1938.3)
        const line1 = `${sign}${absVal} (${sign}${absPct}%) ${sign}${absTicks}`;
        const line2 = `${barsCount} bars, ${timeStr}`;
        const line3 = `Vol ${volStr}`;

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

        const badgeW = 210;
        const badgeH = 64;
        let badgeX = boxMinX + (boxMaxX - boxMinX) / 2 - (badgeW / 2);
        let badgeY = boxMaxY + 10;

        if (badgeY + badgeH > window.innerHeight - 60) {
          badgeY = Math.max(50, boxMinY - badgeH - 10);
        }

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
          // 5. Solid Dark Rounded Badge Background (TradingView Charcoal Badge)
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
              color: '#1f1f1f',
              borderColor: '#363a45',
              borderSize: 1,
              borderRadius: 6
            }
          },
          // 6. Badge Text Line 1: Price (Pct) Ticks (Crisp white, NO blue background)
          {
            type: 'text',
            attrs: {
              x: badgeX + badgeW / 2,
              y: badgeY + 12,
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
              size: 12,
              weight: 'bold',
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }
          },
          // 7. Badge Text Line 2: Bars, Duration (Crisp silver, NO blue background)
          {
            type: 'text',
            attrs: {
              x: badgeX + badgeW / 2,
              y: badgeY + 29,
              text: line2,
              align: 'center'
            },
            styles: {
              color: '#d1d4dc',
              backgroundColor: 'transparent',
              borderColor: 'transparent',
              borderSize: 0,
              paddingLeft: 0,
              paddingRight: 0,
              paddingTop: 0,
              paddingBottom: 0,
              size: 11,
              weight: '500',
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }
          },
          // 8. Badge Text Line 3: Volume (Subtle silver, NO blue background)
          {
            type: 'text',
            attrs: {
              x: badgeX + badgeW / 2,
              y: badgeY + 45,
              text: line3,
              align: 'center'
            },
            styles: {
              color: '#9598a1',
              backgroundColor: 'transparent',
              borderColor: 'transparent',
              borderSize: 0,
              paddingLeft: 0,
              paddingRight: 0,
              paddingTop: 0,
              paddingBottom: 0,
              size: 11,
              weight: 'normal',
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

  chartInstance = chart;

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
        downColor: '#ec407a',       // Bear rose/pink matching image 2
        noChangeColor: '#787b86',
        upBorderColor: '#d1d4dc',
        downBorderColor: '#ec407a',
        noChangeBorderColor: '#787b86',
        upWickColor: '#d1d4dc',
        downWickColor: '#ec407a',
        noChangeWickColor: '#787b86'
      },
      priceMark: {
        show: true,
        high: { show: false },
        low: { show: false },
        last: {
          show: true,
          upColor: '#d1d4dc',
          downColor: '#ec407a',
          noChangeColor: '#787b86',
          line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1 },
          text: { show: true, color: '#ffffff', size: 11, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2 }
        }
      },
      tooltip: {
        showRule: 'always',
        showType: 'standard',
        rect: { color: 'rgba(28, 28, 28, 0.85)', borderColor: '#333333' },
        text: { size: 11, color: '#d1d4dc', family: 'monospace' }
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
      point: { color: '#2962ff', borderColor: 'rgba(41, 98, 255, 0.35)', borderSize: 1, radius: 4 },
      line: { style: 'solid', color: '#2962ff', size: 1 },
      rect: { style: 'fill', color: 'rgba(41, 98, 255, 0.15)', borderColor: '#2962ff', borderSize: 1 },
      polygon: { style: 'fill', color: 'rgba(41, 98, 255, 0.15)', borderColor: '#2962ff', borderSize: 1 },
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
  chart.setBarSpace(7.5);
  chart.setOffsetRightDistance(80);

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
