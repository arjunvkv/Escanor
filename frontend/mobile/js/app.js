/**
 * Escanor Mobile Terminal — Main Application Controller
 * Pure push-based WebSocket streaming on ws://<host>:5056. ZERO HTTP POLLING.
 * Dispatches live frames to mercury thermometers, 20-trail snake, peak/trough monitor, and terrain radars.
 */

import {
  GLOBAL_SESSIONS,
  INTERMARKET_DRIVERS,
  formatPrice,
  formatAutoPrecisePct,
  calcShiftScore,
  formatShiftScore,
  formatTimeIST,
  showTerminalToast
} from './constants.js';

import { renderMobileThermometers } from './thermometers.js';
import { updateGaugeStoryNumbers } from './thermo_story_engine.js';
import { renderWindowHighLows } from './snake_engine.js';
import { updateQuickLotBadge, renderLeadLagModalContent, refreshActiveMetricModal } from './modals.js';
import { initGaugeAlarms, evaluateGaugeAlarms } from './gauge_alarms.js';

let lastTelemetryData = null;
let activeClosingTickets = new Set();
let macroHeadlineTickerIndex = 0;
let wsConn = null;

// Global session checker
function getISTMinutesNow() {
  try {
    const now = new Date();
    const istStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const parts = istStr.split(':').map(Number);
    return parts[0] * 60 + parts[1] + (parts[2] / 60);
  } catch (e) {
    const d = new Date();
    const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + (d.getUTCSeconds() / 60);
    return (utcMin + 330) % 1440;
  }
}

function isSessionActiveIST(sess, curMin) {
  if (sess.istStart <= sess.istEnd) {
    return curMin >= sess.istStart && curMin < sess.istEnd;
  } else {
    return curMin >= sess.istStart || curMin < sess.istEnd;
  }
}

export function onSessionBoxClick(sessId) {
  const sess = GLOBAL_SESSIONS.find(s => s.id === sessId);
  if (!sess) return;
  const curMin = getISTMinutesNow();
  const isActive = isSessionActiveIST(sess, curMin);
  const stateStr = isActive 
    ? (sess.isOverlap ? '🔥 ACTIVE LIQUIDITY OVERLAP' : '🟢 ACTIVE SESSION') 
    : '⚪ INACTIVE (Outside Window)';
  const toastType = isActive ? (sess.isOverlap ? 'warning' : 'success') : 'info';
  showTerminalToast(`${sess.full} (${sess.name}): ${stateStr}`, toastType);
}
window.onSessionBoxClick = onSessionBoxClick;

export function updateGlobalSessionsUI() {
  const row = document.getElementById('sessionsStripRow');
  if (!row) return;

  const curMin = getISTMinutesNow();
  let html = '';

  const timeStrings = {
    'ASN': '5:30a-2:30p',
    'AS_LD': '12:30p-2:30p',
    'LDN': '12:30p-9:30p',
    'LD_NY': '6:00p-9:30p',
    'NY': '6:00p-2:30a',
    'ROLL': '2:45a-3:45a'
  };

  GLOBAL_SESSIONS.forEach(sess => {
    const isActive = isSessionActiveIST(sess, curMin);
    let containerClass = 'flex-1 min-w-[50px] py-1 px-1 rounded-md text-center cursor-pointer transition select-none flex flex-col items-center justify-center border ';
    let dotClass = 'w-1.5 h-1.5 rounded-full inline-block mr-1 ';
    let titleColor = '';
    let timeColor = '';

    if (isActive) {
      if (sess.isOverlap) {
        containerClass += 'overlap-active-blink bg-amber-950/85 border-amber-400 text-amber-200 ';
        dotClass += 'bg-amber-400 animate-pulse';
        titleColor = 'text-amber-300 font-black';
        timeColor = 'text-amber-200 font-bold';
      } else {
        containerClass += 'session-active-blink bg-emerald-950/80 border-emerald-400 text-emerald-300 ';
        dotClass += 'bg-emerald-400 animate-pulse';
        titleColor = 'text-emerald-300 font-black';
        timeColor = 'text-emerald-200 font-bold';
      }
    } else {
      containerClass += 'bg-slate-900/60 border-white/5 text-slate-400 hover:border-white/10 ';
      dotClass += 'bg-slate-600';
      titleColor = 'text-slate-400 font-bold';
      timeColor = 'text-slate-500';
    }

    const tStr = timeStrings[sess.id] || '';
    html += `
      <div onclick="onSessionBoxClick('${sess.id}')" 
           class="${containerClass}" 
           title="${sess.full} (${tStr} IST) · ${isActive ? 'Active' : 'Inactive'}">
        <div class="flex items-center justify-center leading-none">
          <span class="${dotClass}"></span>
          <span class="text-[10px] tracking-tight ${titleColor}">${sess.name}</span>
        </div>
        <div class="text-[8px] font-mono leading-tight mt-0.5 tracking-tighter ${timeColor}">
          ${tStr}
        </div>
      </div>
    `;
  });

  row.innerHTML = html;
}

