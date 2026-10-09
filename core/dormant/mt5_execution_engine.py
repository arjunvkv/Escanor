"""
Escanor MT5 Execution Engine (Dormant Core Module)
Clean, robust execution functions for MT5 market & pending orders, SL/TP modification,
breakeven armoring, and position management.
"""

import re
import json
import logging
from typing import Dict, Any, Optional

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None

logger = logging.getLogger("escanor.execution")


def execute_market_order(
    symbol: str = "XAUUSD",
    side: str = "BUY",
    volume: float = 1.0,
    sl: float = 0.0,
    tp: float = 0.0,
    comment: str = "Escanor Market Order",
    magic: int = 234000
) -> Dict[str, Any]:
    """Execute direct market order on MT5."""
    if not mt5:
        return {"status": "FAILED", "error": "MetaTrader5 module not available"}

    sym_info = mt5.symbol_info(symbol)
    if not sym_info or not sym_info.visible:
        if not mt5.symbol_select(symbol, True):
            return {"status": "FAILED", "error": f"Symbol {symbol} not found"}
        sym_info = mt5.symbol_info(symbol)

    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return {"status": "FAILED", "error": f"No tick for {symbol}"}

    s_side = side.strip().upper()
    order_type = mt5.ORDER_TYPE_BUY if s_side == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if s_side == "BUY" else tick.bid

    step = sym_info.volume_step or 0.01
    vol = round(round(volume / step) * step, 2)
    vol = max(sym_info.volume_min, min(sym_info.volume_max, vol))

    filling_mode = mt5.ORDER_FILLING_IOC
    if sym_info.filling_mode & 1:
        filling_mode = mt5.ORDER_FILLING_IOC
    elif sym_info.filling_mode & 2:
        filling_mode = mt5.ORDER_FILLING_FOK

    clean_comment = re.sub(r'[^A-Za-z0-9_\- ]', '', str(comment or "Escanor"))[:25]
    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": vol,
        "type": order_type,
        "price": price,
        "sl": float(sl) if sl else 0.0,
        "tp": float(tp) if tp else 0.0,
        "deviation": 50,
        "magic": magic,
        "comment": clean_comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode
    }

    res = mt5.order_send(req)
    if not res or res.retcode == 10030:
        req["type_filling"] = mt5.ORDER_FILLING_FOK if filling_mode != mt5.ORDER_FILLING_FOK else mt5.ORDER_FILLING_IOC
        res = mt5.order_send(req)

    if res and res.retcode == mt5.TRADE_RETCODE_DONE:
        return {
            "status": "EXECUTED",
            "symbol": symbol,
            "side": s_side,
            "volume": vol,
            "price": price,
            "sl": sl,
            "tp": tp,
            "ticket": res.order,
            "retcode": res.retcode,
            "message": f"Market order filled! Active ticket #{res.order} is live on MT5."
        }

    err = f"MT5 Retcode {getattr(res, 'retcode', 'Unknown')}: {getattr(res, 'comment', 'Failed')}" if res else f"Last error: {mt5.last_error()}"
    return {"status": "FAILED", "symbol": symbol, "error": err, "retcode": getattr(res, 'retcode', None)}


def place_pending_order(
    symbol: str = "XAUUSD",
    order_type: str = "BUY_LIMIT",
    price: float = 0.0,
    volume: float = 1.0,
    sl: float = 0.0,
    tp: float = 0.0,
    comment: str = "Escanor Pending Order",
    magic: int = 234000
) -> Dict[str, Any]:
    """Place pending limit/stop order on MT5."""
    if not mt5:
        return {"status": "FAILED", "error": "MetaTrader5 module not available"}

    type_map = {
        "BUY_LIMIT": mt5.ORDER_TYPE_BUY_LIMIT,
        "SELL_LIMIT": mt5.ORDER_TYPE_SELL_LIMIT,
        "BUY_STOP": mt5.ORDER_TYPE_BUY_STOP,
        "SELL_STOP": mt5.ORDER_TYPE_SELL_STOP
    }
    ot = type_map.get(order_type.upper())
    if ot is None:
        return {"status": "FAILED", "error": f"Invalid order type: {order_type}"}

    sym_info = mt5.symbol_info(symbol)
    if not sym_info:
        return {"status": "FAILED", "error": f"Symbol {symbol} not found"}

    step = sym_info.volume_step or 0.01
    vol = round(round(volume / step) * step, 2)
    clean_comment = re.sub(r'[^A-Za-z0-9_\- ]', '', str(comment or "Escanor"))[:25]

    req = {
        "action": mt5.TRADE_ACTION_PENDING,
        "symbol": symbol,
        "volume": vol,
        "type": ot,
        "price": float(price),
        "sl": float(sl) if sl else 0.0,
        "tp": float(tp) if tp else 0.0,
        "magic": magic,
        "comment": clean_comment,
        "type_time": mt5.ORDER_TIME_GTC
    }
    res = mt5.order_send(req)
    if res and res.retcode == mt5.TRADE_RETCODE_DONE:
        return {
            "status": "PLACED",
            "symbol": symbol,
            "type": order_type.upper(),
            "volume": vol,
            "price": price,
            "ticket": res.order,
            "retcode": res.retcode
        }
    err = f"MT5 Retcode {getattr(res, 'retcode', 'Unknown')}: {getattr(res, 'comment', 'Failed')}" if res else f"Last error: {mt5.last_error()}"
    return {"status": "FAILED", "error": err, "retcode": getattr(res, 'retcode', None)}


