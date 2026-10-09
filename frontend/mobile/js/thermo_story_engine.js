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
  // 1. VELOCITY (UP EXPANSION PACE vs DOWN STALL TIME)
  // ─────────────────────────────────────────────────────────────────────────
  const vel1m = tape.vel_1m !== undefined ? Number(tape.vel_1m) : (Number(tape.tick_velocity) || 0);

  let velTop, velBottom;

  if (vel1m >= 50) {
    if (!state.kineticStart) state.kineticStart = now;
    state.stallStart = null;
    const durSec = Math.max(1, (now - state.kineticStart) / 1000);
    velTop = {
      text: `▲ +${formatDuration(durSec)} EXP`,
      color: durSec >= 15 ? '#10b981' : '#34d399'
    };
    velBottom = { text: '▼ 0s STALL', color: '#94a3b8' };
  } else {
    state.kineticStart = null;
    if (!state.stallStart) state.stallStart = now;
    const durSec = Math.max(1, (now - state.stallStart) / 1000);
    velTop = { text: '▲ 0s EXP', color: '#64748b' };
    velBottom = {
      text: `▼ ${formatDuration(durSec)} STALL`,
      color: durSec >= 60 ? '#f59e0b' : '#fbbf24'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. CVD (AGGRESSIVE BUY ACCUMULATION vs SELL DISTRIBUTION LOTS)
  // ─────────────────────────────────────────────────────────────────────────
  const cvd = Number(tape.cvd_delta) || 0;
  const accVal = Math.max(0, Math.round(cvd));
  const distVal = Math.abs(Math.min(0, Math.round(cvd)));

  const cvdTop = {
    text: `▲ +${accVal}Δ ACC`,
    color: accVal >= 100 ? '#10b981' : (accVal > 0 ? '#34d399' : '#64748b')
  };
  const cvdBottom = {
    text: `▼ -${distVal}Δ DIST`,
    color: distVal >= 100 ? '#ef4444' : (distVal > 0 ? '#f87171' : '#94a3b8')
  };

  // ─────────────────────────────────────────────────────────────────────────
  // 3. FOOTPRINT (LIFT vs DUMP 4-BLOCK RATIO)
  // ─────────────────────────────────────────────────────────────────────────
  const rawBlocks = tape.recent_fp_blocks || tape.footprint_4m_blocks || tape.footprint_4m || [];
  const fpBlocks = rawBlocks.slice(-4);
  const blockVals = fpBlocks.map(b => (typeof b === 'object' && b !== null ? Number(b.delta || 0) : Number(b) || 0));
  const totalBlk = Math.max(1, blockVals.length);

  const liftCount = blockVals.filter(v => v > 0).length;
  const dumpCount = blockVals.filter(v => v < 0).length;

  const fpTop = {
    text: `▲ ${liftCount}/4 LIFT`,
    color: liftCount >= 3 ? '#10b981' : (liftCount >= 2 ? '#34d399' : '#64748b')
  };
  const fpBottom = {
    text: `▼ ${dumpCount}/4 DUMP`,
    color: dumpCount >= 3 ? '#ef4444' : (dumpCount >= 2 ? '#f87171' : '#94a3b8')
  };

  // ─────────────────────────────────────────────────────────────────────────
  // 4. IMPULSE (SPATIAL DISPLACEMENT SURGE vs BOX COIL DURATION)
  // ─────────────────────────────────────────────────────────────────────────
  const ratePtMin = impulseData.rate_pt_min !== undefined ? Number(impulseData.rate_pt_min) : (Number(tape.impulse_rate) || 0);

  let impTop, impBottom;

  if (Math.abs(ratePtMin) >= 0.5) {
    if (!state.surgeStart) state.surgeStart = now;
    state.impulseCoilStart = null;
    const durSec = Math.max(1, (now - state.surgeStart) / 1000);
    const isBull = ratePtMin > 0;
    impTop = {
      text: `▲ +${formatDuration(durSec)} ${isBull ? 'SURGE' : 'DROP'}`,
      color: isBull ? '#10b981' : '#ef4444'
    };
    impBottom = { text: '▼ 0s COIL', color: '#94a3b8' };
  } else {
    state.surgeStart = null;
    if (!state.impulseCoilStart) state.impulseCoilStart = now;
    const durSec = Math.max(1, (now - state.impulseCoilStart) / 1000);
    impTop = { text: '▲ 0s SURGE', color: '#64748b' };
    impBottom = {
      text: `▼ ${formatDuration(durSec)} COIL`,
      color: durSec >= 60 ? '#f59e0b' : '#fbbf24'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. INTERMARKET LEAD (BETA LEAD STREAK vs HEADWIND DRAG DURATION)
  // ─────────────────────────────────────────────────────────────────────────
  const activeSym = (typeof window !== 'undefined' && window.selectedLeadGauge) || 'XAG';
  const xauPct = Number(silver.xau_pct !== undefined ? silver.xau_pct : (tel?.spot?.xau_pct || 0.0));
  let curPct = 0;
  if (activeSym === 'XAG') {
    curPct = Number(silver.xag_pct !== undefined ? silver.xag_pct : 0.0);
  } else if (tel?.intermarket && tel.intermarket[activeSym]) {
    curPct = Number(tel.intermarket[activeSym].pct || 0.0);
  }
  const activeScore = Math.round((curPct - xauPct) * 100);

  let leadTop, leadBottom;

  if (activeScore > 2) {
    if (!state.leadStart) state.leadStart = now;
    state.dragStart = null;
    const durSec = Math.max(1, (now - state.leadStart) / 1000);
    leadTop = {
      text: `▲ +${formatDuration(durSec)} LEAD`,
      color: activeScore >= 10 ? '#10b981' : '#34d399'
    };
    leadBottom = { text: '▼ 0s DRAG', color: '#10b981' };
  } else if (activeScore < -2) {
    if (!state.dragStart) state.dragStart = now;
    state.leadStart = null;
    const durSec = Math.max(1, (now - state.dragStart) / 1000);
    leadTop = { text: '▲ 0s LEAD', color: '#64748b' };
    leadBottom = {
      text: `▼ ${formatDuration(durSec)} DRAG`,
      color: activeScore <= -10 ? '#ef4444' : '#f87171'
    };
  } else {
    state.leadStart = null;
    state.dragStart = null;
    leadTop = { text: '▲ 0s SYNC', color: '#38bdf8' };
    leadBottom = { text: '▼ 0s DRAG', color: '#94a3b8' };
  }

  return {
    velocity: { top: velTop, bottom: velBottom },
    cvd: { top: cvdTop, bottom: cvdBottom },
    footprint: { top: fpTop, bottom: fpBottom },
    impulse: { top: impTop, bottom: impBottom },
    silver: { top: leadTop, bottom: leadBottom }
  };
}
