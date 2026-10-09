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
          all.forEach(ov => chart.removeOverlay({ id: ov.id }));
          if (window.__lineTradingManager) {
            window.__lineTradingManager.clearAllLines();
          }
          syncDrawingsToServer(currentSymbolRef, chart, false, true);
          hideFloatingBar();
          showChartToast('Cleared all drawings');
        });
      }
    }
  });

  const isLineOverlay = (name) => ['segment', 'rayLine', 'straightLine', 'horizontalStraightLine', 'verticalStraightLine'].includes(name);

  // Create Drawing with Shift Snapping & Event Hooks
  function createDrawing(overlayName) {
    if (isLineOverlay(overlayName) && window.__lineTradingManager) {
      window.__lineTradingManager.setDrawing(true);
    }
    const defaultStyles = isLineOverlay(overlayName) ? {
      line: { color: '#94a3b8', size: 1.5, style: 'solid' },
      point: { color: '#94a3b8', borderColor: '#94a3b8', activeColor: '#cbd5e1', activeBorderColor: '#cbd5e1', radius: 4.5 }
    } : undefined;

    try {
      chart.createOverlay({
        name: overlayName,
        styles: defaultStyles,
        onDrawEnd: ({ overlay }) => {
          if (isLineOverlay(overlayName) && window.__lineTradingManager && overlay) {
            window.__lineTradingManager.setDrawing(false);
            window.__lineTradingManager.registerLineOverlay(overlay, overlayName);
          }
          syncDrawingsToServer(currentSymbolRef, chart);
          setActive(toolCrosshair, 'crosshair');
        },
        performEventPressedMove: ({ points, performPointIndex }) => {
          if (isLineOverlay(overlayName) && window.__lineTradingManager) {
            window.__lineTradingManager.setDragging(true);
          }
          // If Shift is pressed, lock to horizontal level
          if (window.__isShiftPressed && points.length >= 2 && performPointIndex === 1) {
            points[1].value = points[0].value;
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
    const ovName = params.name;
    const defaultStyles = (isLineOverlay(ovName) && !params.styles) ? {
      line: { color: '#94a3b8', size: 1.5, style: 'solid' },
      point: { color: '#94a3b8', borderColor: '#94a3b8', activeColor: '#cbd5e1', activeBorderColor: '#cbd5e1', radius: 4.5 }
    } : params.styles;

    const customParams = {
      ...params,
      styles: defaultStyles,
      onDrawEnd: (args) => {
        if (params.onDrawEnd) params.onDrawEnd(args);
        if (isLineOverlay(ovName) && window.__lineTradingManager && args?.overlay) {
          window.__lineTradingManager.setDrawing(false);
          window.__lineTradingManager.registerLineOverlay(args.overlay, ovName);
        }
      },
      performEventPressedMove: (args) => {
        if (params.performEventPressedMove) params.performEventPressedMove(args);
        if (isLineOverlay(ovName) && window.__lineTradingManager) {
          window.__lineTradingManager.setDragging(true);
        }
        if (window.__isShiftPressed && args.points?.length >= 2 && args.performPointIndex === 1) {
          args.points[1].value = args.points[0].value;
        }
      },
      onPressedMoveEnd: (args) => {
        if (params.onPressedMoveEnd) params.onPressedMoveEnd(args);
        if (isLineOverlay(ovName) && window.__lineTradingManager) {
          window.__lineTradingManager.setDragging(false);
        }
        syncDrawingsToServer(currentSymbolRef, chart);
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

  function handleOverlaySelected(event) {
    selectedOverlay = event.overlay;
    if (!selectedOverlay) return;

    // Measurement tool: User explicitly requested:
    // "no need for for settings delete or floating box for measurement tool . let it be auto removed when clicked ouside -- same as trading view"
    if (selectedOverlay.name === 'measureBox') {
      hideFloatingBar();
      return;
    }

    // Position at the single saved persistent coordinate for ALL items
    applyFloatingBarPosition();
    floatingBar.style.display = 'flex';
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
      const id = selectedOverlay.id;
      chart.removeOverlay({ id });
      if (window.__lineTradingManager) {
        window.__lineTradingManager.removeLineOverlay(id);
      }
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

  // Settings button on floating toolbar
  floatSettingsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!selectedOverlay) return;

    const ovName = selectedOverlay.name;

    // 1. Line Tools -> Open Line Trading Settings Modal (applicable to all line types)
    if (isLineOverlay(ovName) && window.__lineTradingManager) {
      window.__lineTradingManager.openSettingsModal(selectedOverlay.id);
      return;
    }

    // 2. Rectangle Box -> Open Rectangle Settings Modal (theming options removed/empty)
    if (ovName === 'rect') {
      const rectModal = document.getElementById('tvRectSettingsModal');
      if (rectModal) rectModal.style.display = 'flex';
      return;
    }
  });

  // Rectangle Settings Modal Buttons
  document.getElementById('tvCloseRectModalBtn')?.addEventListener('click', () => {
    const rectModal = document.getElementById('tvRectSettingsModal');
    if (rectModal) rectModal.style.display = 'none';
  });

  document.getElementById('tvCloseRectBtn')?.addEventListener('click', () => {
    const rectModal = document.getElementById('tvRectSettingsModal');
    if (rectModal) rectModal.style.display = 'none';
  });

  document.getElementById('tvDeleteRectBtn')?.addEventListener('click', () => {
    deleteSelectedOverlay();
    const rectModal = document.getElementById('tvRectSettingsModal');
    if (rectModal) rectModal.style.display = 'none';
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
}
