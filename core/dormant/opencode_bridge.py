"""
Escanor OpenCode Bridge (Dormant Core Module)
Clean core module preserving:
1. OpenCode server start mechanism
2. Asynchronous prompt dispatcher & idle polling
3. Institutional dossier send & data receive mechanism
"""

import os
import sys
import time
import json
import logging
import subprocess
import urllib.request
import urllib.error
from typing import Optional, Dict, Any, List

logger = logging.getLogger("escanor.opencode_bridge")
OPENCODE_API_URL = os.environ.get("OPENCODE_API_URL", "http://127.0.0.1:4096")


def start_opencode_server(port: int = 4096, proxy_url: Optional[str] = "http://127.0.0.1:40001") -> Optional[subprocess.Popen]:
    """Launch local OpenCode headless server process with optional HTTP proxy."""
    cmd = ["opencode", "serve", "--port", str(port), "--hostname", "0.0.0.0"]
    env = os.environ.copy()
    if proxy_url:
        env["HTTP_PROXY"] = proxy_url
        env["HTTPS_PROXY"] = proxy_url

    try:
        proc = subprocess.Popen(
            cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            shell=True
        )
        logger.info(f"OpenCode server launched (PID: {proc.pid}) on port {port}")
        return proc
    except Exception as err:
        logger.error(f"Failed to launch OpenCode server: {err}")
        return None


def is_opencode_idle(session_id: str, api_url: str = OPENCODE_API_URL) -> bool:
    """Check if OpenCode session is idle and ready for new instructions."""
    try:
        url = f"{api_url}/session/{session_id}"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                status = data.get("status", {})
                return status.get("type") in ("idle", "ready", "waiting_for_input", None)
    except Exception:
        pass
    return False


def send_prompt_async(session_id: str, prompt_text: str, api_url: str = OPENCODE_API_URL) -> bool:
    """Dispatch text prompt to OpenCode asynchronously without blocking."""
    url = f"{api_url}/session/{session_id}/prompt_async"
    payload = json.dumps({
        "parts": [{"type": "text", "text": prompt_text}]
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception as err:
        logger.warning(f"send_prompt_async failed: {err}")
        return False


def build_dossier(
    cycle_id: int,
    symbol: str,
    structure: Dict[str, Any],
    tape: Dict[str, Any],
    open_positions: List[Dict[str, Any]],
    account_status: Dict[str, Any]
) -> Dict[str, Any]:
    """Compile structured market context dossier for OpenCode consumption."""
    return {
        "cycle_id": cycle_id,
        "timestamp": time.time(),
        "symbol": symbol,
        "structure": structure,
        "tape": tape,
        "open_positions": open_positions,
        "account": account_status
    }


def save_dossier(dossier: Dict[str, Any], output_path: str = "logs/dossier.json") -> bool:
    """Persist structured dossier to disk."""
    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(dossier, f, indent=2)
        return True
    except Exception as err:
        logger.error(f"Failed to save dossier: {err}")
        return False


def parse_opencode_response(raw_message: str) -> Dict[str, Any]:
    """Extract trading actions or reasoning directives from OpenCode text output."""
    action = {"type": "HOLD", "reasoning": raw_message}
    if "BUY" in raw_message.upper():
        action["type"] = "BUY"
    elif "SELL" in raw_message.upper():
        action["type"] = "SELL"
    return action
