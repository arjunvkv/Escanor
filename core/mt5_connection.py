"""
Escanor MT5 Connection & Data Feed
Connects directly to MetaTrader 5 and exposes candle streams, ticks, and account state.
"""

import os
import json
import time
import logging
from typing import Optional, List, Dict, Any

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None

logger = logging.getLogger("escanor.mt5")
FTMO_PATH = r"C:\Program Files\FTMO Global Markets MT5 Terminal\terminal64.exe"

TIMEFRAME_MAP = {
    "1": 1, "M1": 1,
    "5": 5, "M5": 5,
    "15": 15, "M15": 15,
    "30": 30, "M30": 30,
    "60": 60, "1H": 60, "H1": 60,
    "240": 240, "4H": 240, "H4": 240,
    "D1": 1440, "1D": 1440
}


def init_mt5(timeout: int = 5000) -> bool:
    """Initialize connection to MetaTrader 5 terminal."""
    if not mt5:
        logger.error("MetaTrader5 package not installed.")
        return False

    try:
        t_info = mt5.terminal_info()
        if t_info is not None and getattr(t_info, "connected", False):
            return True

        creds_path = os.path.join(os.path.dirname(__file__), "mt5_credentials.json")
        creds = {}
        if os.path.exists(creds_path):
            try:
                with open(creds_path, "r", encoding="utf-8") as f:
                    creds = json.load(f)
            except Exception:
                pass

        kwargs: Dict[str, Any] = {"timeout": timeout}
        if os.path.exists(FTMO_PATH):
            kwargs["path"] = FTMO_PATH
        if creds.get("login"):
            kwargs["login"] = creds["login"]
        if creds.get("password"):
            kwargs["password"] = creds["password"]
        if creds.get("server"):
            kwargs["server"] = creds["server"]

        ok = mt5.initialize(**kwargs)
        if not ok:
            ok = mt5.initialize(timeout=timeout)
        return bool(ok)
    except Exception as err:
        logger.error(f"MT5 initialization failed: {err}")
        return False


def get_tick(symbol: str = "XAUUSD") -> Optional[Dict[str, Any]]:
    """Fetch live spot tick for symbol."""
    if not init_mt5():
        return None
    try:
        mt5.symbol_select(symbol, True)
        tick = mt5.symbol_info_tick(symbol)
        info = mt5.symbol_info(symbol)
        if not tick:
            return None
        bid = round(float(tick.bid), 2)
        ask = round(float(tick.ask), 2)
        spread = int(info.spread) if info else round((ask - bid) * 100)
        return {
            "symbol": symbol,
            "bid": bid,
            "ask": ask,
            "spread": spread,
            "time": int(tick.time),
            "timestamp": time.time()
        }
    except Exception as err:
        logger.error(f"get_tick error: {err}")
        return None


def get_candles(symbol: str = "XAUUSD", timeframe: str = "5", count: int = 200) -> List[Dict[str, Any]]:
    """Fetch OHLCV candles formatted for KLineCharts (timestamp in ms, open, high, low, close, volume)."""
    if not init_mt5():
        return []

    tf_int = TIMEFRAME_MAP.get(str(timeframe).upper(), 5)
    try:
        mt5.symbol_select(symbol, True)
        rates = mt5.copy_rates_from_pos(symbol, tf_int, 0, count)
        if rates is None or len(rates) == 0:
            return []

        candles = []
        for r in rates:
            candles.append({
                "timestamp": int(r["time"]) * 1000,
                "open": round(float(r["open"]), 3),
                "high": round(float(r["high"]), 3),
                "low": round(float(r["low"]), 3),
                "close": round(float(r["close"]), 3),
                "volume": int(r["tick_volume"]),
                "turnover": round(float(r["close"]) * float(r["tick_volume"]), 2)
            })
        return candles
    except Exception as err:
        logger.error(f"get_candles error: {err}")
        return []


def get_account_status() -> Dict[str, Any]:
    """Fetch real-time MT5 account metrics."""
    if not init_mt5():
        return {"balance": 0, "equity": 0, "margin": 0, "free_margin": 0}
    try:
        acc = mt5.account_info()
        if not acc:
            return {"balance": 0, "equity": 0, "margin": 0, "free_margin": 0}
        return {
            "login": getattr(acc, "login", None),
            "server": getattr(acc, "server", None),
            "balance": round(float(getattr(acc, "balance", 0.0)), 2),
            "equity": round(float(getattr(acc, "equity", 0.0)), 2),
            "margin": round(float(getattr(acc, "margin", 0.0)), 2),
            "free_margin": round(float(getattr(acc, "margin_free", 0.0)), 2),
            "currency": getattr(acc, "currency", "USD")
        }
    except Exception:
        return {"balance": 0, "equity": 0, "margin": 0, "free_margin": 0}


def get_positions(symbol: Optional[str] = None) -> List[Dict[str, Any]]:
    """Fetch open MT5 positions."""
    if not init_mt5():
        return []
    try:
        positions = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
        if not positions:
            return []
        res = []
        tick_gold = mt5.symbol_info_tick("XAUUSD")
        for p in positions:
            p_type = "BUY" if p.type == 0 else "SELL"
            cur_p = (tick_gold.bid if p.type == 0 else tick_gold.ask) if tick_gold else p.price_open
            profit_pts = round((cur_p - p.price_open) if p.type == 0 else (p.price_open - cur_p), 2)
            res.append({
                "ticket": int(p.ticket),
                "symbol": str(p.symbol),
                "type": p_type,
                "volume": float(p.volume),
                "price_open": round(float(p.price_open), 2),
                "sl": round(float(p.sl), 2) if p.sl else None,
                "tp": round(float(p.tp), 2) if p.tp else None,
                "profit": round(float(p.profit), 2),
                "profit_pts": profit_pts,
                "time": int(p.time),
                "elapsed_sec": max(0, int(time.time() - p.time)),
                "open_epoch_utc": int(p.time)
            })
        return res
    except Exception as err:
        logger.error(f"get_positions error: {err}")
        return []


def get_pending_orders(symbol: Optional[str] = None) -> List[Dict[str, Any]]:
    """Fetch resting MT5 pending orders."""
    if not init_mt5():
        return []
    try:
        orders = mt5.orders_get(symbol=symbol) if symbol else mt5.orders_get()
        if not orders:
            return []
        type_names = {
            2: "BUY_LIMIT", 3: "SELL_LIMIT",
            4: "BUY_STOP", 5: "SELL_STOP"
        }
        res = []
        for o in orders:
            res.append({
                "ticket": int(o.ticket),
                "symbol": str(o.symbol),
                "type": type_names.get(o.type, f"TYPE_{o.type}"),
                "volume": float(o.volume_initial),
                "price_open": round(float(o.price_open), 2),
                "sl": round(float(o.sl), 2) if o.sl else None,
                "tp": round(float(o.tp), 2) if o.tp else None,
                "time_setup": int(o.time_setup)
            })
        return res
    except Exception as err:
        logger.error(f"get_pending_orders error: {err}")
        return []
