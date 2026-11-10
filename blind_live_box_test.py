"""
BLIND LIVE BOX DETECTION & STEPWISE THINNING TEST (ZERO LOOKAHEAD BIAS)
Strictly causal:
1. At bar T, an automated rule identifies a consolidation box using ONLY bars prior to T.
2. The box is thinned node-by-node down to a scratch corridor strictly using data up to T.
3. The tape advances bar-by-bar into future time (T+1, T+2, ...) simulating live conditions.
4. Evaluates arrival, physical trigger, scratch risk, win rates, and feasibility.
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step

def detect_consolidation_causally(rates, current_idx, lookback=30):
    """
    Evaluates at bar current_idx whether a consolidation box exists.
    Uses ONLY bars [current_idx - lookback, current_idx].
    ZERO future lookahead!
    """
    if current_idx < lookback + 20:
        return None
        
    window = rates[current_idx - lookback : current_idx + 1]
    highs = [b['high'] for b in window]
    lows = [b['low'] for b in window]
    w_high = max(highs)
    w_low = min(lows)
    w_range = w_high - w_low
    
    # 1. Range constraint: Must be between 12.0p and 28.0p (wide macro consolidation)
    if not (12.0 <= w_range <= 28.0):
        return None
        
    # 2. Re-test count constraint: Must have oscillated inside range (not a single straight line)
    # Check if price touched upper 25% and lower 25% of the range multiple times
    upper_threshold = w_high - 0.25 * w_range
    lower_threshold = w_low + 0.25 * w_range
    
    touches_upper = sum(1 for b in window if b['high'] >= upper_threshold)
    touches_lower = sum(1 for b in window if b['low'] <= lower_threshold)
    
    if touches_upper < 3 or touches_lower < 3:
        return None
        
    # 3. Compression / coiling check: The last 5 bars range is narrower than the overall box
    last5_range = max(b['high'] for b in window[-5:]) - min(b['low'] for b in window[-5:])
    if last5_range > 0.65 * w_range:
        # Still expanding violently, not yet coiling/settling
        return None
        
    # 4. Context check: Was there an impulse prior to this consolidation?
    prior_bars = rates[current_idx - lookback - 20 : current_idx - lookback]
    prior_move = prior_bars[-1]['close'] - prior_bars[0]['close']
    is_after_impulse = abs(prior_move) >= 6.0
    
    return {
        'current_idx': current_idx,
        'time': datetime.datetime.fromtimestamp(rates[current_idx]['time']),
        'bars': window,
        'top': round(w_high, 2),
        'bottom': round(w_low, 2),
        'range': round(w_range, 2),
        'is_after_impulse': is_after_impulse,
        'prior_dir': 'BEAR' if prior_move < 0 else 'BULL'
    }

def thin_box_causally(bars, top_price, bottom_price, target_height=3.2):
    """
    Applies structure-guided node thinning strictly on the historical window available at T.
    Returns the thinned box and the final converged Fulcrum & Vacuum.
    """
    curr_top = top_price
    curr_bot = bottom_price
    steps = 0
    final_fulcrum = (top_price + bottom_price) / 2.0
    final_vacuum = final_fulcrum
    
    while (curr_top - curr_bot) > target_height and steps < 5:
        res = single_node_thinning_step(bars, curr_top, curr_bot, choice_strategy='structure')
        if not res:
            break
        curr_top = res['new_top']
        curr_bot = res['new_bottom']
        final_fulcrum = res['new_fulcrum']
        final_vacuum = res['new_vacuum']
        steps += 1
        
    return {
        'steps': steps,
        'thinned_top': round(curr_top, 2),
        'thinned_bottom': round(curr_bot, 2),
        'thinned_height': round(curr_top - curr_bot, 2),
        'fulcrum': round(final_fulcrum, 2),
        'vacuum': round(final_vacuum, 2)
    }

def simulate_live_forward_tape(rates, entry_shelf, thinned_top, thinned_bottom, start_idx, max_forward_bars=48):
    """
    Advances forward bar-by-bar strictly AFTER bar T.
    Simulates live ticker conditions:
    1. Waits for arrival at the thinned shelf (tolerance +-0.30p)
    2. Enters with scratch SL outside the thinned box
    3. Simulates auto-BE at +1.80p and uncapped trailing
    """
    future_bars = rates[start_idx + 1 : start_idx + 1 + max_forward_bars]
    if len(future_bars) < 2:
        return {'status': 'NO_DATA'}
        
    arrived = False
    arrival_bar = -1
    approach_from = None
    
    # 1. Magnetic Arrival check
    initial_p = future_bars[0]['open']
    approach_from = 'above' if initial_p > entry_shelf else 'below'
    
    for idx, b in enumerate(future_bars):
        if b['low'] <= entry_shelf + 0.30 and b['high'] >= entry_shelf - 0.30:
            arrived = True
            arrival_bar = idx
            break
            
    if not arrived:
        return {'status': 'DID_NOT_ARRIVE'}
        
    # 2. Live execution from shelf
    # If price pulled back from above into the shelf -> BUY
    # If price pulled up from below into the shelf -> SELL
    pos = 'BUY' if approach_from == 'above' else 'SELL'
    entry_p = entry_shelf
    
    if pos == 'BUY':
        sl_p = round(thinned_bottom - 0.30, 2)
        risk = round(entry_p - sl_p, 2)
    else:
        sl_p = round(thinned_top + 0.30, 2)
        risk = round(sl_p - entry_p, 2)
        
    if risk <= 0.30:
        risk = 1.00
        
    # Forward simulation from arrival point
    trade_bars = future_bars[arrival_bar:]
    be_active = False
    current_sl = sl_p
    peak_fav = 0.0
    exit_p = 0.0
    exit_reason = None
    
    for b in trade_bars:
        if pos == 'BUY':
            if b['low'] <= current_sl:
                exit_p = current_sl
                exit_reason = 'STOP_LOSS' if not be_active else 'BE_OR_TRAIL'
                break
            fav = b['high'] - entry_p
            if fav > peak_fav: peak_fav = fav
            
            # Auto-BE at +1.80p displacement
            if peak_fav >= 1.80 and not be_active:
                current_sl = entry_p + 0.10
                be_active = True
                
            # Dynamic Trail at >= 8.50p
            if peak_fav >= 8.50:
                current_sl = max(current_sl, entry_p + peak_fav - 3.00)
                
        else: # SELL
            if b['high'] >= current_sl:
                exit_p = current_sl
                exit_reason = 'STOP_LOSS' if not be_active else 'BE_OR_TRAIL'
                break
            fav = entry_p - b['low']
            if fav > peak_fav: peak_fav = fav
            
            if peak_fav >= 1.80 and not be_active:
                current_sl = entry_p - 0.10
                be_active = True
                
            if peak_fav >= 8.50:
                current_sl = min(current_sl, entry_p - (peak_fav - 3.00))

    if not exit_reason:
        exit_p = trade_bars[-1]['close']
        exit_reason = 'SESSION_LIMIT'
        
    realized_pts = round((exit_p - entry_p) if pos == 'BUY' else (entry_p - exit_p), 2)
    
    return {
        'status': 'TRADE_EXECUTED',
        'arrival_bars': arrival_bar,
        'direction': pos,
        'entry': entry_p,
        'initial_sl': sl_p,
        'risk': risk,
        'peak_fav': round(peak_fav, 2),
        'realized_pts': realized_pts,
        'be_active': be_active,
        'win_3p': peak_fav >= 3.0,
        'win_5p': peak_fav >= 5.0,
        'win_10p': peak_fav >= 10.0,
        'win_20p': peak_fav >= 20.0,
        'exit_reason': exit_reason,
        'rr': round(peak_fav / risk, 1) if risk > 0 else 0
    }

def run_blind_live_audit():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 3000)
    print(f"Loaded {len(rates)} historical bars for blind live testing.")
    
    detected_boxes = []
    last_detected_idx = -100
    
    # Iterate causally through time
    for current_idx in range(60, len(rates) - 60):
        # Prevent overlapping detections within 18 bars (1.5 hours)
        if current_idx - last_detected_idx < 18:
            continue
            
        box = detect_consolidation_causally(rates, current_idx, lookback=32)
        if box:
            last_detected_idx = current_idx
            
            # Step 1: Thin the box strictly using data up to current_idx
            thinned = thin_box_causally(box['bars'], box['top'], box['bottom'], target_height=3.2)
            
            # Step 2: Simulate live forward execution
            sim = simulate_live_forward_tape(
                rates,
                thinned['fulcrum'],
                thinned['thinned_top'],
                thinned['thinned_bottom'],
                current_idx,
                max_forward_bars=48
            )
            
            detected_boxes.append({
                'box': box,
                'thinned': thinned,
                'sim': sim
            })
            
    print(f"\nTotal Blind Live Boxes Detected Causally: {len(detected_boxes)}")
    
    # Analyze results
    arrived_trades = [d for d in detected_boxes if d['sim']['status'] == 'TRADE_EXECUTED']
    un_arrived = [d for d in detected_boxes if d['sim']['status'] == 'DID_NOT_ARRIVE']
    
    print("\n" + "="*85)
    print("BLIND LIVE FEASIBILITY AUDIT RESULTS (ZERO LOOKAHEAD)")
    print("="*85)
    print(f"• Total Boxes Drawn Blindly:              {len(detected_boxes)}")
    print(f"• Magnetic Arrival Rate (Price hits shelf): {len(arrived_trades) / len(detected_boxes) * 100:5.1f}% ({len(arrived_trades)} of {len(detected_boxes)})")
    print(f"• Missed / No-Arrival Rate:                 {len(un_arrived) / len(detected_boxes) * 100:5.1f}%")
    
    if len(arrived_trades) == 0:
        return
        
    trades = [d['sim'] for d in arrived_trades]
    avg_box_height = np.mean([d['thinned']['thinned_height'] for d in arrived_trades])
    avg_scratch_risk = np.mean([t['risk'] for t in trades])
    avg_arrival_time_bars = np.mean([t['arrival_bars'] for t in trades])
    
    w3 = sum(1 for t in trades if t['win_3p']) / len(trades) * 100
    w5 = sum(1 for t in trades if t['win_5p']) / len(trades) * 100
    w10 = sum(1 for t in trades if t['win_10p']) / len(trades) * 100
    w20 = sum(1 for t in trades if t['win_20p']) / len(trades) * 100
    be_rate = sum(1 for t in trades if t['be_active']) / len(trades) * 100
    scratch_losses = sum(1 for t in trades if t['realized_pts'] < 0) / len(trades) * 100
    
    avg_peak_fav = np.mean([t['peak_fav'] for t in trades])
    avg_realized_pts = np.mean([t['realized_pts'] for t in trades])
    avg_rr = np.mean([t['rr'] for t in trades])
    
    print(f"\n--- TRADE EXECUTION & RISK PROFILE (LIVE FORWARD CONDITIONS) ---")
    print(f"• Average Initial Raw Box Range:          ${np.mean([d['box']['range'] for d in arrived_trades]):.2f} pts")
    print(f"• Average Thinned Scratch Box Height:     ${avg_box_height:.2f} pts")
    print(f"• Average Live Scratch Stop Loss Risk:    ${avg_scratch_risk:.2f} pts")
    print(f"• Average Waiting Time for Arrival:       {avg_arrival_time_bars:.1f} M5 bars (~{avg_arrival_time_bars*5:.0f} mins)")
    print(f"• Auto-BE Protection Rate (+1.80p hit):    {be_rate:5.1f}%")
    print(f"• Full Scratch Loss Rate (SL hit < BE):   {scratch_losses:5.1f}%")
    
    print(f"\n--- EXPANSION WIN RATES & REALIZED EXPECTANCY ---")
    print(f"• Win Rate for >= 3.0 pts Expansion:      {w3:5.1f}%")
    print(f"• Win Rate for >= 5.0 pts Expansion:      {w5:5.1f}%")
    print(f"• Win Rate for >= 10.0 pts Monster Run:   {w10:5.1f}%")
    print(f"• Win Rate for >= 20.0 pts Mega Trend:    {w20:5.1f}%")
    print(f"• Average Peak Favorable Expansion:       +{avg_peak_fav:.2f} pts")
    print(f"• Average Realized Net Gain per Trade:    +{avg_realized_pts:.2f} pts")
    print(f"• Realized Risk-to-Reward Ratio:          1:{avg_rr:.1f}")
    print("="*85)
    
    # Breakdown by context
    impulse_trades = [d['sim'] for d in arrived_trades if d['box']['is_after_impulse']]
    non_impulse_trades = [d['sim'] for d in arrived_trades if not d['box']['is_after_impulse']]
    
    if impulse_trades:
        w10_imp = sum(1 for t in impulse_trades if t['win_10p']) / len(impulse_trades) * 100
        rr_imp = np.mean([t['rr'] for t in impulse_trades])
        print(f"\n[KEY INSIGHT] Boxes Drawn Blindly AFTER an Impulsive Push (N={len(impulse_trades)}):")
        print(f"  • Win >= 10p: {w10_imp:.1f}% | Avg R:R: 1:{rr_imp:.1f}")
    if non_impulse_trades:
        w10_non = sum(1 for t in non_impulse_trades if t['win_10p']) / len(non_impulse_trades) * 100
        rr_non = np.mean([t['rr'] for t in non_impulse_trades])
        print(f"[KEY INSIGHT] Boxes Drawn Blindly in Flat Symmetrical Chop (N={len(non_impulse_trades)}):")
        print(f"  • Win >= 10p: {w10_non:.1f}% | Avg R:R: 1:{rr_non:.1f}")

if __name__ == '__main__':
    run_blind_live_audit()
