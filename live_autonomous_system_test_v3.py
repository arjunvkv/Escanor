"""
AUTONOMOUS LIVE MIMIC V3: SOLVING THE PREMATURE BE CHOKE TRAP
Replaces the tight BE choke with Institutional Runner Management:
1. Breakeven is NOT pulled to +0.20p on a tiny 2.4p wobble. Instead, at +3.0p MFE, SL is trailed to reduce risk to scratch (-0.80p).
2. Trailing only locks profit once real expansion begins (>=5.0p).
3. Evaluates with real MT5 friction: Spread 0.38p, Slippage 0.10p, Commission 0.06p.
"""

import MetaTrader5 as mt5
import numpy as np
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step
from live_autonomous_system_test import auto_detect_impulse_consolidation, auto_stepwise_thin_box

SPREAD_PTS = 0.38
SLIPPAGE_PTS = 0.10
COMMISSION_PTS = 0.06
TOTAL_FRICTION = SPREAD_PTS + SLIPPAGE_PTS + COMMISSION_PTS

def simulate_v3_execution(rates, shelf_price, thinned_top, thinned_bottom, start_idx, max_forward=60):
    future_bars = rates[start_idx + 1 : start_idx + 1 + max_forward]
    if len(future_bars) < 2:
        return {'status': 'NO_DATA'}
        
    triggered = False
    trigger_idx = -1
    pos = None
    entry_p = 0.0
    sl_p = 0.0
    risk = 0.0
    
    for idx in range(min(36, len(future_bars))):
        b = future_bars[idx]
        b_range = max(0.01, b['high'] - b['low'])
        lower_wick = min(b['open'], b['close']) - b['low']
        upper_wick = b['high'] - max(b['open'], b['close'])
        
        # Spring Wick: Sweeps below shelf, closes back above shelf, lower wick >= 30%
        if b['low'] <= shelf_price - 0.25 and b['close'] >= shelf_price + 0.10 and (lower_wick / b_range) >= 0.30:
            pos = 'BUY'
            fill_entry = round(b['close'] + SPREAD_PTS + SLIPPAGE_PTS, 2)
            initial_sl = round(min(b['low'] - 0.25, thinned_bottom - 0.35) - SLIPPAGE_PTS, 2)
            risk = round(fill_entry - initial_sl, 2)
            if 1.40 <= risk <= 3.80:
                triggered = True
                trigger_idx = idx
                break
                
        # Upthrust Wick: Sweeps above shelf, closes back below shelf, upper wick >= 30%
        elif b['high'] >= shelf_price + 0.25 and b['close'] <= shelf_price - 0.10 and (upper_wick / b_range) >= 0.30:
            pos = 'SELL'
            fill_entry = round(b['close'] - SLIPPAGE_PTS, 2)
            initial_sl = round(max(b['high'] + 0.25, thinned_top + 0.35) + SPREAD_PTS + SLIPPAGE_PTS, 2)
            risk = round(initial_sl - fill_entry, 2)
            if 1.40 <= risk <= 3.80:
                triggered = True
                trigger_idx = idx
                break
                
    if not triggered:
        return {'status': 'NO_PHYSICAL_TRIGGER'}
        
    trade_bars = future_bars[trigger_idx + 1:]
    if len(trade_bars) == 0:
        return {'status': 'NO_POST_DATA'}
        
    current_sl = initial_sl
    peak_fav = 0.0
    exit_price = 0.0
    exit_reason = None
    
    for b in trade_bars:
        if pos == 'BUY':
            bid_low = b['low']
            bid_high = b['high']
            
            if bid_low <= current_sl:
                exit_price = current_sl - SLIPPAGE_PTS
                exit_reason = 'STOP_LOSS'
                break
                
            fav = bid_high - fill_entry
            if fav > peak_fav: peak_fav = fav
            
            # Milestone 1: At +3.50p gain, tighten SL to cut risk in half (entry - 0.80p)
            if peak_fav >= 3.50 and current_sl < fill_entry - 0.80:
                current_sl = fill_entry - 0.80
                
            # Milestone 2: At +5.0p gain, move SL to TRUE Breakeven (+0.20p)
            if peak_fav >= 5.00 and current_sl < fill_entry + 0.20:
                current_sl = fill_entry + 0.20
                
            # Milestone 3: Dynamic Peak Trail at >= 8.0p expansion (trailing 3.50p behind peak)
            if peak_fav >= 8.00:
                current_sl = max(current_sl, round(fill_entry + peak_fav - 3.50, 2))
                
        else: # SELL
            ask_high = b['high'] + SPREAD_PTS
            ask_low = b['low'] + SPREAD_PTS
            
            if ask_high >= current_sl:
                exit_price = current_sl + SLIPPAGE_PTS
                exit_reason = 'STOP_LOSS'
                break
                
            fav = fill_entry - ask_low
            if fav > peak_fav: peak_fav = fav
            
            if peak_fav >= 3.50 and current_sl > fill_entry + 0.80:
                current_sl = fill_entry + 0.80
                
            if peak_fav >= 5.00 and current_sl > fill_entry - 0.20:
                current_sl = fill_entry - 0.20
                
            if peak_fav >= 8.00:
                current_sl = min(current_sl, round(fill_entry - (peak_fav - 3.50), 2))

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
        'is_win': net_pts > 0,
        'win_3p': peak_fav >= 3.0,
        'win_5p': peak_fav >= 5.0,
        'win_10p': peak_fav >= 10.0,
        'win_20p': peak_fav >= 20.0,
        'rr': round(peak_fav / risk, 1) if risk > 0 else 0
    }

