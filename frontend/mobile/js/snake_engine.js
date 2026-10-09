/**
 * Escanor Mobile Terminal — Peak/Trough Engine
 * Matches Screenshot 2: 1m-10h peak/trough window monitor and displacement metrics.
 */

import { calcShiftScore, formatShiftScore } from './constants.js';

let selectedWindowMinutes = 1;
let rollingThermoHistory = [];

export function setWindowMinutes(mins, fromDropdown = false) {
  selectedWindowMinutes = Number(mins) || 1;
  const btns = document.querySelectorAll('.btn-win-min');
  const selectEl = document.getElementById('windowTimeframeSelect');

  if (fromDropdown) {
    btns.forEach(b => {
      b.className = 'btn-win-min px-1.5 py-0.5 rounded font-black border transition bg-slate-900 text-slate-400 border-white/5 hover:text-white cursor-pointer active:scale-95 flex-shrink-0';
    });
    if (selectEl) {
      selectEl.value = String(selectedWindowMinutes);
      selectEl.className = 'h-[19px] px-1 py-0 rounded font-black font-mono text-[8.5px] border transition bg-amber-500 text-black border-amber-400 shadow cursor-pointer focus:outline-none flex-shrink-0';
    }
  } else {
    btns.forEach(b => {
      const m = Number(b.getAttribute('data-min'));
      if (m === selectedWindowMinutes) {
        b.className = 'btn-win-min px-1.5 py-0.5 rounded font-black border transition bg-amber-500 text-black border-amber-400 shadow cursor-pointer active:scale-95 flex-shrink-0';
      } else {
        b.className = 'btn-win-min px-1.5 py-0.5 rounded font-black border transition bg-slate-900 text-slate-400 border-white/5 hover:text-white cursor-pointer active:scale-95 flex-shrink-0';
      }
    });
    if (selectEl) {
      selectEl.value = '';
      selectEl.className = 'h-[19px] px-1 py-0 rounded font-black font-mono text-[8.5px] border transition bg-slate-900 text-slate-300 border-white/10 hover:text-amber-300 cursor-pointer focus:outline-none flex-shrink-0';
    }
  }

  if (window.__lastTelemetry) {
    renderWindowHighLows(window.__lastTelemetry);
  }
}
window.setWindowMinutes = setWindowMinutes;

export function onWindowDropdownChange(val) {
  if (!val) return;
  setWindowMinutes(Number(val), true);
}
window.onWindowDropdownChange = onWindowDropdownChange;

