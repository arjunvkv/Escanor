/**
 * Escanor — Structural Levels Chart Engine
 * Natively renders institutional auction levels directly onto the TradingView chart canvas:
 * 
 * 1. 👑 PDH (Ceiling): Amber/Gold dashed line (#f59e0b) + live distance/swept state
 * 2. 🛡️ Sovereign PDL (Floor): Emerald dashed line (#10b981) + live distance/swept state
 * 3. ⚖️ GEX EQ / VWAP: Cyan solid reference line (#38bdf8)
 * 4. 🌏 Asian High & Low: Purple/Teal dashed lines (#c084fc / #2dd4bf)
 * 5. 🏷️ Equilibrium (50% Dealing Range): Subtle violet line (#818cf8)
 * 6. ✈️ Supply & Demand FVG Shelves: Soft Rose (#f43f5e) & Emerald (#10b981) bounds
 */

export class StructuralLevelsEngine {
  constructor({ chartEngine }) {
    this.chart = (chartEngine && chartEngine.chart) ? chartEngine.chart : chartEngine;
    this.levelOverlays = new Map(); // key -> overlayId
  }

  updateLevels(tel) {
    if (!this.chart || !tel) return;

    const spot = tel.spot || {};
    const tape = tel.tape || {};
    const bid = spot.bid !== undefined ? spot.bid : (tape.ask ? (tape.ask - 0.35) : (tel.bid || 4149.0));

    const struct = tel.structure || {};
    const gexVal = Number(tel.gex || struct.gex || struct.gex_eq || (struct.vwap && struct.vwap.vwap) || tel.vwap);

    const levelsToRender = [];

    // ONLY ONE MARKING: GEX yellow dashed line matching image exactly
    if (gexVal && !isNaN(gexVal) && gexVal > 0) {
      levelsToRender.push({
        key: 'lvl_gex',
        price: gexVal,
        title: '',
        yLabel: `GEX $${gexVal.toFixed(2)}`,
        color: '#eab308', // Warm yellow shade from image
        lineStyle: 'dashed',
        lineSize: 1.5,
        opacity: 0.35     // Opacity matching image
      });
    }

    // Synchronize overlays on KLineCharts
    const activeKeys = new Set(levelsToRender.map(l => l.key));

    // Remove stale levels
    for (const [key, ovId] of this.levelOverlays.entries()) {
      if (!activeKeys.has(key)) {
        try { this.chart.removeOverlay({ id: ovId }); } catch (_) {}
        this.levelOverlays.delete(key);
      }
    }

    // Sync current levels
    for (const lvl of levelsToRender) {
      this._syncLevelLine(lvl);
    }
  }

  _syncLevelLine(lvl) {
    const key = lvl.key;
    const options = {
      name: 'structuralLevel',
      points: [{ value: lvl.price }],
      lock: true,
      extendData: {
        key: lvl.key,
        title: lvl.title,
        yLabel: lvl.yLabel,
        color: lvl.color,
        lineStyle: lvl.lineStyle,
        lineSize: lvl.lineSize,
        opacity: lvl.opacity !== undefined ? lvl.opacity : 0.30
      }
    };

    let ovId = this.levelOverlays.get(key);
    if (ovId) {
      try {
        this.chart.overrideOverlay(Object.assign({ id: ovId }, options));
        return;
      } catch (_) {
        try { this.chart.removeOverlay({ id: ovId }); } catch (e) {}
        this.levelOverlays.delete(key);
      }
    }

    try {
      const createdId = this.chart.createOverlay(options);
      if (createdId) {
        this.levelOverlays.set(key, createdId);
      }
    } catch (err) {
      console.warn(`[StructuralLevelsEngine] Error creating overlay ${key}:`, err);
    }
  }
}
