"""Startet Distrimatcher lokal:  python -m distrimatcher  (bzw. Distrimatcher.exe)

Der Server lauscht nur auf 127.0.0.1 (nicht im Netzwerk erreichbar). Ist `pywebview`
installiert, öffnet sich ein eigenes Desktop-Fenster, sonst der Standardbrowser.
"""
from __future__ import annotations

import argparse
import socket
import threading
import time
import webbrowser


def free_port(preferred: int) -> int:
    for port in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("kein freier Port")


def main() -> None:
    ap = argparse.ArgumentParser(prog="distrimatcher")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--browser", action="store_true", help="Browser statt Desktop-Fenster verwenden")
    args = ap.parse_args()

    import uvicorn

    from .app import app

    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}/"
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    while not server.started:
        time.sleep(0.05)
    print(f"Distrimatcher läuft auf {url}  (Beenden mit Strg+C)")

    if not args.no_browser and not args.browser:
        try:
            import webview  # pywebview

            webview.create_window("Distrimatcher", url, width=1400, height=900)
            webview.start()
            server.should_exit = True
            return
        except ImportError:
            pass
    if not args.no_browser:
        webbrowser.open(url)
    try:
        while t.is_alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        server.should_exit = True


if __name__ == "__main__":
    main()