export function renderRadarBlocks(tel) {
  const activeSym = window.selectedLeadGauge || 'XAG';
  const intermarket = (tel && tel.intermarket) || {};
  const silver = (tel && tel.silver) || {};
  const xauPct = Number(silver.xau_pct !== undefined ? silver.xau_pct : (tel?.spot?.xau_pct || 0.0));
  const leadKeys = ['XAG', 'JPY', 'DXY', 'YLD', 'NDX', 'CPR', 'BTC', 'XPT', 'OIL', 'GOL'];
  const leadLabels = {
    'XAG': 'SIL', 'JPY': 'JPY', 'DXY': 'INDX', 'YLD': 'YLD',
    'NDX': 'NDX', 'CPR': 'CPR', 'BTC': 'BTC', 'XPT': 'PLT',
    'OIL': 'OIL', 'GOL': 'GOL'
  };

  leadKeys.forEach(k => {
    const el = document.getElementById(`radarPill_${k}`);
    if (!el) return;

    const item = (k === 'GOL')
      ? { pct: xauPct }
      : (intermarket[k] || (k === 'XAG' ? { pct: silver.xag_pct } : {}));
    const pVal = Number(item.pct !== undefined ? item.pct : 0.0);
    const isSelected = (k === activeSym);

    const score = calcShiftScore(k, pVal, xauPct);
    const scoreStr = formatShiftScore(score);
    const activePrefix = isSelected ? '● ' : '';
    const dispName = leadLabels[k] || k;
    el.innerHTML = `<span>${activePrefix}${dispName}:</span>&nbsp;<span>${scoreStr}</span>`;
    const distStr = (score / 100 >= 0 ? '+' : '') + (score / 100).toFixed(2);
    el.title = `${dispName}: ${scoreStr} (${pVal >= 0 ? '+' : ''}${pVal.toFixed(2)}% | Dist vs Gold: ${distStr}%) · Tap to promote gauge`;

    let baseClass = 'px-1.5 py-0.5 rounded text-[10px] font-bold font-mono flex items-center cursor-pointer active:scale-95 transition whitespace-nowrap flex-shrink-0 ';
    if (Math.abs(score) <= 3) {
      baseClass += 'bg-slate-900 border border-slate-700 text-slate-300';
    } else if (score > 3) {
      baseClass += 'bg-emerald-950/90 border border-emerald-500/60 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.2)]';
    } else {
      baseClass += 'bg-red-950/90 border border-red-500/60 text-red-300 shadow-[0_0_8px_rgba(239,68,68,0.2)]';
    }

    if (isSelected) {
      baseClass += ' ring-1 ring-amber-400 border-amber-400 text-amber-200';
    }

    el.className = baseClass;
  });
}

function formatDriverSummaryBadge(key, tel, isLead) {
  const normKey = (key === 'SIL' ? 'XAG' : (key === 'PLT' ? 'XPT' : key));
  const intermarket = (tel && tel.intermarket) || {};
  const silver = (tel && tel.silver) || {};

  let pVal = 0.0;
  let isBullGold = false;

  if (normKey === 'YLD') {
    const yObj = intermarket.YLD || {};
    pVal = Number(yObj.pct !== undefined ? yObj.pct : 0.0);
    isBullGold = pVal < 0;
  } else if (normKey === 'XAG') {
    pVal = Number(silver.xag_pct !== undefined ? silver.xag_pct : (intermarket.XAG?.pct || 0.0));
    isBullGold = pVal > 0;
  } else if (normKey === 'DXY' || normKey === 'JPY') {
    const obj = intermarket[normKey] || {};
    pVal = Number(obj.pct !== undefined ? obj.pct : 0.0);
    isBullGold = pVal < 0;
  } else {
    const obj = intermarket[normKey] || {};
    pVal = Number(obj.pct !== undefined ? obj.pct : 0.0);
    isBullGold = pVal > 0;
  }

  const textCol = isBullGold ? 'text-emerald-300' : 'text-red-300';
  const bgCol = isBullGold ? 'bg-emerald-950/70 border-emerald-500/40' : 'bg-red-950/70 border-red-500/40';
  const shortKey = key === 'XAG' ? 'SIL' : (key === 'XPT' ? 'PLT' : key);

  return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${bgCol} border font-mono text-[9.5px] whitespace-nowrap"><strong class="text-white font-extrabold">${shortKey}</strong><span class="${textCol} font-black">${pVal >= 0 ? '+' : ''}${pVal.toFixed(2)}%</span></span>`;
}

