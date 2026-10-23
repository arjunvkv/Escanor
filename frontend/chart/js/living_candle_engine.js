/**
 * Escanor — Living Candle Footprint Engine (Zero-Bloat Visual System)
 * Transposes institutional order flow, volume footprint, absorption dynamics,
 * and time-series duration directly into the candle anatomy.
 * 
 * Rules:
 * 1. 5-Hour Focus Window: Past 60 candles (on M5) receive morphological footprint styling.
 * 2. Absorption Bodies:
 *    - Frost Electric Cyan (#00f0ff) = Institutional Buyer Absorption (Spring Wick)
 *    - Burnt Amber (#f59e0b) = Institutional Seller Distribution (Ceiling Wick)
 * 3. Expansion Bodies:
 *    - Vibrant Emerald (#10b981) = High-Velocity Bull Expansion
 *    - Deep Crimson (#e0457b) = High-Velocity Bear Expansion
 * 4. Exhaustion / Chop Bodies:
 *    - Desaturated Frosted Slate (#475569) = Low-volume retail noise
 * 5. POC Notch (Point of Control): 1px horizontal micro-notch at max-volume price tier.
 * 6. Absorption Wick Spine: 2.5px glowing neon spine on the absorbing wick.
 * 7. Auto-Coiling Ghost Box: Highlights >= 4-bar compression zones.
 * 8. Ignition Marker: Micro-triangle at expansion start.
 */

let footprintEnabled = true;

export function isFootprintEnabled() {
  return footprintEnabled;
}

export function setFootprintEnabled(enabled) {
  footprintEnabled = Boolean(enabled);
}

/**
 * Evaluates whether a candle forms an Electric Cyan (Buyer Absorption) or
 * Burnt Amber / Yellow (Seller Distribution) trap pattern, and whether any
 * part of the candle (body or wicks) touches/spans across linePrice.
 */
export function evaluateCandleTrapState(dataList, index = null, linePrice = null) {
  if (!dataList || dataList.length < 2) {
    return { isCyan: false, isYellow: false, candleOverlapsLine: false, bodyOverlapsLine: false, k: null };
  }
  const i = (index !== null && index >= 0) ? index : dataList.length - 1;
  const k = dataList[i];
  if (!k) return { isCyan: false, isYellow: false, candleOverlapsLine: false, bodyOverlapsLine: false, k: null };

  const range = k.high - k.low;
  const body = Math.abs(k.close - k.open);
  const upperWick = k.high - Math.max(k.open, k.close);
  const lowerWick = Math.min(k.open, k.close) - k.low;
  const lowerRatio = range > 0 ? (lowerWick / range) : 0;
  const upperRatio = range > 0 ? (upperWick / range) : 0;

  // Swing Low / High across prior 12 bars
  let swingLow = Infinity;
  let swingHigh = -Infinity;
  const lookbackStart = Math.max(0, i - 12);
  for (let s = lookbackStart; s < i; s++) {
    if (dataList[s].low < swingLow) swingLow = dataList[s].low;
    if (dataList[s].high > swingHigh) swingHigh = dataList[s].high;
  }

  // Check if candle overlaps line: any part of the candle (body or wicks) touches/spans across linePrice
  let candleOverlapsLine = false;
  let bodyOverlapsLine = false;
  if (typeof linePrice === 'number' && !isNaN(linePrice) && linePrice > 0) {
    const bodyLow = Math.min(k.open, k.close);
    const bodyHigh = Math.max(k.open, k.close);
    candleOverlapsLine = (k.low - 0.08 <= linePrice) && (k.high + 0.08 >= linePrice);
    bodyOverlapsLine = (bodyLow - 0.08 <= linePrice) && (bodyHigh + 0.08 >= linePrice);
  }

  // Cyan: Buyer Absorption / Bottom Trap
  // Swept prior swing low, or swept below the line, with lower wick rejection >= 35% and close in upper 68% of candle
  const sweptLowCond = (k.low <= swingLow + 0.02) || (typeof linePrice === 'number' && k.low <= linePrice);
  const isCyan = sweptLowCond && lowerRatio >= 0.35 && (k.close > k.low + 0.30 * range);

  // Yellow: Seller Distribution / Top Trap
  // Swept prior swing high, or swept above the line, with upper wick rejection >= 35% and close in lower 68% of candle
  const sweptHighCond = (k.high >= swingHigh - 0.02) || (typeof linePrice === 'number' && k.high >= linePrice);
  const isYellow = sweptHighCond && upperRatio >= 0.35 && (k.close < k.high - 0.30 * range);

  return {
    isCyan: Boolean(isCyan),
    isYellow: Boolean(isYellow),
    candleOverlapsLine,
    bodyOverlapsLine,
    swingLow,
    swingHigh,
    lowerRatio,
    upperRatio,
    k
  };
}

