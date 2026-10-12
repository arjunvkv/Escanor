"""
Escanor Macro Intelligence & Structural Execution Dossier Engine
Constructs and dispatches real-time situational intelligence dossiers to OpenCode every 5 minutes,
embedding live MT5 gold price/spread, dual UTC+IST timestamps, session dynamics,
and enforcing the 3-phase operating cadence:
  1. Autonomous macro & news investigation via Proxima MCP suite (Multi-model debate ChatGPT vs Gemini)
  2. alpha_query_analyst_desk, alpha_get_market_regime_context, alpha_get_deep_orderflow_telemetry for 5-min technicals (supporting role)
  3. Pre-execution audit (alpha_get_account_status & pending orders) and live orders ONLY if favourable
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
        """Constructs the high-fidelity situational prompt dossier enforcing the 3-phase cadence."""
        sess_info = self.get_market_session_info()
        telem = self.get_mt5_live_telemetry("XAUUSD")

        price_str = f"Bid: {telem['bid']} | Ask: {telem['ask']} | Spread: {telem['spread_pts']} pts" if telem["connected"] else "MT5 Connection Offline / Weekend Freeze"
        range_str = f"2H High: {telem.get('2h_m5_high')} | 2H Low: {telem.get('2h_m5_low')} (Range: {telem.get('2h_m5_range_pts')} pts)" if telem.get("2h_m5_high") else "N/A"

        prompt = f"""### ESCANOR MACRO INTELLIGENCE & EXECUTION DOSSIER - CYCLE #{cycle_number}

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

Execute Cycle #{cycle_number} through your exact 3-phase sequence:

**PHASE 1: MACRO INTELLIGENCE & FULL NEWS AUDIT (YOUR CORE MISSION)**
- **Tools**: `proxima_ask_chatgpt`, `proxima_ask_gemini`, `proxima_deep_search` (powered via Gemini/ChatGPT), `proxima_ddg_search`, `proxima_web_scrape`. *(Perplexity is strictly excluded).*
- **Multi-Model Macro Debate**: Actively query both ChatGPT (`proxima_ask_chatgpt`) and Gemini (`proxima_ask_gemini`). Debate the bull vs bear counter-thesis to stress-test your view.
- **Dynamic Real-World Reality**: Dive deeply into real-world events across the globe (wars, military conflicts, supply shortages, trade shocks, sanctions, energy crises, sovereign debt strains) without limiting your inquiry to any fixed list.
- **The Living Reaction Check (Crucial)**: Evaluate whether Gold ($XAUUSD$) is actually reacting to the news or ignoring/absorbing it. Compare headlines directly against live MT5 tape price action.
- **Full 6-Layer Causal Audit**: Macro Gravity -> Causal Transmission (US10Y, DFII10, DXY) -> Active Regime -> Tape Asymmetry -> Sub-Wires & Catalysts -> Runway Clearance.

**PHASE 2: 5-MINUTE TECHNICAL & STRUCTURAL AUDIT (SUPPORTING ROLE ONLY)**
- Call `alpha_query_analyst_desk(query="Check 5m order flow, fair value gaps, liquidity sweeps, and key supply/demand levels", symbol="XAUUSD")`.
- Call `alpha_get_market_regime_context(symbol="XAUUSD")`.
- Call `alpha_get_deep_orderflow_telemetry(symbol="XAUUSD")` (glance at VWAP bands, DOM depth ladder, retail stop pools, FVG 50% CE).
- Inspect 5m technical structure strictly to support or invalidate the macro thesis.

