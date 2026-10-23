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
      // Filter out temporary measure boxes, structural levels, session timeline, or system markers
      const userDrawings = allOverlays
        .filter(ov => ov.name !== 'sessionTimeline' && ov.name !== 'measureBox' && ov.name !== 'activeTradeOrder' && ov.name !== 'structuralLevel' && ov.name !== 'lineSlTpMarking' && !ov.id?.startsWith('sys_') && !ov.id?.startsWith('pos_') && !ov.id?.startsWith('ord_') && !ov.id?.startsWith('lvl_') && !ov.id?.startsWith('sltp_'))
        .map(ov => {
          // Strictly clean points: NEVER persist volatile in-memory dataIndex to server!
          // Points must be cleanly anchored by real timestamp and price value only.
          let cleanPoints = (ov.points || []).map(p => {
            const pt = { value: p.value };
            if (typeof p.timestamp === 'number' && !isNaN(p.timestamp) && p.timestamp > 0) {
              pt.timestamp = p.timestamp;
            } else if (typeof p.dataIndex === 'number' && chart._chartStore) {
              const ts = chart._chartStore.dataIndexToTimestamp(p.dataIndex);
              if (typeof ts === 'number' && !isNaN(ts) && ts > 0) {
                pt.timestamp = ts;
              }
            }
            return pt;
          });

          if (ov.name === 'rect') {
            cleanPoints = normalizeRectPoints(cleanPoints);
          }

          return {
            id: ov.id,
            name: ov.name,
            points: cleanPoints,
            styles: ov.styles,
            zLevel: ov.zLevel,
            extendData: ov.extendData || {}
          };
        });

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

export function normalizeRectPoints(points) {
  if (!points || !Array.isArray(points) || points.length < 2) return points;
  const validPoints = points.filter(p => p && typeof p.value === 'number' && !isNaN(p.value));
  if (validPoints.length < 2) return points;

  const timestamps = validPoints.map(p => p.timestamp).filter(t => typeof t === 'number' && !isNaN(t) && t > 0);
  const values = validPoints.map(p => p.value);

  let leftTime, rightTime;
  if (timestamps.length >= 2) {
    leftTime = Math.min(...timestamps);
    rightTime = Math.max(...timestamps);
  } else {
    leftTime = validPoints[0].timestamp || Date.now();
    rightTime = validPoints[1].timestamp || (leftTime + 3600000);
  }
  if (leftTime === rightTime) {
    rightTime = leftTime + 5 * 60 * 1000;
  }

  const topVal = Math.max(...values);
  const bottomVal = Math.min(...values);
  const midVal = (topVal + bottomVal) / 2;

  const p0 = points[0] || {};
  const p1 = points[1] || {};

  return [
    { timestamp: leftTime, value: topVal, dataIndex: p0.dataIndex },       // 0: Top-Left (TL)
    { timestamp: rightTime, value: topVal, dataIndex: p1.dataIndex },      // 1: Top-Right (TR)
    { timestamp: rightTime, value: bottomVal, dataIndex: p1.dataIndex },    // 2: Bottom-Right (BR)
    { timestamp: leftTime, value: bottomVal, dataIndex: p0.dataIndex },     // 3: Bottom-Left (BL)
    { timestamp: leftTime, value: midVal, dataIndex: p0.dataIndex },        // 4: Middle-Left (ML)
    { timestamp: rightTime, value: midVal, dataIndex: p1.dataIndex }       // 5: Middle-Right (MR)
  ];
}

export function expandRectPointsToSix(points) {
  return normalizeRectPoints(points);
}

export function handleRectPressedMove(points, performPointIndex, dataList, tfMins) {
  if (!points || points.length !== 6) return;
  if (performPointIndex < 0 || performPointIndex > 5) return;

  const pt = points[performPointIndex];
  if (!pt) return;

  // 1. Keep timestamp and dataIndex in lockstep for the actively dragged point
  if (Array.isArray(dataList) && dataList.length > 0) {
    const lastIdx = dataList.length - 1;
    const lastBar = dataList[lastIdx];
    const barMs = (tfMins || 5) * 60 * 1000;
    if (typeof pt.dataIndex === 'number') {
      if (pt.dataIndex > lastIdx) {
        pt.timestamp = lastBar.timestamp + Math.round((pt.dataIndex - lastIdx) * barMs);
      } else if (pt.dataIndex >= 0 && dataList[pt.dataIndex]) {
        pt.timestamp = dataList[pt.dataIndex].timestamp;
      }
    }
  }

  // 2. Lock edges:
  // Points layout:
  // 0: Top-Left (TL)     1: Top-Right (TR)
  // 4: Mid-Left (ML)     5: Mid-Right (MR)
  // 3: Bottom-Left (BL)  2: Bottom-Right (BR)

  // A. Left edge moved: Handles 0, 3, 4
  if (performPointIndex === 0 || performPointIndex === 3 || performPointIndex === 4) {
    const leftTime = pt.timestamp;
    const leftIdx = pt.dataIndex;
    points[0].timestamp = leftTime;
    points[0].dataIndex = leftIdx;
    points[3].timestamp = leftTime;
    points[3].dataIndex = leftIdx;
    points[4].timestamp = leftTime;
    points[4].dataIndex = leftIdx;
  }

  // B. Right edge moved: Handles 1, 2, 5
  if (performPointIndex === 1 || performPointIndex === 2 || performPointIndex === 5) {
    const rightTime = pt.timestamp;
    const rightIdx = pt.dataIndex;
    points[1].timestamp = rightTime;
    points[1].dataIndex = rightIdx;
    points[2].timestamp = rightTime;
    points[2].dataIndex = rightIdx;
    points[5].timestamp = rightTime;
    points[5].dataIndex = rightIdx;
  }

  // C. Top edge moved: Handles 0, 1
  if (performPointIndex === 0 || performPointIndex === 1) {
    const topVal = pt.value;
    points[0].value = topVal;
    points[1].value = topVal;
  }

  // D. Bottom edge moved: Handles 2, 3
  if (performPointIndex === 2 || performPointIndex === 3) {
    const bottomVal = pt.value;
    points[2].value = bottomVal;
    points[3].value = bottomVal;
  }

  // E. Mid handles vertical lock:
  const currentTop = points[0].value;
  const currentBottom = points[2].value;
  const midVal = (currentTop + currentBottom) / 2;
  points[4].value = midVal;
  points[5].value = midVal;
}

