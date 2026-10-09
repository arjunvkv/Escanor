/**
 * Escanor Mobile Terminal — Gauge Physics Alarms & Dispatcher Engine
 * Evaluates live 5-Gauge tape physics (Velocity 1M/5M, CVD Delta, Footprint 4M,
 * Impulse Displacement, and Silver Beta Lead) against single or multi-criteria
 * combination rules and alerts via PC Web Audio Chime and/or Telegram Bot.
 */

const STORAGE_KEY = 'escanor_gauge_alarms_v1';
const TELEGRAM_CONFIG_KEY = 'escanor_telegram_config_v1';

let alarms = [];
let audioCtx = null;
let lastEvaluatedTelemetry = null;

export const GAUGE_METRICS = {
  'vel_1m': {
    label: '⚡ 1M Velocity (t/m)',
    unit: 't/m',
    defaultVal: 100,
    presets: [45, 100, 140]
  },
  'vel_5m': {
    label: '⚡ 5M Velocity (t/m)',
    unit: 't/m',
    defaultVal: 100,
    presets: [45, 100, 140]
  },
  'cvd': {
    label: '🌊 CVD Delta (L)',
    unit: 'L',
    defaultVal: 200,
    presets: [200, -200, 500, -500]
  },
  'fp': {
    label: '📊 4M Footprint Delta (L)',
    unit: 'L',
    defaultVal: 140,
    presets: [140, -140, 300, -300]
  },
  'impulse': {
    label: '⚡ Impulse Rate (pt/m)',
    unit: 'pt/m',
    defaultVal: 1.5,
    presets: [0.8, -0.8, 1.5, -1.5, 2.5, -2.5]
  },
  'silver': {
    label: '🥈 Silver Shift Score (-99 to +99)',
    unit: 'pts',
    defaultVal: 15,
    presets: [15, -15, 38, -38]
  }
};

export const QUICK_PRESETS = [
  {
    name: '🚀 Kinetic Momentum Surge',
    channel: 'BOTH',
    logic: 'ALL',
    cooldownSec: 60,
    conditions: [
      { metric: 'vel_1m', op: '>=', value: 100 },
      { metric: 'cvd', op: '>=', value: 200 }
    ]
  },
  {
    name: '🛑 Liquidity Dump Cascade',
    channel: 'BOTH',
    logic: 'ALL',
    cooldownSec: 60,
    conditions: [
      { metric: 'vel_1m', op: '>=', value: 100 },
      { metric: 'cvd', op: '<=', value: -200 }
    ]
  },
  {
    name: '🥈 Silver Bull Beta Lead',
    channel: 'BOTH',
    logic: 'ALL',
    cooldownSec: 60,
    conditions: [
      { metric: 'silver', op: '>=', value: 15 },
      { metric: 'impulse', op: '>=', value: 0.8 }
    ]
  },
  {
    name: '🌊 CVD Absorption Divergence',
    channel: 'BOTH',
    logic: 'ALL',
    cooldownSec: 60,
    conditions: [
      { metric: 'impulse', op: '<=', value: -0.5 },
      { metric: 'cvd', op: '>=', value: 300 }
    ]
  },
  {
    name: '🤫 Quiet Retest Floor (Prong A)',
    channel: 'BOTH',
    logic: 'ALL',
    cooldownSec: 120,
    conditions: [
      { metric: 'vel_1m', op: '<=', value: 40 },
      { metric: 'vel_5m', op: '<=', value: 45 }
    ]
  }
];

