#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FolioFold Launcher
==================
A small, dependency-free launcher that wraps ``server.py`` so FolioFold can be
started with a double-click on Windows.

Behaviour (mirrors ``FolioFold 启动.bat``):
  1. If the server is already answering on http://127.0.0.1:3000, just open the
     browser (single-instance guard) and exit.
  2. Otherwise locate a Python 3.11 (or 3.12) interpreter on the machine.
  3. Start ``server.py`` (expected next to this launcher) as a detached process.
  4. Wait until the server health endpoint responds, then open the browser.

This launcher is NOT a replacement for the server. ``server.py`` remains the
single source of truth; the EXE only automates launching it. The portable BAT
files remain the supported fallback.

No personal paths, usernames, or tokens are referenced anywhere in this file.
"""

import os
import sys
import time
import threading
import webbrowser
import subprocess
import urllib.request
import urllib.error

PORT = 3000
HOST = "127.0.0.1"
APP_NAME = "FolioFold"
HEALTH_URL = "http://%s:%d/api/version" % (HOST, PORT)
HOME_URL = "http://localhost:%d/" % PORT
CREATE_NO_WINDOW = 0x08000000  # Windows: don't spawn a console for the child


def app_base():
    """Directory that contains this launcher / server.py."""
    if getattr(sys, "frozen", False):
        # PyInstaller onedir: sys.executable is the real exe in its folder.
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def show_error(text, title=APP_NAME):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, str(text), str(title), 0x10)  # MB_ICONERROR
    except Exception:
        sys.stderr.write("%s: %s\n" % (title, text))
        try:
            input("Press Enter to exit...")
        except Exception:
            pass


def probe_command(cmd):
    """Run `cmd` (e.g. ['py','-3.11']) with a version print; return (major,minor) or None."""
    try:
        proc = subprocess.run(
            cmd + ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
            capture_output=True, text=True, timeout=20,
            creationflags=CREATE_NO_WINDOW,
        )
        if proc.returncode != 0:
            return None
        out = proc.stdout.strip()
        if not out:
            return None
        parts = out.split(".")
        if len(parts) < 2:
            return None
        return (int(parts[0]), int(parts[1]))
    except Exception:
        return None


def find_python():
    """Return a command (list) to launch a suitable Python, or None."""
    candidates = [
        ["py", "-3.11"],
        ["py", "-3"],
        ["python"],
        ["python3"],
    ]
    results = []
    for c in candidates:
        v = probe_command(c)
        if v is not None:
            results.append((c, v))
    if not results:
        return None
    # Prefer exactly 3.11 (matches server.py's cgi requirement best)
    for c, v in results:
        if v == (3, 11):
            return c
    # Accept any 3.11+ but below 3.13 (cgi was removed in 3.13)
    for c, v in results:
        if (3, 11) <= v < (3, 13):
            return c
    # Last resort: the newest interpreter found
    results.sort(key=lambda x: x[1], reverse=True)
    return results[0][0]


def server_health():
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def _open_url(url):
    try:
        webbrowser.open(url)
    except Exception:
        pass


def open_browser():
    """Best-effort: open the app in the default browser. Never blocks.

    Runs in a daemon thread with a bounded join so a missing/headless browser
    (where the OS URL handler can hang) can never stall the launcher.
    """
    try:
        t = threading.Thread(target=_open_url, args=(HOME_URL,), daemon=True)
        t.start()
        t.join(timeout=5)
    except Exception:
        pass


def find_server(base):
    # Search upward from the launcher's directory for server.py, so the EXE works
    # whether it sits next to server.py (project root) or inside a release/
    # subfolder of the project (e.g. release/FolioFold/FolioFold.exe). server.py
    # always serves from its own directory, so once found we cd there and the
    # whole app (portfolio/, content/, etc.) is available.
    cur = base
    for _ in range(4):
        cand = os.path.join(cur, "server.py")
        if os.path.isfile(cand):
            return cand
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return None


def main():
    base = app_base()
    server_py = find_server(base)
    if not server_py:
        show_error(
            "未找到 server.py。\n\n"
            "请把 FolioFold.exe 与 FolioFold 程序文件放在同一目录下，\n"
            "或改用 FolioFold 启动.bat 启动。"
        )
        return

    # Single-instance guard: already running?
    if server_health():
        open_browser()
        return

    python_cmd = find_python()
    if not python_cmd:
        show_error(
            "未检测到 Python 3.11。\n\n"
            "FolioFold 需要 Python 3.11 才能运行。\n"
            "请安装 Python 3.11 后重试，或使用 FolioFold 启动.bat。"
        )
        return

    app_dir = os.path.dirname(os.path.abspath(server_py))
    try:
        subprocess.Popen(
            python_cmd + [server_py],
            cwd=app_dir,
            creationflags=CREATE_NO_WINDOW,
        )
    except Exception as exc:
        show_error("启动服务器失败：\n%s" % exc)
        return

    # Wait for health (up to ~45s)
    for _ in range(45):
        if server_health():
            break
        time.sleep(1)

    if server_health():
        open_browser()
    else:
        show_error(
            "服务器启动超时。\n\n"
            "请检查 Python 3.11 安装，或改用 FolioFold 启动.bat。",
            title="%s 启动警告" % APP_NAME,
        )


if __name__ == "__main__":
    main()
