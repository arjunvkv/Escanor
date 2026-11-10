"""
AUDIT RECURSIVE BOX SUBTRACTION & CONVERGENCE VS RANDOM PICK PROBABILITY CHECK
Evaluates the Sovereign Retest Fulcrum & Zero-Interest Vacuum Box Subtraction Algorithm
across real historical MT5 XAUUSD data.
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
import random

def compute_box_fulcrum_vacuum(bars, top_price, bottom_price):
    """
    Exact replica of tv_chart_engine.js: computeBoxFulcrumAndVacuum
    """
    price_range = top_price - bottom_price
    if price_range <= 0.05 or len(bars) < 2:
        return None
    
    num_steps = min(80, max(30, int(round(price_range / 0.10))))
    step = price_range / num_steps
    tol = max(0.08, step * 1.15)
    
    candle_props = []
    for b in bars:
        b_open, b_high, b_low, b_close = b['open'], b['high'], b['low'], b['close']
        vol = b['tick_volume'] if 'tick_volume' in b.dtype.names else 1
        body_top = max(b_open, b_close)
        body_bottom = min(b_open, b_close)
        body_size = body_top - body_bottom
        full_range = max(0.01, b_high - b_low)
        candle_props.append({
            'high': b_high, 'low': b_low, 'open': b_open, 'close': b_close,
            'body_top': body_top, 'body_bottom': body_bottom,
            'body_size': body_size, 'full_range': full_range, 'vol': vol
        })
        
    best_fulcrum_price = (top_price + bottom_price) / 2.0
    max_fulcrum_score = -1.0
    best_details = {'retests': 0, 'flips': 0, 'launchpads': 0}
    
    min_vacuum_vol = float('inf')
    best_vacuum_price = (top_price + bottom_price) / 2.0
    
    for s in range(num_steps + 1):
        p = bottom_price + s * step
        fulcrum_score = 0.0
        retests = 0
        upper_rejections = 0
        lower_rejections = 0
        launchpads = 0
        dwell_vol = 0.0
        crossing_bodies = 0
        
        for c in candle_props:
            if abs(c['high'] - p) <= tol and c['body_top'] < p - 0.04:
                fulcrum_score += 3.5
                upper_rejections += 1
                retests += 1
            if abs(c['low'] - p) <= tol and c['body_bottom'] > p + 0.04:
                fulcrum_score += 3.5
                lower_rejections += 1
                retests += 1
            if abs(c['open'] - p) <= tol and c['body_size'] >= 0.80:
                fulcrum_score += 3.0
                launchpads += 1
            if abs(c['open'] - p) <= tol * 0.7 or abs(c['close'] - p) <= tol * 0.7:
                fulcrum_score += 1.5
                
            if c['low'] <= p <= c['high']:
                fraction = 1.0 / max(1.0, round(c['full_range'] / step))
                dwell_vol += c['vol'] * fraction
                if c['body_bottom'] <= p <= c['body_top'] and c['body_size'] >= 0.80:
                    crossing_bodies += 1
                    
        flips = min(upper_rejections, lower_rejections)
        fulcrum_score += flips * 5.0
        
        if fulcrum_score > max_fulcrum_score:
            max_fulcrum_score = fulcrum_score
            best_fulcrum_price = p
            best_details = {'retests': retests, 'flips': flips, 'launchpads': launchpads, 'score': fulcrum_score}
            
        rel_pos = (p - bottom_price) / price_range
        if 0.12 <= rel_pos <= 0.88:
            adj_dwell = dwell_vol / max(1.0, crossing_bodies * 2.5)
            if adj_dwell < min_vacuum_vol:
                min_vacuum_vol = adj_dwell
                best_vacuum_price = p
                
    if abs(best_vacuum_price - best_fulcrum_price) < 0.40:
        if best_fulcrum_price - bottom_price > top_price - best_fulcrum_price:
            best_vacuum_price = max(bottom_price + 0.25, best_fulcrum_price - price_range * 0.38)
        else:
            best_vacuum_price = min(top_price - 0.25, best_fulcrum_price + price_range * 0.38)
            
    return {
        'fulcrum': round(best_fulcrum_price, 2),
        'vacuum': round(best_vacuum_price, 2),
        'retests': best_details['retests'],
        'flips': best_details['flips'],
        'score': max_fulcrum_score,
        'top': top_price,
        'bottom': bottom_price
    }

def recursive_box_subtraction(bars, top_price, bottom_price, min_height=2.5, max_iters=5):
    """
    Subtracted box algorithm:
    Iteratively shrinks the box boundaries to eat up outer noise / voids towards
    the active fulcrum / vacuum points until height reaches an affordable scratch.
    """
    curr_top = top_price
    curr_bottom = bottom_price
    history = []
    
    for iteration in range(max_iters):
        res = compute_box_fulcrum_vacuum(bars, curr_top, curr_bottom)
        if not res:
            break
        f = res['fulcrum']
        v = res['vacuum']
        height = curr_top - curr_bottom
        history.append({
            'iteration': iteration + 1,
            'top': curr_top,
            'bottom': curr_bottom,
            'height': height,
            'fulcrum': f,
            'vacuum': v,
            'retests': res['retests'],
            'score': res['score']
        })
        
        if height <= min_height:
            break
            
        # Determine which outer boundary has dead space / vacuum to subtract
        upper_level = max(f, v)
        lower_level = min(f, v)
        
        # Eat up space above upper level and below lower level
        new_top = min(curr_top, upper_level + max(0.8, (curr_top - upper_level) * 0.4))
        new_bottom = max(curr_bottom, lower_level - max(0.8, (lower_level - curr_bottom) * 0.4))
        
        if (new_top - new_bottom) >= height * 0.95 or (new_top - new_bottom) < 1.0:
            # Force tighter convergence if step was too small
            new_top = curr_top - (curr_top - upper_level) * 0.6
            new_bottom = curr_bottom + (lower_level - curr_bottom) * 0.6
            
        if (new_top - new_bottom) <= 0.8:
            break
            
        curr_top = round(new_top, 2)
        curr_bottom = round(new_bottom, 2)
        
    return history

def simulate_trade_from_shelf(entry_price, sl_price, forward_bars, max_lookforward=36):
    """
    Simulates entering at the magnetic shelf after the box formation.
    Direction is inferred by the first breakout out of the shelf or absorption.
    Tests both Long and Short:
    - Long: Entry at entry_price, SL at sl_price (below entry)
    - Short: Entry at entry_price, SL at (entry_price + (entry_price - sl_price))
    Returns the maximum favorable move, maximum adverse drawdown, and whether it won big (>=5p, >=10p, >=20p)
    before hitting SL.
    """
    sl_dist = abs(entry_price - sl_price)
    if sl_dist <= 0.1:
        sl_dist = 1.0
        
    # Long trade
    long_sl = entry_price - sl_dist
    long_max_fav = 0.0
    long_max_adv = 0.0
    long_stopped = False
    
    # Short trade
    short_sl = entry_price + sl_dist
    short_max_fav = 0.0
    short_max_adv = 0.0
    short_stopped = False
    
    lookahead = forward_bars[:max_lookforward]
    if len(lookahead) == 0:
        return None
        
    for b in lookahead:
        # Check Long
        if not long_stopped:
            if b['low'] <= long_sl:
                long_stopped = True
            else:
                fav = b['high'] - entry_price
                if fav > long_max_fav:
                    long_max_fav = fav
                adv = entry_price - b['low']
                if adv > long_max_adv:
                    long_max_adv = adv
                    
        # Check Short
        if not short_stopped:
            if b['high'] >= short_sl:
                short_stopped = True
            else:
                fav = entry_price - b['low']
                if fav > short_max_fav:
                    short_max_fav = fav
                adv = b['high'] - entry_price
                if adv > short_max_adv:
                    short_max_adv = adv

    # Best direction outcome
    if long_max_fav >= short_max_fav:
        best_dir = 'BUY'
        max_fav = long_max_fav
        max_adv = long_max_adv
        stopped = long_stopped
    else:
        best_dir = 'SELL'
        max_fav = short_max_fav
        max_adv = short_max_adv
        stopped = short_stopped
        
    return {
        'direction': best_dir,
        'entry': entry_price,
        'sl_dist': sl_dist,
        'max_fav': max_fav,
        'max_adv': max_adv,
        'stopped': stopped,
        'win_3p': (max_fav >= 3.0) and not (stopped and max_fav < 3.0),
        'win_5p': (max_fav >= 5.0) and not (stopped and max_fav < 5.0),
        'win_10p': (max_fav >= 10.0) and not (stopped and max_fav < 10.0),
        'win_20p': (max_fav >= 20.0) and not (stopped and max_fav < 20.0),
        'rr': max_fav / sl_dist if sl_dist > 0 else 0
    }

def run_empirical_study():
    if not mt5.initialize():
        print("MT5 initialization failed!")
        return
        
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 1500)
    print(f"Total historical bars loaded: {len(rates)}")
    
    # -------------------------------------------------------------------------
    # PART 1: THE EXACT CASE FROM THE USER'S TEST (Nov 3, 2026)
    # -------------------------------------------------------------------------
    print("\n" + "="*80)
    print("PART 1: EXACT CASE STUDY ON USER'S NOV 3, 2026 BOX")
    print("="*80)
    
    # Box bars: 895 to 931, forward bars: 931 to 970
    box_bars = rates[895:931]
    forward_bars = rates[931:970]
    
    initial_top = 3919.24
    initial_bottom = 3892.74
    
    subtraction_steps = recursive_box_subtraction(box_bars, initial_top, initial_bottom, min_height=3.0, max_iters=5)
    
    print(f"{'Step':<6} | {'Box Top':<10} | {'Box Bottom':<10} | {'Height':<8} | {'Fulcrum':<10} | {'Vacuum':<10} | {'Retests':<8}")
    print("-" * 75)
    for step in subtraction_steps:
        print(f"#{step['iteration']:<5} | ${step['top']:<9.2f} | ${step['bottom']:<9.2f} | {step['height']:<7.2f}p | ${step['fulcrum']:<9.2f} | ${step['vacuum']:<9.2f} | {step['retests']}x")
        
    # Evaluate Trade on Initial Wide Box vs Subtracted Box
    wide_entry = subtraction_steps[0]['fulcrum']
    wide_sl = subtraction_steps[0]['bottom'] - 0.50
    wide_sim = simulate_trade_from_shelf(wide_entry, wide_sl, forward_bars)
    
    final_step = subtraction_steps[-1]
    conv_entry = final_step['fulcrum']
    conv_sl = final_step['bottom'] - 0.50
    conv_sim = simulate_trade_from_shelf(conv_entry, conv_sl, forward_bars)
    
    print("\n--- RESULTS ON USER'S TEST BOX ---")
    print(f"Initial Wide Box: Entry ${wide_entry:.2f}, SL ${wide_sl:.2f} (Risk: {wide_sim['sl_dist']:.2f}p)")
    print(f"  -> Max Favorable Expansion: +{wide_sim['max_fav']:.2f}p | Max Drawdown: {wide_sim['max_adv']:.2f}p | Realized R:R: 1:{wide_sim['rr']:.1f}")
    
    print(f"\nFinal Subtracted Box: Entry ${conv_entry:.2f}, SL ${conv_sl:.2f} (Affordable Scratch Risk: {conv_sim['sl_dist']:.2f}p)")
    print(f"  -> Max Favorable Expansion: +{conv_sim['max_fav']:.2f}p | Max Drawdown: {conv_sim['max_adv']:.2f}p | Realized R:R: 1:{conv_sim['rr']:.1f}")
    
    # -------------------------------------------------------------------------
    # PART 2: STATISTICAL PROBABILITY CHECK ACROSS MULTIPLE HISTORICAL BOXES
    # Systematic Recursive Subtraction vs Random Pick of Fulcrum/Vacuum
    # -------------------------------------------------------------------------
    print("\n" + "="*80)
    print("PART 2: EMPIRICAL PROBABILITY CHECK (RECURSIVE SUBTRACTION VS RANDOM PICK)")
    print("="*80)
    
    # Detect consolidation boxes: 24 to 48 bars where range is between 6.0p and 25.0p
    box_samples = []
    step_size = 18
    for i in range(50, len(rates) - 60, step_size):
        window = rates[i:i+36]
        w_high = max(b['high'] for b in window)
        w_low = min(b['low'] for b in window)
        w_range = w_high - w_low
        if 6.0 <= w_range <= 26.0:
            forward = rates[i+36:i+36+48]
            box_samples.append({
                'start_idx': i,
                'bars': window,
                'forward': forward,
                'top': w_high,
                'bottom': w_low,
                'range': w_range
            })
            
    print(f"Total Valid Consolidation Boxes Identified: {len(box_samples)}")
    
    # Metrics containers
    rec_results = []
    rand_results = []
    wide_results = []
    
    random.seed(42)
    
    for sample in box_samples:
        bars = sample['bars']
        fwd = sample['forward']
        top = sample['top']
        bot = sample['bottom']
        
        # 1. Wide Box Baseline
        w_res = compute_box_fulcrum_vacuum(bars, top, bot)
        if w_res:
            entry = w_res['fulcrum']
            sl = bot - 0.50
            sim = simulate_trade_from_shelf(entry, sl, fwd)
            if sim:
                wide_results.append(sim)
                
        # 2. Systematic Recursive Subtraction to Affordable Scratch
        sub_history = recursive_box_subtraction(bars, top, bot, min_height=2.8, max_iters=4)
        if sub_history:
            final = sub_history[-1]
            entry = final['fulcrum']
            # Scratch stop loss anchored right below reduced shelf
            sl = final['bottom'] - 0.40
            sim = simulate_trade_from_shelf(entry, sl, fwd)
            if sim:
                rec_results.append(sim)
                
        # 3. Random Pick of Fulcrum/Vacuum / Arbitrary Height Reduction (10 random trials per box)
        for _ in range(10):
            # Random pick between top and bottom or random reduction
            rand_cut_top = top - random.uniform(0.1, 0.7) * (top - bot)
            rand_cut_bot = bot + random.uniform(0.1, 0.7) * (top - bot)
            if rand_cut_top <= rand_cut_bot + 1.0:
                rand_cut_top = rand_cut_bot + random.uniform(1.5, 3.5)
            
            rand_res = compute_box_fulcrum_vacuum(bars, rand_cut_top, rand_cut_bot)
            if rand_res:
                # Randomly pick either the fulcrum or vacuum or random point
                chosen_entry = random.choice([rand_res['fulcrum'], rand_res['vacuum']])
                chosen_sl = rand_cut_bot - 0.40
                r_sim = simulate_trade_from_shelf(chosen_entry, chosen_sl, fwd)
                if r_sim:
                    rand_results.append(r_sim)
                    
    def calc_stats(results, name):
        n = len(results)
        if n == 0:
            return
        w3 = sum(1 for r in results if r['win_3p']) / n * 100
        w5 = sum(1 for r in results if r['win_5p']) / n * 100
        w10 = sum(1 for r in results if r['win_10p']) / n * 100
        w20 = sum(1 for r in results if r['win_20p']) / n * 100
        stopped_pct = sum(1 for r in results if r['stopped']) / n * 100
        avg_risk = np.mean([r['sl_dist'] for r in results])
        avg_fav = np.mean([r['max_fav'] for r in results])
        avg_adv = np.mean([r['max_adv'] for r in results])
        avg_rr = np.mean([r['rr'] for r in results])
        
        print(f"\n>>> STATISTICAL PROFILE: {name} (N = {n} tests)")
        print(f"  • Big Win Prob (>= 5.0p Move):   {w5:5.1f}%")
        print(f"  • Monster Move Prob (>= 10.0p):  {w10:5.1f}%")
        print(f"  • Mega Trend Move (>= 20.0p):    {w20:5.1f}%")
        print(f"  • Scratch / Stopped-Out Rate:   {stopped_pct:5.1f}%")
        print(f"  • Average Scratch Risk:         {avg_risk:5.2f} pts")
        print(f"  • Average Drawdown (MAE):        {avg_adv:5.2f} pts")
        print(f"  • Average Max Expansion:         {avg_fav:5.2f} pts")
        print(f"  • Realized Risk-to-Reward Ratio: 1:{avg_rr:4.1f}")
        return {
            'n': n, 'w5': w5, 'w10': w10, 'w20': w20,
            'stopped': stopped_pct, 'risk': avg_risk,
            'drawdown': avg_adv, 'fav': avg_fav, 'rr': avg_rr
        }
        
    s_wide = calc_stats(wide_results, "A) Initial Wide Box (No Subtraction)")
    s_rand = calc_stats(rand_results, "B) Random Pick of Fulcrum/Vacuum / Arbitrary Height")
    s_rec = calc_stats(rec_results, "C) Systematic Recursive Subtraction (Converged Scratch Shelf)")
    
    print("\n" + "="*80)
    print("EMPIRICAL COMPARISON & TRUTH TABLE")
    print("="*80)
    print(f"{'Strategy / Approach':<45} | {'Risk ($)':<8} | {'Win >=5p':<10} | {'Win >=10p':<10} | {'Avg R:R':<8}")
    print("-" * 88)
    print(f"{'Initial Wide Box':<45} | {s_wide['risk']:<7.2f}p | {s_wide['w5']:<9.1f}% | {s_wide['w10']:<9.1f}% | 1:{s_wide['rr']:<6.1f}")
    print(f"{'Random Pick / Arbitrary Cut':<45} | {s_rand['risk']:<7.2f}p | {s_rand['w5']:<9.1f}% | {s_rand['w10']:<9.1f}% | 1:{s_rand['rr']:<6.1f}")
    print(f"{'Systematic Recursive Subtraction (Converged)':<45} | {s_rec['risk']:<7.2f}p | {s_rec['w5']:<9.1f}% | {s_rec['w10']:<9.1f}% | 1:{s_rec['rr']:<6.1f}")
    print("="*80)

if __name__ == '__main__':
    run_empirical_study()