// =============================================================================
// 🔊 WEB AUDIO SYNTHESIZER (PC CHIME ALERT)
// =============================================================================

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function playPcAlarmSound(type = 'alarm') {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    if (type === 'alarm') {
      // High-priority 3-tone arpeggio siren (A5 -> D6 -> A6)
      osc1.type = 'triangle';
      osc2.type = 'sine';

      osc1.frequency.setValueAtTime(880, now);
      osc1.frequency.setValueAtTime(1174.66, now + 0.12);
      osc1.frequency.setValueAtTime(1760, now + 0.24);

      osc2.frequency.setValueAtTime(440, now);
      osc2.frequency.setValueAtTime(587.33, now + 0.12);
      osc2.frequency.setValueAtTime(880, now + 0.24);

      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.45, now + 0.05);
      gain.gain.linearRampToValueAtTime(0.35, now + 0.24);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.70);
      osc2.stop(now + 0.70);
    } else {
      // Pleasant test ding
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(1046.5, now); // C6
      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.3, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc1.connect(gain);
      gain.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.45);
    }
  } catch (err) {
    console.warn('[GaugeAlarms] Web Audio play failed:', err);
  }
}
window.playPcAlarmSound = playPcAlarmSound;

// =============================================================================
// 📱 TELEGRAM DISPATCHER
// =============================================================================

export function getTelegramConfig() {
  try {
    const raw = localStorage.getItem(TELEGRAM_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    bot_token: '8748826581:AAEoP9rXDeINirO7rov-TcE7ikkY3rkWC1M',
    chat_id: -1004324335052
  };
}

export function saveTelegramConfig(cfg) {
  try {
    localStorage.setItem(TELEGRAM_CONFIG_KEY, JSON.stringify(cfg));
  } catch (e) {}
}

export async function sendTelegramAlert(alarm, liveValues) {
  const cfg = getTelegramConfig();
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });

  let condDetails = alarm.conditions.map(c => {
    const mCfg = GAUGE_METRICS[c.metric] || {};
    const liveVal = liveValues[c.metric] !== undefined ? liveValues[c.metric] : '--';
    return `• <b>${mCfg.label || c.metric}</b>: Current <code>${liveVal}</code> (Target ${c.op} ${c.value})`;
  }).join('\n');

  const message = `🚨 <b>ESCANOR GAUGE ALARM TRIGGERED</b> 🚨\n\n` +
    `🏷️ <b>Rule:</b> ${alarm.name}\n` +
    `⚡ <b>Trigger Logic:</b> ${alarm.logic || 'ALL'}\n` +
    `🕒 <b>Time:</b> ${timeStr}\n\n` +
    `📊 <b>Gauge Conditions:</b>\n${condDetails}\n\n` +
    `📈 <b>Live Tape Physics:</b>\n` +
    `• Vel 1M: <code>${liveValues.vel_1m} t/m</code> · 5M: <code>${liveValues.vel_5m} t/m</code>\n` +
    `• CVD Delta: <code>${liveValues.cvd >= 0 ? '+' : ''}${liveValues.cvd}L</code>\n` +
    `• 4M Footprint: <code>${liveValues.fp >= 0 ? '+' : ''}${liveValues.fp}L</code>\n` +
    `• Impulse: <code>${liveValues.impulse >= 0 ? '+' : ''}${liveValues.impulse} pt/m</code>\n` +
    `• Silver Shift: <code>${liveValues.silver >= 0 ? '+' : ''}${liveValues.silver}</code>`;

  try {
    const res = await fetch('/api/telegram/send_alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        bot_token: cfg.bot_token,
        chat_id: cfg.chat_id
      })
    });
    const data = await res.json();
    return data && data.status === 'OK';
  } catch (err) {
    console.error('[GaugeAlarms] Telegram dispatch failed:', err);
    return false;
  }
}

export async function testTelegramPing() {
  const cfg = getTelegramConfig();
  const timeStr = new Date().toLocaleTimeString();
  const message = `🔔 <b>Escanor Gauge Alarms — Test Connection</b>\n\n` +
    `✔ Telegram alert bot communication verified successfully!\n` +
    `🕒 <b>Timestamp:</b> ${timeStr}\n` +
    `📱 <b>Chat ID:</b> <code>${cfg.chat_id}</code>`;

  try {
    const res = await fetch('/api/telegram/send_alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        bot_token: cfg.bot_token,
        chat_id: cfg.chat_id
      })
    });
    const data = await res.json();
    return data && data.status === 'OK';
  } catch (err) {
    return false;
  }
}

// =============================================================================
// 🧭 ALARMS STORAGE & SYNC
// =============================================================================

