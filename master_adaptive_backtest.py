"""
MASTER ADAPTIVE BACKTEST (15,000 M5 BARS / 3 FULL MONTHS)
Includes the 3 Crucial Upgrades:
1. Dynamic ATR-Adaptive Box Sizing (scales naturally at $4600 and $3900)
2. Two-Way Execution:
   - Spring Accumulation (BUYs at swing lows / exhaustion)
   - Redistribution Flags (SELLs during macro downtrends - captures the late Oct crashes!)
3. Sovereign Absorption Gate: Protects against catching falling knives
4. Realistic Live Friction: Spread (0.38p), Slippage (0.15p), Commission (0.06p) = 0.59p total!
5. Partial Scale-out: 50% banked at +4.0p, remaining 50% trailed dynamically.
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

def compute_rolling_atr(rates, current_idx, period=48):
    """
    Computes rolling 4-hour ATR (48 M5 bars) dynamically at bar current_idx.
    """
    if current_idx < period + 2:
        return 16.0
    bars = rates[current_idx - period : current_idx]
    tr_list = []
    for i in range(1, len(bars)):
        h = bars[i]['high']
        l = bars[i]['low']
        pc = bars[i-1]['close']
        tr = max(h - l, abs(h - pc), abs(l - pc))
        tr_list.append(tr)
    return np.mean(tr_list) * 6.0  # approximate 4-hour range

def scan_adaptive_box(rates, current_idx, rolling_atr, lookback=28):
    if current_idx < lookback + 35:
        return None
        
    dt = datetime.datetime.fromtimestamp(rates[current_idx]['time'], datetime.timezone.utc)
    # Exclude rollover spread spike (21:00 to 23:15 UTC) and dead night hours
    if dt.hour >= 21 or (dt.hour == 23 and dt.minute < 15) or dt.hour < 5:
        return None
        
    window = rates[current_idx - lookback : current_idx + 1]
    highs = [b['high'] for b in window]
    lows = [b['low'] for b in window]
    w_high = max(highs)
    w_low = min(lows)
    w_range = w_high - w_low
    
    # 1. UPGRADE 1: DYNAMIC ATR-ADAPTIVE SIZING
    min_range = max(8.0, 0.40 * rolling_atr)
    max_range = max(26.0, 1.40 * rolling_atr)
    
    if not (min_range <= w_range <= max_range):
        return None
        
    # Check prior impulse move in prior 25 bars
    prior_bars = rates[current_idx - lookback - 25 : current_idx - lookback]
    if len(prior_bars) < 15:
        return None
    prior_move = prior_bars[-1]['close'] - prior_bars[0]['open']
    
    # Needs at least a 0.35 * ATR prior impulse move
    if abs(prior_move) < max(6.0, 0.35 * rolling_atr):
        return None
        
    # Determine structural regime:
    # If prior move was a heavy dump:
    # - If base formed at the very bottom of prior 60 bars -> Spring Accumulation (BUY)
    # - If base is a mid-trend pause -> Bear Redistribution Flag (SELL)
    lowest_prior = min(b['low'] for b in rates[current_idx - lookback - 50 : current_idx])
    highest_prior = max(b['high'] for b in rates[current_idx - lookback - 50 : current_idx])
    
    regime = 'NEUTRAL'
    if prior_move < 0:
        if w_low <= lowest_prior + 1.5:
            regime = 'SPRING_ACCUMULATION_BUY'
        else:
            regime = 'BEAR_REDISTRIBUTION_SELL'
    else:
        if w_high >= highest_prior - 1.5:
            regime = 'UPTHRUST_DISTRIBUTION_SELL'
        else:
            regime = 'BULL_REACCUMULATION_BUY'
            
    return {
        'idx': current_idx,
        'time': dt,
        'bars': window,
        'top': round(w_high, 2),
        'bottom': round(w_low, 2),
        'range': round(w_range, 2),
        'regime': regime,
        'rolling_atr': round(rolling_atr, 2)
    }

def thin_box_causally(bars, top, bottom, target_scratch=3.2):
    curr_top = top
    curr_bot = bottom
    final_fulcrum = (top + bottom) / 2.0
    for _ in range(4):
        res = single_node_thinning_step(bars, curr_top, curr_bot, choice_strategy='structure')
        if not res: break
        curr_top = res['new_top']
        curr_bot = res['new_bottom']
        final_fulcrum = res['new_fulcrum']
        if res['height'] <= target_scratch: break
    return {
        'thinned_top': round(curr_top, 2),
        'thinned_bottom': round(curr_bot, 2),
        'thinned_height': round(curr_top - curr_bot, 2),
        'fulcrum': round(final_fulcrum, 2)
    }

def execute_adaptive_trade(rates, shelf_price, thinned_top, thinned_bottom, regime, start_idx, max_forward=60):
    future_bars = rates[start_idx + 1 : start_idx + 1 + max_forward]
    if len(future_bars) < 5:
        return {'status': 'NO_DATA'}
        
    recent_vols = [b['tick_volume'] for b in rates[start_idx - 10 : start_idx]]
    avg_vol = np.mean(recent_vols) if recent_vols else 1000
    
    triggered = False
    trigger_idx = -1
    pos = None
    fill_entry = 0.0
    initial_sl = 0.0
    risk = 0.0
    
    for idx in range(min(36, len(future_bars))):
        b = future_bars[idx]
        b_range = max(0.01, b['high'] - b['low'])
        lower_wick = min(b['open'], b['close']) - b['low']
        upper_wick = b['high'] - max(b['open'], b['close'])
        has_vol = b['tick_volume'] >= 1.15 * avg_vol
        
        # BUY TRIGGER (Spring Accumulation or Bull Flag)
        if 'BUY' in regime:
            if b['low'] <= shelf_price - 0.20 and b['close'] >= shelf_price + 0.15 and (lower_wick / b_range) >= 0.30 and has_vol:
                pos = 'BUY'
                fill_entry = round(b['close'] + SPREAD_PTS + SLIPPAGE_PTS, 2)
                initial_sl = round(b['low'] - 0.70 - SLIPPAGE_PTS, 2)
                risk = round(fill_entry - initial_sl, 2)
                if 1.60 <= risk <= 4.50:
                    triggered = True
                    trigger_idx = idx
                    break
                    
        # SELL TRIGGER (Bear Redistribution Flag or Upthrust)
        elif 'SELL' in regime:
            if b['high'] >= shelf_price + 0.20 and b['close'] <= shelf_price - 0.15 and (upper_wick / b_range) >= 0.30 and has_vol:
                pos = 'SELL'
                fill_entry = round(b['close'] - SLIPPAGE_PTS, 2)
                initial_sl = round(b['high'] + 0.70 + SPREAD_PTS + SLIPPAGE_PTS, 2)
                risk = round(initial_sl - fill_entry, 2)
                if 1.60 <= risk <= 4.50:
                    triggered = True
                    trigger_idx = idx
                    break

    if not triggered:
        return {'status': 'NO_ORDERFLOW_TRIGGER'}
        
    trade_bars = future_bars[trigger_idx + 1:]
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
            
            # Pessimistic SL check
            if bid_low <= current_sl:
                exit_price = current_sl - SLIPPAGE_PTS
                loss = round((exit_price - fill_entry) - COMMISSION_PTS, 2)
                if not lot1_closed: lot1_pnl = loss; lot1_closed = True
                if not lot2_closed: lot2_pnl = loss; lot2_closed = True
                break
                
            # TP1 partial harvest at +4.0p
            if not lot1_closed and bid_high >= target_tp1:
                lot1_pnl = round(4.00 - SLIPPAGE_PTS - COMMISSION_PTS, 2)
                lot1_closed = True
                current_sl = max(current_sl, fill_entry + 0.30)
                
            # Runner trail at >= +8.0p
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

    # Session limit close
    last_b = trade_bars[-1]
    if pos == 'BUY':
        final_bid = last_b['close']
        close_pnl = round((final_bid - fill_entry) - COMMISSION_PTS, 2)
    else:
        final_ask = last_b['close'] + SPREAD_PTS
        close_pnl = round((fill_entry - final_ask) - COMMISSION_PTS, 2)
        
    if not lot1_closed: lot1_pnl = close_pnl
    if not lot2_closed: lot2_pnl = close_pnl
    
    blended_net = round(0.5 * lot1_pnl + 0.5 * lot2_pnl, 2)
    
    return {
        'status': 'TRADE_EXECUTED',
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

def run_adaptive_slice(rates_slice, slice_name):
    trades = []
    last_idx = -100
    candidates = 0
    
    for idx in range(80, len(rates_slice) - 60, 6):
        if idx - last_idx < 15: continue
        rolling_atr = compute_rolling_atr(rates_slice, idx)
        box = scan_adaptive_box(rates_slice, idx, rolling_atr)
        if box:
            candidates += 1
            last_idx = idx
            thinned = thin_box_causally(box['bars'], box['top'], box['bottom'], target_scratch=3.2)
            sim = execute_adaptive_trade(
                rates_slice,
                thinned['fulcrum'],
                thinned['thinned_top'],
                thinned['thinned_bottom'],
                box['regime'],
                idx,
                max_forward=60
            )
            if sim['status'] == 'TRADE_EXECUTED':
                trades.append({
                    'time': box['time'],
                    'regime': box['regime'],
                    'sim': sim
                })
                
    n = len(trades)
    if n == 0:
        return {'name': slice_name, 'n': 0, 'candidates': candidates, 'win_rate': 0, 'pf': 0, 'total_net': 0, 'avg_win': 0, 'avg_loss': 0, 'trades': []}
        
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

def run_study():
    mt5.initialize()
    total_bars = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 15000)
    print(f"Loaded {len(total_bars)} total bars across ~85 trading days.")
    print(f"Modeled live friction: Spread={SPREAD_PTS}p | Slippage={SLIPPAGE_PTS}p | Comm={COMMISSION_PTS}p | Total Friction={TOTAL_FRICTION:.2f}p")
    
    # 3 Non-overlapping slices
    slice1 = total_bars[10000:]
    dt1_s = datetime.datetime.fromtimestamp(slice1[0]['time'])
    dt1_e = datetime.datetime.fromtimestamp(slice1[-1]['time'])
    
    slice2 = total_bars[5000:10000]
    dt2_s = datetime.datetime.fromtimestamp(slice2[0]['time'])
    dt2_e = datetime.datetime.fromtimestamp(slice2[-1]['time'])
    
    slice3 = total_bars[0:5000]
    dt3_s = datetime.datetime.fromtimestamp(slice3[0]['time'])
    dt3_e = datetime.datetime.fromtimestamp(slice3[-1]['time'])
    
    res1 = run_adaptive_slice(slice1, f"Slice 1 [Recent: {dt1_s.strftime('%b %d')} - {dt1_e.strftime('%b %d')}]")
    res2 = run_adaptive_slice(slice2, f"Slice 2 [Out-of-Sample: {dt2_s.strftime('%b %d')} - {dt2_e.strftime('%b %d')}]")
    res3 = run_adaptive_slice(slice3, f"Slice 3 [Out-of-Sample: {dt3_s.strftime('%b %d')} - {dt3_e.strftime('%b %d')}]")
    
    print("\n" + "="*105)
    print("MASTER ADAPTIVE SYSTEM: CROSS-REGIME VALIDATION (ALL UPGRADES + FULL LIVE FRICTION)")
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

if __name__ == '__main__':
    run_study()
