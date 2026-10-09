/**
 * Escanor — TradingView Chart Engine (KLineCharts v10 wrapper)
 * Themes the chart to exact TradingView Obsidian (#131722), silver bull (#d1d4dc), rose bear (#e0457b)
 * and registers custom box & measurement ruler tools.
 */

// Register custom Rectangle (Box) overlay if not natively present
function registerCustomOverlays() {
  if (typeof klinecharts === 'undefined') return;

  const supported = klinecharts.getSupportedOverlays();

  // Custom Box / Rectangle overlay
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
          return [
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
                color: 'rgba(41, 98, 255, 0.15)',
                borderColor: '#2962ff',
                borderSize: 1
              }
            }
          ];
        }
        return [];
      }
    });
  }

  // Custom Measurement Ruler Box
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
        const color = isUp ? 'rgba(38, 166, 154, 0.22)' : 'rgba(224, 69, 123, 0.22)';
        const border = isUp ? '#26a69a' : '#e0457b';
        const label = `${isUp ? '+' : ''}${valDiff.toFixed(2)} (${isUp ? '+' : ''}${pctDiff.toFixed(2)}%)`;

        return [
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
              color: color,
              borderColor: border,
              borderSize: 1,
              borderStyle: 'dashed'
            }
          },
          {
            type: 'text',
            attrs: {
              x: Math.min(p1.x, p2.x) + 8,
              y: Math.min(p1.y, p2.y) + 16,
              text: label
            },
            styles: {
              color: '#ffffff',
              size: 11,
              family: 'monospace'
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
