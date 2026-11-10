import MetaTrader5 as mt5
import datetime

def find_range():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 1000)
    for i in range(910, 970):
        r = rates[i]
        dt = datetime.datetime.fromtimestamp(r['time'])
        print(f"{i} | {dt} | O:{r['open']:.2f} H:{r['high']:.2f} L:{r['low']:.2f} C:{r['close']:.2f} V:{r['tick_volume']}")


if __name__ == '__main__':
    find_range()
