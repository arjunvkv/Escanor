"""
Escanor Macro Intelligence Dossier Engine
Constructs and dispatches real-time situational intelligence dossiers to OpenCode,
embedding live MT5 gold price/spread, dual UTC+IST timestamps, session dynamics,
and empowering OpenCode to use Proxima tools freely for sovereign macro analysis.
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

        # Session gates (UTC)
        # Asian: 00:00 - 08:00 UTC
        # London: 07:00 - 15:30 UTC
        # NY: 12:30 - 21:00 UTC
        # London/NY Overlap: 12:30 - 15:30 UTC
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
        """Constructs the high-fidelity situational prompt dossier."""
        sess_info = self.get_market_session_info()
        telem = self.get_mt5_live_telemetry("XAUUSD")

        price_str = f"Bid: {telem['bid']} | Ask: {telem['ask']} | Spread: {telem['spread_pts']} pts" if telem["connected"] else "MT5 Connection Offline / Weekend Freeze"
        range_str = f"2H High: {telem.get('2h_m5_high')} | 2H Low: {telem.get('2h_m5_low')} (Range: {telem.get('2h_m5_range_pts')} pts)" if telem.get("2h_m5_high") else "N/A"

        prompt = f"""### ESCANOR MACRO INTELLIGENCE DOSSIER — CYCLE #{cycle_number}

**1. REAL-TIME CLOCK & SESSION TELEMETRY**:
- **UTC Time**: {sess_info['utc_time']}
- **IST Time**: {sess_info['ist_time']}
- **Active Market Gate**: {', '.join(sess_info['sessions'])}
- **Trading Day Status**: {'Market Closed (Weekend / Hold Evaluation Mode)' if sess_info['is_weekend'] else 'Live Auction Open'}

**2. LIVE BROKER & ASSET REALITY (MT5 XAUUSD)**:
- **Spot Quote**: {price_str}
- **Recent Technical Range (2H)**: {range_str}

---

### MISSION DIRECTIVE FOR OPENCODE:
Conduct a comprehensive, situational sovereign intelligence assessment for Gold ($XAUUSD$).
You have complete freedom to invoke **Proxima MCP tools** (`proxima_ask_perplexity`, `proxima_ask_chatgpt`, `proxima_web_scrape`, `proxima_ddg_search`, `proxima_deep_search`) across as many steps and in whatever sequence you deem necessary. Do not restrict tool calls.

**Execute through the 6-Stage Situational Causal Hierarchy**:
1. **Stage 1 (Global Macro Horizon & Breaking Sovereign Catalysts)**: Identify breaking geopolitics, central bank pronouncements, fiscal announcements, or sovereign risk.
2. **Stage 2 (Economic Calendar & Imminent Tier-1 Releases)**: Check upcoming prints (CPI, PPI, NFP, PCE, FOMC, GDP, Retail Sales, Unemployment Claims). Note timing and market consensus.
3. **Stage 3 (Sovereign Rates & Real Yield Gravitational Reality)**: Analyze US 10-Year Real Yields (`DFII10`), Nominal 10Y Yields (`US10Y`), and the US Dollar Index (`DXY`). Is Gold acting as a rate asset, safe haven, or currency alternative?
4. **Stage 4 (Physical Transmission & Supply/Demand Realities)**: Central bank reserve flows, ETF liquidations/accumulations, physical premiums (Shanghai Gold Exchange vs London spot).
5. **Stage 5 (Immediate Tape Alignment & Price Action Interaction)**: Compare the macro narrative against current MT5 price ({telem.get('bid', 'N/A')}). Is Gold validating the macro news, or showing causal asymmetry (refusing to rally/dump)?
6. **Stage 6 (Synthesis & 15-Minute Actionable Macro Roadmap)**: Provide the current sovereign regime, macro bias, key invalidation levels, and actionable intelligence for the desk.

*Remember: Follow the Anti-Naive Filtering and Negative Search Guidance in your standing instructions. Formulate your findings clearly in this session.*
"""
        return prompt

    def seed_new_session(self, title: str = "Escanor Macro Intelligence Desk (Pure Proxima)") -> str:
        """Creates and initializes a clean OpenCode session pinned to C:\\Trading."""
        session = self.sm.create_session(title=title, directory=r"C:\Trading")
        session_id = session["id"]
        logger.info(f"Created new OpenCode session: {session_id} - '{title}'")

        seed_message = """# ESCANOR MACRO INTELLIGENCE DESK INITIALIZED

Standing Orders loaded from AGENTS.md:
- Pure Proxima MCP Intelligence Harness (`ask_perplexity`, `ask_chatgpt`, `web_scrape`, `ddg_search`, `deep_search`).
- Autonomous freedom: execute any sequence and number of tool inquiries needed.
- Grounded in live MT5 spot price and dual UTC/IST timestamps.
- Zero naive mechanical assumptions: pure situational macroeconomic reasoning.

The desk is initialized and standing by for the initial intelligence dossier.
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


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Escanor Macro Dossier Engine")
    parser.add_argument("--seed", action="store_true", help="Create and seed a new session in /trading/")
    parser.add_argument("--dispatch", action="store_true", help="Dispatch the live MT5 dossier")
    parser.add_argument("--session-id", type=str, default=None, help="Target session ID")
    parser.add_argument("--cycle", type=int, default=1, help="Cycle number")
    args = parser.parse_args()

    engine = DossierEngine()

    if args.seed:
        sid = engine.seed_new_session()
        print(f"SESSION_ID={sid}")
        if args.dispatch:
            time.sleep(2.0)
            engine.dispatch_dossier(session_id=sid, cycle_number=args.cycle)
    elif args.dispatch:
        engine.dispatch_dossier(session_id=args.session_id, cycle_number=args.cycle)
    else:
        print("Market Session:")
        print(json.dumps(engine.get_market_session_info(), indent=2))
        print("\nMT5 Telemetry:")
        print(json.dumps(engine.get_mt5_live_telemetry(), indent=2))
        print("\nPreview Dossier:")
        print(engine.build_dossier_content(1))
