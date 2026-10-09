# Escanor — High-Performance Trading Terminal

Escanor is an ultra-fast, lightweight trading terminal powered by direct MetaTrader 5 tick streaming, built for low-latency market analysis and precision execution.

## Features

- **TradingView Clone Terminal (Desktop)**:
  - Exact TradingView Obsidian theme (`#131722`) with silver bull (`#d1d4dc`) and pink bear (`#e0457b`) candles.
  - Live candle countdown timer on the right price scale.
  - Full drawing toolkit: Crosshair, Trend Line, Ray Line, Extended Line, Horizontal Line, Vertical Line, Rectangle/Box.
  - Interactive Measurement Ruler with `Shift + Drag` shortcut.
  - **Server-Side Drawings Persistence**: All markings are automatically saved on the server and synchronized across all devices and browsers.
  - Quick Buy/Sell execution pad with live spread.

- **Escanor Mobile HUD**:
  - Full 5-Axis mercury thermometer radar gauges.
  - 20-bar M1 candle sequence snake.
  - Peak & trough extension monitor.
  - Spatial terrain boundaries (FVG, Asian range sweeps, PDH/PDL, VWAP).
  - Streamlined and focused (news feed excised).

- **Lightweight Backend Daemon (`server.py`)**:
  - FastAPI HTTP server on port `5055` + WebSocket broadcaster on port `5056`.
  - Zero news scraping, zero LLM polling, zero MCP overhead.
  - Direct MT5 execution engine.

- **Dormant Core Mechanisms**:
  - Preserved modular stubs for Cloudflare WARP proxy bridge, OpenCode asynchronous prompt sync, and MT5 trade routing.

## Quick Start

```bash
# Start the Escanor daemon
python server.py
```

- **Desktop Chart**: `http://127.0.0.1:5055/chart`
- **Mobile HUD**: `http://127.0.0.1:5055/mobile`
- **Auto-Router**: `http://127.0.0.1:5055/` (routes mobile browsers to `/mobile` and desktop to `/chart`)
