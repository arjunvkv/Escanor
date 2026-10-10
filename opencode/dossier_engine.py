"""
Escanor Macro Intelligence & Structural Execution Dossier Engine
Constructs and dispatches real-time situational intelligence dossiers to OpenCode every 5 minutes,
embedding live MT5 gold price/spread, dual UTC+IST timestamps, session dynamics,
and enforcing the 4-phase operating cadence:
  1. alpha_get_account_status & alpha_get_pending_orders FIRST
  2. Autonomous macro & news investigation via Proxima MCP suite
  3. alpha_query_analyst_desk & alpha_get_market_regime_context AT LAST for 5-min technicals
  4. Execution decision & live orders when favourable (Strictly zero prong planning)
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

### OPERATIONAL CYCLE DIRECTIVE:

Execute Cycle #{cycle_number} through your 4-phase sequence:

**PHASE 1: PRE-FLIGHT AUDIT (CALL FIRST)**
- Inspect live balance, equity, margin, and open position tickets via `alpha_get_account_status()`.
- Inspect working limit/stop orders via `alpha_get_pending_orders(symbol="XAUUSD")`.

**PHASE 2: MACRO & NEWS INVESTIGATION (PROXIMA SUITE)**
- Investigate breaking sovereign catalysts, calendar gates (CPI, PPI, NFP, FOMC), US nominal 10Y yields (`US10Y`), 10Y real TIPS yields (`DFII10`), and Dollar Index (`DXY`).
- Test tape asymmetry: Is Gold validating the macro print or absorbing selling pressure?
- Check forward runway over next 15–45 minutes.

**PHASE 3: 5-MINUTE TECHNICAL & STRUCTURAL AUDIT (CALL AT LAST AFTER NEWS)**
- Call `alpha_query_analyst_desk(query="Check 5m order flow, fair value gaps, liquidity sweeps, and key supply/demand levels", symbol="XAUUSD")`.
- Call `alpha_get_market_regime_context(symbol="XAUUSD")`.

**PHASE 4: EXECUTION DECISION & ACTION (ZERO PRONG PLANNING)**
- Place actual orders via `alpha_place_pending_order` or `alpha_execute_market_order` WHEN AND ONLY WHEN macro and 5m technical structure align during active market hours.
- Manage existing positions via `alpha_update_position`.
- If market is closed or conditions are unfavourable/choppy: declare **STAND DOWN / NO ACTION**. State your rationale and objective invalidation tripwires.
- **STRICT**: Do NOT manufacture hypothetical prongs (Prong A/B/C) or advisory setups. Do NOT call sentiment publishing tools.

Synthesize your findings in the standard executive report format.
"""
        return prompt

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
    parser.add_argument("--dispatch", action="store_true", help="Dispatch a live MT5 dossier")
    parser.add_argument("--session-id", type=str, default=None, help="Target session ID")
    parser.add_argument("--cycle", type=int, default=1, help="Cycle number")
    parser.add_argument("--loop", action="store_true", help="Run continuously every 5 minutes")
    parser.add_argument("--interval", type=int, default=300, help="Interval in seconds (default: 300 / 5 min)")
    args = parser.parse_args()

    engine = DossierEngine()

    if args.loop:
        sid = args.session_id or (engine.sm.find_latest_macro_session() or {}).get("id")
        if not sid:
            print("No active session found. Provide --session-id or seed one first with seed.py.")
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
