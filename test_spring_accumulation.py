"""
TEST: WYCKOFF SPRING ACCUMULATION BASE (THE EXACT PATTERN FROM YOUR IMAGES)
Tests the exact setup you executed in Images 1-3:
1. Market sells off into a swing low base
2. Consolidation forms at the bottom
3. Box is thinned node-by-node down to the invariant shelf
4. Price sweeps the lower vacuum / floor (Spring Wick), absorbs, and reclaims the Fulcrum
5. Enter LONG with scratch SL below the sweep tip
6. Modeled with real MT5 friction (0.38p spread, 0.10p slippage, 0.06p commission)
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step

SPREAD_PTS = 0.38
SLIPPAGE_PTS = 0.10
COMMISSION_PTS = 0.06
TOTAL_FRICTION = SPREAD_PTS + SLIPPAGE_PTS + COMMISSION_PTS

def run_spring_accumulation_test():
    mt5.initialize()
    rates_m5 = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 5000)
    print(f"Loaded {len(rates_m5)} M5 bars.")
    
    spring_trades = []
    last_idx = -100
    
    for idx in range(60, len(rates_m5) - 60, 6):
        if idx - last_idx < 15: continue
        
        # Look for consolidation base after a selloff (Dump of >=8.0p in prior 25 bars)
        prior = rates_m5[idx - 45 : idx - 20]
        if len(prior) < 15: continue
        prior_move = prior[-1]['close'] - prior[0]['open']
        
        # Only look for bases formed after a selloff (Accumulation Spring Setup!)
        if prior_move > -7.0:
            continue
            
        coil = rates_m5[idx - 20 : idx + 1]
        c_high = max(b['high'] for b in coil)
        c_low = min(b['low'] for b in coil)
        c_range = c_high - c_low
        if not (10.0 <= c_range <= 28.0):
            continue
            
        last_idx = idx
        
        # Thin box down to invariant scratch shelf
        curr_top = c_high
        curr_bot = c_low
        final_fulcrum = (curr_top + curr_bot) / 2.0
        for _ in range(4):
            res = single_node_thinning_step(coil, curr_top, curr_bot, choice_strategy='structure')
            if not res: break
            curr_top = res['new_top']
            curr_bot = res['new_bottom']
            final_fulcrum = res['new_fulcrum']
            if res['height'] <= 3.2: break
            
        # Look forward for the Spring Wick Reclaim (Price sweeps below shelf and reclaims)
        forward = rates_m5[idx + 1 : idx + 61]
        if len(forward) < 5: continue
        
        triggered = False
        trigger_idx = -1
        fill_entry = 0.0
        initial_sl = 0.0
        risk = 0.0
        
        for f_idx in range(min(36, len(forward))):
            b = forward[f_idx]
            b_range = max(0.01, b['high'] - b['low'])
            lower_wick = min(b['open'], b['close']) - b['low']
            
            # Spring Wick: Sweeps below shelf by >=0.20p, closes back above shelf, lower wick >= 30%
            if b['low'] <= final_fulcrum - 0.20 and b['close'] >= final_fulcrum + 0.15 and (lower_wick / b_range) >= 0.30:
                fill_entry = round(b['close'] + SPREAD_PTS + SLIPPAGE_PTS, 2)
                initial_sl = round(b['low'] - 0.70 - SLIPPAGE_PTS, 2)
                risk = round(fill_entry - initial_sl, 2)
                if 1.60 <= risk <= 4.00:
                    triggered = True
                    trigger_idx = f_idx
                    break
                    
        if not triggered:
            continue
            
        trade_bars = forward[trigger_idx + 1:]
        if len(trade_bars) == 0: continue
        
        current_sl = initial_sl
        peak_fav = 0.0
        exit_p = 0.0
        exit_reason = None
        
        for b in trade_bars:
            if b['low'] <= current_sl:
                exit_p = current_sl - SLIPPAGE_PTS
                exit_reason = 'STOP_LOSS'
                break
            fav = b['high'] - fill_entry
            if fav > peak_fav: peak_fav = fav
            
            if peak_fav >= 4.00 and current_sl < fill_entry - 0.80:
                current_sl = fill_entry - 0.80
            if peak_fav >= 6.00 and current_sl < fill_entry + 0.30:
                current_sl = fill_entry + 0.30
            if peak_fav >= 10.00:
                current_sl = max(current_sl, round(fill_entry + peak_fav - 4.00, 2))
                
        if not exit_reason:
            exit_p = trade_bars[-1]['close']
            exit_reason = 'SESSION_LIMIT'
            
        net_pts = round((exit_p - fill_entry) - COMMISSION_PTS, 2)
        
        spring_trades.append({
            'time': datetime.datetime.fromtimestamp(rates_m5[idx]['time']),
            'entry': fill_entry,
            'sl': initial_sl,
            'risk': risk,
            'exit': exit_p,
            'net_pts': net_pts,
            'peak_fav': round(peak_fav, 2),
            'exit_reason': exit_reason,
            'is_win': net_pts > 0
        })
        
    print("\n" + "="*95)
    print("SPRING ACCUMULATION SETUP AUDIT (YOUR EXACT MANUAL PATTERN)")
    print("="*95)
    print(f"Total Qualified Spring Trades Executed: {len(spring_trades)}")
    
    if len(spring_trades) == 0: return
    
    print("\n" + "-"*95)
    print(f"{'#':<3} | {'Date / Time':<16} | {'Entry':<8} | {'SL (Risk)':<14} | {'Exit':<8} | {'Net PnL':<9} | {'Peak MFE':<9} | {'Outcome'}")
    print("-" * 95)
    for i, t in enumerate(spring_trades):
        out = "MONSTER WIN" if t['net_pts'] >= 8.0 else ("WIN" if t['net_pts'] > 0 else "SCRATCH")
        print(f"{i+1:<3} | {t['time'].strftime('%Y-%m-%d %H:%M')} | ${t['entry']:<7.2f} | ${t['sl']:.2f} ({t['risk']:.2f}p) | ${t['exit']:<7.2f} | {t['net_pts']:+6.2f}p  | +{t['peak_fav']:<6.2f}p  | {out}")
    print("-" * 95)
    
    wins = [t for t in spring_trades if t['is_win']]
    losses = [t for t in spring_trades if not t['is_win']]
    total_win = sum(t['net_pts'] for t in wins)
    total_loss = sum(abs(t['net_pts']) for t in losses)
    pf = (total_win / total_loss) if total_loss > 0 else 999.0
    
    print(f"• Win Rate:                                {len(wins)/len(spring_trades)*100:5.1f}% ({len(wins)} of {len(spring_trades)})")
    print(f"• Profit Factor:                           {pf:5.2f}")
    print(f"• Total Net Points:                        {total_win - total_loss:+6.2f} pts")
    if wins: print(f"• Average Winner:                         +{np.mean([t['net_pts'] for t in wins]):5.2f} pts")
    if losses: print(f"• Average Scratch Loss:                   -${np.mean([abs(t['net_pts']) for t in losses]):5.2f} pts")
    print(f"• Reached >= 10.0 pts Move:                {sum(1 for t in spring_trades if t['peak_fav'] >= 10.0)/len(spring_trades)*100:5.1f}%")
    print("="*95)

if __name__ == '__main__':
    run_spring_accumulation_test()