export function loadAlarms() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      alarms = JSON.parse(raw);
    }
  } catch (e) {
    alarms = [];
  }
  updateAlarmsBadge();
  // Sync in background from server
  fetch('/api/gauge_alarms')
    .then(r => r.json())
    .then(data => {
      if (data && Array.isArray(data.alarms) && data.alarms.length > 0 && alarms.length === 0) {
        alarms = data.alarms;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(alarms));
        updateAlarmsBadge();
        renderActiveAlarmsList();
      }
    })
    .catch(() => {});
  return alarms;
}

export function saveAlarms() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alarms));
    fetch('/api/gauge_alarms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alarms })
    }).catch(() => {});
  } catch (e) {}
  updateAlarmsBadge();
}

function updateAlarmsBadge() {
  const badge = document.getElementById('activeAlarmsBadge');
  if (!badge) return;
  const activeCount = alarms.filter(a => a.enabled).length;
  if (activeCount > 0) {
    badge.textContent = `${activeCount} ARMED`;
    badge.className = 'px-1.5 py-0.2 text-[8px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded-full font-mono font-bold';
    badge.classList.remove('hidden');
  } else {
    badge.textContent = '0 ARMED';
    badge.className = 'hidden';
  }
}

// =============================================================================
// ⚡ LIVE TELEMETRY EVALUATION
// =============================================================================

export function extractGaugeValues(tel) {
  if (!tel) return null;
  const tape = tel.tape || {};
  const impulseData = tel.impulse || (tape && tape.impulse) || {};
  const silver = tel.silver || {};

  const vel1m = tape.vel_1m !== undefined ? Number(tape.vel_1m) : (Number(tape.tick_velocity) || 0);
  const vel5m = tape.vel_5m_avg !== undefined ? Number(tape.vel_5m_avg) : (Number(tape.vel_5m) || vel1m);
  const cvd = Number(tape.cvd_delta) || 0;
  const fp = Number(tape.footprint_delta) || 0;
  const impulse = impulseData.rate_pt_min !== undefined ? Number(impulseData.rate_pt_min) : (Number(tape.impulse_rate) || 0);

  // Silver shift score
  let silverScore = 0;
  if (window.selectedLeadGauge === 'XAG' || !window.selectedLeadGauge) {
    const curPct = Number(silver.xag_pct !== undefined ? silver.xag_pct : 0.0);
    const xauPct = Number(silver.xau_pct !== undefined ? silver.xau_pct : (tel?.spot?.xau_pct || 0.0));
    silverScore = Math.round((curPct - xauPct) * 100);
  }

  return {
    vel_1m: Math.round(vel1m),
    vel_5m: Math.round(vel5m),
    cvd: Math.round(cvd),
    fp: Math.round(fp),
    impulse: Math.round(impulse * 10) / 10,
    silver: silverScore
  };
}

export function evaluateGaugeAlarms(tel) {
  if (!tel || alarms.length === 0) return;
  const vals = extractGaugeValues(tel);
  if (!vals) return;
  lastEvaluatedTelemetry = vals;

  const now = Date.now();

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    if (!Array.isArray(alarm.conditions) || alarm.conditions.length === 0) continue;

    // Check cooldown
    const cooldownMs = (alarm.cooldownSec === -1) ? Infinity : (Number(alarm.cooldownSec || 60) * 1000);
    if (alarm.lastTriggered && (now - alarm.lastTriggered < cooldownMs)) {
      continue;
    }

    // Evaluate conditions
    const logic = alarm.logic || 'ALL';
    let triggered = false;

    if (logic === 'ALL') {
      triggered = alarm.conditions.every(c => checkSingleCondition(c, vals));
    } else {
      triggered = alarm.conditions.some(c => checkSingleCondition(c, vals));
    }

    if (triggered) {
      fireAlarm(alarm, vals);
    }
  }
}

function checkSingleCondition(cond, vals) {
  const current = vals[cond.metric];
  if (current === undefined || current === null || isNaN(current)) return false;

  const target = Number(cond.value);
  if (cond.op === '>=') {
    return current >= target;
  } else if (cond.op === '<=') {
    return current <= target;
  }
  return false;
}