def modify_position(ticket: int, sl: Optional[float] = None, tp: Optional[float] = None) -> Dict[str, Any]:
    """Modify SL and TP for open position or pending order."""
    if not mt5:
        return {"status": "FAILED", "error": "MetaTrader5 module not available"}

    # 1. Check open positions
    pos = None
    for p in mt5.positions_get() or ():
        if p.ticket == ticket:
            pos = p
            break

    if pos:
        sym_info = mt5.symbol_info(pos.symbol)
        digits = getattr(sym_info, "digits", 2)
        tick = mt5.symbol_info_tick(pos.symbol)

        clean_sl = round(float(sl), digits) if sl is not None and float(sl) > 0 else (0.0 if sl == 0 else pos.sl)
        clean_tp = round(float(tp), digits) if tp is not None and float(tp) > 0 else (0.0 if tp == 0 else pos.tp)

        # Validate stops against live price if available to provide crystal-clear guidance
        if tick:
            bid = tick.bid
            ask = tick.ask
            min_dist = (getattr(sym_info, "trade_stops_level", 0) or 0) * (getattr(sym_info, "point", 0.01) or 0.01)

            if pos.type == 0:  # BUY
                if clean_sl > 0 and clean_sl >= (bid - min_dist):
                    return {
                        "status": "FAILED",
                        "error": f"Invalid Stop Loss: For BUY #{ticket}, SL (${clean_sl:.2f}) must be below market bid (${bid:.2f})"
                    }
                if clean_tp > 0 and clean_tp <= (ask + min_dist):
                    return {
                        "status": "FAILED",
                        "error": f"Invalid Take Profit: For BUY #{ticket}, TP (${clean_tp:.2f}) must be above market ask (${ask:.2f})"
                    }
            elif pos.type == 1:  # SELL
                if clean_sl > 0 and clean_sl <= (ask + min_dist):
                    return {
                        "status": "FAILED",
                        "error": f"Invalid Stop Loss: For SELL #{ticket}, SL (${clean_sl:.2f}) must be above market ask (${ask:.2f})"
                    }
                if clean_tp > 0 and clean_tp >= (bid - min_dist):
                    return {
                        "status": "FAILED",
                        "error": f"Invalid Take Profit: For SELL #{ticket}, TP (${clean_tp:.2f}) must be below market bid (${bid:.2f})"
                    }

        req = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": ticket,
            "symbol": pos.symbol,
            "sl": clean_sl,
            "tp": clean_tp
        }
        res = mt5.order_send(req)
        # 10009: DONE, 10008: PLACED, 10025: NO CHANGES (already set)
        if res and res.retcode in (mt5.TRADE_RETCODE_DONE, 10008, 10009, 10025):
            return {"status": "MODIFIED", "ticket": ticket, "sl": clean_sl, "tp": clean_tp}

        retcode = getattr(res, "retcode", None)
        comment = getattr(res, "comment", "Failed")
        if retcode == 10016:
            comment = "Invalid stops (SL/TP placed on wrong side of market price or within broker freeze level)"
        return {"status": "FAILED", "error": f"Retcode {retcode}: {comment}"}

    # 2. Check pending orders if not in open positions
    order = None
    for o in mt5.orders_get() or ():
        if o.ticket == ticket:
            order = o
            break

    if order:
        sym_info = mt5.symbol_info(order.symbol)
        digits = getattr(sym_info, "digits", 2)
        clean_sl = round(float(sl), digits) if sl is not None and float(sl) > 0 else (0.0 if sl == 0 else order.sl)
        clean_tp = round(float(tp), digits) if tp is not None and float(tp) > 0 else (0.0 if tp == 0 else order.tp)

        req = {
            "action": mt5.TRADE_ACTION_MODIFY,
            "order": ticket,
            "symbol": order.symbol,
            "price": order.price_open,
            "sl": clean_sl,
            "tp": clean_tp,
            "type_time": mt5.ORDER_TIME_GTC
        }
        res = mt5.order_send(req)
        if res and res.retcode in (mt5.TRADE_RETCODE_DONE, 10008, 10009, 10025):
            return {"status": "MODIFIED", "ticket": ticket, "sl": clean_sl, "tp": clean_tp}

        return {"status": "FAILED", "error": f"Pending order #{ticket} modify failed: Retcode {getattr(res, 'retcode', None)}"}

    return {"status": "FAILED", "error": f"Position or order ticket #{ticket} not found"}


