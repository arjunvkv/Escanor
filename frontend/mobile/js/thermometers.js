/**
 * Escanor Mobile Terminal — Mercury Gauges & Tape Physics Thermometers
 * Matches Screenshot 3: 5 vertical mercury gauge tubes (Velocity dual-tube, CVD, Footprint with blocks, Impulse, and Silver/Intermarket Lead).
 */

import { calcShiftScore, formatShiftScore, formatPrice } from './constants.js';
import { updateGaugeStoryNumbers } from './thermo_story_engine.js';

let selectedLeadGauge = 'XAG';

export function selectLeadGauge(sym) {
  selectedLeadGauge = String(sym).toUpperCase();
  window.selectedLeadGauge = selectedLeadGauge;
  if (window.__lastTelemetry) {
    renderMobileThermometers(window.__lastTelemetry);
  }
}
window.selectLeadGauge = selectLeadGauge;

export function buildDualVelocityThermo({ vel1m, vel5m, vel10mMax, story }) {
  const storyTop = story?.top || { text: 'EXP: --', color: '#64748b' };
  const storyBottom = story?.bottom || { text: 'COIL: --', color: '#64748b' };

  const v1 = Number(vel1m) || 0;
  const v5 = Number(vel5m) || 0;
  const p1 = Math.max(0.01, Math.min(0.99, v1 / 140));
  const p5 = Math.max(0.01, Math.min(0.99, v5 / 140));

  const c1 = v1 >= 100 ? '#10b981' : (v1 >= 45 ? '#f59e0b' : '#94a3b8');
  const c5 = v5 >= 100 ? '#10b981' : (v5 >= 45 ? '#f59e0b' : '#94a3b8');
  const lbl1 = v1 >= 100 ? 'KINETIC' : (v1 >= 45 ? 'ACTIVE' : 'QUIET');
  const lbl5 = v5 >= 100 ? 'KINETIC' : (v5 >= 45 ? 'ACTIVE' : 'QUIET');

  const W = 68;
  const TUBE_W = 12.5;
  const TUBE_H = 100;
  const TUBE_Y = 12;
  const BULB_R = 8.5;
  const BULB_CY = TUBE_Y + TUBE_H + BULB_R + 2;
  const SVG_H = BULB_CY + BULB_R + 3;

  const X1 = 13;
  const X2 = 42;

  const fillH1 = Math.max(2, TUBE_H * p1);
  const fillY1 = TUBE_Y + (TUBE_H - fillH1);
  const ptrY1 = TUBE_Y + TUBE_H * (1 - p1);

  const fillH2 = Math.max(2, TUBE_H * p5);
  const fillY2 = TUBE_Y + (TUBE_H - fillH2);
  const ptrY2 = TUBE_Y + TUBE_H * (1 - p5);

  const y100 = TUBE_Y + TUBE_H * (1 - 100 / 140);
  const y45 = TUBE_Y + TUBE_H * (1 - 45 / 140);

  const svg = `
    <svg width="${W + 8}" height="${SVG_H}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block;margin:0 auto;">
      <text x="${X1 + TUBE_W / 2}" y="8.5" font-size="7.5" font-weight="900" fill="#e2e8f0" text-anchor="middle" font-family="monospace">1M</text>
      <text x="${X2 + TUBE_W / 2}" y="8.5" font-size="7.5" font-weight="900" fill="#fcd34d" text-anchor="middle" font-family="monospace">5M</text>

      <line x1="6" y1="${y100}" x2="${W + 2}" y2="${y100}" stroke="#10b981" stroke-width="0.8" stroke-dasharray="2,2" opacity="0.85"/>
      <text x="4" y="${y100 + 2.5}" font-size="7" fill="#10b981" text-anchor="end" font-family="monospace">100</text>
      <line x1="6" y1="${y45}" x2="${W + 2}" y2="${y45}" stroke="#f59e0b" stroke-width="0.8" stroke-dasharray="2,2" opacity="0.85"/>
      <text x="4" y="${y45 + 2.5}" font-size="7" fill="#f59e0b" text-anchor="end" font-family="monospace">45</text>

      <rect x="${X1}" y="${TUBE_Y}" width="${TUBE_W}" height="${TUBE_H}" rx="4" fill="rgba(12,18,35,0.95)" stroke="rgba(255,255,255,0.13)" stroke-width="1"/>
      <rect x="${X1 + 1.5}" y="${fillY1}" width="${TUBE_W - 3}" height="${fillH1}" rx="2.5" fill="${c1}" opacity="0.85"/>
      <circle cx="${X1 + TUBE_W / 2}" cy="${BULB_CY}" r="${BULB_R}" fill="${c1}" opacity="0.9"/>
      <polygon points="${X1 - 1},${ptrY1} ${X1 - 5},${ptrY1 - 2.5} ${X1 - 5},${ptrY1 + 2.5}" fill="${c1}" opacity="0.95"/>

      <rect x="${X2}" y="${TUBE_Y}" width="${TUBE_W}" height="${TUBE_H}" rx="4" fill="rgba(12,18,35,0.95)" stroke="rgba(255,255,255,0.13)" stroke-width="1"/>
      <rect x="${X2 + 1.5}" y="${fillY2}" width="${TUBE_W - 3}" height="${fillH2}" rx="2.5" fill="${c5}" opacity="0.85"/>
      <circle cx="${X2 + TUBE_W / 2}" cy="${BULB_CY}" r="${BULB_R}" fill="${c5}" opacity="0.9"/>
      <polygon points="${X2 + TUBE_W + 1},${ptrY2} ${X2 + TUBE_W + 5},${ptrY2 - 2.5} ${X2 + TUBE_W + 5},${ptrY2 + 2.5}" fill="${c5}" opacity="0.95"/>
    </svg>
  `;

  return `
    <div onclick="openMetricModal('velocity')" class="flex flex-col items-center gap-0.5 flex-1 min-w-[70px] cursor-pointer active:scale-95 transition hover:opacity-90" title="Tap to inspect Tape Tick Velocity">
      <div class="text-[10px] font-black text-slate-200 tracking-wider text-center whitespace-nowrap">⚡ VELOCITY</div>
      <!-- Story Number (Above Tube) -->
      <div class="w-full px-1 py-0.5 rounded bg-[#061826] border border-emerald-400/60 shadow-[0_0_6px_rgba(16,185,129,0.25)] text-[9px] font-black font-mono leading-none tracking-tight text-center whitespace-nowrap min-h-[16px] flex items-center justify-center my-0.5" style="color:${storyTop.color || '#34d399'};">
        ${storyTop.text || '▲ 0s EXP'}
      </div>
      <div class="text-[7.5px] font-mono text-slate-400 text-center whitespace-nowrap">▲140+</div>
      <div class="relative flex items-center justify-center w-full">${svg}</div>
      <div class="text-[7.5px] font-mono text-slate-400 text-center whitespace-nowrap">▼0</div>
      <!-- Story Number (Below Tube) -->
      <div class="w-full px-1 py-0.5 rounded bg-[#211206] border border-amber-400/60 shadow-[0_0_6px_rgba(245,158,11,0.25)] text-[9px] font-black font-mono leading-none tracking-tight text-center whitespace-nowrap min-h-[16px] flex items-center justify-center my-0.5" style="color:${storyBottom.color || '#fbbf24'};">
        ${storyBottom.text || '▼ 0s STALL'}
      </div>
      <div class="flex justify-between w-full px-0.5 mt-0.5 text-center">
        <div>
          <div class="text-[13.5px] font-black font-mono leading-none" style="color:${c1};">${v1.toFixed(0)}</div>
          <div class="text-[8.5px] font-bold" style="color:${c1};">${lbl1}</div>
        </div>
        <div>
          <div class="text-[13.5px] font-black font-mono leading-none" style="color:${c5};">${v5.toFixed(0)}</div>
          <div class="text-[8.5px] font-bold" style="color:${c5};">${lbl5}</div>
        </div>
      </div>
      <div class="text-[7.5px] text-slate-400 text-center leading-tight font-mono min-h-[12px] flex items-center justify-center">
        10M↑${vel10mMax || v1.toFixed(0)} t/m
      </div>
      <div class="min-h-[12px] flex items-center justify-center">
        <div style="font-size:8px;color:#f59e0b;font-weight:900;text-align:center;line-height:12px;">TAPE PACE</div>
      </div>
    </div>
  `;
}