function fireAlarm(alarm, vals) {
  alarm.lastTriggered = Date.now();
  alarm.triggerCount = (alarm.triggerCount || 0) + 1;

  // Once-only alarm automatically disables
  if (alarm.cooldownSec === -1) {
    alarm.enabled = false;
  }

  saveAlarms();
  renderActiveAlarmsList();

  const channel = alarm.channel || 'BOTH';

  // 1. PC Audio & Visual Notification
  if (channel === 'PC' || channel === 'BOTH') {
    playPcAlarmSound('alarm');
    showAlarmBanner(alarm, vals);

    // Desktop Notification API
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`🚨 Escanor Alarm: ${alarm.name}`, {
          body: `Triggered at ${new Date().toLocaleTimeString()}! Tap to inspect.`,
          icon: '/favicon.ico'
        });
      } catch (e) {}
    }
  }

  // 2. Telegram Bot Dispatch
  if (channel === 'TELEGRAM' || channel === 'BOTH') {
    sendTelegramAlert(alarm, vals);
  }
}

function showAlarmBanner(alarm, vals) {
  let el = document.getElementById('tvAlarmBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tvAlarmBanner';
    el.className = 'fixed top-3 left-1/2 -translate-x-1/2 z-[9999] w-[92%] max-w-sm p-3 rounded-xl bg-[#0c1223]/95 border-2 border-amber-400 shadow-[0_0_25px_rgba(251,191,36,0.5)] font-mono text-slate-100 flex flex-col gap-1 backdrop-blur-md transition-all duration-300 animate-bounce';
    document.body.appendChild(el);
  }

  const condText = alarm.conditions.map(c => `${c.metric} ${c.op} ${c.value}`).join(' & ');

  el.innerHTML = `
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-1.5 font-black text-amber-300 text-xs tracking-wider">
        <span>🚨</span>
        <span>${alarm.name}</span>
      </div>
      <button onclick="this.parentElement.parentElement.remove()" class="text-slate-400 hover:text-white text-xs px-1">✕</button>
    </div>
    <div class="text-[10px] text-emerald-400 font-bold">${condText}</div>
    <div class="text-[9px] text-slate-400 flex items-center justify-between border-t border-white/10 pt-1 mt-0.5">
      <span>Vel: ${vals.vel_1m} | CVD: ${vals.cvd >= 0 ? '+' : ''}${vals.cvd} | Imp: ${vals.impulse}</span>
      <span class="text-amber-400 font-bold">${alarm.channel}</span>
    </div>
  `;

  el.style.display = 'flex';
  clearTimeout(window.__alarmBannerTimer);
  window.__alarmBannerTimer = setTimeout(() => {
    if (el) el.style.display = 'none';
  }, 7500);
}

// =============================================================================
// 🎛️ MODAL UI CONTROLLER
// =============================================================================

export function initGaugeAlarms() {
  loadAlarms();

  const btn = document.getElementById('openGaugeAlarmsBtn');
  if (btn) {
    btn.onclick = (e) => {
      if (e) e.preventDefault();
      openGaugeAlarmsModal();
    };
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openGaugeAlarmsModal();
    });
  }

  // Request browser Notification permission on first click
  if ('Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => {
      Notification.requestPermission().catch(() => {});
    }, { once: true });
  }

  // Pre-seed audio context on user gesture
  document.addEventListener('click', () => {
    getAudioContext();
  }, { once: true });
}

export function openGaugeAlarmsModal() {
  console.log('[GaugeAlarms] Opening gauge alarms modal...');
  const modal = document.getElementById('gaugeAlarmsModal');
  if (!modal) {
    console.error('[GaugeAlarms] Modal #gaugeAlarmsModal element not found!');
    return;
  }
  modal.style.display = 'flex';
  modal.classList.remove('hidden');
  try { getAudioContext(); } catch (e) {}
  try { switchAlarmsTab('active'); } catch (e) {}
  try { renderActiveAlarmsList(); } catch (e) {}
  try { renderTelegramTab(); } catch (e) {}
}
window.openGaugeAlarmsModal = openGaugeAlarmsModal;
window.__realOpenGaugeAlarmsModal = openGaugeAlarmsModal;