/**
 * Automatically calculates and enforces dynamic zLevel hierarchy for rectangle overlays:
 * Smaller boxes (micro zones) receive HIGHER zLevels (up to 45), while large macro boxes
 * receive LOWER zLevels (starting at 10).
 * This ensures micro sub-boxes float cleanly above macro boxes for both rendering and click/drag selection.
 */
export function recalculateRectZLevels(chart) {
  if (!chart || typeof chart.getOverlays !== 'function') return;
  const allOverlays = chart.getOverlays() || [];
  const rects = allOverlays.filter(ov => ov.name === 'rect' && ov.points && ov.points.length >= 2);
  if (rects.length === 0) return;

  if (rects.length === 1) {
    if (typeof chart.overrideOverlay === 'function') {
      chart.overrideOverlay({ id: rects[0].id, zLevel: 15 });
    }
    return;
  }

  // Calculate physical spatial area for each box: (Price Range * Time Duration in Minutes)
  const rectsWithArea = rects.map(r => {
    const validPts = (r.points || []).filter(p => p && typeof p.value === 'number' && !isNaN(p.value));
    if (validPts.length < 2) return { overlay: r, area: 0 };
    const vals = validPts.map(p => p.value);
    const times = validPts.map(p => p.timestamp).filter(t => typeof t === 'number' && !isNaN(t) && t > 0);
    const pSpan = Math.max(0.01, Math.max(...vals) - Math.min(...vals));
    const tSpan = times.length >= 2 ? Math.max(60000, Math.max(...times) - Math.min(...times)) : 60000;
    const area = pSpan * (tSpan / 60000);
    return { overlay: r, area };
  });

  // Sort DESCENDING: Largest macro box first (gets lowest zLevel 10)
  // Smallest micro sub-box last (gets highest zLevel 45)
  rectsWithArea.sort((a, b) => b.area - a.area);

  const minZ = 10;
  const maxZ = 45;
  const count = rectsWithArea.length;
  const step = count > 1 ? ((maxZ - minZ) / (count - 1)) : 0;

  rectsWithArea.forEach((item, index) => {
    const assignedZ = Math.round(minZ + index * step);
    if (item.overlay.zLevel !== assignedZ) {
      item.overlay.zLevel = assignedZ;
      if (typeof chart.overrideOverlay === 'function') {
        chart.overrideOverlay({ id: item.overlay.id, zLevel: assignedZ });
      }
    }
  });
}

export function restoreDrawings(chart, drawingsList) {
  if (!chart || !Array.isArray(drawingsList)) return;
  window.__isRestoringDrawings = true;
  try {
    drawingsList.forEach(d => {
      try {
        const isLine = ['segment', 'rayLine', 'straightLine', 'horizontalStraightLine', 'verticalStraightLine'].includes(d.name);
        const zLvl = d.zLevel !== undefined ? d.zLevel : (isLine ? 50 : (d.name === 'rect' ? 10 : 20));
        const rawPoints = (d.name === 'rect' && d.points)
          ? normalizeRectPoints(d.points)
          : d.points;

        // Strip any stale or volatile dataIndex so KLineChart strictly anchors by exact timestamp & price
        const points = (rawPoints || []).map(p => {
          const pt = { value: p.value };
          if (typeof p.timestamp === 'number' && !isNaN(p.timestamp) && p.timestamp > 0) {
            pt.timestamp = p.timestamp;
          }
          return pt;
        });

        chart.createOverlay({
          id: d.id,
          name: d.name,
          points: points,
          styles: d.styles,
          zLevel: zLvl,
          extendData: d.extendData || {}
        });
      } catch (e) {
        console.warn(`[Escanor Drawings] Could not restore overlay ${d.name}:`, e);
      }
    });

    // Enforce higher zLevel for smaller boxes among restored drawings
    recalculateRectZLevels(chart);
  } finally {
    window.__isRestoringDrawings = false;
  }
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
