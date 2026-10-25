/**
 * Escanor — TradingView Left Toolbar & Interaction Controller
 * Manages:
 * - Line tools, Box, and Measure tool
 * - Shift-key locking to horizontal while drawing lines
 * - Keyboard shortcuts (R = Rect, T/L = Line, H = Horiz, Shift+Drag = Ruler)
 * - Floating action toolbar for selected drawing (Matches Image 2)
 * - Settings modal & Backspace/Delete removal
 * - In-app confirmation dialog (Zero browser alert/confirm popups)
 */

import { syncDrawingsToServer, showChartToast, expandRectPointsToSix, normalizeRectPoints, handleRectPressedMove, recalculateRectZLevels } from './drawings_storage.js?v=202610241430';
import { computeRectangleVolumeMetrics, patchOverlayViews, updateExtensionSeriesRibbon, openExtensionNetworkModal, toggleStructuralInflectionLines, syncStructuralInflectionLines } from './tv_chart_engine.js?v=202610251945';

let activeTool = 'crosshair';
let selectedOverlay = null;
let currentSymbolRef = 'XAUUSD';

// Window Shift tracking
window.__isShiftPressed = false;
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') window.__isShiftPressed = true;
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') window.__isShiftPressed = false;
});

// Custom In-App Confirm Dialog (Zero browser default alert/confirm)
export function showTvConfirm(title, message, onConfirm) {
  const modal = document.getElementById('tvConfirmModal');
  const titleEl = document.getElementById('tvConfirmTitle');
  const msgEl = document.getElementById('tvConfirmMessage');
  const okBtn = document.getElementById('tvConfirmOkBtn');
  const cancelBtn = document.getElementById('tvConfirmCancelBtn');
  const cancelX = document.getElementById('tvConfirmCancelX');

  if (!modal) {
    if (onConfirm) onConfirm();
    return;
  }

  titleEl.textContent = title;
  msgEl.textContent = message;
  modal.style.display = 'flex';

  function close() {
    modal.style.display = 'none';
    okBtn.onclick = null;
    cancelBtn.onclick = null;
    cancelX.onclick = null;
  }

  cancelBtn.onclick = close;
  cancelX.onclick = close;
  okBtn.onclick = () => {
    close();
    if (onConfirm) onConfirm();
  };
}

