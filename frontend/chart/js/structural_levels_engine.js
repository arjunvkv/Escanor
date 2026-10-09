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
    const pdh = Number(tel.pdh || struct.pdh);
    const pdl = Number(tel.pdl || struct.pdl);
    const asianHigh = Number(tel.asian_high || struct.asian_high);
    const asianLow = Number(tel.asian_low || struct.asian_low);
    const vwapVal = Number((struct.vwap && struct.vwap.vwap) || tel.vwap);
    
    // Dealing range midpoint (50% EQ)
    let rangeEq = null;
    if (pdh && pdl && pdh > pdl) {
      rangeEq = pdl + (pdh - pdl) * 0.5;
    }

    const levelsToRender = [];

    // 1. 👑 PDH (Ceiling)
    if (pdh && !isNaN(pdh) && pdh > 0) {
      const dist = pdh - bid;
      const isSwept = dist < 0;
      const statusText = isSwept ? `SWEPT (-${Math.abs(dist).toFixed(1)}p)` : `+${dist.toFixed(1)}p above`;
      levelsToRender.push({
        key: 'lvl_pdh',
        price: pdh,
        title: `👑 PDH $${pdh.toFixed(2)} [${statusText}]`,
        yLabel: `PDH $${pdh.toFixed(2)}`,
        color: isSwept ? '#ef4444' : '#f59e0b',
        lineStyle: 'dashed',
        lineSize: isSwept ? 1.5 : 2
      });
    }

    // 2. 🛡️ Sovereign PDL (Floor)
    if (pdl && !isNaN(pdl) && pdl > 0) {
      const dist = bid - pdl;
      const isSwept = dist < 0;
      const statusText = isSwept ? `SWEPT (-${Math.abs(dist).toFixed(1)}p)` : `+${dist.toFixed(1)}p below`;
      levelsToRender.push({
        key: 'lvl_pdl',
        price: pdl,
        title: `🛡️ SOVEREIGN PDL $${pdl.toFixed(2)} [${statusText}]`,
        yLabel: `PDL $${pdl.toFixed(2)}`,
        color: isSwept ? '#ef4444' : '#10b981',
        lineStyle: 'dashed',
        lineSize: isSwept ? 1.5 : 2
      });
    }

    // 3. ⚖️ GEX EQ / VWAP
    if (vwapVal && !isNaN(vwapVal) && vwapVal > 0) {
      const dist = bid - vwapVal;
      const sign = dist >= 0 ? '+' : '';
      levelsToRender.push({
        key: 'lvl_vwap',
        price: vwapVal,
        title: `⚖️ GEX EQ / VWAP $${vwapVal.toFixed(2)} [${sign}${dist.toFixed(1)}p]`,
        yLabel: `VWAP $${vwapVal.toFixed(2)}`,
        color: '#38bdf8',
        lineStyle: 'solid',
        lineSize: 1.5
      });
    }

    // 4. 🌏 Asian High
    if (asianHigh && !isNaN(asianHigh) && asianHigh > 0 && Math.abs(asianHigh - pdh) > 0.5) {
      const dist = asianHigh - bid;
      const isSwept = dist < 0;
      levelsToRender.push({
        key: 'lvl_asian_high',
        price: asianHigh,
        title: `🌏 ASIAN HIGH $${asianHigh.toFixed(2)} [${isSwept ? 'SWEPT' : (dist >= 0 ? '+' : '') + dist.toFixed(1) + 'p'}]`,
        yLabel: `ASH $${asianHigh.toFixed(2)}`,
        color: '#c084fc',
        lineStyle: 'dashed',
        lineSize: 1.5
      });
    }

    // 5. 🌏 Asian Low
    if (asianLow && !isNaN(asianLow) && asianLow > 0 && Math.abs(asianLow - pdl) > 0.5) {
      const dist = bid - asianLow;
      const isSwept = dist < 0;
      levelsToRender.push({
        key: 'lvl_asian_low',
        price: asianLow,
        title: `🌏 ASIAN LOW $${asianLow.toFixed(2)} [${isSwept ? 'SWEPT' : (dist >= 0 ? '+' : '') + dist.toFixed(1) + 'p'}]`,
        yLabel: `ASL $${asianLow.toFixed(2)}`,
        color: '#2dd4bf',
        lineStyle: 'dashed',
        lineSize: 1.5
      });
    }

    // 6. 🏷️ Equilibrium 50% Dealing Range
    if (rangeEq && !isNaN(rangeEq) && rangeEq > 0) {
      const dist = bid - rangeEq;
      levelsToRender.push({
        key: 'lvl_range_eq',
        price: rangeEq,
        title: `🏷️ RANGE 50% EQ $${rangeEq.toFixed(2)} [${dist >= 0 ? '+' : ''}${dist.toFixed(1)}p]`,
        yLabel: `EQ $${rangeEq.toFixed(2)}`,
        color: '#818cf8',
        lineStyle: 'dashed',
        lineSize: 1.2
      });
    }

    // 7. ✈️ Supply FVG Shelf
    if (struct.supply_fvg && struct.supply_fvg.bottom) {
      const supP = Number(struct.supply_fvg.bottom);
      if (!isNaN(supP) && supP > 0) {
        levelsToRender.push({
          key: 'lvl_supply_fvg',
          price: supP,
          title: `✈️ SUPPLY FVG $${supP.toFixed(2)} [+${Math.max(0, supP - bid).toFixed(1)}p]`,
          yLabel: `SUPPLY $${supP.toFixed(2)}`,
          color: '#f43f5e',
          lineStyle: 'solid',
          lineSize: 1.5
        });
      }
    }

    // 8. ✈️ Demand FVG Shelf
    if (struct.demand_fvg && struct.demand_fvg.top) {
      const demP = Number(struct.demand_fvg.top);
      if (!isNaN(demP) && demP > 0) {
        levelsToRender.push({
          key: 'lvl_demand_fvg',
          price: demP,
          title: `✈️ DEMAND FVG $${demP.toFixed(2)} [+${Math.max(0, bid - demP).toFixed(1)}p]`,
          yLabel: `DEMAND $${demP.toFixed(2)}`,
          color: '#10b981',
          lineStyle: 'solid',
          lineSize: 1.5
        });
      }
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
        lineSize: lvl.lineSize
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