export function renderLeadLagSummary(tel) {
  const container = document.getElementById('leadLagPillContent');
  if (!container) return;

  const truth = (tel && (tel.intermarket_truth || tel.macro_sentiment)) || {};
  const theme = truth.revolving_theme || 'SOVEREIGN RATES & REAL YIELDS';
  const captain = truth.regime_captain || 'YLD';
  const leadDrivers = Array.isArray(truth.lead_drivers) && truth.lead_drivers.length > 0 ? truth.lead_drivers : ['YLD', 'SIL', 'DXY'];
  const lagDrivers = Array.isArray(truth.lag_drivers) && truth.lag_drivers.length > 0 ? truth.lag_drivers : ['JPY', 'CPR', 'BTC'];

  const leadItemsHtml = leadDrivers.map(k => formatDriverSummaryBadge(k, tel, true)).join('');
  const lagItemsHtml = lagDrivers.map(k => formatDriverSummaryBadge(k, tel, false)).join('');

  const leadSig = (tel && tel.intermarket_lead) || {};
  let leadBannerHtml = '';
  if (leadSig.status === 'VALIDATED_SOVEREIGN_LEAD') {
    const isBlast = leadSig.signal === 'BLAST_EXPANSION';
    leadBannerHtml = `
      <div class="mt-1 pt-1 border-t border-white/5 flex items-center justify-between text-[9.5px] font-bold">
        <span class="px-1.5 py-0.5 rounded ${isBlast ? 'bg-emerald-950 text-emerald-300 border border-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.3)]' : 'bg-rose-950 text-rose-300 border border-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.3)]'} flex items-center gap-1">
          <span>${isBlast ? '🚀 SOVEREIGN BLAST LEAD' : '📉 SOVEREIGN DIP CASCADE'}</span>
        </span>
        <span class="text-slate-300 font-mono text-[9px]">DXY ${leadSig.point_2_dollar?.dxy_1h_pct > 0 ? '+' : ''}${leadSig.point_2_dollar?.dxy_1h_pct}% · US10Y ${leadSig.point_1_yields?.us10y}%</span>
      </div>`;
  } else if (leadSig.is_point_4_mirage) {
    leadBannerHtml = `
      <div class="mt-1 pt-1 border-t border-white/5 flex items-center justify-between text-[9.5px] font-bold">
        <span class="px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-500/70 flex items-center gap-1">
          <span>🛑 POINT 4 MIRAGE BLOCKED</span>
        </span>
        <span class="text-amber-400 font-mono text-[9px] truncate max-w-[170px]" title="${(leadSig.mirage_flags || []).join('; ')}">${(leadSig.mirage_flags || []).join(', ')}</span>
      </div>`;
  } else {
    leadBannerHtml = `
      <div class="mt-1 pt-1 border-t border-white/5 flex items-center justify-between text-[9.5px]">
        <span class="text-slate-400 flex items-center gap-1 font-bold">
          <span>⚖️ Intermarket Flow:</span>
          <span class="text-slate-300">Equilibrium (MT5 DXY Verified)</span>
        </span>
        <span class="text-slate-400 font-mono text-[9px]">DXY: ${leadSig.point_2_dollar?.dxy_price || 102.3}</span>
      </div>`;
  }

  container.innerHTML = `
    <div class="flex items-center justify-between gap-1 border-b border-white/5 pb-1">
      <div class="flex items-center gap-1.5 min-w-0 flex-1">
        <span class="px-1.5 py-0.2 rounded bg-amber-950/90 text-amber-400 border border-amber-500/50 text-[9px] font-black uppercase tracking-wider flex-shrink-0">⚡ THEME</span>
        <span class="text-amber-200 font-extrabold text-[11px] truncate uppercase tracking-tight">${theme}</span>
      </div>
      <div class="flex items-center gap-1.5 flex-shrink-0">
        <div class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-950/90 border border-red-500/60 text-red-200 text-[9.5px] font-black">
          <span class="text-[9px]">👑</span>
          <span>CAPTAIN: ${captain}</span>
        </div>
        <span onclick="event.stopPropagation(); window.openLeadLagModal && window.openLeadLagModal();" class="px-1.5 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-500/50 text-[8.5px] font-black uppercase flex items-center gap-0.5 shadow-sm hover:bg-amber-900 cursor-pointer active:scale-95 transition">
          <span>SILVER</span>
          <span class="text-[8px]">🥈</span>
        </span>
      </div>
    </div>
    <div class="flex items-center gap-1.5 text-[10px] leading-tight">
      <span class="px-1.5 py-0.2 rounded bg-emerald-950/90 text-emerald-400 border border-emerald-500/40 text-[9px] font-black tracking-wider flex-shrink-0">🟢 LEAD</span>
      <div class="flex items-center gap-1 flex-wrap">${leadItemsHtml}</div>
    </div>
    <div class="flex items-center gap-1.5 text-[10px] leading-tight">
      <span class="px-1.5 py-0.2 rounded bg-slate-900 text-slate-400 border border-slate-700 text-[9px] font-black tracking-wider flex-shrink-0">⏳ LAG</span>
      <div class="flex items-center gap-1 flex-wrap">${lagItemsHtml}</div>
    </div>
    ${leadBannerHtml}
  `;
}

export function updateMacroPill(data) {
  const badge = document.getElementById('macroPillBadge');
  const text = document.getElementById('macroPillText');
  const bullBar = document.getElementById('macroPillBullBar');
  const bearBar = document.getElementById('macroPillBearBar');

  if (!data || data.status === 'AWAITING_OPENCODE') {
    if (badge) { badge.innerHTML = ''; badge.className = 'hidden'; }
    if (bullBar) bullBar.style.width = '0%';
    if (bearBar) bearBar.style.width = '0%';
    if (text) { text.textContent = ''; text.title = ''; }
    return;
  }

  const cur = data.current_hour || {};
  const rawBull = cur.bull_pct !== undefined && cur.bull_pct !== null ? parseFloat(cur.bull_pct) : (data.bull_pct !== undefined && data.bull_pct !== null ? parseFloat(data.bull_pct) : null);
  const rawBear = cur.bear_pct !== undefined && cur.bear_pct !== null ? parseFloat(cur.bear_pct) : (data.bear_pct !== undefined && data.bear_pct !== null ? parseFloat(data.bear_pct) : null);

  if (rawBull === null || rawBear === null || isNaN(rawBull) || isNaN(rawBear)) {
    if (badge) { badge.innerHTML = ''; badge.className = 'hidden'; }
    if (bullBar) bullBar.style.width = '0%';
    if (bearBar) bearBar.style.width = '0%';
  } else {
    let b = rawBull;
    let be = rawBear;
    if (b + be > 0) {
      const tot = b + be;
      b = Math.round((b / tot) * 100);
      be = 100 - b;
    }
    const isBull = b >= be;

    if (badge) {
      if (isBull) {
        badge.className = 'px-2 py-0.5 rounded text-[11px] font-black uppercase whitespace-nowrap bg-emerald-950 text-emerald-300 border border-emerald-500/60 shadow-[0_0_8px_rgba(16,185,129,0.3)]';
        badge.innerHTML = `BULL ${b}% 🟢`;
      } else {
        badge.className = 'px-2 py-0.5 rounded text-[11px] font-black uppercase whitespace-nowrap bg-red-950 text-red-300 border border-red-500/60 shadow-[0_0_8px_rgba(239,68,68,0.3)]';
        badge.innerHTML = `BEAR ${be}% 🔴`;
      }
    }

    if (bullBar) bullBar.style.width = `${b}%`;
    if (bearBar) bearBar.style.width = `${be}%`;
  }

  if (text) {
    const headlines = data.headlines || [];
    if (Array.isArray(headlines) && headlines.length > 0) {
      const topH = headlines[macroHeadlineTickerIndex % headlines.length];
      macroHeadlineTickerIndex++;
      const dir = String(topH.direction || topH.sentiment || '').toUpperCase();
      const dirIcon = dir.includes('BULL') ? '🟢' : (dir.includes('BEAR') ? '🔴' : '⚪');
      const src = topH.source ? `[${topH.source}] ` : '';
      const hText = topH.text || topH.title || topH.headline || '';
      text.textContent = `${dirIcon} ${src}${hText}`;
      text.title = `${src}${hText}`;
    } else if (cur.summary || data.catalyst_summary) {
      text.textContent = cur.summary || data.catalyst_summary;
      text.title = text.textContent;
    } else {
      text.textContent = '';
      text.title = '';
    }
  }
}

