"""
Escanor OpenCode Macro Intelligence Module
Autonomous macro intelligence and news dossier engine powered by Proxima MCP and MT5 live feeds.
"""

from .session_manager import OpenCodeSessionManager
from .dossier_engine import DossierEngine
from .seed import seed_session, MASTER_SEED_PROMPT

__all__ = ["OpenCodeSessionManager", "DossierEngine", "seed_session", "MASTER_SEED_PROMPT"]
