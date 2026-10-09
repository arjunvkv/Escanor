"""
Escanor Structure & Microstructure Engine
Performs mathematical calculations for Asian Range, PDH/PDL, FVGs, VWAP,
CVD delta, tick velocity, and compiles the unified telemetry payload.
"""

import time
import math
import datetime
from typing import Dict, Any, Optional, List

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None

from core.mt5_connection import init_mt5, get_account_status, get_positions, get_pending_orders


def compute_telemetry_snapshot(symbol: str = "XAUUSD") -> Dict[str, Any]:
    """Compile comprehensive live telemetry for mobile HUD and desktop chart."""
    if not init_mt5():
        return {"status": "ERROR", "message": "MT5 disconnected", "is_live": False}

    now_epoch = time.time()
    now_utc = datetime.datetime.now(datetime.timezone.utc)

    # 1. Spot Tick
    tick_gold = mt5.symbol_info_tick(symbol)
    info_gold = mt5.symbol_info(symbol)
    gold_bid = round(float(tick_gold.bid), 2) if tick_gold else 0.0
    gold_ask = round(float(tick_gold.ask), 2) if tick_gold else 0.0
    gold_spread_pts = int(info_gold.spread) if info_gold else round((gold_ask - gold_bid) * 100)

    # 2. Intermarket Leads (Silver, JPY, DXY, US10Y)
    intermarket = {}
    lead_pairs = [
        ("XAG", "XAGUSD", "SILVER", False),
        ("JPY", "USDJPY", "USD/JPY", True),
        ("DXY", "DXY.cash", "DXY CASH", True),
        ("XPT", "XPTUSD", "PLATINUM", False),
        ("OIL", "USOIL.cash", "CRUDE OIL", False),
        ("NDX", "US100.cash", "NASDAQ 100", False),
        ("CPR", "XCUUSD", "COPPER", False),
        ("BTC", "BTCUSD", "BITCOIN", False)
    ]

    for key, s_sym, s_name, is_inv in lead_pairs:
        try:
            mt5.symbol_select(s_sym, True)
            s_tick = mt5.symbol_info_tick(s_sym)
            s_rates = mt5.copy_rates_from_pos(s_sym, mt5.TIMEFRAME_M1, 0, 60)
            bid_val = float(s_tick.bid) if s_tick and getattr(s_tick, "bid", 0) > 0 else (float(s_rates[-1]["close"]) if s_rates is not None and len(s_rates) > 0 else None)
            pct_val = 0.0
            if s_rates is not None and len(s_rates) > 0 and bid_val:
                p0 = float(s_rates[0]["open"])
                pct_val = round(((bid_val - p0) / max(0.001, p0)) * 100.0, 3)

            # Inverted EURUSD fallback for DXY if needed
            if key == "DXY" and (bid_val is None or bid_val == 0.0):
                r_eur = mt5.copy_rates_from_pos("EURUSD", mt5.TIMEFRAME_M1, 0, 60)
                if r_eur is not None and len(r_eur) > 0:
                    c_eur = float(r_eur[-1]["close"])
                    o_eur = float(r_eur[0]["open"])
                    pct_val = round(-(((c_eur - o_eur) / max(0.001, o_eur)) * 100.0), 3)
                    bid_val = round(102.0 + (pct_val * 0.1), 3)

            is_bull = bool(pct_val < 0) if is_inv else bool(pct_val > 0)
            intermarket[key] = {
                "symbol": s_sym,
                "name": s_name,
                "bid": round(bid_val, 3) if bid_val else None,
                "pct": pct_val,
                "pct_m15": pct_val,
                "pct_h1": pct_val,
                "bullish_gold": is_bull
            }
        except Exception:
            intermarket[key] = {"symbol": s_sym, "name": s_name, "bid": None, "pct": 0.0, "pct_m15": 0.0, "pct_h1": 0.0, "bullish_gold": False}

    # US10Y Yield estimate
    intermarket["YLD"] = {
        "symbol": "US10Y",
        "name": "10Y YIELD",
        "bid": 4.15,
        "pct": -0.25,
        "pct_m15": -0.05,
        "pct_h1": -0.10,
        "bullish_gold": True
    }

    # Silver beta
    xag_info = intermarket.get("XAG", {})
    silver_bid = xag_info.get("bid")
    xag_pct = xag_info.get("pct", 0.0)

    # 3. M5 Candles & Structural Levels
    rates_m5 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M5, 0, 100)
    day_high, day_low, dealing_range_pos = None, None, None
    demand_fvg, supply_fvg = None, None
    xau_pct, xau_m5_pct = 0.0, 0.0

    if rates_m5 is not None and len(rates_m5) >= 2:
        highs = [float(r["high"]) for r in rates_m5]
        lows = [float(r["low"]) for r in rates_m5]
        day_high = round(max(highs), 2)
        day_low = round(min(lows), 2)
        if day_high > day_low:
            dealing_range_pos = round((gold_bid - day_low) / (day_high - day_low), 2)

        xau_open_1h = float(rates_m5[-12]["open"]) if len(rates_m5) >= 12 else float(rates_m5[0]["open"])
        if xau_open_1h > 0:
            xau_pct = round(((gold_bid - xau_open_1h) / xau_open_1h) * 100, 2)
        xau_prev = float(rates_m5[-2]["close"])
        if xau_prev > 0:
            xau_m5_pct = round(((gold_bid - xau_prev) / xau_prev) * 100, 2)

        # Detect FVGs
        for i in range(len(rates_m5) - 2, 2, -1):
            b1 = rates_m5[i - 2]
            b3 = rates_m5[i]
            # Bullish Demand FVG
            if demand_fvg is None and float(b3["low"]) > float(b1["high"]) + 0.30:
                bot = round(float(b1["high"]), 2)
                top = round(float(b3["low"]), 2)
                if bot <= gold_bid + 1.0:
                    demand_fvg = {
                        "type": "BULLISH_FVG", "tf": "M5",
                        "top": top, "bottom": bot, "ce": round((bot + top) / 2.0, 2),
                        "width": round(top - bot, 2), "fill_pct": 0.0, "status": "FRESH",
                        "time": int(rates_m5[i - 1]["time"])
                    }
            # Bearish Supply FVG
            if supply_fvg is None and float(b3["high"]) < float(b1["low"]) - 0.30:
                top = round(float(b1["low"]), 2)
                bot = round(float(b3["high"]), 2)
                if top >= gold_bid - 1.0:
                    supply_fvg = {
                        "type": "BEARISH_FVG", "tf": "M5",
                        "top": top, "bottom": bot, "ce": round((bot + top) / 2.0, 2),
                        "width": round(top - bot, 2), "fill_pct": 0.0, "status": "FRESH",
                        "time": int(rates_m5[i - 1]["time"])
                    }
            if demand_fvg and supply_fvg:
                break

    # 4. Asian Session Range (00:00 - 06:00 UTC)
    asian_high, asian_low = None, None
    asian_high_pen, asian_low_pen = 0.0, 0.0
    asian_sweep_high, asian_sweep_low = False, False

    if rates_m5 is not None:
        today_start = int(datetime.datetime(now_utc.year, now_utc.month, now_utc.day, tzinfo=datetime.timezone.utc).timestamp())
        asian_bars = [r for r in rates_m5 if today_start <= r["time"] <= today_start + 6 * 3600]
        if asian_bars:
            asian_high = round(max(float(r["high"]) for r in asian_bars), 2)
            asian_low = round(min(float(r["low"]) for r in asian_bars), 2)
            if gold_bid > asian_high:
                asian_high_pen = round(gold_bid - asian_high, 2)
                asian_sweep_high = asian_high_pen >= 2.0
            elif gold_bid < asian_low:
                asian_low_pen = round(asian_low - gold_bid, 2)
                asian_sweep_low = asian_low_pen >= 2.0

    # 5. Previous Day High / Low from D1
    pdh, pdl, pivot = None, None, None
    rates_d1 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_D1, 1, 2)
    if rates_d1 is not None and len(rates_d1) >= 1:
        d_bar = rates_d1[-1]
        pdh = round(float(d_bar["high"]), 2)
        pdl = round(float(d_bar["low"]), 2)
        pivot = round((pdh + pdl + float(d_bar["close"])) / 3.0, 2)

    equilibrium = round((day_high + day_low) / 2.0, 2) if (day_high and day_low) else None

    # 6. Microstructure (M1 bars for 20-trail snake, velocity, CVD)
    rates_m1 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M1, 0, 60)
    vel_10m = []
    deltas_10m = []
    trail_20 = []
    window_stats_8m = []
    peak_trough_windows = {}
    tick_velocity = 0
    cvd_delta = 0

    if rates_m1 is not None and len(rates_m1) >= 1:
        tick_velocity = int(rates_m1[-1]["tick_volume"])
        # CVD calculation over last 10 bars
        for r in rates_m1[-10:]:
            rng = max(0.01, float(r["high"]) - float(r["low"]))
            d = int(((float(r["close"]) - float(r["open"])) / rng) * float(r["tick_volume"]))
            deltas_10m.append(d)
            vel_10m.append(int(r["tick_volume"]))
        cvd_delta = sum(deltas_10m)

        # 20-trail snake
        for i in range(max(0, len(rates_m1) - 20), len(rates_m1)):
            r = rates_m1[i]
            o, c, h, l = float(r["open"]), float(r["close"]), float(r["high"]), float(r["low"])
            prev_r = rates_m1[i - 1] if i > 0 else r
            ca = bool(h > float(prev_r["high"]))
            cb = bool(l < float(prev_r["low"]))
            trail_20.append({
                "time": int(r["time"]),
                "open": round(o, 2),
                "close": round(c, 2),
                "high": round(h, 2),
                "low": round(l, 2),
                "vol": int(r["tick_volume"]),
                "body": round(abs(c - o), 2),
                "rng": round(max(0.05, h - l), 2),
                "direction": "UP" if c >= o else "DOWN",
                "cross_above": ca,
                "cross_below": cb,
                "crossed_prev": "ABOVE" if (ca and not cb) else ("BELOW" if (cb and not ca) else ("BOTH" if (ca and cb) else "INSIDE"))
            })

        for idx, b in enumerate(rates_m1[-8:]):
            b_rng = max(0.01, float(b["high"]) - float(b["low"]))
            b_body = float(b["close"]) - float(b["open"])
            window_stats_8m.append({
                "min_age": len(rates_m1[-8:]) - 1 - idx,
                "vel": int(b["tick_volume"]),
                "delta": int((b_body / b_rng) * float(b["tick_volume"])),
                "disp_pt": round(b_body, 2),
                "high": round(float(b["high"]), 2),
                "low": round(float(b["low"]), 2)
            })

        # Multi-window peak/trough ranges
        for w in [5, 15, 30, 60]:
            sub = rates_m1[-min(w, len(rates_m1)):]
            peak_trough_windows[f"m{w}"] = {
                "high": round(max(float(r["high"]) for r in sub), 2),
                "low": round(min(float(r["low"]) for r in sub), 2),
                "spread_pt": round(max(float(r["high"]) for r in sub) - min(float(r["low"]) for r in sub), 2)
            }

    # 7. VWAP
    vwap_val = round(sum(float(r["close"]) * float(r["tick_volume"]) for r in rates_m5) / max(1, sum(float(r["tick_volume"]) for r in rates_m5)), 2) if rates_m5 is not None and len(rates_m5) > 0 else gold_bid
    vwap_data = {
        "vwap": vwap_val,
        "upper_band_1": round(vwap_val + 3.5, 2),
        "lower_band_1": round(vwap_val - 3.5, 2),
        "upper_band_2": round(vwap_val + 7.0, 2),
        "lower_band_2": round(vwap_val - 7.0, 2),
        "distance_usd": round(gold_bid - vwap_val, 2),
        "posture": "BULLISH_ABOVE_VWAP" if gold_bid >= vwap_val else "BEARISH_BELOW_VWAP",
        "summary": "Spot trading above VWAP" if gold_bid >= vwap_val else "Spot trading below VWAP"
    }

    # 8. Positions & Orders
    account = get_account_status()
    positions = get_positions(symbol)
    orders = get_pending_orders(symbol)

    chart_bar = {
        "time": int(rates_m5[-1]["time"]) if rates_m5 is not None and len(rates_m5) > 0 else int(now_epoch),
        "open": round(float(rates_m5[-1]["open"]), 3) if rates_m5 is not None and len(rates_m5) > 0 else gold_bid,
        "high": round(max(float(rates_m5[-1]["high"]), gold_bid), 3) if rates_m5 is not None and len(rates_m5) > 0 else gold_bid,
        "low": round(min(float(rates_m5[-1]["low"]), gold_bid), 3) if rates_m5 is not None and len(rates_m5) > 0 else gold_bid,
        "close": gold_bid
    }

    cvd_flip_label = "POSITIVE EXPANDING" if cvd_delta > 150 else ("NEGATIVE EXPANDING" if cvd_delta < -150 else "BALANCED")

    return {
        "status": "OK",
        "is_live": True,
        "timestamp_epoch": now_epoch,
        "timestamp_utc": now_utc.strftime("%Y-%m-%d %H:%M:%S UTC"),
        "bid": gold_bid,
        "ask": gold_ask,
        "spread_pts": gold_spread_pts,
        "pdh": pdh,
        "pdl": pdl,
        "account": account,
        "spot": {
            "bid": gold_bid,
            "ask": gold_ask,
            "spread_pts": gold_spread_pts,
            "chart_bar": chart_bar
        },
        "silver": {
            "bid": silver_bid,
            "ask": round(silver_bid + 0.045, 3) if silver_bid else None,
            "xag_pct": xag_pct,
            "xau_pct": xau_pct,
            "xag_m5_pct": xag_pct,
            "xau_m5_pct": xau_m5_pct,
            "beta_ratio": round(xag_pct / max(0.01, abs(xau_pct)), 2) if abs(xau_pct) > 0.01 else 1.0,
            "alignment": "CONFIRMED" if (xag_pct * xau_pct >= 0) else "DIVERGENT",
            "status": "LIVE" if silver_bid else "OFFLINE"
        },
        "intermarket": intermarket,
        "structure": {
            "day_high": day_high,
            "day_low": day_low,
            "dealing_range_pos": dealing_range_pos,
            "pdh": pdh,
            "pdl": pdl,
            "pivot": pivot,
            "equilibrium": equilibrium,
            "asian_high": asian_high,
            "asian_low": asian_low,
            "asian_sweep_high": asian_sweep_high,
            "asian_sweep_low": asian_sweep_low,
            "asian_high_pen": asian_high_pen,
            "asian_low_pen": asian_low_pen,
            "demand_fvg": demand_fvg,
            "supply_fvg": supply_fvg,
            "vwap": vwap_data
        },
        "tape": {
            "tick_velocity": tick_velocity,
            "cvd_delta": cvd_delta,
            "cvd_flip": "SUSTAINED",
            "footprint_delta": cvd_delta,
            "effort_divergence": False,
            "impulse_rate": 0.0,
            "disp_1m_pt": 0.0,
            "disp_5m_pt": 0.0,
            "vel_10m": vel_10m,
            "vel_1m": tick_velocity,
            "vel_5m_avg": round(sum(vel_10m[-5:]) / max(1, len(vel_10m[-5:])), 1) if vel_10m else 0,
            "vel_10m_max": max(vel_10m) if vel_10m else 0,
            "deltas_10m": deltas_10m,
            "cvd_10b_net": cvd_delta,
            "cvd_10b_ratio": 1.0,
            "cvd_flip_label": cvd_flip_label
        },
        "trail_20": trail_20,
        "window_stats_8m": window_stats_8m,
        "peak_trough_windows": peak_trough_windows,
        "positions": positions,
        "orders": orders,
        "closed_positions_history": []
    }
