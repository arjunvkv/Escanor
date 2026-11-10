"""
REFINED MULTI-SHELF ORDER FLOW SYSTEM (VACUUM VOID AS TARGET RUNWAY, NOT BOUNCE)
Key Corrections:
1. Entry Shelves: Upper Shelf (Distribution Rejections) & Lower Shelf / Core Fulcrum (Absorption Bounces).
2. Vacuum Void is the TARGET RUNWAY (Price accelerates through it towards opposite shelf).
3. Evaluates with full live broker friction (0.59p total: Spread 0.38p, Slippage 0.15p, Comm 0.06p) across all 3 slices (15,000 M5 bars).
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

def extract_structural_shelves(bars, top_price, bottom_price):
    raw_res = compute_box_fulcrum_vacuum(bars, top_price, bottom_price)
    if not raw_res:
        return []
    f0 = raw_res['fulcrum']
    v0 = raw_res['vacuum']
    
    shelves = []
    
    # 1. Core Fulcrum (Retest Axis)
    shelves.append({'type': 'CORE_FULCRUM', 'price': f0, 'target': v0})
    
    # 2. Upper Reduction Shelf (Top reduced to upper node)
    res_upper = single_node_thinning_step(bars, top_price, bottom_price, choice_strategy='top_first')
    if res_upper:
        shelves.append({'type': 'UPPER_SHELF', 'price': res_upper['new_fulcrum'], 'target': res_upper['new_vacuum']})
        
    # 3. Lower Reduction Shelf (Bottom reduced to lower node)
    res_lower = single_node_thinning_step(bars, top_price, bottom_price, choice_strategy='bottom_first')
    if res_lower:
        shelves.append({'type': 'LOWER_SHELF', 'price': res_lower['new_fulcrum'], 'target': res_lower['new_vacuum']})
        
    unique = []
    for s in shelves:
        if not any(abs(s['price'] - u['price']) < 0.45 for u in unique):
            unique.append(s)
    return unique

def evaluate_refined_orderflow(rates, shelves, start_idx, max_forward=60):
    future_bars = rates[start_idx + 1 : start_idx + 1 + max_forward]
    if len(future_bars) < 5:
        return {'status': 'NO_DATA'}
        
    recent_vols = [b['tick_volume'] for b in rates[start_idx - 10 : start_idx]]
    avg_vol = np.mean(recent_vols) if recent_vols else 1000
    
    triggered = False
    trigger_idx = -1
    active_shelf = None
    pos = None
    fill_entry = 0.0
    initial_sl = 0.0
    risk = 0.0
    
    for f_idx in range(min(36, len(future_bars))):
        b = future_bars[f_idx]
        b_range = max(0.01, b['high'] - b['low'])
        lower_wick = min(b['open'], b['close']) - b['low']
        upper_wick = b['high'] - max(b['open'], b['close'])
        has_volume = b['tick_volume'] >= 1.15 * avg_vol
        
        for shelf in shelves:
            sp = shelf['price']
            
            # AT UPPER SHELF: Look for BEARISH DISTRIBUTION (SELL)
            if shelf['type'] in ['UPPER_SHELF', 'CORE_FULCRUM']:
                if b['high'] >= sp + 0.20 and b['close'] <= sp - 0.15 and (upper_wick / b_range) >= 0.35 and has_volume:
                    pos = 'SELL'
                    fill_entry = round(b['close'] - SLIPPAGE_PTS, 2)
                    initial_sl = round(b['high'] + 0.70 + SPREAD_PTS + SLIPPAGE_PTS, 2)
                    risk = round(initial_sl - fill_entry, 2)
                    if 1.60 <= risk <= 4.20:
                        triggered = True
                        trigger_idx = f_idx
                        active_shelf = shelf
                        break
                        
            # AT LOWER SHELF: Look for BULLISH ABSORPTION (BUY)
            if shelf['type'] in ['LOWER_SHELF', 'CORE_FULCRUM']:
                if b['low'] <= sp - 0.20 and b['close'] >= sp + 0.15 and (lower_wick / b_range) >= 0.35 and has_volume:
                    pos = 'BUY'
                    fill_entry = round(b['close'] + SPREAD_PTS + SLIPPAGE_PTS, 2)
                    initial_sl = round(b['low'] - 0.70 - SLIPPAGE_PTS, 2)
                    risk = round(fill_entry - initial_sl, 2)
                    if 1.60 <= risk <= 4.20:
                        triggered = True
                        trigger_idx = f_idx
                        active_shelf = shelf
                        break
                        
        if triggered:
            break
            
    if not triggered:
        return {'status': 'NO_TRIGGER'}
        
    trade_bars = future_bars[trigger_idx + 1 :]
    if len(trade_bars) == 0:
        return {'status': 'NO_POST_DATA'}
        
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
            
            if bid_low <= current_sl:
                loss = round((current_sl - SLIPPAGE_PTS - fill_entry) - COMMISSION_PTS, 2)
                if not lot1_closed: lot1_pnl = loss; lot1_closed = True
                if not lot2_closed: lot2_pnl = loss; lot2_closed = True
                break
                
            if not lot1_closed and bid_high >= target_tp1:
                lot1_pnl = round(4.00 - SLIPPAGE_PTS - COMMISSION_PTS, 2)
                lot1_closed = True
                current_sl = max(current_sl, fill_entry + 0.30)
                
            if lot1_closed and not lot2_closed and peak_fav >= 8.00:
                current_sl = max(current_sl, round(fill_entry + peak_fav - 3.50, 2))
                
        else: # SELL
            ask_high = b['high'] + SPREAD_PTS
            ask_low = b['low'] + SPREAD_PTS
            fav = fill_entry - ask_low
            if fav > peak_fav: peak_fav = fav
            
            if ask_high >= current_sl:
                loss = round((fill_entry - (current_sl + SLIPPAGE_PTS)) - COMMISSION_PTS, 2)
                if not lot1_closed: lot1_pnl = loss; lot1_closed = True
                if not lot2_closed: lot2_pnl = loss; lot2_closed = True
                break
                
            if not lot1_closed and ask_low <= target_tp1:
                lot1_pnl = round(4.00 - SLIPPAGE_PTS - COMMISSION_PTS, 2)
                lot1_closed = True
                current_sl = min(current_sl, fill_entry - 0.30)
                
            if lot1_closed and not lot2_closed and peak_fav >= 8.00:
                current_sl = min(current_sl, round(fill_entry - (peak_fav - 3.50), 2))

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
        'direction': pos,
        'entry': fill_entry,
        'sl': initial_sl,
        'risk': risk,
        'peak_fav': round(peak_fav, 2),
        'blended_net': blended_net,
        'is_win': blended_net > 0,
        'hit_tp1': lot1_closed and lot1_pnl > 0,
        'win_10p': peak_fav >= 10.0
    }

def run_slice(rates_slice, slice_name):
    trades = []
    last_idx = -100
    for idx in range(80, len(rates_slice) - 60, 6):
        if idx - last_idx < 15: continue
        dt = datetime.datetime.fromtimestamp(rates_slice[idx]['time'], datetime.timezone.utc)
        if dt.hour >= 21 or (dt.hour == 23 and dt.minute < 15) or dt.hour < 5: continue
        window = rates_slice[idx - 28 : idx + 1]
        w_range = max(b['high'] for b in window) - min(b['low'] for b in window)
        if not (10.0 <= w_range <= 35.0): continue
        last_idx = idx
        shelves = extract_structural_shelves(window, max(b['high'] for b in window), min(b['low'] for b in window))
        sim = evaluate_refined_orderflow(rates_slice, shelves, idx, max_forward=60)
        if sim['status'] == 'TRADE_EXECUTED':
            trades.append({'time': dt, 'sim': sim})
            
    n = len(trades)
    if n == 0:
        return {'name': slice_name, 'n': 0, 'win_rate': 0, 'pf': 0, 'total_net': 0, 'avg_win': 0, 'avg_loss': 0, 'trades': []}
    wins = [t for t in trades if t['sim']['is_win']]
    losses = [t for t in trades if not t['sim']['is_win']]
    total_net = sum(t['sim']['blended_net'] for t in trades)
    tot_win = sum(t['sim']['blended_net'] for t in wins)
    tot_loss = sum(abs(t['sim']['blended_net']) for t in losses)
    pf = (tot_win / tot_loss) if tot_loss > 0 else 999.0
    avg_win = np.mean([t['sim']['blended_net'] for t in wins]) if wins else 0
    avg_loss = np.mean([abs(t['sim']['blended_net']) for t in losses]) if losses else 0
    return {
        'name': slice_name,
        'n': n,
        'win_rate': len(wins) / n * 100,
        'pf': pf,
        'total_net': total_net,
        'avg_win': avg_win,
        'avg_loss': avg_loss,
        'trades': trades
    }

def main():
    mt5.initialize()
    total_bars = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 15000)
    slice1 = total_bars[10000:]
    slice2 = total_bars[5000:10000]
    slice3 = total_bars[0:5000]
    
    r1 = run_slice(slice1, "Slice 1 [Recent: Oct 09 - Nov 05]")
    r2 = run_slice(slice2, "Slice 2 [Out-of-Sample: Sep 15 - Oct 09]")
    r3 = run_slice(slice3, "Slice 3 [Out-of-Sample: Aug 20 - Sep 15]")
    
    print("\n" + "="*105)
    print("REFINED MULTI-SHELF MATRIX: STRUCTURAL SHELVES + ORDER FLOW REALITY (15,000 BARS)")
    print("="*105)
    print(f"{'Market Slice':<42} | {'Trades':<6} | {'Win Rate':<9} | {'Profit Factor':<13} | {'Avg Winner':<10} | {'Avg Scratch':<11} | {'Net PnL (Pts)':<12}")
    print("-" * 105)
    for r in [r1, r2, r3]:
        print(f"{r['name']:<42} | {r['n']:<6} | {r['win_rate']:5.1f}%   | {r['pf']:5.2f}         | +{r['avg_win']:4.2f} pts   | -{r['avg_loss']:4.2f} pts   | {r['total_net']:+7.2f} pts")
    print("-" * 105)
    
    all_t = r1['trades'] + r2['trades'] + r3['trades']
    all_w = [t for t in all_t if t['sim']['is_win']]
    all_l = [t for t in all_t if not t['sim']['is_win']]
    tot_pnl = sum(t['sim']['blended_net'] for t in all_t)
    tot_w_pts = sum(t['sim']['blended_net'] for t in all_w)
    tot_l_pts = sum(abs(t['sim']['blended_net']) for t in all_l)
    tot_pf = (tot_w_pts / tot_l_pts) if tot_l_pts > 0 else 999.0
    print(f"{'OVERALL COMBINED (15,000 M5 BARS / 3 MO)':<42} | {len(all_t):<6} | {len(all_w)/len(all_t)*100:5.1f}%   | {tot_pf:5.2f}         | +{np.mean([t['sim']['blended_net'] for t in all_w]):4.2f} pts   | -{np.mean([abs(t['sim']['blended_net']) for t in all_l]):4.2f} pts   | {tot_pnl:+7.2f} pts")
    print("="*105)

if __name__ == '__main__':
    main()