def run_v3_study():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 4000)
    print(f"Loaded {len(rates)} historical bars for V3 Live Study.")
    print(f"Spread={SPREAD_PTS}p | Slippage={SLIPPAGE_PTS}p | Commission={COMMISSION_PTS}p | Friction={TOTAL_FRICTION:.2f}p")
    
    detected = []
    last_idx = -100
    
    for idx in range(60, len(rates) - 60):
        if idx - last_idx < 15:
            continue
            
        box = auto_detect_impulse_consolidation(rates, idx, min_impulse=8.0, lookback_coil=24)
        if box:
            last_idx = idx
            thinned = auto_stepwise_thin_box(box['coil_bars'], box['top'], box['bottom'], target_height=3.2)
            sim = simulate_v3_execution(
                rates,
                thinned['fulcrum'],
                thinned['thinned_top'],
                thinned['thinned_bottom'],
                idx,
                max_forward=60
            )
            detected.append({
                'box': box,
                'thinned': thinned,
                'sim': sim
            })
            
    executed = [d for d in detected if d['sim']['status'] == 'TRADE_EXECUTED']
    
    print("\n" + "="*85)
    print("V3 RESULTS: AUTONOMOUS LIVE MIMIC (WITH BREATHING ROOM RUNNER TRAIL)")
    print("="*85)
    print(f"• Total Auto-Detected Structures:          {len(detected)}")
    print(f"• Trades Fully Triggered & Executed:       {len(executed)}")
    
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
    
    avg_risk = np.mean([t['risk'] for t in trades])
    avg_peak = np.mean([t['peak_fav'] for t in trades])
    avg_rr = np.mean([t['rr'] for t in trades])
    
    print(f"\n--- FINANCIAL PERFORMANCE (NET OF ALL BROKER SPREAD & SLIPPAGE) ---")
    print(f"• Win Rate:                                {len(wins)/len(trades)*100:5.1f}% ({len(wins)} of {len(trades)})")
    print(f"• Profit Factor:                           {pf:5.2f}")
    print(f"• Total Net Points Extracted:              {net_pnl:+6.2f} pts")
    print(f"• Average Winner:                         +{avg_win:5.2f} pts (Runner captured!)")
    print(f"• Average Scratch Loss:                   -${avg_loss:5.2f} pts")
    print(f"• Win/Loss Expectancy Ratio:               {avg_win / avg_loss if avg_loss > 0 else 0:5.2f}x")
    
    print(f"\n--- RUNNER EXPANSION STATS ---")
    print(f"• Reached >= 3.0 pts Expansion:            {w3:5.1f}%")
    print(f"• Reached >= 5.0 pts Expansion:            {w5:5.1f}%")
    print(f"• Reached >= 10.0 pts Monster Move:        {w10:5.1f}%")
    print(f"• Reached >= 20.0 pts Mega Trend:          {w20:5.1f}%")
    print(f"• Average Stop Loss Risk:                  ${avg_risk:4.2f} pts")
    print(f"• Average Peak Move from Shelf:            +{avg_peak:4.2f} pts")
    print(f"• Peak Risk-to-Reward:                     1:{avg_rr:4.1f}")
    print("="*85)

if __name__ == '__main__':
    run_v3_study()
