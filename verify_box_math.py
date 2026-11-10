import MetaTrader5 as mt5
import numpy as np

def compute_box_fulcrum_vacuum(bars, top_price, bottom_price):
    price_range = top_price - bottom_price
    if price_range <= 0.05 or len(bars) < 2:
        return None
    
    num_steps = min(80, max(30, int(round(price_range / 0.10))))
    step = price_range / num_steps
    tol = max(0.08, step * 1.15)
    
    candle_props = []
    for b in bars:
        b_open, b_high, b_low, b_close = b['open'], b['high'], b['low'], b['close']
        vol = b['tick_volume'] if 'tick_volume' in b.dtype.names else 1
        body_top = max(b_open, b_close)
        body_bottom = min(b_open, b_close)
        body_size = body_top - body_bottom
        full_range = max(0.01, b_high - b_low)
        candle_props.append({
            'high': b_high, 'low': b_low, 'open': b_open, 'close': b_close,
            'body_top': body_top, 'body_bottom': body_bottom,
            'body_size': body_size, 'full_range': full_range, 'vol': vol
        })
        
    best_fulcrum_price = (top_price + bottom_price) / 2.0
    max_fulcrum_score = -1.0
    best_details = {'retests': 0, 'flips': 0, 'launchpads': 0}
    
    min_vacuum_vol = float('inf')
    best_vacuum_price = (top_price + bottom_price) / 2.0
    
    for s in range(num_steps + 1):
        p = bottom_price + s * step
        fulcrum_score = 0.0
        retests = 0
        upper_rejections = 0
        lower_rejections = 0
        launchpads = 0
        dwell_vol = 0.0
        crossing_bodies = 0
        
        for c in candle_props:
            if abs(c['high'] - p) <= tol and c['body_top'] < p - 0.04:
                fulcrum_score += 3.5
                upper_rejections += 1
                retests += 1
            if abs(c['low'] - p) <= tol and c['body_bottom'] > p + 0.04:
                fulcrum_score += 3.5
                lower_rejections += 1
                retests += 1
            if abs(c['open'] - p) <= tol and c['body_size'] >= 0.80:
                fulcrum_score += 3.0
                launchpads += 1
            if abs(c['open'] - p) <= tol * 0.7 or abs(c['close'] - p) <= tol * 0.7:
                fulcrum_score += 1.5
                
            if c['low'] <= p <= c['high']:
                fraction = 1.0 / max(1.0, round(c['full_range'] / step))
                dwell_vol += c['vol'] * fraction
                if c['body_bottom'] <= p <= c['body_top'] and c['body_size'] >= 0.80:
                    crossing_bodies += 1
                    
        flips = min(upper_rejections, lower_rejections)
        fulcrum_score += flips * 5.0
        
        if fulcrum_score > max_fulcrum_score:
            max_fulcrum_score = fulcrum_score
            best_fulcrum_price = p
            best_details = {'retests': retests, 'flips': flips, 'launchpads': launchpads, 'score': fulcrum_score}
            
        rel_pos = (p - bottom_price) / price_range
        if 0.12 <= rel_pos <= 0.88:
            adj_dwell = dwell_vol / max(1.0, crossing_bodies * 2.5)
            if adj_dwell < min_vacuum_vol:
                min_vacuum_vol = adj_dwell
                best_vacuum_price = p
                
    if abs(best_vacuum_price - best_fulcrum_price) < 0.40:
        if best_fulcrum_price - bottom_price > top_price - best_fulcrum_price:
            best_vacuum_price = max(bottom_price + 0.25, best_fulcrum_price - price_range * 0.38)
        else:
            best_vacuum_price = min(top_price - 0.25, best_fulcrum_price + price_range * 0.38)
            
    return {
        'fulcrum': round(best_fulcrum_price, 2),
        'vacuum': round(best_vacuum_price, 2),
        'retests': best_details['retests'],
        'flips': best_details['flips'],
        'score': max_fulcrum_score
    }

def verify():
    mt5.initialize()
    rates = mt5.copy_rates_from_pos('XAUUSD', mt5.TIMEFRAME_M5, 0, 1000)
    
    # In Image 1: box spans approximately bars 893 to 930
    # Let's test different bar slices to find the exact match to the user's box
    print("Scanning for closest box match...")
    best_diff = 999.0
    best_match = None
    for start in range(860, 920, 2):
        for end in range(start + 10, min(len(rates), start + 60), 2):
            bars = rates[start:end]
            res = compute_box_fulcrum_vacuum(bars, 3919.24, 3892.74)
            if res:
                diff = abs(res['fulcrum'] - 3905.99)
                if diff < best_diff:
                    best_diff = diff
                    best_match = (start, end, res)
                    if diff < 0.1:
                        print(f"Close match: start={start}, end={end}, fulcrum={res['fulcrum']}, vacuum={res['vacuum']}, retests={res['retests']}")
    print(f"Best overall match: diff={best_diff}, info={best_match}")


if __name__ == '__main__':
    verify()
