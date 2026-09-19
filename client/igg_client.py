# -*- coding: utf-8 -*-
"""
IGG VIP Studio - Windows Client.
Native WebView2 window that loads the web app from your deployed server and
exposes window.iggNative so the app's ADB features (connect/pull/push/unban/
auto-update) work from the desktop. No save algorithm and no secrets live here.

Run from source:   python igg_client.py
Build the EXE:     build_exe.bat
"""

from __future__ import annotations

import base64
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

import webview  # pywebview - native WebView2 window

APP_NAME = "IGG VIP Studio"
APP_VERSION = "1.1.0"

# Where the app UI comes from. Override with env IGG_VIP_URL or
# %APPDATA%\IGG-VIP-Studio\server.txt
DEFAULT_SERVER_URL = "https://igg-vip-studio-07u9.onrender.com"

GAME_PACKAGE = "com.playrix.township"
SAVE_DIR = f"/sdcard/Android/data/{GAME_PACKAGE}/files"
SAVE_FILE = "mGameInfo.xml"
LOCAL_INFO_FILE = "mLocalInfo.xml"


def _app_data_dir() -> Path:
    root = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    d = Path(root) / "IGG-VIP-Studio"
    d.mkdir(parents=True, exist_ok=True)
    return d


def resolve_server_url() -> str:
    env = (os.environ.get("IGG_VIP_URL") or "").strip()
    if env:
        return env.rstrip("/")
    try:
        txt = (_app_data_dir() / "server.txt").read_text(encoding="utf-8").strip()
        if txt:
            return txt.rstrip("/")
    except Exception:
        pass
    return DEFAULT_SERVER_URL


_ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_DEVICE_ID_RE = re.compile(r"^VIP(?:-[A-Z0-9]{4}){5}$")


def _mint_device_id() -> str:
    raw = os.urandom(20)
    chars = [_ALPH[b % len(_ALPH)] for b in raw]
    return "VIP-" + "-".join("".join(chars[i:i + 4]) for i in range(0, 20, 4))


def get_device_id() -> str:
    p = _app_data_dir() / "device.id"
    try:
        existing = p.read_text(encoding="utf-8").strip().upper()
        if _DEVICE_ID_RE.match(existing):
            return existing
    except Exception:
        pass
    new_id = _mint_device_id()
    try:
        p.write_text(new_id, encoding="utf-8")
    except Exception:
        pass
    return new_id
# ── ADB helpers ──────────────────────────────────────────────────────────────
def _find_adb() -> str | None:
    here = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    candidates = [here / "adb" / "adb.exe", here / "adb.exe"]
    on_path = shutil.which("adb")
    if on_path:
        candidates.append(Path(on_path))
    local = os.environ.get("LOCALAPPDATA", "")
    pf = os.environ.get("ProgramFiles", "C:\\Program Files")
    pfx = os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")
    for base in [
        Path(local) / "Android" / "Sdk" / "platform-tools" / "adb.exe",
        Path(pf) / "Nox" / "bin" / "adb.exe",
        Path(pfx) / "Nox" / "bin" / "adb.exe",
        Path(local) / "Programs" / "BlueStacks_nxt" / "HD-Adb.exe",
        Path(pf) / "BlueStacks_nxt" / "HD-Adb.exe",
        Path(local) / "LDPlayer" / "LDPlayer9" / "adb.exe",
        Path(pf) / "LDPlayer" / "LDPlayer9" / "adb.exe",
        Path(local) / "Microvirt" / "MEmu" / "adb.exe",
    ]:
        candidates.append(base)
    for c in candidates:
        try:
            if c and Path(c).exists():
                return str(c)
        except Exception:
            continue
    return None


