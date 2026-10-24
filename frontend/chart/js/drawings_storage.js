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

export function normalizeRectPoints(points, customDataList) {
  if (!points || !Array.isArray(points) || points.length < 2) return points;

  const dataList = (customDataList && Array.isArray(customDataList) && customDataList.length > 0)
    ? customDataList
    : ((typeof window !== 'undefined' && window.__chartInstance?.getDataList?.()) || []);
  const tfMins = (typeof window !== 'undefined' && window.__currentTimeframeMinutes) || 5;
  const barMs = tfMins * 60 * 1000;
  const lastIdx = dataList.length > 0 ? (dataList.length - 1) : -1;
  const lastBar = lastIdx >= 0 ? dataList[lastIdx] : null;
  const firstBar = dataList.length > 0 ? dataList[0] : null;

  // 1. Resolve missing or undefined timestamps for ALL points (e.g. when drawn outside current price into future or past)
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (!pt) continue;
    const hasValidTime = (typeof pt.timestamp === 'number' && !isNaN(pt.timestamp) && pt.timestamp > 0);
    if (!hasValidTime && typeof pt.dataIndex === 'number' && !isNaN(pt.dataIndex) && lastBar) {
      if (pt.dataIndex > lastIdx) {
        pt.timestamp = lastBar.timestamp + Math.round((pt.dataIndex - lastIdx) * barMs);
      } else if (pt.dataIndex < 0 && firstBar) {
        pt.timestamp = firstBar.timestamp + Math.round(pt.dataIndex * barMs);
      } else if (dataList[pt.dataIndex]) {
        pt.timestamp = dataList[pt.dataIndex].timestamp;
      }
    }
  }

  const validPoints = points.filter(p => p && typeof p.value === 'number' && !isNaN(p.value));
  if (validPoints.length < 2) return points;

  const timestamps = validPoints
    .map(p => p.timestamp)
    .filter(t => typeof t === 'number' && !isNaN(t) && t > 0);
  const values = validPoints.map(p => p.value);

  let leftTime, rightTime;
  if (timestamps.length >= 2) {
    leftTime = Math.min(...timestamps);
    rightTime = Math.max(...timestamps);
  } else if (timestamps.length === 1) {
    leftTime = timestamps[0];
    rightTime = leftTime + barMs * 6;
  } else if (lastBar) {
    leftTime = lastBar.timestamp;
    rightTime = leftTime + barMs * 6;
  } else {
    leftTime = Date.now();
    rightTime = leftTime + 3600000;
  }

  // Ensure minimum 1 bar width so the box never auto-shrinks to zero
  if (leftTime === rightTime) {
    rightTime = leftTime + barMs;
  } else if (leftTime > rightTime) {
    const tmp = leftTime;
    leftTime = rightTime;
    rightTime = tmp;
  }

  let topVal = Math.max(...values);
  let bottomVal = Math.min(...values);
  if (topVal === bottomVal) {
    topVal += 0.5;
    bottomVal -= 0.5;
  }
  const midVal = (topVal + bottomVal) / 2;

  // Compute clean, non-inverted dataIndex corresponding to leftTime and rightTime
  let leftIdx = undefined;
  let rightIdx = undefined;
  if (dataList.length > 0 && lastBar) {
    if (leftTime > lastBar.timestamp) {
      leftIdx = lastIdx + Math.round((leftTime - lastBar.timestamp) / barMs);
    } else if (firstBar && leftTime < firstBar.timestamp) {
      leftIdx = Math.round((leftTime - firstBar.timestamp) / barMs);
    } else {
      const idx = dataList.findIndex(b => b.timestamp >= leftTime);
      leftIdx = idx !== -1 ? idx : 0;
    }

    if (rightTime > lastBar.timestamp) {
      rightIdx = lastIdx + Math.round((rightTime - lastBar.timestamp) / barMs);
    } else if (firstBar && rightTime < firstBar.timestamp) {
      rightIdx = Math.round((rightTime - firstBar.timestamp) / barMs);
    } else {
      const idx = dataList.findIndex(b => b.timestamp >= rightTime);
      rightIdx = idx !== -1 ? idx : lastIdx;
    }
  }

  return [
    { timestamp: leftTime, value: topVal, dataIndex: leftIdx },       // 0: Top-Left (TL)
    { timestamp: rightTime, value: topVal, dataIndex: rightIdx },     // 1: Top-Right (TR)
    { timestamp: rightTime, value: bottomVal, dataIndex: rightIdx },   // 2: Bottom-Right (BR)
    { timestamp: leftTime, value: bottomVal, dataIndex: leftIdx },    // 3: Bottom-Left (BL)
    { timestamp: leftTime, value: midVal, dataIndex: leftIdx },       // 4: Middle-Left (ML)
    { timestamp: rightTime, value: midVal, dataIndex: rightIdx }      // 5: Middle-Right (MR)
  ];
}

