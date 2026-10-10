"""
Escanor Macro Intelligence & Structural Execution Dossier Engine
Constructs and dispatches real-time situational intelligence dossiers to OpenCode every 5 minutes,
embedding live MT5 gold price/spread, dual UTC+IST timestamps, session dynamics,
and enforcing the 4-phase operating cadence:
  1. alpha_get_account_status & alpha_get_pending_orders FIRST
  2. Autonomous macro & news investigation via Proxima MCP suite
  3. alpha_query_analyst_desk & alpha_get_market_regime_context AT LAST for 5-min technicals
  4. Execution decision & trigger placement when favourable
"""

import os
import sys
import json
import time
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any

# Ensure project root is in sys.path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from core.mt5_connection import init_mt5, get_tick, get_candles
from opencode.session_manager import OpenCodeSessionManager

logger = logging.getLogger("escanor.opencode.dossier")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

IST = timezone(timedelta(hours=5, minutes=30))


class DossierEngine:
    def __init__(self, session_manager: Optional[OpenCodeSessionManager] = None):
        self.sm = session_manager or OpenCodeSessionManager()

    def get_market_session_info(self) -> Dict[str, Any]:
        """Calculates current UTC and IST times and determines the active market session."""
        now_utc = datetime.now(timezone.utc)
        now_ist = now_utc.astimezone(IST)
        hour_utc = now_utc.hour + now_utc.minute / 60.0

        sessions = []
        if 0.0 <= hour_utc < 8.0:
            sessions.append("Asian (Tokyo/Sydney)")
        if 7.0 <= hour_utc < 15.5:
            sessions.append("London (European Core)")
        if 12.5 <= hour_utc < 21.0:
            sessions.append("New York (US Liquidity Peak)")
        if 12.5 <= hour_utc <= 15.5:
            sessions.append("LONDON/NY HIGH-OCTANE OVERLAP")
        if 21.0 <= hour_utc < 24.0:
            sessions.append("Late NY / Rollover (Thin Liquidity Window)")

        is_weekend = now_utc.weekday() in (5, 6)
        if is_weekend:
            sessions.append("WEEKEND (MT5 Market Closed / Electronic Quotes Paused)")

        return {
            "utc_time": now_utc.strftime("%Y-%m-%d %H:%M:%S UTC"),
            "ist_time": now_ist.strftime("%Y-%m-%d %H:%M:%S IST"),
            "sessions": sessions or ["Inter-session Transition"],
            "is_weekend": is_weekend
        }

    def get_mt5_live_telemetry(self, symbol: str = "XAUUSD") -> Dict[str, Any]:
        """Pulls live spot tick and recent high/low from MetaTrader 5."""
        tick = get_tick(symbol)
        telemetry = {
            "symbol": symbol,
            "connected": tick is not None,
            "bid": tick.get("bid") if tick else None,
            "ask": tick.get("ask") if tick else None,
            "spread_pts": tick.get("spread") if tick else None,
            "last_update_epoch": tick.get("time") if tick else None
        }

        # Pull recent M5 candles to get local range
        try:
            candles = get_candles(symbol, timeframe="5", count=24) # Last 2 hours of M5
            if candles:
                highs = [c["high"] for c in candles]
                lows = [c["low"] for c in candles]
                telemetry["2h_m5_high"] = round(max(highs), 2)
                telemetry["2h_m5_low"] = round(min(lows), 2)
                telemetry["2h_m5_range_pts"] = round(telemetry["2h_m5_high"] - telemetry["2h_m5_low"], 2)
        except Exception as e:
            logger.debug(f"Could not compute 2h candle stats: {e}")

        return telemetry

    def build_dossier_content(self, cycle_number: int = 1) -> str:
        """Constructs the high-fidelity situational prompt dossier enforcing the 4-phase cadence."""
        sess_info = self.get_market_session_info()
        telem = self.get_mt5_live_telemetry("XAUUSD")

        price_str = f"Bid: {telem['bid']} | Ask: {telem['ask']} | Spread: {telem['spread_pts']} pts" if telem["connected"] else "MT5 Connection Offline / Weekend Freeze"
        range_str = f"2H High: {telem.get('2h_m5_high')} | 2H Low: {telem.get('2h_m5_low')} (Range: {telem.get('2h_m5_range_pts')} pts)" if telem.get("2h_m5_high") else "N/A"

        prompt = f"""### ESCANOR MACRO INTELLIGENCE & EXECUTION DOSSIER — CYCLE #{cycle_number}

**1. REAL-TIME CLOCK & SESSION TELEMETRY**:
- **UTC Time**: {sess_info['utc_time']}
- **IST Time**: {sess_info['ist_time']}
- **Active Market Gate**: {', '.join(sess_info['sessions'])}
- **Trading Day Status**: {'Market Closed (Weekend / Hold Evaluation Mode)' if sess_info['is_weekend'] else 'Live Auction Open'}

**2. LIVE BROKER & ASSET REALITY (MT5 XAUUSD)**:
- **Spot Quote**: {price_str}
- **Recent Technical Range (2H)**: {range_str}

---

### MANDATORY 4-PHASE OPERATIONAL DIRECTIVE:

**PHASE 1 (PRE-FLIGHT AUDIT — CALL FIRST)**:
You must call these tools immediately before performing research or trading:
1. `alpha_get_account_status()`: Audit live Balance, Equity, Margin usage, and any open positions.
2. `alpha_get_pending_orders(symbol="XAUUSD")`: Audit the current pending order book.

**PHASE 2 (AUTONOMOUS MACRO & NEWS INVESTIGATION — MIDDLE)**:
Investigate macro reality using your **Proxima Intelligence Suite** (`proxima_ask_perplexity`, `proxima_ask_chatgpt`, `proxima_web_scrape`, `proxima_ddg_search`, `proxima_deep_search`).
Execute through the 6-stage causal hierarchy:
- Sovereign Catalysts (Geopolitics, fiscal risk, Fed statements)
- Transmission Chain into Real Yields (DFII10), Nominal 10Y (US10Y), and DXY
- Gold Specificity (Opportunity cost vs monetary debasement / central bank demand)
- Tape Asymmetry: Compare live macro wires against MT5 quote ({telem.get('bid', 'N/A')}). Is Gold demonstrating absorption or distribution?
- Secondary prints (AHE, JOLTS, ISM Prices Paid, Treasury auctions)
- Forward Runway (Next 15–45 minutes clearance, upcoming data releases)

**PHASE 3 (5-MINUTE TECHNICAL & STRUCTURAL REALITY — CALL AT LAST AFTER NEWS)**:
After finishing your macroeconomic analysis, verify the immediate 5-minute technical structure before placing any trades:
1. `alpha_query_analyst_desk(query="Check 5m order flow, fair value gaps, liquidity sweeps, and key supply/demand levels", symbol="XAUUSD")`
2. `alpha_get_market_regime_context(symbol="XAUUSD")`: Check volatility, tick velocity, and structural regime.

**PHASE 4 (EXECUTION & DECISION — STRICTLY ZERO PRONG PLANNING)**:
If and only if your macro thesis and 5-minute technical structure align into a high-conviction confluence during active market hours:
- Place precision structural limit or stop orders via `alpha_place_pending_order(symbol="XAUUSD", order_type="BUY_LIMIT"|"SELL_LIMIT"|"BUY_STOP"|"SELL_STOP", price=..., volume=..., sl_price=..., tp_price=..., tag=...)`.
- Or execute immediate market orders via `alpha_execute_market_order(symbol="XAUUSD", side="BUY"|"SELL", volume=..., sl_price=..., tp_price=..., comment=...)`.
- Modify or cancel stale pending orders via `alpha_modify_pending_order` / `alpha_cancel_pending_order`.
- Manage live open positions via `alpha_update_position`.
- If market is closed (e.g. weekend) or conditions are unfavourable/choppy: declare **STAND DOWN / NO ACTION**. State your positioning rationale, evaluate existing open positions, and define exact invalidation tripwires.
- **STRICT DIRECTIVE**: Do NOT invent hypothetical "prongs" (Prong A/B/C) or advisory future trade setups. Pre-planning hypothetical setups creates trade fixation and premature bias. Do NOT call sentiment publishing tools. Formulate your complete executive report directly in this session.
"""
        return prompt

    def seed_new_session(self, title: str = "Escanor Macro Intelligence & Execution Desk") -> str:
        """Creates and initializes a clean OpenCode session pinned to C:\\Trading."""
        session = self.sm.create_session(title=title, directory=r"C:\Trading")
        session_id = session["id"]
        logger.info(f"Created new OpenCode session: {session_id} - '{title}'")

        seed_message = """# ESCANOR MACRO INTELLIGENCE & STRUCTURAL EXECUTION DESK INITIALIZED

Standing Orders loaded from AGENTS.md:
- **Full Tool Suite**:
  - Pre-Flight & Structural Tools: `alpha_get_account_status`, `alpha_get_pending_orders`, `alpha_query_analyst_desk`, `alpha_get_market_regime_context`.
  - Trade Execution Tools: `alpha_execute_market_order`, `alpha_place_pending_order`, `alpha_cancel_pending_order`, `alpha_modify_pending_order`, `alpha_update_position`.
  - Proxima Suite: `proxima_ask_perplexity`, `proxima_ask_chatgpt`, `proxima_web_scrape`, `proxima_ddg_search`, `proxima_deep_search`.
- **4-Phase Operating Sequence on Every Dossier**:
  1. Call `alpha_get_account_status` and `alpha_get_pending_orders` FIRST.
  2. Perform autonomous macro & news investigation via Proxima suite.
  3. Call `alpha_query_analyst_desk` and `alpha_get_market_regime_context` AT LAST after news to audit 5m technicals.
  4. Place orders / triggers or adjust risk WHEN FAVOURABLE.

The desk is standing by for the 5-minute operational dossier cadence.
"""
        ok = self.sm.send_prompt(session_id, seed_message, async_mode=False)
        logger.info(f"Session seeded: {ok}")
        return session_id

    def dispatch_dossier(self, session_id: Optional[str] = None, cycle_number: int = 1) -> bool:
        """Builds and dispatches the live dossier to the target session."""
        if not session_id:
            latest = self.sm.find_latest_macro_session()
            if not latest:
                logger.error("No active session found to dispatch dossier.")
                return False
            session_id = latest["id"]

        dossier = self.build_dossier_content(cycle_number=cycle_number)
        logger.info(f"Dispatching Dossier #{cycle_number} to session {session_id}...")
        return self.sm.send_prompt(session_id, dossier, async_mode=True)

    def run_periodic_loop(self, session_id: str, interval_seconds: int = 300, max_cycles: Optional[int] = None):
        """
        Runs the recurring 5-minute dossier trigger loop.
        Monitors session idle status and dispatches fresh MT5 dossiers periodically.
        """
        logger.info(f"Starting periodic dossier loop for session {session_id} (interval: {interval_seconds}s / 5 mins)...")
        cycle = 1

        while True:
            if max_cycles and cycle > max_cycles:
                logger.info(f"Completed maximum cycles ({max_cycles}). Exiting loop.")
                break

            logger.info(f"=== INITIATING CYCLE #{cycle} ===")

            # Wait if session is currently active/busy
            idle_wait_start = time.time()
            while not self.sm.is_idle(session_id):
                if time.time() - idle_wait_start > 120:
                    logger.warning(f"Session {session_id} remained busy for 120s. Deferring cycle #{cycle} to next interval.")
                    break
                logger.info(f"Session {session_id} is currently busy processing. Waiting for idle...")
                time.sleep(5.0)

            # Dispatch fresh live dossier
            ok = self.dispatch_dossier(session_id=session_id, cycle_number=cycle)
            if ok:
                logger.info(f"Cycle #{cycle} dossier successfully dispatched. Next cycle in {interval_seconds} seconds.")
                cycle += 1
            else:
                logger.error(f"Failed to dispatch cycle #{cycle}. Retrying in 10 seconds.")
                time.sleep(10.0)
                continue

            # Sleep until next scheduled interval
            time.sleep(interval_seconds)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Escanor Macro Dossier Engine")
    parser.add_argument("--seed", action="store_true", help="Create and seed a new session in /trading/")
    parser.add_argument("--dispatch", action="store_true", help="Dispatch a live MT5 dossier")
    parser.add_argument("--session-id", type=str, default=None, help="Target session ID")
    parser.add_argument("--cycle", type=int, default=1, help="Cycle number")
    parser.add_argument("--loop", action="store_true", help="Run continuously every 5 minutes")
    parser.add_argument("--interval", type=int, default=300, help="Interval in seconds (default: 300 / 5 min)")
    parser.add_argument("--title", type=str, default="Escanor Macro Intelligence & Execution Desk", help="Session title")
    args = parser.parse_args()

    engine = DossierEngine()

    if args.seed:
        sid = engine.seed_new_session(title=args.title)
        print(f"SESSION_ID={sid}")
        if args.dispatch:
            time.sleep(2.0)
            engine.dispatch_dossier(session_id=sid, cycle_number=args.cycle)
        if args.loop:
            engine.run_periodic_loop(session_id=sid, interval_seconds=args.interval)
    elif args.loop:
        sid = args.session_id or (engine.sm.find_latest_macro_session() or {}).get("id")
        if not sid:
            print("No active session found. Seed one first with --seed.")
            sys.exit(1)
        engine.run_periodic_loop(session_id=sid, interval_seconds=args.interval)
    elif args.dispatch:
        engine.dispatch_dossier(session_id=args.session_id, cycle_number=args.cycle)
    else:
        print("Market Session:")
        print(json.dumps(engine.get_market_session_info(), indent=2))
        print("\nMT5 Telemetry:")
        print(json.dumps(engine.get_mt5_live_telemetry(), indent=2))
        print("\nPreview Dossier:")
        print(engine.build_dossier_content(1))