export function renderWindowHighLows(tel) {
  const grid = document.getElementById('windowHighLowGrid');
  if (!grid) return;

  const now = Date.now();
  const activeLead = window.selectedLeadGauge || 'XAG';
  const leadPtTitles = {
    'XAG': 'SILVER BETA',
    'JPY': 'USD/JPY BETA',
    'DXY': 'DXY CASH BETA',
    'YLD': '10Y YIELD BETA',
    'NDX': 'NASDAQ 100 BETA',
    'CPR': 'COPPER BETA',
    'BTC': 'BITCOIN BETA',
    'XPT': 'PLATINUM BETA',
    'OIL': 'CRUDE OIL BETA',
    'GOL': 'GOLD SPOT BETA'
  };
  const activeLeadTitle = leadPtTitles[activeLead] || 'LEAD BETA';

  const ptWin = (tel && tel.peak_trough_windows && tel.peak_trough_windows[String(selectedWindowMinutes)])
    ? tel.peak_trough_windows[String(selectedWindowMinutes)]
    : null;

  let maxVel = null, minVel = null;
  let maxCvd = null, minCvd = null;
  let maxFp = null, minFp = null;
  let maxImp = null, minImp = null;
  let maxAg = null, minAg = null;

  if (ptWin) {
    if (ptWin.max_vel !== undefined && ptWin.max_vel !== null) maxVel = Number(ptWin.max_vel);
    if (ptWin.min_vel !== undefined && ptWin.min_vel !== null) minVel = Number(ptWin.min_vel);
    if (ptWin.max_cvd !== undefined && ptWin.max_cvd !== null) maxCvd = Number(ptWin.max_cvd);
    if (ptWin.min_cvd !== undefined && ptWin.min_cvd !== null) minCvd = Number(ptWin.min_cvd);
    if (ptWin.max_fp !== undefined && ptWin.max_fp !== null) maxFp = Number(ptWin.max_fp);
    if (ptWin.min_fp !== undefined && ptWin.min_fp !== null) minFp = Number(ptWin.min_fp);
    if (ptWin.max_imp !== undefined && ptWin.max_imp !== null) maxImp = Number(ptWin.max_imp);
    if (ptWin.min_imp !== undefined && ptWin.min_imp !== null) minImp = Number(ptWin.min_imp);

    if (ptWin.leads && ptWin.leads[activeLead]) {
      maxAg = Number(ptWin.leads[activeLead].max);
      minAg = Number(ptWin.leads[activeLead].min);
    } else if (ptWin.max_silver !== undefined && ptWin.max_silver !== null) {
      maxAg = Number(ptWin.max_silver);
      minAg = Number(ptWin.min_silver);
    }
  }

  const liveVel = Number(tel?.tape?.vel_1m || tel?.tape?.tick_velocity || 0);
  const liveCvd = Number(tel?.tape?.cvd_delta || 0);
  const liveFp = Number(tel?.tape?.footprint_delta || 0);
  const liveImp = Number(tel?.impulse?.rate_pt_min !== undefined ? tel.impulse.rate_pt_min : (tel?.tape?.impulse_rate || 0));
  const liveAg = Number(tel?.silver?.xag_pct !== undefined ? tel.silver.xag_pct : 0);
  const liveGold = Number(tel?.silver?.xau_pct !== undefined ? tel.silver.xau_pct : (tel?.spot?.xau_pct || 0));
  const liveLeads = {
    'XAG': liveAg,
    'JPY': Number(tel?.intermarket?.JPY?.pct !== undefined ? tel.intermarket.JPY.pct : 0),
    'DXY': Number(tel?.intermarket?.DXY?.pct !== undefined ? tel.intermarket.DXY.pct : 0),
    'YLD': Number(tel?.intermarket?.YLD?.pct !== undefined ? tel.intermarket.YLD.pct : 0),
    'NDX': Number(tel?.intermarket?.NDX?.pct !== undefined ? tel.intermarket.NDX.pct : 0),
    'CPR': Number(tel?.intermarket?.CPR?.pct !== undefined ? tel.intermarket.CPR.pct : 0),
    'BTC': Number(tel?.intermarket?.BTC?.pct !== undefined ? tel.intermarket.BTC.pct : 0),
    'XPT': Number(tel?.intermarket?.XPT?.pct !== undefined ? tel.intermarket.XPT.pct : 0),
    'OIL': Number(tel?.intermarket?.OIL?.pct !== undefined ? tel.intermarket.OIL.pct : 0),
    'GOL': liveGold
  };

  if (liveVel > 0 || liveCvd !== 0 || liveFp !== 0) {
    rollingThermoHistory.push({
      ts: now,
      vel: liveVel,
      cvd: liveCvd,
      fp: liveFp,
      impulse: liveImp,
      silver: liveAg,
      leads: liveLeads
    });
  }

  const pruneCutoff = now - (600 * 60 * 1000);
  if (rollingThermoHistory.length > 36000) {
    rollingThermoHistory = rollingThermoHistory.filter(h => h.ts >= pruneCutoff);
  }

  const winCutoff = now - (selectedWindowMinutes * 60 * 1000);
  const winSamples = rollingThermoHistory.filter(h => h.ts >= winCutoff);
  let sVels = [];
  let sCvds = [];
  let sFps = [];
  let sImps = [];
  let sAgs = [];
  if (winSamples.length > 0) {
    sVels = winSamples.map(s => s.vel).filter(v => v !== null && !isNaN(v));
    sCvds = winSamples.map(s => s.cvd).filter(v => v !== null && !isNaN(v));
    sFps = winSamples.map(s => s.fp).filter(v => v !== null && !isNaN(v));
    sImps = winSamples.map(s => s.impulse).filter(v => v !== null && !isNaN(v));
    sAgs = winSamples.map(s => (s.leads && s.leads[activeLead] !== undefined) ? s.leads[activeLead] : (activeLead === 'XAG' ? s.silver : null)).filter(v => v !== null && !isNaN(v));

    if (sVels.length > 0) {
      maxVel = maxVel !== null ? Math.max(maxVel, ...sVels) : Math.max(...sVels);
      minVel = minVel !== null ? Math.min(minVel, ...sVels) : Math.min(...sVels);
    }
    if (sCvds.length > 0) {
      maxCvd = maxCvd !== null ? Math.max(maxCvd, ...sCvds) : Math.max(...sCvds);
      minCvd = minCvd !== null ? Math.min(minCvd, ...sCvds) : Math.min(...sCvds);
    }
    if (sFps.length > 0) {
      maxFp = maxFp !== null ? Math.max(maxFp, ...sFps) : Math.max(...sFps);
      minFp = minFp !== null ? Math.min(minFp, ...sFps) : Math.min(...sFps);
    }
    if (sImps.length > 0) {
      maxImp = maxImp !== null ? Math.max(maxImp, ...sImps) : Math.max(...sImps);
      minImp = minImp !== null ? Math.min(minImp, ...sImps) : Math.min(...sImps);
    }
    if (sAgs.length > 0) {
      maxAg = maxAg !== null ? Math.max(maxAg, ...sAgs) : Math.max(...sAgs);
      minAg = minAg !== null ? Math.min(minAg, ...sAgs) : Math.min(...sAgs);
    }
  }

  if (maxVel === null) { maxVel = liveVel; minVel = liveVel; }
  if (maxCvd === null) { maxCvd = liveCvd; minCvd = liveCvd; }
  if (maxFp === null) { maxFp = liveFp; minFp = liveFp; }
  if (maxImp === null) { maxImp = liveImp; minImp = liveImp; }
  const curLeadVal = (liveLeads && liveLeads[activeLead] !== undefined) ? liveLeads[activeLead] : liveAg;
  if (maxAg === null) { maxAg = curLeadVal; minAg = curLeadVal; }

  const scoreAgMax = calcShiftScore(activeLead, maxAg, liveGold);
  const scoreAgMin = calcShiftScore(activeLead, minAg, liveGold);
  const scoreAgDel = Math.abs(scoreAgMax - scoreAgMin);

  const avgVel = sVels.length > 0 ? (sVels.reduce((a, b) => a + b, 0) / sVels.length) : liveVel;
  const avgCvd = sCvds.length > 0 ? (sCvds.reduce((a, b) => a + b, 0) / sCvds.length) : liveCvd;
  const avgFp = sFps.length > 0 ? (sFps.reduce((a, b) => a + b, 0) / sFps.length) : liveFp;
  const avgImp = sImps.length > 0 ? (sImps.reduce((a, b) => a + b, 0) / sImps.length) : liveImp;
  const sAgScores = sAgs.map(v => calcShiftScore(activeLead, v, liveGold));
  const curLeadScore = calcShiftScore(activeLead, curLeadVal, liveGold);
  const avgAgScore = sAgScores.length > 0 ? (sAgScores.reduce((a, b) => a + b, 0) / sAgScores.length) : curLeadScore;

  const velDispRange = Math.max(10, Math.abs(maxVel - minVel) / 2);
  const cvdDispRange = Math.max(50, Math.abs(maxCvd - minCvd) / 2);
  const fpDispRange = Math.max(20, Math.abs(maxFp - minFp) / 2);
  const impDispRange = Math.max(1.0, Math.abs(maxImp - minImp) / 2);
  const agDispRange = Math.max(5, scoreAgDel / 2);

  const velRatio = Math.max(-1.0, Math.min(1.0, (liveVel - avgVel) / velDispRange));
  const cvdRatio = Math.max(-1.0, Math.min(1.0, (liveCvd - avgCvd) / cvdDispRange));
  const fpRatio = Math.max(-1.0, Math.min(1.0, (liveFp - avgFp) / fpDispRange));
  const impRatio = Math.max(-1.0, Math.min(1.0, (liveImp - avgImp) / impDispRange));
  const agRatio = Math.max(-1.0, Math.min(1.0, (curLeadScore - avgAgScore) / agDispRange));

  function calcDisplacementStyle(ratio) {
    const mag = Math.min(48, Math.round(Math.abs(ratio) * 48));
    if (ratio > 0.04) {
      return `bottom: 50%; height: ${mag}%; background-color: #10b981; box-shadow: 0 0 6px rgba(16, 185, 129, 0.6);`;
    } else if (ratio < -0.04) {
      return `top: 50%; height: ${mag}%; background-color: #ef4444; box-shadow: 0 0 6px rgba(239, 68, 68, 0.6);`;
    } else {
      return `top: 50%; height: 2px; transform: translateY(-50%); background-color: #64748b;`;
    }
  }

  const elVelMax = document.getElementById('pt_vel_max');
  if (!elVelMax) {
    grid.innerHTML = `
      <div class="bg-slate-950/80 p-1 rounded border border-white/5 flex items-center justify-between gap-1 overflow-hidden" title="Velocity: Displacement from ${selectedWindowMinutes}m avg">
        <div class="space-y-0.5 min-w-0 flex-1">
          <div class="text-[8px] text-slate-400 font-bold truncate">VELOCITY</div>
          <div id="pt_vel_max" class="text-[11px] font-black text-emerald-400 leading-tight">▲${maxVel}</div>
          <div id="pt_vel_min" class="text-[10px] font-bold text-red-400 leading-tight">▼${minVel}</div>
          <div id="pt_vel_delta" class="text-[7.5px] text-slate-500 font-mono">Δ${Math.abs(maxVel - minVel)}</div>
        </div>
        <div class="w-1.5 h-[36px] bg-slate-900 rounded-full border border-white/10 relative flex-shrink-0 flex items-center justify-center overflow-hidden">
          <div class="absolute w-full h-[1px] bg-slate-500/70 top-1/2 -translate-y-1/2 z-10 pointer-events-none"></div>
          <div id="pt_vel_bar" class="absolute w-full rounded-full transition-all duration-200" style="${calcDisplacementStyle(velRatio)}"></div>
        </div>
      </div>

      <div class="bg-slate-950/80 p-1 rounded border border-white/5 flex items-center justify-between gap-1 overflow-hidden" title="CVD Delta: Displacement from ${selectedWindowMinutes}m avg">
        <div class="space-y-0.5 min-w-0 flex-1">
          <div class="text-[8px] text-slate-400 font-bold truncate">CVD DELTA</div>
          <div id="pt_cvd_max" class="text-[11px] font-black ${maxCvd >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight">▲${maxCvd >= 0 ? '+' : ''}${maxCvd}</div>
          <div id="pt_cvd_min" class="text-[10px] font-bold ${minCvd >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight">▼${minCvd >= 0 ? '+' : ''}${minCvd}</div>
          <div id="pt_cvd_delta" class="text-[7.5px] text-slate-500 font-mono">Δ${Math.abs(maxCvd - minCvd)}</div>
        </div>
        <div class="w-1.5 h-[36px] bg-slate-900 rounded-full border border-white/10 relative flex-shrink-0 flex items-center justify-center overflow-hidden">
          <div class="absolute w-full h-[1px] bg-slate-500/70 top-1/2 -translate-y-1/2 z-10 pointer-events-none"></div>
          <div id="pt_cvd_bar" class="absolute w-full rounded-full transition-all duration-200" style="${calcDisplacementStyle(cvdRatio)}"></div>
        </div>
      </div>

      <div class="bg-slate-950/80 p-1 rounded border border-white/5 flex items-center justify-between gap-1 overflow-hidden" title="Footprint: Displacement from ${selectedWindowMinutes}m avg">
        <div class="space-y-0.5 min-w-0 flex-1">
          <div class="text-[8px] text-slate-400 font-bold truncate">FOOTPRINT</div>
          <div id="pt_fp_max" class="text-[11px] font-black ${maxFp >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight">▲${maxFp >= 0 ? '+' : ''}${maxFp}L</div>
          <div id="pt_fp_min" class="text-[10px] font-bold ${minFp >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight">▼${minFp >= 0 ? '+' : ''}${minFp}L</div>
          <div id="pt_fp_delta" class="text-[7.5px] text-slate-500 font-mono">Δ${Math.abs(maxFp - minFp)}L</div>
        </div>
        <div class="w-1.5 h-[36px] bg-slate-900 rounded-full border border-white/10 relative flex-shrink-0 flex items-center justify-center overflow-hidden">
          <div class="absolute w-full h-[1px] bg-slate-500/70 top-1/2 -translate-y-1/2 z-10 pointer-events-none"></div>
          <div id="pt_fp_bar" class="absolute w-full rounded-full transition-all duration-200" style="${calcDisplacementStyle(fpRatio)}"></div>
        </div>
      </div>

      <div class="bg-slate-950/80 p-1 rounded border border-white/5 flex items-center justify-between gap-1 overflow-hidden" title="Impulse: Displacement from ${selectedWindowMinutes}m avg">
        <div class="space-y-0.5 min-w-0 flex-1">
          <div class="text-[8px] text-slate-400 font-bold truncate">IMPULSE</div>
          <div id="pt_imp_max" class="text-[11px] font-black ${maxImp >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight">▲${maxImp >= 0 ? '+' : ''}${maxImp.toFixed(1)}</div>
          <div id="pt_imp_min" class="text-[10px] font-bold ${minImp >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight">▼${minImp >= 0 ? '+' : ''}${minImp.toFixed(1)}</div>
          <div id="pt_imp_delta" class="text-[7.5px] text-slate-500 font-mono">Δ${Math.abs(maxImp - minImp).toFixed(1)}pt</div>
        </div>
        <div class="w-1.5 h-[36px] bg-slate-900 rounded-full border border-white/10 relative flex-shrink-0 flex items-center justify-center overflow-hidden">
          <div class="absolute w-full h-[1px] bg-slate-500/70 top-1/2 -translate-y-1/2 z-10 pointer-events-none"></div>
          <div id="pt_imp_bar" class="absolute w-full rounded-full transition-all duration-200" style="${calcDisplacementStyle(impRatio)}"></div>
        </div>
      </div>

      <div class="bg-slate-950/80 p-1 rounded border border-white/5 flex items-center justify-between gap-1 overflow-hidden" title="${activeLeadTitle}: Displacement from ${selectedWindowMinutes}m avg">
        <div class="space-y-0.5 min-w-0 flex-1">
          <div id="pt_lead_title" class="text-[8px] text-slate-400 font-bold truncate">${activeLeadTitle}</div>
          <div id="pt_ag_max" class="text-[11px] font-black ${scoreAgMax >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight">▲${formatShiftScore(scoreAgMax)}</div>
          <div id="pt_ag_min" class="text-[10px] font-bold ${scoreAgMin >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight">▼${formatShiftScore(scoreAgMin)}</div>
          <div id="pt_ag_delta" class="text-[7.5px] text-slate-500 font-mono">Δ${scoreAgDel < 10 ? '0' + scoreAgDel : scoreAgDel}</div>
        </div>
        <div class="w-1.5 h-[36px] bg-slate-900 rounded-full border border-white/10 relative flex-shrink-0 flex items-center justify-center overflow-hidden">
          <div class="absolute w-full h-[1px] bg-slate-500/70 top-1/2 -translate-y-1/2 z-10 pointer-events-none"></div>
          <div id="pt_ag_bar" class="absolute w-full rounded-full transition-all duration-200" style="${calcDisplacementStyle(agRatio)}"></div>
        </div>
      </div>
    `;
    return;
  }

  elVelMax.textContent = `▲${maxVel}`;
  const elVelMin = document.getElementById('pt_vel_min');
  if (elVelMin) elVelMin.textContent = `▼${minVel}`;
  const elVelDel = document.getElementById('pt_vel_delta');
  if (elVelDel) elVelDel.textContent = `Δ${Math.abs(maxVel - minVel)}`;
  const elVelBar = document.getElementById('pt_vel_bar');
  if (elVelBar) elVelBar.style.cssText = calcDisplacementStyle(velRatio);

  const elCvdMax = document.getElementById('pt_cvd_max');
  if (elCvdMax) {
    elCvdMax.textContent = `▲${maxCvd >= 0 ? '+' : ''}${maxCvd}`;
    elCvdMax.className = `text-[11px] font-black ${maxCvd >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight`;
  }
  const elCvdMin = document.getElementById('pt_cvd_min');
  if (elCvdMin) {
    elCvdMin.textContent = `▼${minCvd >= 0 ? '+' : ''}${minCvd}`;
    elCvdMin.className = `text-[10px] font-bold ${minCvd >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight`;
  }
  const elCvdDel = document.getElementById('pt_cvd_delta');
  if (elCvdDel) elCvdDel.textContent = `Δ${Math.abs(maxCvd - minCvd)}`;
  const elCvdBar = document.getElementById('pt_cvd_bar');
  if (elCvdBar) elCvdBar.style.cssText = calcDisplacementStyle(cvdRatio);

  const elFpMax = document.getElementById('pt_fp_max');
  if (elFpMax) {
    elFpMax.textContent = `▲${maxFp >= 0 ? '+' : ''}${maxFp}L`;
    elFpMax.className = `text-[11px] font-black ${maxFp >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight`;
  }
  const elFpMin = document.getElementById('pt_fp_min');
  if (elFpMin) {
    elFpMin.textContent = `▼${minFp >= 0 ? '+' : ''}${minFp}L`;
    elFpMin.className = `text-[10px] font-bold ${minFp >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight`;
  }
  const elFpDel = document.getElementById('pt_fp_delta');
  if (elFpDel) elFpDel.textContent = `Δ${Math.abs(maxFp - minFp)}L`;
  const elFpBar = document.getElementById('pt_fp_bar');
  if (elFpBar) elFpBar.style.cssText = calcDisplacementStyle(fpRatio);

  const elImpMax = document.getElementById('pt_imp_max');
  if (elImpMax) {
    elImpMax.textContent = `▲${maxImp >= 0 ? '+' : ''}${maxImp.toFixed(1)}`;
    elImpMax.className = `text-[11px] font-black ${maxImp >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight`;
  }
  const elImpMin = document.getElementById('pt_imp_min');
  if (elImpMin) {
    elImpMin.textContent = `▼${minImp >= 0 ? '+' : ''}${minImp.toFixed(1)}`;
    elImpMin.className = `text-[10px] font-bold ${minImp >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight`;
  }
  const elImpDel = document.getElementById('pt_imp_delta');
  if (elImpDel) elImpDel.textContent = `Δ${Math.abs(maxImp - minImp).toFixed(1)}pt`;
  const elImpBar = document.getElementById('pt_imp_bar');
  if (elImpBar) elImpBar.style.cssText = calcDisplacementStyle(impRatio);

  const elLeadTitle = document.getElementById('pt_lead_title');
  if (elLeadTitle) elLeadTitle.textContent = activeLeadTitle;

  const elAgMax = document.getElementById('pt_ag_max');
  if (elAgMax) {
    elAgMax.textContent = `▲${formatShiftScore(scoreAgMax)}`;
    elAgMax.className = `text-[11px] font-black ${scoreAgMax >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight`;
  }
  const elAgMin = document.getElementById('pt_ag_min');
  if (elAgMin) {
    elAgMin.textContent = `▼${formatShiftScore(scoreAgMin)}`;
    elAgMin.className = `text-[10px] font-bold ${scoreAgMin >= 0 ? 'text-emerald-400' : 'text-red-400'} leading-tight`;
  }
  const elAgDel = document.getElementById('pt_ag_delta');
  if (elAgDel) elAgDel.textContent = `Δ${scoreAgDel < 10 ? '0' + scoreAgDel : scoreAgDel}`;
  const elAgBar = document.getElementById('pt_ag_bar');
  if (elAgBar) elAgBar.style.cssText = calcDisplacementStyle(agRatio);
}

