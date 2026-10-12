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
        .map(ov => ({
          id: ov.id,
          name: ov.name,
          points: ov.points,
          styles: ov.styles,
          extendData: ov.extendData || {}
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

export function expandRectPointsToSix(points) {
  if (!points || points.length !== 2) return points;
  const p0 = points[0];
  const p1 = points[1];
  if (!p0 || !p1) return points;
  const pLeft = (p0.timestamp < p1.timestamp || (p0.timestamp === p1.timestamp && (p0.dataIndex || 0) <= (p1.dataIndex || 0))) ? p0 : p1;
  const pRight = (pLeft === p0) ? p1 : p0;
  const vTop = Math.max(p0.value, p1.value);
  const vBottom = Math.min(p0.value, p1.value);
  const vMid = (vTop + vBottom) / 2;
  return [
    { timestamp: pLeft.timestamp, dataIndex: pLeft.dataIndex, value: vTop },       // 0: Top-Left (TL)
    { timestamp: pRight.timestamp, dataIndex: pRight.dataIndex, value: vTop },     // 1: Top-Right (TR)
    { timestamp: pRight.timestamp, dataIndex: pRight.dataIndex, value: vBottom },   // 2: Bottom-Right (BR)
    { timestamp: pLeft.timestamp, dataIndex: pLeft.dataIndex, value: vBottom },     // 3: Bottom-Left (BL)
    { timestamp: pLeft.timestamp, dataIndex: pLeft.dataIndex, value: vMid },       // 4: Middle-Left (ML)
    { timestamp: pRight.timestamp, dataIndex: pRight.dataIndex, value: vMid }      // 5: Middle-Right (MR)
  ];
}

export function handleRectPressedMove(points, performPointIndex) {
  if (!points || points.length !== 6) return;

  // Point 0: Top-Left (TL)
  if (performPointIndex === 0) {
    const curTop = points[0].value;
    const curLeftTime = points[0].timestamp;
    const curLeftIdx = points[0].dataIndex;
    const curBottom = points[2].value;

    points[1].value = curTop;
    points[3].timestamp = curLeftTime;
    points[3].dataIndex = curLeftIdx;

    const midVal = (curTop + curBottom) / 2;
    points[4].timestamp = curLeftTime;
    points[4].dataIndex = curLeftIdx;
    points[4].value = midVal;
    points[5].value = midVal;
  }
  // Point 1: Top-Right (TR)
  else if (performPointIndex === 1) {
    const curTop = points[1].value;
    const curRightTime = points[1].timestamp;
    const curRightIdx = points[1].dataIndex;
    const curBottom = points[2].value;

    points[0].value = curTop;
    points[2].timestamp = curRightTime;
    points[2].dataIndex = curRightIdx;

    const midVal = (curTop + curBottom) / 2;
    points[5].timestamp = curRightTime;
    points[5].dataIndex = curRightIdx;
    points[5].value = midVal;
    points[4].value = midVal;
  }
  // Point 2: Bottom-Right (BR)
  else if (performPointIndex === 2) {
    const curBottom = points[2].value;
    const curRightTime = points[2].timestamp;
    const curRightIdx = points[2].dataIndex;
    const curTop = points[0].value;

    points[1].timestamp = curRightTime;
    points[1].dataIndex = curRightIdx;
    points[3].value = curBottom;

    const midVal = (curTop + curBottom) / 2;
    points[5].timestamp = curRightTime;
    points[5].dataIndex = curRightIdx;
    points[5].value = midVal;
    points[4].value = midVal;
  }
  // Point 3: Bottom-Left (BL)
  else if (performPointIndex === 3) {
    const curBottom = points[3].value;
    const curLeftTime = points[3].timestamp;
    const curLeftIdx = points[3].dataIndex;
    const curTop = points[0].value;

    points[0].timestamp = curLeftTime;
    points[0].dataIndex = curLeftIdx;
    points[2].value = curBottom;

    const midVal = (curTop + curBottom) / 2;
    points[4].timestamp = curLeftTime;
    points[4].dataIndex = curLeftIdx;
    points[4].value = midVal;
    points[5].value = midVal;
  }
  // Point 4: Middle-Left (ML) -> drag left or right to extend/contract width
  else if (performPointIndex === 4) {
    const newLeftTime = points[4].timestamp;
    const newLeftIdx = points[4].dataIndex;

    points[0].timestamp = newLeftTime;
    points[0].dataIndex = newLeftIdx;
    points[3].timestamp = newLeftTime;
    points[3].dataIndex = newLeftIdx;

    // Lock vertical price to middle of top and bottom
    const midVal = (points[0].value + points[3].value) / 2;
    points[4].value = midVal;
  }
  // Point 5: Middle-Right (MR) -> drag left or right to extend/contract width
  else if (performPointIndex === 5) {
    const newRightTime = points[5].timestamp;
    const newRightIdx = points[5].dataIndex;

    points[1].timestamp = newRightTime;
    points[1].dataIndex = newRightIdx;
    points[2].timestamp = newRightTime;
    points[2].dataIndex = newRightIdx;

    // Lock vertical price to middle of top and bottom
    const midVal = (points[1].value + points[2].value) / 2;
    points[5].value = midVal;
  }
}

export function restoreDrawings(chart, drawingsList) {
  if (!chart || !Array.isArray(drawingsList)) return;
  drawingsList.forEach(d => {
    try {
      const isLine = ['segment', 'rayLine', 'straightLine', 'horizontalStraightLine', 'verticalStraightLine'].includes(d.name);
      const zLvl = d.zLevel !== undefined ? d.zLevel : (isLine ? 50 : (d.name === 'rect' ? 10 : 20));
      const points = (d.name === 'rect' && d.points && d.points.length === 2)
        ? expandRectPointsToSix(d.points)
        : d.points;
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
