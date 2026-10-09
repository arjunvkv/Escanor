/**
 * Escanor Mobile Terminal — Gauge Story Numbers & Auction State Accumulator
 * Tracks duration, streak, and intensity of tape physics across frames:
 * 1. Velocity: Kinetic Expansion Run (EXP) vs Quiet Absorption Stall (COIL)
 * 2. CVD: Cumulative Aggressor Delta (ACC) vs Absorption Spring (DIST)
 * 3. Footprint: Bullish Block Lift Ratio (LIFT) vs Bearish Dump Ratio (DUMP)
 * 4. Impulse: Trend Displacement Age (SURGE) vs Compression Coil Duration (COIL)
 * 5. Intermarket Lead: Beta Outperformance Streak (BETA) vs Divergent Headwind (DRAG)
 */

let state = {
  // 1. Velocity
  kineticStart: null,
  stallStart: null,

  // 2. CVD
  lastCvdSign: 0,
  cvdStreakStart: null,

  // 3. Footprint
  lastLiftRatio: '0/4',
  lastDumpRatio: '0/4',

  // 4. Impulse
  surgeStart: null,
  impulseCoilStart: null,

  // 5. Intermarket Lead
  leadStart: null,
  dragStart: null
};

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem < 10 ? '0' + rem : rem}s`;
  }
  return `${s}s`;
}

export function updateGaugeStoryNumbers(tel) {
  const tape = (tel && tel.tape) || {};
  const silver = (tel && tel.silver) || {};
  const impulseData = tel.impulse || (tape && tape.impulse) || {};
  const now = Date.now();

  // ─────────────────────────────────────────────────────────────────────────
  // 1. VELOCITY (EXP vs COIL)
  // ─────────────────────────────────────────────────────────────────────────
  const vel1m = tape.vel_1m !== undefined ? Number(tape.vel_1m) : (Number(tape.tick_velocity) || 0);

  let velTop = { text: 'EXP: --', color: '#64748b' };
  let velBottom = { text: 'COIL: --', color: '#64748b' };

  if (vel1m >= 100) {
    if (!state.kineticStart) state.kineticStart = now;
    state.stallStart = null;
    const durSec = (now - state.kineticStart) / 1000;
    velTop = {
      text: `EXP: +${formatDuration(durSec)}`,
      color: durSec >= 15 ? '#10b981' : '#34d399'
    };
  } else {
    state.kineticStart = null;
  }

  if (vel1m <= 40) {
    if (!state.stallStart) state.stallStart = now;
    state.kineticStart = null;
    const durSec = (now - state.stallStart) / 1000;
    velBottom = {
      text: `COIL: ${formatDuration(durSec)}`,
      color: durSec >= 120 ? '#f59e0b' : '#cbd5e1'
    };
  } else {
    state.stallStart = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. CVD (ACC vs DIST)
  // ─────────────────────────────────────────────────────────────────────────
  const cvd = Number(tape.cvd_delta) || 0;
  let cvdTop = { text: 'ACC: 0Δ', color: '#64748b' };
  let cvdBottom = { text: 'DIST: 0Δ', color: '#64748b' };

  if (cvd > 0) {
    cvdTop = {
      text: `ACC: +${Math.round(cvd)}Δ`,
      color: cvd >= 200 ? '#10b981' : '#34d399'
    };
    cvdBottom = { text: 'DIST: 0Δ', color: '#475569' };
  } else if (cvd < 0) {
    cvdTop = { text: 'ACC: 0Δ', color: '#475569' };
    cvdBottom = {
      text: `DIST: ${Math.round(cvd)}Δ`,
      color: cvd <= -200 ? '#ef4444' : '#f87171'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. FOOTPRINT (LIFT vs DUMP Block Ratios)
  // ─────────────────────────────────────────────────────────────────────────
  const rawBlocks = tape.recent_fp_blocks || tape.footprint_4m_blocks || tape.footprint_4m || [];
  const fpBlocks = rawBlocks.slice(-4);
  const blockVals = fpBlocks.map(b => (typeof b === 'object' && b !== null ? Number(b.delta || 0) : Number(b) || 0));
  const totalBlk = Math.max(1, blockVals.length);

  const liftCount = blockVals.filter(v => v > 0).length;
  const dumpCount = blockVals.filter(v => v < 0).length;

  let fpTop = {
    text: `LIFT: ${liftCount}/${totalBlk}`,
    color: liftCount >= 3 ? '#10b981' : (liftCount >= 2 ? '#34d399' : '#64748b')
  };
  let fpBottom = {
    text: `DUMP: ${dumpCount}/${totalBlk}`,
    color: dumpCount >= 3 ? '#ef4444' : (dumpCount >= 2 ? '#f87171' : '#64748b')
  };

  // ─────────────────────────────────────────────────────────────────────────
  // 4. IMPULSE (SURGE vs COIL)
  // ─────────────────────────────────────────────────────────────────────────
  const ratePtMin = impulseData.rate_pt_min !== undefined ? Number(impulseData.rate_pt_min) : (Number(tape.impulse_rate) || 0);

  let impTop = { text: 'SURGE: --', color: '#64748b' };
  let impBottom = { text: 'COIL: --', color: '#64748b' };

  if (Math.abs(ratePtMin) >= 0.8) {
    if (!state.surgeStart) state.surgeStart = now;
    state.impulseCoilStart = null;
    const durSec = (now - state.surgeStart) / 1000;
    const isBull = ratePtMin > 0;
    impTop = {
      text: `${isBull ? 'SURGE' : 'DROP'}: +${formatDuration(durSec)}`,
      color: isBull ? '#10b981' : '#ef4444'
    };
  } else {
    state.surgeStart = null;
  }

  if (Math.abs(ratePtMin) <= 0.4) {
    if (!state.impulseCoilStart) state.impulseCoilStart = now;
    state.surgeStart = null;
    const durSec = (now - state.impulseCoilStart) / 1000;
    impBottom = {
      text: `COIL: ${formatDuration(durSec)}`,
      color: durSec >= 120 ? '#f59e0b' : '#cbd5e1'
    };
  } else {
    state.impulseCoilStart = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. INTERMARKET LEAD (BETA vs DRAG)
  // ─────────────────────────────────────────────────────────────────────────
  const activeSym = window.selectedLeadGauge || 'XAG';
  const xauPct = Number(silver.xau_pct !== undefined ? silver.xau_pct : (tel?.spot?.xau_pct || 0.0));
  let curPct = 0;
  if (activeSym === 'XAG') {
    curPct = Number(silver.xag_pct !== undefined ? silver.xag_pct : 0.0);
  } else if (tel?.intermarket && tel.intermarket[activeSym]) {
    curPct = Number(tel.intermarket[activeSym].pct || 0.0);
  }
  const activeScore = Math.round((curPct - xauPct) * 100);

  let leadTop = { text: 'BETA: 0s', color: '#64748b' };
  let leadBottom = { text: 'DRAG: 0s ✔', color: '#64748b' };

  if (activeScore >= 5) {
    if (!state.leadStart) state.leadStart = now;
    state.dragStart = null;
    const durSec = (now - state.leadStart) / 1000;
    leadTop = {
      text: `BETA: +${formatDuration(durSec)} ▲`,
      color: activeScore >= 15 ? '#10b981' : '#34d399'
    };
    leadBottom = { text: 'DRAG: 0s ✔', color: '#10b981' };
  } else if (activeScore <= -5) {
    if (!state.dragStart) state.dragStart = now;
    state.leadStart = null;
    const durSec = (now - state.dragStart) / 1000;
    leadTop = { text: 'BETA: --', color: '#475569' };
    leadBottom = {
      text: `DRAG: ${formatDuration(durSec)} ⚠`,
      color: activeScore <= -15 ? '#ef4444' : '#f87171'
    };
  } else {
    state.leadStart = null;
    state.dragStart = null;
    leadTop = { text: 'SYNC (00)', color: '#94a3b8' };
    leadBottom = { text: 'DRAG: 0s ✔', color: '#94a3b8' };
  }

  return {
    velocity: { top: velTop, bottom: velBottom },
    cvd: { top: cvdTop, bottom: cvdBottom },
    footprint: { top: fpTop, bottom: fpBottom },
    impulse: { top: impTop, bottom: impBottom },
    silver: { top: leadTop, bottom: leadBottom }
  };
}
