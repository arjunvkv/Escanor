"""
MULTI-WAY BOX REDUCTION & ORDER FLOW TRUE REALITY MATRIX
Evaluates the multi-shelf reduction architecture:
1. Shrinking the box produces multiple structural shelves:
   - Upper Shelf (Top reduced to upper Vacuum/Fulcrum)
   - Lower Shelf (Bottom reduced to lower Vacuum/Fulcrum)
   - Core Fulcrum Retest Axis (Center equilibrium)
   - Vacuum Void Pocket (Fast transit / sweep pocket)
2. Direction is NOT predetermined: ORDER FLOW TRUE REALITY METRICS dictate execution:
   - At ANY shelf, if order flow shows Bullish Absorption (Spring Wick, lower spine >=35%, volume spike) -> BUY
   - At ANY shelf, if order flow shows Bearish Distribution (Ceiling Wick, upper spine >=35%, volume spike) -> SELL
3. Tested across 3 non-overlapping slices of 15,000 M5 bars with real live broker friction (Spread 0.38p, Slippage 0.15p, Comm 0.06p).
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

def extract_multi_shelves(bars, top_price, bottom_price):
    """
    Shrinks the box in multiple patterns, generating distinct shelves:
    - Initial Fulcrum & Vacuum
    - Upper Shelf: Box top reduced to upper node
    - Lower Shelf: Box bottom reduced to lower node
    - Converged Scratch Corridor
    """
    raw_res = compute_box_fulcrum_vacuum(bars, top_price, bottom_price)
    if not raw_res:
        return []
        
    f0 = raw_res['fulcrum']
    v0 = raw_res['vacuum']
    
    shelves = []
    
    # 1. Core Retest Fulcrum Shelf
    shelves.append({
        'type': 'CORE_FULCRUM',
        'price': f0,
        'upper_bound': top_price,
        'lower_bound': bottom_price
    })
    
    # 2. Zero-Interest Vacuum Shelf
    shelves.append({
        'type': 'VACUUM_VOID',
        'price': v0,
        'upper_bound': top_price,
        'lower_bound': bottom_price
    })
    
    # 3. Upper Reduction Shelf (Top reduced down to upper node)
    upper_node = max(f0, v0)
    res_upper = single_node_thinning_step(bars, top_price, bottom_price, choice_strategy='top_first')
    if res_upper:
        shelves.append({
            'type': 'UPPER_SHELF',
            'price': res_upper['new_fulcrum'],
            'upper_bound': res_upper['new_top'],
            'lower_bound': res_upper['new_bottom']
        })
        
    # 4. Lower Reduction Shelf (Bottom reduced up to lower node)
    lower_node = min(f0, v0)
    res_lower = single_node_thinning_step(bars, top_price, bottom_price, choice_strategy='bottom_first')
    if res_lower:
        shelves.append({
            'type': 'LOWER_SHELF',
            'price': res_lower['new_fulcrum'],
            'upper_bound': res_lower['new_top'],
            'lower_bound': res_lower['new_bottom']
        })
        
    # Deduplicate shelves that are within 0.50p of each other
    unique_shelves = []
    for s in shelves:
        if not any(abs(s['price'] - u['price']) < 0.40 for u in unique_shelves):
            unique_shelves.append(s)
            
    return unique_shelves

def evaluate_orderflow_at_shelves(rates, shelves, start_idx, max_forward=48):
    future_bars = rates[start_idx + 1 : start_idx + 1 + max_forward]
    if len(future_bars) < 5:
        return {'status': 'NO_DATA'}
        
    # Baseline rolling volume
    recent_vols = [b['tick_volume'] for b in rates[start_idx - 10 : start_idx]]
    avg_vol = np.mean(recent_vols) if recent_vols else 1000
    
    triggered = False
    trigger_bar_idx = -1
    active_shelf = None
    pos = None
    fill_entry = 0.0
    initial_sl = 0.0
    risk = 0.0
    
    # Scan forward bar-by-bar across the first 36 bars
    for f_idx in range(min(36, len(future_bars))):
        b = future_bars[f_idx]
        b_range = max(0.01, b['high'] - b['low'])
        b_open = b['open']
        b_close = b['close']
        b_high = b['high']
        b_low = b['low']
        b_vol = b['tick_volume']
        
        lower_wick = min(b_open, b_close) - b_low
        upper_wick = b_high - max(b_open, b_close)
        has_volume = b_vol >= 1.15 * avg_vol
        
        # Test order flow against each unique shelf
        for shelf in shelves:
            sp = shelf['price']
            
            # ORDER FLOW SIGNAL 1: Spring Wick Absorption (BUY)
            # Price sweeps below shelf by >=0.20p, lower wick >= 35%, closes above shelf with volume
            if b_low <= sp - 0.20 and b_close >= sp + 0.15 and (lower_wick / b_range) >= 0.35 and has_volume:
                pos = 'BUY'
                fill_entry = round(b_close + SPREAD_PTS + SLIPPAGE_PTS, 2)
                initial_sl = round(b_low - 0.70 - SLIPPAGE_PTS, 2)
                risk = round(fill_entry - initial_sl, 2)
                if 1.60 <= risk <= 4.20:
                    triggered = True
                    trigger_bar_idx = f_idx
                    active_shelf = shelf
                    break
                    
            # ORDER FLOW SIGNAL 2: Ceiling Wick Distribution (SELL)
            # Price sweeps above shelf by >=0.20p, upper wick >= 35%, closes below shelf with volume
            elif b_high >= sp + 0.20 and b_close <= sp - 0.15 and (upper_wick / b_range) >= 0.35 and has_volume:
                pos = 'SELL'
                fill_entry = round(b_close - SLIPPAGE_PTS, 2)
                initial_sl = round(b_high + 0.70 + SPREAD_PTS + SLIPPAGE_PTS, 2)
                risk = round(initial_sl - fill_entry, 2)
                if 1.60 <= risk <= 4.20:
                    triggered = True
                    trigger_bar_idx = f_idx
                    active_shelf = shelf
                    break
                    
        if triggered:
            break
            
    if not triggered:
        return {'status': 'NO_ORDERFLOW_TRIGGER'}
        
    trade_bars = future_bars[trigger_bar_idx + 1 :]
    if len(trade_bars) == 0:
        return {'status': 'NO_POST_DATA'}
        
    # Scale-out Execution (50% at +4.0p, remaining 50% trailed)
    current_sl = initial_sl
    lot1_closed = False
    lot1_pnl = 0.0
    lot2_closed = False
    lot2_pnl = 0.0
    peak_fav = 0.0
    target_tp1 = (fill_entry + 4.00) if pos == 'BUY' else (fill_entry - 4.00)
    
    for b in trade_bars:
        if pos == 'BUY':
            bid_low = b['low']
            bid_high = b['high']
            fav = bid_high - fill_entry
            if fav > peak_fav: peak_fav = fav
            
            # Pessimistic Stop check
            if bid_low <= current_sl:
                exit_price = current_sl - SLIPPAGE_PTS
                loss = round((exit_price - fill_entry) - COMMISSION_PTS, 2)
                if not lot1_closed: lot1_pnl = loss; lot1_closed = True
                if not lot2_closed: lot2_pnl = loss; lot2_closed = True
                break
                
            # TP1 at +4.0p
            if not lot1_closed and bid_high >= target_tp1:
                lot1_pnl = round(4.00 - SLIPPAGE_PTS - COMMISSION_PTS, 2)
                lot1_closed = True
                current_sl = max(current_sl, fill_entry + 0.30)
                
            # Dynamic trail at >= +8.0p
            if lot1_closed and not lot2_closed and peak_fav >= 8.00:
                current_sl = max(current_sl, round(fill_entry + peak_fav - 3.50, 2))
                
        else: # SELL
            ask_high = b['high'] + SPREAD_PTS
            ask_low = b['low'] + SPREAD_PTS
            fav = fill_entry - ask_low
            if fav > peak_fav: peak_fav = fav
            
            if ask_high >= current_sl:
                exit_price = current_sl + SLIPPAGE_PTS
                loss = round((fill_entry - exit_price) - COMMISSION_PTS, 2)
                if not lot1_closed: lot1_pnl = loss; lot1_closed = True
                if not lot2_closed: lot2_pnl = loss; lot2_closed = True
                break
                
            if not lot1_closed and ask_low <= target_tp1:
                lot1_pnl = round(4.00 - SLIPPAGE_PTS - COMMISSION_PTS, 2)
                lot1_closed = True
                current_sl = min(current_sl, fill_entry - 0.30)
                
            if lot1_closed and not lot2_closed and peak_fav >= 8.00:
                current_sl = min(current_sl, round(fill_entry - (peak_fav - 3.50), 2))

    # Mark to market at session end
    last_b = trade_bars[-1]
    if pos == 'BUY':
        close_pnl = round((last_b['close'] - fill_entry) - COMMISSION_PTS, 2)
    else:
        close_pnl = round((fill_entry - (last_b['close'] + SPREAD_PTS)) - COMMISSION_PTS, 2)
        
    if not lot1_closed: lot1_pnl = close_pnl
    if not lot2_closed: lot2_pnl = close_pnl
    
    blended_net = round(0.5 * lot1_pnl + 0.5 * lot2_pnl, 2)
    
    return {
        'status': 'TRADE_EXECUTED',
        'shelf_type': active_shelf['type'],
        'shelf_price': active_shelf['price'],
        'direction': pos,
        'entry': fill_entry,
        'sl': initial_sl,
        'risk': risk,
        'peak_fav': round(peak_fav, 2),
        'lot1_pnl': lot1_pnl,
        'lot2_pnl': lot2_pnl,
        'blended_net': blended_net,
        'is_win': blended_net > 0,
        'hit_tp1': lot1_closed and lot1_pnl > 0,
        'win_10p': peak_fav >= 10.0,
        'win_15p': peak_fav >= 15.0
    }

def run_multi_shelf_slice(rates_slice, slice_name):
    trades = []
    last_idx = -100
    candidate_boxes = 0
    
    for idx in range(80, len(rates_slice) - 60, 6):
        if idx - last_idx < 15: continue
        
        # Check active session (06:00 to 20:00 UTC)
        dt = datetime.datetime.fromtimestamp(rates_slice[idx]['time'], datetime.timezone.utc)
        if dt.hour >= 21 or (dt.hour == 23 and dt.minute < 15) or dt.hour < 5:
            continue
            
        window = rates_slice[idx - 28 : idx + 1]
        w_high = max(b['high'] for b in window)
        w_low = min(b['low'] for b in window)
        w_range = w_high - w_low
        
        # Consolidation check (dynamic range window)
        if not (10.0 <= w_range <= 35.0):
            continue
            
        candidate_boxes += 1
        last_idx = idx
        
        # Extract MULTI-SHELVED reduction patterns
        shelves = extract_multi_shelves(window, w_high, w_low)
        if not shelves:
            continue
            
        sim = evaluate_orderflow_at_shelves(rates_slice, shelves, idx, max_forward=60)
        if sim['status'] == 'TRADE_EXECUTED':
            trades.append({
                'time': dt,
                'sim': sim
            })
            
    n = len(trades)
    if n == 0:
        return {'name': slice_name, 'n': 0, 'candidates': candidate_boxes, 'win_rate': 0, 'pf': 0, 'total_net': 0, 'avg_win': 0, 'avg_loss': 0, 'trades': []}
        
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
        'candidates': candidate_boxes,
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

def run_multi_shelf_audit():
    mt5.initialize()
    total_bars = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 15000)
    print(f"Loaded {len(total_bars)} M5 bars across ~85 trading days.")
    print(f"Friction: Spread={SPREAD_PTS}p | Slippage={SLIPPAGE_PTS}p | Comm={COMMISSION_PTS}p | Total Friction={TOTAL_FRICTION:.2f}p")
    
    slice1 = total_bars[10000:]
    dt1_s = datetime.datetime.fromtimestamp(slice1[0]['time'])
    dt1_e = datetime.datetime.fromtimestamp(slice1[-1]['time'])
    
    slice2 = total_bars[5000:10000]
    dt2_s = datetime.datetime.fromtimestamp(slice2[0]['time'])
    dt2_e = datetime.datetime.fromtimestamp(slice2[-1]['time'])
    
    slice3 = total_bars[0:5000]
    dt3_s = datetime.datetime.fromtimestamp(slice3[0]['time'])
    dt3_e = datetime.datetime.fromtimestamp(slice3[-1]['time'])
    
    res1 = run_multi_shelf_slice(slice1, f"Slice 1 [Recent: {dt1_s.strftime('%b %d')} - {dt1_e.strftime('%b %d')}]")
    res2 = run_multi_shelf_slice(slice2, f"Slice 2 [Out-of-Sample: {dt2_s.strftime('%b %d')} - {dt2_e.strftime('%b %d')}]")
    res3 = run_multi_shelf_slice(slice3, f"Slice 3 [Out-of-Sample: {dt3_s.strftime('%b %d')} - {dt3_e.strftime('%b %d')}]")
    
    print("\n" + "="*105)
    print("MULTI-SHELF REDUCTION & ORDER FLOW REALITY MATRIX (ACROSS ALL 3 SLICES)")
    print("="*105)
    print(f"{'Market Slice':<42} | {'Trades':<6} | {'Win Rate':<9} | {'Profit Factor':<13} | {'Avg Winner':<10} | {'Avg Scratch':<11} | {'Net PnL (Pts)':<12}")
    print("-" * 105)
    
    for r in [res1, res2, res3]:
        print(f"{r['name']:<42} | {r['n']:<6} | {r['win_rate']:5.1f}%   | {r['pf']:5.2f}         | +{r['avg_win']:4.2f} pts   | -{r['avg_loss']:4.2f} pts   | {r['total_net']:+7.2f} pts")
        
    print("-" * 105)
    
    all_trades = res1['trades'] + res2['trades'] + res3['trades']
    tot_n = len(all_trades)
    tot_w = [t for t in all_trades if t['sim']['is_win']]
    tot_l = [t for t in all_trades if not t['sim']['is_win']]
    tot_pnl = sum(t['sim']['blended_net'] for t in all_trades)
    tot_win_pts = sum(t['sim']['blended_net'] for t in tot_w)
    tot_loss_pts = sum(abs(t['sim']['blended_net']) for t in tot_l)
    tot_pf = (tot_win_pts / tot_loss_pts) if tot_loss_pts > 0 else 999.0
    
    print(f"{'OVERALL COMBINED (15,000 M5 BARS / 3 MO)':<42} | {tot_n:<6} | {len(tot_w)/tot_n*100:5.1f}%   | {tot_pf:5.2f}         | +{np.mean([t['sim']['blended_net'] for t in tot_w]):4.2f} pts   | -{np.mean([abs(t['sim']['blended_net']) for t in tot_l]):4.2f} pts   | {tot_pnl:+7.2f} pts")
    print("="*105)
    
    # Analyze by Shelf Type: Where did the winning shelves originate?
    shelf_groups = {}
    for t in all_trades:
        st = t['sim']['shelf_type']
        if st not in shelf_groups: shelf_groups[st] = []
        shelf_groups[st].append(t['sim'])
        
    print("\n" + "="*85)
    print("SHELF ORIGIN BREAKDOWN (WHICH REDUCED SHELVES GENERATED THE PROFIT?)")
    print("="*85)
    print(f"{'Shelf Type':<25} | {'Trades':<8} | {'Win Rate':<10} | {'Profit Factor':<14} | {'Net PnL':<10}")
    print("-" * 85)
    for st, sim_list in shelf_groups.items():
        sn = len(sim_list)
        sw = [s for s in sim_list if s['is_win']]
        sl = [s for s in sim_list if not s['is_win']]
        s_pnl = sum(s['blended_net'] for s in sim_list)
        s_win_pts = sum(s['blended_net'] for s in sw)
        s_loss_pts = sum(abs(s['blended_net']) for s in sl)
        s_pf = (s_win_pts / s_loss_pts) if s_loss_pts > 0 else 999.0
        print(f"{st:<25} | {sn:<8} | {len(sw)/sn*100:5.1f}%    | {s_pf:5.2f}          | {s_pnl:+6.2f} pts")
    print("="*85)

if __name__ == '__main__':
    run_multi_shelf_audit()