export function buildThermo({ metricKey, title, unit, pct, fillColor, bipolar,
                       current, currentLabel, markers, highLabel, lowLabel, footer, extraHtml, sideHtml, story }) {
  const hasSide = Boolean(sideHtml);
  const COL_W = hasSide ? 78 : 58;
  const TUBE_W = 14;
  const TUBE_H = 100;
  const BULB_R = 8.5;
  const TUBE_X = hasSide ? 16 : (COL_W - TUBE_W) / 2;
  const TUBE_Y = 12;
  const BULB_CY = TUBE_Y + TUBE_H + BULB_R + 2;
  const SVG_H = BULB_CY + BULB_R + 3;
  const BULB_CX = TUBE_X + TUBE_W / 2;

  const storyTop = story?.top || { text: '--', color: '#64748b' };
  const storyBottom = story?.bottom || { text: '--', color: '#64748b' };

  const p = Math.max(0.01, Math.min(0.99, Number(pct) || 0.5));

  let fillY, fillH;
  if (bipolar) {
    const centerY = TUBE_Y + TUBE_H * 0.5;
    if (p >= 0.5) {
      fillH = TUBE_H * (p - 0.5);
      fillY = centerY - fillH;
    } else {
      fillY = centerY;
      fillH = TUBE_H * (0.5 - p);
    }
  } else {
    fillH = TUBE_H * p;
    fillY = TUBE_Y + (TUBE_H - fillH);
  }
  fillH = Math.max(2, fillH);

  const pointerY = TUBE_Y + TUBE_H * (1 - p);
  const ptrArrowSvg = hasSide
    ? `<polygon points="${TUBE_X},${pointerY} ${TUBE_X - 6},${pointerY - 3} ${TUBE_X - 6},${pointerY + 3}" fill="${fillColor}" opacity="0.95"/>`
    : `<polygon points="${TUBE_X + TUBE_W},${pointerY} ${TUBE_X + TUBE_W + 6},${pointerY - 3} ${TUBE_X + TUBE_W + 6},${pointerY + 3}" fill="${fillColor}" opacity="0.95"/>`;

  let mkSvg = '';
  (markers || []).forEach(m => {
    const my = TUBE_Y + TUBE_H * (1 - Math.max(0, Math.min(1, m.pct)));
    if (m.side === 'left' || hasSide) {
      mkSvg += `<line x1="${TUBE_X}" y1="${my}" x2="${TUBE_X + TUBE_W}" y2="${my}" stroke="${m.color}" stroke-width="0.8" stroke-dasharray="2,2" opacity="0.85"/>`;
      mkSvg += `<text x="${TUBE_X - 2}" y="${my + 2.5}" font-size="7" fill="${m.color}" text-anchor="end" font-family="monospace" opacity="0.95">${m.label}</text>`;
    } else {
      mkSvg += `<line x1="${TUBE_X}" y1="${my}" x2="${TUBE_X + TUBE_W}" y2="${my}" stroke="${m.color}" stroke-width="0.8" stroke-dasharray="2,2" opacity="0.85"/>`;
      mkSvg += `<text x="${TUBE_X + TUBE_W + 2}" y="${my + 2.5}" font-size="7" fill="${m.color}" text-anchor="start" font-family="monospace" opacity="0.95">${m.label}</text>`;
    }
  });

  const svg = `
    <svg width="${COL_W}" height="${SVG_H}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;display:block;margin:0 auto;">
      <rect x="${TUBE_X}" y="${TUBE_Y}" width="${TUBE_W}" height="${TUBE_H}" rx="4" fill="rgba(12,18,35,0.95)" stroke="rgba(255,255,255,0.13)" stroke-width="1"/>
      <rect x="${TUBE_X + 1.5}" y="${fillY}" width="${TUBE_W - 3}" height="${fillH}" rx="3" fill="${fillColor}" opacity="0.85"/>
      <rect x="${TUBE_X}" y="${fillY}" width="${TUBE_W}" height="${fillH}" rx="4" fill="${fillColor}" opacity="0.12"/>
      ${mkSvg}
      ${ptrArrowSvg}
      <circle cx="${BULB_CX}" cy="${BULB_CY}" r="${BULB_R}" fill="${fillColor}" opacity="0.9"/>
      <circle cx="${BULB_CX}" cy="${BULB_CY}" r="${BULB_R - 3}" fill="${fillColor}" opacity="0.45"/>
    </svg>
  `;

  return `
    <div onclick="openMetricModal('${metricKey}')" class="flex flex-col items-center gap-0.5 flex-1 ${hasSide ? 'min-w-[78px]' : 'min-w-[58px]'} cursor-pointer active:scale-95 transition hover:opacity-90" title="Tap to inspect ${title}">
      <div class="text-[10px] font-black text-slate-200 tracking-wider text-center whitespace-nowrap">${title}</div>
      <!-- Story Number (Above Tube) -->
      <div class="w-full px-1 py-0.5 rounded bg-[#061826] border border-emerald-400/60 shadow-[0_0_6px_rgba(16,185,129,0.25)] text-[9px] font-black font-mono leading-none tracking-tight text-center whitespace-nowrap min-h-[16px] flex items-center justify-center my-0.5" style="color:${storyTop.color || '#34d399'};">
        ${storyTop.text || '▲ 0'}
      </div>
      <div class="text-[7.5px] font-mono text-slate-400 text-center whitespace-nowrap">▲${highLabel}</div>
      <div class="relative flex items-center justify-center w-full">
        ${svg}
        ${hasSide ? `
        <div class="absolute left-[38px] top-[62px] -translate-y-1/2 flex flex-col gap-0.5 z-10 pointer-events-none">
          ${sideHtml}
        </div>
        ` : ''}
      </div>
      <div class="text-[7.5px] font-mono text-slate-400 text-center whitespace-nowrap">▼${lowLabel}</div>
      <!-- Story Number (Below Tube) -->
      <div class="w-full px-1 py-0.5 rounded bg-[#211206] border border-amber-400/60 shadow-[0_0_6px_rgba(245,158,11,0.25)] text-[9px] font-black font-mono leading-none tracking-tight text-center whitespace-nowrap min-h-[16px] flex items-center justify-center my-0.5" style="color:${storyBottom.color || '#fbbf24'};">
        ${storyBottom.text || '▼ 0'}
      </div>
      <div class="text-[14px] font-black font-mono text-center leading-none" style="color:${fillColor};">${current}</div>
      <div class="text-[8.5px] font-bold text-center whitespace-nowrap" style="color:${fillColor};">${currentLabel}</div>
      <div class="text-[7.5px] text-slate-400 text-center leading-tight whitespace-nowrap font-mono min-h-[12px] flex items-center justify-center">${footer || ''}</div>
      <div class="min-h-[12px] flex items-center justify-center">${extraHtml || ''}</div>
    </div>
  `;
}