export function closeGaugeAlarmsModal() {
  const modal = document.getElementById('gaugeAlarmsModal');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.add('hidden');
  }
}
window.closeGaugeAlarmsModal = closeGaugeAlarmsModal;

export function switchAlarmsTab(tab) {
  const tabActive = document.getElementById('alarmTabBtnActive');
  const tabCreate = document.getElementById('alarmTabBtnCreate');
  const tabTg = document.getElementById('alarmTabBtnTg');

  const contentActive = document.getElementById('alarmContentActive');
  const contentCreate = document.getElementById('alarmContentCreate');
  const contentTg = document.getElementById('alarmContentTg');

  [tabActive, tabCreate, tabTg].forEach(t => t?.classList.remove('border-amber-400', 'text-amber-300', 'bg-amber-500/10'));
  [contentActive, contentCreate, contentTg].forEach(c => c?.classList.add('hidden'));

  if (tab === 'create') {
    tabCreate?.classList.add('border-amber-400', 'text-amber-300', 'bg-amber-500/10');
    contentCreate?.classList.remove('hidden');
  } else if (tab === 'tg') {
    tabTg?.classList.add('border-amber-400', 'text-amber-300', 'bg-amber-500/10');
    contentTg?.classList.remove('hidden');
    renderTelegramTab();
  } else {
    tabActive?.classList.add('border-amber-400', 'text-amber-300', 'bg-amber-500/10');
    contentActive?.classList.remove('hidden');
    renderActiveAlarmsList();
  }
}
window.switchAlarmsTab = switchAlarmsTab;

export function renderActiveAlarmsList() {
  const listEl = document.getElementById('activeAlarmsListContainer');
  if (!listEl) return;

  if (alarms.length === 0) {
    listEl.innerHTML = `
      <div class="py-8 text-center text-slate-500 space-y-2">
        <div class="text-3xl">🔕</div>
        <div class="text-xs font-bold text-slate-400">NO GAUGE ALARMS CONFIGURED</div>
        <div class="text-[10px] text-slate-500">Create a single-item or combination alert from the '+ NEW ALARM' tab.</div>
        <button onclick="switchAlarmsTab('create')" class="mt-2 px-3 py-1.5 rounded-lg bg-amber-500 text-black font-black text-[10px] shadow-sm hover:bg-amber-400 active:scale-95 transition">
          + CREATE FIRST ALARM
        </button>
      </div>
    `;
    return;
  }

  listEl.innerHTML = alarms.map((alarm, idx) => {
    const isArmed = alarm.enabled;
    const channelBadge = alarm.channel === 'BOTH' ? '⚡ PC + TELEGRAM' : (alarm.channel === 'PC' ? '🖥️ PC ONLY' : '📱 TELEGRAM');
    const channelColor = alarm.channel === 'BOTH' ? 'text-amber-300 border-amber-400/40 bg-amber-500/10' : (alarm.channel === 'PC' ? 'text-cyan-300 border-cyan-400/40 bg-cyan-500/10' : 'text-blue-300 border-blue-400/40 bg-blue-500/10');

    const condList = alarm.conditions.map(c => {
      const mCfg = GAUGE_METRICS[c.metric] || {};
      return `<span class="px-1.5 py-0.5 rounded bg-slate-900 border border-white/10 text-[9px] text-slate-200">
        ${mCfg.label?.split(' ')[1] || c.metric} ${c.op} <strong>${c.value}</strong>
      </span>`;
    }).join(`<span class="text-[9px] text-slate-500 font-bold mx-0.5">${alarm.logic || 'AND'}</span>`);

    const lastTrig = alarm.lastTriggered ? new Date(alarm.lastTriggered).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Never';

    return `
      <div class="p-2.5 rounded-xl bg-slate-900/80 border ${isArmed ? 'border-amber-500/30' : 'border-white/5 opacity-60'} space-y-1.5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <button onclick="toggleAlarmEnabled('${alarm.id}')" class="text-xs transition active:scale-90" title="Toggle Alarm On/Off">
              ${isArmed ? '🟢' : '⚪'}
            </button>
            <span class="font-bold text-xs ${isArmed ? 'text-slate-100' : 'text-slate-400'}">${alarm.name}</span>
          </div>
          <div class="flex items-center gap-1">
            <span class="px-1.5 py-0.5 rounded text-[8px] font-bold border ${channelColor}">${channelBadge}</span>
            <button onclick="testAlarmTrigger('${alarm.id}')" class="p-1 text-slate-400 hover:text-amber-300 text-[10px]" title="Test Trigger Alarm">🔔</button>
            <button onclick="deleteAlarm('${alarm.id}')" class="p-1 text-red-400 hover:text-red-300 text-[10px]" title="Delete Alarm">✕</button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-1 pt-0.5">
          ${condList}
        </div>

        <div class="flex items-center justify-between text-[8px] text-slate-500 pt-1 border-t border-white/5">
          <span>Cooldown: ${alarm.cooldownSec === -1 ? 'Once Only' : alarm.cooldownSec + 's'}</span>
          <span>Triggers: ${alarm.triggerCount || 0} · Last: ${lastTrig}</span>
        </div>
      </div>
    `;
  }).join('');
}

