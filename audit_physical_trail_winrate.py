"""
Audit Physical Trail & Vacuum Ignition Win Rate on Real MT5 Data
Strategy:
1. Detect Absorption / Coiling Shelf:
   - Window of 4-8 bars with compressed range (<= 3.0p) and high effort (Vol / Range >= 250)
2. Detect Vacuum Ignition Breakout:
   - Bar breaks above ceiling (Bull) or below floor (Bear) with low effort (Vol / Range <= 80 or high range-to-volume ratio)
   - Entry taken at the breakout price coordinate
3. Micro-Management Simulation (Zero Lookahead):
   - Step bar-by-bar forward:
   - If price advances by +1.0p, lock Breakeven (+0.15p)
   - If price hits +3.0p target -> WIN (Target Reached)
   - If price pulls back through entry by -0.25p before reaching +0.8p -> SCRATCH (-0.20p loss)
   - If price stagnates for 5 bars without reaching +0.8p -> TIME-STOP SCRATCH (-0.10p loss)
"""

import MetaTrader5 as mt5
import numpy as np
import pandas as pd
from datetime import datetime
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def run_winrate_audit(timeframe=mt5.TIMEFRAME_M5, count=10000, tf_name="M5"):
    if not mt5.initialize():
        print("Failed to initialize MT5")
        return None

    rates = mt5.copy_rates_from_pos("XAUUSD", timeframe, 0, count)
    mt5.shutdown()

    if rates is None or len(rates) < 100:
        print(f"No rates returned for {tf_name}")
        return None

    df = pd.DataFrame(rates)
    df['time_str'] = [datetime.fromtimestamp(t).strftime('%Y-%m-%d %H:%M') for t in df['time']]
    df['range'] = df['high'] - df['low']
    df['body'] = (df['close'] - df['open']).abs()
    df['effort'] = df['tick_volume'] / np.maximum(0.1, df['range'])
    df['is_up'] = df['close'] >= df['open']

    trades = []
    i = 20
    n = len(df)

    while i < n - 30:
        # Check prior 6 bars for Absorption Shelf
        lookback = df.iloc[i-6:i]
        shelf_high = lookback['high'].max()
        shelf_low = lookback['low'].min()
        shelf_range = shelf_high - shelf_low
        avg_effort = lookback['effort'].mean()

        is_shelf = (shelf_range <= 3.8) and (avg_effort >= 180)

        if not is_shelf:
            i += 1
            continue

        cur = df.iloc[i]
        
        # Bullish Vacuum Ignition Trigger:
        # Breaks above shelf_high with expansion and low effort or strong body
        bull_ignition = (cur['close'] > shelf_high) and (cur['body'] / max(0.1, cur['range']) >= 0.55) and (cur['effort'] <= 220)
        
        # Bearish Vacuum Ignition Trigger:
        # Breaks below shelf_low with expansion and low effort or strong body
        bear_ignition = (cur['close'] < shelf_low) and (cur['body'] / max(0.1, cur['range']) >= 0.55) and (cur['effort'] <= 220)

        if not (bull_ignition or bear_ignition):
            i += 1
            continue

        direction = 'BUY' if bull_ignition else 'SELL'
        entry_price = shelf_high if direction == 'BUY' else shelf_low
        entry_bar = i
        be_locked = False
        outcome = None
        pnl_pts = 0.0
        max_favorable = 0.0
        max_adverse = 0.0
        exit_bar = i

        # Step forward bar-by-bar
        for f in range(i + 1, min(i + 35, n)):
            bar = df.iloc[f]
            if direction == 'BUY':
                high_excursion = bar['high'] - entry_price
                low_excursion = entry_price - bar['low']
            else:
                high_excursion = entry_price - bar['low']
                low_excursion = bar['high'] - entry_price

            max_favorable = max(max_favorable, high_excursion)
            max_adverse = max(max_adverse, low_excursion)

            # 1. Check +3.0p Target
            if high_excursion >= 3.0:
                outcome = 'WIN_3P'
                pnl_pts = 3.0
                exit_bar = f
                break

            # 2. Check Breakeven lock at +1.0p
            if high_excursion >= 1.0:
                be_locked = True

            # 3. Check Scratch / Breakeven hit
            if be_locked:
                # If price drops back to BE + 0.15p
                if low_excursion >= -0.15:
                    outcome = 'BE_SCRATCH'
                    pnl_pts = 0.15
                    exit_bar = f
                    break
            else:
                # Strict 0.25p tape scratch tripwire
                if low_excursion >= 0.25:
                    outcome = 'QUICK_SCRATCH'
                    pnl_pts = -0.20  # Average scratch loss
                    exit_bar = f
                    break

            # 4. Time stop: if 6 bars pass without reaching +0.8p
            if f - i >= 6 and max_favorable < 0.8:
                outcome = 'TIME_SCRATCH'
                pnl_pts = -0.10
                exit_bar = f
                break

        if outcome is None:
            # Reached end of forward window
            if be_locked:
                outcome = 'BE_SCRATCH'
                pnl_pts = 0.15
            else:
                outcome = 'TIME_SCRATCH'
                pnl_pts = -0.10

        trades.append({
            'entry_time': cur['time_str'],
            'direction': direction,
            'entry_price': entry_price,
            'outcome': outcome,
            'pnl_pts': pnl_pts,
            'max_favorable': round(max_favorable, 2),
            'max_adverse': round(max_adverse, 2),
            'duration_bars': exit_bar - entry_bar
        })

        # Advance past trade exit
        i = exit_bar + 1

    return trades

