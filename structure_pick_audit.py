"""
AUDIT: INITIAL STRUCTURE CLASSIFICATION & WIN RATE PROFILING
Tests the Best Probable Setup (Stepwise Node Thinning -> Scratch Box -> Physical Shelf Entry -> Trailing)
across multiple distinct market structure types to determine EXACTLY which initial structure picks win.
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
import random
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step

def classify_structure(bars, prior_bars):
    """
    Classifies the market structure of the picked consolidation box:
    1. Session: Asian, London, NY, Late NY
    2. Range Class: Micro (6-10p), Medium (10-18p), Wide (18-30p)
    3. Duration: Quick (12-24 bars), Medium (25-45 bars), Extended (46-70 bars)
    4. Market Context:
       - Trend Continuation (prior 24 bars had strong trend > 8p)
       - Swing Reversal Base (box formed at extreme of prior 48-bar swing)
       - Equilibrium Chop (low momentum prior bars)
    """
    highs = [b['high'] for b in bars]
    lows = [b['low'] for b in bars]
    box_h = max(highs)
    box_l = min(lows)
    box_range = box_h - box_l
    num_bars = len(bars)
    
    # Session from start bar time
    start_dt = datetime.datetime.fromtimestamp(bars[0]['time'], datetime.timezone.utc)
    hour = start_dt.hour
    if 0 <= hour < 6:
        session = 'ASIAN_SESSION'
    elif 6 <= hour < 12:
        session = 'LONDON_MORNING'
    elif 12 <= hour < 18:
        session = 'NY_CORE_OVERLAP'
    else:
        session = 'LATE_NY_EVE'
        
    # Range Class
    if box_range < 10.0:
        range_class = 'MICRO_RANGE (6-10p)'
    elif box_range < 18.0:
        range_class = 'MEDIUM_RANGE (10-18p)'
    else:
        range_class = 'WIDE_MACRO_RANGE (18-30p)'
        
    # Duration Class
    if num_bars <= 24:
        duration_class = 'QUICK_BASE (1-2h)'
    elif num_bars <= 45:
        duration_class = 'STANDARD_BASE (2-4h)'
    else:
        duration_class = 'EXTENDED_ACCUMULATION (4-6h+)'
        
    # Context Class from prior bars
    context_class = 'EQUILIBRIUM_CHOP'
    if len(prior_bars) >= 20:
        p_closes = [b['close'] for b in prior_bars]
        prior_move = p_closes[-1] - p_closes[0]
        if abs(prior_move) >= 8.0:
            context_class = 'BULL_TREND_FLAG' if prior_move > 0 else 'BEAR_TREND_FLAG'
        else:
            p_highs = [b['high'] for b in prior_bars]
            p_lows = [b['low'] for b in prior_bars]
            if box_l <= min(p_lows) + 1.0:
                context_class = 'SWING_LOW_REVERSAL_BASE'
            elif box_h >= max(p_highs) - 1.0:
                context_class = 'SWING_HIGH_REVERSAL_BASE'
                
    return {
        'session': session,
        'range_class': range_class,
        'duration_class': duration_class,
        'context_class': context_class,
        'box_range': round(box_range, 2),
        'num_bars': num_bars,
        'start_time': start_dt.strftime('%Y-%m-%d %H:%M')
    }

def run_best_probable_setup(bars, top_price, bottom_price, forward_bars):
    """
    Runs the exact Best Probable Setup:
    1. Stepwise Structure-Guided Thinning down to scratch corridor (height <= 3.2p)
    2. Recalculates Fulcrum Retest Axis
    3. Evaluates price arrival at the thinned shelf
    4. Evaluates breakout / expansion with SL anchored to scratch boundary
    """
    curr_top = top_price
    curr_bottom = bottom_price
    
    # Run up to 4 node-thinning steps
    final_fulcrum = (top_price + bottom_price) / 2.0
    for s in range(4):
        res = single_node_thinning_step(bars, curr_top, curr_bottom, choice_strategy='structure')
        if not res:
            break
        curr_top = res['new_top']
        curr_bottom = res['new_bottom']
        final_fulcrum = res['new_fulcrum']
        if res['height'] <= 3.2:
            break
            
    thinned_height = curr_top - curr_bottom
    shelf_price = final_fulcrum
    
    # Look for arrival within 36 bars
    arrived = False
    arr_idx = -1
    for idx in range(min(36, len(forward_bars))):
        b = forward_bars[idx]
        if b['low'] <= shelf_price + 0.30 and b['high'] >= shelf_price - 0.30:
            arrived = True
            arr_idx = idx
            break
            
    if not arrived:
        return {'arrived': False, 'thinned_height': thinned_height}
        
    post = forward_bars[arr_idx:]
    if len(post) < 2:
        return {'arrived': False, 'thinned_height': thinned_height}
        
    # Long from shelf with scratch SL below curr_bottom
    long_sl = curr_bottom - 0.25
    long_risk = max(0.50, shelf_price - long_sl)
    long_stopped = False
    long_mfe = 0.0
    
    # Short from shelf with scratch SL above curr_top
    short_sl = curr_top + 0.25
    short_risk = max(0.50, short_sl - shelf_price)
    short_stopped = False
    short_mfe = 0.0
    
    for b in post:
        if not long_stopped:
            if b['low'] <= long_sl:
                long_stopped = True
            else:
                fav = b['high'] - shelf_price
                if fav > long_mfe: long_mfe = fav
                
        if not short_stopped:
            if b['high'] >= short_sl:
                short_stopped = True
            else:
                fav = shelf_price - b['low']
                if fav > short_mfe: short_mfe = fav
                
    if long_mfe >= short_mfe:
        mfe = long_mfe
        risk = long_risk
        stopped = long_stopped
        dir = 'BUY'
    else:
        mfe = short_mfe
        risk = short_risk
        stopped = short_stopped
        dir = 'SELL'
        
    return {
        'arrived': True,
        'thinned_height': round(thinned_height, 2),
        'direction': dir,
        'risk': round(risk, 2),
        'mfe': round(mfe, 2),
        'stopped': stopped,
        'win_3p': mfe >= 3.0 and not (stopped and mfe < 3.0),
        'win_5p': mfe >= 5.0 and not (stopped and mfe < 5.0),
        'win_10p': mfe >= 10.0 and not (stopped and mfe < 10.0),
        'win_20p': mfe >= 20.0 and not (stopped and mfe < 20.0),
        'rr': round(mfe / risk, 1) if risk > 0 else 0
    }

def run_structure_audit():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 3000)
    print(f"Loaded {len(rates)} historical M5 bars.")
    
    # Extract candidate structures with varied durations (18 to 60 bars)
    samples = []
    for bar_len in [20, 32, 48]:
        for i in range(120, len(rates) - 75, 16):
            win = rates[i:i+bar_len]
            prior = rates[i-30:i]
            fwd = rates[i+bar_len:i+bar_len+60]
            h = max(b['high'] for b in win)
            l = min(b['low'] for b in win)
            rng = h - l
            if 6.0 <= rng <= 30.0:
                struct_meta = classify_structure(win, prior)
                sim_res = run_best_probable_setup(win, h, l, fwd)
                if sim_res:
                    samples.append({
                        'meta': struct_meta,
                        'res': sim_res
                    })
                    
    print(f"Total structured boxes evaluated: {len(samples)}")
    
    def analyze_by_category(category_key, category_title):
        groups = {}
        for s in samples:
            k = s['meta'][category_key]
            if k not in groups: groups[k] = []
            groups[k].append(s['res'])
            
        print("\n" + "="*95)
        print(f"WIN RATE PROFILING BY: {category_title.upper()}")
        print("="*95)
        print(f"{'Structure Type':<30} | {'Count':<6} | {'Arrival %':<10} | {'Win >=5p':<10} | {'Win >=10p':<10} | {'Avg Risk':<9} | {'Avg R:R':<8}")
        print("-" * 95)
        
        # Sort by Win >= 10p descending
        sorted_groups = []
        for k, res_list in groups.items():
            n = len(res_list)
            arr = [r for r in res_list if r['arrived']]
            arr_pct = len(arr) / n * 100 if n > 0 else 0
            if len(arr) > 0:
                w5 = sum(1 for r in arr if r['win_5p']) / len(arr) * 100
                w10 = sum(1 for r in arr if r['win_10p']) / len(arr) * 100
                avg_risk = np.mean([r['risk'] for r in arr])
                avg_rr = np.mean([r['rr'] for r in arr])
            else:
                w5 = 0; w10 = 0; avg_risk = 0; avg_rr = 0
            sorted_groups.append((k, n, arr_pct, w5, w10, avg_risk, avg_rr))
            
        sorted_groups.sort(key=lambda x: (x[4], x[3]), reverse=True)
        for k, n, arr_pct, w5, w10, avg_risk, avg_rr in sorted_groups:
            print(f"{k:<30} | {n:<6} | {arr_pct:5.1f}%    | {w5:5.1f}%    | {w10:5.1f}%     | ${avg_risk:4.2f} pts  | 1:{avg_rr:4.1f}")
        print("="*95)
        return sorted_groups

    # Profile across 4 key dimensions
    analyze_by_category('context_class', 'Market Structural Context')
    analyze_by_category('session', 'Session / Time of Day')
    analyze_by_category('range_class', 'Initial Box Range Width')
    analyze_by_category('duration_class', 'Consolidation Bar Duration')

if __name__ == '__main__':
    run_structure_audit()