export function renderMobileThermometers(tel) {
  const container = document.getElementById('thermoColumnsContainer');
  if (!container) return;

  const tape = (tel && tel.tape) || {};
  const silver = (tel && tel.silver) || {};

  // Accumulate & format Live Story Numbers across all 5 gauges
  const story = updateGaugeStoryNumbers(tel) || {};

  // 1. Velocity (Dual Tube 1M & 5M)
  const vel1m = tape.vel_1m !== undefined ? Number(tape.vel_1m) : (Number(tape.tick_velocity) || 0);
  const vel5m = tape.vel_5m_avg !== undefined ? Number(tape.vel_5m_avg) : (Number(tape.vel_5m) || vel1m);
  const vel10mMax = tape.vel_10m_max || tape.vel_10m || vel1m;
  const thermoVel = buildDualVelocityThermo({ vel1m, vel5m, vel10mMax, story: story.velocity });

  // 2. CVD Delta (+/- 1200)
  const cvd = Number(tape.cvd_delta) || 0;
  const cvdPct = Math.max(0.01, Math.min(0.99, 0.5 + cvd / 1200));
  const cvdColor = cvd >= 0 ? '#10b981' : '#ef4444';
  const cvdLabel = cvd >= 50 ? 'ACCUM' : (cvd <= -50 ? 'DIST' : 'NEUTRAL');
  const thermoCvd = buildThermo({
    metricKey: 'cvd',
    title: '🌊 CVD', unit: 'L',
    pct: cvdPct, fillColor: cvdColor, bipolar: true,
    current: (cvd >= 0 ? '+' : '') + cvd.toFixed(0),
    currentLabel: cvdLabel,
    markers: [{ pct: 0.5, label: '0', color: '#fff', side: 'right' }],
    highLabel: '+600', lowLabel: '-600',
    footer: `Slope:${cvd > 0 ? '▲' : '▼'} ${cvdLabel}`,
    extraHtml: `<div style="font-size:8px;color:#10b981;text-align:center;font-weight:900;letter-spacing:0.02em;">FLOW DELTA</div>`,
    story: story.cvd
  });

  // 3. 4M Footprint Delta (+/- 1600 with 4 BLOCKS Column)
  const fp = Number(tape.footprint_delta) || 0;
  const fpPct = Math.max(0.01, Math.min(0.99, 0.5 + fp / 1600));
  const fpColor = fp >= 0 ? '#10b981' : '#ef4444';
  const fpLabel = fp >= 100 ? 'BID LIFT' : (fp <= -100 ? 'ASK DUMP' : 'NEUTRAL');
  const rawBlocks = tape.recent_fp_blocks || tape.footprint_4m_blocks || tape.footprint_4m || [];
  const fpBlocks = rawBlocks.slice(-4);
  const fpPillsHtml = fpBlocks.map(b => {
    const val = typeof b === 'object' && b !== null ? (b.delta !== undefined ? b.delta : 0) : Number(b) || 0;
    const c = val >= 0 ? '#10b981' : '#ef4444';
    return `<div style="background:${c}22;border:1px solid ${c}88;color:${c};font-size:8px;padding:1.5px 3.5px;border-radius:3px;text-align:center;font-weight:800;font-family:monospace;line-height:1.2;">${val >= 0 ? '+' : ''}${val}</div>`;
  }).join('');

  const thermoFp = buildThermo({
    metricKey: 'footprint',
    title: '📊 FOOT', unit: 'L',
    pct: fpPct, fillColor: fpColor, bipolar: true,
    current: (fp >= 0 ? '+' : '') + fp.toFixed(0),
    currentLabel: fpLabel,
    markers: [{ pct: 0.5, label: '0L', color: '#fff', side: 'left' }],
    highLabel: '+800', lowLabel: '-800',
    footer: `Net:${fp >= 0 ? '+' : ''}${fp.toFixed(0)}L`,
    sideHtml: fpPillsHtml ? `<div style="font-size:6.5px;color:#94a3b8;font-weight:900;text-align:center;margin-bottom:1.5px;letter-spacing:0.04em;">BLOCKS</div>${fpPillsHtml}` : '',
    extraHtml: `<div style="font-size:8px;color:#f59e0b;text-align:center;font-weight:800;white-space:nowrap;">4M DELTA</div>`,
    story: story.footprint
  });

  // 4. Impulse (Price Displacement Velocity pt/m)
  const impulseData = tel.impulse || (tel.tape && tel.tape.impulse) || {};
  const ratePtMin = impulseData.rate_pt_min !== undefined ? Number(impulseData.rate_pt_min) : (Number(tape.impulse_rate) || 0);
  const disp1m = impulseData.disp_1m_pt !== undefined ? Number(impulseData.disp_1m_pt) : (Number(tape.disp_1m_pt) || 0);
  const disp5m = impulseData.disp_5m_pt !== undefined ? Number(impulseData.disp_5m_pt) : (Number(tape.disp_5m_pt) || 0);

  const impulsePct = Math.max(0.01, Math.min(0.99, 0.5 + (ratePtMin / 12.0)));
  let impulseColor = '#f59e0b';
  let impulseLabel = 'COIL ⏸';
  if (ratePtMin >= 2.5) { impulseColor = '#10b981'; impulseLabel = 'SURGE ⚡'; }
  else if (ratePtMin >= 0.8) { impulseColor = '#34d399'; impulseLabel = 'BULL ↗'; }
  else if (ratePtMin <= -2.5) { impulseColor = '#ef4444'; impulseLabel = 'CASCADE 🛑'; }
  else if (ratePtMin <= -0.8) { impulseColor = '#f87171'; impulseLabel = 'BEAR ↘'; }

  const thermoImpulse = buildThermo({
    metricKey: 'impulse',
    title: '⚡ IMPULSE', unit: 'pt/m',
    pct: impulsePct, fillColor: impulseColor, bipolar: true,
    current: (ratePtMin >= 0 ? '+' : '') + ratePtMin.toFixed(1),
    currentLabel: impulseLabel,
    markers: [
      { pct: 0.5, label: '0.0', color: '#fff', side: 'right' },
      { pct: 0.75, label: '+3.0', color: '#10b981', side: 'left' },
      { pct: 0.25, label: '-3.0', color: '#ef4444', side: 'left' }
    ],
    highLabel: '+6.0 pt/m', lowLabel: '-6.0 pt/m',
    footer: `1M:${disp1m >= 0 ? '+' : ''}${disp1m.toFixed(1)}pt · 5M:${disp5m >= 0 ? '+' : ''}${disp5m.toFixed(1)}pt`,
    extraHtml: `<div style="font-size:8px;color:${impulseColor};text-align:center;font-weight:900;letter-spacing:0.02em;">DISP VELOCITY</div>`,
    story: story.impulse
  });

  // 5. Intermarket Lead Gauge (Silver or Selected)
  const intermarket = (tel && tel.intermarket) || {};
  const xauPct = Number(silver.xau_pct !== undefined ? silver.xau_pct : (tel && tel.spot && tel.spot.xau_pct || 0));

  const activeSym = selectedLeadGauge || 'XAG';
  const leadConfigs = {
    'XAG': { title: '🥈 SILVER', span: 1.6, isInverse: false },
    'JPY': { title: '🇯🇵 USD/JPY', span: 0.6, isInverse: true },
    'DXY': { title: '💵 DXY CASH', span: 0.6, isInverse: true },
    'YLD': { title: '🏛️ 10Y YIELD', span: 1.0, isInverse: true },
    'NDX': { title: '📈 NASDAQ 100', span: 2.0, isInverse: false },
    'CPR': { title: '🧱 COPPER', span: 2.0, isInverse: false },
    'BTC': { title: '⚡ BITCOIN', span: 5.0, isInverse: false },
    'XPT': { title: '🛡️ PLATINUM', span: 1.6, isInverse: false },
    'OIL': { title: '🛢️ CRUDE OIL', span: 3.0, isInverse: false },
    'GOL': { title: '🪙 GOLD SPOT', span: 1.6, isInverse: false }
  };

  const curCfg = leadConfigs[activeSym] || leadConfigs['XAG'];
  const curData = (activeSym === 'GOL')
    ? { bid: tel?.spot?.bid || (tel?.tape && tel.tape.ask), pct: xauPct }
    : (intermarket[activeSym] || (activeSym === 'XAG' ? { bid: silver.bid, pct: silver.xag_pct } : {}));
  const curPct = Number(curData.pct !== undefined ? curData.pct : 0.0);

  const effectiveGoldPct = curCfg.isInverse ? -curPct : curPct;
  const dispFromGold = (activeSym === 'GOL') ? 0.0 : (effectiveGoldPct - xauPct);
  const activeScore = calcShiftScore(activeSym, curPct, xauPct);

  // The thermometer tube spans -99 to +99 with 00 at center (pct = 0.5)
  // +38 is at pct = 0.6875, -38 is at pct = 0.3125, +99 at top, -99 at bottom
  const gaugeNormPct = Math.max(0.02, Math.min(0.98, 0.5 + (activeScore / 198)));

  let curColor = '#94a3b8';
  let curLabel = 'SYNCHRONIZED (00)';
  let curStatus = '✔ ZERO DISPLACEMENT';

  if (activeSym === 'XAG') {
    const isOppositeSign = (curPct * xauPct < 0) && Math.abs(dispFromGold) >= 0.04;
    if (isOppositeSign) {
      curColor = '#f59e0b'; curLabel = 'DIVERGENT ⚠️'; curStatus = '⚠️ THIN TRAP';
    } else if (activeScore >= 15) {
      curColor = '#10b981'; curLabel = 'BULL BETA ⚡'; curStatus = '✔ BETA ALIGNED';
    } else if (activeScore > 3) {
      curColor = '#34d399'; curLabel = 'BULL ALIGNED'; curStatus = '✔ POSITIVE LEAD';
    } else if (activeScore <= -15) {
      curColor = '#ef4444'; curLabel = 'BEAR BETA ⚡'; curStatus = '✔ BEAR DRAG';
    } else if (activeScore < -3) {
      curColor = '#f87171'; curLabel = 'BEAR ALIGNED'; curStatus = '⚠️ LAGGING GOLD';
    }
  } else {
    if (activeScore >= 10) {
      curColor = '#10b981'; curLabel = 'LEAD ⚡'; curStatus = '✔ STRONG TAILWIND';
    } else if (activeScore > 3) {
      curColor = '#34d399'; curLabel = 'BULL ↗'; curStatus = '✔ SUPPORTIVE FLOW';
    } else if (activeScore <= -10) {
      curColor = '#ef4444'; curLabel = 'DRAG 🛑'; curStatus = '⚠ HEADWIND PRESSURE';
    } else if (activeScore < -3) {
      curColor = '#f87171'; curLabel = 'BEAR ↘'; curStatus = '⚠ RESISTIVE DRAG';
    }
  }

  const thermoLead = buildThermo({
    metricKey: 'silver',
    title: curCfg.title,
    unit: '',
    pct: gaugeNormPct,
    fillColor: curColor,
    bipolar: true,
    current: formatShiftScore(activeScore),
    currentLabel: curLabel,
    markers: [
      { pct: 0.5, label: '00', color: '#fff', side: 'right' },
      { pct: 0.6875, label: '+38', color: '#10b981', side: 'left' },
      { pct: 0.3125, label: '-38', color: '#ef4444', side: 'left' }
    ],
    highLabel: '+99',
    lowLabel: '-99',
    footer: `${dispFromGold >= 0 ? '+' : ''}${dispFromGold.toFixed(2)}% vs XAU`,
    extraHtml: `<div style="font-size:8px;color:${curColor};text-align:center;font-weight:900;letter-spacing:0.02em;">${curStatus}</div>`,
    story: story.silver
  });

  container.innerHTML = thermoVel + thermoCvd + thermoFp + thermoImpulse + thermoLead;
}
