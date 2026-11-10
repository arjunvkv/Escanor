"""
Audit Combined Fulcrum & Vacuum Setups on Real MT5 Data
Evaluates two distinct auction entry types:
1. TYPE A: FULCRUM RECLAIM (Spring / Sweep of Floor with Absorption Reclaim)
2. TYPE B: VACUUM ROOF BREAKOUT (Velocity Breakout into Thin Book)
3. COMBINED PORTFOLIO
"""

import MetaTrader5 as mt5
import numpy as np
import pandas as pd
from datetime import datetime
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

def run_fulcrum_vacuum_audit(timeframe=mt5.TIMEFRAME_M5, count=30000, tf_name="M5"):
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
    df['upper_wick'] = df['high'] - np.maximum(df['open'], df['close'])
    df['lower_wick'] = np.minimum(df['open'], df['close']) - df['low']
    df['is_up'] = df['close'] >= df['open']

    trades = []
    i = 25
    n = len(df)

    while i < n - 35:
        # Define Coiling Box across prior 8 bars
        lookback = df.iloc[i-8:i]
        box_roof = lookback['high'].max()      # Vacuum Roof
        box_floor = lookback['low'].min()      # Fulcrum Floor
        box_height = box_roof - box_floor
        box_mid = (box_roof + box_floor) / 2   # Equilibrium Axis / POC median
        avg_effort = lookback['effort'].mean()

        # Box must be a coiled energy bracket (height between 2.0p and 6.0p, with high friction)
        is_valid_box = (2.0 <= box_height <= 6.0) and (avg_effort >= 160)

        if not is_valid_box:
            i += 1
            continue

        cur = df.iloc[i]
        setup_type = None
        direction = None
        entry_price = 0.0
        invalidation_price = 0.0

        # --- SETUP 1: FULCRUM RECLAIM (Floor Sweep & Spring) ---
        # Bull Fulcrum Reclaim: candle swept below box_floor (or tested lower 15%), rejected with lower wick, and closed back above floor
        swept_floor = cur['low'] <= box_floor + 0.10
        lower_reject = (cur['lower_wick'] / max(0.1, cur['range'])) >= 0.30
        closed_inside = cur['close'] > box_floor + 0.30 * cur['range']
        
        if swept_floor and lower_reject and closed_inside:
            setup_type = 'FULCRUM_RECLAIM'
            direction = 'BUY'
            entry_price = cur['close']
            invalidation_price = cur['low'] - 0.20

        # Bear Fulcrum Reclaim: candle swept above box_roof, rejected with upper wick, and closed back below roof
        swept_roof = cur['high'] >= box_roof - 0.10
        upper_reject = (cur['upper_wick'] / max(0.1, cur['range'])) >= 0.30
        closed_below_roof = cur['close'] < box_roof - 0.30 * cur['range']

        if swept_roof and upper_reject and closed_below_roof and not setup_type:
            setup_type = 'FULCRUM_RECLAIM'
            direction = 'SELL'
            entry_price = cur['close']
            invalidation_price = cur['high'] + 0.20

        # --- SETUP 2: VACUUM ROOF BREAKOUT (Velocity Acceleration into Thin Book) ---
        if not setup_type:
            # Bull Vacuum Breakout: Closes cleanly above box_roof with low effort / velocity
            bull_vac = (cur['close'] > box_roof) and (cur['body'] / max(0.1, cur['range']) >= 0.55) and (cur['effort'] <= 220)
            if bull_vac:
                setup_type = 'VACUUM_BREAKOUT'
                direction = 'BUY'
                entry_price = box_roof
                invalidation_price = box_mid

            # Bear Vacuum Breakout: Closes cleanly below box_floor with low effort / velocity
            bear_vac = (cur['close'] < box_floor) and (cur['body'] / max(0.1, cur['range']) >= 0.55) and (cur['effort'] <= 220)
            if bear_vac:
                setup_type = 'VACUUM_BREAKOUT'
                direction = 'SELL'
                entry_price = box_floor
                invalidation_price = box_mid

        if not setup_type:
            i += 1
            continue

        # Simulate micro-trade forward
        entry_bar = i
        be_locked = False
        outcome = None
        pnl_pts = 0.0
        max_favorable = 0.0
        max_adverse = 0.0
        exit_bar = i

        target_pts = 3.0  # Core target: >= 3.0p

        for f in range(i + 1, min(i + 35, n)):
            bar = df.iloc[f]
            if direction == 'BUY':
                high_excursion = bar['high'] - entry_price
                low_excursion = entry_price - bar['low']
                hit_invalidation = bar['low'] <= invalidation_price
            else:
                high_excursion = entry_price - bar['low']
                low_excursion = bar['high'] - entry_price
                hit_invalidation = bar['high'] >= invalidation_price

            max_favorable = max(max_favorable, high_excursion)
            max_adverse = max(max_adverse, low_excursion)

            # 1. Target Hit >= 3.0p
            if high_excursion >= target_pts:
                outcome = 'WIN_3P'
                pnl_pts = target_pts
                exit_bar = f
                break

            # 2. Lock Breakeven at +1.0p advance
            if high_excursion >= 1.0:
                be_locked = True

            # 3. Breakeven or Scratch Check
            if be_locked:
                if low_excursion >= -0.15:
                    outcome = 'BE_SCRATCH'
                    pnl_pts = 0.15
                    exit_bar = f
                    break
            else:
                # Fast Scratch Tripwire:
                # If Vacuum Breakout: strict 0.25p pullback into box is an instant scratch
                # If Fulcrum Reclaim: invalidation or 0.35p retracement
                scratch_thresh = 0.25 if setup_type == 'VACUUM_BREAKOUT' else 0.35
                if low_excursion >= scratch_thresh or hit_invalidation:
                    outcome = 'QUICK_SCRATCH'
                    pnl_pts = -round(min(0.35, low_excursion), 2)
                    exit_bar = f
                    break

            # 4. Time stop: 6 bars pass without achieving +0.8p progress
            if f - i >= 6 and max_favorable < 0.8:
                outcome = 'TIME_SCRATCH'
                pnl_pts = -0.10
                exit_bar = f
                break

        if outcome is None:
            if be_locked:
                outcome = 'BE_SCRATCH'
                pnl_pts = 0.15
            else:
                outcome = 'TIME_SCRATCH'
                pnl_pts = -0.10

        trades.append({
            'entry_time': cur['time_str'],
            'setup_type': setup_type,
            'direction': direction,
            'entry_price': entry_price,
            'outcome': outcome,
            'pnl_pts': pnl_pts,
            'max_favorable': round(max_favorable, 2),
            'max_adverse': round(max_adverse, 2),
            'duration_bars': exit_bar - entry_bar
        })

        i = exit_bar + 1

    return trades

