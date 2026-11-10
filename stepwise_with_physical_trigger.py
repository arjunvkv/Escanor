"""
STEP-BY-STEP THINNING WITH TICKER TRUE PHYSICAL ABSORPTION TRIGGER & TRAILING
Simulates thinning one node at a time, recalculating at each step, and when price arrives
at the recalculated shelf, applies the EXACT Physical Trail Ticker Logic:
- Pattern 3: Absorption Sweep & Reclaim (Spring Wick sweeps past level by >=0.40p then reclaims)
- Pattern 1: Pinpoint touch rejection
- Auto-BE at +1.80p
- Peak Trail at +8.50p
"""

import MetaTrader5 as mt5
import numpy as np
import random
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step

def simulate_physical_ticker_trade(shelf_price, box_top, box_bottom, trade_bars):
    """
    Simulates the exact logic from live_strategy_engine.js:
    - Waits for touch or sweep past shelf_price
    - Checks for absorption reclaim / displacement away
    - Executes with scratch SL (<=1.80p risk)
    - Applies Auto-BE (+0.10p lock at +1.80p MFE) and dynamic peak trail
    """
    if len(trade_bars) < 2:
        return None
        
    triggered = False
    pos = None
    entry_p = 0.0
    sl_p = 0.0
    risk = 0.0
    trigger_bar_idx = -1
    
    # 1. Search for arrival & live physical trigger across first 36 bars (3 hours)
    for idx in range(min(36, len(trade_bars))):
        b = trade_bars[idx]
        
        # Test BUY (Absorption of sweep below shelf or bounce off shelf)
        if b['low'] <= shelf_price - 0.30 and b['close'] >= shelf_price + 0.15:
            # Sovereign Absorption Sweep & Reclaim (Spring Wick)
            pos = 'BUY'
            entry_p = b['close']
            sl_p = max(entry_p - 1.80, min(b['low'] - 0.20, box_bottom - 0.20))
            risk = entry_p - sl_p
            if 0.40 <= risk <= 1.80:
                triggered = True
                trigger_bar_idx = idx
                break
                
        # Test SELL (Absorption of sweep above shelf or rejection off shelf)
        elif b['high'] >= shelf_price + 0.30 and b['close'] <= shelf_price - 0.15:
            # Upthrust sweep & reclaim
            pos = 'SELL'
            entry_p = b['close']
            sl_p = min(entry_p + 1.80, max(b['high'] + 0.20, box_top + 0.20))
            risk = sl_p - entry_p
            if 0.40 <= risk <= 1.80:
                triggered = True
                trigger_bar_idx = idx
                break
                
        # Clean Pinpoint Touch & Bounce
        elif abs(b['low'] - shelf_price) <= 0.30 and b['close'] >= shelf_price + 0.35:
            pos = 'BUY'
            entry_p = b['close']
            sl_p = max(entry_p - 1.60, box_bottom - 0.25)
            risk = entry_p - sl_p
            if 0.40 <= risk <= 1.60:
                triggered = True
                trigger_bar_idx = idx
                break
        elif abs(b['high'] - shelf_price) <= 0.30 and b['close'] <= shelf_price - 0.35:
            pos = 'SELL'
            entry_p = b['close']
            sl_p = min(entry_p + 1.60, box_top + 0.25)
            risk = sl_p - entry_p
            if 0.40 <= risk <= 1.60:
                triggered = True
                trigger_bar_idx = idx
                break


    if not triggered:
        return {'triggered': False}
        
    # 2. Simulate Physical Trail Trailing Engine on remaining bars
    forward = trade_bars[trigger_bar_idx:]
    be_active = False
    current_sl = sl_p
    peak_fav = 0.0
    exit_price = 0.0
    exit_reason = None
    
    for b in forward:
        if pos == 'BUY':
            # Check Stop Loss hit
            if b['low'] <= current_sl:
                exit_price = current_sl
                exit_reason = 'STOP_LOSS' if not be_active else 'BE_OR_TRAIL'
                break
            fav = b['high'] - entry_p
            if fav > peak_fav: peak_fav = fav
            
            # Milestone 0: BE Lock (+0.10p) at +1.80p physical displacement
            if peak_fav >= 1.80 and not be_active:
                current_sl = max(current_sl, entry_p + 0.10)
                be_active = True
                
            # Milestone 1: Lock +1.80p at +3.20p MFE
            if peak_fav >= 3.20:
                current_sl = max(current_sl, entry_p + 1.80)
                
            # Milestone 3: Peak Trail 3.00p behind peak at >= 8.50p
            if peak_fav >= 8.50:
                current_sl = max(current_sl, peak_fav - 3.00 + entry_p)
                
        else: # SELL
            if b['high'] >= current_sl:
                exit_price = current_sl
                exit_reason = 'STOP_LOSS' if not be_active else 'BE_OR_TRAIL'
                break
            fav = entry_p - b['low']
            if fav > peak_fav: peak_fav = fav
            
            if peak_fav >= 1.80 and not be_active:
                current_sl = min(current_sl, entry_p - 0.10)
                be_active = True
                
            if peak_fav >= 3.20:
                current_sl = min(current_sl, entry_p - 1.80)
                
            if peak_fav >= 8.50:
                current_sl = min(current_sl, entry_p - (peak_fav - 3.00))

    if not exit_reason:
        # Mark to market at end of session
        exit_price = forward[-1]['close']
        exit_reason = 'SESSION_END'
        
    realized_pts = (exit_price - entry_p) if pos == 'BUY' else (entry_p - exit_price)
    
    return {
        'triggered': True,
        'direction': pos,
        'entry': round(entry_p, 2),
        'initial_sl': round(sl_p, 2),
        'risk': round(risk, 2),
        'peak_fav': round(peak_fav, 2),
        'realized_pts': round(realized_pts, 2),
        'be_achieved': be_active,
        'win_3p': peak_fav >= 3.0,
        'win_5p': peak_fav >= 5.0,
        'win_10p': peak_fav >= 10.0,
        'win_20p': peak_fav >= 20.0,
        'clean_scratch_loss': realized_pts < 0 and abs(realized_pts) <= risk,
        'realized_rr': round(peak_fav / risk, 1) if risk > 0 else 0
    }