**PHASE 3: AUDIT & TELEGRAM ALERT (ONLY IF FAVOURABLE - ZERO PRONG PLANNING)**
- **CRITICAL**: Direct broker auto-execution is disabled. The agent does NOT place live orders directly into MT5.
- Do NOT call account status or pending order tools at the beginning of the cycle.
- **IF AND ONLY IF** macro and 5m technical setup align into an actionable high-conviction trade during active market hours:
  1. Call `alpha_get_account_status()` and `alpha_get_pending_orders(symbol="XAUUSD")` right before dispatching the proposal.
  2. Call `alpha_send_telegram_trade_alert` to send the trade proposal to the trader's Telegram channel for manual evaluation:
     - `symbol`: "XAUUSD"
     - `order_type`: "BUY_LIMIT" | "SELL_LIMIT" | "BUY_STOP" | "SELL_STOP" | "BUY" | "SELL"
     - `entry_price`: Exact entry coordinate
     - `sl_price`: Stop Loss coordinate
     - `tp_price`: Take Profit coordinate
     - `rr`: Risk to Reward ratio
     - `risk_dollars`: Estimated dollars in SL
     - `reward_dollars`: Estimated dollars in profit
     - `volume`: Suggested lot size
     - `story`: Short story explaining why this trade is proposed and the macro edge
     - `nearest_inflection_note`: Short note on what is expected to happen at the next nearest point
  3. The trader will evaluate the proposal manually and execute it on MT5.
- **IF NOT FAVOURABLE / MARKET CLOSED**:
  - Declare **STAND DOWN / NO ACTION**. Do NOT call `alpha_get_account_status`, `alpha_get_pending_orders`, or `alpha_send_telegram_trade_alert`.
  - State your macro rationale, synthesize the ChatGPT/Gemini debate, and define objective invalidation tripwires.
  - **STRICT**: Zero hypothetical prongs (Prong A/B/C) or advisory setups. Zero sentiment publishing tools.

**FINAL MANDATORY SECTION**:
At last, after all your analysis, print a short note on exactly what is going to happen at the next nearest point/coordinate (Section 4 in your report: Nearest coordinate, expected event/price action, validation vs invalidation).

Synthesize your findings in the standard executive report format.
"""
        return prompt

    def dispatch_dossier(self, session_id: Optional[str] = None, cycle_number: int = 1) -> bool:
        """Builds and dispatches the live dossier to the target session."""
        if not session_id:
            latest = self.sm.find_latest_macro_session()
            if not latest:
                logger.info("No active macro session found. Creating a fresh session...")
                new_sess = self.sm.create_session("Escanor Macro Intelligence Desk (Pure Proxima)")
                session_id = new_sess["id"]
            else:
                session_id = latest["id"]

        dossier = self.build_dossier_content(cycle_number=cycle_number)
        logger.info(f"Dispatching Dossier #{cycle_number} to session {session_id}...")
        return self.sm.send_prompt(session_id, dossier, async_mode=True)

    def run_periodic_loop(self, session_id: Optional[str] = None, interval_seconds: int = 300, max_cycles: Optional[int] = None):
        """
        Runs the recurring 5-minute dossier trigger loop.
        Monitors session idle status and dispatches fresh MT5 dossiers periodically.
        """
        if not session_id:
            latest = self.sm.find_latest_macro_session()
            if not latest:
                logger.info("Creating a fresh OpenCode session for dossier loop...")
                new_sess = self.sm.create_session("Escanor Macro Intelligence Desk (Pure Proxima)")
                session_id = new_sess["id"]
            else:
                session_id = latest["id"]

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
    parser.add_argument("--new-session", action="store_true", help="Create a fresh session and use it")
    parser.add_argument("--cycle", type=int, default=1, help="Cycle number")
    parser.add_argument("--loop", action="store_true", help="Run continuously every 5 minutes")
    parser.add_argument("--interval", type=int, default=300, help="Interval in seconds (default: 300 / 5 min)")
    args = parser.parse_args()

    engine = DossierEngine()

    sid = args.session_id
    if args.new_session:
        sess = engine.sm.create_session("Escanor Macro Intelligence Desk (Pure Proxima)")
        sid = sess["id"]
        print(f"Created fresh session: {sid}")

    if args.loop:
        engine.run_periodic_loop(session_id=sid, interval_seconds=args.interval)
    elif args.dispatch:
        engine.dispatch_dossier(session_id=sid, cycle_number=args.cycle)
    else:
        print("Market Session:")
        print(json.dumps(engine.get_market_session_info(), indent=2))
        print("\nMT5 Telemetry:")
        print(json.dumps(engine.get_mt5_live_telemetry(), indent=2))
        print("\nPreview Dossier:")
        print(engine.build_dossier_content(1))