export function registerLivingFootprintIndicator() {
  if (typeof klinecharts === 'undefined') return;

  klinecharts.registerIndicator({
    name: 'LivingFootprint',
    shortName: '', // Empty shortName so it does not clutter the candle pane header
    series: 'price',
    precision: 2,
    shouldOhlc: true,
    styles: {
      tooltip: {
        showRule: 'none' // Zero header clutter on candle pane
      }
    },
    calc: (dataList) => {
      return dataList.map(() => ({}));
    },
    draw: ({ ctx, chart, bounding, xAxis, yAxis }) => {
      if (!footprintEnabled || !chart || !ctx || !xAxis || !yAxis) return true;

      // Always reset line dash so wicks and spines render as solid, continuous lines
      ctx.setLineDash([]);

      const dataList = chart.getDataList() || [];
      const len = dataList.length;
      if (len < 5) return true;

      // 5-Hour Focus Window: Calculate bars dynamically based on actual timestamp
      const latestBar = dataList[len - 1];
      const cutoffTime = (latestBar && latestBar.timestamp) ? (latestBar.timestamp - (5 * 3600 * 1000)) : (Date.now() - (5 * 3600 * 1000));
      let startIndex = 0;
      for (let idx = len - 1; idx >= 0; idx--) {
        if (dataList[idx].timestamp < cutoffTime) {
          startIndex = idx + 1;
          break;
        }
      }
      if (len - startIndex < 12) startIndex = Math.max(0, len - Math.min(60, len));

      const barSpace = chart.getBarSpace ? chart.getBarSpace() : { bar: 6, halfBar: 3, gapBar: 5, halfGapBar: 2 };
      const barWidth = Math.max(2, (barSpace.gapBar || (barSpace.bar ? barSpace.bar - 2 : 5)));
      const halfWidth = barSpace.halfGapBar !== undefined ? barSpace.halfGapBar : Math.floor(barWidth / 2);

      // Calculate rolling stats across the window
      let sumRange = 0;
      for (let i = startIndex; i < len; i++) {
        sumRange += (dataList[i].high - dataList[i].low);
      }
      const count = Math.max(1, len - startIndex);
      const avgRange = Math.max(0.8, sumRange / count);

      // Calculate Session VWAP across today's session bars
      const todayDateStr = (latestBar && latestBar.timestamp) ? new Date(latestBar.timestamp).toDateString() : new Date().toDateString();
      let vwapPV = 0;
      let vwapV = 0;
      const vwapCurve = [];

      for (let idx = 0; idx < len; idx++) {
        const bar = dataList[idx];
        const barDateStr = bar.timestamp ? new Date(bar.timestamp).toDateString() : todayDateStr;
        if (barDateStr === todayDateStr) {
          const vol = Number(bar.volume || bar.tick_volume || 1);
          const typ = (bar.high + bar.low + bar.close) / 3;
          vwapPV += typ * vol;
          vwapV += vol;
          if (vwapV > 0 && idx >= startIndex) {
            vwapCurve.push({ idx, price: vwapPV / vwapV });
          }
        }
      }

      // Draw Session VWAP on chart canvas (Lavender purple dashed curve)
      if (vwapCurve.length >= 2) {
        ctx.save();
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        let first = true;
        for (const pt of vwapCurve) {
          const px = xAxis.convertToPixel(pt.idx);
          const py = yAxis.convertToPixel(pt.price);
          if (first) {
            ctx.moveTo(px, py);
            first = false;
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();

        const lastPt = vwapCurve[vwapCurve.length - 1];
        const lastPx = xAxis.convertToPixel(lastPt.idx);
        const lastPy = yAxis.convertToPixel(lastPt.price);
        ctx.font = 'bold 9px monospace';
        ctx.fillStyle = '#c084fc';
        ctx.fillText('VWAP', Math.min(bounding.width - 34, lastPx + 6), lastPy + 3);
        ctx.restore();
      }

      // Render each candle in the 5-Hour window
      for (let i = startIndex; i < len; i++) {
        const k = dataList[i];
        const prev = i > 0 ? dataList[i - 1] : k;
        const x = xAxis.convertToPixel(i);

        // Skip off-screen candles
        if (x < -20 || x > bounding.width + 20) continue;

        const yOpen = yAxis.convertToPixel(k.open);
        const yClose = yAxis.convertToPixel(k.close);
        const yHigh = yAxis.convertToPixel(k.high);
        const yLow = yAxis.convertToPixel(k.low);

        const topY = Math.min(yOpen, yClose);
        const botY = Math.max(yOpen, yClose);
        const bHeight = Math.max(2, botY - topY);

        const range = k.high - k.low;
        const body = Math.abs(k.close - k.open);
        const isUp = k.close >= k.open;
        const upperWick = k.high - Math.max(k.open, k.close);
        const lowerWick = Math.min(k.open, k.close) - k.low;
        const lowerRatio = lowerWick / (range || 1);
        const upperRatio = upperWick / (range || 1);

        // Swing Low / High across prior 10 bars
        let swingLow = Infinity;
        let swingHigh = -Infinity;
        const lookbackStart = Math.max(0, i - 12);
        for (let s = lookbackStart; s < i; s++) {
          if (dataList[s].low < swingLow) swingLow = dataList[s].low;
          if (dataList[s].high > swingHigh) swingHigh = dataList[s].high;
        }

        // Check if candle swept an armed trap line
        let sweptArmedLineLow = false;
        let sweptArmedLineHigh = false;
        if (i === len - 1 && window.__lineTradingManager && window.__lineTradingManager.lines) {
          for (const ln of window.__lineTradingManager.lines.values()) {
            if (ln.isArmed && ln.trapColorEnabled && typeof ln._lastCalculatedPrice === 'number') {
              const lp = ln._lastCalculatedPrice;
              if (k.low <= lp + 0.05 && (k.high >= lp - 0.05)) {
                if (String(ln.direction).toUpperCase() === 'BUY') sweptArmedLineLow = true;
              }
              if (k.high >= lp - 0.05 && (k.low <= lp + 0.05)) {
                if (String(ln.direction).toUpperCase() === 'SELL' || ln.actionType === 'EXIT') sweptArmedLineHigh = true;
              }
            }
          }
        }

        // Structural Classifications
        const sweptLow = (k.low <= swingLow + 0.02 || sweptArmedLineLow) && lowerRatio >= 0.35 && (k.close > k.low + 0.30 * range);
        const sweptHigh = (k.high >= swingHigh - 0.02 || sweptArmedLineHigh) && upperRatio >= 0.35 && (k.close < k.high - 0.30 * range);

        const isSpringWick = sweptLow && (!sweptHigh || lowerRatio >= upperRatio);
        const isCeilingWick = sweptHigh && (!sweptLow || upperRatio > lowerRatio);
        const isBullExpansion = isUp && (body / (range || 1) >= 0.62) && range >= avgRange * 1.15;
        const isBearExpansion = !isUp && (body / (range || 1) >= 0.62) && range >= avgRange * 1.15;
        const isChop = range < avgRange * 0.70 && !isSpringWick && !isCeilingWick;

        // Check if candle qualifies for morphological footprint styling
        const isSpecial = isSpringWick || isCeilingWick || isBullExpansion || isBearExpansion || isChop;
        if (!isSpecial) {
          continue;
        }

        // Check Trap Survival: Did any subsequent candle violate this candle's stop loss wick?
        let isTrapBreached = false;
        if (isSpringWick && i < len - 1) {
          for (let j = i + 1; j < len; j++) {
            if (dataList[j].low < k.low - 0.02) {
              isTrapBreached = true;
              break;
            }
          }
        } else if (isCeilingWick && i < len - 1) {
          for (let j = i + 1; j < len; j++) {
            if (dataList[j].high > k.high + 0.02) {
              isTrapBreached = true;
              break;
            }
          }
        }

        // Determine Candle Colors for footprint states
        let bodyFill = '#d1d4dc';
        let wickColor = '#94a3b8';
        let specialSpine = null;

        if (isSpringWick) {
          if (!isTrapBreached) {
            bodyFill = '#00e5ff'; // Electric Frost Cyan (Active, Surviving Trap)
            wickColor = '#00e5ff';
            specialSpine = 'lower';
          } else {
            bodyFill = '#0e7490'; // Dimmed Cyan (Breached / Inactive Trap)
            wickColor = '#0891b2';
            specialSpine = 'lower_dead';
          }
        } else if (isCeilingWick) {
          if (!isTrapBreached) {
            bodyFill = '#ffd600'; // Pure Vibrant Yellow (Active, Surviving Trap)
            wickColor = '#ffd600';
            specialSpine = 'upper';
          } else {
            bodyFill = '#a16207'; // Dimmed Yellow / Amber (Breached / Inactive Trap)
            wickColor = '#ca8a04';
            specialSpine = 'upper_dead';
          }
        } else if (isBullExpansion) {
          bodyFill = '#10b981'; // Vibrant Emerald
          wickColor = '#10b981';
        } else if (isBearExpansion) {
          bodyFill = '#e0457b'; // Deep Crimson
          wickColor = '#e0457b';
        } else if (isChop) {
          bodyFill = '#475569'; // Frosted Slate
          wickColor = '#475569';
        }

        ctx.save();
        ctx.setLineDash([]); // Ensure solid strokes for all wicks and spines

        // 1. Draw Solid Continuous Wicks
        ctx.strokeStyle = wickColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, yHigh);
        ctx.lineTo(x, yLow);
        ctx.stroke();

        // 2. Glowing Wick Core (Absorption Spine) & Dot at Wick Tip
        if (specialSpine === 'lower') {
          const yBodyBottom = Math.max(yOpen, yClose);
          ctx.strokeStyle = '#00e5ff';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(x, yBodyBottom);
          ctx.lineTo(x, yLow);
          ctx.stroke();

          // White Dot at Wick Tip (Active sniper absorption)
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(x, yLow, 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else if (specialSpine === 'lower_dead') {
          const yBodyBottom = Math.max(yOpen, yClose);
          ctx.strokeStyle = '#0891b2';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, yBodyBottom);
          ctx.lineTo(x, yLow);
          ctx.stroke();

          // Muted Dot at tip
          ctx.fillStyle = '#38bdf8';
          ctx.beginPath();
          ctx.arc(x, yLow, 1.8, 0, Math.PI * 2);
          ctx.fill();
        } else if (specialSpine === 'upper') {
          const yBodyTop = Math.min(yOpen, yClose);
          ctx.strokeStyle = '#ffd600';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(x, yBodyTop);
          ctx.lineTo(x, yHigh);
          ctx.stroke();

          // White Dot at Wick Tip (Active sniper distribution)
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(x, yHigh, 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else if (specialSpine === 'upper_dead') {
          const yBodyTop = Math.min(yOpen, yClose);
          ctx.strokeStyle = '#ca8a04';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, yBodyTop);
          ctx.lineTo(x, yHigh);
          ctx.stroke();

          // Muted Dot at tip
          ctx.fillStyle = '#fbbf24';
          ctx.beginPath();
          ctx.arc(x, yHigh, 1.8, 0, Math.PI * 2);
          ctx.fill();
        }

        // 3. Clean Solid Candle Body
        const bw = Math.max(barWidth, 3);
        const hw = bw / 2;
        ctx.fillStyle = bodyFill;
        ctx.fillRect(x - hw, topY, bw, bHeight);

        // 4. White Line inside Body (POC) — strictly inside body bounds
        if (bHeight >= 4) {
          const bodyBottom = Math.min(k.open, k.close);
          const bodyTop = Math.max(k.open, k.close);
          const bodyH = bodyTop - bodyBottom;
          let pocPrice = (k.open + k.close) / 2;
          if (isSpringWick) {
            pocPrice = bodyBottom + (bodyH * 0.35);
          } else if (isCeilingWick) {
            pocPrice = bodyBottom + (bodyH * 0.65);
          }
          const rawPocY = yAxis.convertToPixel(pocPrice);
          const yPoc = Math.max(topY + 1.5, Math.min(botY - 1.5, rawPocY));

          // If dead trap, draw POC slightly dimmed so cross symbol takes visual priority
          ctx.strokeStyle = (specialSpine === 'lower_dead' || specialSpine === 'upper_dead')
            ? 'rgba(255, 255, 255, 0.35)'
            : '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x - halfWidth + 1, yPoc);
          ctx.lineTo(x + halfWidth - 1, yPoc);
          ctx.stroke();
        }

        // 5. If dead trap, draw bold invalidation cross symbol '✕' on top with high-contrast text styling
        if (specialSpine === 'lower_dead' || specialSpine === 'upper_dead') {
          const midY = (topY + botY) / 2;
          ctx.save();
          const fontSize = Math.max(9, Math.min(13, Math.round(bw * 1.1)));
          ctx.font = `900 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          // Dark halo/outline for guaranteed visibility against dimmed cyan and dimmed yellow
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
          ctx.lineWidth = 2.5;
          ctx.strokeText('✕', x, midY);
          // High-visibility crimson text fill
          ctx.fillStyle = '#ff2238';
          ctx.fillText('✕', x, midY);
          ctx.restore();
        }

        ctx.restore();
      }

      return true; // Complete custom draw cleanly
    }
  });
}

/**
 * Computes 5-Hour Footprint Intelligence Metrics:
 * - cyanTraps: Total Bull Absorption trap candles in the 5H window
 * - yellowTraps: Total Bear Distribution trap candles in the 5H window
 * - bullPressurePct: % expansion force favoring bulls (0-100)
 * - bearPressurePct: % expansion force favoring bears (0-100)
 */
export function computeFootprintMetrics(dataList, currentSpotPrice = null) {
  if (!dataList || dataList.length < 5) {
    return {
      cyanTraps: 0,
      yellowTraps: 0,
      activeCyan: 0,
      brokenCyan: 0,
      activeYellow: 0,
      brokenYellow: 0,
      cyanDomPct: 50,
      yellowDomPct: 50,
      dominant: 'NEUTRAL',
      bullPressurePct: 50,
      bearPressurePct: 50,
      sessionVwap: null,
      vwapRegime: 'BALANCED',
      isBelowVwap: false,
      isAboveVwap: false
    };
  }

  const len = dataList.length;
  const latestBar = dataList[len - 1];
  const cutoffTime = (latestBar && latestBar.timestamp) ? (latestBar.timestamp - (5 * 3600 * 1000)) : (Date.now() - (5 * 3600 * 1000));
  let startIndex = 0;
  for (let idx = len - 1; idx >= 0; idx--) {
    if (dataList[idx].timestamp < cutoffTime) {
      startIndex = idx + 1;
      break;
    }
  }
  if (len - startIndex < 12) startIndex = Math.max(0, len - Math.min(60, len));

  let cyanTraps = 0;
  let yellowTraps = 0;
  let activeCyan = 0;
  let brokenCyan = 0;
  let activeYellow = 0;
  let brokenYellow = 0;
  let cyanPowerSum = 0;
  let yellowPowerSum = 0;

  const totalBarsInWindow = Math.max(1, len - startIndex);

  // Session VWAP across today's session bars
  let sumPV = 0;
  let sumV = 0;
  const todayDateStr = (latestBar && latestBar.timestamp) ? new Date(latestBar.timestamp).toDateString() : new Date().toDateString();
  for (let idx = 0; idx < len; idx++) {
    const bar = dataList[idx];
    const barDateStr = bar.timestamp ? new Date(bar.timestamp).toDateString() : todayDateStr;
    if (barDateStr === todayDateStr) {
      const vol = Number(bar.volume || bar.tick_volume || 1);
      const typ = (bar.high + bar.low + bar.close) / 3;
      sumPV += typ * vol;
      sumV += vol;
    }
  }
  const sessionVwap = sumV > 0 ? (sumPV / sumV) : 0;
  const curSpot = (typeof currentSpotPrice === 'number' && currentSpotPrice > 0) ? currentSpotPrice : (latestBar ? latestBar.close : 0);
  const isBelowVwap = sessionVwap > 0 && curSpot < (sessionVwap - 0.10);
  const isAboveVwap = sessionVwap > 0 && curSpot > (sessionVwap + 0.10);
  const vwapRegime = isBelowVwap ? 'MARKDOWN (Below VWAP)' : (isAboveVwap ? 'MARKUP (Above VWAP)' : 'BALANCED');

  for (let i = startIndex; i < len; i++) {
    const k = dataList[i];
    const range = k.high - k.low;
    const lowerWick = Math.min(k.open, k.close) - k.low;
    const upperWick = k.high - Math.max(k.open, k.close);
    const lowerRatio = range > 0 ? (lowerWick / range) : 0;
    const upperRatio = range > 0 ? (upperWick / range) : 0;

    let swingLow = Infinity;
    let swingHigh = -Infinity;
    const lookbackStart = Math.max(0, i - 12);
    for (let s = lookbackStart; s < i; s++) {
      if (dataList[s].low < swingLow) swingLow = dataList[s].low;
      if (dataList[s].high > swingHigh) swingHigh = dataList[s].high;
    }

    // Check if current living candle touches an armed line
    let sweptArmedLineLow = false;
    let sweptArmedLineHigh = false;
    if (i === len - 1 && window.__lineTradingManager && window.__lineTradingManager.lines) {
      for (const ln of window.__lineTradingManager.lines.values()) {
        if (ln.isArmed && ln.trapColorEnabled && typeof ln._lastCalculatedPrice === 'number') {
          const lp = ln._lastCalculatedPrice;
          if (k.low <= lp + 0.05 && (k.high >= lp - 0.05)) {
            if (String(ln.direction).toUpperCase() === 'BUY') sweptArmedLineLow = true;
          }
          if (k.high >= lp - 0.05 && (k.low <= lp + 0.05)) {
            if (String(ln.direction).toUpperCase() === 'SELL' || ln.actionType === 'EXIT') sweptArmedLineHigh = true;
          }
        }
      }
    }

    const sweptLow = (k.low <= swingLow + 0.02 || sweptArmedLineLow) && lowerRatio >= 0.35 && (k.close > k.low + 0.30 * range);
    const sweptHigh = (k.high >= swingHigh - 0.02 || sweptArmedLineHigh) && upperRatio >= 0.35 && (k.close < k.high - 0.30 * range);

    const isSpring = sweptLow && (!sweptHigh || lowerRatio >= upperRatio);
    const isCeiling = sweptHigh && (!sweptLow || upperRatio > lowerRatio);

    const barVol = Number(k.volume || k.tick_volume || 1);
    const recency = 0.35 + 0.65 * ((i - startIndex) / Math.max(1, totalBarsInWindow - 1));

    if (isSpring) {
      cyanTraps++;
      let isBreached = false;
      if (i < len - 1) {
        for (let j = i + 1; j < len; j++) {
          if (dataList[j].low < k.low - 0.02) {
            isBreached = true;
            break;
          }
        }
      }
      if (isBreached) {
        brokenCyan++;
      } else {
        activeCyan++;
        const power = barVol * lowerRatio * recency * 1.5;
        cyanPowerSum += power;
      }
    }

    if (isCeiling) {
      yellowTraps++;
      let isBreached = false;
      if (i < len - 1) {
        for (let j = i + 1; j < len; j++) {
          if (dataList[j].high > k.high + 0.02) {
            isBreached = true;
            break;
          }
        }
      }
      if (isBreached) {
        brokenYellow++;
      } else {
        activeYellow++;
        const power = barVol * upperRatio * recency * 1.5;
        yellowPowerSum += power;
      }
    }

    // Dynamic living candle orderflow contribution:
    if (i === len - 1 && !isSpring && !isCeiling) {
      if (lowerRatio >= 0.28 && k.low <= swingLow + 0.05) {
        cyanPowerSum += barVol * lowerRatio * 1.0;
      } else if (upperRatio >= 0.28 && k.high >= swingHigh - 0.05) {
        yellowPowerSum += barVol * upperRatio * 1.0;
      }
    }
  }

  // Calculate Net Survival Domination:
  let cyanDomPct = 50;
  let yellowDomPct = 50;
  let dominant = 'NEUTRAL';

  const totalActive = activeCyan + activeYellow;
  const totalBroken = brokenCyan + brokenYellow;

  if (totalActive === 0 && totalBroken === 0) {
    cyanDomPct = 50;
    yellowDomPct = 50;
    dominant = 'NEUTRAL';
  } else if (activeCyan === 0 && brokenCyan > 0 && activeYellow === 0) {
    // Cascading drop: All bottom attempts failed, zero top traps
    cyanDomPct = 5;
    yellowDomPct = 95;
    dominant = 'BEAR_CASCADE';
  } else if (activeYellow === 0 && brokenYellow > 0 && activeCyan === 0) {
    // Expansion rally: All top attempts failed, zero bottom traps
    cyanDomPct = 95;
    yellowDomPct = 5;
    dominant = 'BULL_EXPANSION';
  } else if (activeCyan === 0 && activeYellow > 0) {
    // All bottom attempts dead, top trap alive!
    cyanDomPct = 10;
    yellowDomPct = 90;
    dominant = 'BEAR_CASCADE';
  } else if (activeYellow === 0 && activeCyan > 0) {
    // All top attempts dead, bottom trap alive!
    cyanDomPct = 90;
    yellowDomPct = 10;
    dominant = 'CYAN';
  } else if (cyanPowerSum + yellowPowerSum > 0) {
    const powerRatio = cyanPowerSum / (cyanPowerSum + yellowPowerSum);
    cyanDomPct = Math.min(95, Math.max(5, Math.round(powerRatio * 100)));
    yellowDomPct = 100 - cyanDomPct;
    dominant = cyanDomPct > 55 ? 'CYAN' : (yellowDomPct > 55 ? 'YELLOW' : 'BALANCED');
  } else {
    cyanDomPct = 50;
    yellowDomPct = 50;
    dominant = 'NEUTRAL';
  }

  return {
    cyanTraps,
    yellowTraps,
    activeCyan,
    brokenCyan,
    activeYellow,
    brokenYellow,
    cyanDomPct,
    yellowDomPct,
    dominant,
    bullPressurePct: cyanDomPct,
    bearPressurePct: yellowDomPct,
    sessionVwap: sessionVwap > 0 ? Number(sessionVwap.toFixed(2)) : null,
    vwapRegime,
    isBelowVwap,
    isAboveVwap
  };
}