export function toggleAlarmEnabled(id) {
  const al = alarms.find(a => a.id === id);
  if (al) {
    al.enabled = !al.enabled;
    saveAlarms();
    renderActiveAlarmsList();
  }
}
window.toggleAlarmEnabled = toggleAlarmEnabled;

export function deleteAlarm(id) {
  alarms = alarms.filter(a => a.id !== id);
  saveAlarms();
  renderActiveAlarmsList();
}
window.deleteAlarm = deleteAlarm;

export function testAlarmTrigger(id) {
  const al = alarms.find(a => a.id === id);
  if (al) {
    const vals = lastEvaluatedTelemetry || { vel_1m: 130, vel_5m: 138, cvd: 272, fp: 140, impulse: 0.1, silver: 14 };
    fireAlarm(al, vals);
  }
}
window.testAlarmTrigger = testAlarmTrigger;

// =============================================================================
// 📝 ALARM CREATOR FORM LOGIC
// =============================================================================

let creatorConditions = [];
let creatorChannel = 'BOTH';
let creatorLogic = 'ALL';

export function resetCreatorForm(preset = null) {
  creatorConditions = [];
  creatorChannel = preset?.channel || 'BOTH';
  creatorLogic = preset?.logic || 'ALL';

  const nameInput = document.getElementById('alarmNameInput');
  if (nameInput) {
    nameInput.value = preset?.name || 'Gauge Physics Alert';
  }

  const cooldownSel = document.getElementById('alarmCooldownSelect');
  if (cooldownSel) {
    cooldownSel.value = preset?.cooldownSec !== undefined ? String(preset.cooldownSec) : '60';
  }

  setCreatorChannel(creatorChannel);
  setCreatorLogic(creatorLogic);

  if (preset && Array.isArray(preset.conditions)) {
    creatorConditions = JSON.parse(JSON.stringify(preset.conditions));
  } else {
    // Default 1 condition
    creatorConditions = [{ metric: 'vel_1m', op: '>=', value: 100 }];
  }
  renderCreatorConditionRows();
}
window.resetCreatorForm = resetCreatorForm;

export function applyQuickPreset(idx) {
  const p = QUICK_PRESETS[idx];
  if (p) {
    resetCreatorForm(p);
  }
}
window.applyQuickPreset = applyQuickPreset;

