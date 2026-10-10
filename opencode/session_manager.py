"""
OpenCode Session Manager
Handles creation, discovery, message streaming, and prompt dispatching
for OpenCode sessions over local or Tailscale endpoints.
"""

import os
import json
import time
import sqlite3
import logging
import urllib.request
import urllib.error
from typing import Optional, List, Dict, Any

logger = logging.getLogger("escanor.opencode.session")

DEFAULT_TAILSCALE_URL = "http://100.95.56.22:4096"
DEFAULT_LOCAL_URL = "http://127.0.0.1:4096"
DB_PATH = os.path.expanduser("~/.local/share/opencode/opencode.db")


class OpenCodeSessionManager:
    def __init__(self, base_url: Optional[str] = None):
        self.base_url = self._resolve_base_url(base_url)
        logger.info(f"OpenCodeSessionManager initialized with endpoint: {self.base_url}")

    def _resolve_base_url(self, explicit_url: Optional[str] = None) -> str:
        if explicit_url:
            return explicit_url.rstrip("/")
        
        env_url = os.environ.get("OPENCODE_API_URL")
        if env_url:
            return env_url.rstrip("/")

        # Check Tailscale first, fallback to localhost
        for candidate in [DEFAULT_TAILSCALE_URL, DEFAULT_LOCAL_URL]:
            try:
                req = urllib.request.Request(f"{candidate}/session", method="GET")
                with urllib.request.urlopen(req, timeout=2) as resp:
                    if resp.status == 200:
                        return candidate
            except Exception:
                continue
        return DEFAULT_LOCAL_URL

    def list_sessions(self) -> List[Dict[str, Any]]:
        """List all OpenCode sessions from the API."""
        url = f"{self.base_url}/session"
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            logger.error(f"Failed to list sessions from {url}: {e}")
            return []

    def create_session(
        self,
        title: str = "Escanor Macro Intelligence Desk (Pure Proxima)",
        directory: str = r"C:\Trading"
    ) -> Dict[str, Any]:
        """
        Create a new session pinned to C:\\Trading directory so it appears
        cleanly under the /trading/ project tab in OpenCode UI.
        """
        url = f"{self.base_url}/session"
        payload = json.dumps({
            "title": title
        }).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        session_id = data.get("id")
        if not session_id:
            raise RuntimeError(f"Session creation failed to return an id: {data}")

        # Ensure database record is explicitly anchored to C:\Trading and project path Trading
        self._anchor_session_to_trading_project(session_id, directory, title)
        return data

    def _anchor_session_to_trading_project(self, session_id: str, directory: str, title: str):
        """Fixes or ensures SQLite metadata pins directory='C:\\Trading' and path='Trading'."""
        if not os.path.exists(DB_PATH):
            return
        try:
            conn = sqlite3.connect(DB_PATH, timeout=5)
            cur = conn.cursor()
            cur.execute(
                """
                UPDATE session 
                SET directory = ?, path = 'Trading', project_id = 'global', title = ?
                WHERE id = ?
                """,
                (directory, title, session_id)
            )
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"Failed to update session metadata in sqlite: {e}")

    def find_latest_macro_session(self) -> Optional[Dict[str, Any]]:
        """Find the most recent Escanor Macro Intelligence session."""
        sessions = self.list_sessions()
        macro_sessions = [
            s for s in sessions 
            if "Macro" in s.get("title", "") or "Escanor" in s.get("title", "")
        ]
        if macro_sessions:
            return macro_sessions[0]
        return sessions[0] if sessions else None

    def get_messages(self, session_id: str) -> List[Dict[str, Any]]:
        """Fetch message history for a given session."""
        url = f"{self.base_url}/session/{session_id}/message"
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            logger.error(f"Failed to get messages for {session_id}: {e}")
            return []

    def is_idle(self, session_id: str) -> bool:
        """Check if session is currently idle and ready for a new prompt."""
        messages = self.get_messages(session_id)
        if not messages:
            return True
        last_msg = messages[-1]
        parts = last_msg.get("parts", [])
        for p in reversed(parts):
            if p.get("type") == "tool" and p.get("state", {}).get("status") == "running":
                return False
            if p.get("type") == "step-start":
                return False
        return True

    def send_prompt(self, session_id: str, text: str, async_mode: bool = True) -> bool:
        """
        Send a text prompt to the session. 
        Uses prompt_async so the agent can execute MCP tools over multiple steps.
        """
        endpoint = "prompt_async" if async_mode else "prompt"
        url = f"{self.base_url}/session/{session_id}/{endpoint}"
        payload = json.dumps({
            "parts": [{"type": "text", "text": text}]
        }).encode("utf-8")

        for attempt in range(1, 4):
            try:
                req = urllib.request.Request(
                    url,
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=30) as resp:
                    if 200 <= resp.status < 300:
                        logger.info(f"Prompt dispatched to {session_id} (attempt {attempt}).")
                        return True
            except Exception as e:
                logger.warning(f"Dispatch attempt {attempt}/3 failed: {e}")
                time.sleep(1.0)
        return False