export function expandRectPointsToSix(points, customDataList) {
  return normalizeRectPoints(points, customDataList);
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
    const firstBar = dataList[0];
    const barMs = (tfMins || 5) * 60 * 1000;
    if (typeof pt.dataIndex === 'number') {
      if (pt.dataIndex > lastIdx) {
        pt.timestamp = lastBar.timestamp + Math.round((pt.dataIndex - lastIdx) * barMs);
      } else if (pt.dataIndex < 0 && firstBar) {
        pt.timestamp = firstBar.timestamp + Math.round(pt.dataIndex * barMs);
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

  const selectedId = window.__selectedOverlay?.id;

  if (rects.length === 1) {
    const isSelected = (selectedId && rects[0].id === selectedId);
    const z = isSelected ? 100 : 15;
    rects[0].fixedZLevel = true;
    rects[0].zLevel = z;
    if (typeof rects[0].setPrevZLevel === 'function') rects[0].setPrevZLevel(z);
    if (typeof chart.overrideOverlay === 'function') {
      chart.overrideOverlay({ id: rects[0].id, zLevel: z, fixedZLevel: true });
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

  // Sort DESCENDING: Largest macro box first (lowest zLevel 10)
  // Smallest micro sub-box last (highest zLevel 48)
  rectsWithArea.sort((a, b) => b.area - a.area);

  const minZ = 10;
  const maxZ = 48;
  const count = rectsWithArea.length;
  const step = count > 1 ? ((maxZ - minZ) / (count - 1)) : 0;

  rectsWithArea.forEach((item, index) => {
    const isSelected = (selectedId && item.overlay.id === selectedId);
    // If currently selected, elevate to 100 so its 6 resize handles and body float above all other boxes
    const assignedZ = isSelected ? 100 : Math.round(minZ + index * step);
    item.overlay.fixedZLevel = true;
    item.overlay.zLevel = assignedZ;
    if (typeof item.overlay.setPrevZLevel === 'function') {
      item.overlay.setPrevZLevel(assignedZ);
    }
    if (typeof chart.overrideOverlay === 'function') {
      chart.overrideOverlay({ id: item.overlay.id, zLevel: assignedZ, fixedZLevel: true });
    }
  });

  // Force chart store to re-sort overlays immediately
  if (chart._chartStore && typeof chart._chartStore._sortOverlays === 'function') {
    chart._chartStore._sortOverlays();
  }
}

export function restoreDrawings(chart, drawingsList) {
  if (!chart || !Array.isArray(drawingsList)) return;
  window.__isRestoringDrawings = true;
  try {
    drawingsList.forEach(d => {
      try {
        const isLine = ['segment', 'rayLine', 'straightLine', 'horizontalStraightLine', 'verticalStraightLine'].includes(d.name);
        const isRect = (d.name === 'rect');
        const zLvl = isLine ? 200 : (d.zLevel !== undefined ? d.zLevel : (isRect ? 10 : 20));
        const rawPoints = (isRect && d.points)
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
          fixedZLevel: (isLine || isRect) ? true : Boolean(d.fixedZLevel),
          extendData: d.extendData || {}
        });
      } catch (e) {
        console.warn(`[Escanor Drawings] Could not restore overlay ${d.name}:`, e);
      }
    });

    // Enforce higher zLevel for smaller boxes among restored drawings
    recalculateRectZLevels(chart);
    if (typeof window.__updateExtensionSeriesRibbon === 'function') {
      window.__updateExtensionSeriesRibbon(chart);
    }
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
