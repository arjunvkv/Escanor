"""
DETAILED MONTE CARLO AUDIT: RECURSIVE SUBTRACTION VS RANDOM PICK
"""
import MetaTrader5 as mt5
import numpy as np
import random
from audit_recursive_box_probability import compute_box_fulcrum_vacuum, recursive_box_subtraction, simulate_trade_from_shelf

def run_deep_test():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 2000)
    print(f"Loaded {len(rates)} historical bars for deep audit.")
    
    # Identify 60 distinct consolidation boxes
    boxes = []
    for i in range(100, len(rates) - 80, 25):
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
            
    print(f"Extracted {len(boxes)} clean consolidation boxes.")
    
    # Test 3 strategies:
    # 1. Converged Subtraction: iteratively eat outer vacuum/voids until height <= 3.5p
    # 2. Random Fulcrum/Vacuum Pick: pick at random iteration or random point
    # 3. Naive Middle / Full Box
    
    converged_trials = []
    random_pick_trials = []
    
    for b in boxes:
        bars = b['bars']
        fwd = b['fwd']
        top = b['top']
        bot = b['bot']
        
        # Method 1: Systematic Convergence
        steps = recursive_box_subtraction(bars, top, bot, min_height=3.0, max_iters=5)
        if steps:
            final = steps[-1]
            # Test entry at final fulcrum with stop at final bottom
            entry = final['fulcrum']
            sl = final['bottom'] - 0.40
            sim = simulate_trade_from_shelf(entry, sl, fwd)
            if sim:
                converged_trials.append(sim)
                
        # Method 2: Random Pick across 20 iterations per box
        for _ in range(20):
            # Pick a random intermediate subtraction level or random choice
            rand_step = random.randint(1, 4)
            # simulate random top/bot cuts
            cut_t = top - random.uniform(0.15, 0.65) * (top - bot)
            cut_b = bot + random.uniform(0.15, 0.65) * (top - bot)
            if cut_t <= cut_b + 1.5:
                cut_t = cut_b + 2.5
            r_res = compute_box_fulcrum_vacuum(bars, cut_t, cut_b)
            if r_res:
                chosen = random.choice([r_res['fulcrum'], r_res['vacuum']])
                chosen_sl = cut_b - 0.40
                r_sim = simulate_trade_from_shelf(chosen, chosen_sl, fwd)
                if r_sim:
                    random_pick_trials.append(r_sim)

    def print_metrics(name, data):
        n = len(data)
        w3 = sum(1 for d in data if d['win_3p']) / n * 100
        w5 = sum(1 for d in data if d['win_5p']) / n * 100
        w10 = sum(1 for d in data if d['win_10p']) / n * 100
        w15 = sum(1 for d in data if d['max_fav'] >= 15.0 and not (d['stopped'] and d['max_fav'] < 15.0)) / n * 100
        w25 = sum(1 for d in data if d['max_fav'] >= 25.0 and not (d['stopped'] and d['max_fav'] < 25.0)) / n * 100
        stopped = sum(1 for d in data if d['stopped']) / n * 100
        avg_risk = np.mean([d['sl_dist'] for d in data])
        avg_rr = np.mean([d['rr'] for d in data])
        avg_fav = np.mean([d['max_fav'] for d in data])
        avg_adv = np.mean([d['max_adv'] for d in data])
        
        print(f"\n[{name}] (Total Runs: {n})")
        print(f"  • Big Win Prob (>= 5p):    {w5:.1f}%")
        print(f"  • Major Win Prob (>= 10p):  {w10:.1f}%")
        print(f"  • Monster Win Prob (>= 15p):{w15:.1f}%")
        print(f"  • Mega Win Prob (>= 25p):   {w25:.1f}%")
        print(f"  • Scratch / Stop-Out Rate: {stopped:.1f}%")
        print(f"  • Average Scratch Risk:    ${avg_risk:.2f}")
        print(f"  • Average Max Drawdown:    ${avg_adv:.2f}")
        print(f"  • Average Max Expansion:   +${avg_fav:.2f}")
        print(f"  • Average Risk-to-Reward:  1:{avg_rr:.1f}")

    print_metrics("SYSTEMATIC RECURSIVE SUBTRACTION (CONVERGED TO INVARIANT SHELF)", converged_trials)
    print_metrics("RANDOM PICK OF FULCRUM / VACUUM (UNCONVERGED ARBITRARY REDUCTION)", random_pick_trials)

if __name__ == '__main__':
    run_deep_test()