export function setCreatorChannel(ch) {
  creatorChannel = ch;
  ['btnChanBoth', 'btnChanPc', 'btnChanTg'].forEach(id => {
    const b = document.getElementById(id);
    b?.classList.remove('bg-amber-500', 'text-black', 'border-amber-400');
    b?.classList.add('bg-slate-900', 'text-slate-300', 'border-white/10');
  });

  const activeId = ch === 'BOTH' ? 'btnChanBoth' : (ch === 'PC' ? 'btnChanPc' : 'btnChanTg');
  const activeBtn = document.getElementById(activeId);
  if (activeBtn) {
    activeBtn.classList.remove('bg-slate-900', 'text-slate-300', 'border-white/10');
    activeBtn.classList.add('bg-amber-500', 'text-black', 'border-amber-400', 'font-black');
  }
}
window.setCreatorChannel = setCreatorChannel;

export function setCreatorLogic(logic) {
  creatorLogic = logic;
  const btnAll = document.getElementById('btnLogicAll');
  const btnAny = document.getElementById('btnLogicAny');

  if (logic === 'ALL') {
    btnAll?.classList.add('bg-amber-500', 'text-black', 'font-black');
    btnAll?.classList.remove('bg-slate-900', 'text-slate-400');
    btnAny?.classList.add('bg-slate-900', 'text-slate-400');
    btnAny?.classList.remove('bg-amber-500', 'text-black', 'font-black');
  } else {
    btnAny?.classList.add('bg-amber-500', 'text-black', 'font-black');
    btnAny?.classList.remove('bg-slate-900', 'text-slate-400');
    btnAll?.classList.add('bg-slate-900', 'text-slate-400');
    btnAll?.classList.remove('bg-amber-500', 'text-black', 'font-black');
  }
}
window.setCreatorLogic = setCreatorLogic;

export function addCreatorCondition() {
  creatorConditions.push({ metric: 'cvd', op: '>=', value: 200 });
  renderCreatorConditionRows();
}
window.addCreatorCondition = addCreatorCondition;

export function removeCreatorCondition(idx) {
  if (creatorConditions.length <= 1) return;
  creatorConditions.splice(idx, 1);
  renderCreatorConditionRows();
}
window.removeCreatorCondition = removeCreatorCondition;

export function updateCreatorCondition(idx, field, val) {
  if (!creatorConditions[idx]) return;
  if (field === 'value') {
    creatorConditions[idx][field] = Number(val) || 0;
  } else {
    creatorConditions[idx][field] = val;
    // Set sensible default if metric changed
    if (field === 'metric' && GAUGE_METRICS[val]) {
      creatorConditions[idx].value = GAUGE_METRICS[val].defaultVal;
    }
  }
  renderCreatorConditionRows();
}
window.updateCreatorCondition = updateCreatorCondition;

export function setConditionPresetVal(idx, val) {
  if (!creatorConditions[idx]) return;
  creatorConditions[idx].value = val;
  renderCreatorConditionRows();
}
window.setConditionPresetVal = setConditionPresetVal;

