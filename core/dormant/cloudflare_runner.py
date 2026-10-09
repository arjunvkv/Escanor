"""
Escanor Cloudflare Runner & OpenCode Connection Bridge (Dormant Core Module)
Clean core module preserving Cloudflare WARP SOCKS5 / HTTP CONNECT proxy bridge,
route monitoring, and OpenCode connectivity.
"""

import os
import sys
import time
import socket
import select
import threading
import subprocess
import urllib.request
import urllib.error
from typing import Optional, List, Dict, Any

OPENCODE_API_URL = os.environ.get("OPENCODE_API_URL", "http://127.0.0.1:4096")
HTTP_BRIDGE_PORT = 40001
WARP_SOCKS_PORT = 40000

WARP_CLI_PATHS = [
    r"C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe",
    r"C:\Program Files (x86)\Cloudflare\Cloudflare WARP\warp-cli.exe",
    "warp-cli.exe"
]


class CloudflareProxyBridge:
    """Threaded HTTP CONNECT and forward proxy bridge routing via Cloudflare WARP SOCKS5."""

    def __init__(self, http_port: int = HTTP_BRIDGE_PORT, socks_port: int = WARP_SOCKS_PORT):
        self.http_port = http_port
        self.socks_host = "127.0.0.1"
        self.socks_port = socks_port
        self.running = False
        self._server_sock: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._active_sockets = set()

    def start(self):
        """Start local HTTP forward proxy server in background thread."""
        self.running = True
        self._server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server_sock.bind(("0.0.0.0", self.http_port))
        self._server_sock.listen(128)

        t = threading.Thread(target=self._accept_loop, daemon=True)
        t.start()
        print(f"[Cloudflare Bridge] Listening on 0.0.0.0:{self.http_port} (SOCKS5 127.0.0.1:{self.socks_port})")

    def _accept_loop(self):
        while self.running:
            try:
                client_sock, client_addr = self._server_sock.accept()
                threading.Thread(target=self._handle_client, args=(client_sock,), daemon=True).start()
            except Exception:
                if not self.running:
                    break

    def _handle_client(self, client_sock: socket.socket):
        with self._lock:
            self._active_sockets.add(client_sock)
        try:
            req_data = client_sock.recv(4096)
            if not req_data:
                client_sock.close()
                return

            first_line = req_data.split(b"\r\n")[0].decode("latin-1", errors="replace")
            parts = first_line.split()
            if len(parts) < 2:
                client_sock.close()
                return

            method, target = parts[0], parts[1]
            if method.upper() == "CONNECT":
                host_str, port_str = target.split(":")
                dest_host = host_str
                dest_port = int(port_str)
                remote_sock = self.connect_socks5(dest_host, dest_port)
                client_sock.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                self._bi_pipe(client_sock, remote_sock)
            else:
                # Standard forward proxy
                client_sock.close()
        except Exception:
            try:
                client_sock.close()
            except Exception:
                pass
        finally:
            with self._lock:
                self._active_sockets.discard(client_sock)

    def connect_socks5(self, dest_host: str, dest_port: int) -> socket.socket:
        """Establish outbound tunnel via local Cloudflare WARP SOCKS5 daemon."""
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.connect((self.socks_host, self.socks_port))
        # Handshake: NO AUTH (0x05, 0x01, 0x00)
        s.sendall(b"\x05\x01\x00")
        resp = s.recv(2)
        if resp != b"\x05\x00":
            s.close()
            raise RuntimeError("SOCKS5 handshake failed")

        host_bytes = dest_host.encode("utf-8")
        req = b"\x05\x01\x00\x03" + bytes([len(host_bytes)]) + host_bytes + dest_port.to_bytes(2, "big")
        s.sendall(req)
        resp2 = s.recv(10)
        if len(resp2) < 4 or resp2[1] != 0x00:
            s.close()
            raise RuntimeError(f"SOCKS5 connect error: {resp2}")
        return s

    def _bi_pipe(self, sock1: socket.socket, sock2: socket.socket):
        sockets = [sock1, sock2]
        while self.running:
            r_socks, _, _ = select.select(sockets, [], [], 10.0)
            if not r_socks:
                continue
            for s in r_socks:
                other = sock2 if s is sock1 else sock1
                try:
                    data = s.recv(16384)
                    if not data:
                        return
                    other.sendall(data)
                except Exception:
                    return

    def stop(self):
        self.running = False
        if self._server_sock:
            try:
                self._server_sock.close()
            except Exception:
                pass


def check_opencode_health(api_url: str = OPENCODE_API_URL) -> bool:
    """Verify if local OpenCode server is responding."""
    try:
        req = urllib.request.Request(f"{api_url}/session", method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False
