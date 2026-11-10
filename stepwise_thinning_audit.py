"""
STEP-BY-STEP SEQUENTIAL NODE THINNING AUDIT (ONE NODE AT A TIME)
Analyzes the progression of thinning a consolidation box one node at a time (Fulcrum or Vacuum),
recalculating at every step, and measuring:
- Arrival probability (Price arrives at the magnetic shelf)
- Win rates at each thinning step (Step 0, Step 1, Step 2, Step 3, Step 4)
- Structure-guided thinning vs Random node thinning
- Risk-to-Reward and probable outcomes
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
import random
from audit_recursive_box_probability import compute_box_fulcrum_vacuum

def single_node_thinning_step(bars, top_price, bottom_price, choice_strategy='structure'):
    """
    Given the current box, compute the internal Fulcrum and Vacuum.
    Then thin EXACTLY ONE NODE:
    - Upper node: max(F, V)
    - Lower node: min(F, V)
    
    choice_strategy:
    - 'structure': thin the edge that contains the larger dead space / vacuum void
    - 'random': 50/50 pick of whether to thin the top down or bottom up
    - 'top_first': thin top down
    - 'bottom_first': thin bottom up
    """
    res = compute_box_fulcrum_vacuum(bars, top_price, bottom_price)
    if not res:
        return None
        
    f = res['fulcrum']
    v = res['vacuum']
    upper_node = max(f, v)
    lower_node = min(f, v)
    
    top_distance = top_price - upper_node
    bot_distance = lower_node - bottom_price
    
    # Decide which edge to thin
    thin_edge = None
    if choice_strategy == 'structure':
        # Thin whichever outer zone has more dead space
        if top_distance >= bot_distance and top_distance > 0.40:
            thin_edge = 'top'
        elif bot_distance > 0.40:
            thin_edge = 'bottom'
        elif top_distance > 0.20:
            thin_edge = 'top'
        else:
            thin_edge = 'bottom'
    elif choice_strategy == 'random':
        choices = []
        if top_distance > 0.30: choices.append('top')
        if bot_distance > 0.30: choices.append('bottom')
        if not choices:
            return None
        thin_edge = random.choice(choices)
    elif choice_strategy == 'top_first':
        thin_edge = 'top' if top_distance > 0.30 else 'bottom'
    elif choice_strategy == 'bottom_first':
        thin_edge = 'bottom' if bot_distance > 0.30 else 'top'
        
    new_top = top_price
    new_bottom = bottom_price
    
    if thin_edge == 'top':
        # Snap top down to upper node + buffer
        new_top = round(upper_node + 0.25, 2)
    elif thin_edge == 'bottom':
        # Snap bottom up to lower node - buffer
        new_bottom = round(lower_node - 0.25, 2)
        
    # Safety check: ensure box still has positive valid height
    if new_top - new_bottom < 1.0:
        return None
        
    # Recalculate inside newly thinned box
    new_res = compute_box_fulcrum_vacuum(bars, new_top, new_bottom)
    if not new_res:
        return None
        
    return {
        'thinned_edge': thin_edge,
        'old_top': top_price,
        'old_bottom': bottom_price,
        'new_top': new_top,
        'new_bottom': new_bottom,
        'height': round(new_top - new_bottom, 2),
        'prev_fulcrum': f,
        'prev_vacuum': v,
        'new_fulcrum': new_res['fulcrum'],
        'new_vacuum': new_res['vacuum'],
        'new_retests': new_res['retests'],
        'new_score': new_res['score']
    }

def evaluate_arrival_and_trade(shelf_price, box_top, box_bottom, forward_bars, max_bars=48):
    """
    Evaluates:
    1. Did price arrive at the shelf? (Magnetic Arrival Check)
    2. How many bars until arrival?
    3. Once arrived, does it trigger a trade with scratch SL outside the thinned box?
    4. What are the expansion outcomes (>=3p, >=5p, >=10p, >=20p)?
    """
    lookahead = forward_bars[:max_bars]
    if len(lookahead) == 0:
        return None
        
    # 1. Arrival Check: Does price reach within 0.40p of the shelf?
    arrived = False
    arrival_bar_idx = -1
    approach_dir = None
    
    initial_p = lookahead[0]['close']
    if initial_p > shelf_price:
        initial_dir = 'above'
    else:
        initial_dir = 'below'
        
    for idx, b in enumerate(lookahead):
        if b['low'] <= shelf_price + 0.25 and b['high'] >= shelf_price - 0.25:
            arrived = True
            arrival_bar_idx = idx
            approach_dir = initial_dir
            break
            
    if not arrived:
        return {
            'arrived': False,
            'arrival_bars': -1,
            'trade': None
        }
        
    # 2. Trade Execution from Arrival:
    # If approached from above -> BUY from shelf, SL below box_bottom
    # If approached from below -> SELL from shelf, SL above box_top
    entry_price = shelf_price
    trade_bars = lookahead[arrival_bar_idx:]
    
    if approach_dir == 'above':
        pos = 'BUY'
        sl_price = round(box_bottom - 0.35, 2)
        risk = round(entry_price - sl_price, 2)
    else:
        pos = 'SELL'
        sl_price = round(box_top + 0.35, 2)
        risk = round(sl_price - entry_price, 2)
        
    if risk <= 0.20:
        risk = 1.00
        
    max_fav = 0.0
    max_adv = 0.0
    stopped = False
    
    for b in trade_bars:
        if pos == 'BUY':
            if b['low'] <= sl_price:
                stopped = True
                break
            fav = b['high'] - entry_price
            adv = entry_price - b['low']
        else:
            if b['high'] >= sl_price:
                stopped = True
                break
            fav = entry_price - b['low']
            adv = b['high'] - entry_price
            
        if fav > max_fav: max_fav = fav
        if adv > max_adv: max_adv = adv
        
    return {
        'arrived': True,
        'arrival_bars': arrival_bar_idx,
        'direction': pos,
        'entry': entry_price,
        'sl': sl_price,
        'risk': risk,
        'max_fav': round(max_fav, 2),
        'max_adv': round(max_adv, 2),
        'stopped': stopped,
        'win_3p': max_fav >= 3.0,
        'win_5p': max_fav >= 5.0,
        'win_10p': max_fav >= 10.0,
        'win_20p': max_fav >= 20.0,
        'rr': round(max_fav / risk, 1) if risk > 0 else 0
    }

def run_stepwise_audit():
    if not mt5.initialize():
        print("MT5 initialization failed!")
        return
        
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 2000)
    print(f"Total M5 bars loaded: {len(rates)}")
    
    # Identify consolidation boxes
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
                'fwd': rates[i+36:i+36+48],
                'top': h,
                'bot': l,
                'range': rng
            })
            
    print(f"Total consolidation boxes identified: {len(boxes)}")
    
    # Containers for results by Step index: Step 0 (Raw), Step 1, Step 2, Step 3, Step 4
    # For both Structure-guided and Random pick
    strategies = ['structure', 'random']
    all_step_data = {s: {step: [] for step in range(5)} for s in strategies}
    
    random.seed(123)
    
    for strat in strategies:
        iterations_per_box = 1 if strat == 'structure' else 15
        for b in boxes:
            bars = b['bars']
            fwd = b['fwd']
            
            for _ in range(iterations_per_box):
                curr_top = b['top']
                curr_bot = b['bot']
                
                # Step 0: Raw initial box
                raw_res = compute_box_fulcrum_vacuum(bars, curr_top, curr_bot)
                if raw_res:
                    eval_0 = evaluate_arrival_and_trade(raw_res['fulcrum'], curr_top, curr_bot, fwd)
                    if eval_0:
                        all_step_data[strat][0].append({
                            'height': curr_top - curr_bot,
                            'eval': eval_0
                        })
                        
                # Progressively thin one node at a time (up to 4 steps)
                for step_num in range(1, 5):
                    thin_res = single_node_thinning_step(bars, curr_top, curr_bot, choice_strategy=strat)
                    if not thin_res:
                        break
                    curr_top = thin_res['new_top']
                    curr_bot = thin_res['new_bottom']
                    
                    # Evaluate trade from the newly recalculated Fulcrum
                    eval_step = evaluate_arrival_and_trade(thin_res['new_fulcrum'], curr_top, curr_bot, fwd)
                    if eval_step:
                        all_step_data[strat][step_num].append({
                            'height': thin_res['height'],
                            'eval': eval_step
                        })
                        
                    if thin_res['height'] <= 2.8:
                        # Box has reached thin scratch height
                        break
                        
    def print_strategy_report(strat_name, strat_key):
        print("\n" + "="*85)
        print(f"STEP-BY-STEP PROGRESSION REPORT: {strat_name.upper()}")
        print("="*85)
        print(f"{'Step':<8} | {'Avg Height':<11} | {'Avg Risk':<9} | {'Arrival %':<10} | {'Win >=3p':<9} | {'Win >=5p':<9} | {'Win >=10p':<10} | {'Avg R:R':<8}")
        print("-" * 85)
        
        for step in range(5):
            records = all_step_data[strat_key][step]
            n = len(records)
            if n == 0: continue
            
            avg_height = np.mean([r['height'] for r in records])
            arrived_records = [r for r in records if r['eval']['arrived']]
            arrival_pct = len(arrived_records) / n * 100
            
            if len(arrived_records) > 0:
                avg_risk = np.mean([r['eval']['risk'] for r in arrived_records])
                w3 = sum(1 for r in arrived_records if r['eval']['win_3p']) / len(arrived_records) * 100
                w5 = sum(1 for r in arrived_records if r['eval']['win_5p']) / len(arrived_records) * 100
                w10 = sum(1 for r in arrived_records if r['eval']['win_10p']) / len(arrived_records) * 100
                avg_rr = np.mean([r['eval']['rr'] for r in arrived_records])
            else:
                avg_risk = 0; w3 = 0; w5 = 0; w10 = 0; avg_rr = 0
                
            label = "Step 0 (Raw Box)" if step == 0 else f"Step {step} Thinned"
            print(f"{label:<8} | {avg_height:5.2f} pts   | {avg_risk:4.2f} pts  | {arrival_pct:5.1f}%    | {w3:5.1f}%   | {w5:5.1f}%   | {w10:5.1f}%    | 1:{avg_rr:4.1f}")
        print("="*85)
        
    print_strategy_report("Structure-Guided Sequential Thinning (One Node at a Time)", "structure")
    print_strategy_report("Random-Pick Sequential Thinning (One Node at a Time)", "random")

if __name__ == '__main__':
    run_stepwise_audit()
