/**
 * Escanor — TradingView Left Toolbar Controller
 * Manages active drawing tool modes, flyout menus, delete actions,
 * and keyboard shortcuts (Shift + Drag ruler measurement).
 */

import { syncDrawingsToServer, showChartToast } from './drawings_storage.js';

let activeTool = 'crosshair';
let selectedOverlayId = null;

export function initToolbar(chart, currentSymbol = 'XAUUSD') {
  if (!chart) return;

  const toolCrosshair = document.getElementById('toolCrosshair');
  const toolLinesBtn = document.getElementById('toolLinesBtn');
  const toolBoxBtn = document.getElementById('toolBoxBtn');
  const toolMeasureBtn = document.getElementById('toolMeasureBtn');
  const toolDeleteBtn = document.getElementById('toolDeleteBtn');
  const flyout = document.getElementById('lineToolsFlyout');

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

  // 2. Line Tools Button — Click to activate current line, or toggle flyout
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

  // Flyout item selection
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

  // Close flyout on outside click
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

  // 5. Delete Tool
  toolDeleteBtn?.addEventListener('click', () => {
    if (selectedOverlayId) {
      chart.removeOverlay(selectedOverlayId);
      selectedOverlayId = null;
      syncDrawingsToServer(currentSymbol, chart);
      showChartToast('Removed selected drawing');
    } else {
      // If nothing selected, remove all overlays
      const all = chart.getOverlays() || [];
      if (all.length > 0) {
        if (confirm(`Remove all ${all.length} drawings on chart?`)) {
          all.forEach(ov => chart.removeOverlay(ov.id));
          syncDrawingsToServer(currentSymbol, chart);
          showChartToast('Cleared all drawings');
        }
      }
    }
  });

  function createDrawing(overlayName) {
    try {
      chart.createOverlay({
        name: overlayName,
        onDrawEnd: () => {
          syncDrawingsToServer(currentSymbol, chart);
          // Return to crosshair after completed drawing
          setActive(toolCrosshair, 'crosshair');
        }
      });
    } catch (err) {
      console.error('[Escanor Toolbar] Create overlay failed:', err);
    }
  }

  // Track selected drawing & auto-sync when modified
  try {
    chart.subscribeAction('onOverlaySelected', (info) => {
      if (info && info.overlay) {
        selectedOverlayId = info.overlay.id;
      }
    });

    chart.subscribeAction('onOverlayDeselected', () => {
      selectedOverlayId = null;
    });
  } catch (e) {
    // Graceful fallback
  }

  // =========================================================================
  // ⌨️ SHORTCUTS: Shift + Drag Ruler, Delete, Escape
  // =========================================================================
  let shiftPressed = false;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !shiftPressed) {
      shiftPressed = true;
    }
    if (e.key === 'Escape') {
      setActive(toolCrosshair, 'crosshair');
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedOverlayId) {
      chart.removeOverlay(selectedOverlayId);
      selectedOverlayId = null;
      syncDrawingsToServer(currentSymbol, chart);
      showChartToast('Deleted drawing');
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
      shiftPressed = false;
    }
  });

  const chartContainer = document.getElementById('klineChart');
  chartContainer?.addEventListener('mousedown', (e) => {
    if (e.shiftKey) {
      // Activate TradingView measurement ruler via Shift + Drag
      chart.createOverlay({
        name: 'measureBox',
        onDrawEnd: () => {
          setActive(toolCrosshair, 'crosshair');
        }
      });
    }
  });
}