def _run_adb(adb: str, args: list[str], timeout: int = 30) -> tuple[int, bytes, bytes]:
    try:
        proc = subprocess.run(
            [adb] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return 124, b"", b"adb timed out"
    except Exception as e:  # noqa: BLE001
        return 1, b"", str(e).encode("utf-8", "replace")

class NativeBridge:
    """Exposed to the page as window.iggNative (method names match the app)."""

    def version(self) -> str:
        return APP_VERSION

    # license key storage
    def loadSavedKey(self) -> str:
        try:
            return (_app_data_dir() / "license.key").read_text(encoding="utf-8").strip()
        except Exception:
            return ""

    def saveKey(self, key: str) -> dict:
        try:
            (_app_data_dir() / "license.key").write_text(str(key).strip(), encoding="utf-8")
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def clearSavedKey(self) -> dict:
        try:
            (_app_data_dir() / "license.key").unlink(missing_ok=True)
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    # ADB
    def devices(self) -> list[dict]:
        adb = _find_adb()
        if not adb:
            return []
        code, out, _ = _run_adb(adb, ["devices"])
        if code != 0:
            return []
        result: list[dict] = []
        for line in out.decode("utf-8", "replace").splitlines()[1:]:
            line = line.strip()
            if not line or "\t" not in line:
                continue
            serial, state = line.split("\t", 1)
            if state.strip() == "device":
                result.append({"id": serial.strip(), "label": serial.strip()})
        return result

    def forceStop(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            return {"ok": False, "package": GAME_PACKAGE, "error": "adb not found"}
        _run_adb(adb, ["-s", serial, "shell", "am", "force-stop", GAME_PACKAGE])
        return {"ok": True, "package": GAME_PACKAGE}

    def _pull_b64(self, adb: str, serial: str, remote_dir: str, fname: str) -> tuple[bytes, str]:
        remote = f"{remote_dir}/{fname}"
        with tempfile.TemporaryDirectory() as td:
            local = Path(td) / fname
            code, _, err = _run_adb(adb, ["-s", serial, "pull", remote, str(local)])
            if code == 0 and local.exists():
                return local.read_bytes(), fname
            code2, out2, _ = _run_adb(adb, ["-s", serial, "shell", "cat", remote])
            if code2 == 0 and out2:
                return out2, fname
            msg = (err or b"pull failed").decode("utf-8", "replace").strip() or "pull failed"
            raise RuntimeError(msg)

    def pull(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        data, fname = self._pull_b64(adb, serial, SAVE_DIR, SAVE_FILE)
        return {"b64": base64.b64encode(data).decode("ascii"), "file": fname}

    def pullLocalInfo(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        data, fname = self._pull_b64(adb, serial, SAVE_DIR, LOCAL_INFO_FILE)
        return {"b64": base64.b64encode(data).decode("ascii"), "file": fname, "package": GAME_PACKAGE}

    def push(self, serial: str, b64: str, options: dict | None = None) -> dict:
        options = options or {}
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        if not options.get("alreadyStopped"):
            _run_adb(adb, ["-s", serial, "shell", "am", "force-stop", GAME_PACKAGE])
            time.sleep(0.4)
        data = base64.b64decode(b64)
        with tempfile.TemporaryDirectory() as td:
            local = Path(td) / SAVE_FILE
            local.write_bytes(data)
            code, _, err = _run_adb(adb, ["-s", serial, "push", str(local), f"{SAVE_DIR}/{SAVE_FILE}"])
            if code != 0:
                raise RuntimeError(err.decode("utf-8", "replace").strip() or "push failed")
            bak = Path(td) / "mGameInfo.bak"
            bak.write_bytes(data)
            _run_adb(adb, ["-s", serial, "push", str(bak), f"{SAVE_DIR}/mGameInfo.bak"])
        if options.get("restart"):
            _run_adb(adb, ["-s", serial, "shell", "monkey", "-p", GAME_PACKAGE,
                           "-c", "android.intent.category.LAUNCHER", "1"])
        return {"ok": True}
    # self-update
    def installUpdate(self, release: dict) -> dict:
        try:
            url = release["downloadUrl"]
            expected = str(release["sha256"]).lower()
            version = str(release.get("version", ""))
        except Exception:
            return {"ok": False, "reason": "invalid release payload"}
        if not getattr(sys, "frozen", False):
            return {"ok": False, "reason": "not-packaged"}

        current_exe = Path(sys.executable).resolve()
        new_exe = current_exe.with_name(f"{current_exe.stem}-{version or 'new'}.exe")
        try:
            with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310
                payload = resp.read()
            if zipfile.is_zipfile(io.BytesIO(payload)):
                with zipfile.ZipFile(io.BytesIO(payload)) as zf:
                    name = next((n for n in zf.namelist() if n.lower().endswith(".exe")), None)
                    if not name:
                        return {"ok": False, "reason": "zip has no exe"}
                    payload = zf.read(name)
            digest = hashlib.sha256(payload).hexdigest().lower()
            if expected and digest != expected:
                return {"ok": False, "reason": "sha256 mismatch"}
            new_exe.write_bytes(payload)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "reason": f"download failed: {e}"}

        bat = new_exe.with_suffix(".cmd")
        bat.write_text(
            "@echo off\r\n"
            "ping 127.0.0.1 -n 3 >nul\r\n"
            f'move /y "{new_exe}" "{current_exe}" >nul\r\n'
            f'start "" "{current_exe}"\r\n'
            'del "%~f0" >nul 2>&1\r\n',
            encoding="ascii",
        )
        subprocess.Popen(["cmd", "/c", str(bat)],
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        threading.Timer(0.6, _quit_app).start()
        return {"ok": True, "version": version}


def _quit_app() -> None:
    try:
        for w in list(webview.windows):
            w.destroy()
    finally:
        os._exit(0)  # noqa: SLF001


# pywebview exposes the api object as window.pywebview.api.*. The web app looks
# for window.iggNative.*, so we alias it as soon as the bridge is ready.
_ALIAS_JS = """
(function () {
  function install() {
    try {
      if (window.pywebview && window.pywebview.api && !window.iggNative) {
        window.iggNative = window.pywebview.api;
        window.dispatchEvent(new Event('igg-native-ready'));
      }
    } catch (e) {}
  }
  install();
  var n = 0;
  var t = setInterval(function () {
    install();
    if ((window.iggNative) || ++n > 50) clearInterval(t);
  }, 100);
})();
"""


def main() -> None:
    url = resolve_server_url()
    bridge = NativeBridge()
    get_device_id()  # ensure a stable device id exists for the app to match
    window = webview.create_window(
        APP_NAME,
        url,
        js_api=bridge,
        width=1280,
        height=840,
        min_size=(1024, 680),
        background_color="#0b0f1a",
        text_select=True,
    )

    def _inject() -> None:
        window.evaluate_js(_ALIAS_JS)

    webview.start(_inject, debug=bool(os.environ.get("IGG_VIP_DEBUG")))


if __name__ == "__main__":
    main()


