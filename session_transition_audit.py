"""
SESSION TRANSITION AUDIT: HOW DOES THE BOX PERFORM ACROSS CHANGING MARKET SESSIONS?
Evaluates performance when boxes cross or trigger during:
1. Asian-to-London Handoff (05:30 - 09:00 UTC) - The Classic Liquidity Sweep
2. London-to-NY Overlap Handoff (12:00 - 15:30 UTC) - The Macro Explosion
3. London Mid-Day / Internal (09:00 - 12:00 UTC)
4. Late NY / Asian Internal (18:00 - 05:00 UTC)
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step
from refined_multi_shelf_orderflow import extract_structural_shelves, evaluate_refined_orderflow

def run_session_transition_study():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 15000)
    print(f"Loaded {len(rates)} bars for Session Transition Analysis.")
    
    transition_groups = {
        'ASIAN_TO_LONDON (06:00 - 09:30 UTC)': [],
        'LONDON_TO_NY_OVERLAP (12:00 - 16:00 UTC)': [],
        'LONDON_CORE_CONTINUATION (09:30 - 12:00 UTC)': [],
        'LATE_NY_AND_QUIET_HOURS (16:30 - 05:30 UTC)': []
    }
    
    last_idx = -100
    for idx in range(80, len(rates) - 60, 6):
        if idx - last_idx < 15: continue
        dt = datetime.datetime.fromtimestamp(rates[idx]['time'], datetime.timezone.utc)
        
        # Classify the session handoff
        hour = dt.hour
        if 6 <= hour <= 9:
            session_cat = 'ASIAN_TO_LONDON (06:00 - 09:30 UTC)'
        elif 12 <= hour <= 16:
            session_cat = 'LONDON_TO_NY_OVERLAP (12:00 - 16:00 UTC)'
        elif 9 < hour < 12:
            session_cat = 'LONDON_CORE_CONTINUATION (09:30 - 12:00 UTC)'
        else:
            session_cat = 'LATE_NY_AND_QUIET_HOURS (16:30 - 05:30 UTC)'
            
        window = rates[idx - 28 : idx + 1]
        w_range = max(b['high'] for b in window) - min(b['low'] for b in window)
        if not (10.0 <= w_range <= 35.0): continue
        
        last_idx = idx
        shelves = extract_structural_shelves(window, max(b['high'] for b in window), min(b['low'] for b in window))
        sim = evaluate_refined_orderflow(rates, shelves, idx, max_forward=60)
        
        if sim['status'] == 'TRADE_EXECUTED':
            transition_groups[session_cat].append({
                'time': dt,
                'sim': sim
            })
            
    print("\n" + "="*95)
    print("SESSION TRANSITION PERFORMANCE BREAKDOWN (15,000 M5 BARS / 3 MONTHS)")
    print("="*95)
    print(f"{'Session Transition Window':<42} | {'Trades':<6} | {'Win Rate':<9} | {'Profit Factor':<13} | {'Avg Win':<9} | {'Avg Loss':<9} | {'Net PnL':<10}")
    print("-" * 95)
    
    for cat, t_list in transition_groups.items():
        n = len(t_list)
        if n == 0: continue
        wins = [t for t in t_list if t['sim']['is_win']]
        losses = [t for t in t_list if not t['sim']['is_win']]
        
        tot_net = sum(t['sim']['blended_net'] for t in t_list)
        tot_win = sum(t['sim']['blended_net'] for t in wins)
        tot_loss = sum(abs(t['sim']['blended_net']) for t in losses)
        pf = (tot_win / tot_loss) if tot_loss > 0 else 999.0
        
        avg_w = np.mean([t['sim']['blended_net'] for t in wins]) if wins else 0
        avg_l = np.mean([abs(t['sim']['blended_net']) for t in losses]) if losses else 0
        wr = len(wins) / n * 100
        
        print(f"{cat:<42} | {n:<6} | {wr:5.1f}%   | {pf:5.2f}         | +{avg_w:4.2f}p   | -{avg_l:4.2f}p   | {tot_net:+6.2f} pts")
    print("="*95)

if __name__ == '__main__':
    run_session_transition_study()
