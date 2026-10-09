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

  // 2. Custom Measurement Ruler Box (Exact Match to TradingView Image 1)
  klinecharts.registerOverlay({
    name: 'measureBox',
    totalStep: 3,
    needDefaultPointFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length === 2 && overlay.points?.length === 2) {
        const [p1, p2] = coordinates;
        const [pt1, pt2] = overlay.points;

        const valDiff = pt2.value - pt1.value;
        const pctDiff = ((valDiff / (pt1.value || 1)) * 100);
        const isUp = valDiff >= 0;

        // Colors
        const boxColor = isUp ? 'rgba(8, 153, 129, 0.20)' : 'rgba(224, 69, 123, 0.20)';
        const borderColor = isUp ? '#089981' : '#e0457b';
        const badgeColor = isUp ? '#089981' : '#f23645';

        // Calculate bars count and total volume in range from candle data
        const allBars = chartInstance?.getDataList() || [];
        const minT = Math.min(pt1.timestamp || 0, pt2.timestamp || 0);
        const maxT = Math.max(pt1.timestamp || 0, pt2.timestamp || 0);
        const inRange = allBars.filter(b => b.timestamp >= minT && b.timestamp <= maxT);

        const barsCount = inRange.length > 0 ? inRange.length : 1;
        const totalVol = inRange.reduce((acc, b) => acc + (Number(b.volume) || 0), 0);

        let volStr = '';
        if (totalVol >= 1000000) {
          volStr = `${(totalVol / 1000000).toFixed(2)} M`;
        } else if (totalVol >= 1000) {
          volStr = `${(totalVol / 1000).toFixed(2)} K`;
        } else {
          volStr = `${totalVol}`;
        }

        // Time duration (e.g. 4h 5m, 25m, 1d 2h)
        const diffMs = Math.abs(maxT - minT);
        const diffMin = Math.round(diffMs / 60000);
        let timeStr = '';
        if (diffMin >= 1440) {
          const d = Math.floor(diffMin / 1440);
          const h = Math.floor((diffMin % 1440) / 60);
          timeStr = `${d}d ${h}h`;
        } else if (diffMin >= 60) {
          const h = Math.floor(diffMin / 60);
          const m = diffMin % 60;
          timeStr = `${h}h ${m}m`;
        } else {
          timeStr = `${diffMin}m`;
        }

        // Ticks for gold (1 point = 100 ticks)
        const ticks = valDiff * 100;
        const tickSign = ticks >= 0 ? '+' : '';
        const tickFormatted = `${tickSign}${ticks.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;

        // Badge lines
        const line1 = `${valDiff >= 0 ? '+' : ''}${valDiff.toFixed(3)} (${pctDiff >= 0 ? '+' : ''}${pctDiff.toFixed(2)}%) ${tickFormatted}`;
        const line2 = `${barsCount} bars, ${timeStr}`;
        const line3 = `Vol ${volStr}`;

        // Crosshairs & arrow
        const midY = (p1.y + p2.y) / 2;
        const midX = (p1.x + p2.x) / 2;
        const arrowDir = p2.x >= p1.x ? -1 : 1;
        const arrowHead = [
          { x: p2.x + arrowDir * 7, y: midY - 4 },
          { x: p2.x, y: midY },
          { x: p2.x + arrowDir * 7, y: midY + 4 }
        ];

        // Badge placement (Centered horizontally, pinned below or inside)
        const boxMinX = Math.min(p1.x, p2.x);
        const boxMaxX = Math.max(p1.x, p2.x);
        const boxMaxY = Math.max(p1.y, p2.y);
        const boxMinY = Math.min(p1.y, p2.y);

        const badgeW = 208;
        const badgeH = 68;
        let badgeX = boxMinX + (boxMaxX - boxMinX) / 2 - (badgeW / 2);
        let badgeY = boxMaxY + 12;

        if (badgeY + badgeH > window.innerHeight - 60) {
          badgeY = Math.max(50, boxMinY - badgeH - 12);
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
          // 5. Solid Rounded Badge Background (Matching Image 1)
          {
            type: 'rect',
            attrs: {
              x: badgeX,
              y: badgeY,
              width: badgeW,
              height: badgeH
            },
            styles: {
              style: 'fill',
              color: badgeColor,
              borderRadius: 8
            }
          },
          // 6. Badge Text Line 1: Price (Pct) Ticks
          {
            type: 'text',
            attrs: {
              x: badgeX + badgeW / 2,
              y: badgeY + 13,
              text: line1,
              align: 'center'
            },
            styles: {
              color: '#ffffff',
              size: 12,
              weight: 'bold',
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }
          },
          // 7. Badge Text Line 2: Bars, Duration
          {
            type: 'text',
            attrs: {
              x: badgeX + badgeW / 2,
              y: badgeY + 31,
              text: line2,
              align: 'center'
            },
            styles: {
              color: '#ffffff',
              size: 11,
              weight: 'normal',
              family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }
          },
          // 8. Badge Text Line 3: Volume
          {
            type: 'text',
            attrs: {
              x: badgeX + badgeW / 2,
              y: badgeY + 48,
              text: line3,
              align: 'center'
            },
            styles: {
              color: '#ffffff',
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

  // Exact TradingView Obsidian Theme Styles
  chart.setStyles({
    grid: {
      show: true,
      horizontal: { show: true, size: 1, color: '#1f2433', style: 'dashed', dashedValue: [2, 2] },
      vertical: { show: true, size: 1, color: '#1f2433', style: 'dashed', dashedValue: [2, 2] }
    },
    candle: {
      type: 'candle_solid',
      bar: {
        upColor: '#d1d4dc',         // Bull silver
        downColor: '#e0457b',       // Bear pink/rose
        noChangeColor: '#888888',
        upBorderColor: '#d1d4dc',
        downBorderColor: '#e0457b',
        noChangeBorderColor: '#888888',
        upWickColor: '#d1d4dc',
        downWickColor: '#e0457b',
        noChangeWickColor: '#888888'
      },
      priceMark: {
        show: true,
        high: { show: false },
        low: { show: false },
        last: {
          show: true,
          upColor: '#d1d4dc',
          downColor: '#e0457b',
          noChangeColor: '#888888',
          line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1 },
          text: { show: true, color: '#ffffff', size: 11, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2 }
        }
      },
      tooltip: {
        showRule: 'always',
        showType: 'standard',
        rect: { color: 'rgba(19, 23, 34, 0.75)', borderColor: '#2a2e39' },
        text: { size: 11, color: '#d1d4dc', family: 'monospace' }
      }
    },
    xAxis: {
      show: true,
      size: 'auto',
      axisLine: { show: true, color: '#2a2e39', size: 1 },
      tickLine: { show: true, size: 1, length: 3, color: '#2a2e39' },
      tickText: { show: true, color: '#787b86', size: 11, family: 'sans-serif' }
    },
    yAxis: {
      show: true,
      size: 'auto',
      position: 'right',
      type: 'normal',
      inside: false,
      axisLine: { show: true, color: '#2a2e39', size: 1 },
      tickLine: { show: true, size: 1, length: 3, color: '#2a2e39' },
      tickText: { show: true, color: '#787b86', size: 11, family: 'sans-serif' }
    },
    crosshair: {
      show: true,
      horizontal: {
        show: true,
        line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: '#787b86' },
        text: { show: true, color: '#ffffff', size: 11, backgroundColor: '#2a2e39', borderColor: '#2a2e39' }
      },
      vertical: {
        show: true,
        line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: '#787b86' },
        text: { show: true, color: '#ffffff', size: 11, backgroundColor: '#2a2e39', borderColor: '#2a2e39' }
      }
    },
    separator: {
      size: 1,
      color: '#2a2e39',
      fill: true
    }
  });

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
