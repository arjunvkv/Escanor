"""
Escanor Telemetry & Chart Daemon
Pure, lightweight FastAPI + WebSocket daemon serving:
- Mobile Terminal HUD (Port 5055 HTTP + Port 5056 WS)
- Desktop TradingView Clone Chart
- Server-side Drawings Persistence
- MT5 Direct Trade Execution
Zero news scraping, zero LLM polling, zero MCP overhead.
"""

import os
import sys
import json
import time
import base64
from datetime import datetime, timedelta
import asyncio
import logging
from typing import Dict, Any, List, Optional
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import websockets

# Ensure Escanor root is in sys.path
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from core.mt5_connection import init_mt5, get_candles, get_tick, get_positions, get_pending_orders, get_account_status
from core.structure_engine import compute_telemetry_snapshot
from core.dormant.mt5_execution_engine import (
    execute_market_order, place_pending_order, modify_position, close_position, close_all_positions
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("escanor.server")

# Load configuration
CONFIG_PATH = BASE_DIR / "config.json"
DRAWINGS_PATH = BASE_DIR / "data" / "drawings.json"
DRAWINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
EVALUATION_VIEW_PATH = BASE_DIR / "data" / "active_evaluation_view.json"
EVALUATION_SNAPSHOT_PATH = BASE_DIR / "data" / "active_evaluation_snapshot.png"
DRAWDOWN_PATH = BASE_DIR / "data" / "drawdown.json"

drawdown_config: Dict[str, Any] = {
    "enabled": True,
    "max_drawdown": 500.0,
    "is_locked": False,
    "locked_at": None,
    "date": datetime.now().strftime("%Y-%m-%d")
}

def load_drawdown_config():
    global drawdown_config
    if DRAWDOWN_PATH.exists():
        try:
            with open(DRAWDOWN_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
                today_str = datetime.now().strftime("%Y-%m-%d")
                # Automatically reset lock if date changed
                if saved.get("date") != today_str:
                    saved["date"] = today_str
                    saved["is_locked"] = False
                    saved["locked_at"] = None
                drawdown_config.update(saved)
        except Exception as e:
            logger.warning(f"Error reading drawdown.json: {e}")

def save_drawdown_config():
    try:
        DRAWDOWN_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(DRAWDOWN_PATH, "w", encoding="utf-8") as f:
            json.dump(drawdown_config, f, indent=2)
    except Exception as e:
        logger.error(f"Error saving drawdown.json: {e}")

load_drawdown_config()

def compute_daily_drawdown_stats() -> Dict[str, Any]:
    """Compute today's exact closed deals PnL, floating PnL, and drawdown buffer."""
    import MetaTrader5 as mt5
    now = datetime.now()
    start_of_day = datetime(now.year, now.month, now.day, 0, 0, 0)
    today_str = start_of_day.strftime("%Y-%m-%d")

    # If calendar day has rolled over, unlock automatically for new day
    if drawdown_config.get("date") != today_str:
        drawdown_config["date"] = today_str
        drawdown_config["is_locked"] = False
        drawdown_config["locked_at"] = None
        save_drawdown_config()

    try:
        if not mt5.terminal_info():
            mt5.initialize()
    except Exception as e:
        logger.warning(f"MT5 initialize check error in drawdown: {e}")

    realized = 0.0
    deals_count = 0
    try:
        deals = mt5.history_deals_get(start_of_day, now + timedelta(hours=4))
        if deals:
            for d in deals:
                if getattr(d, 'entry', -1) == 1 or (getattr(d, 'profit', 0) != 0 and getattr(d, 'entry', -1) != 0):
                    realized += float(getattr(d, 'profit', 0.0)) + float(getattr(d, 'commission', 0.0)) + float(getattr(d, 'swap', 0.0))
                    deals_count += 1
    except Exception as e:
        logger.warning(f"Error reading MT5 deals for drawdown: {e}")

    positions = []
    try:
        positions = mt5.positions_get() or []
    except Exception:
        pass

    floating = sum(float(getattr(p, 'profit', 0.0)) for p in positions)
    net_pnl = round(realized + floating, 2)
    today_loss = max(0.0, -net_pnl)
    max_dd = float(drawdown_config.get("max_drawdown", 500.0))
    remaining = max(0.0, round(max_dd - today_loss, 2))

    return {
        "today_realized": round(realized, 2),
        "realized": round(realized, 2),
        "today_floating": round(floating, 2),
        "floating": round(floating, 2),
        "today_net": net_pnl,
        "net_today": net_pnl,
        "today_loss": round(today_loss, 2),
        "deals_count": deals_count,
        "max_drawdown": max_dd,
        "remaining": remaining,
        "enabled": bool(drawdown_config.get("enabled", True)),
        "is_locked": bool(drawdown_config.get("is_locked", False)),
        "locked_at": drawdown_config.get("locked_at")
    }

async def check_daily_drawdown_limit(sym: str = "XAUUSD") -> Dict[str, Any]:
    """Check if daily drawdown buffer has reached 0. If so, flatten all positions and lock."""
    stats = compute_daily_drawdown_stats()
    if stats["enabled"] and not stats["is_locked"]:
        if stats["remaining"] <= 0.0 and stats["today_loss"] >= stats["max_drawdown"]:
            logger.warning(f"🚨 CRITICAL DAILY DRAWDOWN LIMIT REACHED: Loss ${stats['today_loss']} >= Max ${stats['max_drawdown']}. LOCKING TRADING AND CLOSING ALL TRADES!")
            drawdown_config["is_locked"] = True
            drawdown_config["locked_at"] = datetime.now().isoformat()
            save_drawdown_config()
            try:
                close_res = close_all_positions(sym)
                logger.info(f"Daily drawdown auto-close result: {close_res}")
            except Exception as ce:
                logger.error(f"Error during drawdown auto-close: {ce}")
            stats["is_locked"] = True
    return stats

config = {
    "symbol": "XAUUSD",
    "http_port": 5055,
    "ws_port": 5056,
    "mt5_magic": 234000
}
if CONFIG_PATH.exists():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            config.update(json.load(f))
    except Exception as e:
        logger.warning(f"Error reading config.json: {e}")

app = FastAPI(title="Escanor Terminal Daemon")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.endswith((".js", ".css", ".html")) or path in ("/mobile", "/chart", "/", "/mobile_app"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# Active WebSocket connections
active_ws_clients: set = set()


# =========================================================================
# 📡 HTTP REST API ENDPOINTS
# =========================================================================

@app.get("/api/telemetry")
async def get_telemetry():
    """Return live market structure and telemetry snapshot for mobile HUD & chart."""
    snap = compute_telemetry_snapshot(config.get("symbol", "XAUUSD"))
    if isinstance(snap, dict):
        snap["armed_breakevens"] = list(armed_breakeven_positions.keys())
        snap["drawdown"] = compute_daily_drawdown_stats()
    return JSONResponse(content=snap)


@app.get("/api/candles")
async def get_candles_endpoint(symbol: str = "XAUUSD", timeframe: str = "5", count: int = 300, end_time: Optional[int] = None):
    """Fetch MT5 OHLCV candles formatted for KLineCharts.
    Supports end_time for loading historical candles on scroll left."""
    try:
        c_int = int(count) if count else 300
    except (ValueError, TypeError):
        c_int = 300
    candles = get_candles(symbol=symbol, timeframe=str(timeframe), count=c_int, end_time=end_time)
    return JSONResponse(content={"status": "OK", "symbol": symbol, "timeframe": timeframe, "candles": candles})


@app.get("/api/drawings")
async def get_drawings(symbol: str = "XAUUSD"):
    """Fetch saved chart drawings from server-side storage."""
    if DRAWINGS_PATH.exists():
        try:
            with open(DRAWINGS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                return JSONResponse(content={"status": "OK", "drawings": data.get(symbol, [])})
        except Exception as e:
            logger.error(f"Failed to read drawings: {e}")
    return JSONResponse(content={"status": "OK", "drawings": []})


@app.post("/api/drawings")
async def save_drawings(request: Request):
    """Persist chart drawings on the server so they sync across all devices."""
    try:
        body = await request.json()
        symbol = body.get("symbol", config.get("symbol", "XAUUSD"))
        drawings = body.get("drawings", [])
        
        all_drawings = {}
        if DRAWINGS_PATH.exists():
            try:
                with open(DRAWINGS_PATH, "r", encoding="utf-8") as f:
                    all_drawings = json.load(f)
            except Exception:
                all_drawings = {}

        all_drawings[symbol] = drawings
        with open(DRAWINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(all_drawings, f, indent=2)

        # Broadcast DRAWINGS_UPDATED so all connected charts sync in real time
        try:
            await broadcast_ws_message({
                "type": "DRAWINGS_UPDATED",
                "symbol": symbol,
                "source": body.get("source", "server_api"),
                "timestamp": time.time()
            })
        except Exception as ws_err:
            logger.warning(f"Could not broadcast drawings update: {ws_err}")

        return JSONResponse(content={"status": "OK", "message": "Drawings saved successfully", "count": len(drawings)})
    except Exception as e:
        logger.error(f"Failed to save drawings: {e}")
        return JSONResponse(content={"status": "ERROR", "message": str(e)}, status_code=500)


@app.post("/api/chart/evaluate_snapshot")
async def save_evaluation_snapshot(request: Request):
    """Receive and persist the visible chart viewport snapshot, candle telemetry, and canvas image for AI sovereign evaluation."""
    try:
        body = await request.json()
        symbol = body.get("symbol", "XAUUSD")
        timeframe = body.get("timeframe", "5m")
        candle_count = body.get("candle_count", 0)
        start_candle = body.get("start_candle", {})
        end_candle = body.get("end_candle", {})
        visible_high = body.get("visible_high")
        visible_low = body.get("visible_low")
        visible_range_pts = body.get("visible_range_pts")
        total_volume = body.get("total_volume")
        visible_bars = body.get("visible_bars", [])
        view_range = body.get("view_range", {})
        image_base64 = body.get("image_base64", "")

        saved_image_path = None
        if image_base64:
            try:
                img_data = image_base64
                if "," in img_data:
                    img_data = img_data.split(",", 1)[1]
                img_bytes = base64.b64decode(img_data)
                EVALUATION_SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
                with open(EVALUATION_SNAPSHOT_PATH, "wb") as f:
                    f.write(img_bytes)
                saved_image_path = str(EVALUATION_SNAPSHOT_PATH)
                logger.info(f"Saved evaluation snapshot image ({len(img_bytes)} bytes) to {EVALUATION_SNAPSHOT_PATH}")
            except Exception as img_err:
                logger.warning(f"Could not decode evaluation snapshot image: {img_err}")

        eval_payload = {
            "symbol": symbol,
            "timeframe": timeframe,
            "captured_at_utc": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC"),
            "captured_timestamp": int(time.time() * 1000),
            "candle_count": candle_count or len(visible_bars),
            "view_range": view_range,
            "start_candle": start_candle,
            "end_candle": end_candle,
            "visible_high": visible_high,
            "visible_low": visible_low,
            "visible_range_pts": visible_range_pts,
            "total_volume": total_volume,
            "snapshot_image": saved_image_path,
            "visible_bars": visible_bars
        }

        EVALUATION_VIEW_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(EVALUATION_VIEW_PATH, "w", encoding="utf-8") as f:
            json.dump(eval_payload, f, indent=2)

        logger.info(f"Captured active evaluation view for {symbol} ({len(visible_bars)} visible bars: {start_candle.get('utc')} -> {end_candle.get('utc')})")

        return JSONResponse(content={
            "status": "OK",
            "message": "Evaluation view and snapshot saved successfully",
            "symbol": symbol,
            "timeframe": timeframe,
            "candle_count": len(visible_bars),
            "start_time": start_candle.get("utc") or start_candle.get("datetime_utc"),
            "end_time": end_candle.get("utc") or end_candle.get("datetime_utc"),
            "visible_high": visible_high,
            "visible_low": visible_low,
            "snapshot_image_saved": bool(saved_image_path)
        })
    except Exception as e:
        logger.error(f"Failed to save evaluation snapshot: {e}")
        return JSONResponse(content={"status": "ERROR", "message": str(e)}, status_code=500)


@app.get("/api/chart/evaluate_snapshot")
async def get_evaluation_snapshot():
    """Retrieve the latest captured evaluation snapshot view."""
    if EVALUATION_VIEW_PATH.exists():
        try:
            with open(EVALUATION_VIEW_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                return JSONResponse(content={"status": "OK", "data": data})
        except Exception as e:
            return JSONResponse(content={"status": "ERROR", "message": str(e)}, status_code=500)
    return JSONResponse(content={"status": "EMPTY", "message": "No evaluation snapshot captured yet."})


# =========================================================================
# ⚡ MT5 TRADE EXECUTION ENDPOINTS
# =========================================================================

# Mutex lock to strictly serialize all trade execution requests and eliminate duplicate orders
trade_execution_lock = asyncio.Lock()


async def execute_trade_request(data: dict) -> dict:
    """Core MT5 trade execution logic shared by HTTP POST and WebSocket routes."""
    async with trade_execution_lock:
        sym = data.get("symbol", config.get("symbol", "XAUUSD"))
        side = data.get("side") or data.get("direction") or "BUY"
        volume = float(data.get("volume", 0.50))
        sl = float(data.get("sl_price") or data.get("sl") or 0.0)
        tp = float(data.get("tp_price") or data.get("tp") or 0.0)
        comment = data.get("comment", "Escanor Market Order")

        # STRICT DAILY DRAWDOWN LOCK ENFORCEMENT: Block all execution when buffer <= 0 AND enabled
        dd_stats = compute_daily_drawdown_stats()
        if dd_stats["enabled"] and (dd_stats["is_locked"] or dd_stats["remaining"] <= 0.0):
            logger.warning(f"Trade execution BLOCKED: Daily Drawdown Limit is locked ($0.00 remaining)")
            return {
                "status": "BLOCKED",
                "error": "Daily Drawdown Limit Reached ($0.00 Remaining). Trading is LOCKED until manually disabled in settings.",
                "drawdown_locked": True
            }

        # STRICT SINGLE ACTIVE POSITION RULE: Only 1 trade active at a time
        active_pos = get_positions(sym)
        if active_pos and len(active_pos) > 0:
            logger.info(f"Trade execution blocked: {len(active_pos)} trade(s) already active on {sym}. Only 1 active allowed.")
            return {
                "status": "BLOCKED",
                "error": "Only one trade allowed active at a time",
                "active_positions": len(active_pos)
            }

        res = execute_market_order(symbol=sym, side=side, volume=volume, sl=sl, tp=tp, comment=comment)
        if res and res.get("status") in ("EXECUTED", "OK"):
            res["status"] = "OK"
            res["execution_status"] = "EXECUTED"
            res["success"] = True
            if "ticket" in res and "order" not in res:
                res["order"] = res["ticket"]

            # Auto-Breakeven for Trap Candle Trades (controlled by trap_be_enabled / trap_trade flag, OFF by default):
            ticket = int(res.get("ticket") or res.get("order") or 0)
            is_trap_be = bool(data.get("trap_be_enabled", False)) or bool(data.get("trap_trade", False))
            if is_trap_be and ticket > 0:
                trigger_price = float(data.get("trigger_price") or res.get("price") or 0.0)
                disp_pips = float(data.get("auto_be_displacement_pips") or 0.0)
                if disp_pips <= 0:
                    raw_disp = float(data.get("auto_be_displacement", 1.5))
                    disp_pips = raw_disp * 10.0 if raw_disp < 10 else raw_disp
                disp_pts = round(disp_pips * 0.10, 2)
                # 0.3 pips on Gold = 0.03 point ($0.03)
                offset_pips = float(data.get("auto_be_offset_pips", 0.3))
                offset_delta = round(offset_pips * 0.10, 2)
                if offset_delta < 0.01:
                    offset_delta = 0.03
                is_buy = (str(side).upper().startswith("BUY"))
                target_sl = round(trigger_price + offset_delta, 2) if is_buy else round(trigger_price - offset_delta, 2)
                threshold_price = round(trigger_price + disp_pts, 2) if is_buy else round(trigger_price - disp_pts, 2)

                armed_breakeven_positions[ticket] = {
                    "ticket": ticket,
                    "symbol": sym,
                    "is_buy": is_buy,
                    "open_price": float(res.get("price", trigger_price)),
                    "trigger_price": trigger_price,
                    "target_sl": target_sl,
                    "tp": tp,
                    "required_displacement": disp_pts,
                    "displacement_pips": disp_pips,
                    "threshold_price": threshold_price,
                    "offset_pips": offset_pips,
                    "offset_delta": offset_delta,
                    "is_trap_auto_be": True,
                    "armed_at": time.time()
                }
                logger.info(
                    f"🛡️ Trap Candle Trade #{ticket} Auto-Breakeven ARMED: Target SL ${target_sl:.2f} (+{offset_pips}p / +${offset_delta:.2f}) "
                    f"at +{disp_pips}p ({disp_pts}pt) displacement (threshold ${threshold_price:.2f}, trigger ${trigger_price:.2f})"
                )
        return res


@app.post("/api/trade/execute")
async def trade_execute(request: Request):
    """Direct market order execution."""
    data = await request.json()
    res = await execute_trade_request(data)
    return JSONResponse(content=res)


@app.post("/api/trade/place_pending")
async def trade_place_pending(request: Request):
    """Place pending stop/limit order."""
    data = await request.json()
    sym = data.get("symbol", config.get("symbol", "XAUUSD"))
    order_type = data.get("order_type") or data.get("type") or "BUY_LIMIT"
    price = float(data.get("price") or data.get("trigger_price") or 0.0)
    volume = float(data.get("volume", 0.50))
    sl = float(data.get("sl_price") or data.get("sl") or 0.0)
    tp = float(data.get("tp_price") or data.get("tp") or 0.0)
    comment = data.get("comment", "Escanor Pending Order")
    res = place_pending_order(symbol=sym, order_type=order_type, price=price, volume=volume, sl=sl, tp=tp, comment=comment)
    if res and res.get("status") in ("PLACED", "OK"):
        res["status"] = "OK"
        res["execution_status"] = "PLACED"
        res["success"] = True
        if "ticket" in res and "order" not in res:
            res["order"] = res["ticket"]
    return JSONResponse(content=res)


@app.post("/api/trade/modify")
async def trade_modify(request: Request):
    """Modify SL/TP of an active position."""
    data = await request.json()
    ticket = int(data.get("ticket"))
    sl = float(data["sl"]) if "sl" in data and data["sl"] is not None else None
    tp = float(data["tp"]) if "tp" in data and data["tp"] is not None else None
    res = modify_position(ticket=ticket, sl=sl, tp=tp)
    if res and res.get("status") == "MODIFIED":
        res["status"] = "OK"
    return JSONResponse(content=res)


# In-memory registry of armed auto-breakeven positions:
# { ticket: { ticket, symbol, is_buy, open_price, target_sl, tp, offset_pips, armed_at } }
armed_breakeven_positions: Dict[int, Dict[str, Any]] = {}


@app.post("/api/trade/breakeven")
async def trade_breakeven(request: Request):
    """
    Move Stop Loss to Breakeven + offset_pips (default +0.2 pip) for open positions.
    For BUY: SL = round(open_price + offset, digits)
    For SELL: SL = round(open_price - offset, digits)
    - If market price has already cleared target in profit: modifies MT5 SL immediately.
    - If market price is not in profit yet: ARMS Auto-Breakeven to trigger the instant price clears target.
    Supports action: 'toggle' | 'arm' | 'disarm'.
    Triggered via Alt + B shortcut or UI button.
    """
    try:
        data = await request.json()
    except Exception:
        data = {}

    sym = data.get("symbol", config.get("symbol", "XAUUSD"))
    offset_pips = float(data.get("offset_pips", 0.2))
    req_ticket = data.get("ticket")
    action = str(data.get("action", "toggle")).lower()

    positions = get_positions(sym) if sym else get_positions()
    if not positions:
        return JSONResponse(content={
            "status": "FAILED",
            "modified_count": 0,
            "error": "No open active positions found"
        })

    if req_ticket is not None:
        target_positions = [p for p in positions if int(p["ticket"]) == int(req_ticket)]
    else:
        target_positions = positions

    if not target_positions:
        return JSONResponse(content={
            "status": "FAILED",
            "modified_count": 0,
            "error": f"No open position matching #{req_ticket}"
        })

    def calc_pips_delta(symbol_name: str, pips: float) -> float:
        try:
            import MetaTrader5 as mt5_mod
            sym_info = mt5_mod.symbol_info(symbol_name) if mt5_mod else None
            digits = getattr(sym_info, "digits", 2) if sym_info else 2
        except Exception:
            digits = 2

        # Gold / XAUUSD: 1 point = $1.00 = 10 pips, so 1 pip = 0.10, 0.2 pip = 0.02
        if "XAU" in symbol_name.upper() or "GOLD" in symbol_name.upper():
            return round(pips * 0.10, digits)
        if digits in (2, 3):
            return round(pips * 0.01, digits)
        if digits in (4, 5):
            return round(pips * 0.0001, digits)
        return round(pips * 0.10, digits)

    results = []
    modified_count = 0
    armed_count = 0
    disarmed_count = 0
    errors = []

    import MetaTrader5 as mt5_mod

    for pos in target_positions:
        pos_ticket = int(pos["ticket"])
        pos_sym = pos.get("symbol", sym)
        open_price = float(pos["price_open"])
        pos_type = pos.get("type", "BUY")
        is_buy = (pos_type == "BUY" or pos_type == 0 or str(pos_type).upper().startswith("BUY"))
        offset = calc_pips_delta(pos_sym, offset_pips)

        if is_buy:
            new_sl = round(open_price + offset, 2)
        else:
            new_sl = round(open_price - offset, 2)

        # Check if user explicitly requested disarm, or if already armed and toggling specific ticket
        if pos_ticket in armed_breakeven_positions and (action == "disarm" or (action == "toggle" and req_ticket is not None)):
            armed_breakeven_positions.pop(pos_ticket, None)
            disarmed_count += 1
            results.append({
                "ticket": pos_ticket,
                "status": "DISARMED",
                "action": "DISARMED",
                "type": "BUY" if is_buy else "SELL"
            })
            logger.info(f"🛡️ Auto-Breakeven disarmed for #{pos_ticket}")
            continue

        tick = mt5_mod.symbol_info_tick(pos_sym) if mt5_mod else None
        sym_info = mt5_mod.symbol_info(pos_sym) if mt5_mod else None
        min_dist = (getattr(sym_info, "trade_stops_level", 0) or 0) * (getattr(sym_info, "point", 0.01) or 0.01)

        can_execute_now = False
        cur_price = 0.0
        if tick:
            cur_price = tick.bid if is_buy else tick.ask
            if is_buy and tick.bid > (new_sl + min_dist):
                can_execute_now = True
            elif not is_buy and tick.ask < (new_sl - min_dist):
                can_execute_now = True

        if can_execute_now:
            res = modify_position(ticket=pos_ticket, sl=new_sl, tp=pos.get("tp"))
            if res and res.get("status") in ("MODIFIED", "OK"):
                armed_breakeven_positions.pop(pos_ticket, None)
                modified_count += 1
                results.append({
                    "ticket": pos_ticket,
                    "status": "MODIFIED",
                    "action": "MODIFIED",
                    "sl": new_sl,
                    "open_price": open_price,
                    "type": "BUY" if is_buy else "SELL",
                    "offset_pips": offset_pips
                })
                logger.info(f"🛡️ Position #{pos_ticket} moved to Breakeven (+{offset_pips}p): SL -> {new_sl}")
            else:
                err_msg = res.get("error", "Failed to modify position")
                errors.append(f"#{pos_ticket}: {err_msg}")
                results.append({
                    "ticket": pos_ticket,
                    "status": "FAILED",
                    "error": err_msg
                })
        else:
            # ARM AUTO-BREAKEVEN!
            target_cond = f"Bid > ${new_sl:.2f}" if is_buy else f"Ask < ${new_sl:.2f}"
            armed_breakeven_positions[pos_ticket] = {
                "ticket": pos_ticket,
                "symbol": pos_sym,
                "is_buy": is_buy,
                "open_price": open_price,
                "target_sl": new_sl,
                "tp": pos.get("tp"),
                "offset_pips": offset_pips,
                "armed_at": time.time()
            }
            armed_count += 1
            results.append({
                "ticket": pos_ticket,
                "status": "ARMED",
                "action": "ARMED",
                "sl": new_sl,
                "open_price": open_price,
                "type": "BUY" if is_buy else "SELL",
                "offset_pips": offset_pips,
                "current_price": cur_price,
                "target_condition": target_cond
            })
            logger.info(f"🛡️ Position #{pos_ticket} Auto-Breakeven ARMED: Target SL ${new_sl:.2f} ({target_cond}, live {cur_price})")

    overall_status = "OK" if (modified_count > 0 or armed_count > 0 or disarmed_count > 0) else "FAILED"
    action_label = "MODIFIED" if modified_count > 0 else ("ARMED" if armed_count > 0 else ("DISARMED" if disarmed_count > 0 else "FAILED"))

    return JSONResponse(content={
        "status": overall_status,
        "action": action_label,
        "modified_count": modified_count,
        "armed_count": armed_count,
        "disarmed_count": disarmed_count,
        "results": results,
        "errors": errors if errors else None
    })


@app.post("/api/trade/move_sl_dollars")
async def trade_move_sl_dollars(request: Request):
    """
    Move or Trail Stop Loss to lock in a specific dollar amount for open positions.
    Triggered via Alt + Home shortcut or header input.
    Formula for Gold (XAUUSD, contract size 100):
      Delta P = dollars / (volume * contract_size)
      For BUY: target_sl = round(open_price + Delta P, 2)
      For SELL: target_sl = round(open_price - Delta P, 2)
    """
    try:
        data = await request.json()
    except Exception:
        data = {}

    sym = data.get("symbol", config.get("symbol", "XAUUSD"))
    try:
        dollars = float(data.get("dollars", 0.0))
    except (ValueError, TypeError):
        dollars = 0.0

    req_ticket = data.get("ticket")

    positions = get_positions(sym) if sym else get_positions()
    if not positions:
        return JSONResponse(content={
            "status": "FAILED",
            "modified_count": 0,
            "error": "No open active positions found"
        })

    if req_ticket is not None:
        target_positions = [p for p in positions if int(p["ticket"]) == int(req_ticket)]
    else:
        target_positions = positions

    if not target_positions:
        return JSONResponse(content={
            "status": "FAILED",
            "modified_count": 0,
            "error": f"No open position matching #{req_ticket}"
        })

    results = []
    modified_count = 0
    armed_count = 0
    errors = []

    import MetaTrader5 as mt5_mod

    for pos in target_positions:
        pos_ticket = int(pos["ticket"])
        pos_sym = pos.get("symbol", sym)
        open_price = float(pos["price_open"])
        pos_vol = float(pos.get("volume", 0.01))
        pos_type = pos.get("type", "BUY")
        is_buy = (pos_type == "BUY" or pos_type == 0 or str(pos_type).upper().startswith("BUY"))

        # Calculate contract size (standard Gold = 100 oz per lot)
        contract_size = 100.0
        if mt5_mod:
            s_info = mt5_mod.symbol_info(pos_sym)
            if s_info and getattr(s_info, "trade_contract_size", 0) > 0:
                contract_size = float(s_info.trade_contract_size)

        dollar_per_dollar_move = pos_vol * contract_size
        delta_p = (dollars / dollar_per_dollar_move) if dollar_per_dollar_move > 0 else 0.0

        if is_buy:
            new_sl = round(open_price + delta_p, 2)
        else:
            new_sl = round(open_price - delta_p, 2)

        tick = mt5_mod.symbol_info_tick(pos_sym) if mt5_mod else None
        sym_info = mt5_mod.symbol_info(pos_sym) if mt5_mod else None
        min_dist = (getattr(sym_info, "trade_stops_level", 0) or 0) * (getattr(sym_info, "point", 0.01) or 0.01)

        can_execute_now = False
        cur_price = 0.0
        if tick:
            cur_price = tick.bid if is_buy else tick.ask
            if is_buy and tick.bid > (new_sl + min_dist):
                can_execute_now = True
            elif not is_buy and tick.ask < (new_sl - min_dist):
                can_execute_now = True

        if can_execute_now:
            res = modify_position(ticket=pos_ticket, sl=new_sl, tp=pos.get("tp"))
            if res and res.get("status") in ("MODIFIED", "OK"):
                armed_breakeven_positions.pop(pos_ticket, None)
                modified_count += 1
                results.append({
                    "ticket": pos_ticket,
                    "status": "MODIFIED",
                    "action": "MODIFIED",
                    "sl": new_sl,
                    "open_price": open_price,
                    "type": "BUY" if is_buy else "SELL",
                    "dollars": dollars
                })
                logger.info(f"🛡️ Position #{pos_ticket} SL moved to lock ${dollars}: SL -> {new_sl}")
            else:
                err_msg = res.get("error", "Failed to modify position")
                errors.append(f"#{pos_ticket}: {err_msg}")
                results.append({
                    "ticket": pos_ticket,
                    "status": "FAILED",
                    "error": err_msg
                })
        else:
            # ARM IT so 15ms background tick loop executes it as soon as price crosses
            target_cond = f"Bid > ${new_sl:.2f}" if is_buy else f"Ask < ${new_sl:.2f}"
            armed_breakeven_positions[pos_ticket] = {
                "ticket": pos_ticket,
                "symbol": pos_sym,
                "is_buy": is_buy,
                "open_price": open_price,
                "target_sl": new_sl,
                "tp": pos.get("tp"),
                "offset_pips": delta_p * 10,
                "armed_at": time.time(),
                "dollars": dollars
            }
            armed_count += 1
            results.append({
                "ticket": pos_ticket,
                "status": "ARMED",
                "action": "ARMED",
                "sl": new_sl,
                "open_price": open_price,
                "type": "BUY" if is_buy else "SELL",
                "dollars": dollars,
                "current_price": cur_price,
                "target_condition": target_cond
            })
            logger.info(f"🎯 Position #{pos_ticket} Lock ${dollars} ARMED: Target SL ${new_sl:.2f} ({target_cond}, live {cur_price})")

    overall_status = "OK" if (modified_count > 0 or armed_count > 0) else "FAILED"
    return JSONResponse(content={
        "status": overall_status,
        "modified_count": modified_count,
        "armed_count": armed_count,
        "results": results,
        "errors": errors if errors else None
    })


def deactivate_saved_drawings(symbol: str = "XAUUSD") -> int:
    """Deactivate all armed trade drawings in drawings.json (Long Position, Short Position, Line Trading)."""
    count = 0
    if not DRAWINGS_PATH.exists():
        return count
    try:
        with open(DRAWINGS_PATH, "r", encoding="utf-8") as f:
            all_drawings = json.load(f)

        target_symbols = [symbol] if symbol and symbol != "ALL" else list(all_drawings.keys())
        for sym in target_symbols:
            drws = all_drawings.get(sym, [])
            for d in drws:
                ext = d.get("extendData")
                if isinstance(ext, dict):
                    if ext.get("isArmed"):
                        ext["isArmed"] = False
                        count += 1
                    if "armedSide" in ext and ext["armedSide"]:
                        ext["armedSide"] = None

        with open(DRAWINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(all_drawings, f, indent=2)
        logger.info(f"Deactivated {count} armed trade drawing(s) on server for {symbol}")
    except Exception as e:
        logger.error(f"Error deactivating saved drawings: {e}")
    return count


async def broadcast_ws_message(msg_dict: dict):
    """Broadcast an arbitrary JSON message to all connected WebSocket clients (5055 & 5056)."""
    if not active_ws_clients:
        return
    try:
        payload_str = json.dumps(msg_dict)
        dead = set()
        for client in list(active_ws_clients):
            try:
                if hasattr(client, "send_text"):
                    await client.send_text(payload_str)
                else:
                    await client.send(payload_str)
            except Exception:
                dead.add(client)
        active_ws_clients.difference_update(dead)
    except Exception as e:
        logger.error(f"Error broadcasting ws message: {e}")


@app.post("/api/drawings/deactivate_trades")
async def api_deactivate_trades(request: Request):
    """Deactivate all activated drawings of trades (Long Position, Short Position, Line Trading)."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    symbol = body.get("symbol", config.get("symbol", "XAUUSD"))
    source = body.get("source", "mobile")
    count = deactivate_saved_drawings(symbol)
    await broadcast_ws_message({
        "type": "DEACTIVATE_TRADE_DRAWINGS",
        "action": "DEACTIVATE_ALL",
        "symbol": symbol,
        "source": source,
        "timestamp": int(time.time() * 1000)
    })
    return JSONResponse(content={"status": "OK", "message": "All trade drawings deactivated", "deactivated_count": count})


@app.post("/api/alarms/deactivate_all")
async def api_deactivate_all_alarms(request: Request):
    """Deactivate all alarms everywhere on any device (chart drawings, lines, boxes, and mobile gauges)."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    symbol = body.get("symbol", config.get("symbol", "XAUUSD"))
    drawings_count = 0
    gauge_count = 0

    # 1. Deactivate all alarms in drawings.json (all rectangles, lines, positions, etc.)
    if DRAWINGS_PATH.exists():
        try:
            with open(DRAWINGS_PATH, "r", encoding="utf-8") as f:
                all_drawings = json.load(f)

            for sym, drws in all_drawings.items():
                for d in drws:
                    ext = d.get("extendData")
                    if isinstance(ext, dict):
                        if ext.get("alarmMode") and ext["alarmMode"] != "OFF":
                            ext["alarmMode"] = "OFF"
                            drawings_count += 1
                        if ext.get("alarmActive"):
                            ext["alarmActive"] = False
                            drawings_count += 1
                        ext["alerted"] = True
                        if ext.get("isArmed"):
                            ext["isArmed"] = False
                            drawings_count += 1
                        if ext.get("armedSide"):
                            ext["armedSide"] = None
                        if ext.get("telegramAlert"):
                            ext["telegramAlert"] = False
                        ext.pop("_lastInside", None)
                        ext.pop("_lastFired", None)
                    # Reset styles if rect
                    if d.get("name") == "rect":
                        d["styles"] = {
                            "style": "stroke_fill",
                            "color": "rgba(236, 64, 122, 0.12)",
                            "borderColor": "#ec407a",
                            "borderSize": 1.5
                        }

            with open(DRAWINGS_PATH, "w", encoding="utf-8") as f:
                json.dump(all_drawings, f, indent=2)
            logger.info(f"Deactivated {drawings_count} drawing alarms in drawings.json")
        except Exception as e:
            logger.error(f"Error deactivating drawing alarms: {e}")

    # 2. Deactivate and permanently wipe all alarms in gauge_alarms.json
    if GAUGE_ALARMS_PATH.exists():
        try:
            with open(GAUGE_ALARMS_PATH, "w", encoding="utf-8") as f:
                json.dump({"alarms": []}, f, indent=2)
            gauge_count = 1
            logger.info("Permanently wiped all gauge alarms in gauge_alarms.json")
        except Exception as e:
            logger.error(f"Error deactivating gauge alarms: {e}")

    # 3. Clear in-memory server debounces/states
    try:
        server_box_alarm_state.clear()
    except Exception:
        pass

    # 4. Broadcast DEACTIVATE_ALL_ALARMS to all connected devices/WebSocket clients
    await broadcast_ws_message({
        "type": "DEACTIVATE_ALL_ALARMS",
        "action": "DEACTIVATE_ALL",
        "symbol": symbol,
        "timestamp": int(time.time() * 1000)
    })

    return JSONResponse(content={
        "status": "OK",
        "message": "All alarms deactivated across all devices",
        "drawings_deactivated": drawings_count,
        "gauge_alarms_deactivated": gauge_count
    })


@app.post("/api/trade/close")
async def trade_close(request: Request):
    """Close an open position at market or cancel pending order."""
    data = await request.json()
    ticket = int(data.get("ticket"))
    is_pending = bool(data.get("is_pending", False))
    source = data.get("source", "chart")
    armed_breakeven_positions.pop(ticket, None)
    res = close_position(ticket=ticket, is_pending=is_pending)

    # USER REQUIREMENT: Only the particular line trigger that activated that trade should get deactivated!
    sym = config.get("symbol", "XAUUSD")
    await broadcast_ws_message({
        "type": "DEACTIVATE_TRADE_DRAWINGS",
        "action": "DEACTIVATE_TICKET",
        "symbol": sym,
        "source": source,
        "closed_ticket": ticket,
        "timestamp": int(time.time() * 1000)
    })
    return JSONResponse(content=res)


@app.post("/api/trade/close_all")
async def trade_close_all(request: Request):
    """Close all open positions and cancel all pending orders."""
    data = await request.json()
    sym = data.get("symbol") or config.get("symbol", "XAUUSD")
    source = data.get("source", "chart")
    armed_breakeven_positions.clear()
    res = close_all_positions(symbol=sym)

    # Deactivate all active drawings of trades
    count = deactivate_saved_drawings(sym)
    await broadcast_ws_message({
        "type": "DEACTIVATE_TRADE_DRAWINGS",
        "action": "DEACTIVATE_ALL",
        "symbol": sym,
        "source": source,
        "timestamp": int(time.time() * 1000)
    })
    return JSONResponse(content=res)


@app.post("/api/trade/auto_close")
async def trade_auto_close(request: Request):
    """Set or cancel auto-close timer (acknowledged by daemon)."""
    data = await request.json()
    return JSONResponse(content={"status": "OK", "ticket": data.get("ticket")})


@app.get("/api/trade/ticket_result")
async def trade_ticket_result(ticket: int):
    """Check closed position history to determine if trade was a win or loss."""
    try:
        import MetaTrader5 as mt5
        if not mt5.initialize():
            return JSONResponse(content={"status": "ERROR", "message": "MT5 not initialized"})

        deals = mt5.history_deals_get(position=ticket)
        if not deals:
            return JSONResponse(content={"status": "NOT_FOUND", "ticket": ticket, "is_loss": False, "profit": 0.0})

        # Find the exit deal (entry == 1 or deal with non-zero profit)
        exit_deals = [d for d in deals if d.entry == 1 or d.profit != 0]
        if exit_deals:
            exit_deal = exit_deals[-1]
            profit = float(exit_deal.profit)
            is_loss = profit < 0
            return JSONResponse(content={
                "status": "CLOSED",
                "ticket": ticket,
                "profit": profit,
                "is_loss": is_loss,
                "comment": getattr(exit_deal, "comment", "")
            })

        total_profit = sum(float(d.profit) for d in deals)
        return JSONResponse(content={
            "status": "CLOSED",
            "ticket": ticket,
            "profit": total_profit,
            "is_loss": total_profit < 0
        })
    except Exception as e:
        logger.error(f"Error checking ticket result for #{ticket}: {e}")
        return JSONResponse(content={"status": "ERROR", "message": str(e), "is_loss": False})


@app.get("/api/drawdown")
async def get_drawdown():
    """Get current daily drawdown stats and lock status."""
    return JSONResponse(content=compute_daily_drawdown_stats())


@app.post("/api/drawdown")
async def update_drawdown(request: Request):
    """Update daily drawdown limit, toggle protection, or manually unlock."""
    data = await request.json()
    if "enabled" in data:
        is_enabled = bool(data["enabled"])
        drawdown_config["enabled"] = is_enabled
        if not is_enabled:
            drawdown_config["is_locked"] = False
            drawdown_config["locked_at"] = None
    if "max_drawdown" in data:
        drawdown_config["max_drawdown"] = max(1.0, float(data["max_drawdown"]))
    if "is_locked" in data:
        drawdown_config["is_locked"] = bool(data["is_locked"])
        if not drawdown_config["is_locked"]:
            drawdown_config["locked_at"] = None
    save_drawdown_config()
    stats = compute_daily_drawdown_stats()
    logger.info(f"Updated drawdown config: max=${drawdown_config['max_drawdown']}, enabled={drawdown_config['enabled']}, locked={drawdown_config['is_locked']}")
    return JSONResponse(content={"status": "OK", "stats": stats, **stats})


# =========================================================================
# 🔔 GAUGE ALARMS & TELEGRAM ALERT DISPATCH
# =========================================================================

GAUGE_ALARMS_PATH = BASE_DIR / "data" / "gauge_alarms.json"
DEFAULT_TELEGRAM_BOT_TOKEN = "8748826581:AAEoP9rXDeINirO7rov-TcE7ikkY3rkWC1M"
DEFAULT_TELEGRAM_CHAT_ID = -1004324335052


@app.get("/api/gauge_alarms")
async def get_gauge_alarms():
    """Load persistent gauge alarms from disk (always empty per user order)."""
    return JSONResponse(content={"alarms": []})


@app.post("/api/gauge_alarms")
async def save_gauge_alarms(req: Request):
    """Save persistent gauge alarms to disk (strictly neutralizes/disables any incoming alarms)."""
    try:
        GAUGE_ALARMS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(GAUGE_ALARMS_PATH, "w", encoding="utf-8") as f:
            json.dump({"alarms": []}, f, indent=2)
        return JSONResponse(content={"status": "OK", "count": 0})
    except Exception as e:
        logger.error(f"Error neutralizing gauge alarms: {e}")
        return JSONResponse(content={"status": "ERROR", "message": str(e)}, status_code=500)


@app.post("/api/telegram/send_alert")
async def send_telegram_alert(req: Request):
    """Dispatch formatted alert message to Telegram channel/bot."""
    try:
        body = await req.json()
        msg = body.get("message", "")
        if not msg:
            return JSONResponse(content={"status": "ERROR", "message": "Empty message"}, status_code=400)

        # Block any stale/invisible gauge alarms from persisting clients
        if "GAUGE ALARM" in msg or "Kinetic Momentum Surge" in msg:
            logger.warning("Blocked rogue gauge alarm dispatch to Telegram.")
            return JSONResponse(content={"status": "BLOCKED", "message": "Gauge alarms decommissioned"})

        bot_token = body.get("bot_token") or DEFAULT_TELEGRAM_BOT_TOKEN
        chat_id = body.get("chat_id") or DEFAULT_TELEGRAM_CHAT_ID
        parse_mode = body.get("parse_mode", "HTML")

        def _send():
            import urllib.request
            url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
            payload = {
                "chat_id": chat_id,
                "text": msg,
                "parse_mode": parse_mode,
                "disable_web_page_preview": True
            }
            data_bytes = json.dumps(payload).encode("utf-8")
            req_tg = urllib.request.Request(
                url, data=data_bytes, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req_tg, timeout=8) as resp:
                return resp.read().decode()

        loop = asyncio.get_event_loop()
        res_text = await loop.run_in_executor(None, _send)
        return JSONResponse(content={"status": "OK", "telegram_response": json.loads(res_text)})
    except Exception as e:
        logger.error(f"Error sending Telegram alert: {e}")
        return JSONResponse(content={"status": "ERROR", "message": str(e)}, status_code=500)


# =========================================================================
# 🌐 UI STATIC ROUTES
# =========================================================================

# Mount shared assets
app.mount("/shared", StaticFiles(directory=str(BASE_DIR / "frontend" / "shared")), name="shared")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

# Mount mobile assets
app.mount("/mobile/css", StaticFiles(directory=str(BASE_DIR / "frontend" / "mobile" / "css")), name="mobile_css")
app.mount("/mobile/js", StaticFiles(directory=str(BASE_DIR / "frontend" / "mobile" / "js")), name="mobile_js")
app.mount("/frontend/mobile_app/js", StaticFiles(directory=str(BASE_DIR / "frontend" / "mobile" / "js")), name="compat_mobile_app_js")
app.mount("/frontend/mobile_app/css", StaticFiles(directory=str(BASE_DIR / "frontend" / "mobile" / "css")), name="compat_mobile_app_css")
app.mount("/frontend/mobile_app", StaticFiles(directory=str(BASE_DIR / "frontend" / "mobile")), name="compat_mobile_app")
app.mount("/mobile_app", StaticFiles(directory=str(BASE_DIR / "frontend" / "mobile")), name="compat_mobile_app2")

# Mount chart assets
app.mount("/chart/css", StaticFiles(directory=str(BASE_DIR / "frontend" / "chart" / "css")), name="chart_css")
app.mount("/chart/js", StaticFiles(directory=str(BASE_DIR / "frontend" / "chart" / "js")), name="chart_js")


@app.get("/mobile")
@app.get("/mobile_app")
async def get_mobile_ui():
    """Serve Escanor Mobile HUD."""
    mobile_index = BASE_DIR / "frontend" / "mobile" / "index.html"
    return FileResponse(str(mobile_index))


@app.get("/chart")
async def get_chart_ui():
    """Serve TradingView Clone Desktop Chart."""
    chart_index = BASE_DIR / "frontend" / "chart" / "index.html"
    return FileResponse(str(chart_index))


@app.get("/")
async def root_redirect(request: Request):
    """Smart router: Mobile user-agents go to /mobile, desktops go to /chart."""
    ua = request.headers.get("user-agent", "").lower()
    if any(m in ua for m in ("mobile", "android", "iphone", "ipad")):
        return FileResponse(str(BASE_DIR / "frontend" / "mobile" / "index.html"))
    return FileResponse(str(BASE_DIR / "frontend" / "chart" / "index.html"))


# =========================================================================
# 🔄 WEBSOCKET BROADCASTER & FAST COMMAND ENGINE (PORTS 5055 & 5056)
# =========================================================================

async def handle_ws_incoming_message(websocket, raw_text: str):
    """Handle ultra-low latency execution and control commands directly over WebSocket."""
    if not raw_text:
        return
    try:
        data = json.loads(raw_text)
        action = data.get("action")
        if action in ("EXECUTE_LINE", "EXECUTE_MARKET", "EXECUTE_HOTKEY"):
            res = await execute_trade_request(data)
            reply = json.dumps({
                "type": "TRADE_EXECUTION_RESULT",
                "request_id": data.get("request_id"),
                "result": res
            })
            if hasattr(websocket, "send_text"):
                await websocket.send_text(reply)
            else:
                await websocket.send(reply)
    except Exception as e:
        logger.warning(f"Error handling WS client message: {e}")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """FastAPI WebSocket endpoint on port 5055."""
    await websocket.accept()
    active_ws_clients.add(websocket)
    try:
        while True:
            msg_text = await websocket.receive_text()
            if msg_text:
                await handle_ws_incoming_message(websocket, msg_text)
    except WebSocketDisconnect:
        active_ws_clients.discard(websocket)
    except Exception:
        active_ws_clients.discard(websocket)


async def standalone_ws_handler(websocket):
    """Handler for dedicated WebSocket server on port 5056."""
    active_ws_clients.add(websocket)
    try:
        async for msg_text in websocket:
            if msg_text:
                await handle_ws_incoming_message(websocket, msg_text)
    except Exception:
        pass
    finally:
        active_ws_clients.discard(websocket)


# Server-side box alarms state tracking: {rect_id: {"last_inside": bool, "last_fired": float}}
server_box_alarm_state: Dict[str, Dict[str, Any]] = {}


async def _dispatch_tg_async(msg: str):
    try:
        def _send():
            import urllib.request
            url = f"https://api.telegram.org/bot{DEFAULT_TELEGRAM_BOT_TOKEN}/sendMessage"
            payload = {
                "chat_id": DEFAULT_TELEGRAM_CHAT_ID,
                "text": msg,
                "parse_mode": "HTML",
                "disable_web_page_preview": True
            }
            data_bytes = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(url, data=data_bytes, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                return resp.read().decode()
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _send)
        logger.info("Box alarm dispatched to Telegram successfully.")
    except Exception as e:
        logger.error(f"Failed to dispatch box alarm to Telegram: {e}")


def check_server_box_alarms(snap: Dict[str, Any]):
    """Evaluate persistent rectangle box alarms directly on server and dispatch Telegram alert if enabled."""
    if not DRAWINGS_PATH.exists() or not snap:
        return
    try:
        bid = snap.get("bid")
        if not bid or not isinstance(bid, (int, float)):
            return

        with open(DRAWINGS_PATH, "r", encoding="utf-8") as f:
            all_drawings = json.load(f)

        rects = [
            d for d in all_drawings.get("XAUUSD", [])
            if d.get("name") == "rect" and d.get("extendData", {}).get("alarmMode") in ("INSIDE", "OUTSIDE", "BOTH")
        ]
        if not rects:
            return

        now_t = time.time()
        for rect in rects:
            rect_id = rect.get("id")
            if not rect_id:
                continue

            extend = rect.get("extendData", {})
            # Only dispatch to Telegram if user explicitly checked the Telegram alert option!
            if not extend.get("telegramAlert"):
                continue

            points = rect.get("points", [])
            if len(points) < 2:
                continue

            p1 = float(points[0].get("value", 0))
            p2 = float(points[1].get("value", 0))
            top = max(p1, p2)
            bottom = min(p1, p2)
            mode = extend.get("alarmMode", "OFF")

            state = server_box_alarm_state.setdefault(rect_id, {"last_inside": None, "last_fired": 0.0})
            is_inside = (bottom <= bid <= top)
            was_inside = state["last_inside"]

            if was_inside is None:
                state["last_inside"] = is_inside
                continue

            can_fire = (now_t - state["last_fired"]) > 10.0  # 10s debounce

            # Entering box
            if not was_inside and is_inside and mode in ("INSIDE", "BOTH"):
                if can_fire:
                    state["last_fired"] = now_t
                    msg = (
                        f"🚨 <b>ESCANOR BOX PRICE ALARM</b>\n"
                        f"━━━━━━━━━━━━━━━━━━\n"
                        f"<b>Alert:</b> 🎯 Price ENTERED Box\n"
                        f"<b>Asset:</b> Gold ($XAUUSD$)\n"
                        f"<b>Live Spot:</b> ${bid:.2f}\n"
                        f"<b>Box Ceiling:</b> ${top:.2f}\n"
                        f"<b>Box Floor:</b> ${bottom:.2f}\n"
                        f"<b>Alarm Mode:</b> {mode}\n"
                        f"<b>Time:</b> {time.strftime('%H:%M:%S UTC', time.gmtime())}\n"
                        f"━━━━━━━━━━━━━━━━━━"
                    )
                    asyncio.create_task(_dispatch_tg_async(msg))
            # Breaking out of box
            elif was_inside and not is_inside and mode in ("OUTSIDE", "BOTH"):
                if can_fire:
                    state["last_fired"] = now_t
                    direction = f"Broke ABOVE Ceiling (${top:.2f})" if bid > top else f"Broke BELOW Floor (${bottom:.2f})"
                    msg = (
                        f"🚨 <b>ESCANOR BOX PRICE ALARM</b>\n"
                        f"━━━━━━━━━━━━━━━━━━\n"
                        f"<b>Alert:</b> 🚀 Price OUT OF BOX ({direction})\n"
                        f"<b>Asset:</b> Gold ($XAUUSD$)\n"
                        f"<b>Live Spot:</b> ${bid:.2f}\n"
                        f"<b>Box Ceiling:</b> ${top:.2f}\n"
                        f"<b>Box Floor:</b> ${bottom:.2f}\n"
                        f"<b>Alarm Mode:</b> {mode}\n"
                        f"<b>Time:</b> {time.strftime('%H:%M:%S UTC', time.gmtime())}\n"
                        f"━━━━━━━━━━━━━━━━━━"
                    )
                    asyncio.create_task(_dispatch_tg_async(msg))

            state["last_inside"] = is_inside
    except Exception as e:
        logger.warning(f"Error checking server box alarms: {e}")


async def check_armed_breakevens():
    """Evaluate armed auto-breakevens on every telemetry tick and execute SL modification immediately once in profit."""
    if not armed_breakeven_positions:
        return
    try:
        import MetaTrader5 as mt5_mod
        if not mt5_mod:
            return

        open_positions = {int(p.ticket): p for p in (mt5_mod.positions_get() or ())}
        to_remove = []

        for ticket, armed in list(armed_breakeven_positions.items()):
            # If position no longer exists (closed manually, TP, or SL), clean up
            if ticket not in open_positions:
                to_remove.append(ticket)
                continue

            sym = armed.get("symbol", "XAUUSD")
            tick = mt5_mod.symbol_info_tick(sym)
            if not tick:
                continue

            sym_info = mt5_mod.symbol_info(sym)
            min_dist = (getattr(sym_info, "trade_stops_level", 0) or 0) * (getattr(sym_info, "point", 0.01) or 0.01)
            target_sl = float(armed["target_sl"])
            is_buy = armed["is_buy"]
            pos = open_positions[ticket]

            ready = False
            is_trap = armed.get("is_trap_auto_be", False)
            if is_trap and armed.get("threshold_price") is not None:
                threshold_price = float(armed["threshold_price"])
                # For BUY: Bid must reach threshold (trigger_price + 1.5pt) and be safely above target_sl
                if is_buy and tick.bid >= threshold_price and tick.bid > (target_sl + min_dist):
                    ready = True
                # For SELL: Ask/Bid must reach threshold (trigger_price - 1.5pt) and be safely below target_sl
                elif not is_buy and tick.ask <= threshold_price and tick.ask < (target_sl - min_dist):
                    ready = True
            else:
                # Standard BE (Alt+B): triggers as soon as price is in profit above target_sl
                if is_buy and tick.bid > (target_sl + min_dist):
                    ready = True
                elif not is_buy and tick.ask < (target_sl - min_dist):
                    ready = True

            if ready:
                res = modify_position(ticket=ticket, sl=target_sl, tp=getattr(pos, "tp", None))
                if res and res.get("status") in ("MODIFIED", "OK"):
                    to_remove.append(ticket)
                    dollars_val = armed.get("dollars")
                    if dollars_val is not None:
                        log_label = f"🛡️ Auto-Lock (+${dollars_val:.0f})"
                    elif is_trap:
                        log_label = f"🛡️ Trap Auto-Breakeven (+{offset_p}p after {disp_pips}p disp)"
                    else:
                        log_label = "🛡️ Auto-Breakeven (+0.2p)"
                    logger.info(f"{log_label} executed for #{ticket}! SL set to ${target_sl:.2f}")
                    await broadcast_ws_message({
                        "type": "BREAKEVEN_TRIGGERED",
                        "ticket": ticket,
                        "sl": target_sl,
                        "open_price": armed.get("open_price"),
                        "trigger_price": armed.get("trigger_price"),
                        "offset_pips": offset_p,
                        "displacement_pips": disp_pips,
                        "displacement_pts": disp_pts,
                        "is_trap": is_trap,
                        "timestamp": int(time.time() * 1000)
                    })

        for t in to_remove:
            armed_breakeven_positions.pop(t, None)
    except Exception as e:
        logger.warning(f"Error checking armed breakevens: {e}")


async def fast_tick_stream_loop():
    """Ultra-low latency tick loop streaming MT5 price changes every 15-20ms to all WS clients."""
    import MetaTrader5 as mt5_mod
    logger.info("Starting ultra-fast MT5 tick stream loop (15ms)...")
    sym = config.get("symbol", "XAUUSD")
    last_bid = 0.0
    last_ask = 0.0
    while True:
        try:
            if mt5_mod:
                tick = mt5_mod.symbol_info_tick(sym)
                if tick:
                    bid = float(tick.bid)
                    ask = float(tick.ask)
                    # Broadcast immediately whenever bid or ask changes
                    if bid != last_bid or ask != last_ask:
                        last_bid = bid
                        last_ask = ask
                        payload = json.dumps({
                            "type": "TICK",
                            "symbol": sym,
                            "bid": bid,
                            "ask": ask,
                            "time_msc": int(getattr(tick, "time_msc", 0) or (time.time() * 1000))
                        })
                        dead = set()
                        for client in list(active_ws_clients):
                            try:
                                if hasattr(client, "send_text"):
                                    await client.send_text(payload)
                                else:
                                    await client.send(payload)
                            except Exception:
                                dead.add(client)
                        if dead:
                            active_ws_clients.difference_update(dead)
        except Exception as e:
            logger.warning(f"Fast tick loop error: {e}")
        await asyncio.sleep(0.015)


async def broadcast_telemetry_loop():
    """Continuous high-speed loop broadcasting MT5 telemetry to all connected clients."""
    logger.info("Starting telemetry broadcast loop...")
    while True:
        try:
            snap = compute_telemetry_snapshot(config.get("symbol", "XAUUSD"))
            dd_stats = await check_daily_drawdown_limit(config.get("symbol", "XAUUSD"))
            if isinstance(snap, dict):
                snap["armed_breakevens"] = list(armed_breakeven_positions.keys())
                snap["drawdown"] = dd_stats
            check_server_box_alarms(snap)
            await check_armed_breakevens()

            if active_ws_clients:
                payload_str = json.dumps(snap)
                
                # Broadcast concurrently
                dead = set()
                for client in list(active_ws_clients):
                    try:
                        if hasattr(client, "send_text"):
                            # FastAPI WebSocket
                            await client.send_text(payload_str)
                        else:
                            # websockets library WebSocket
                            await client.send(payload_str)
                    except Exception:
                        dead.add(client)
                active_ws_clients.difference_update(dead)
        except Exception as err:
            logger.error(f"Broadcast error: {err}")
        await asyncio.sleep(0.40)


async def main():
    """Launch both FastAPI (5055) and standalone WebSocket (5056) concurrently."""
    init_mt5()
    
    # Start dedicated WebSocket server on port 5056
    ws_port = config.get("ws_port", 5056)
    ws_server = await websockets.serve(standalone_ws_handler, "0.0.0.0", ws_port)
    logger.info(f"Dedicated WebSocket server running on ws://0.0.0.0:{ws_port}")

    # Launch background broadcast tasks (both 15ms tick stream and 400ms heavy telemetry)
    asyncio.create_task(fast_tick_stream_loop())
    asyncio.create_task(broadcast_telemetry_loop())

    # Start FastAPI Uvicorn server on port 5055
    http_port = config.get("http_port", 5055)
    uv_config = uvicorn.Config(app=app, host="0.0.0.0", port=http_port, log_level="warning")
    uv_server = uvicorn.Server(uv_config)
    logger.info(f"Escanor HTTP Server running on http://0.0.0.0:{http_port}")
    await uv_server.serve()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Escanor daemon stopped.")
