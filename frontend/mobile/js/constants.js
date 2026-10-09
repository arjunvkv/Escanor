/**
 * Escanor Mobile Terminal — Constants & Reusable Utilities
 * Strictly organized: sessions config, driver definitions, regime cheat sheets, and formatting helpers.
 */

export const GLOBAL_SESSIONS = [
  { id: 'ASN', name: 'ASN', full: 'Asian Core', istStart: 5 * 60 + 30, istEnd: 14 * 60 + 30, color: 'sky' },
  { id: 'AS_LD', name: 'AS-LD', full: 'Asian-London Overlap', istStart: 12 * 60 + 30, istEnd: 14 * 60 + 30, isOverlap: true, color: 'amber' },
  { id: 'LDN', name: 'LDN', full: 'London Expansion', istStart: 12 * 60 + 30, istEnd: 21 * 60 + 30, color: 'emerald' },
  { id: 'LD_NY', name: 'LD-NY', full: 'London-NY Overlap', istStart: 18 * 60, istEnd: 21 * 60 + 30, isOverlap: true, color: 'amber' },
  { id: 'NY', name: 'NY', full: 'New York Session', istStart: 18 * 60, istEnd: (26 * 60 + 30) % (24 * 60), crossesMidnight: true, color: 'emerald' },
  { id: 'ROLL', name: 'ROLL', full: 'Late NY / Asian Rollover', istStart: 2 * 60 + 45, istEnd: 3 * 60 + 45, isDanger: true, color: 'red' }
];

export const INTERMARKET_DRIVERS = {
  'XAG': { sym: 'XAG', label: 'SIL', name: 'Silver Beta', corr: 'POSITIVE', beta: 1.8, desc: 'High beta precious metal cousin. Silver leading gold = macro trend confirmation.' },
  'JPY': { sym: 'JPY', label: 'JPY', name: 'USD/JPY (Fx)', corr: 'INVERSE', beta: 0.9, desc: 'Global carry trade barometer. Yen strength (pair falling) fuels gold rally.' },
  'DXY': { sym: 'DXY', label: 'INDX', name: 'US Dollar Index', corr: 'INVERSE', beta: 1.0, desc: 'Sovereign pricing currency. Dollar weakening provides tailwind to gold.' },
  'YLD': { sym: 'YLD', label: 'YLD', name: 'US 10Y Yield', corr: 'INVERSE', beta: 1.2, desc: 'Opportunity cost of zero-yield gold. Falling yields spark aggressive gold bids.' },
  'NDX': { sym: 'NDX', label: 'NDX', name: 'Nasdaq 100', corr: 'REGIME', beta: 0.7, desc: 'Global equity risk appetite. Divergence signals liquidity dislocations.' },
  'CPR': { sym: 'CPR', label: 'CPR', name: 'Copper Spot', corr: 'POSITIVE', beta: 0.8, desc: 'Doctor Copper global industrial growth pulse. Leads broad commodity supercycles.' },
  'BTC': { sym: 'BTC', label: 'BTC', name: 'Bitcoin', corr: 'REGIME', beta: 0.5, desc: 'Alternative sovereign liquidity asset and digital store-of-value competitor.' },
  'XPT': { sym: 'XPT', label: 'PLT', name: 'Platinum Spot', corr: 'POSITIVE', beta: 1.1, desc: 'PGM industrial and investment precious metal barometer.' },
  'OIL': { sym: 'OIL', label: 'OIL', name: 'Crude Oil', corr: 'POSITIVE', beta: 0.6, desc: 'Global headline inflation energy pulse. Surging oil pushes breakeven inflation up.' },
  'GOL': { sym: 'GOL', label: 'GOL', name: 'Gold Spot', corr: 'SELF', beta: 1.0, desc: 'Primary traded asset benchmark coordinates.' }
};

export const SATELLITE_NORMALIZER = {
  'SILVER': 'XAG', 'XAG': 'XAG', 'SIL': 'XAG',
  'USDJPY': 'JPY', 'JPY': 'JPY',
  'DXY': 'DXY', 'INDX': 'DXY', 'USD': 'DXY',
  'US10Y': 'YLD', 'YLD': 'YLD', '10Y': 'YLD', 'TNX': 'YLD',
  'NDX': 'NDX', 'NASDAQ': 'NDX', 'QQQ': 'NDX',
  'COPPER': 'CPR', 'CPR': 'CPR', 'HG': 'CPR',
  'BITCOIN': 'BTC', 'BTC': 'BTC', 'CRYPTO': 'BTC',
  'PLATINUM': 'XPT', 'PLT': 'XPT', 'XPT': 'XPT',
  'OIL': 'OIL', 'CRUDE': 'OIL', 'WTI': 'OIL',
  'GOLD': 'GOL', 'GOL': 'GOL', 'XAU': 'GOL'
};