export function renderCreatorConditionRows() {
  const container = document.getElementById('creatorConditionsContainer');
  if (!container) return;

  container.innerHTML = creatorConditions.map((c, idx) => {
    const mCfg = GAUGE_METRICS[c.metric] || {};
    const presets = mCfg.presets || [];

    const metricOpts = Object.entries(GAUGE_METRICS).map(([k, cfg]) => {
      return `<option value="${k}" ${k === c.metric ? 'selected' : ''}>${cfg.label}</option>`;
    }).join('');

    const presetPills = presets.map(p => {
      return `<button type="button" onclick="setConditionPresetVal(${idx}, ${p})" class="px-1.5 py-0.5 rounded bg-slate-950 border border-white/10 hover:border-amber-400 text-[8px] text-slate-300 font-mono active:scale-95">
        ${p > 0 && c.metric !== 'vel_1m' && c.metric !== 'vel_5m' ? '+' : ''}${p}
      </button>`;
    }).join('');

    return `
      <div class="p-2 rounded-xl bg-slate-900 border border-white/10 space-y-1.5">
        <div class="flex items-center justify-between text-[9px] font-bold text-amber-300">
          <span>CONDITION #${idx + 1}</span>
          ${creatorConditions.length > 1 ? `<button type="button" onclick="removeCreatorCondition(${idx})" class="text-red-400 hover:text-red-300 text-[10px]">✕ Remove</button>` : ''}
        </div>

        <div class="grid grid-cols-12 gap-1.5">
          <div class="col-span-7">
            <label class="text-[8px] text-slate-400 block mb-0.5">Gauge Item</label>
            <select onchange="updateCreatorCondition(${idx}, 'metric', this.value)" class="w-full bg-slate-950 border border-white/10 rounded-lg p-1.5 text-[10px] text-white font-mono focus:border-amber-400 outline-none">
              ${metricOpts}
            </select>
          </div>

          <div class="col-span-2">
            <label class="text-[8px] text-slate-400 block mb-0.5">Op</label>
            <select onchange="updateCreatorCondition(${idx}, 'op', this.value)" class="w-full bg-slate-950 border border-white/10 rounded-lg p-1.5 text-[10px] text-amber-300 font-black font-mono focus:border-amber-400 outline-none text-center">
              <option value=">=" ${c.op === '>=' ? 'selected' : ''}>≥</option>
              <option value="<=" ${c.op === '<=' ? 'selected' : ''}>≤</option>
            </select>
          </div>

          <div class="col-span-3">
            <label class="text-[8px] text-slate-400 block mb-0.5">Value (${mCfg.unit})</label>
            <input type="number" step="any" value="${c.value}" onchange="updateCreatorCondition(${idx}, 'value', this.value)" class="w-full bg-slate-950 border border-white/10 rounded-lg p-1.5 text-[10px] text-emerald-400 font-mono font-bold focus:border-amber-400 outline-none text-right"/>
          </div>
        </div>

        <div class="flex items-center gap-1 overflow-x-auto pt-0.5">
          <span class="text-[7.5px] text-slate-500 whitespace-nowrap">Presets:</span>
          ${presetPills}
        </div>
      </div>
    `;
  }).join('');
}

export function saveCreatedAlarm() {
  const nameInput = document.getElementById('alarmNameInput');
  const cooldownSel = document.getElementById('alarmCooldownSelect');

  const name = nameInput?.value?.trim() || 'Custom Gauge Alarm';
  const cooldownSec = Number(cooldownSel?.value || 60);

  const newAlarm = {
    id: `alarm_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
    name,
    enabled: true,
    channel: creatorChannel,
    logic: creatorLogic,
    cooldownSec,
    lastTriggered: null,
    triggerCount: 0,
    conditions: JSON.parse(JSON.stringify(creatorConditions))
  };

  alarms.push(newAlarm);
  saveAlarms();
  switchAlarmsTab('active');
  playPcAlarmSound('ding');
}
window.saveCreatedAlarm = saveCreatedAlarm;

// =============================================================================
// ⚙️ TELEGRAM SETTINGS TAB
// =============================================================================

export function renderTelegramTab() {
  const cfg = getTelegramConfig();
  const tokenInp = document.getElementById('tgBotTokenInput');
  const chatInp = document.getElementById('tgChatIdInput');

  if (tokenInp) tokenInp.value = cfg.bot_token || '';
  if (chatInp) chatInp.value = cfg.chat_id || '';
}

export function saveTelegramSettings() {
  const tokenInp = document.getElementById('tgBotTokenInput');
  const chatInp = document.getElementById('tgChatIdInput');

  const bot_token = tokenInp?.value?.trim() || '';
  const chat_id = chatInp?.value?.trim() || '';

  saveTelegramConfig({ bot_token, chat_id });
  alert('✔ Telegram Bot configuration saved!');
}
window.saveTelegramSettings = saveTelegramSettings;

export async function handleTestTelegramClick() {
  const btn = document.getElementById('btnTestTelegram');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Sending test...';
  }

  const ok = await testTelegramPing();

  if (btn) {
    btn.disabled = false;
    btn.textContent = ok ? '✔ Message Sent!' : '❌ Failed (Check Bot)';
    setTimeout(() => {
      btn.textContent = '📱 Send Test Message';
    }, 2500);
  }
}
window.handleTestTelegramClick = handleTestTelegramClick;