def run_stepwise_physical_trigger_audit():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 2000)
    
    boxes = []
    for i in range(80, len(rates) - 70, 20):
        win = rates[i:i+36]
        h = max(b['high'] for b in win)
        l = min(b['low'] for b in win)
        rng = h - l
        if 8.0 <= rng <= 26.0:
            boxes.append({
                'idx': i,
                'bars': win,
                'fwd': rates[i+36:i+36+60],
                'top': h,
                'bot': l,
                'range': rng
            })

            
    print(f"Total consolidation boxes loaded: {len(boxes)}")
    
    # Track metrics for Step 0, Step 1, Step 2, Step 3, Step 4
    step_results = {s: [] for s in range(5)}
    
    for b in boxes:
        bars = b['bars']
        fwd = b['fwd']
        
        curr_top = b['top']
        curr_bot = b['bot']
        
        # Step 0: Raw initial box
        raw_res = compute_box_fulcrum_vacuum(bars, curr_top, curr_bot)
        if raw_res:
            res_0 = simulate_physical_ticker_trade(raw_res['fulcrum'], curr_top, curr_bot, fwd)
            if res_0 and res_0['triggered']:
                step_results[0].append(res_0)
                
        # Thin step by step
        for step_num in range(1, 5):
            thin_res = single_node_thinning_step(bars, curr_top, curr_bot, choice_strategy='structure')
            if not thin_res:
                break
            curr_top = thin_res['new_top']
            curr_bot = thin_res['new_bottom']
            
            res_s = simulate_physical_ticker_trade(thin_res['new_fulcrum'], curr_top, curr_bot, fwd)
            if res_s and res_s['triggered']:
                step_results[step_num].append(res_s)
                
            if thin_res['height'] <= 2.8:
                break
                
    print("\n" + "="*95)
    print("STEP-BY-STEP PROGRESSION WITH TICKER TRUE PHYSICAL TRAIL TRIGGER & TRAILING")
    print("="*95)
    print(f"{'Step':<16} | {'Triggered':<10} | {'Avg Risk':<9} | {'BE Active %':<11} | {'Win >=5p':<9} | {'Win >=10p':<10} | {'Avg Peak':<10} | {'Avg R:R':<8}")
    print("-" * 95)
    
    for s in range(5):
        data = step_results[s]
        n = len(data)
        if n == 0: continue
        avg_risk = np.mean([d['risk'] for d in data])
        be_pct = sum(1 for d in data if d['be_achieved']) / n * 100
        w5 = sum(1 for d in data if d['win_5p']) / n * 100
        w10 = sum(1 for d in data if d['win_10p']) / n * 100
        avg_peak = np.mean([d['peak_fav'] for d in data])
        avg_rr = np.mean([d['realized_rr'] for d in data])
        
        label = "Step 0 (Raw Box)" if s == 0 else f"Step {s} Thinned"
        print(f"{label:<16} | {n:<10} | {avg_risk:4.2f} pts  | {be_pct:5.1f}%     | {w5:5.1f}%   | {w10:5.1f}%    | +{avg_peak:4.2f} pts   | 1:{avg_rr:4.1f}")
    print("="*95)

if __name__ == '__main__':
    run_stepwise_physical_trigger_audit()