export function formatPrice(val, decimals = 2) {
  if (val === undefined || val === null || isNaN(val)) return '----.--';
  return Number(val).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatAutoPrecisePct(val) {
  if (val === undefined || val === null || isNaN(val)) return '--%';
  const num = Number(val);
  const sign = num > 0 ? '+' : '';
  const abs = Math.abs(num);
  if (abs >= 10.0) return `${sign}${num.toFixed(1)}%`;
  if (abs >= 1.0) return `${sign}${num.toFixed(2)}%`;
  return `${sign}${num.toFixed(3)}%`;
}

export function calcShiftScore(sym, pctVal, xauPct = 0.0) {
  if (pctVal === undefined || pctVal === null || isNaN(pctVal)) return 0;
  const num = Number(pctVal);
  const goldPct = Number(xauPct !== undefined && xauPct !== null && !isNaN(xauPct) ? xauPct : 0.0);
  const normKey = SATELLITE_NORMALIZER[String(sym).toUpperCase()] || 'GOL';
  const cfg = INTERMARKET_DRIVERS[normKey] || { corr: 'POSITIVE', beta: 1.0 };

  // Volatility scaling factor:
  // Bitcoin (BTC) has routine percentage swings ~5x larger than Gold and other assets.
  // Crude Oil (OIL) has ~2.5x larger routine swings.
  // Scaling into Gold-equivalent macro volatility prevents out-of-scale values (like -48 on BTC):
  let scaledNum = num;
  if (normKey === 'BTC') scaledNum = num / 5.0;
  else if (normKey === 'OIL') scaledNum = num / 2.5;

  // For inverse assets (USDJPY, DXY, US10Y), a drop in asset is bullish for Gold.
  // Effective directional move in Gold terms:
  const effectivePct = (cfg.corr === 'INVERSE') ? -scaledNum : scaledNum;

  // True displacement from Gold's price move:
  // How much distance the item's price is standing from Gold
  const disp = (normKey === 'GOL') ? 0.0 : (effectivePct - goldPct);

  // 1 unit = 0.01% (1 basis point) displacement from Gold
  // E.g. -0.09% displacement = -9 score (formatted as -09)
  // E.g. +0.38% displacement = +38 score (formatted as +38)
  const score = Math.round(disp * 100);
  return Math.max(-99, Math.min(99, score));
}

export function formatShiftScore(score) {
  const s = Math.round(Number(score) || 0);
  if (s === 0) return '00';
  const sign = s > 0 ? '+' : '-';
  return `${sign}${Math.abs(s).toString().padStart(2, '0')}`;
}

export function formatTimeIST(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: true,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function showTerminalToast(message, type = 'info') {
  if (navigator.vibrate) {
    if (type === 'error') navigator.vibrate([60, 40, 60]);
    else if (type === 'success') navigator.vibrate(50);
    else navigator.vibrate(25);
  }
  const banner = document.getElementById('terminalToastBanner');
  const content = document.getElementById('terminalToastContent');
  if (!banner || !content) return;

  let bg = 'bg-slate-900/95 border-slate-700 text-slate-100';
  let icon = 'ℹ️';
  if (type === 'error') {
    bg = 'bg-red-950/95 border-red-500/80 text-red-200 shadow-red-950/60';
    icon = '❌';
  } else if (type === 'success') {
    bg = 'bg-emerald-950/95 border-emerald-500/80 text-emerald-200 shadow-emerald-950/60';
    icon = '✅';
  } else if (type === 'warning') {
    bg = 'bg-amber-950/95 border-amber-500/80 text-amber-200 shadow-amber-950/60';
    icon = '⚠️';
  }

  content.className = `py-2 px-3 rounded-xl border font-bold text-xs shadow-2xl flex items-center justify-between gap-2 backdrop-blur-md ${bg}`;
  content.innerHTML = `
    <div class="flex items-center gap-2">
      <span>${icon}</span>
      <span>${message}</span>
    </div>
    <button onclick="document.getElementById('terminalToastBanner').classList.add('opacity-0', '-translate-y-4')" class="text-xs opacity-70 hover:opacity-100">✕</button>
  `;

  banner.classList.remove('opacity-0', '-translate-y-4', 'pointer-events-none');
  banner.classList.add('opacity-100', 'translate-y-0');

  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    banner.classList.add('opacity-0', '-translate-y-4', 'pointer-events-none');
    banner.classList.remove('opacity-100', 'translate-y-0');
  }, 3500);
}