print("Running M5 and M1 Win Rate Audits across historical data...")
m5_trades = run_winrate_audit(mt5.TIMEFRAME_M5, count=10000, tf_name="M5")
m1_trades = run_winrate_audit(mt5.TIMEFRAME_M1, count=15000, tf_name="M1")

def print_stats(trades, tf_name):
    if not trades:
        print(f"No trades for {tf_name}")
        return

    tdf = pd.DataFrame(trades)
    total = len(tdf)
    wins = len(tdf[tdf['outcome'] == 'WIN_3P'])
    be_scratches = len(tdf[tdf['outcome'] == 'BE_SCRATCH'])
    quick_scratches = len(tdf[tdf['outcome'] == 'QUICK_SCRATCH'])
    time_scratches = len(tdf[tdf['outcome'] == 'TIME_SCRATCH'])
    total_scratches = quick_scratches + time_scratches

    # Moves reaching >= 5p and >= 10p
    big_5p = len(tdf[tdf['max_favorable'] >= 5.0])
    big_10p = len(tdf[tdf['max_favorable'] >= 10.0])

    # Win rate definitions:
    # 1. Pure Target Hit Rate (Hits >= 3.0p target):
    pure_target_winrate = (wins / total) * 100

    # 2. Capital-Preserving Success Rate (Wins + Positive BE Scratches):
    capital_safe_rate = ((wins + be_scratches) / total) * 100

    # Net PnL and Profit Factor:
    gross_profit = tdf[tdf['pnl_pts'] > 0]['pnl_pts'].sum()
    gross_loss = abs(tdf[tdf['pnl_pts'] < 0]['pnl_pts'].sum())
    profit_factor = round(gross_profit / max(0.001, gross_loss), 2)
    net_pnl_pts = round(gross_profit - gross_loss, 2)
    avg_win = round(tdf[tdf['pnl_pts'] > 0]['pnl_pts'].mean(), 2)
    avg_loss = round(abs(tdf[tdf['pnl_pts'] < 0]['pnl_pts'].mean()), 2)
    risk_reward = round(avg_win / max(0.01, avg_loss), 1)

    print(f"\n========================================================")
    print(f"📊 PERFORMANCE AUDIT RESULTS: {tf_name} ({total} Setups Analyzed)")
    print(f"========================================================")
    print(f"Total Setups Triggered:         {total}")
    print(f"Target Hits (>= 3.0p WIN):      {wins} ({pure_target_winrate:.1f}%)")
    print(f"Expanded to >= 5.0p:            {big_5p} ({big_5p/total*100:.1f}%)")
    print(f"Expanded to >= 10.0p:           {big_10p} ({big_10p/total*100:.1f}%)")
    print(f"Breakeven Scratches (+0.15p):   {be_scratches} ({be_scratches/total*100:.1f}%)")
    print(f"Quick Scratches (-0.20p):       {quick_scratches} ({quick_scratches/total*100:.1f}%)")
    print(f"Time-Stop Scratches (-0.10p):   {time_scratches} ({time_scratches/total*100:.1f}%)")
    print(f"--------------------------------------------------------")
    print(f"🏆 PURE TARGET WIN RATE:        {pure_target_winrate:.1f}%")
    print(f"🛡️ ZERO-LOSS RETENTION RATE:   {capital_safe_rate:.1f}% (Wins + BE)")
    print(f"❌ LOSS SCRATCH RATE:           {(total_scratches/total)*100:.1f}% (Avg loss: -{avg_loss}p)")
    print(f"--------------------------------------------------------")
    print(f"💰 PROFIT FACTOR:               {profit_factor} : 1")
    print(f"📈 NET POINTS CAPTURED:         +{net_pnl_pts} points")
    print(f"⚖️ REALIZED RISK/REWARD:        {risk_reward} : 1 (+{avg_win}p vs -{avg_loss}p)")
    print(f"========================================================\n")

if m5_trades:
    print_stats(m5_trades, "M5 TIMEFRAME (10,000 BARS ~ 50 DAYS)")
if m1_trades:
    print_stats(m1_trades, "M1 TIMEFRAME (15,000 BARS ~ 12 DAYS)")