export function initToolbar(chart, currentSymbol = 'XAUUSD') {
  if (!chart) return;
  currentSymbolRef = currentSymbol;

  const toolCrosshair = document.getElementById('toolCrosshair');
  const toolLinesBtn = document.getElementById('toolLinesBtn');
  const toolBoxBtn = document.getElementById('toolBoxBtn');
  const toolMeasureBtn = document.getElementById('toolMeasureBtn');
  const toolDeleteBtn = document.getElementById('toolDeleteBtn');
  const flyout = document.getElementById('lineToolsFlyout');

  const floatingBar = document.getElementById('tvFloatingToolbar');
  const floatDragHandle = document.getElementById('tvFloatDragHandle');
  const floatSettingsBtn = document.getElementById('tvFloatSettingsBtn');
  const floatArmBtn = document.getElementById('tvFloatArmBtn');
  const floatRectAlarmBtn = document.getElementById('tvFloatRectAlarmBtn');
  const floatVertAlarmBtn = document.getElementById('tvFloatVertAlarmBtn');
  const floatDeleteBtn = document.getElementById('tvFloatDeleteBtn');

  const settingsModal = document.getElementById('tvSettingsModal');
  const closeSettingsBtn = document.getElementById('tvCloseSettingsBtn');
  const saveSettingsBtn = document.getElementById('tvSaveSettingsBtn');
  const settingColor = document.getElementById('tvSettingColor');
  const settingWidth = document.getElementById('tvSettingWidth');
  const settingFillColor = document.getElementById('tvSettingFillColor');
  const settingLineStyle = document.getElementById('tvSettingLineStyle');

  function clearActiveButtons() {
    document.querySelectorAll('.tv-tool-btn').forEach(b => b.classList.remove('active'));
    if (flyout) flyout.style.display = 'none';
  }

  function setActive(btn, toolName) {
    clearActiveButtons();
    if (btn) btn.classList.add('active');
    activeTool = toolName;
    if (window.__lineTradingManager) {
      window.__lineTradingManager.setDrawing(false);
      window.__lineTradingManager.setDragging(false);
    }
  }

  // 1. Crosshair Mode
  toolCrosshair?.addEventListener('click', () => {
    setActive(toolCrosshair, 'crosshair');
    chart.setStyles({ crosshair: { show: true } });
  });

  // 2. Line Tools Button & Flyout
  toolLinesBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isShowing = flyout && flyout.style.display === 'flex';
    if (isShowing) {
      if (flyout) flyout.style.display = 'none';
    } else {
      clearActiveButtons();
      toolLinesBtn.classList.add('active');
      if (flyout) flyout.style.display = 'flex';
    }
  });

  document.querySelectorAll('.tv-flyout-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const overlayName = item.getAttribute('data-overlay');
      document.querySelectorAll('.tv-flyout-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      clearActiveButtons();
      toolLinesBtn.classList.add('active');
      if (flyout) flyout.style.display = 'none';

      activeTool = overlayName;
      createDrawing(overlayName);
    });
  });

  document.addEventListener('click', (e) => {
    if (flyout && !flyout.contains(e.target) && e.target !== toolLinesBtn) {
      flyout.style.display = 'none';
    }
  });

  // 3. Rectangle / Box Tool
  toolBoxBtn?.addEventListener('click', () => {
    setActive(toolBoxBtn, 'rect');
    createDrawing('rect');
  });

  // 4. Long Position Tool Button
  const toolLongPosBtn = document.getElementById('toolLongPosBtn');
  toolLongPosBtn?.addEventListener('click', () => {
    setActive(toolLongPosBtn, 'longPosition');
    createDrawing('longPosition');
    showChartToast('Long Position Tool (Alt+A)');
  });

  // 5. Short Position Tool Button
  const toolShortPosBtn = document.getElementById('toolShortPosBtn');
  toolShortPosBtn?.addEventListener('click', () => {
    setActive(toolShortPosBtn, 'shortPosition');
    createDrawing('shortPosition');
    showChartToast('Short Position Tool (Alt+S)');
  });

  // 6. Position & Measure Tool Settings (Specify Lots)
  const toolMeasureSettingsBtn = document.getElementById('toolMeasureSettingsBtn');
  toolMeasureSettingsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openMeasureSettingsModal();
  });

  const clearAllUserDrawings = () => {
    const all = chart.getOverlays() || [];
    // Target user drawings (lines, boxes, fibs, etc. but NEVER system overlays like activeTradeOrder, structuralLevel, sessionTimeline, lineSlTpMarking, measureBox)
    const userDrawings = all.filter(ov => {
      if (['activeTradeOrder', 'structuralLevel', 'sessionTimeline', 'lineSlTpMarking', 'measureBox'].includes(ov.name)) return false;
      if (ov.id && (ov.id.startsWith('sys_') || ov.id.startsWith('pos_') || ov.id.startsWith('ord_') || ov.id.startsWith('lvl_') || ov.id.startsWith('sltp_'))) return false;
      return true;
    });

    if (userDrawings.length === 0) {
      showChartToast('No line or box drawings to remove');
      return;
    }

    showTvConfirm('Clear Chart Drawings', `Remove all ${userDrawings.length} line and box drawing(s) on chart?`, () => {
      userDrawings.forEach(ov => chart.removeOverlay({ id: ov.id }));
      if (window.__lineTradingManager) {
        window.__lineTradingManager.clearAllLines();
      }
      selectedOverlay = null;
      const rectModal = document.getElementById('tvRectSettingsModal');
      if (rectModal) rectModal.style.display = 'none';

      updateExtensionSeriesRibbon(chart);
      syncDrawingsToServer(currentSymbolRef, chart, false, true);
      hideFloatingBar();
      showChartToast(`Cleared all ${userDrawings.length} drawing(s)`);
    });
  };

  // 5. Delete Tool Button on Left Dock
  toolDeleteBtn?.addEventListener('click', () => {
    if (selectedOverlay) {
      deleteSelectedOverlay();
    } else {
      clearAllUserDrawings();
    }
  });

  // Top Bar Clear All Drawings Button (Left of Mobile HUD)
  const tvClearAllDrawingsTopBtn = document.getElementById('tvClearAllDrawingsTopBtn');
  tvClearAllDrawingsTopBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    clearAllUserDrawings();
  });

  const isLineOverlay = (name) => ['segment', 'rayLine', 'straightLine', 'horizontalStraightLine'].includes(name);

  // Create Drawing with Shift Snapping & Event Hooks
  function createDrawing(overlayName) {
    if (isLineOverlay(overlayName) && window.__lineTradingManager) {
      window.__lineTradingManager.setDrawing(true);
    }
    const defaultStyles = isLineOverlay(overlayName) ? {
      line: { color: '#94a3b8', size: 1.5, style: 'solid' },
      point: { color: '#94a3b8', borderColor: '#94a3b8', activeColor: '#cbd5e1', activeBorderColor: '#cbd5e1', radius: 4.5 }
    } : undefined;

    const isLine = isLineOverlay(overlayName) || overlayName === 'verticalStraightLine';
    const isRect = (overlayName === 'rect');
    const zLvl = isLine ? 200 : (isRect ? 45 : 20);

    try {
      chart.createOverlay({
        name: overlayName,
        zLevel: zLvl,
        fixedZLevel: (isLine || isRect) ? true : false,
        styles: defaultStyles,
        onDrawEnd: ({ overlay }) => {
          if (isLineOverlay(overlayName) && window.__lineTradingManager && overlay) {
            window.__lineTradingManager.setDrawing(false);
            window.__lineTradingManager.registerLineOverlay(overlay, overlayName);
          }
          if (overlayName === 'rect' && overlay) {
            if (overlay.points && overlay.points.length >= 2) {
              const sixPoints = normalizeRectPoints(overlay.points, chart.getDataList());
              chart.overrideOverlay({ id: overlay.id, points: sixPoints });
            }
            recalculateRectZLevels(chart);
            updateExtensionSeriesRibbon(chart);
          }
          if ((overlayName === 'longPosition' || overlayName === 'shortPosition') && overlay) {
            if (overlay.points && overlay.points.length === 1) {
              const p0 = overlay.points[0];
              const isLong = (overlayName === 'longPosition');
              const tfMins = window.__currentTimeframeMinutes || 5;
              const spanMs = 25 * tfMins * 60 * 1000;
              const targetDelta = 10.0;
              const stopDelta = 5.0;
              const targetVal = isLong ? (p0.value + targetDelta) : (p0.value - targetDelta);
              const stopVal = isLong ? (p0.value - stopDelta) : (p0.value + stopDelta);
              overlay.points.push(
                { timestamp: p0.timestamp + spanMs, value: targetVal },
                { timestamp: p0.timestamp + spanMs, value: stopVal }
              );
            }
          }
          syncDrawingsToServer(currentSymbolRef, chart);
          setActive(toolCrosshair, 'crosshair');
        },
        performEventPressedMove: ({ points, performPointIndex, currentStep }) => {
          if (window.__isRestoringDrawings) return;
          if (isLineOverlay(overlayName) && window.__lineTradingManager) {
            window.__lineTradingManager.setDragging(true);
          }
          if (overlayName === 'rect' && points?.length === 6) {
            handleRectPressedMove(points, performPointIndex, chart.getDataList(), window.__currentTimeframeMinutes || 5);
          }
          // If Shift is pressed, lock to horizontal level
          if (window.__isShiftPressed && points.length >= 2 && performPointIndex === 1) {
            points[1].value = points[0].value;
          }
          if ((overlayName === 'longPosition' || overlayName === 'shortPosition') && points?.length >= 3) {
            const isLong = (overlayName === 'longPosition');
            if (performPointIndex === 1) {
              points[2].timestamp = points[1].timestamp;
              if (isLong && points[1].value <= points[0].value) points[1].value = points[0].value + 0.1;
              else if (!isLong && points[1].value >= points[0].value) points[1].value = points[0].value - 0.1;
            } else if (performPointIndex === 2) {
              points[1].timestamp = points[2].timestamp;
              if (isLong && points[2].value >= points[0].value) points[2].value = points[0].value - 0.1;
              else if (!isLong && points[2].value <= points[0].value) points[2].value = points[0].value + 0.1;
            }
          }
        },
        onPressedMoveEnd: () => {
          if (isLineOverlay(overlayName) && window.__lineTradingManager) {
            window.__lineTradingManager.setDragging(false);
          }
          syncDrawingsToServer(currentSymbolRef, chart);
        },
        onSelected: (event) => {
          handleOverlaySelected(event);
        },
        onDeselected: (event) => {
          handleOverlayDeselected(event);
        }
      });
    } catch (err) {
      console.error('[Escanor Toolbar] Create overlay failed:', err);
    }
  }

  // Wrap global createOverlay to ensure all restored & created overlays support selection & shift lock
  const origCreateOverlay = chart.createOverlay.bind(chart);
  chart.createOverlay = function (params) {
    const ovName = params.name;

    // Internal execution & structural overlays bypass user drawing wrappers
    if (ovName === 'lineSlTpMarking' || ovName === 'activeTradeOrder' || ovName === 'structuralLevel') {
      return origCreateOverlay(params);
    }

    const defaultStyles = (isLineOverlay(ovName) && !params.styles) ? {
      line: { color: '#94a3b8', size: 1.5, style: 'solid' },
      point: { color: '#94a3b8', borderColor: '#94a3b8', activeColor: '#cbd5e1', activeBorderColor: '#cbd5e1', radius: 4.5 }
    } : params.styles;

    const isLine = isLineOverlay(ovName) || ovName === 'verticalStraightLine';
    const isRect = (ovName === 'rect');
    const zLvl = isLine ? 200 : (params.zLevel !== undefined ? params.zLevel : (isRect ? 45 : 20));

    const customParams = {
      ...params,
      zLevel: zLvl,
      fixedZLevel: (isLine || isRect) ? true : Boolean(params.fixedZLevel),
      styles: defaultStyles,
      onDrawEnd: (args) => {
        if (params.onDrawEnd) params.onDrawEnd(args);
        if (isLineOverlay(ovName) && window.__lineTradingManager && args?.overlay) {
          window.__lineTradingManager.setDrawing(false);
          window.__lineTradingManager.registerLineOverlay(args.overlay, ovName);
        }
        if (ovName === 'rect' && args?.overlay) {
          const ov = args.overlay;
          if (ov.points && ov.points.length >= 2) {
            const sixPoints = normalizeRectPoints(ov.points, chart.getDataList());
            chart.overrideOverlay({ id: ov.id, points: sixPoints });
          }
          recalculateRectZLevels(chart);
        }
        if ((ovName === 'longPosition' || ovName === 'shortPosition') && args?.overlay) {
          const ov = args.overlay;
          if (ov.points && ov.points.length === 1) {
            const p0 = ov.points[0];
            const isLong = (ovName === 'longPosition');
            const tfMins = window.__currentTimeframeMinutes || 5;
            const spanMs = 25 * tfMins * 60 * 1000;
            const targetDelta = 10.0;
            const stopDelta = 5.0;
            const targetVal = isLong ? (p0.value + targetDelta) : (p0.value - targetDelta);
            const stopVal = isLong ? (p0.value - stopDelta) : (p0.value + stopDelta);
            ov.points.push(
              { timestamp: p0.timestamp + spanMs, value: targetVal },
              { timestamp: p0.timestamp + spanMs, value: stopVal }
            );
          }
        }
      },
      performEventPressedMove: (args) => {
        if (window.__isRestoringDrawings) return;
        if (params.performEventPressedMove) params.performEventPressedMove(args);
        if (isLineOverlay(ovName) && window.__lineTradingManager) {
          window.__lineTradingManager.setDragging(true);
        }
        if (window.__isShiftPressed && args.points?.length >= 2 && args.performPointIndex === 1) {
          args.points[1].value = args.points[0].value;
        }
        if ((ovName === 'longPosition' || ovName === 'shortPosition') && args.points?.length >= 3) {
          const isLong = (ovName === 'longPosition');
          if (args.performPointIndex === 1) {
            args.points[2].timestamp = args.points[1].timestamp;
            if (isLong && args.points[1].value <= args.points[0].value) args.points[1].value = args.points[0].value + 0.1;
            else if (!isLong && args.points[1].value >= args.points[0].value) args.points[1].value = args.points[0].value - 0.1;
          } else if (args.performPointIndex === 2) {
            args.points[1].timestamp = args.points[2].timestamp;
            if (isLong && args.points[2].value >= args.points[0].value) args.points[2].value = args.points[0].value - 0.1;
            else if (!isLong && args.points[2].value <= args.points[0].value) args.points[2].value = args.points[0].value + 0.1;
          }
        }
        // Keep timestamp in lockstep with dataIndex into the future empty space for ALL points
        const dataList = chart.getDataList() || [];
        if (dataList.length > 0 && Array.isArray(args.points)) {
          const lastIdx = dataList.length - 1;
          const lastBar = dataList[lastIdx];
          const firstBar = dataList[0];
          const tfMins = window.__currentTimeframeMinutes || 5;
          const barMs = tfMins * 60 * 1000;
          for (let i = 0; i < args.points.length; i++) {
            const pt = args.points[i];
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

        if (ovName === 'rect' && args.points?.length === 6) {
          handleRectPressedMove(args.points, args.performPointIndex, chart.getDataList(), window.__currentTimeframeMinutes || 5);
        }
      },
      performEventMoveForDrawing: (args) => {
        if (window.__isRestoringDrawings || args?.currentStep === -1) return;
        if (params.performEventMoveForDrawing) params.performEventMoveForDrawing(args);
        const dataList = chart.getDataList() || [];
        if (dataList.length > 0 && Array.isArray(args.points)) {
          const lastIdx = dataList.length - 1;
          const lastBar = dataList[lastIdx];
          const firstBar = dataList[0];
          const tfMins = window.__currentTimeframeMinutes || 5;
          const barMs = tfMins * 60 * 1000;
          for (let i = 0; i < args.points.length; i++) {
            const pt = args.points[i];
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
      onPressedMoveEnd: (args) => {
        if (params.onPressedMoveEnd) params.onPressedMoveEnd(args);
        if (isLineOverlay(ovName) && window.__lineTradingManager) {
          window.__lineTradingManager.setDragging(false);
        }
        if (ovName === 'rect' && args?.overlay?.points) {
          const sixPoints = normalizeRectPoints(args.overlay.points, chart.getDataList());
          chart.overrideOverlay({ id: args.overlay.id, points: sixPoints });
          updateExtensionSeriesRibbon(chart);
        }
        syncDrawingsToServer(currentSymbolRef, chart);
      },
      onSelected: (event) => {
        if (params.onSelected) params.onSelected(event);
        handleOverlaySelected(event);
      },
      onDeselected: (event) => {
        if (params.onDeselected) params.onDeselected(event);
        handleOverlayDeselected(event);
      }
    };
    return origCreateOverlay(customParams);
  };

  // =========================================================================
  // 🎛️ FLOATING ACTION TOOLBAR (MATCHES TRADINGVIEW)
  // Single persistent coordinate across all items and browser reloads
  // =========================================================================

  const TOOLBAR_POS_KEY = 'tv_floating_toolbar_pos';

  function getSavedToolbarPosition() {
    try {
      const saved = localStorage.getItem(TOOLBAR_POS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.left === 'number' && typeof parsed.top === 'number') {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[Toolbar] Failed reading saved position:', e);
    }
    return null;
  }

  function saveToolbarPosition(left, top) {
    try {
      localStorage.setItem(TOOLBAR_POS_KEY, JSON.stringify({ left: Math.round(left), top: Math.round(top) }));
    } catch (e) {
      console.warn('[Toolbar] Failed saving position:', e);
    }
  }

  function applyFloatingBarPosition() {
    if (!floatingBar) return;
    const barWidth = floatingBar.offsetWidth || 116;
    const barHeight = floatingBar.offsetHeight || 36;

    let pos = getSavedToolbarPosition();
    if (!pos) {
      // Default initial location: centered horizontally, 75px from top
      const defaultLeft = Math.round((window.innerWidth / 2) - (barWidth / 2));
      const defaultTop = 75;
      pos = { left: defaultLeft, top: defaultTop };
      saveToolbarPosition(pos.left, pos.top);
    }

    // Strictly clamp within viewport so the box never gets lost off-screen
    const maxLeft = Math.max(10, window.innerWidth - barWidth - 10);
    const maxTop = Math.max(10, window.innerHeight - barHeight - 10);
    const clampedLeft = Math.max(10, Math.min(maxLeft, pos.left));
    const clampedTop = Math.max(10, Math.min(maxTop, pos.top));

    floatingBar.style.left = `${clampedLeft}px`;
    floatingBar.style.top = `${clampedTop}px`;
  }

  // Pre-position on init so it's ready at the saved coordinate
  applyFloatingBarPosition();
  window.__handleOverlaySelected = handleOverlaySelected;

  function handleOverlaySelected(event) {
    selectedOverlay = event.overlay;
    window.__selectedOverlay = selectedOverlay;
    if (!selectedOverlay) return;

    // SL/TP projection markings: thin draggable chart indicators, preserve parent line selection
    if (selectedOverlay.name === 'lineSlTpMarking' || String(selectedOverlay.id).startsWith('sltp_')) {
      const parentId = selectedOverlay.extendData?.parentLineId;
      if (parentId && window.__lineTradingManager) {
        window.__lineTradingManager.selectedLineId = String(parentId);
      }
      hideFloatingBar();
      return;
    }

    if (window.__lineTradingManager && selectedOverlay.id) {
      window.__lineTradingManager.setSelectedLineId(selectedOverlay.id);
    }

    // Measurement tool: User explicitly requested:
    // "no need for for settings delete or floating box for measurement tool . let it be auto removed when clicked ouside -- same as trading view"
    if (selectedOverlay.name === 'measureBox') {
      hideFloatingBar();
      return;
    }

    // Position at the single saved persistent coordinate for ALL items
    applyFloatingBarPosition();

    // Show contextual quick action icon on the right side of Settings gear:
    // 1. Line Tools (Trend Line, Ray Line, Extended Line, Horizontal Line) -> Arm / Disarm Trade Trigger
    if (isLineOverlay(selectedOverlay.name) && window.__lineTradingManager) {
      if (floatArmBtn) {
        floatArmBtn.style.display = 'flex';
        const lineConfig = window.__lineTradingManager.getLineConfig(selectedOverlay.id);
        const isArmed = lineConfig ? Boolean(lineConfig.isArmed) : false;
        floatArmBtn.classList.toggle('armed', isArmed);
        floatArmBtn.classList.remove('buy', 'sell');
        if (isArmed && lineConfig) {
          if (lineConfig.direction === 'BUY') floatArmBtn.classList.add('buy');
          else if (lineConfig.direction === 'SELL') floatArmBtn.classList.add('sell');
        }
        floatArmBtn.title = isArmed ? '⚡ ACTIVE / ARMED (Click to Deactivate)' : '⚪ DEACTIVATED (Click to Activate)';
      }
      if (floatRectAlarmBtn) floatRectAlarmBtn.style.display = 'none';
      if (floatVertAlarmBtn) floatVertAlarmBtn.style.display = 'none';
    }
    // 2. Long & Short position tools -> Arm / Disarm Trade Trigger
    else if (selectedOverlay.name === 'longPosition' || selectedOverlay.name === 'shortPosition') {
      if (floatArmBtn) {
        floatArmBtn.style.display = 'flex';
        const isArmed = Boolean(selectedOverlay.extendData?.isArmed);
        floatArmBtn.classList.toggle('armed', isArmed);
        floatArmBtn.classList.remove('buy', 'sell');
        floatArmBtn.title = isArmed ? '⚡ ARMED (Click to Disarm)' : 'Arm Trade Trigger (Click to Arm)';
      }
      if (floatRectAlarmBtn) floatRectAlarmBtn.style.display = 'none';
      if (floatVertAlarmBtn) floatVertAlarmBtn.style.display = 'none';
    }
    // 3. Rectangle tool -> Immediate Alarm activation (BOTH In & Out + Telegram)
    else if (selectedOverlay.name === 'rect') {
      if (floatArmBtn) floatArmBtn.style.display = 'none';
      if (floatVertAlarmBtn) floatVertAlarmBtn.style.display = 'none';
      if (floatRectAlarmBtn) {
        floatRectAlarmBtn.style.display = 'flex';
        const isAlarmArmed = (selectedOverlay.extendData?.alarmMode === 'BOTH' && Boolean(selectedOverlay.extendData?.telegramAlert));
        floatRectAlarmBtn.classList.toggle('armed', isAlarmArmed);
        floatRectAlarmBtn.title = isAlarmArmed ? '🔔 ALARM ARMED (BOTH + Telegram) - Click to Disarm' : 'Activate Alarm (BOTH In & Out + Telegram)';
      }
      recalculateRectZLevels(chart);
      patchOverlayViews(chart);
    }
    // 4. Vertical Straight Line -> Immediate Time Alarm activation (PC & Mobile)
    else if (selectedOverlay.name === 'verticalStraightLine') {
      if (floatArmBtn) floatArmBtn.style.display = 'none';
      if (floatRectAlarmBtn) floatRectAlarmBtn.style.display = 'none';
      if (floatVertAlarmBtn) {
        floatVertAlarmBtn.style.display = 'flex';
        const isVertAlarmArmed = Boolean(selectedOverlay.extendData?.alarmActive);
        floatVertAlarmBtn.classList.toggle('armed', isVertAlarmArmed);
        floatVertAlarmBtn.title = isVertAlarmArmed ? '🔔 TIME ALARM ARMED (PC & Mobile) - Click to Disarm' : 'Activate Time Alarm (PC & Mobile)';
      }
    } else {
      if (floatArmBtn) floatArmBtn.style.display = 'none';
      if (floatRectAlarmBtn) floatRectAlarmBtn.style.display = 'none';
      if (floatVertAlarmBtn) floatVertAlarmBtn.style.display = 'none';
    }

    floatingBar.style.display = 'flex';
  }

  function handleOverlayDeselected(event) {
    if (window.__isDraggingSlTp || (window.__lineTradingManager && window.__lineTradingManager.isDraggingSlTp)) {
      return;
    }
    const deselectedOv = event?.overlay;
    if (deselectedOv && (deselectedOv.name === 'lineSlTpMarking' || String(deselectedOv.id).startsWith('sltp_') || deselectedOv.name === 'activeTradeOrder')) {
      return;
    }

    // If an SL or TP line is currently active or selected, preserve parent line selection!
    if (window.__selectedOverlay && (window.__selectedOverlay.name === 'lineSlTpMarking' || String(window.__selectedOverlay.id).startsWith('sltp_'))) {
      return;
    }

    selectedOverlay = null;
    window.__selectedOverlay = null;
    recalculateRectZLevels(chart);

    if (window.__lineTradingManager && !window.__lineTradingManager.isDraggingSlTp) {
      window.__lineTradingManager.setSelectedLineId(null);
    }
    hideFloatingBar();
  }

  function hideFloatingBar() {
    if (floatingBar) floatingBar.style.display = 'none';
    if (floatArmBtn) floatArmBtn.style.display = 'none';
    if (floatRectAlarmBtn) floatRectAlarmBtn.style.display = 'none';
    if (floatVertAlarmBtn) floatVertAlarmBtn.style.display = 'none';
  }

  function deleteSelectedOverlay() {
    if (!selectedOverlay) return;
    try {
      const id = selectedOverlay.id;
      chart.removeOverlay({ id });
      if (window.__lineTradingManager) {
        window.__lineTradingManager.removeLineOverlay(id);
      }
      recalculateRectZLevels(chart);
      updateExtensionSeriesRibbon(chart);
      selectedOverlay = null;
      hideFloatingBar();
      syncDrawingsToServer(currentSymbolRef, chart, false, true);
      showChartToast('Deleted drawing');
    } catch (e) {
      console.warn('Error removing overlay:', e);
    }
  }

  // Delete button on floating toolbar
  floatDeleteBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteSelectedOverlay();
  });

  // Arm/Disarm button on floating toolbar (Immediate trigger arm/disarm)
  floatArmBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!selectedOverlay) return;

    // 1. Line Tools (Trend Line, Ray Line, Extended Line, Horizontal Line) -> Immediate Arm/Deactivate Toggle
    if (isLineOverlay(selectedOverlay.name) && window.__lineTradingManager) {
      const isArmed = window.__lineTradingManager.toggleLineArmed(selectedOverlay.id);
      const line = window.__lineTradingManager.getLineConfig(selectedOverlay.id);
      const name = line?.name || 'Line Trigger';
      const dir = line?.direction || 'BUY';
      const lots = line?.volume || (typeof getGlobalLot === 'function' ? getGlobalLot() : 1.0);

      floatArmBtn.classList.toggle('armed', isArmed);
      floatArmBtn.classList.remove('buy', 'sell');
      if (isArmed && line) {
        if (dir === 'BUY') floatArmBtn.classList.add('buy');
        else if (dir === 'SELL') floatArmBtn.classList.add('sell');
        showChartToast(`⚡ ACTIVE: ${name} (${dir} ${Number(lots).toFixed(2)}L)`);
      } else {
        showChartToast(`⚪ DEACTIVATED: ${name}`);
      }
      floatArmBtn.title = isArmed ? '⚡ ACTIVE / ARMED (Click to Deactivate)' : '⚪ DEACTIVATED (Click to Activate)';
      return;
    }

    if (selectedOverlay.name !== 'longPosition' && selectedOverlay.name !== 'shortPosition') return;

    selectedOverlay.extendData = selectedOverlay.extendData || {};
    selectedOverlay.extendData.isArmed = !selectedOverlay.extendData.isArmed;
    const isArmed = selectedOverlay.extendData.isArmed;

    floatArmBtn.classList.toggle('armed', isArmed);
    floatArmBtn.title = isArmed ? '⚡ ARMED (Click to Disarm)' : 'Arm Trade Trigger (Click to Arm)';

    // Trigger overlay redraw immediately with new armed styling
    chart.overrideOverlay({
      id: selectedOverlay.id,
      extendData: selectedOverlay.extendData
    });

    syncDrawingsToServer(currentSymbolRef, chart, false, true);

    const isLong = (selectedOverlay.name === 'longPosition');
    const side = isLong ? 'BUY' : 'SELL';
    const p0Val = Number(selectedOverlay.points?.[0]?.value) || 0;
    const lots = getGlobalLot();

    if (isArmed) {
      showChartToast(`⚡ Armed ${side} ${lots.toFixed(2)}L @ $${p0Val.toFixed(2)}`);
    } else {
      showChartToast(`⚪ Disarmed ${side} Trigger`);
    }
  });

  const rectQuickAlarmBtn = document.getElementById('tvRectQuickAlarmBtn');

  function toggleRectBothTelegramAlarm(rectOverlay) {
    if (!rectOverlay) return;
    rectOverlay.extendData = rectOverlay.extendData || {};
    const isCurrentlyArmed = (rectOverlay.extendData.alarmMode === 'BOTH' && Boolean(rectOverlay.extendData.telegramAlert));

    if (isCurrentlyArmed) {
      // Disarm to OFF
      rectOverlay.extendData.alarmMode = 'OFF';
      rectOverlay.extendData.telegramAlert = false;

      if (floatRectAlarmBtn) {
        floatRectAlarmBtn.classList.remove('armed');
        floatRectAlarmBtn.title = 'Activate Alarm (BOTH In & Out + Telegram)';
      }
      if (rectQuickAlarmBtn) rectQuickAlarmBtn.classList.remove('active');
      updateRectAlarmButtonsUI('OFF');
      const tgCheck = document.getElementById('tvRectTelegramCheck');
      if (tgCheck) tgCheck.checked = false;

      showChartToast('⚪ Box Alarm Disarmed (OFF)');
    } else {
      // Immediately activate BOTH in and out + Telegram
      window.__allAlarmsDeactivated = false;
      rectOverlay.extendData.alarmMode = 'BOTH';
      rectOverlay.extendData.telegramAlert = true;
      rectOverlay.extendData._lastInside = undefined;

      if (floatRectAlarmBtn) {
        floatRectAlarmBtn.classList.add('armed');
        floatRectAlarmBtn.title = '🔔 ALARM ARMED (BOTH + Telegram) - Click to Disarm';
      }
      if (rectQuickAlarmBtn) rectQuickAlarmBtn.classList.add('active');
      updateRectAlarmButtonsUI('BOTH');
      const tgCheck = document.getElementById('tvRectTelegramCheck');
      if (tgCheck) tgCheck.checked = true;

      playAlarmChime();
      showChartToast('🔔 Box Alarm Armed: BOTH In & Out (Telegram + PC)!');
    }

    // Redraw overlay on chart immediately
    chart.overrideOverlay({
      id: rectOverlay.id,
      extendData: rectOverlay.extendData
    });

    syncDrawingsToServer(currentSymbolRef, chart, false, true);
  }

  // Immediate Alarm button on floating toolbar (on the right of settings gear for rectangle)
  floatRectAlarmBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!selectedOverlay || selectedOverlay.name !== 'rect') return;
    toggleRectBothTelegramAlarm(selectedOverlay);
  });

  // Immediate Alarm button in rectangle settings modal header
  rectQuickAlarmBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!selectedOverlay || selectedOverlay.name !== 'rect') return;
    toggleRectBothTelegramAlarm(selectedOverlay);
  });

  function toggleVerticalLineAlarm(vertOverlay) {
    if (!vertOverlay || vertOverlay.name !== 'verticalStraightLine') return;
    vertOverlay.extendData = vertOverlay.extendData || {};
    const isCurrentlyArmed = Boolean(vertOverlay.extendData.alarmActive);

    if (isCurrentlyArmed) {
      // Disarm
      vertOverlay.extendData.alarmActive = false;
      if (floatVertAlarmBtn) {
        floatVertAlarmBtn.classList.remove('armed');
        floatVertAlarmBtn.title = 'Activate Time Alarm (PC & Mobile)';
      }
      showChartToast('⚪ Vertical Line Alarm Disarmed');
    } else {
      // Arm
      window.__allAlarmsDeactivated = false;
      vertOverlay.extendData.alarmActive = true;
      vertOverlay.extendData.telegramAlert = true;
      vertOverlay.extendData.armedAt = Date.now();
      vertOverlay.extendData.alerted = false;

      if (floatVertAlarmBtn) {
        floatVertAlarmBtn.classList.add('armed');
        floatVertAlarmBtn.title = '🔔 TIME ALARM ARMED (PC & Mobile) - Click to Disarm';
      }
      playAlarmChime();

      const pt0 = vertOverlay.points?.[0];
      const timeStr = pt0?.timestamp ? new Date(pt0.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '';
      showChartToast(`🔔 Vertical Line Time Alarm Armed${timeStr ? ' for ' + timeStr : ''} (PC & Mobile)!`);
    }

    chart.overrideOverlay({
      id: vertOverlay.id,
      extendData: vertOverlay.extendData
    });

    syncDrawingsToServer(currentSymbolRef, chart, false, true);
  }

  // Immediate Time Alarm button on floating toolbar (on the right of settings gear for vertical line)
  floatVertAlarmBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!selectedOverlay || selectedOverlay.name !== 'verticalStraightLine') return;
    toggleVerticalLineAlarm(selectedOverlay);
  });

  // Settings button on floating toolbar
  floatSettingsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!selectedOverlay) return;

    const ovName = selectedOverlay.name;

    // 1. Line Tools -> Open Line Trading Settings Modal (applicable to execution lines, not vertical line)
    if (ovName !== 'verticalStraightLine' && isLineOverlay(ovName) && window.__lineTradingManager) {
      window.__lineTradingManager.openSettingsModal(selectedOverlay.id);
      return;
    }

    // 2. Rectangle Box -> Open Rectangle Settings Modal (with Alarms & Price Range)
    if (ovName === 'rect') {
      const rectModal = document.getElementById('tvRectSettingsModal');
      if (rectModal) {
        const p1 = Number(selectedOverlay.points?.[0]?.value) || 0;
        const p2 = Number(selectedOverlay.points?.[1]?.value) || 0;
        const topPrice = Math.max(p1, p2);
        const bottomPrice = Math.min(p1, p2);

        const topEl = document.getElementById('tvRectTopPrice');
        const botEl = document.getElementById('tvRectBottomPrice');
        if (topEl) topEl.textContent = `$${topPrice.toFixed(2)}`;
        if (botEl) botEl.textContent = `$${bottomPrice.toFixed(2)}`;

        // Populate Empirical Structural & Order Flow Metrics
        populateRectMetricsUI(selectedOverlay);

        const curDir = selectedOverlay.extendData?.direction || 'AUTO';
        updateRectDirectionButtonsUI(curDir);

        const curMode = selectedOverlay.extendData?.alarmMode || 'OFF';
        updateRectAlarmButtonsUI(curMode);

        const tgCheck = document.getElementById('tvRectTelegramCheck');
        if (tgCheck) {
          tgCheck.checked = Boolean(selectedOverlay.extendData?.telegramAlert);
        }

        const thisOverlayCheck = document.getElementById('tvRectHideThisOverlayCheck');
        if (thisOverlayCheck) {
          thisOverlayCheck.checked = Boolean(selectedOverlay.extendData?.hideVolumeOverlay);
        }

        const allOverlaysCheck = document.getElementById('tvRectHideAllOverlaysCheck');
        if (allOverlaysCheck) {
          allOverlaysCheck.checked = Boolean(window.__hideAllRectVolumeOverlays);
        }

        const thisArrowsCheck = document.getElementById('tvRectHideArrowsCheck');
        if (thisArrowsCheck) {
          thisArrowsCheck.checked = Boolean(selectedOverlay.extendData?.hideArrows);
        }

        const allRibbonCheck = document.getElementById('tvRectHideRibbonCheck');
        if (allRibbonCheck) {
          allRibbonCheck.checked = Boolean(window.__hideExtensionRibbon);
        }

        const thisFillCheck = document.getElementById('tvRectDisableThisFillCheck');
        if (thisFillCheck) {
          thisFillCheck.checked = Boolean(selectedOverlay.extendData?.disableFill);
        }

        const allFillCheck = document.getElementById('tvRectDisableAllFillCheck');
        if (allFillCheck) {
          allFillCheck.checked = Boolean(window.__disableAllRectFill);
        }

        const isQuickArmed = (curMode === 'BOTH' && Boolean(selectedOverlay.extendData?.telegramAlert));
        if (rectQuickAlarmBtn) rectQuickAlarmBtn.classList.toggle('active', isQuickArmed);

        rectModal.style.display = 'flex';
      }
      return;
    }

    // 3. Position Tool -> Focus Global Lot input on header (No separate lot settings)
    if (ovName === 'longPosition' || ovName === 'shortPosition') {
      const headerInput = document.getElementById('tvHeaderLotInput');
      if (headerInput) {
        headerInput.focus();
        headerInput.select();
      }
      showChartToast(`Global lot is configured on top header (${getGlobalLot().toFixed(2)}L)`);
      return;
    }
  });

  const rectAlarmDescs = {
    OFF: 'Alarm is disabled.',
    INSIDE: '🎯 Alerts when live spot price touches or enters inside this box.',
    OUTSIDE: '🚀 Alerts when live spot price breaks out / leaves this box.',
    BOTH: '⚡ Alerts on BOTH entering and leaving this box.'
  };

  function updateRectDirectionButtonsUI(dir) {
    document.querySelectorAll('.tv-dir-btn').forEach(btn => {
      const isActive = btn.getAttribute('data-dir') === dir;
      btn.classList.toggle('active', isActive);
      btn.style.borderColor = isActive ? '#3b82f6' : '#334155';
      btn.style.background = isActive ? '#1e3a8a' : '#1e293b';
    });
  }

  function populateRectMetricsUI(overlay) {
    if (!overlay) return;
    const chartData = chart?.getDataList?.() || [];
    const volMetrics = computeRectangleVolumeMetrics(overlay, chartData);
    if (!volMetrics) return;

    const favMoveEl = document.getElementById('tvRectFavMove');
    const advMoveEl = document.getElementById('tvRectAdvMove');
    const rangeEl = document.getElementById('tvRectRange');
    const totalVolEl = document.getElementById('tvRectTotalVol');
    const netDeltaEl = document.getElementById('tvRectNetDelta');
    const absorptionEl = document.getElementById('tvRectAbsorption');
    const resultEl = document.getElementById('tvRectResultText');

    if (favMoveEl) favMoveEl.textContent = `+${volMetrics.favMove.toFixed(1)} pts`;
    if (advMoveEl) advMoveEl.textContent = `-${volMetrics.advMove.toFixed(1)} pts`;
    if (rangeEl) rangeEl.textContent = `${volMetrics.R_b.toFixed(2)} pts`;
    if (totalVolEl) totalVolEl.textContent = `${volMetrics.totalVol.toLocaleString()} ticks`;
    if (netDeltaEl) {
      const sign = volMetrics.netDelta > 0 ? '+' : '';
      const pctSign = volMetrics.netDeltaPct > 0 ? '+' : '';
      netDeltaEl.innerHTML = `${sign}${volMetrics.netDelta.toLocaleString()} <span style="font-size:11px; color:#94a3b8; font-weight:600;">(ΔCVD ${sign}${volMetrics.cvdChg})</span>`;
      netDeltaEl.style.color = volMetrics.netDelta > 0 ? '#00e676' : (volMetrics.netDelta < 0 ? '#ff334b' : '#38bdf8');
    }
    if (absorptionEl) {
      absorptionEl.innerHTML = `${volMetrics.absorbPct}% <span style="font-size:10px; color:#94a3b8;">(${volMetrics.absorbLevel})</span>`;
    }
    if (resultEl) {
      resultEl.textContent = volMetrics.resultText;
      resultEl.style.color = volMetrics.resultColor;
    }
  }

  // Direction Buttons Click Listeners
  document.querySelectorAll('.tv-dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.getAttribute('data-dir') || 'AUTO';
      updateRectDirectionButtonsUI(dir);
      if (selectedOverlay && selectedOverlay.name === 'rect') {
        selectedOverlay.extendData = selectedOverlay.extendData || {};
        selectedOverlay.extendData.direction = dir;
        populateRectMetricsUI(selectedOverlay);

        chart.overrideOverlay({
          id: selectedOverlay.id,
          extendData: selectedOverlay.extendData
        });

        if (typeof chart.updatePane === 'function') chart.updatePane(1);
        updateExtensionSeriesRibbon(chart);
        syncDrawingsToServer(currentSymbolRef, chart, false, true);
        showChartToast(`Direction: ${dir}`);
      }
    });
  });

  function updateRectAlarmButtonsUI(mode) {
    document.querySelectorAll('.tv-alarm-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    const descEl = document.getElementById('tvAlarmStatusDesc');
    if (descEl) descEl.textContent = rectAlarmDescs[mode] || rectAlarmDescs.OFF;
  }

  document.querySelectorAll('.tv-alarm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode') || 'OFF';
      updateRectAlarmButtonsUI(mode);
      if (selectedOverlay && selectedOverlay.name === 'rect') {
        selectedOverlay.extendData = selectedOverlay.extendData || {};
        selectedOverlay.extendData.alarmMode = mode;
        selectedOverlay.extendData._lastInside = undefined;

        const isQuickArmed = (mode === 'BOTH' && Boolean(selectedOverlay.extendData.telegramAlert));
        if (floatRectAlarmBtn) {
          floatRectAlarmBtn.classList.toggle('armed', isQuickArmed);
          floatRectAlarmBtn.title = isQuickArmed ? '🔔 ALARM ARMED (BOTH + Telegram) - Click to Disarm' : 'Activate Alarm (BOTH In & Out + Telegram)';
        }
        if (rectQuickAlarmBtn) rectQuickAlarmBtn.classList.toggle('active', isQuickArmed);

        chart.overrideOverlay({
          id: selectedOverlay.id,
          extendData: selectedOverlay.extendData
        });

        syncDrawingsToServer(currentSymbolRef, chart, false, true);
      }
    });
  });

  // Telegram alert checkbox listener
  const tgCheck = document.getElementById('tvRectTelegramCheck');
  tgCheck?.addEventListener('change', () => {
    if (selectedOverlay && selectedOverlay.name === 'rect') {
      selectedOverlay.extendData = selectedOverlay.extendData || {};
      selectedOverlay.extendData.telegramAlert = Boolean(tgCheck.checked);

      const isQuickArmed = (selectedOverlay.extendData.alarmMode === 'BOTH' && Boolean(selectedOverlay.extendData.telegramAlert));
      if (floatRectAlarmBtn) {
        floatRectAlarmBtn.classList.toggle('armed', isQuickArmed);
        floatRectAlarmBtn.title = isQuickArmed ? '🔔 ALARM ARMED (BOTH + Telegram) - Click to Disarm' : 'Activate Alarm (BOTH In & Out + Telegram)';
      }
      if (rectQuickAlarmBtn) rectQuickAlarmBtn.classList.toggle('active', isQuickArmed);

      chart.overrideOverlay({
        id: selectedOverlay.id,
        extendData: selectedOverlay.extendData
      });

      syncDrawingsToServer(currentSymbolRef, chart, false, true);
    }
  });

  // Volume Overlay Visibility Checkboxes (This Box Only / All Boxes)
  const thisBoxOverlayCheck = document.getElementById('tvRectHideThisOverlayCheck');
  thisBoxOverlayCheck?.addEventListener('change', (e) => {
    if (selectedOverlay && selectedOverlay.name === 'rect') {
      selectedOverlay.extendData = selectedOverlay.extendData || {};
      selectedOverlay.extendData.hideVolumeOverlay = e.target.checked;
      chart.overrideOverlay({
        id: selectedOverlay.id,
        extendData: selectedOverlay.extendData
      });
      syncDrawingsToServer(currentSymbolRef, chart, false, true);
      showChartToast(e.target.checked ? 'Volume overlay hidden on this box' : 'Volume overlay visible on this box');
    }
  });

  const allBoxesOverlayCheck = document.getElementById('tvRectHideAllOverlaysCheck');
  allBoxesOverlayCheck?.addEventListener('change', (e) => {
    const isHidden = e.target.checked;
    window.__hideAllRectVolumeOverlays = isHidden;
    try {
      localStorage.setItem('escanor_hide_all_rect_volume', isHidden ? 'true' : 'false');
    } catch (_) {}
    if (typeof chart.getOverlays === 'function') {
      const all = chart.getOverlays() || [];
      all.filter(o => o.name === 'rect').forEach(r => {
        chart.overrideOverlay({ id: r.id });
      });
    }
    showChartToast(isHidden ? 'Volume overlay hidden on ALL boxes' : 'Volume overlay visible on all boxes');
  });

  // Excursion Arrows & Badges Visibility Checkbox
  const thisArrowsCheck = document.getElementById('tvRectHideArrowsCheck');
  thisArrowsCheck?.addEventListener('change', (e) => {
    if (selectedOverlay && selectedOverlay.name === 'rect') {
      selectedOverlay.extendData = selectedOverlay.extendData || {};
      selectedOverlay.extendData.hideArrows = e.target.checked;
      chart.overrideOverlay({
        id: selectedOverlay.id,
        extendData: selectedOverlay.extendData
      });
      syncDrawingsToServer(currentSymbolRef, chart, false, true);
      if (typeof chart.updatePane === 'function') chart.updatePane(1);
      showChartToast(e.target.checked ? 'Arrows & badges hidden on this box' : 'Arrows & badges visible on this box');
    }
  });

  // Top Extension Ribbon Visibility Checkbox
  const allRibbonCheck = document.getElementById('tvRectHideRibbonCheck');
  allRibbonCheck?.addEventListener('change', (e) => {
    const isHidden = e.target.checked;
    window.__hideExtensionRibbon = isHidden;
    try {
      localStorage.setItem('escanor_hide_extension_ribbon', isHidden ? 'true' : 'false');
    } catch (_) {}
    updateExtensionSeriesRibbon(chart);
    if (typeof chart.updatePane === 'function') chart.updatePane(1);
    showChartToast(isHidden ? 'Extension ribbon hidden' : 'Extension ribbon visible');
  });

  // Box Fill Visibility Checkboxes (This Box Only / All Boxes)
  const thisBoxFillCheck = document.getElementById('tvRectDisableThisFillCheck');
  thisBoxFillCheck?.addEventListener('change', (e) => {
    if (selectedOverlay && selectedOverlay.name === 'rect') {
      selectedOverlay.extendData = selectedOverlay.extendData || {};
      selectedOverlay.extendData.disableFill = e.target.checked;
      chart.overrideOverlay({
        id: selectedOverlay.id,
        extendData: selectedOverlay.extendData
      });
      syncDrawingsToServer(currentSymbolRef, chart, false, true);
      if (typeof chart.updatePane === 'function') {
        chart.updatePane(1);
      }
      showChartToast(e.target.checked ? 'Box fill disabled on this box' : 'Box fill enabled on this box');
    }
  });

  const allBoxesFillCheck = document.getElementById('tvRectDisableAllFillCheck');
  allBoxesFillCheck?.addEventListener('change', (e) => {
    const isDisabled = e.target.checked;
    window.__disableAllRectFill = isDisabled;
    try {
      localStorage.setItem('escanor_disable_all_rect_fill', isDisabled ? 'true' : 'false');
    } catch (_) {}
    if (typeof chart.getOverlays === 'function') {
      const all = chart.getOverlays() || [];
      all.filter(o => o.name === 'rect').forEach(r => {
        chart.overrideOverlay({ id: r.id });
      });
    }
    if (typeof chart.updatePane === 'function') {
      chart.updatePane(1);
    }
    showChartToast(isDisabled ? 'Box fill disabled on ALL boxes' : 'Box fill enabled on all boxes');
  });

  // Rectangle Settings Modal Buttons
  document.getElementById('tvCloseRectModalBtn')?.addEventListener('click', () => {
    const rectModal = document.getElementById('tvRectSettingsModal');
    if (rectModal) rectModal.style.display = 'none';
  });

  document.getElementById('tvCloseRectBtn')?.addEventListener('click', () => {
    const rectModal = document.getElementById('tvRectSettingsModal');
    if (rectModal) rectModal.style.display = 'none';
    if (selectedOverlay && selectedOverlay.name === 'rect') {
      const mode = selectedOverlay.extendData?.alarmMode || 'OFF';
      const tg = Boolean(selectedOverlay.extendData?.telegramAlert);

      chart.overrideOverlay({
        id: selectedOverlay.id,
        extendData: selectedOverlay.extendData
      });

      syncDrawingsToServer(currentSymbolRef, chart, false, true);
      const tgNote = tg ? ' (Telegram + PC)' : ' (PC Only)';
      showChartToast(mode === 'OFF' ? 'Rectangle Saved (Alarm OFF)' : `🔔 Box Alarm Armed: ${mode}${tgNote}`);
    }
  });

  document.getElementById('tvDeleteRectBtn')?.addEventListener('click', () => {
    deleteSelectedOverlay();
    const rectModal = document.getElementById('tvRectSettingsModal');
    if (rectModal) rectModal.style.display = 'none';
  });

  // Structural Sample Network Dossier Modal & Extension Series Ribbon Click
  const extRibbon = document.getElementById('tvExtensionSeriesRibbon');
  if (extRibbon) {
    extRibbon.addEventListener('click', (e) => {
      if (e?.target?.closest?.('#tvBoxToggleChip') || e?.target?.id === 'tvBoxToggleChip') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      openExtensionNetworkModal(chart);
    });
  }

  const toggleLinesBtn = document.getElementById('tvToggleInflectionLinesBtn');
  if (toggleLinesBtn) {
    toggleLinesBtn.onclick = (e) => {
      if (e) e.stopPropagation();
      toggleStructuralInflectionLines(chart);
    };
  }

  const networkModal = document.getElementById('tvExtensionNetworkModal');
  const closeNetworkBtn = document.getElementById('tvCloseNetworkModalBtn');
  const closeNetworkBtnDone = document.getElementById('tvCloseNetworkModalBtnDone');

  function closeNetworkModal() {
    if (networkModal) networkModal.style.display = 'none';
  }
  closeNetworkBtn?.addEventListener('click', closeNetworkModal);
  closeNetworkBtnDone?.addEventListener('click', closeNetworkModal);
  if (networkModal) {
    networkModal.addEventListener('click', (e) => {
      if (e.target === networkModal) closeNetworkModal();
    });
  }

  // Unified Global Lot Settings Logic
  function getGlobalLot() {
    const val = parseFloat(localStorage.getItem('escanor_global_lot') || localStorage.getItem('escanor_measure_lots') || '1.00');
    return isNaN(val) ? 1.00 : Math.max(0.01, Math.min(100.0, val));
  }
  window.getGlobalLot = getGlobalLot;

  function setGlobalLot(val, chartRef) {
    const num = parseFloat(val);
    const finalVal = (isNaN(num) ? 1.00 : Math.max(0.01, Math.min(100.0, num))).toFixed(2);
    localStorage.setItem('escanor_global_lot', finalVal);
    localStorage.setItem('escanor_measure_lots', finalVal);
    localStorage.setItem('escanor_line_trading_lots', finalVal);

    const input = document.getElementById('tvHeaderLotInput');
    if (input && document.activeElement !== input) {
      input.value = finalVal;
    }

    // Update active state on header lot pills
    document.querySelectorAll('.tv-top-lot-pill').forEach(pill => {
      const pVal = parseFloat(pill.getAttribute('data-lot') || '0').toFixed(2);
      pill.classList.toggle('active', pVal === finalVal);
    });

    // Force re-render of chart overlays so position tools reflect updated lot size and recalculate dollars
    const c = chartRef || chart;
    if (c && typeof c.getOverlays === 'function') {
      const all = c.getOverlays() || [];
      all.filter(o => o.name === 'longPosition' || o.name === 'shortPosition').forEach(o => {
        c.overrideOverlay({ id: o.id, extendData: { ...(o.extendData || {}), _refresh: Date.now() } });
      });
    }

    // Notify Line Trading engine if available
    if (window.lineTrading && typeof window.lineTrading.updateAllVolumes === 'function') {
      window.lineTrading.updateAllVolumes(parseFloat(finalVal));
    }

    showChartToast(`Global Trade Lot: ${finalVal}L`);
  }
  window.setGlobalLot = setGlobalLot;

  // Initialize Header Lot Input and Quick Pills
  const initialLot = getGlobalLot();
  const headerLotInp = document.getElementById('tvHeaderLotInput');
  if (headerLotInp) {
    headerLotInp.value = initialLot.toFixed(2);
    headerLotInp.addEventListener('change', (e) => {
      setGlobalLot(e.target.value, chart);
    });
    headerLotInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        setGlobalLot(e.target.value, chart);
        headerLotInp.blur();
      }
    });
  }

  document.querySelectorAll('.tv-top-lot-pill').forEach(pill => {
    const pVal = parseFloat(pill.getAttribute('data-lot') || '0').toFixed(2);
    pill.classList.toggle('active', pVal === initialLot.toFixed(2));

    pill.addEventListener('click', () => {
      const lotVal = pill.getAttribute('data-lot');
      if (headerLotInp) headerLotInp.value = parseFloat(lotVal).toFixed(2);
      setGlobalLot(lotVal, chart);
    });
  });

  // Draggable Floating Toolbar Handle & Body
  let isDraggingBar = false;
  let dragOffset = { x: 0, y: 0 };

  function startDraggingBar(clientX, clientY) {
    isDraggingBar = true;
    floatingBar.classList.add('dragging');
    const barRect = floatingBar.getBoundingClientRect();
    dragOffset.x = clientX - barRect.left;
    dragOffset.y = clientY - barRect.top;
  }

  function moveDraggingBar(clientX, clientY) {
    if (!isDraggingBar || !floatingBar) return;
    const barWidth = floatingBar.offsetWidth || 116;
    const barHeight = floatingBar.offsetHeight || 36;

    let newLeft = clientX - dragOffset.x;
    let newTop = clientY - dragOffset.y;

    // Clamp strictly within viewport
    newLeft = Math.max(10, Math.min(window.innerWidth - barWidth - 10, newLeft));
    newTop = Math.max(10, Math.min(window.innerHeight - barHeight - 10, newTop));

    floatingBar.style.left = `${newLeft}px`;
    floatingBar.style.top = `${newTop}px`;
  }

  function stopDraggingBar() {
    if (!isDraggingBar) return;
    isDraggingBar = false;
    if (floatingBar) {
      floatingBar.classList.remove('dragging');
      const left = parseFloat(floatingBar.style.left) || floatingBar.offsetLeft;
      const top = parseFloat(floatingBar.style.top) || floatingBar.offsetTop;
      saveToolbarPosition(left, top);
    }
  }

  // Allow dragging by the drag handle OR any non-button area of the floating toolbar
  floatingBar?.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tv-float-btn') || e.target.closest('button')) {
      return;
    }
    startDraggingBar(e.clientX, e.clientY);
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (isDraggingBar) {
      moveDraggingBar(e.clientX, e.clientY);
    }
  });

  window.addEventListener('mouseup', () => {
    stopDraggingBar();
    if (window.__lineTradingManager) {
      window.__lineTradingManager.setDragging(false);
    }
  });

  // Touch drag support
  floatingBar?.addEventListener('touchstart', (e) => {
    if (e.target.closest('.tv-float-btn') || e.target.closest('button')) return;
    if (e.touches && e.touches[0]) {
      startDraggingBar(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (isDraggingBar && e.touches && e.touches[0]) {
      moveDraggingBar(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    stopDraggingBar();
    if (window.__lineTradingManager) {
      window.__lineTradingManager.setDragging(false);
    }
  });

  window.addEventListener('resize', () => {
    if (floatingBar && floatingBar.style.display !== 'none') {
      applyFloatingBarPosition();
    }
  });

  // =========================================================================
  // ⌨️ KEYBOARD SHORTCUTS
  // =========================================================================

  window.addEventListener('keydown', (e) => {
    const isAltActive = Boolean(e.altKey || (typeof e.getModifierState === 'function' && (e.getModifierState('Alt') || e.getModifierState('AltGraph'))));

    // Let trading hotkeys (Alt+PageUp, Alt+PageDown, Alt+End, Alt+B, Alt+Home) pass directly to app.js
    if (isAltActive && (['PageUp', 'PageDown', 'End', 'b', 'B', 'Home'].includes(e.key) || ['PageUp', 'PageDown', 'End', 'KeyB', 'Home'].includes(e.code))) {
      return;
    }

    const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (isTyping) return;

    // 1. Backspace & Delete removes selected item
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (selectedOverlay) {
        e.preventDefault();
        deleteSelectedOverlay();
      }
    }

    // 2. Escape cancels active tool, closes modals & floating bar
    if (e.key === 'Escape') {
      setActive(toolCrosshair, 'crosshair');
      hideFloatingBar();
      if (settingsModal) settingsModal.style.display = 'none';
      const confirmModal = document.getElementById('tvConfirmModal');
      if (confirmModal) confirmModal.style.display = 'none';
      const networkModal = document.getElementById('tvExtensionNetworkModal');
      if (networkModal) networkModal.style.display = 'none';
    }

    // 3. 'R' or 'Alt+R' -> Shortcut to draw rectangle
    if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setActive(toolBoxBtn, 'rect');
      createDrawing('rect');
      showChartToast('Rectangle Tool (R)');
    }

    // 4. 'T' or 'Alt+T' or 'L' -> Shortcut to trigger line tool
    if ((e.key === 't' || e.key === 'T' || e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setActive(toolLinesBtn, 'segment');
      createDrawing('segment');
      showChartToast('Trend Line Tool');
    }

    // 5. 'H' or 'Alt+H' -> Shortcut for Horizontal line
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setActive(toolLinesBtn, 'horizontalStraightLine');
      createDrawing('horizontalStraightLine');
      showChartToast('Horizontal Line (H)');
    }
    // 6. 'M' or 'Alt+M' -> Shortcut to trigger measureBox tool
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !isAltActive) {
      e.preventDefault();
      createDrawing('measureBox');
      showChartToast('Measure Tool (M or Shift+Drag)');
    }

    // 7. Alt + Q -> Shortcut for Long Position tool (Left or Right Alt)
    if (isAltActive && (e.key === 'q' || e.key === 'Q') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setActive(toolLongPosBtn, 'longPosition');
      createDrawing('longPosition');
      showChartToast('Long Position Tool (Alt+Q)');
    }

    // 8. Alt + W -> Shortcut for Short Position tool (Left or Right Alt)
    if (isAltActive && (e.key === 'w' || e.key === 'W') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setActive(toolShortPosBtn, 'shortPosition');
      createDrawing('shortPosition');
      showChartToast('Short Position Tool (Alt+W)');
    }

    // 9. Alt + V -> Shortcut for Vertical Line tool (Left or Right Alt)
    if (isAltActive && (e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setActive(toolLinesBtn, 'verticalStraightLine');
      createDrawing('verticalStraightLine');
      showChartToast('Vertical Line Tool (Alt+V)');
    }
  });

  // 7. Shift + Drag anywhere on chart canvas triggers Measurement Tool
  // When clicking anywhere without Shift, measurement ruler is auto-removed (same as TradingView)
  const chartCanvas = document.getElementById('klineChart');
  chartCanvas?.addEventListener('mousedown', (e) => {
    if (e.shiftKey && e.button === 0) {
      createDrawing('measureBox');
    } else if (activeTool !== 'measureBox') {
      const all = chart.getOverlays() || [];
      const measures = all.filter(o => o.name === 'measureBox');
      if (measures.length > 0) {
        measures.forEach(m => chart.removeOverlay({ id: m.id }));
      }
    }
  });

  // Ensure default active tool is strictly crosshair on initialization
  setActive(toolCrosshair, 'crosshair');
}

// =========================================================================
// 🔔 RECTANGLE ALARMS EVALUATION & PC WEB AUDIO CHIME
// =========================================================================

let alarmAudioCtx = null;

export function playAlarmChime() {
  if (window.__allAlarmsDeactivated === true) {
    return;
  }
  try {
    if (!alarmAudioCtx) {
      alarmAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (alarmAudioCtx.state === 'suspended') {
      alarmAudioCtx.resume();
    }
    const now = alarmAudioCtx.currentTime;
    const osc1 = alarmAudioCtx.createOscillator();
    const osc2 = alarmAudioCtx.createOscillator();
    const gain = alarmAudioCtx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(587.33, now);        // D5
    osc1.frequency.setValueAtTime(880, now + 0.12);     // A5
    osc2.frequency.setValueAtTime(880, now + 0.12);

    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(alarmAudioCtx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.60);
    osc2.stop(now + 0.60);
  } catch (e) {
    console.warn('[Alarm Audio] Play failed:', e);
  }
}

async function dispatchTelegramBoxAlarm(eventTitle, spot, bottom, top, mode) {
  if (window.__allAlarmsDeactivated === true) return;
  try {
    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
    const msg = `🚨 <b>ESCANOR BOX PRICE ALARM</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `<b>Alert:</b> ${eventTitle}\n` +
      `<b>Asset:</b> Gold ($XAUUSD$)\n` +
      `<b>Live Spot:</b> $${spot.toFixed(2)}\n` +
      `<b>Box Ceiling:</b> $${top.toFixed(2)}\n` +
      `<b>Box Floor:</b> $${bottom.toFixed(2)}\n` +
      `<b>Alarm Mode:</b> ${mode}\n` +
      `<b>Time:</b> ${timeStr}\n` +
      `━━━━━━━━━━━━━━━━━━`;

    await fetch('/api/telegram/send_alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
  } catch (err) {
    console.warn('[Telegram Alarm] Dispatch failed:', err);
  }
}

export function evaluateRectangleAlarms(spot, chartRef) {
  if (window.__allAlarmsDeactivated === true) return;
  if (!chartRef || !spot || typeof spot !== 'number' || isNaN(spot)) return;
  const overlays = chartRef.getOverlays() || [];
  const rects = overlays.filter(o => o.name === 'rect' && o.extendData?.alarmMode && o.extendData.alarmMode !== 'OFF');
  if (rects.length === 0) return;

  const now = Date.now();

  for (const rect of rects) {
    if (!rect.points || rect.points.length < 2) continue;
    const vals = rect.points.map(p => Number(p.value)).filter(v => !isNaN(v) && v > 0);
    if (vals.length === 0) continue;
    const top = Math.max(...vals);
    const bottom = Math.min(...vals);
    const mode = rect.extendData.alarmMode;
    const isTgEnabled = Boolean(rect.extendData.telegramAlert);

    const isInside = (spot >= bottom && spot <= top);
    const wasInside = rect.extendData._lastInside;

    if (wasInside === undefined) {
      rect.extendData._lastInside = isInside;
      continue;
    }

    const canFire = !rect.extendData._lastFired || (now - rect.extendData._lastFired > 8000);

    // 1. Entering / Hitting Box
    if (!wasInside && isInside && (mode === 'INSIDE' || mode === 'BOTH')) {
      if (canFire) {
        rect.extendData._lastFired = now;
        playAlarmChime();
        const toastMsg = `🎯 PRICE ENTERED BOX! Spot $${spot.toFixed(2)} in [$${bottom.toFixed(2)} - $${top.toFixed(2)}]`;
        showChartToast(toastMsg);
        if (isTgEnabled) {
          dispatchTelegramBoxAlarm(`🎯 Price ENTERED Box`, spot, bottom, top, mode);
        }
      }
    }
    // 2. Breaking out / Out of Box
    else if (wasInside && !isInside && (mode === 'OUTSIDE' || mode === 'BOTH')) {
      if (canFire) {
        rect.extendData._lastFired = now;
        playAlarmChime();
        const breakoutDir = spot > top ? `Broke ABOVE Ceiling ($${top.toFixed(2)})` : `Broke BELOW Floor ($${bottom.toFixed(2)})`;
        const toastMsg = `🚀 PRICE OUT OF BOX! Spot $${spot.toFixed(2)} ${breakoutDir}`;
        showChartToast(toastMsg);
        if (isTgEnabled) {
          dispatchTelegramBoxAlarm(`🚀 Price OUT OF BOX (${breakoutDir})`, spot, bottom, top, mode);
        }
      }
    }

    rect.extendData._lastInside = isInside;
  }
}

// =========================================================================
// ⏰ VERTICAL LINE TIME ALARMS EVALUATION (PC & MOBILE)
// =========================================================================

async function dispatchTelegramVertAlarm(spot, lineTimestamp) {
  try {
    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
    const lineDateStr = lineTimestamp ? new Date(lineTimestamp).toLocaleTimeString('en-US', { hour12: false }) : 'Now';
    const spotStr = (typeof spot === 'number' && !isNaN(spot)) ? `$${spot.toFixed(2)}` : '--';
    const msg = `⏰ <b>ESCANOR VERTICAL LINE TIME ALARM</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `<b>Event:</b> Vertical Line Touched / Time Gate Reached\n` +
      `<b>Asset:</b> Gold ($XAUUSD$)\n` +
      `<b>Live Spot:</b> ${spotStr}\n` +
      `<b>Line Time:</b> ${lineDateStr}\n` +
      `<b>Triggered At:</b> ${timeStr}\n` +
      `━━━━━━━━━━━━━━━━━━`;

    await fetch('/api/telegram/send_alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
  } catch (err) {
    console.warn('[Telegram Alarm] Vertical line dispatch failed:', err);
  }
}

export function evaluateVerticalLineAlarms(spot, chartRef) {
  if (window.__allAlarmsDeactivated === true) return;
  if (!chartRef) return;
  const overlays = chartRef.getOverlays() || [];
  const armedLines = overlays.filter(o => o.name === 'verticalStraightLine' && o.extendData?.alarmActive && !o.extendData.alerted);
  if (armedLines.length === 0) return;

  const now = Date.now();

  // Boot settling guard: on page load/reload, wait at least 3 seconds before evaluating alarms.
  // Also auto-disarm any lines whose target timestamp has already passed, so they never fire false alarms on reload.
  if (window.__pageBootTime && (now - window.__pageBootTime < 3000)) {
    for (const line of armedLines) {
      const pt0 = line.points?.[0];
      const lineTimestamp = pt0?.timestamp;
      if (typeof lineTimestamp === 'number' && lineTimestamp <= now) {
        line.extendData.alarmActive = false;
        line.extendData.alerted = true;
        chartRef.overrideOverlay({ id: line.id, extendData: line.extendData });
      }
    }
    return;
  }

  const dataList = chartRef.getDataList ? (chartRef.getDataList() || []) : [];
  const latestBar = dataList.length > 0 ? dataList[dataList.length - 1] : null;

  for (const line of armedLines) {
    const pt0 = line.points?.[0];
    if (!pt0) continue;

    const lineTimestamp = pt0.timestamp;
    const lineDataIndex = pt0.dataIndex;
    const armedAt = line.extendData?.armedAt || 0;

    // Stale guard: if line timestamp was already in the past when armed, disarm silently
    if (armedAt > 0 && typeof lineTimestamp === 'number' && lineTimestamp < (armedAt - 60000)) {
      line.extendData.alarmActive = false;
      line.extendData.alerted = true;
      chartRef.overrideOverlay({ id: line.id, extendData: line.extendData });
      continue;
    }

    let isTouched = false;

    // 1. If timestamp is set, check if current time or latest bar timestamp reached/exceeded it
    if (typeof lineTimestamp === 'number' && lineTimestamp > 0) {
      if (now >= lineTimestamp || (latestBar && latestBar.timestamp >= lineTimestamp)) {
        isTouched = true;
      }
    } else if (typeof lineDataIndex === 'number' && dataList.length > 0) {
      // 2. Fallback to candle index only if timestamp is not specified
      if ((dataList.length - 1) >= lineDataIndex) {
        isTouched = true;
      }
    }

    if (isTouched) {
      line.extendData.alerted = true;
      line.extendData.alarmActive = false;
      line.extendData._triggeredAt = now;

      // Alert PC (Chime + Toast)
      playAlarmChime();
      const timeFormatted = lineTimestamp ? new Date(lineTimestamp).toLocaleTimeString('en-US', { hour12: false }) : '';
      showChartToast(`⏰ VERTICAL LINE REACHED${timeFormatted ? ' (' + timeFormatted + ')' : ''}! Time event touched.`);

      // Alert Mobile via Telegram
      dispatchTelegramVertAlarm(spot, lineTimestamp);

      // Redraw overlay on chart immediately
      chartRef.overrideOverlay({
        id: line.id,
        extendData: line.extendData
      });

      // Update floating toolbar button if currently selected
      const floatVertAlarmBtn = document.getElementById('tvFloatVertAlarmBtn');
      if (floatVertAlarmBtn && window.__selectedOverlay && window.__selectedOverlay.id === line.id) {
        floatVertAlarmBtn.classList.remove('armed');
        floatVertAlarmBtn.title = 'Activate Time Alarm (PC & Mobile)';
      }

      syncDrawingsToServer(window.__currentSymbol || 'XAUUSD', chartRef, false, true);
    }
  }
}
window.evaluateVerticalLineAlarms = evaluateVerticalLineAlarms;

// =========================================================================
// ⚡ POSITION TOOL IMMEDIATE EXECUTION ENGINE (TOUCH TRIGGER)
// =========================================================================

let lastPosEvalBid = null;
let lastPosEvalAsk = null;

export function evaluatePositionTriggers(bid, ask, chartRef) {
  if (window.__allAlarmsDeactivated === true) return;
  if (window.__isDrawdownLocked) return;
  if (!chartRef || typeof bid !== 'number' || typeof ask !== 'number') return;
  const overlays = chartRef.getOverlays() || [];
  const armedPositions = overlays.filter(o => 
    (o.name === 'longPosition' || o.name === 'shortPosition') &&
    o.extendData && o.extendData.isArmed
  );

  if (armedPositions.length === 0) {
    lastPosEvalBid = bid;
    lastPosEvalAsk = ask;
    return;
  }

  // USER RULE: "only one trade should be active at a time even it touches any line"
  const hasActivePositions = (window.__lastActivePositions && window.__lastActivePositions.length > 0) ||
                             (window.__lineTradingManager && window.__lineTradingManager.activePositions && window.__lineTradingManager.activePositions.length > 0);
  if (hasActivePositions) {
    lastPosEvalBid = bid;
    lastPosEvalAsk = ask;
    return;
  }

  const prevBid = (typeof lastPosEvalBid === 'number') ? lastPosEvalBid : bid;
  const prevAsk = (typeof lastPosEvalAsk === 'number') ? lastPosEvalAsk : ask;

  for (const pos of armedPositions) {
    const isLong = (pos.name === 'longPosition');
    const p0Val = Number(pos.points?.[0]?.value) || 0; // Entry trigger coordinate
    const p1Val = Number(pos.points?.[1]?.value) || 0; // Target (TP)
    const p2Val = Number(pos.points?.[2]?.value) || 0; // Stop Loss (SL)

    if (p0Val <= 0) continue;

    let triggered = false;
    // Long triggers when Ask touches or crosses entry trigger price
    // Short triggers when Bid touches or crosses entry trigger price
    if (isLong) {
      const minP = Math.min(prevAsk, ask);
      const maxP = Math.max(prevAsk, ask);
      if ((p0Val >= minP && p0Val <= maxP) || Math.abs(ask - p0Val) <= 0.01) {
        triggered = true;
      }
    } else {
      const minP = Math.min(prevBid, bid);
      const maxP = Math.max(prevBid, bid);
      if ((p0Val >= minP && p0Val <= maxP) || Math.abs(bid - p0Val) <= 0.01) {
        triggered = true;
      }
    }

    if (triggered) {
      if (window.__isDrawdownLocked) {
        pos.extendData.isArmed = false;
        chartRef.overrideOverlay({ id: pos.id, extendData: pos.extendData });
        syncDrawingsToServer(currentSymbolRef, chartRef, false, true);
        showChartToast('⛔ DAILY DRAWDOWN HIT ($0.00). Position trigger blocked.');
        return;
      }

      // 1. Immediately disarm to prevent duplicate firing
      pos.extendData.isArmed = false;
      chartRef.overrideOverlay({ id: pos.id, extendData: pos.extendData });
      syncDrawingsToServer(currentSymbolRef, chartRef, false, true);

      // If this position is currently selected, update the toolbar arm button
      const floatArmBtn = document.getElementById('tvFloatArmBtn');
      if (floatArmBtn && selectedOverlay && selectedOverlay.id === pos.id) {
        floatArmBtn.classList.remove('armed');
        floatArmBtn.title = 'Arm Trade Trigger (DISARMED)';
      }

      // 2. Mark active trade trigger time so header timer activates immediately
      window.__activeTradeTriggerTime = Date.now();
      window.__posActiveClientStart = Date.now();
      if (typeof window.updateActiveTradeTimerUI === 'function') {
        window.updateActiveTradeTimerUI(window.__lastActivePositions || []);
      }

      // 3. Parameters
      const lots = getGlobalLot();
      const side = isLong ? 'BUY' : 'SELL';
      const slPrice = Math.round(p2Val * 100) / 100;
      const tpPrice = Math.round(p1Val * 100) / 100;

      playAlarmChime();
      showChartToast(`⚡ ${side} Trigger Hit @ $${p0Val.toFixed(2)}! Executing ${lots.toFixed(2)}L...`);

      // 4. Execute on MT5
      fetch('/api/trade/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: currentSymbolRef || 'XAUUSD',
          side: side,
          volume: lots,
          sl: slPrice,
          tp: tpPrice,
          comment: `Escanor ${side} Trigger`
        })
      })
      .then(res => res.json())
      .then(data => {
        const isOk = data && (data.status === 'EXECUTED' || data.status === 'OK' || data.ticket);
        if (isOk) {
          const tkt = data.ticket || data.order || 'FILLED';
          showChartToast(`🚀 ${side} ${lots.toFixed(2)}L Executed! Ticket #${tkt}`);
        } else {
          showChartToast(`⚠️ Trade Trigger Exec Error: ${data.error || data.message || 'Failed'}`);
        }
      })
      .catch(err => {
        showChartToast(`⚠️ Trade Exec Failed: ${err.message}`);
      });

      // 5. Send Telegram alert
      try {
        const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
        const tgMsg = `⚡ <b>ESCANOR TRADE TRIGGER EXECUTED</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `<b>Action:</b> ${side} ${lots.toFixed(2)} Lots\n` +
          `<b>Asset:</b> Gold ($XAUUSD$)\n` +
          `<b>Trigger Price:</b> $${p0Val.toFixed(2)}\n` +
          `<b>Stop Loss:</b> $${slPrice.toFixed(2)}\n` +
          `<b>Take Profit:</b> $${tpPrice.toFixed(2)}\n` +
          `<b>Time:</b> ${timeStr}\n` +
          `━━━━━━━━━━━━━━━━━━`;
        fetch('/api/telegram/send_alert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: tgMsg })
        }).catch(() => {});
      } catch (e) {}
    }
  }

  lastPosEvalBid = bid;
  lastPosEvalAsk = ask;
}

