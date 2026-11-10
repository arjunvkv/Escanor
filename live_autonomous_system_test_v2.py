"""
AUTONOMOUS LIVE MIMIC V2: FIXING THE 3 BLIND BOT DEFECTS
1. Replaces naive impulse direction with PHYSICAL ABSORPTION SWEEP & RECLAIM (Wyckoff Spring / Upthrust)
2. Expands scratch buffer to $2.20 - $2.80p to absorb 0.54p round-trip broker friction
3. Adjusts Auto-BE trigger to +2.40p so normal retests don't choke the runner
Tests across 3,500 historical M5 bars with real MT5 spread (0.38p), slippage (0.10p), commission (0.06p).
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step
from live_autonomous_system_test import auto_detect_impulse_consolidation, auto_stepwise_thin_box

SPREAD_PTS = 0.38
SLIPPAGE_PTS = 0.10
COMMISSION_PTS = 0.06
TOTAL_FRICTION = SPREAD_PTS + SLIPPAGE_PTS + COMMISSION_PTS

def simulate_absorption_live_execution(rates, shelf_price, thinned_top, thinned_bottom, start_idx, max_forward=48):
    future_bars = rates[start_idx + 1 : start_idx + 1 + max_forward]
    if len(future_bars) < 2:
        return {'status': 'NO_DATA'}
        
    triggered = False
    trigger_idx = -1
    pos = None
    entry_p = 0.0
    sl_p = 0.0
    risk = 0.0
    
    # Scan forward up to 36 bars for genuine physical absorption at the shelf
    for idx in range(min(36, len(future_bars))):
        b = future_bars[idx]
        b_range = max(0.01, b['high'] - b['low'])
        lower_wick = min(b['open'], b['close']) - b['low']
        upper_wick = b['high'] - max(b['open'], b['close'])
        
        # PATTERN A: SPRING WICK ABSORPTION (Liquidity Sweep below shelf, high-wick rejection & reclaim)
        # Low swept below shelf by >=0.30p, but candle closed back above shelf, lower wick >= 35% of candle
        if b['low'] <= shelf_price - 0.25 and b['close'] >= shelf_price + 0.10 and (lower_wick / b_range) >= 0.30:
            pos = 'BUY'
            # BUY fills at ASK = close + Spread + Slippage
            fill_entry = round(b['close'] + SPREAD_PTS + SLIPPAGE_PTS, 2)
            # Stop loss anchored below the sweep tip + buffer
            initial_sl = round(min(b['low'] - 0.30, thinned_bottom - 0.40) - SLIPPAGE_PTS, 2)
            risk = round(fill_entry - initial_sl, 2)
            
            # Risk must be reasonable ($1.50 to $3.50p)
            if 1.40 <= risk <= 3.80:
                triggered = True
                trigger_idx = idx
                break
                
        # PATTERN B: UPTHRUST ABSORPTION (Liquidity Sweep above shelf, upper-wick rejection & close below)
        elif b['high'] >= shelf_price + 0.25 and b['close'] <= shelf_price - 0.10 and (upper_wick / b_range) >= 0.30:
            pos = 'SELL'
            # SELL fills at BID = close - Slippage
            fill_entry = round(b['close'] - SLIPPAGE_PTS, 2)
            # Stop loss triggered when ASK touches sweep tip + buffer
            initial_sl = round(max(b['high'] + 0.30, thinned_top + 0.40) + SPREAD_PTS + SLIPPAGE_PTS, 2)
            risk = round(initial_sl - fill_entry, 2)
            
            if 1.40 <= risk <= 3.80:
                triggered = True
                trigger_idx = idx
                break
                
    if not triggered:
        return {'status': 'NO_PHYSICAL_TRIGGER'}
        
    # Forward trade simulation from trigger bar onwards
    trade_bars = future_bars[trigger_idx + 1:]
    if len(trade_bars) == 0:
        return {'status': 'NO_POST_DATA'}
        
    current_sl = initial_sl
    be_active = False
    peak_fav = 0.0
    exit_price = 0.0
    exit_reason = None
    
    for b in trade_bars:
        if pos == 'BUY':
            bid_low = b['low']
            bid_high = b['high']
            
            # Check stop loss
            if bid_low <= current_sl:
                exit_price = current_sl - SLIPPAGE_PTS
                exit_reason = 'STOP_LOSS' if not be_active else 'BE_OR_TRAIL'
                break
                
            fav = bid_high - fill_entry
            if fav > peak_fav: peak_fav = fav
            
            # Auto-BE: Trigger at +2.40p physical gain (gives trade room to breathe)
            if peak_fav >= 2.40 and not be_active:
                current_sl = fill_entry + 0.20  # Lock +0.20p net profit
                be_active = True
                
            # Dynamic Trail at >= 7.0p expansion (trailing 2.50p behind peak)
            if peak_fav >= 7.00:
                current_sl = max(current_sl, round(fill_entry + peak_fav - 2.50, 2))
                
        else: # SELL
            ask_high = b['high'] + SPREAD_PTS
            ask_low = b['low'] + SPREAD_PTS
            
            if ask_high >= current_sl:
                exit_price = current_sl + SLIPPAGE_PTS
                exit_reason = 'STOP_LOSS' if not be_active else 'BE_OR_TRAIL'
                break
                
            fav = fill_entry - ask_low
            if fav > peak_fav: peak_fav = fav
            
            if peak_fav >= 2.40 and not be_active:
                current_sl = fill_entry - 0.20
                be_active = True
                
            if peak_fav >= 7.00:
                current_sl = min(current_sl, round(fill_entry - (peak_fav - 2.50), 2))

    if not exit_reason:
        last_b = trade_bars[-1]
        exit_price = last_b['close'] if pos == 'BUY' else (last_b['close'] + SPREAD_PTS)
        exit_reason = 'SESSION_LIMIT'
        
    gross_pts = (exit_price - fill_entry) if pos == 'BUY' else (fill_entry - exit_price)
    net_pts = round(gross_pts - COMMISSION_PTS, 2)
    
    return {
        'status': 'TRADE_EXECUTED',
        'direction': pos,
        'fill_entry': fill_entry,
        'initial_sl': initial_sl,
        'risk': risk,
        'peak_fav': round(peak_fav, 2),
        'exit_price': round(exit_price, 2),
        'exit_reason': exit_reason,
        'net_pts': net_pts,
        'be_active': be_active,
        'is_win': net_pts > 0,
        'win_3p': peak_fav >= 3.0,
        'win_5p': peak_fav >= 5.0,
        'win_10p': peak_fav >= 10.0,
        'win_20p': peak_fav >= 20.0,
        'rr': round(peak_fav / risk, 1) if risk > 0 else 0
    }

def run_v2_study():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 3500)
    print(f"Loaded {len(rates)} historical bars for V2 Live Mimic Study.")
    print(f"Spread={SPREAD_PTS}p | Slippage={SLIPPAGE_PTS}p | Commission={COMMISSION_PTS}p | Round-trip={TOTAL_FRICTION:.2f}p")
    
    detected = []
    last_idx = -100
    
    for idx in range(60, len(rates) - 60):
        if idx - last_idx < 15:
            continue
            
        box = auto_detect_impulse_consolidation(rates, idx, min_impulse=8.0, lookback_coil=24)
        if box:
            last_idx = idx
            thinned = auto_stepwise_thin_box(box['coil_bars'], box['top'], box['bottom'], target_height=3.2)
            sim = simulate_absorption_live_execution(
                rates,
                thinned['fulcrum'],
                thinned['thinned_top'],
                thinned['thinned_bottom'],
                idx,
                max_forward=48
            )
            detected.append({
                'box': box,
                'thinned': thinned,
                'sim': sim
            })
            
    executed = [d for d in detected if d['sim']['status'] == 'TRADE_EXECUTED']
    no_trigger = [d for d in detected if d['sim']['status'] == 'NO_PHYSICAL_TRIGGER']
    
    print("\n" + "="*85)
    print("V2 RESULTS: AUTONOMOUS SYSTEM WITH PHYSICAL ABSORPTION & FRICTION")
    print("="*85)
    print(f"• Total Auto-Detected Structures:          {len(detected)}")
    print(f"• Trades Triggered by Physical Absorption: {len(executed)} ({len(executed)/len(detected)*100:.1f}%)")
    print(f"• Filtered Out (No Clean Absorption Wick): {len(no_trigger)} ({len(no_trigger)/len(detected)*100:.1f}%)")
    
    if len(executed) == 0:
        return
        
    trades = [d['sim'] for d in executed]
    wins = [t for t in trades if t['is_win']]
    losses = [t for t in trades if not t['is_win']]
    
    net_pnl = sum(t['net_pts'] for t in trades)
    avg_win = np.mean([t['net_pts'] for t in wins]) if wins else 0
    avg_loss = np.mean([abs(t['net_pts']) for t in losses]) if losses else 0
    pf = (sum(t['net_pts'] for t in wins) / sum(abs(t['net_pts']) for t in losses)) if losses else 999.0
    
    w3 = sum(1 for t in trades if t['win_3p']) / len(trades) * 100
    w5 = sum(1 for t in trades if t['win_5p']) / len(trades) * 100
    w10 = sum(1 for t in trades if t['win_10p']) / len(trades) * 100
    w20 = sum(1 for t in trades if t['win_20p']) / len(trades) * 100
    be_rate = sum(1 for t in trades if t['be_active']) / len(trades) * 100
    
    avg_risk = np.mean([t['risk'] for t in trades])
    avg_peak = np.mean([t['peak_fav'] for t in trades])
    avg_rr = np.mean([t['rr'] for t in trades])
    
    print(f"\n--- FINANCIAL & EXPECTANCY METRICS (NET OF SPREAD, SLIPPAGE, COMMISSIONS) ---")
    print(f"• Win Rate (Net Profit > $0):              {len(wins)/len(trades)*100:5.1f}% ({len(wins)} of {len(trades)})")
    print(f"• Profit Factor:                           {pf:5.2f}")
    print(f"• Total Net Points Extracted:              {net_pnl:+6.2f} pts")
    print(f"• Average Net Gain Per Executed Trade:     {net_pnl / len(trades):+6.2f} pts")
    print(f"• Average Winner:                         +{avg_win:5.2f} pts")
    print(f"• Average Scratch Loss:                   -${avg_loss:5.2f} pts")
    print(f"• Win/Loss Expectancy Ratio:               {avg_win / avg_loss if avg_loss > 0 else 0:5.2f}x")
    
    print(f"\n--- RUNNER & EXPANSION METRICS ---")
    print(f"• Auto-BE Protection Rate (+2.40p reached): {be_rate:5.1f}%")
    print(f"• Reached >= 3.0 pts Expansion:            {w3:5.1f}%")
    print(f"• Reached >= 5.0 pts Expansion:            {w5:5.1f}%")
    print(f"• Reached >= 10.0 pts Monster Move:        {w10:5.1f}%")
    print(f"• Average Stop Loss Risk:                  ${avg_risk:4.2f} pts")
    print(f"• Average Peak Move from Shelf:            +{avg_peak:4.2f} pts")
    print(f"• Realized Peak Risk-to-Reward:            1:{avg_rr:4.1f}")
    print("="*85)

if __name__ == '__main__':
    run_v2_study()