def print_audit_report(trades, title):
    if not trades:
        print(f"No trades for {title}")
        return

    tdf = pd.DataFrame(trades)
    total = len(tdf)
    wins = len(tdf[tdf['outcome'] == 'WIN_3P'])
    be_scratches = len(tdf[tdf['outcome'] == 'BE_SCRATCH'])
    loss_scratches = len(tdf[tdf['pnl_pts'] < 0])

    big_5p = len(tdf[tdf['max_favorable'] >= 5.0])
    big_10p = len(tdf[tdf['max_favorable'] >= 10.0])

    pure_target_wr = (wins / total) * 100
    zero_loss_rate = ((wins + be_scratches) / total) * 100
    loss_rate = (loss_scratches / total) * 100

    gross_profit = tdf[tdf['pnl_pts'] > 0]['pnl_pts'].sum()
    gross_loss = abs(tdf[tdf['pnl_pts'] < 0]['pnl_pts'].sum())
    profit_factor = round(gross_profit / max(0.001, gross_loss), 2)
    net_pnl = round(gross_profit - gross_loss, 2)
    avg_win = round(tdf[tdf['pnl_pts'] > 0]['pnl_pts'].mean(), 2)
    avg_loss = round(abs(tdf[tdf['pnl_pts'] < 0]['pnl_pts'].mean()), 2)
    rr = round(avg_win / max(0.01, avg_loss), 1)

    print(f"\n========================================================")
    print(f"📊 {title.upper()}")
    print(f"========================================================")
    print(f"Total Setups Audited:           {total}")
    print(f"Target Hits (>= 3.0p WIN):      {wins} ({pure_target_wr:.1f}%)")
    print(f"Expanded to >= 5.0p:            {big_5p} ({big_5p/total*100:.1f}%)")
    print(f"Expanded to >= 10.0p:           {big_10p} ({big_10p/total*100:.1f}%)")
    print(f"Breakeven Scratches (+0.15p):   {be_scratches} ({be_scratches/total*100:.1f}%)")
    print(f"Loss Scratches (Avg -{avg_loss}p):       {loss_scratches} ({loss_rate:.1f}%)")
    print(f"--------------------------------------------------------")
    print(f"🏆 PURE TARGET WIN RATE:        {pure_target_wr:.1f}%")
    print(f"🛡️ ZERO-LOSS RETENTION RATE:   {zero_loss_rate:.1f}% (Wins + BE)")
    print(f"❌ LOSS SCRATCH RATE:           {loss_rate:.1f}%")
    print(f"--------------------------------------------------------")
    print(f"💰 PROFIT FACTOR:               {profit_factor} : 1")
    print(f"📈 NET POINTS CAPTURED:         +{net_pnl} points")
    print(f"⚖️ REALIZED RISK / REWARD:      {rr} : 1 (+{avg_win}p vs -{avg_loss}p)")
    print(f"========================================================\n")

print("Auditing Combined FULCRUM & VACUUM setups on real MT5 XAUUSD data...")
trades_m5 = run_fulcrum_vacuum_audit(mt5.TIMEFRAME_M5, count=30000, tf_name="M5")

if trades_m5:
    tdf = pd.DataFrame(trades_m5)
    
    # 1. Fulcrum Reclaim Setups Alone
    fulcrum_trades = [t for t in trades_m5 if t['setup_type'] == 'FULCRUM_RECLAIM']
    print_audit_report(fulcrum_trades, "SET-UP 1: FULCRUM RECLAIM ONLY (Floor Sweep & Spring)")

    # 2. Vacuum Breakout Setups Alone
    vacuum_trades = [t for t in trades_m5 if t['setup_type'] == 'VACUUM_BREAKOUT']
    print_audit_report(vacuum_trades, "SET-UP 2: VACUUM ROOF BREAKOUT ONLY (Velocity Flight)")

    # 3. Combined Fulcrum & Vacuum Portfolio
    print_audit_report(trades_m5, "COMBINED FULCRUM & VACUUM PORTFOLIO (M5 30,000 BARS ~ 150 DAYS)")
