"""
TEST: HIGH-CONVICTION LIVE MIMIC (LONDON SESSION + IMPULSE REVERSAL BASES)
Tests the automated system with real MT5 spread (0.38p), slippage (0.10p), and commission (0.06p),
but filtering for HIGH-CONVICTION structures (matching the user's manual test criteria).
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step
from live_autonomous_system_test_v3 import simulate_v3_execution

SPREAD_PTS = 0.38
SLIPPAGE_PTS = 0.10
COMMISSION_PTS = 0.06
TOTAL_FRICTION = SPREAD_PTS + SLIPPAGE_PTS + COMMISSION_PTS

def run_high_conviction_live_audit():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 4000)
    
    high_conviction_boxes = []
    
    for idx in range(60, len(rates) - 60, 8):
        dt = datetime.datetime.fromtimestamp(rates[idx]['time'], datetime.timezone.utc)
        
        # 1. Session Filter: London Morning & London/NY Overlap (06:00 to 15:30 UTC)
        if not (6 <= dt.hour <= 15):
            continue
            
        # 2. Check for strong impulse move in prior 20 bars (>=10.0p move)
        prior_bars = rates[idx - 40 : idx - 20]
        if len(prior_bars) < 15: continue
        prior_move = prior_bars[-1]['close'] - prior_bars[0]['open']
        if abs(prior_move) < 10.0:
            continue
            
        # 3. Check for coiling consolidation base (20 bars)
        coil_bars = rates[idx - 20 : idx + 1]
        c_high = max(b['high'] for b in coil_bars)
        c_low = min(b['low'] for b in coil_bars)
        c_range = c_high - c_low
        if not (12.0 <= c_range <= 28.0):
            continue
            
        # 4. Thin box down to scratch height
        curr_top = c_high
        curr_bot = c_low
        final_fulcrum = (curr_top + curr_bot) / 2.0
        for _ in range(4):
            res = single_node_thinning_step(coil_bars, curr_top, curr_bot, choice_strategy='structure')
            if not res: break
            curr_top = res['new_top']
            curr_bot = res['new_bottom']
            final_fulcrum = res['new_fulcrum']
            if res['height'] <= 3.2: break
            
        # 5. Simulate live broker execution with real spread & friction
        sim = simulate_v3_execution(
            rates,
            final_fulcrum,
            curr_top,
            curr_bot,
            idx,
            max_forward=60
        )
        
        if sim and sim['status'] == 'TRADE_EXECUTED':
            high_conviction_boxes.append({
                'time': dt,
                'thinned_height': curr_top - curr_bot,
                'sim': sim
            })
            
    print(f"\n=====================================================================================")
    print(f"HIGH-CONVICTION LIVE AUDIT (REAL SPREAD 0.38p, SLIPPAGE 0.10p, COMMISSIONS)")
    print(f"=====================================================================================")
    print(f"• Total High-Conviction Setups Triggered:  {len(high_conviction_boxes)}")
    
    if len(high_conviction_boxes) == 0:
        return
        
    trades = [d['sim'] for d in high_conviction_boxes]
    wins = [t for t in trades if t['is_win']]
    losses = [t for t in trades if not t['is_win']]
    
    net_pnl = sum(t['net_pts'] for t in trades)
    avg_win = np.mean([t['net_pts'] for t in wins]) if wins else 0
    avg_loss = np.mean([abs(t['net_pts']) for t in losses]) if losses else 0
    pf = (sum(t['net_pts'] for t in wins) / sum(abs(t['net_pts']) for t in losses)) if losses else 999.0
    
    w3 = sum(1 for t in trades if t['win_3p']) / len(trades) * 100
    w5 = sum(1 for t in trades if t['win_5p']) / len(trades) * 100
    w10 = sum(1 for t in trades if t['win_10p']) / len(trades) * 100
    w15 = sum(1 for t in trades if t['peak_fav'] >= 15.0) / len(trades) * 100
    
    print(f"• Win Rate:                                {len(wins)/len(trades)*100:5.1f}% ({len(wins)} of {len(trades)})")
    print(f"• Profit Factor:                           {pf:5.2f}")
    print(f"• Total Net Points Extracted:              {net_pnl:+6.2f} pts")
    print(f"• Average Winner:                         +{avg_win:5.2f} pts")
    print(f"• Average Scratch Loss:                   -${avg_loss:5.2f} pts")
    print(f"• Win >= 5.0 pts Move:                     {w5:5.1f}%")
    print(f"• Win >= 10.0 pts Monster Move:            {w10:5.1f}%")
    print(f"• Win >= 15.0 pts Trend Leg:               {w15:5.1f}%")
    print(f"• Realized Peak Risk-to-Reward:            1:{np.mean([t['rr'] for t in trades]):4.1f}")
    print("=====================================================================================")

if __name__ == '__main__':
    run_high_conviction_live_audit()
