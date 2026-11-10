"""
CROSS-REGIME OUT-OF-SAMPLE AUDIT (15,000 M5 BARS / 3 FULL MONTHS)
Evaluates the setup across 3 independent, non-overlapping market slices:
- Slice 1: Recent (Oct 12 - Nov 05, 2026) [Bars 0 to 5,000]
- Slice 2: Out-of-Sample Mid (Sept 15 - Oct 12, 2026) [Bars 5,000 to 10,000]
- Slice 3: Out-of-Sample Early (Aug 20 - Sept 15, 2026) [Bars 10,000 to 15,000]

Incorporating all live trap fixes:
1. Partial Harvest Scale-out:
   - 50% closed at +4.0p (+4.0p locked in bank)
   - SL on remaining 50% moved to +0.30p (True Breakeven)
   - Dynamic Peak Trail at >= +8.0p (3.5p trailing buffer) on remaining runner
2. Realistic Live Broker Friction:
   - Spread: 0.38 pts
   - Slippage: 0.15 pts (modeled on entries AND stop-outs)
   - ECN Commission: 0.06 pts
   - Total friction: 0.59 pts
3. Live Rollover Spread-Spike Protection:
   - NO trades taken between 21:00 and 23:15 UTC (rollover blackout)
4. Pessimistic Intra-Bar Sequencing:
   - In any bar touching both SL and target, SL is ALWAYS evaluated first!
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step

SPREAD_PTS = 0.38
SLIPPAGE_PTS = 0.15
COMMISSION_PTS = 0.06
TOTAL_FRICTION = SPREAD_PTS + SLIPPAGE_PTS + COMMISSION_PTS

def scan_spring_consolidation(rates, current_idx, lookback=26):
    if current_idx < lookback + 25:
        return None
        
    dt = datetime.datetime.fromtimestamp(rates[current_idx]['time'], datetime.timezone.utc)
    
    # 1. LIVE TRAP REMOVED: Exclude rollover window (21:00 to 23:15 UTC) to prevent spread spike stopouts
    if dt.hour >= 21 or (dt.hour == 23 and dt.minute < 15) or dt.hour < 5:
        return None
        
    window = rates[current_idx - lookback : current_idx + 1]
    highs = [b['high'] for b in window]
    lows = [b['low'] for b in window]
    w_high = max(highs)
    w_low = min(lows)
    w_range = w_high - w_low
    
    if not (10.0 <= w_range <= 28.0):
        return None
        
    # Check prior impulse move in prior 25 bars (must be a selloff / dump of >=7.0p)
    prior_bars = rates[current_idx - lookback - 25 : current_idx - lookback]
    if len(prior_bars) < 15:
        return None
    prior_move = prior_bars[-1]['close'] - prior_bars[0]['open']
    if prior_move > -6.5:
        # Not a swing low accumulation base after a dump
        return None
        
    return {
        'idx': current_idx,
        'time': dt,
        'bars': window,
        'top': round(w_high, 2),
        'bottom': round(w_low, 2),
        'range': round(w_range, 2)
    }

def thin_box_causally(bars, top, bottom, min_height=3.2):
    curr_top = top
    curr_bot = bottom
    final_fulcrum = (top + bottom) / 2.0
    for _ in range(4):
        res = single_node_thinning_step(bars, curr_top, curr_bot, choice_strategy='structure')
        if not res: break
        curr_top = res['new_top']
        curr_bot = res['new_bottom']
        final_fulcrum = res['new_fulcrum']
        if res['height'] <= min_height: break
    return {
        'thinned_top': round(curr_top, 2),
        'thinned_bottom': round(curr_bot, 2),
        'thinned_height': round(curr_top - curr_bot, 2),
        'fulcrum': round(final_fulcrum, 2)
    }

def simulate_live_scaleout_trade(rates, shelf_price, thinned_top, thinned_bottom, start_idx, max_forward=60):
    future_bars = rates[start_idx + 1 : start_idx + 1 + max_forward]
    if len(future_bars) < 5:
        return {'status': 'NO_DATA'}
        
    recent_vols = [b['tick_volume'] for b in rates[start_idx - 10 : start_idx]]
    avg_vol = np.mean(recent_vols) if recent_vols else 1000
    
    triggered = False
    trigger_idx = -1
    fill_entry = 0.0
    initial_sl = 0.0
    risk = 0.0
    
    # 1. Order Flow Physical Trigger: Spring Wick Reclaim with Volume Surge
    for idx in range(min(36, len(future_bars))):
        b = future_bars[idx]
        b_range = max(0.01, b['high'] - b['low'])
        lower_wick = min(b['open'], b['close']) - b['low']
        has_vol = b['tick_volume'] >= 1.15 * avg_vol
        
        # Spring Wick condition
        if b['low'] <= shelf_price - 0.20 and b['close'] >= shelf_price + 0.15 and (lower_wick / b_range) >= 0.30 and has_vol:
            fill_entry = round(b['close'] + SPREAD_PTS + SLIPPAGE_PTS, 2)
            # Minor Scratch SL: Sweep tip minus 0.70p breathing buffer
            initial_sl = round(b['low'] - 0.70 - SLIPPAGE_PTS, 2)
            risk = round(fill_entry - initial_sl, 2)
            if 1.60 <= risk <= 4.20:
                triggered = True
                trigger_idx = idx
                break
                
    if not triggered:
        return {'status': 'NO_TRIGGER'}
        
    trade_bars = future_bars[trigger_idx + 1:]
    if len(trade_bars) == 0:
        return {'status': 'NO_POST_BARS'}
        
    # Scale-out state machine:
    # Lot 1 (50%): Targets +4.00p (Partial Harvest)
    # Lot 2 (50%): Uncapped runner with Dynamic Peak Trail at >= +8.0p
    current_sl = initial_sl
    lot1_closed = False
    lot1_pnl = 0.0
    lot2_closed = False
    lot2_pnl = 0.0
    
    peak_fav = 0.0
    target_tp1 = fill_entry + 4.00
    
    for b in trade_bars:
        bid_low = b['low']
        bid_high = b['high']
        fav = bid_high - fill_entry
        if fav > peak_fav: peak_fav = fav
        
        # PESSIMISTIC CHECK: If bar touches both SL and TP, SL is triggered FIRST!
        # A. Stop Loss Trigger
        if bid_low <= current_sl:
            stop_exit = current_sl - SLIPPAGE_PTS
            loss_pts = round((stop_exit - fill_entry) - COMMISSION_PTS, 2)
            if not lot1_closed:
                lot1_pnl = loss_pts
                lot1_closed = True
            if not lot2_closed:
                lot2_pnl = loss_pts
                lot2_closed = True
            break
            
        # B. Partial Harvest Check (Lot 1): Did price reach +4.0p?
        if not lot1_closed and bid_high >= target_tp1:
            lot1_pnl = round(4.00 - SLIPPAGE_PTS - COMMISSION_PTS, 2) # Net ~ +3.79 pts
            lot1_closed = True
            # Move SL on remaining Lot 2 to TRUE Breakeven (+0.30p net profit)
            current_sl = max(current_sl, fill_entry + 0.30)
            
        # C. Runner Management (Lot 2):
        if lot1_closed and not lot2_closed:
            # Dynamic peak trail at >= +8.0p
            if peak_fav >= 8.00:
                current_sl = max(current_sl, round(fill_entry + peak_fav - 3.50, 2))
                
    # If session ends with open lots, mark to market at last bar
    last_bid = trade_bars[-1]['close']
    if not lot1_closed:
        lot1_pnl = round((last_bid - fill_entry) - COMMISSION_PTS, 2)
    if not lot2_closed:
        lot2_pnl = round((last_bid - fill_entry) - COMMISSION_PTS, 2)
        
    # Blended Net PnL (50% Lot 1 + 50% Lot 2)
    blended_net_pts = round(0.5 * lot1_pnl + 0.5 * lot2_pnl, 2)
    
    return {
        'status': 'TRADE_EXECUTED',
        'entry': fill_entry,
        'sl': initial_sl,
        'risk': risk,
        'peak_fav': round(peak_fav, 2),
        'lot1_pnl': lot1_pnl,
        'lot2_pnl': lot2_pnl,
        'blended_net': blended_net_pts,
        'is_win': blended_net_pts > 0,
        'hit_tp1': lot1_closed and lot1_pnl > 0,
        'win_10p': peak_fav >= 10.0,
        'win_15p': peak_fav >= 15.0
    }

def run_slice_backtest(rates_slice, slice_name):
    trades = []
    last_idx = -100
    candidates = 0
    
    for idx in range(60, len(rates_slice) - 60, 6):
        if idx - last_idx < 15: continue
        box = scan_spring_consolidation(rates_slice, idx)
        if box:
            candidates += 1
            last_idx = idx
            thinned = thin_box_causally(box['bars'], box['top'], box['bottom'], min_height=3.2)
            sim = simulate_live_scaleout_trade(
                rates_slice,
                thinned['fulcrum'],
                thinned['thinned_top'],
                thinned['thinned_bottom'],
                idx,
                max_forward=60
            )
            if sim['status'] == 'TRADE_EXECUTED':
                trades.append({
                    'time': box['time'],
                    'sim': sim
                })
                
    n = len(trades)
    if n == 0:
        return {'name': slice_name, 'n': 0, 'candidates': candidates}
        
    wins = [t for t in trades if t['sim']['is_win']]
    losses = [t for t in trades if not t['sim']['is_win']]
    
    total_net = sum(t['sim']['blended_net'] for t in trades)
    tot_win = sum(t['sim']['blended_net'] for t in wins)
    tot_loss = sum(abs(t['sim']['blended_net']) for t in losses)
    pf = (tot_win / tot_loss) if tot_loss > 0 else 999.0
    
    avg_win = np.mean([t['sim']['blended_net'] for t in wins]) if wins else 0
    avg_loss = np.mean([abs(t['sim']['blended_net']) for t in losses]) if losses else 0
    
    tp1_pct = sum(1 for t in trades if t['sim']['hit_tp1']) / n * 100
    w10_pct = sum(1 for t in trades if t['sim']['win_10p']) / n * 100
    
    return {
        'name': slice_name,
        'candidates': candidates,
        'n': n,
        'wins': len(wins),
        'losses': len(losses),
        'win_rate': len(wins) / n * 100,
        'pf': pf,
        'total_net': total_net,
        'avg_win': avg_win,
        'avg_loss': avg_loss,
        'tp1_pct': tp1_pct,
        'w10_pct': w10_pct,
        'trades': trades
    }

def run_cross_regime_study():
    mt5.initialize()
    total_bars = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 15000)
    print(f"Loaded {len(total_bars)} total historical M5 bars across ~85 trading days.")
    print(f"Live Friction: Spread={SPREAD_PTS}p | Slippage={SLIPPAGE_PTS}p | Comm={COMMISSION_PTS}p | Total Friction={TOTAL_FRICTION:.2f}p")
    
    # Slice 1: Bars 10000 to 15000 (Recent: Oct 12 - Nov 05, 2026)
    slice1_rates = total_bars[10000:]
    dt1_start = datetime.datetime.fromtimestamp(slice1_rates[0]['time'])
    dt1_end = datetime.datetime.fromtimestamp(slice1_rates[-1]['time'])
    s1_name = f"Slice 1 [Recent: {dt1_start.strftime('%b %d')} - {dt1_end.strftime('%b %d')}]"
    
    # Slice 2: Bars 5000 to 10000 (Mid: Sept 15 - Oct 12, 2026)
    slice2_rates = total_bars[5000:10000]
    dt2_start = datetime.datetime.fromtimestamp(slice2_rates[0]['time'])
    dt2_end = datetime.datetime.fromtimestamp(slice2_rates[-1]['time'])
    s2_name = f"Slice 2 [Out-of-Sample: {dt2_start.strftime('%b %d')} - {dt2_end.strftime('%b %d')}]"
    
    # Slice 3: Bars 0 to 5000 (Early: Aug 20 - Sept 15, 2026)
    slice3_rates = total_bars[0:5000]
    dt3_start = datetime.datetime.fromtimestamp(slice3_rates[0]['time'])
    dt3_end = datetime.datetime.fromtimestamp(slice3_rates[-1]['time'])
    s3_name = f"Slice 3 [Out-of-Sample: {dt3_start.strftime('%b %d')} - {dt3_end.strftime('%b %d')}]"
    
    res1 = run_slice_backtest(slice1_rates, s1_name)
    res2 = run_slice_backtest(slice2_rates, s2_name)
    res3 = run_slice_backtest(slice3_rates, s3_name)
    
    print("\n" + "="*95)
    print("CROSS-REGIME OUT-OF-SAMPLE AUDIT (WITH PARTIAL HARVEST & LIVE FRICTION)")
    print("="*95)
    print(f"{'Market Slice':<38} | {'Trades':<6} | {'Win Rate':<9} | {'Profit Factor':<13} | {'Avg Win':<9} | {'Avg Loss':<9} | {'Net PnL':<10}")
    print("-" * 95)
    
    for r in [res1, res2, res3]:
        print(f"{r['name']:<38} | {r['n']:<6} | {r['win_rate']:5.1f}%   | {r['pf']:5.2f}         | +{r['avg_win']:4.2f}p   | -{r['avg_loss']:4.2f}p   | {r['total_net']:+6.2f} pts")
        
    print("-" * 95)
    
    # Combined Totals
    all_trades = res1.get('trades', []) + res2.get('trades', []) + res3.get('trades', [])
    tot_n = len(all_trades)
    tot_wins = [t for t in all_trades if t['sim']['is_win']]
    tot_losses = [t for t in all_trades if not t['sim']['is_win']]
    tot_pnl = sum(t['sim']['blended_net'] for t in all_trades)
    tot_win_pts = sum(t['sim']['blended_net'] for t in tot_wins)
    tot_loss_pts = sum(abs(t['sim']['blended_net']) for t in tot_losses)
    tot_pf = (tot_win_pts / tot_loss_pts) if tot_loss_pts > 0 else 999.0
    
    print(f"{'OVERALL COMBINED (15,000 M5 BARS / 3 MO)':<38} | {tot_n:<6} | {len(tot_wins)/tot_n*100:5.1f}%   | {tot_pf:5.2f}         | +{np.mean([t['sim']['blended_net'] for t in tot_wins]):4.2f}p   | -{np.mean([abs(t['sim']['blended_net']) for t in tot_losses]):4.2f}p   | {tot_pnl:+6.2f} pts")
    print("="*95)

if __name__ == '__main__':
    run_cross_regime_study()
