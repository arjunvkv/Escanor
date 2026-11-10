"""
INSPECT THE 15 EXECUTED TRADES IN DETAIL
"""
import MetaTrader5 as mt5
from orderflow_physical_trail_edge_audit import find_candidate_structures, thin_box_to_scratch, simulate_orderflow_trail_trade

mt5.initialize()
rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 4500)

executed = []
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
        if sim['status'] == 'TRADE_EXECUTED':
            executed.append({'c': c, 't': thinned, 'sim': sim})

print(f"Total executed trades: {len(executed)}")
for i, t in enumerate(executed):
    s = t['sim']
    c = t['c']
    print(f"Trade #{i+1:2d} | Time: {c['time']} | Dir: {s['direction']:4s} | Entry: {s['fill_entry']:.2f} | SL: {s['initial_sl']:.2f} (Risk: {s['risk']:.2f}p) | Exit: {s['exit_price']:.2f} ({s['exit_reason']:12s}) | Net: {s['net_pts']:+5.2f}p | Peak: +{s['peak_fav']:.2f}p")
