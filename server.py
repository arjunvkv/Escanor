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
    return JSONResponse(content=snap)


@app.get("/api/candles")
async def get_candles_endpoint(symbol: str = "XAUUSD", timeframe: str = "5", count: int = 300):
    """Fetch MT5 OHLCV candles formatted for KLineCharts."""
    try:
        c_int = int(count) if count else 300
    except (ValueError, TypeError):
        c_int = 300
    candles = get_candles(symbol=symbol, timeframe=str(timeframe), count=c_int)
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

        return JSONResponse(content={"status": "OK", "message": "Drawings saved successfully", "count": len(drawings)})
    except Exception as e:
        logger.error(f"Failed to save drawings: {e}")
        return JSONResponse(content={"status": "ERROR", "message": str(e)}, status_code=500)


# =========================================================================
# ⚡ MT5 TRADE EXECUTION ENDPOINTS
# =========================================================================

@app.post("/api/trade/execute")
async def trade_execute(request: Request):
    """Direct market order execution."""
    data = await request.json()
    sym = data.get("symbol", config.get("symbol", "XAUUSD"))
    side = data.get("side") or data.get("direction") or "BUY"
    volume = float(data.get("volume", 0.50))
    sl = float(data.get("sl_price") or data.get("sl") or 0.0)
    tp = float(data.get("tp_price") or data.get("tp") or 0.0)
    comment = data.get("comment", "Escanor Market Order")
    res = execute_market_order(symbol=sym, side=side, volume=volume, sl=sl, tp=tp, comment=comment)
    if res and res.get("status") in ("EXECUTED", "OK"):
        res["status"] = "OK"
        res["execution_status"] = "EXECUTED"
        res["success"] = True
        if "ticket" in res and "order" not in res:
            res["order"] = res["ticket"]
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


@app.post("/api/trade/close")
async def trade_close(request: Request):
    """Close an open position at market or cancel pending order."""
    data = await request.json()
    ticket = int(data.get("ticket"))
    is_pending = bool(data.get("is_pending", False))
    res = close_position(ticket=ticket, is_pending=is_pending)
    return JSONResponse(content=res)


@app.post("/api/trade/close_all")
async def trade_close_all(request: Request):
    """Close all open positions and cancel all pending orders."""
    data = await request.json()
    sym = data.get("symbol")
    res = close_all_positions(symbol=sym)
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


# =========================================================================
# 🔔 GAUGE ALARMS & TELEGRAM ALERT DISPATCH
# =========================================================================

GAUGE_ALARMS_PATH = BASE_DIR / "data" / "gauge_alarms.json"
DEFAULT_TELEGRAM_BOT_TOKEN = "8748826581:AAEoP9rXDeINirO7rov-TcE7ikkY3rkWC1M"
DEFAULT_TELEGRAM_CHAT_ID = -1004324335052


@app.get("/api/gauge_alarms")
async def get_gauge_alarms():
    """Load persistent gauge alarms from disk."""
    if GAUGE_ALARMS_PATH.exists():
        try:
            with open(GAUGE_ALARMS_PATH, "r", encoding="utf-8") as f:
                return JSONResponse(content=json.load(f))
        except Exception as e:
            logger.warning(f"Error reading gauge_alarms.json: {e}")
    return JSONResponse(content={"alarms": []})


@app.post("/api/gauge_alarms")
async def save_gauge_alarms(req: Request):
    """Save persistent gauge alarms to disk."""
    try:
        body = await req.json()
        GAUGE_ALARMS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(GAUGE_ALARMS_PATH, "w", encoding="utf-8") as f:
            json.dump(body, f, indent=2)
        return JSONResponse(content={"status": "OK", "count": len(body.get("alarms", []))})
    except Exception as e:
        logger.error(f"Error saving gauge alarms: {e}")
        return JSONResponse(content={"status": "ERROR", "message": str(e)}, status_code=500)


@app.post("/api/telegram/send_alert")
async def send_telegram_alert(req: Request):
    """Dispatch formatted alert message to Telegram channel/bot."""
    try:
        body = await req.json()
        msg = body.get("message", "")
        if not msg:
            return JSONResponse(content={"status": "ERROR", "message": "Empty message"}, status_code=400)

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
# 🔄 WEBSOCKET BROADCASTER (PORTS 5055 & 5056)
# =========================================================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """FastAPI WebSocket endpoint on port 5055."""
    await websocket.accept()
    active_ws_clients.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        active_ws_clients.discard(websocket)
    except Exception:
        active_ws_clients.discard(websocket)


async def standalone_ws_handler(websocket):
    """Handler for dedicated WebSocket server on port 5056."""
    active_ws_clients.add(websocket)
    try:
        async for _ in websocket:
            pass
    except Exception:
        pass
    finally:
        active_ws_clients.discard(websocket)


async def broadcast_telemetry_loop():
    """Continuous high-speed loop broadcasting MT5 telemetry to all connected clients."""
    logger.info("Starting telemetry broadcast loop...")
    while True:
        try:
            if active_ws_clients:
                snap = compute_telemetry_snapshot(config.get("symbol", "XAUUSD"))
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

    # Launch background broadcast task
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
