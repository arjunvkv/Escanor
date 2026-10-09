/**
 * Escanor Chart — Server-Side Drawings Persistence
 * Saves and restores drawings directly to/from backend server (/api/drawings)
 * so that any device opening the terminal gets the exact same markings.
 */

let saveTimeout = null;

export async function fetchServerDrawings(symbol = 'XAUUSD') {
  try {
    const res = await fetch(`/api/drawings?symbol=${symbol}`);
    const data = await res.json();
    if (data && data.status === 'OK' && Array.isArray(data.drawings)) {
      return data.drawings;
    }
  } catch (err) {
    console.warn('[Escanor Drawings] Failed to fetch server drawings:', err);
  }
  return [];
}

export function syncDrawingsToServer(symbol = 'XAUUSD', chart = null, showToast = true, immediate = false) {
  if (!chart) return;
  clearTimeout(saveTimeout);

  const doSync = async () => {
    try {
      const allOverlays = chart.getOverlays() || [];
      // Filter out temporary measure boxes or system markers
      const userDrawings = allOverlays
        .filter(ov => ov.name !== 'measureBox' && ov.name !== 'activeTradeOrder' && !ov.id?.startsWith('sys_') && !ov.id?.startsWith('pos_') && !ov.id?.startsWith('ord_'))
        .map(ov => ({
          id: ov.id,
          name: ov.name,
          points: ov.points,
          styles: ov.styles
        }));

      const res = await fetch('/api/drawings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, drawings: userDrawings })
      });
      const data = await res.json();
      if (data && data.status === 'OK' && showToast) {
        showChartToast(`Synced ${userDrawings.length} drawing(s) to server`);
      }
    } catch (err) {
      console.error('[Escanor Drawings] Save to server failed:', err);
    }
  };

  if (immediate) {
    doSync();
  } else {
    saveTimeout = setTimeout(doSync, 250);
  }
}

export function restoreDrawings(chart, drawingsList) {
  if (!chart || !Array.isArray(drawingsList)) return;
  drawingsList.forEach(d => {
    try {
      chart.createOverlay({
        id: d.id,
        name: d.name,
        points: d.points,
        styles: d.styles
      });
    } catch (e) {
      console.warn(`[Escanor Drawings] Could not restore overlay ${d.name}:`, e);
    }
  });
}

export function showChartToast(msg) {
  const t = document.getElementById('tvToast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(window.__tvToastTimer);
  window.__tvToastTimer = setTimeout(() => {
    t.classList.remove('visible');
  }, 2200);
}
