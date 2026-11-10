"""
FULL AUTONOMOUS END-TO-END SYSTEM TEST (MIMICKING ALL LIVE CONDITIONS)
Tests whether the entire pipeline can run 100% autonomously without human drawing:
1. Auto-detection of impulse + consolidation structure (Causal, zero lookahead)
2. Auto-generation of initial wide macro box
3. Auto-stepwise node thinning down to scratch height (<=3.2p)
4. Auto-arming of Invariant Retest Fulcrum shelf
5. Realistic live market friction:
   - Live Bid/Ask spread (0.38 pts actual MT5 spread)
   - Realistic slippage (0.10 pts on entry and stops)
   - ECN commission ($0.06 pts round turn)
   - Exact Ask-fill on BUY, Bid-fill on SELL, Ask-trigger on SHORT SL, Bid-trigger on LONG SL
   - Intra-bar worst-case sequence testing (SL hit before TP check)
6. Full performance audit: Win rate, Profit Factor, Expectancy, Max Drawdown
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
from audit_recursive_box_probability import compute_box_fulcrum_vacuum
from stepwise_thinning_audit import single_node_thinning_step

# Live friction constants based on live MT5 telemetry
SPREAD_PTS = 0.38       # Actual live MT5 XAUUSD spread (38 pips)
SLIPPAGE_PTS = 0.10     # Realistic execution slippage
COMMISSION_PTS = 0.06   # ECN commission ($6/lot round trip)
TOTAL_FRICTION = SPREAD_PTS + SLIPPAGE_PTS + COMMISSION_PTS

def auto_detect_impulse_consolidation(rates, current_idx, min_impulse=8.0, lookback_coil=24):
    """
    100% Causal Scanner:
    At bar current_idx, checks if:
    1. A genuine impulse push occurred (displacing >= min_impulse pts over prior 15-25 bars)
    2. A healthy consolidation base has coiled over the last lookback_coil bars
    """
    if current_idx < 50:
        return None
        
    # 1. Coil window
    coil_bars = rates[current_idx - lookback_coil : current_idx + 1]
    coil_high = max(b['high'] for b in coil_bars)
    coil_low = min(b['low'] for b in coil_bars)
    coil_range = coil_high - coil_low
    
    # Must be between 10p and 28p
    if not (10.0 <= coil_range <= 28.0):
        return None
        
    # Check that price is actually oscillating inside (at least 2 touches of upper & lower third)
    upper_zone = coil_high - 0.30 * coil_range
    lower_zone = coil_low + 0.30 * coil_range
    u_touches = sum(1 for b in coil_bars if b['high'] >= upper_zone)
    l_touches = sum(1 for b in coil_bars if b['low'] <= lower_zone)
    if u_touches < 2 or l_touches < 2:
        return None
        
    # 2. Prior impulse window (15 bars before coil)
    impulse_bars = rates[current_idx - lookback_coil - 15 : current_idx - lookback_coil]
    if len(impulse_bars) < 10:
        return None
    impulse_move = impulse_bars[-1]['close'] - impulse_bars[0]['open']
    
    if abs(impulse_move) < min_impulse:
        return None
        
    impulse_dir = 'BULL' if impulse_move > 0 else 'BEAR'
    
    # Session filter: focus on active hours (06:00 to 20:00 UTC)
    dt = datetime.datetime.fromtimestamp(rates[current_idx]['time'], datetime.timezone.utc)
    if dt.hour < 5 or dt.hour > 21:
        return None
        
    return {
        'idx': current_idx,
        'time': dt,
        'coil_bars': coil_bars,
        'top': round(coil_high, 2),
        'bottom': round(coil_low, 2),
        'range': round(coil_range, 2),
        'impulse_dir': impulse_dir,
        'impulse_move': round(impulse_move, 2)
    }

def auto_stepwise_thin_box(bars, top, bottom, target_height=3.2):
    """
    Automatically runs sequential node thinning down to target scratch height.
    """
    curr_top = top
    curr_bot = bottom
    final_fulcrum = (top + bottom) / 2.0
    steps = 0
    
    while (curr_top - curr_bot) > target_height and steps < 5:
        res = single_node_thinning_step(bars, curr_top, curr_bot, choice_strategy='structure')
        if not res:
            break
        curr_top = res['new_top']
        curr_bot = res['new_bottom']
        final_fulcrum = res['new_fulcrum']
        steps += 1
        
    return {
        'steps': steps,
        'thinned_top': round(curr_top, 2),
        'thinned_bottom': round(curr_bot, 2),
        'thinned_height': round(curr_top - curr_bot, 2),
        'fulcrum': round(final_fulcrum, 2)
    }

def simulate_realistic_live_execution(rates, shelf_price, thinned_top, thinned_bottom, impulse_dir, start_idx, max_forward=48):
    """
    Simulates live broker execution with:
    - Real Bid/Ask Spread (0.38 pts)
    - Slippage (0.10 pts)
    - ECN Commission (0.06 pts)
    - Directional bias from the impulse (trend continuation or spring reclaim)
    - Intra-bar conservative sequencing
    """
    future_bars = rates[start_idx + 1 : start_idx + 1 + max_forward]
    if len(future_bars) < 2:
        return {'status': 'NO_DATA'}
        
    # Wait for arrival at shelf (within 0.30p tolerance)
    arrived = False
    arr_idx = -1
    for idx, b in enumerate(future_bars):
        if b['low'] <= shelf_price + 0.30 and b['high'] >= shelf_price - 0.30:
            arrived = True
            arr_idx = idx
            break
            
    if not arrived:
        return {'status': 'DID_NOT_ARRIVE'}
        
    # Live execution:
    # If impulse was BULL -> Look to BUY on shelf retest / absorption
    # If impulse was BEAR -> Look to SELL on shelf retest / rejection
    # If neutral / ambiguous, use approach direction
    trade_bars = future_bars[arr_idx:]
    initial_bar = trade_bars[0]
    
    pos = 'BUY' if impulse_dir == 'BULL' else 'SELL'
    
    # Apply real live broker fill mechanics:
    if pos == 'BUY':
        # BUY enters at ASK = Bid + Spread + Slippage
        fill_entry = round(shelf_price + SPREAD_PTS + SLIPPAGE_PTS, 2)
        # Stop loss anchored below thinned bottom
        initial_sl = round(thinned_bottom - 0.25 - SLIPPAGE_PTS, 2)
        risk = round(fill_entry - initial_sl, 2)
    else:
        # SELL enters at BID - Slippage
        fill_entry = round(shelf_price - SLIPPAGE_PTS, 2)
        # Stop loss is triggered when ASK reaches initial_sl
        initial_sl = round(thinned_top + 0.25 + SPREAD_PTS + SLIPPAGE_PTS, 2)
        risk = round(initial_sl - fill_entry, 2)
        
    if risk < 0.80 or risk > 3.50:
        # Strict institutional risk gate (only accept scratch trades within 0.80p to 3.50p)
        return {'status': 'RISK_GATE_REJECT', 'risk': risk}
        
    # Live forward tracking with conservative intra-bar checks
    current_sl = initial_sl
    be_active = False
    peak_fav = 0.0
    exit_price = 0.0
    exit_reason = None
    
    for b in trade_bars:
        # Conservative check: Did SL get touched during the bar?
        if pos == 'BUY':
            bid_low = b['low']
            bid_high = b['high']
            
            # Check SL on BID
            if bid_low <= current_sl:
                exit_price = current_sl - SLIPPAGE_PTS  # Slippage on stop out
                exit_reason = 'STOP_LOSS' if not be_active else 'BE_OR_TRAIL'
                break
                
            fav = bid_high - fill_entry
            if fav > peak_fav: peak_fav = fav
            
            # Auto-BE: Once price reaches +1.80p physical gain, move SL to entry + 0.10p (net +0.10p)
            if peak_fav >= 1.80 and not be_active:
                current_sl = fill_entry + 0.10
                be_active = True
                
            # Dynamic Trail at >= 6.50p expansion (trailing 2.50p behind peak)
            if peak_fav >= 6.50:
                current_sl = max(current_sl, round(fill_entry + peak_fav - 2.50, 2))
                
        else: # SELL
            # For short: SL is triggered when ASK reaches current_sl
            ask_high = b['high'] + SPREAD_PTS
            ask_low = b['low'] + SPREAD_PTS
            
            if ask_high >= current_sl:
                exit_price = current_sl + SLIPPAGE_PTS
                exit_reason = 'STOP_LOSS' if not be_active else 'BE_OR_TRAIL'
                break
                
            fav = fill_entry - ask_low
            if fav > peak_fav: peak_fav = fav
            
            if peak_fav >= 1.80 and not be_active:
                current_sl = fill_entry - 0.10
                be_active = True
                
            if peak_fav >= 6.50:
                current_sl = min(current_sl, round(fill_entry - (peak_fav - 2.50), 2))

    if not exit_reason:
        # Closed at end of session
        last_b = trade_bars[-1]
        exit_price = last_b['close'] if pos == 'BUY' else (last_b['close'] + SPREAD_PTS)
        exit_reason = 'SESSION_LIMIT'
        
    gross_pts = (exit_price - fill_entry) if pos == 'BUY' else (fill_entry - exit_price)
    net_pts = round(gross_pts - COMMISSION_PTS, 2)
    
    return {
        'status': 'TRADE_EXECUTED',
        'arrival_bars': arr_idx,
        'direction': pos,
        'fill_entry': fill_entry,
        'initial_sl': initial_sl,
        'risk': risk,
        'peak_fav': round(peak_fav, 2),
        'exit_price': round(exit_price, 2),
        'exit_reason': exit_reason,
        'net_pts': net_pts,
        'be_active': be_active,
        'is_win': net_pts > 0,
        'win_3p': peak_fav >= 3.0,
        'win_5p': peak_fav >= 5.0,
        'win_10p': peak_fav >= 10.0,
        'win_20p': peak_fav >= 20.0,
        'rr': round(peak_fav / risk, 1) if risk > 0 else 0
    }

def run_live_mimic_study():
    if not mt5.initialize():
        print("MT5 initialization failed!")
        return
        
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 3500)
    print(f"Loaded {len(rates)} historical M5 bars.")
    print(f"Live Simulation Parameters: Spread={SPREAD_PTS}p | Slippage={SLIPPAGE_PTS}p | Commission={COMMISSION_PTS}p | Total Friction={TOTAL_FRICTION:.2f}p")
    
    detected = []
    last_idx = -100
    
    for idx in range(60, len(rates) - 60):
        if idx - last_idx < 15:
            continue
            
        box = auto_detect_impulse_consolidation(rates, idx, min_impulse=8.0, lookback_coil=24)
        if box:
            last_idx = idx
            thinned = auto_stepwise_thin_box(box['coil_bars'], box['top'], box['bottom'], target_height=3.2)
            sim = simulate_realistic_live_execution(
                rates,
                thinned['fulcrum'],
                thinned['thinned_top'],
                thinned['thinned_bottom'],
                box['impulse_dir'],
                idx,
                max_forward=48
            )
            detected.append({
                'box': box,
                'thinned': thinned,
                'sim': sim
            })
            
    print(f"\nTotal Impulse+Consolidation Boxes Detected Causally: {len(detected)}")
    
    executed = [d for d in detected if d['sim']['status'] == 'TRADE_EXECUTED']
    rejected_risk = [d for d in detected if d['sim']['status'] == 'RISK_GATE_REJECT']
    did_not_arrive = [d for d in detected if d['sim']['status'] == 'DID_NOT_ARRIVE']
    
    print("\n" + "="*85)
    print("LIVE CONDITIONS MIMIC AUDIT: 100% AUTONOMOUS PIPELINE")
    print("="*85)
    print(f"• Total Auto-Detected Structures:          {len(detected)}")
    print(f"• Trades Fully Executed into Broker:        {len(executed)} ({len(executed)/len(detected)*100:.1f}%)")
    print(f"• Rebuffed by Risk Gate (Risk > 3.5p):      {len(rejected_risk)}")
    print(f"• Price Did Not Arrive at Shelf:            {len(did_not_arrive)}")
    
    if len(executed) == 0:
        return
        
    trades = [d['sim'] for d in executed]
    wins = [t for t in trades if t['is_win']]
    losses = [t for t in trades if not t['is_win']]
    
    net_pnl_pts = sum(t['net_pts'] for t in trades)
    avg_win = np.mean([t['net_pts'] for t in wins]) if wins else 0
    avg_loss = np.mean([abs(t['net_pts']) for t in losses]) if losses else 0
    profit_factor = (sum(t['net_pts'] for t in wins) / sum(abs(t['net_pts']) for t in losses)) if losses else 999.0
    
    w3 = sum(1 for t in trades if t['win_3p']) / len(trades) * 100
    w5 = sum(1 for t in trades if t['win_5p']) / len(trades) * 100
    w10 = sum(1 for t in trades if t['win_10p']) / len(trades) * 100
    w20 = sum(1 for t in trades if t['win_20p']) / len(trades) * 100
    be_rate = sum(1 for t in trades if t['be_active']) / len(trades) * 100
    
    avg_risk = np.mean([t['risk'] for t in trades])
    avg_peak = np.mean([t['peak_fav'] for t in trades])
    avg_rr = np.mean([t['rr'] for t in trades])
    
    print(f"\n--- FINANCIAL & EXPECTANCY METRICS (NET OF ALL FRICTIONS) ---")
    print(f"• Win Rate (Net Profit > $0):              {len(wins)/len(trades)*100:5.1f}% ({len(wins)} of {len(trades)})")
    print(f"• Profit Factor:                           {profit_factor:5.2f}")
    print(f"• Total Net Points Extracted:              {net_pnl_pts:+6.2f} pts")
    print(f"• Average Net Gain Per Executed Trade:     {net_pnl_pts / len(trades):+6.2f} pts")
    print(f"• Average Winner:                         +{avg_win:5.2f} pts")
    print(f"• Average Scratch Loss:                   -${avg_loss:5.2f} pts (Controlled Affordable Scratch!)")
    print(f"• Win/Loss Expectancy Ratio:               {avg_win / avg_loss if avg_loss > 0 else 0:5.2f}x")
    
    print(f"\n--- LIVE RUNNER & EXPANSION METRICS ---")
    print(f"• Auto-BE Protection Rate (+1.80p reached): {be_rate:5.1f}%")
    print(f"• Reached >= 3.0 pts Expansion:            {w3:5.1f}%")
    print(f"• Reached >= 5.0 pts Expansion:            {w5:5.1f}%")
    print(f"• Reached >= 10.0 pts Monster Move:        {w10:5.1f}%")
    print(f"• Reached >= 20.0 pts Mega Trend:          {w20:5.1f}%")
    print(f"• Average Live Stop Loss Risk:             ${avg_risk:4.2f} pts")
    print(f"• Average Peak Move from Shelf:            +{avg_peak:4.2f} pts")
    print(f"• Realized Peak Risk-to-Reward:            1:{avg_rr:4.1f}")
    print("="*85)

if __name__ == '__main__':
    run_live_mimic_study()