export async function closePositionTicket(ticket, isPending = false) {
  const numTicket = Number(ticket);
  if (activeClosingTickets.has(numTicket)) return;
  activeClosingTickets.add(numTicket);

  showTerminalToast(`${isPending ? 'Canceling order' : 'Closing position'} #${numTicket}...`, 'info');
  try {
    const resp = await fetch('/api/trade/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: numTicket, is_pending: !!isPending })
    });
    const res = await resp.json();
    if (res && (res.status === 'OK' || res.status === 'CLOSED' || res.success === true)) {
      showTerminalToast(`✅ #${numTicket} closed successfully`, 'success');
      if (lastTelemetryData) {
        if (isPending && Array.isArray(lastTelemetryData.pending_orders)) {
          lastTelemetryData.pending_orders = lastTelemetryData.pending_orders.filter(o => Number(o.ticket) !== numTicket);
        } else if (!isPending && Array.isArray(lastTelemetryData.active_positions)) {
          lastTelemetryData.active_positions = lastTelemetryData.active_positions.filter(p => Number(p.ticket) !== numTicket);
        }
        renderActiveTradesUI(lastTelemetryData);
      }
    } else {
      showTerminalToast(`❌ Close rejected: ${res.error || res.message || 'Error'}`, 'error');
    }
  } catch (err) {
    showTerminalToast(`❌ Close error: ${err.message}`, 'error');
  } finally {
    activeClosingTickets.delete(numTicket);
  }
}
window.closePositionTicket = closePositionTicket;

export async function flattenDesk() {
  showTerminalToast('🚨 FLATTENING DESK: Closing positions & canceling orders...', 'warning');
  try {
    const resp = await fetch('/api/trade/close_all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 'ALL' })
    });
    const res = await resp.json();
    if (res && (res.status === 'OK' || res.success === true)) {
      showTerminalToast(`✅ DESK FLATTENED: ${res.closed_count || 0} item(s) cleared`, 'success');
      if (lastTelemetryData) {
        lastTelemetryData.active_positions = [];
        lastTelemetryData.pending_orders = [];
        renderActiveTradesUI(lastTelemetryData);
      }
    } else {
      showTerminalToast(`Flatten result: ${res.error || res.message || 'Error'}`, 'error');
    }
  } catch (err) {
    showTerminalToast(`Flatten error: ${err.message}`, 'error');
  }
}
window.flattenDesk = flattenDesk;

export async function moveSlToBreakeven(ticket, type, priceOpen) {
  const numTicket = Number(ticket);
  const isBuy = String(type).toUpperCase() === 'BUY';
  const beSl = isBuy ? (Number(priceOpen) + 0.30) : (Number(priceOpen) - 0.30);
  try {
    const resp = await fetch('/api/trade/modify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: numTicket, sl: Number(beSl.toFixed(2)) })
    });
    const res = await resp.json();
    if (res && (res.status === 'OK' || res.status === 'MODIFIED' || res.success === true)) {
      showTerminalToast(`🛡️ Breakeven set on #${numTicket} @ $${beSl.toFixed(2)}`, 'success');
    } else {
      showTerminalToast(`Modify failed: ${res.error || res.message || 'Error'}`, 'error');
    }
  } catch (err) {
    showTerminalToast(`Modify error: ${err.message}`, 'error');
  }
}
window.moveSlToBreakeven = moveSlToBreakeven;

