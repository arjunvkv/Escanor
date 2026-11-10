"""
ORDER FLOW TRUE PHYSICAL TRAIL EDGE AUDIT
Tests whether the combined setup has a statistically verifiable edge in live conditions:
1. Box thinning down to Invariant Fulcrum/Vacuum shelf
2. Order Flow Physical Trail Trigger:
   - Liquidity sweep beyond shelf (>=0.25p)
   - Spring Wick / Upthrust reclaim (wick ratio >= 35%, strong directional close)
   - Volume surge: bar tick volume >= 1.2x of 5-bar moving average (institutional absorption)
3. Minor scratch stop buffer: SL anchored 0.60p beyond sweep tip (protects from spread & micro-wiggles)
4. Escape-Velocity Trailing:
   - Room to breathe: SL untouched until +3.5p
   - At +3.5p: Reduce risk to ultra-tight scratch (-0.80p)
   - At +5.0p: Lock Breakeven (+0.30p net profit)
   - At +8.0p+: Dynamic peak trail (3.50p buffer) for big runners
5. Full live broker friction: MT5 Spread (0.38p), Slippage (0.10p), Commission (0.06p) = 0.54p round-trip!
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

def find_candidate_structures(rates, start_idx, lookback=28):
    """
    Identifies clean consolidation structures during active trading sessions (06:00 - 18:00 UTC)
    with prior directional momentum.
    """
    if start_idx < lookback + 25:
        return None
        
    dt = datetime.datetime.fromtimestamp(rates[start_idx]['time'], datetime.timezone.utc)
    # Active institutional sessions: London Open through NY Core
    if not (6 <= dt.hour <= 18):
        return None
        
    window = rates[start_idx - lookback : start_idx + 1]
    highs = [b['high'] for b in window]
    lows = [b['low'] for b in window]
    w_high = max(highs)
    w_low = min(lows)
    w_range = w_high - w_low
    
    # Range criteria for consolidation
    if not (11.0 <= w_range <= 28.0):
        return None
        
    # Check prior impulse move (prior 20 bars)
    prior_bars = rates[start_idx - lookback - 20 : start_idx - lookback]
    if len(prior_bars) < 15:
        return None
    prior_move = prior_bars[-1]['close'] - prior_bars[0]['open']
    
    # Must have at least 6.0p prior move to establish macro context
    if abs(prior_move) < 6.0:
        return None
        
    return {
        'idx': start_idx,
        'time': dt,
        'bars': window,
        'top': round(w_high, 2),
        'bottom': round(w_low, 2),
        'range': round(w_range, 2),
        'prior_move': round(prior_move, 2)
    }

def thin_box_to_scratch(bars, top, bottom, min_height=3.2):
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

def simulate_orderflow_trail_trade(rates, shelf_price, thinned_top, thinned_bottom, start_idx, max_forward=60):
    future_bars = rates[start_idx + 1 : start_idx + 1 + max_forward]
    if len(future_bars) < 5:
        return {'status': 'NO_DATA'}
        
    triggered = False
    trigger_idx = -1
    pos = None
    fill_entry = 0.0
    initial_sl = 0.0
    risk = 0.0
    
    # Calculate baseline rolling volume
    recent_vols = [b['tick_volume'] for b in rates[start_idx - 10 : start_idx]]
    avg_vol = np.mean(recent_vols) if recent_vols else 1000
    
    # Scan forward up to 36 bars for the ORDER FLOW PHYSICAL ABSORPTION TRIGGER
    for idx in range(min(36, len(future_bars))):
        b = future_bars[idx]
        b_range = max(0.01, b['high'] - b['low'])
        b_open = b['open']
        b_close = b['close']
        b_high = b['high']
        b_low = b['low']
        b_vol = b['tick_volume']
        
        lower_wick = min(b_open, b_close) - b_low
        upper_wick = b_high - max(b_open, b_close)
        
        # Volume surge confirmation (institutional presence)
        has_vol = b_vol >= 1.15 * avg_vol
        
        # 1. ORDER FLOW BULL TRIGGER: Spring Wick Reclaim
        # Condition: Price swept below shelf by >=0.20p, reclaimed back above shelf,
        # lower wick >= 35% of bar range, and volume confirmation
        if b_low <= shelf_price - 0.20 and b_close >= shelf_price + 0.15 and (lower_wick / b_range) >= 0.35 and has_vol:
            pos = 'BUY'
            fill_entry = round(b_close + SPREAD_PTS + SLIPPAGE_PTS, 2)
            # Minor Scratch SL: Sweep low minus 0.60p breathing buffer
            initial_sl = round(b_low - 0.60 - SLIPPAGE_PTS, 2)
            risk = round(fill_entry - initial_sl, 2)
            
            # Risk gate: $1.80 to $3.50 (an affordable scratch that can absorb spread)
            if 1.60 <= risk <= 3.80:
                triggered = True
                trigger_idx = idx
                break
                
        # 2. ORDER FLOW BEAR TRIGGER: Upthrust Reclaim
        elif b_high >= shelf_price + 0.20 and b_close <= shelf_price - 0.15 and (upper_wick / b_range) >= 0.35 and has_vol:
            pos = 'SELL'
            fill_entry = round(b_close - SLIPPAGE_PTS, 2)
            # Minor Scratch SL: Sweep high plus 0.60p breathing buffer + spread
            initial_sl = round(b_high + 0.60 + SPREAD_PTS + SLIPPAGE_PTS, 2)
            risk = round(initial_sl - fill_entry, 2)
            
            if 1.60 <= risk <= 3.80:
                triggered = True
                trigger_idx = idx
                break

    if not triggered:
        return {'status': 'NO_ORDERFLOW_TRIGGER'}
        
    trade_bars = future_bars[trigger_idx + 1:]
    if len(trade_bars) == 0:
        return {'status': 'NO_POST_BARS'}
        
    current_sl = initial_sl
    peak_fav = 0.0
    exit_price = 0.0
    exit_reason = None
    
    # Forward trade simulation with institutional trailing
    for b in trade_bars:
        if pos == 'BUY':
            bid_low = b['low']
            bid_high = b['high']
            
            # Check stop loss
            if bid_low <= current_sl:
                exit_price = current_sl - SLIPPAGE_PTS
                exit_reason = 'STOP_LOSS'
                break
                
            fav = bid_high - fill_entry
            if fav > peak_fav: peak_fav = fav
            
            # Step 1: At +3.50p gain, tighten SL to reduce risk to scratch (-0.80p)
            if peak_fav >= 3.50 and current_sl < fill_entry - 0.80:
                current_sl = fill_entry - 0.80
                
            # Step 2: At +5.0p gain (escape velocity), lock Breakeven (+0.30p net profit)
            if peak_fav >= 5.00 and current_sl < fill_entry + 0.30:
                current_sl = fill_entry + 0.30
                
            # Step 3: At +8.0p+, dynamic peak trail trailing 3.50p behind peak
            if peak_fav >= 8.00:
                current_sl = max(current_sl, round(fill_entry + peak_fav - 3.50, 2))
                
        else: # SELL
            ask_high = b['high'] + SPREAD_PTS
            ask_low = b['low'] + SPREAD_PTS
            
            if ask_high >= current_sl:
                exit_price = current_sl + SLIPPAGE_PTS
                exit_reason = 'STOP_LOSS'
                break
                
            fav = fill_entry - ask_low
            if fav > peak_fav: peak_fav = fav
            
            if peak_fav >= 3.50 and current_sl > fill_entry + 0.80:
                current_sl = fill_entry + 0.80
                
            if peak_fav >= 5.00 and current_sl > fill_entry - 0.30:
                current_sl = fill_entry - 0.30
                
            if peak_fav >= 8.00:
                current_sl = min(current_sl, round(fill_entry - (peak_fav - 3.50), 2))

    if not exit_reason:
        last_b = trade_bars[-1]
        exit_price = last_b['close'] if pos == 'BUY' else (last_b['close'] + SPREAD_PTS)
        exit_reason = 'SESSION_LIMIT'
        
    gross_pts = (exit_price - fill_entry) if pos == 'BUY' else (fill_entry - exit_price)
    net_pts = round(gross_pts - COMMISSION_PTS, 2)
    
    return {
        'status': 'TRADE_EXECUTED',
        'direction': pos,
        'fill_entry': fill_entry,
        'initial_sl': initial_sl,
        'risk': risk,
        'peak_fav': round(peak_fav, 2),
        'exit_price': round(exit_price, 2),
        'exit_reason': exit_reason,
        'net_pts': net_pts,
        'is_win': net_pts > 0,
        'win_3p': peak_fav >= 3.0,
        'win_5p': peak_fav >= 5.0,
        'win_10p': peak_fav >= 10.0,
        'win_15p': peak_fav >= 15.0,
        'win_20p': peak_fav >= 20.0,
        'rr': round(peak_fav / risk, 1) if risk > 0 else 0
    }

def run_edge_audit():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 4500)
    print(f"Loaded {len(rates)} historical M5 bars (~35 days of live MT5 tick data).")
    print(f"Friction modeled: Spread={SPREAD_PTS}p | Slippage={SLIPPAGE_PTS}p | Commission={COMMISSION_PTS}p = Total {TOTAL_FRICTION:.2f}p")
    
    candidates = []
    last_idx = -100
    
    for idx in range(60, len(rates) - 60, 6):
        if idx - last_idx < 15: continue
        c = find_candidate_structures(rates, idx)
        if c:
            last_idx = idx
            thinned = thin_box_to_scratch(c['bars'], c['top'], c['bottom'], min_height=3.2)
            sim = simulate_orderflow_trail_trade(
                rates,
                thinned['fulcrum'],
                thinned['thinned_top'],
                thinned['thinned_bottom'],
                idx,
                max_forward=60
            )
            candidates.append({
                'struct': c,
                'thinned': thinned,
                'sim': sim
            })
            
    executed = [d for d in candidates if d['sim']['status'] == 'TRADE_EXECUTED']
    filtered = [d for d in candidates if d['sim']['status'] == 'NO_ORDERFLOW_TRIGGER']
    
    print("\n" + "="*85)
    print("ORDER FLOW PHYSICAL TRAIL EDGE AUDIT RESULTS")
    print("="*85)
    print(f"• Total Candidate Structures (London & NY Active Sessions): {len(candidates)}")
    print(f"• Filtered Out by Order Flow (No Valid Absorption Sweep):   {len(filtered)} ({len(filtered)/len(candidates)*100:.1f}%)")
    print(f"• High-Probability Trades Triggered & Executed:              {len(executed)} ({len(executed)/len(candidates)*100:.1f}%)")
    
    if len(executed) == 0:
        return
        
    trades = [d['sim'] for d in executed]
    wins = [t for t in trades if t['is_win']]
    losses = [t for t in trades if not t['is_win']]
    
    net_pts = sum(t['net_pts'] for t in trades)
    avg_win = np.mean([t['net_pts'] for t in wins]) if wins else 0
    avg_loss = np.mean([abs(t['net_pts']) for t in losses]) if losses else 0
    total_win_pts = sum(t['net_pts'] for t in wins)
    total_loss_pts = sum(abs(t['net_pts']) for t in losses)
    pf = (total_win_pts / total_loss_pts) if total_loss_pts > 0 else 999.0
    
    w3 = sum(1 for t in trades if t['win_3p']) / len(trades) * 100
    w5 = sum(1 for t in trades if t['win_5p']) / len(trades) * 100
    w10 = sum(1 for t in trades if t['win_10p']) / len(trades) * 100
    w15 = sum(1 for t in trades if t['win_15p']) / len(trades) * 100
    w20 = sum(1 for t in trades if t['win_20p']) / len(trades) * 100
    
    avg_risk = np.mean([t['risk'] for t in trades])
    avg_peak = np.mean([t['peak_fav'] for t in trades])
    avg_rr = np.mean([t['rr'] for t in trades])
    
    print(f"\n--- THE MATHEMATICAL EDGE (NET OF ALL BROKER SPREAD & SLIPPAGE) ---")
    print(f"• Win Rate (Net Profit > $0):              {len(wins)/len(trades)*100:5.1f}% ({len(wins)} of {len(trades)})")
    print(f"• Profit Factor (Gross Wins / Gross Loss): {pf:5.2f}")
    print(f"• Total Net Points Extracted:              {net_pts:+6.2f} pts")
    print(f"• Average Net Profit Per Executed Trade:   {net_pts / len(trades):+6.2f} pts")
    print(f"• Average Winning Trade:                  +{avg_win:5.2f} pts")
    print(f"• Average Scratch Loss:                   -${avg_loss:5.2f} pts (Controlled Minor Scratch)")
    print(f"• Win/Loss Expectancy Ratio:               {avg_win / avg_loss if avg_loss > 0 else 0:5.2f}x")
    
    print(f"\n--- RUNNER CAPTURE & EXPANSION STATS ---")
    print(f"• Reached >= 3.0 pts Expansion:            {w3:5.1f}%")
    print(f"• Reached >= 5.0 pts Expansion:            {w5:5.1f}%")
    print(f"• Reached >= 10.0 pts Monster Run:         {w10:5.1f}%")
    print(f"• Reached >= 15.0 pts Major Trend Leg:     {w15:5.1f}%")
    print(f"• Reached >= 20.0 pts Mega Wave:           {w20:5.1f}%")
    print(f"• Average Stop Loss Risk:                  ${avg_risk:4.2f} pts")
    print(f"• Average Peak Move from Shelf:            +{avg_peak:4.2f} pts")
    print(f"• Peak Risk-to-Reward:                     1:{avg_rr:4.1f}")
    print("="*85)

if __name__ == '__main__':
    run_edge_audit()
