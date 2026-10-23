/**
 * Escanor — Real-Time Trap Candle Alert Engine (Cyan & Yellow)
 * 
 * Monitors the live forming candle in real-time. The split-second
 * a Cyan (Buyer Absorption) or Yellow (Seller Distribution) trap forms,
 * it dispatches:
 * 1. PC Audio Chime (Synthesized Web Audio tones) & Screen Toast
 * 2. Telegram Alert to trader's channel
 * 3. Exactly 3 seconds later, repeats the alert sequence (2 times in a 3s gap).
 */

import { evaluateCandleTrapState } from './living_candle_engine.js';
import { showChartToast } from './drawings_storage.js';

let trapAudioCtx = null;
let lastTriggeredTrapKey = null;
let trapAlertTimeout = null;

/**
 * Play high-impact PC Web Audio chime for Trap alerts.
 */
export function playTrapAlertChime(isCyan = true) {
  try {
    if (!trapAudioCtx) {
      trapAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (trapAudioCtx.state === 'suspended') {
      trapAudioCtx.resume();
    }
    const now = trapAudioCtx.currentTime;
    const osc1 = trapAudioCtx.createOscillator();
    const osc2 = trapAudioCtx.createOscillator();
    const gain = trapAudioCtx.createGain();

    if (isCyan) {
      // Ascending energetic tri-tones (Bullish Buyer Absorption)
      osc1.type = 'sine';
      osc2.type = 'triangle';
      osc1.frequency.setValueAtTime(659.25, now);        // E5
      osc1.frequency.setValueAtTime(880.00, now + 0.10); // A5
      osc1.frequency.setValueAtTime(1046.50, now + 0.20); // C6
      osc2.frequency.setValueAtTime(1318.51, now + 0.20); // E6
    } else {
      // Descending sharp tri-tones (Bearish Seller Distribution)
      osc1.type = 'sine';
      osc2.type = 'triangle';
      osc1.frequency.setValueAtTime(987.77, now);        // B5
      osc1.frequency.setValueAtTime(783.99, now + 0.10); // G5
      osc1.frequency.setValueAtTime(587.33, now + 0.20); // D5
      osc2.frequency.setValueAtTime(1174.66, now + 0.05); // D6
    }

    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.40, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(trapAudioCtx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.70);
    osc2.stop(now + 0.70);
  } catch (e) {
    console.warn('[Trap Audio] Play failed:', e);
  }
}

/**
 * Dispatch formatted HTML alert message to Telegram channel.
 */
export async function dispatchTrapTelegramAlert(trapType, candle, spotPrice, repeatCount = 1) {
  try {
    const isCyan = (trapType === 'CYAN');
    const trapLabel = isCyan ? '🩵 CYAN TRAP (BUYER ABSORPTION)' : '💛 YELLOW TRAP (SELLER DISTRIBUTION)';
    const tag = repeatCount === 1 ? '1/2 (IMMEDIATE FORMATION)' : '2/2 (3-SEC REPEAT CONFIRMATION)';
    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'UTC' });
    const localTimeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
    const wickRatio = isCyan ? (candle.lowerRatio || 0) : (candle.upperRatio || 0);
    const wickPct = Math.round(wickRatio * 100);

    const msg = `🚨 <b>ESCANOR TRAP CANDLE ALERT [${tag}]</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `<b>Trap:</b> ${trapLabel}\n` +
      `<b>Asset:</b> Gold ($XAUUSD$)\n` +
      `<b>Live Spot:</b> $${Number(spotPrice).toFixed(2)}\n` +
      `<b>Candle Close:</b> $${Number(candle.close).toFixed(2)}\n` +
      `<b>Rejection Wick:</b> ${wickPct}% ${isCyan ? 'Lower Wick Rejection' : 'Upper Wick Distribution'}\n` +
      `<b>Extremum Level:</b> $${Number(isCyan ? candle.low : candle.high).toFixed(2)}\n` +
      `<b>Time:</b> ${timeStr} UTC (${localTimeStr} Local)\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      (repeatCount === 1 
        ? `🔔 <i>Alert 1 of 2 dispatched. 2nd confirmation firing in 3 seconds...</i>` 
        : `🛡️ <i>Trap formed & holding. Sequence complete.</i>`);

    fetch('/api/telegram/send_alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    }).catch(err => console.warn('[Trap Telegram] Dispatch error:', err));
  } catch (e) {
    console.error('[Trap Telegram] Error:', e);
  }
}

/**
 * Core evaluation method called on every price tick and bar update.
 */