export function renderActiveTradesUI(tel) {
  const sec = document.getElementById('activePositionsSection');
  const topPill = document.getElementById('topPinnedActiveTradePill');
  if (!sec) return;

  const rawActive = tel.active_positions || (tel.orders && tel.orders.active_positions) || tel.open_positions || [];
  const rawPending = tel.pending_orders || (tel.orders && tel.orders.pending_orders) || [];
  const activePositions = rawActive.filter(p => !activeClosingTickets.has(Number(p.ticket)));
  const pendingOrders = rawPending.filter(o => !activeClosingTickets.has(Number(o.ticket)));

  const acc = tel.account || {};
  const balance = acc.balance !== undefined ? Number(acc.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '100,000.00';
  const equity = acc.equity !== undefined ? Number(acc.equity).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : balance;

  const elAccStatus = document.getElementById('accountEquityStatus');
  if (elAccStatus) {
    elAccStatus.innerHTML = `BAL: <span class="text-amber-300 font-bold">$${balance}</span> · EQ: <span class="text-emerald-300 font-bold">$${equity}</span>`;
  }

  if (topPill) {
    if (activePositions.length > 0) {
      const p0 = activePositions[0];
      const prof = p0.profit !== undefined ? p0.profit : 0;
      const pSign = prof >= 0 ? '+' : '';
      const pBg = prof >= 0 ? 'bg-emerald-950/90 border-emerald-500/80 text-emerald-300' : 'bg-red-950/90 border-red-500/80 text-red-300';
      const nowSec0 = Math.floor(Date.now() / 1000);
      const epoch0 = Number(p0.open_epoch_utc || p0.time || (nowSec0 - Number(p0.elapsed_sec || 0)));
      const elapsed0 = Math.max(0, nowSec0 - epoch0);
      const m0 = Math.floor(elapsed0 / 60);
      const s0 = elapsed0 % 60;
      const tStr0 = m0 > 0 ? `${m0}m ${s0 < 10 ? '0' + s0 : s0}s` : `${elapsed0}s`;

      topPill.className = `flex items-center justify-between gap-1 px-1.5 py-0.5 rounded border text-[10px] font-black font-mono shadow ${pBg}`;
      topPill.innerHTML = `
        <span class="truncate">${p0.type} ${p0.volume}L ${pSign}$${prof.toFixed(1)}</span>
        <button onclick="closePositionTicket(${p0.ticket}, false)" class="px-1.5 py-0.2 rounded bg-red-600 hover:bg-red-500 text-white font-black text-[9px] active:scale-95 transition">✕</button>
      `;
    } else if (pendingOrders.length > 0) {
      const o0 = pendingOrders[0];
      topPill.className = 'flex items-center justify-between gap-1 px-1.5 py-0.5 rounded border border-amber-500/60 bg-amber-950/80 text-amber-300 text-[10px] font-black font-mono shadow';
      topPill.innerHTML = `
        <span class="truncate">${o0.type} @ $${Number(o0.price_open).toFixed(1)}</span>
        <button onclick="closePositionTicket(${o0.ticket}, true)" class="px-1 py-0.2 rounded bg-amber-600 hover:bg-amber-500 text-white font-black text-[9px] active:scale-95 transition">✕</button>
      `;
    } else {
      topPill.className = 'hidden';
      topPill.innerHTML = '';
    }
  }

  if (activePositions.length === 0 && pendingOrders.length === 0) {
    sec.className = 'bg-[#080d1e]/90 border border-white/10 rounded-xl p-2 shadow-sm transition-all';
    sec.innerHTML = `
      <div class="flex items-center justify-between text-[11px] py-0.5 px-1 font-mono">
        <div class="flex items-center gap-1.5 font-bold text-slate-300">
          <span class="w-2 h-2 rounded-full bg-emerald-400 pulsing-dot"></span>
          <span class="text-emerald-400 font-black">ACTIVE MONITOR:</span>
          <span class="text-slate-300">FLAT (0 TRADES)</span>
        </div>
        <div class="text-[10px] text-slate-400 font-mono">
          BAL: <span class="text-amber-300 font-bold">$${balance}</span> · EQ: <span class="text-emerald-300 font-bold">$${equity}</span>
        </div>
      </div>
    `;
    return;
  }

  sec.className = 'bg-[#070e1c]/95 border border-emerald-500/50 rounded-xl p-2 shadow-lg space-y-2 transition-all';
  let posListHtml = activePositions.map(p => {
    const prof = p.profit !== undefined ? p.profit : 0;
    const profPts = p.profit_pts !== undefined ? p.profit_pts : (prof / (p.volume * 100));
    const pCol = prof >= 0 ? 'text-emerald-400' : 'text-red-400';
    const nowSec = Math.floor(Date.now() / 1000);
    const epoch = Number(p.open_epoch_utc || p.time || (nowSec - Number(p.elapsed_sec || 0)));
    const elapsed = Math.max(0, nowSec - epoch);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const tStr = m > 0 ? `${m}m ${s < 10 ? '0' + s : s}s (${elapsed}s)` : `${elapsed}s`;

    return `
      <div class="p-2.5 rounded-xl bg-slate-900/90 border border-white/10 flex items-center justify-between gap-2 font-mono text-[11px] shadow-sm hover:border-amber-500/40 transition">
        <div class="space-y-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-black ${p.type === 'BUY' ? 'text-emerald-300' : 'text-red-300'}">${p.type} ${p.volume}L @ $${Number(p.price_open).toFixed(2)}</span>
            <!-- HIGHLIGHTED ACTIVE TRADE SECONDS COUNTER -->
            <span id="trade_timer_${p.ticket}" data-open-epoch="${epoch}" class="trade-seconds-counter px-2 py-0.5 rounded-md bg-amber-500/25 text-amber-300 border border-amber-400/80 font-mono font-black text-[10px] shadow-[0_0_10px_rgba(245,158,11,0.35)] flex items-center gap-1.5 animate-pulse">
              <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
              <span class="trade-timer-text">⏱️ ${tStr}</span>
            </span>
            ${(p.auto_close_rem_sec !== null && p.auto_close_rem_sec !== undefined && p.auto_close_rem_sec > 0) ? `
            <button onclick="openEditTradeTimerModal(${p.ticket}, ${p.auto_close_mins || Math.ceil(p.auto_close_rem_sec/60)}, ${p.auto_close_rem_sec}, false)" class="px-2 py-0.5 rounded-md bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/60 font-mono font-black text-[10px] shadow-[0_0_8px_rgba(244,63,94,0.3)] flex items-center gap-1 cursor-pointer active:scale-95 transition" title="Click to edit or cancel timer">
              <span>⏳ Closes in:</span>
              <span>${Math.floor(p.auto_close_rem_sec / 60)}m ${String(p.auto_close_rem_sec % 60).padStart(2, '0')}s</span>
            </button>
            ` : `
            <button onclick="openEditTradeTimerModal(${p.ticket}, 0, 0, false)" class="px-1.5 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-amber-300 border border-white/10 font-mono font-bold text-[9.5px] cursor-pointer active:scale-95 transition flex items-center gap-1" title="Add Auto-Close Timer">
              <span>⏱️ +Timer</span>
            </button>
            `}
          </div>
          <div class="text-[10px] text-slate-400">SL: $${p.sl ? Number(p.sl).toFixed(2) : '--'} · TP: $${p.tp ? Number(p.tp).toFixed(2) : '--'}</div>
        </div>
        <div class="text-right">
          <div class="font-black ${pCol} text-xs">${prof >= 0 ? '+' : ''}$${prof.toFixed(2)} (${profPts >= 0 ? '+' : ''}${profPts.toFixed(1)}pt)</div>
          <div class="flex items-center gap-1 mt-1 justify-end">
            <button onclick="moveSlToBreakeven(${p.ticket}, '${p.type}', ${p.price_open})" class="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 text-[9px] font-bold border border-amber-500/40 active:scale-95 transition">BE 🛡️</button>
            <button onclick="closePositionTicket(${p.ticket}, false)" class="px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white font-bold text-[9px] active:scale-95 transition">CLOSE ✕</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  let pendingListHtml = pendingOrders.map(o => {
    const isBuy = String(o.type).toUpperCase().includes('BUY');
    const color = isBuy ? 'text-emerald-300' : 'text-red-300';

    return `
      <div class="p-2 rounded-xl bg-slate-900/80 border border-amber-500/30 flex items-center justify-between gap-2 font-mono text-[11px] shadow-sm">
        <div class="space-y-0.5">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-black text-[9.5px]">⏳ ${o.type}</span>
            <span class="font-bold ${color}">${o.volume}L @ $${Number(o.price_open).toFixed(2)}</span>
            ${o.auto_close_mins ? `
              <button onclick="openEditTradeTimerModal(${o.ticket}, ${o.auto_close_mins}, 0, true)" class="px-1.5 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/50 text-[9px] font-bold cursor-pointer transition flex items-center gap-0.5" title="Click to edit or cancel timer">
                <span>⏱️ ${o.auto_close_mins}m</span>
              </button>
            ` : `
              <button onclick="openEditTradeTimerModal(${o.ticket}, 0, 0, true)" class="px-1 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-amber-300 border border-white/10 text-[9px] font-bold cursor-pointer" title="Add Pending Timer">
                <span>⏱️ +Timer</span>
              </button>
            `}
          </div>
          <div class="text-[9.5px] text-slate-400">SL: $${o.sl ? Number(o.sl).toFixed(2) : '--'} · TP: $${o.tp ? Number(o.tp).toFixed(2) : '--'}</div>
        </div>
        <div>
          <button onclick="closePositionTicket(${o.ticket}, true)" class="px-2 py-1 rounded bg-amber-950/80 hover:bg-amber-900/90 text-amber-300 hover:text-white border border-amber-500/50 text-[9.5px] font-black active:scale-95 transition">CANCEL ✕</button>
        </div>
      </div>
    `;
  }).join('');

  sec.innerHTML = `
    <div class="flex items-center justify-between text-[11px] py-0.5 px-1 font-mono border-b border-white/5 pb-1">
      <div class="flex items-center gap-1.5 font-bold">
        <span class="w-2 h-2 rounded-full bg-emerald-400 pulsing-dot"></span>
        <span class="text-emerald-400 font-black">ACTIVE MONITOR (${activePositions.length} POS · ${pendingOrders.length} PEND)</span>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="flattenDesk()" class="px-2 py-0.5 rounded bg-red-900/90 hover:bg-red-800 text-white font-black text-[9.5px] uppercase border border-red-500/70">🚨 FLATTEN</button>
        <div class="text-[10px] text-slate-400 font-mono">BAL: <span class="text-amber-300 font-bold">$${balance}</span> · EQ: <span class="text-emerald-300 font-bold">$${equity}</span></div>
      </div>
    </div>
    ${activePositions.length > 0 ? `<div class="space-y-1.5">${posListHtml}</div>` : ''}
    ${pendingOrders.length > 0 ? `
      <div class="pt-1.5 ${activePositions.length > 0 ? 'border-t border-white/10' : ''} space-y-1">
        <div class="text-[10px] font-bold text-amber-400 font-mono flex items-center gap-1">
          <span>🎯 PENDING ORDERS (${pendingOrders.length})</span>
        </div>
        <div class="space-y-1.5">${pendingListHtml}</div>
      </div>
    ` : ''}
  `;
}
window.renderActiveTradesUI = renderActiveTradesUI;

export function updateMobileUI(tel) {
  if (!tel) return;
  lastTelemetryData = tel;
  window.__lastTelemetry = tel;

  const spot = tel.spot || {};
  const tape = tel.tape || {};
  const bid = spot.bid !== undefined ? spot.bid : (tape.ask ? (tape.ask - 0.35) : (tel.bid || 4149.0));
  const ask = spot.ask !== undefined ? spot.ask : (tape.ask || (bid + 0.35));
  const spreadPts = Math.round(spot.spread_pts !== undefined ? spot.spread_pts : ((ask - bid) * 100));

  // 1. Sticky Header
  const elSellPrice = document.getElementById('topSellPrice');
  const elBuyPrice = document.getElementById('topBuyPrice');
  const elSpotPrice = document.getElementById('topSpotPrice');
  const elSpread = document.getElementById('topSpreadPts');

  if (elSellPrice) elSellPrice.textContent = `$${bid.toFixed(2)}`;
  if (elBuyPrice) elBuyPrice.textContent = `$${ask.toFixed(2)}`;
  if (elSpotPrice) elSpotPrice.textContent = `$${bid.toFixed(2)}`;
  if (elSpread) elSpread.textContent = `${spreadPts} pt`;

  // 2. Real MT5 Stream IST Clock
  const clockEl = document.getElementById('liveClockIst');
  if (clockEl) clockEl.textContent = formatTimeIST(Date.now());

  // 3. 4TF Posture Pills (ROOT CALCULATION MATCH WITH DESKTOP!)
  // 3. 4TF Separate Posture Boxes with Bidirectional Displacement Micro-Bars
  const tf4 = tel.tf_4_posture || {};
  const post = tf4.postures || tf4 || {};
  const tfPcts = tf4.pcts || {};
  const tfPts = tf4.pts || {};

  const tfMaxScales = {
    'M5': 4.0,   // 4 pt displacement = 100% full M5 expansion bar
    'M15': 8.0,  // 8 pt displacement = 100% full M15 expansion bar
    'H1': 16.0,  // 16 pt displacement = 100% full H1 expansion bar
    'H4': 32.0   // 32 pt displacement = 100% full H4 expansion bar
  };

  ['H4', 'H1', 'M15', 'M5'].forEach(tf => {
    const el = document.getElementById(`pill4Tf${tf}`);
    const txtEl = document.getElementById(`txt4Tf${tf}`);
    const barNeg = document.getElementById(`bar4Tf${tf}Neg`);
    const barPos = document.getElementById(`bar4Tf${tf}Pos`);

    if (el) {
      const pVal = tfPcts[tf];
      const ptVal = tfPts[tf];
      let numPts = 0;
      let hasVal = false;

      if (ptVal !== undefined && ptVal !== null && !isNaN(ptVal)) {
        numPts = Number(ptVal);
        hasVal = true;
      } else if (pVal !== undefined && pVal !== null && !isNaN(pVal)) {
        numPts = Number(pVal) * 40.0; // conservative point estimate
        hasVal = true;
      }

      const sign = numPts > 0 ? '+' : (numPts < 0 ? '-' : '');
      const absPts = Math.abs(numPts);
      const ptDisplay = hasVal ? `${sign}${absPts.toFixed(1)}p` : '--';
      const scale = tfMaxScales[tf] || 10.0;
      const ratio = hasVal ? Math.min(1.0, Math.max(0.0, absPts / scale)) : 0;
      const fillPct = (ratio * 100).toFixed(1) + '%';

      if (txtEl) {
        txtEl.textContent = ptDisplay;
      } else {
        el.innerHTML = `${tf}: ${ptDisplay}`;
      }

      if (barNeg && barPos) {
        if (numPts > 0) {
          barPos.style.width = fillPct;
          barNeg.style.width = '0%';
        } else if (numPts < 0) {
          barNeg.style.width = fillPct;
          barPos.style.width = '0%';
        } else {
          barPos.style.width = '0%';
          barNeg.style.width = '0%';
        }
      }

      const pctStr = (pVal !== undefined && pVal !== null && !isNaN(pVal)) 
        ? `${Number(pVal) >= 0 ? '+' : ''}${Number(pVal).toFixed(3)}%` 
        : '--%';
      el.title = `${tf} Real Price Action: ${sign}${absPts.toFixed(2)} pt (${pctStr}) | Range Scale: ${scale}pt | Posture: ${post[tf] || 'MIX'}`;

      if (numPts > 0) {
        el.className = 'px-1.5 py-1 rounded-lg bg-emerald-950/40 border border-emerald-500/50 flex flex-col justify-center min-w-0 transition-all shadow-[0_0_8px_rgba(16,185,129,0.15)]';
        if (txtEl) txtEl.className = 'text-emerald-400 font-bold truncate';
      } else if (numPts < 0) {
        el.className = 'px-1.5 py-1 rounded-lg bg-rose-950/40 border border-rose-500/50 flex flex-col justify-center min-w-0 transition-all shadow-[0_0_8px_rgba(244,63,94,0.15)]';
        if (txtEl) txtEl.className = 'text-rose-400 font-bold truncate';
      } else {
        el.className = 'px-1.5 py-1 rounded-lg bg-slate-900/90 border border-slate-700/80 flex flex-col justify-center min-w-0 transition-all';
        if (txtEl) txtEl.className = 'text-slate-300 font-bold truncate';
      }
    }
  });

  // 4. 4M Footprint Delta Block Pills
  const fpBlocks = tape.footprint_4m_blocks || tape.recent_fp_blocks || [];
  let fp4mNet = 0;
  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`pillFpBlock${i}`);
    if (el) {
      const blk = fpBlocks[i] || null;
      const idxLabel = i === 3 ? 'FP0' : `FP-${3 - i}`;
      if (blk && blk.delta !== undefined) {
        const d = Number(blk.delta);
        fp4mNet += d;
        const sign = d >= 0 ? '+' : '';
        el.innerHTML = `${idxLabel}: ${sign}${d}Δ`;
        if (d > 0) {
          el.className = 'px-1.5 py-0.5 rounded text-[10.5px] font-bold bg-emerald-950/90 border border-emerald-500/60 text-emerald-300 font-mono shadow-[0_0_6px_rgba(16,185,129,0.3)] flex items-center justify-center';
        } else if (d < 0) {
          el.className = 'px-1.5 py-0.5 rounded text-[10.5px] font-bold bg-red-950/90 border border-red-500/60 text-red-300 font-mono shadow-[0_0_6px_rgba(239,68,68,0.3)] flex items-center justify-center';
        } else {
          el.className = 'px-1.5 py-0.5 rounded text-[10.5px] font-bold bg-slate-900 border border-slate-700 text-slate-300 font-mono flex items-center justify-center';
        }
      } else {
        el.innerHTML = `${idxLabel}: --`;
        el.className = 'px-1.5 py-0.5 rounded text-[10.5px] font-bold bg-slate-900 border border-white/10 text-slate-500 font-mono flex items-center justify-center';
      }
    }
  }

  const fpHead = document.getElementById('fpBlocksHeaderLabel');
  if (fpHead) {
    const sSign = fp4mNet >= 0 ? '+' : '';
    const sCol = fp4mNet > 0 ? 'text-emerald-400' : (fp4mNet < 0 ? 'text-red-400' : 'text-slate-400');
    fpHead.innerHTML = `4M BLOCKS: <span class="${sCol} text-[9.5px] font-black font-mono">(${sSign}${fp4mNet}Δ)</span>`;
  }

  // 5. Global Sessions Strip (At Top!)
  updateGlobalSessionsUI();

  // 6. Intermarket Lead Radar & Theme Box
  renderRadarBlocks(tel);
  renderLeadLagSummary(tel);

  // 7. Mercury Gauges & Story Strips
  try {
    const story = updateGaugeStoryNumbers(tel) || {};
    const setTxt = (id, val, col) => {
      const el = document.getElementById(id);
      if (el && val) {
        el.textContent = val;
        if (col) el.style.color = col;
      }
    };
    if (story.velocity) {
      setTxt('storyTop_vel', story.velocity.top?.text, story.velocity.top?.color);
      setTxt('storyBottom_vel', story.velocity.bottom?.text, story.velocity.bottom?.color);
    }
    if (story.cvd) {
      setTxt('storyTop_cvd', story.cvd.top?.text, story.cvd.top?.color);
      setTxt('storyBottom_cvd', story.cvd.bottom?.text, story.cvd.bottom?.color);
    }
    if (story.footprint) {
      setTxt('storyTop_fp', story.footprint.top?.text, story.footprint.top?.color);
      setTxt('storyBottom_fp', story.footprint.bottom?.text, story.footprint.bottom?.color);
    }
    if (story.impulse) {
      setTxt('storyTop_imp', story.impulse.top?.text, story.impulse.top?.color);
      setTxt('storyBottom_imp', story.impulse.bottom?.text, story.impulse.bottom?.color);
    }
    if (story.silver) {
      setTxt('storyTop_lead', story.silver.top?.text, story.silver.top?.color);
      setTxt('storyBottom_lead', story.silver.bottom?.text, story.silver.bottom?.color);
    }
    renderMobileThermometers(tel);
  } catch (e) { console.error('[Escanor] Thermo render error:', e); }
  try { evaluateGaugeAlarms(tel); } catch (e) { console.error('[Escanor] Gauge alarms error:', e); }

  // 8. Peak/Trough Monitor
  try { renderWindowHighLows(tel); } catch (e) { console.error('[Escanor] Peak/Trough render error:', e); }

  // 9. Active Positions Card
  renderActiveTradesUI(tel);

  // 12. Live Active Modals Refresh
  const leadModal = document.getElementById('leadLagModal');
  if (leadModal && !leadModal.classList.contains('hidden')) {
    renderLeadLagModalContent(tel);
  }
  try {
    refreshActiveMetricModal();
  } catch (e) {}
}
window.updateMobileUI = updateMobileUI;

// Ultra-fast HTTP Telemetry Snapshot (Used for instant order sync & WS fallback)
export async function fetchTelemetrySnapshot() {
  try {
    const res = await fetch('/api/telemetry');
    const data = await res.json();
    if (data && data.status === 'OK') {
      updateMobileUI(data);
    }
  } catch (err) {
    // Silent fail in background
  }
}
window.fetchTelemetrySnapshot = fetchTelemetrySnapshot;

// WebSocket Connection (ws://<host>:5056)
function connectWebSocket() {
  const host = (typeof window !== 'undefined' && window.location && window.location.hostname) ? window.location.hostname : '127.0.0.1';
  const wsUrl = `ws://${host}:5056`;
  console.log(`[Escanor WS] Connecting to ${wsUrl}...`);

  try {
    wsConn = new WebSocket(wsUrl);

    wsConn.onopen = () => {
      console.log('[Escanor WS] Connected to live push stream');
      const dot = document.getElementById('mt5StatusDot');
      if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 pulsing-dot';
    };

    wsConn.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        updateMobileUI(data);
      } catch (err) {
        console.error('[Escanor WS] JSON parse error:', err);
      }
    };

    wsConn.onerror = (err) => {
      console.warn('[Escanor WS] Socket error, will reconnect...', err);
      // Trigger instant HTTP fallback when socket has error
      fetchTelemetrySnapshot();
    };

    wsConn.onclose = () => {
      console.warn('[Escanor WS] Disconnected. Reconnecting in 1500ms...');
      const dot = document.getElementById('mt5StatusDot');
      if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-amber-400';
      // Trigger instant HTTP fallback when socket closes
      fetchTelemetrySnapshot();
      setTimeout(connectWebSocket, 1500);
    };
  } catch (err) {
    console.error('[Escanor WS] Connection failed:', err);
    fetchTelemetrySnapshot();
    setTimeout(connectWebSocket, 2000);
  }
}

// Real-Time 1-Second Trade Counter Ticker
export function tickActiveTradeTimers() {
  const nowSec = Math.floor(Date.now() / 1000);
  document.querySelectorAll('.trade-seconds-counter').forEach(el => {
    const epoch = Number(el.getAttribute('data-open-epoch'));
    if (!epoch || isNaN(epoch)) return;
    const elapsed = Math.max(0, nowSec - epoch);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const tStr = m > 0 ? `${m}m ${s < 10 ? '0' + s : s}s (${elapsed}s)` : `${elapsed}s`;
    const textEl = el.querySelector('.trade-timer-text');
    if (textEl) {
      textEl.textContent = `⏱️ ${tStr}`;
    } else {
      el.textContent = `⏱️ ${tStr}`;
    }
  });
}
window.tickActiveTradeTimers = tickActiveTradeTimers;

// Boot Terminal
function boot() {
  console.log('[Escanor Mobile] Booting terminal...');
  try { fetchTelemetrySnapshot(); } catch (e) { console.warn('[Escanor] Initial snapshot error:', e); }
  try { updateQuickLotBadge(); } catch (e) {}
  try { updateGlobalSessionsUI(); } catch (e) {}
  try { initGaugeAlarms(); } catch (e) { console.warn('[Escanor] Alarm init warning:', e); }
  try { setInterval(updateGlobalSessionsUI, 1000); } catch (e) {}
  try { setInterval(tickActiveTradeTimers, 1000); } catch (e) {}
  // Periodic fallback heartbeat: if WS is not open, fetch via HTTP every 2.5s
  setInterval(() => {
    if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
      fetchTelemetrySnapshot();
    }
  }, 2500);
  try { connectWebSocket(); } catch (e) { console.warn('[Escanor] WS connect error:', e); }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
