"""
DIAGNOSTIC SCRIPT: INVESTIGATING SLICE 1 (OCT-NOV) AND SLICE 3 (AUG-SEP)
Inspects:
1. What was Gold actually doing in Aug 20 - Sep 15 (Slice 3)? Range, trend, daily volatility.
2. Why did the scanner only find 2 candidate boxes in Aug-Sep?
3. What happened in Oct-Nov (Slice 1) on the 8 trades that took losses?
"""

import MetaTrader5 as mt5
import numpy as np
import datetime
from cross_regime_out_of_sample_audit import scan_spring_consolidation, thin_box_causally, simulate_live_scaleout_trade

mt5.initialize()
total_bars = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 15000)

# Slice 3: Bars 0 to 5000 (Aug 20 - Sep 15, 2026)
slice3 = total_bars[0:5000]
s3_start = datetime.datetime.fromtimestamp(slice3[0]['time'])
s3_end = datetime.datetime.fromtimestamp(slice3[-1]['time'])
s3_high = max(b['high'] for b in slice3)
s3_low = min(b['low'] for b in slice3)
s3_open = slice3[0]['open']
s3_close = slice3[-1]['close']

print("="*80)
print(f"SLICE 3 FORENSIC AUDIT: {s3_start} to {s3_end}")
print("="*80)
print(f"• Start Price: ${s3_open:.2f} | End Price: ${s3_close:.2f} | Net Move: {s3_close - s3_open:+.2f} pts")
print(f"• High: ${s3_high:.2f} | Low: ${s3_low:.2f} | Total Range: {s3_high - s3_low:.2f} pts")

# Let's inspect what the scanner was doing in Slice 3
all_candidates_s3 = []
for idx in range(60, len(slice3) - 60, 6):
    dt = datetime.datetime.fromtimestamp(slice3[idx]['time'], datetime.timezone.utc)
    # Check prior move in 25 bars
    prior_bars = slice3[idx - 50 : idx - 25]
    if len(prior_bars) < 15: continue
    prior_move = prior_bars[-1]['close'] - prior_bars[0]['open']
    
    # Check coil
    coil = slice3[idx - 25 : idx + 1]
    rng = max(b['high'] for b in coil) - min(b['low'] for b in coil)
    
    if rng >= 8.0:
        all_candidates_s3.append({
            'idx': idx,
            'time': dt,
            'prior_move': prior_move,
            'rng': rng
        })

print(f"• Coiling windows with range >= 8p in Slice 3: {len(all_candidates_s3)}")
sells_after_dumps = [c for c in all_candidates_s3 if c['prior_move'] <= -6.5]
print(f"• Of those, bases formed AFTER a selloff (dump <= -6.5p): {len(sells_after_dumps)}")

# Inspect Slice 1 (Oct 09 - Nov 05, 2026)
slice1 = total_bars[10000:]
s1_start = datetime.datetime.fromtimestamp(slice1[0]['time'])
s1_end = datetime.datetime.fromtimestamp(slice1[-1]['time'])
s1_open = slice1[0]['open']
s1_close = slice1[-1]['close']
s1_high = max(b['high'] for b in slice1)
s1_low = min(b['low'] for b in slice1)

print("\n" + "="*80)
print(f"SLICE 1 FORENSIC AUDIT: {s1_start} to {s1_end}")
print("="*80)
print(f"• Start Price: ${s1_open:.2f} | End Price: ${s1_close:.2f} | Net Move: {s1_close - s1_open:+.2f} pts")
print(f"• High: ${s1_high:.2f} | Low: ${s1_low:.2f} | Total Range: {s1_high - s1_low:.2f} pts")

# Detailed trade log of Slice 1
from cross_regime_out_of_sample_audit import run_slice_backtest
res1 = run_slice_backtest(slice1, "Slice 1")
print(f"\nSlice 1 Trades Detail (N={len(res1.get('trades', []))}):")
for i, t in enumerate(res1.get('trades', [])):
    s = t['sim']
    print(f"Trade #{i+1} | {t['time']} | Entry: ${s['entry']:.2f} | SL: ${s['sl']:.2f} (Risk: {s['risk']:.2f}p) | Lot1 PnL: {s['lot1_pnl']:+5.2f}p | Lot2 PnL: {s['lot2_pnl']:+5.2f}p | Blended: {s['blended_net']:+5.2f}p | Peak: +{s['peak_fav']:.2f}p")
