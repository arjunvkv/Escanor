"""
COMPREHENSIVE PROBABILITY AUDIT:
SEQUENTIAL NODE-BY-NODE THINNING PATTERN & OUTCOMES
"""
import MetaTrader5 as mt5
import numpy as np
import random
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step

def evaluate_node_trade(shelf_price, box_top, box_bottom, forward_bars, max_lookahead=60):
    """
    Evaluates:
    1. Arrival at shelf (within 0.35p tolerance)
    2. Bounce & expansion from shelf
    3. Outcomes: Max Favorable Excursion (MFE), Max Adverse Drawdown (MAE),
       Win rates (>=3p, >=5p, >=10p, >=20p) before invalidation (breaching opposite box boundary).
    """
    if len(forward_bars) < 2:
        return None
        
    arrived = False
    arrival_idx = -1
    for idx in range(min(36, len(forward_bars))):
        b = forward_bars[idx]
        if b['low'] <= shelf_price + 0.30 and b['high'] >= shelf_price - 0.30:
            arrived = True
            arrival_idx = idx
            break
            
    if not arrived:
        return {'arrived': False}
        
    post_arrival = forward_bars[arrival_idx:]
    
    # Invalidation boundary:
    # If buying at shelf: SL is below box_bottom (or shelf - 1.80p)
    # If selling at shelf: SL is above box_top (or shelf + 1.80p)
    # We evaluate both sides to see the true expansion potential of the shelf
    
    # Long test
    long_sl = box_bottom - 0.25
    long_risk = max(0.60, shelf_price - long_sl)
    long_stopped = False
    long_mfe = 0.0
    long_mae = 0.0
    
    # Short test
    short_sl = box_top + 0.25
    short_risk = max(0.60, short_sl - shelf_price)
    short_stopped = False
    short_mfe = 0.0
    short_mae = 0.0
    
    for b in post_arrival:
        # Long
        if not long_stopped:
            if b['low'] <= long_sl:
                long_stopped = True
            else:
                fav = b['high'] - shelf_price
                if fav > long_mfe: long_mfe = fav
                adv = shelf_price - b['low']
                if adv > long_mae: long_mae = adv
                
        # Short
        if not short_stopped:
            if b['high'] >= short_sl:
                short_stopped = True
            else:
                fav = shelf_price - b['low']
                if fav > short_mfe: short_mfe = fav
                adv = b['high'] - shelf_price
                if adv > short_mae: short_mae = adv

    # Best outcome
    if long_mfe >= short_mfe:
        pos = 'BUY'
        mfe = long_mfe
        mae = long_mae
        risk = long_risk
        stopped = long_stopped
    else:
        pos = 'SELL'
        mfe = short_mfe
        mae = short_mae
        risk = short_risk
        stopped = short_stopped
        
    return {
        'arrived': True,
        'arrival_bars': arrival_idx,
        'direction': pos,
        'entry': shelf_price,
        'risk': round(risk, 2),
        'mfe': round(mfe, 2),
        'mae': round(mae, 2),
        'stopped': stopped,
        'win_3p': mfe >= 3.0 and not (stopped and mfe < 3.0),
        'win_5p': mfe >= 5.0 and not (stopped and mfe < 5.0),
        'win_10p': mfe >= 10.0 and not (stopped and mfe < 10.0),
        'win_20p': mfe >= 20.0 and not (stopped and mfe < 20.0),
        'rr': round(mfe / risk, 1) if risk > 0 else 0
    }

def run_comprehensive_audit():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 2500)
    
    boxes = []
    for i in range(100, len(rates) - 80, 20):
        win = rates[i:i+36]
        h = max(b['high'] for b in win)
        l = min(b['low'] for b in win)
        rng = h - l
        if 8.0 <= rng <= 28.0:
            boxes.append({
                'idx': i,
                'bars': win,
                'fwd': rates[i+36:i+36+60],
                'top': h,
                'bot': l,
                'range': rng
            })
            
    print(f"Total clean consolidation boxes extracted: {len(boxes)}")
    
    for mode in ['structure', 'random']:
        mode_label = "STRUCTURE-GUIDED THINNING" if mode == 'structure' else "RANDOM-PICK THINNING"
        print("\n" + "="*95)
        print(f"EVALUATION: {mode_label} (ONE NODE AT A TIME)")
        print("="*95)
        print(f"{'Step':<16} | {'Box Height':<11} | {'Scratch Risk':<12} | {'Arrival %':<10} | {'Win >=3p':<9} | {'Win >=5p':<9} | {'Win >=10p':<10} | {'Avg R:R':<8}")
        print("-" * 95)
        
        step_stats = {s: [] for s in range(5)}
        trials = 1 if mode == 'structure' else 10
        
        for b in boxes:
            bars = b['bars']
            fwd = b['fwd']
            
            for _ in range(trials):
                curr_top = b['top']
                curr_bot = b['bot']
                
                # Step 0: Raw
                r0 = compute_box_fulcrum_vacuum(bars, curr_top, curr_bot)
                if r0:
                    e0 = evaluate_node_trade(r0['fulcrum'], curr_top, curr_bot, fwd)
                    if e0:
                        step_stats[0].append({'height': curr_top - curr_bot, 'eval': e0})
                        
                for s in range(1, 5):
                    t_res = single_node_thinning_step(bars, curr_top, curr_bot, choice_strategy=mode)
                    if not t_res:
                        break
                    curr_top = t_res['new_top']
                    curr_bot = t_res['new_bottom']
                    
                    es = evaluate_node_trade(t_res['new_fulcrum'], curr_top, curr_bot, fwd)
                    if es:
                        step_stats[s].append({'height': t_res['height'], 'eval': es})
                        
                    if t_res['height'] <= 2.8:
                        break
                        
        for s in range(5):
            records = step_stats[s]
            n = len(records)
            if n == 0: continue
            avg_h = np.mean([r['height'] for r in records])
            arrived_recs = [r for r in records if r['eval']['arrived']]
            arr_pct = len(arrived_recs) / n * 100
            
            if len(arrived_recs) > 0:
                avg_risk = np.mean([r['eval']['risk'] for r in arrived_recs])
                w3 = sum(1 for r in arrived_recs if r['eval']['win_3p']) / len(arrived_recs) * 100
                w5 = sum(1 for r in arrived_recs if r['eval']['win_5p']) / len(arrived_recs) * 100
                w10 = sum(1 for r in arrived_recs if r['eval']['win_10p']) / len(arrived_recs) * 100
                avg_rr = np.mean([r['eval']['rr'] for r in arrived_recs])
            else:
                avg_risk = 0; w3 = 0; w5 = 0; w10 = 0; avg_rr = 0
                
            label = "Step 0 (Raw Box)" if s == 0 else f"Step {s} Thinned"
            print(f"{label:<16} | {avg_h:5.2f} pts   | ${avg_risk:4.2f} pts    | {arr_pct:5.1f}%    | {w3:5.1f}%   | {w5:5.1f}%   | {w10:5.1f}%    | 1:{avg_rr:4.1f}")
        print("="*95)

if __name__ == '__main__':
    run_comprehensive_audit()