def close_position(ticket: int, is_pending: bool = False) -> Dict[str, Any]:
    """Close single open position at market or cancel pending order."""
    if not mt5:
        return {"status": "FAILED", "error": "MetaTrader5 module not available"}

    # 1. Check if explicitly flagged as pending order
    if is_pending:
        req = {
            "action": mt5.TRADE_ACTION_REMOVE,
            "order": ticket
        }
        res = mt5.order_send(req)
        if res and res.retcode == mt5.TRADE_RETCODE_DONE:
            return {"status": "OK", "ticket": ticket, "message": "Pending order canceled"}
        return {"status": "FAILED", "error": f"Retcode {getattr(res, 'retcode', None)}: {getattr(res, 'comment', 'Failed')}"}

    # 2. Check in positions
    pos = None
    for p in mt5.positions_get() or ():
        if p.ticket == ticket:
            pos = p
            break

    if not pos:
        # Check if it was actually a pending order in orders_get
        for o in mt5.orders_get() or ():
            if o.ticket == ticket:
                req = {
                    "action": mt5.TRADE_ACTION_REMOVE,
                    "order": ticket
                }
                res = mt5.order_send(req)
                if res and res.retcode == mt5.TRADE_RETCODE_DONE:
                    return {"status": "OK", "ticket": ticket, "message": "Pending order canceled"}
                return {"status": "FAILED", "error": f"Retcode {getattr(res, 'retcode', None)}"}
        return {"status": "FAILED", "error": f"Ticket #{ticket} not found"}

    close_type = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY
    tick = mt5.symbol_info_tick(pos.symbol)
    price = tick.bid if pos.type == 0 else tick.ask

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": pos.symbol,
        "volume": pos.volume,
        "type": close_type,
        "position": ticket,
        "price": price,
        "deviation": 50,
        "comment": "Escanor Close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC
    }
    res = mt5.order_send(req)
    if res and res.retcode == mt5.TRADE_RETCODE_DONE:
        return {"status": "OK", "ticket": ticket, "close_price": price}
    return {"status": "FAILED", "error": f"Retcode {getattr(res, 'retcode', None)}: {getattr(res, 'comment', 'Failed')}"}


def close_all_positions(symbol: Optional[str] = None) -> Dict[str, Any]:
    """Close all open positions and cancel all pending orders matching symbol or all."""
    if not mt5:
        return {"status": "FAILED", "error": "MetaTrader5 module not available"}

    closed = []
    # 1. Close active positions
    positions = mt5.positions_get() or ()
    for p in positions:
        if symbol and symbol != "ALL" and p.symbol != symbol:
            continue
        res = close_position(p.ticket)
        closed.append({"ticket": p.ticket, "type": "POSITION", "res": res})

    # 2. Cancel pending orders
    orders = mt5.orders_get() or ()
    for o in orders:
        if symbol and symbol != "ALL" and o.symbol != symbol:
            continue
        req = {
            "action": mt5.TRADE_ACTION_REMOVE,
            "order": o.ticket
        }
        res = mt5.order_send(req)
        closed.append({"ticket": o.ticket, "type": "ORDER", "res": getattr(res, "retcode", None)})

    return {"status": "OK", "closed_count": len(closed), "results": closed}