export function evaluateTrapLiveAlert(dataList, spotPrice) {
  if (window.__trapAlertActive !== true) return;
  if (!dataList || dataList.length < 5) return;

  const lastIndex = dataList.length - 1;
  const k = dataList[lastIndex];
  if (!k) return;

  const trapState = evaluateCandleTrapState(dataList, lastIndex, null);
  if (!trapState.isCyan && !trapState.isYellow) return;

  const trapType = trapState.isCyan ? 'CYAN' : 'YELLOW';
  const trapKey = `${trapType}_${k.timestamp}`;

  // Deduplication: Do not re-trigger on the exact same candle & trap type
  if (lastTriggeredTrapKey === trapKey) {
    return;
  }
  lastTriggeredTrapKey = trapKey;

  const curSpot = Number(spotPrice || k.close);
  const isCyan = trapState.isCyan;
  const trapName = isCyan ? '🩵 CYAN (Buyer Absorption)' : '💛 YELLOW (Seller Distribution)';
  const wickPct = Math.round((isCyan ? trapState.lowerRatio : trapState.upperRatio) * 100);

  // ==========================================
  // ⚡ ALERT 1: IMMEDIATE (t = 0)
  // ==========================================
  console.log(`[TrapAlert] 🚨 ${trapType} TRAP FORMED @ $${curSpot.toFixed(2)} (Alert 1/2)`);
  
  // 1. PC Audio Chime
  playTrapAlertChime(isCyan);

  // 2. PC Visual Toast
  showChartToast(`⚡ ${trapName} FORMED @ $${curSpot.toFixed(2)} (${wickPct}% Wick) [Alert 1/2]`);

  // 3. Telegram Alert 1
  dispatchTrapTelegramAlert(trapType, { ...k, lowerRatio: trapState.lowerRatio, upperRatio: trapState.upperRatio }, curSpot, 1);

  // ==========================================
  // ⚡ ALERT 2: 3 SECONDS LATER (t = 3s)
  // ==========================================
  if (trapAlertTimeout) clearTimeout(trapAlertTimeout);
  trapAlertTimeout = setTimeout(() => {
    const freshSpot = window.__lastKnownSpot?.bid || curSpot;
    console.log(`[TrapAlert] 🚨 ${trapType} TRAP CONFIRMATION @ $${freshSpot.toFixed(2)} (Alert 2/2)`);
    
    // 1. PC Audio Chime (Repeat)
    playTrapAlertChime(isCyan);

    // 2. PC Visual Toast (Repeat)
    showChartToast(`⚡ ${trapName} CONFIRMATION @ $${freshSpot.toFixed(2)} [Alert 2/2]`);

    // 3. Telegram Alert 2
    dispatchTrapTelegramAlert(trapType, { ...k, lowerRatio: trapState.lowerRatio, upperRatio: trapState.upperRatio }, freshSpot, 2);
  }, 3000);
}

/**
 * Initialize the Header Button & bind click events.
 */
export function initTrapAlerts() {
  const btn = document.getElementById('tvTrapLiveAlertBtn');
  const statusEl = document.getElementById('tvTrapLiveAlertStatus');
  if (!btn) return;

  // Restore saved state from localStorage (default: OFF)
  const savedState = localStorage.getItem('escanor_trap_alert_active') === 'true';
  window.__trapAlertActive = savedState;

  function updateButtonUI() {
    const isActive = Boolean(window.__trapAlertActive);
    btn.classList.toggle('active', isActive);
    if (statusEl) {
      statusEl.textContent = isActive ? 'ON' : 'OFF';
    }
    btn.title = isActive
      ? 'Trap Alert is ACTIVE: Sends PC Sound & Telegram alert twice in a 3s gap whenever Cyan/Yellow forms (Click to Disable)'
      : 'Trap Alert is OFF: Click to Activate PC Sound & Telegram alerts whenever Cyan/Yellow forms';
  }

  updateButtonUI();

  btn.addEventListener('click', () => {
    window.__trapAlertActive = !window.__trapAlertActive;
    localStorage.setItem('escanor_trap_alert_active', String(window.__trapAlertActive));
    updateButtonUI();

    if (window.__trapAlertActive) {
      playTrapAlertChime(true);
      showChartToast('⚡ Trap Alert (Cyan & Yellow) ACTIVATED! Will alert on PC & Telegram');
    } else {
      if (trapAlertTimeout) clearTimeout(trapAlertTimeout);
      showChartToast('🔕 Trap Alert (Cyan & Yellow) DEACTIVATED');
    }
  });
}
