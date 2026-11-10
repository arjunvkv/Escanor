import MetaTrader5 as mt5
import datetime
import numpy as np

def run():
    if not mt5.initialize():
        print("Failed to initialize MT5")
        return
    
    # Let's inspect bars around Nov 2, 2026
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 1200)
    print(f"Fetched {len(rates)} M5 bars")
    for i in range(480, 560):
        r = rates[i]
        dt = datetime.datetime.fromtimestamp(r['time'])
        print(f"{i:3d} | {dt} | O:{r['open']:7.2f} H:{r['high']:7.2f} L:{r['low']:7.2f} C:{r['close']:7.2f} V:{r['tick_volume']:5d}")

if __name__ == '__main__':
    run()
