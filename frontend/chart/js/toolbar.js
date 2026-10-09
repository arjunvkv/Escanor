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

import { syncDrawingsToServer, showChartToast } from './drawings_storage.js';

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

  // 4. Measure Ruler Tool
  toolMeasureBtn?.addEventListener('click', () => {
    setActive(toolMeasureBtn, 'measureBox');
    createDrawing('measureBox');
  });

  // 5. Delete Tool Button on Left Dock
  toolDeleteBtn?.addEventListener('click', () => {
    if (selectedOverlay) {
      deleteSelectedOverlay();
    } else {
      const all = chart.getOverlays() || [];
      if (all.length > 0) {
        showTvConfirm('Clear Chart Drawings', `Remove all ${all.length} drawings on chart?`, () => {
          all.forEach(ov => chart.removeOverlay(ov.id));
          syncDrawingsToServer(currentSymbolRef, chart);
          hideFloatingBar();
          showChartToast('Cleared all drawings');
        });
      }
    }
  });

  // Create Drawing with Shift Snapping & Event Hooks
  function createDrawing(overlayName) {
    try {
      chart.createOverlay({
        name: overlayName,
        onDrawEnd: () => {
          syncDrawingsToServer(currentSymbolRef, chart);
          setActive(toolCrosshair, 'crosshair');
        },
        performEventPressedMove: ({ points, performPointIndex }) => {
          // If Shift is pressed, lock to horizontal level
          if (window.__isShiftPressed && points.length >= 2 && performPointIndex === 1) {
            points[1].value = points[0].value;
          }
        },
        onSelected: (event) => {
          handleOverlaySelected(event);
        },
        onDeselected: () => {
          handleOverlayDeselected();
        }
      });
    } catch (err) {
      console.error('[Escanor Toolbar] Create overlay failed:', err);
    }
  }

  // Wrap global createOverlay to ensure all restored & created overlays support selection & shift lock
  const origCreateOverlay = chart.createOverlay.bind(chart);
  chart.createOverlay = function (params) {
    const customParams = {
      ...params,
      performEventPressedMove: (args) => {
        if (params.performEventPressedMove) params.performEventPressedMove(args);
        if (window.__isShiftPressed && args.points?.length >= 2 && args.performPointIndex === 1) {
          args.points[1].value = args.points[0].value;
        }
      },
      onSelected: (event) => {
        if (params.onSelected) params.onSelected(event);
        handleOverlaySelected(event);
      },
      onDeselected: (event) => {
        if (params.onDeselected) params.onDeselected(event);
        handleOverlayDeselected();
      }
    };
    return origCreateOverlay(customParams);
  };

  // =========================================================================
  // 🎛️ FLOATING ACTION TOOLBAR (MATCHES IMAGE 2)
  // =========================================================================

  function handleOverlaySelected(event) {
    selectedOverlay = event.overlay;
    if (!selectedOverlay) return;

    // Show floating bar
    floatingBar.style.display = 'flex';

    // Position floating bar near the top-center of the viewport or above cursor
    const chartEl = document.getElementById('klineChart');
    const rect = chartEl.getBoundingClientRect();

    let posX = (event.x || event.pageX || (rect.left + rect.width / 2)) - 50;
    let posY = (event.y || event.pageY || (rect.top + 80)) - 45;

    posX = Math.max(rect.left + 60, Math.min(rect.right - 140, posX));
    posY = Math.max(rect.top + 10, Math.min(rect.bottom - 60, posY));

    floatingBar.style.left = `${posX}px`;
    floatingBar.style.top = `${posY}px`;
  }

  function handleOverlayDeselected() {
    selectedOverlay = null;
    hideFloatingBar();
  }

  function hideFloatingBar() {
    if (floatingBar) floatingBar.style.display = 'none';
  }

  function deleteSelectedOverlay() {
    if (!selectedOverlay) return;
    try {
      chart.removeOverlay(selectedOverlay.id);
      selectedOverlay = null;
      hideFloatingBar();
      syncDrawingsToServer(currentSymbolRef, chart);
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

  // Settings button on floating toolbar
  floatSettingsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!selectedOverlay) return;

    // Populate current styles
    const styles = selectedOverlay.styles || {};
    if (settingColor) settingColor.value = styles.borderColor || styles.color || '#2962ff';
    if (settingWidth) settingWidth.value = String(styles.borderSize || styles.size || 1);
    if (settingFillColor) settingFillColor.value = styles.color || '#2962ff';

    settingsModal.style.display = 'flex';
  });

  closeSettingsBtn?.addEventListener('click', () => {
    settingsModal.style.display = 'none';
  });

  saveSettingsBtn?.addEventListener('click', () => {
    if (selectedOverlay) {
      const col = settingColor?.value || '#2962ff';
      const size = Number(settingWidth?.value || 1);
      const isDashed = settingLineStyle?.value === 'dashed';

      const newStyles = {
        color: col,
        borderColor: col,
        borderSize: size,
        size: size,
        borderStyle: isDashed ? 'dashed' : 'solid',
        style: isDashed ? 'dashed' : 'solid'
      };

      try {
        chart.overrideOverlay({
          id: selectedOverlay.id,
          styles: newStyles
        });
        syncDrawingsToServer(currentSymbolRef, chart);
        showChartToast('Styles updated');
      } catch (err) {
        console.error('Failed to override overlay styles:', err);
      }
    }
    settingsModal.style.display = 'none';
  });

  // Draggable Floating Toolbar Handle
  let isDraggingBar = false;
  let dragOffset = { x: 0, y: 0 };

  floatDragHandle?.addEventListener('mousedown', (e) => {
    isDraggingBar = true;
    const barRect = floatingBar.getBoundingClientRect();
    dragOffset.x = e.clientX - barRect.left;
    dragOffset.y = e.clientY - barRect.top;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (isDraggingBar && floatingBar) {
      floatingBar.style.left = `${e.clientX - dragOffset.x}px`;
      floatingBar.style.top = `${e.clientY - dragOffset.y}px`;
    }
  });

  window.addEventListener('mouseup', () => {
    isDraggingBar = false;
  });

  // =========================================================================
  // ⌨️ KEYBOARD SHORTCUTS
  // =========================================================================

  window.addEventListener('keydown', (e) => {
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
  });

  // 6. Shift + Drag anywhere on chart canvas triggers Measurement Tool
  const chartCanvas = document.getElementById('klineChart');
  chartCanvas?.addEventListener('mousedown', (e) => {
    if (e.shiftKey && e.button === 0) {
      createDrawing('measureBox');
    }
  });
}
