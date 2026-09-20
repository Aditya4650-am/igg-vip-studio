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

# In a windowed (no-console) build sys.stdout/sys.stderr are None, not a
# NullWriter. Anything that writes to them - including libraries we do not
# control, such as bottle's server banner - would raise AttributeError and kill
# the app on startup, so point them at the null device before importing them.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")  # noqa: SIM115
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")  # noqa: SIM115

import webview  # pywebview - native WebView2 window

APP_NAME = "IGG VIP Studio"
APP_VERSION = "1.1.1"

# Where the app UI comes from. Override with env IGG_VIP_URL or
# %APPDATA%\IGG-VIP-Studio\server.txt
DEFAULT_SERVER_URL = "https://igg-vip-studio-07u9.onrender.com"

# Both Township package variants are supported, exactly like the v1.15 client.
# Global is preferred; the Vietnam build remains a supported fallback.
GAME_PACKAGES = ["com.playrix.township", "com.playrix.township.vn"]

SAVE_FILE = "mGameInfo.xml"
LOCAL_INFO_FILE = "mLocalInfo.xml"

# The save lives in the package's private storage and needs root via `su`, but
# the exact folder differs between game builds (`saves/`, `files/`, or the
# package root) and between the global and Vietnam packages. A single hardcoded
# path silently fails with "No such file or directory" on installs that use a
# different layout, so the real path is discovered on the device (see
# `_find_on_device`) and these are only the fallbacks tried when discovery fails.
_SAVE_SUBDIRS = ("saves", "files", "app_data", "")

_SAVE_BASES = (
    "/data/data/{pkg}",
    "/data/user/0/{pkg}",
    "/data/user_de/0/{pkg}",
    "/sdcard/Android/data/{pkg}/files",
    "/storage/emulated/0/Android/data/{pkg}/files",
)


def candidate_paths_for_package(pkg: str, filename: str) -> list[str]:
    out: list[str] = []
    for base in _SAVE_BASES:
        root = base.format(pkg=pkg)
        for sub in _SAVE_SUBDIRS:
            path = f"{root}/{sub}/{filename}" if sub else f"{root}/{filename}"
            if path not in out:
                out.append(path)
    return out


def save_path_for_package(pkg: str) -> str:
    return f"/data/data/{pkg}/saves/{SAVE_FILE}"


def localinfo_path_for_package(pkg: str) -> str:
    return f"/data/data/{pkg}/saves/{LOCAL_INFO_FILE}"


# Real device paths discovered per (serial, package, filename), so push writes
# back to exactly where the pull came from.
_PATH_CACHE: dict[tuple[str, str, str], str] = {}

# Track which package each device actually uses, so push goes back to the same
# package the pull came from (v1.15 behavior).
_active_package: dict[str, str] = {}


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
    """Locate an adb executable: bundled first, then PATH, then every common
    emulator install location (MEmu / LDPlayer / Nox / BlueStacks / SDK)."""
    here = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    candidates: list[Path] = [
        here / "adb" / "adb.exe",
        here / "adb.exe",
    ]
    on_path = shutil.which("adb")
    if on_path:
        candidates.append(Path(on_path))

    local = os.environ.get("LOCALAPPDATA", "")
    roaming = os.environ.get("APPDATA", "")
    pf = os.environ.get("ProgramFiles", "C:\\Program Files")
    pfx = os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")
    home = str(Path.home())
    desktop = str(Path.home() / "Desktop")
    onedrive = os.environ.get("OneDrive", "")

    for base in [
        # Android SDK
        Path(local) / "Android" / "Sdk" / "platform-tools" / "adb.exe",
        Path(pf) / "Android" / "platform-tools" / "adb.exe",
        # MEmu (Program Files AND AppData AND LocalAppData)
        Path(pf) / "Microvirt" / "MEmu" / "adb.exe",
        Path(pfx) / "Microvirt" / "MEmu" / "adb.exe",
        Path(local) / "Microvirt" / "MEmu" / "adb.exe",
        Path(roaming) / "Microvirt" / "MEmu" / "adb.exe",
        # LDPlayer (many install dir names)
        Path(pf) / "LDPlayer" / "adb.exe",
        Path(pf) / "LDPlayer" / "LDPlayer9" / "adb.exe",
        Path(pf) / "ldplayer9box" / "adb.exe",
        Path(pf) / "ldplayerbox" / "adb.exe",
        Path(pfx) / "LDPlayer" / "LDPlayer9" / "adb.exe",
        Path(local) / "LDPlayer" / "LDPlayer9" / "adb.exe",
        Path(local) / "ldplayer9box" / "adb.exe",
        # Nox
        Path(pf) / "Nox" / "bin" / "adb.exe",
        Path(pfx) / "Nox" / "bin" / "adb.exe",
        # BlueStacks
        Path(local) / "Programs" / "BlueStacks_nxt" / "HD-Adb.exe",
        Path(pf) / "BlueStacks_nxt" / "HD-Adb.exe",
        Path(pfx) / "BlueStacks_nxt" / "HD-Adb.exe",
        Path(pf) / "BlueStacks" / "HD-Adb.exe",
        # Genymotion
        Path(local) / "Genymobile" / "Genymotion" / "tools" / "adb.exe",
        # Loose platform-tools copies people commonly keep around
        Path(home) / "platform-tools" / "adb.exe",
        Path(desktop) / "platform-tools" / "adb.exe",
        Path(home) / "Downloads" / "platform-tools" / "adb.exe",
    ]:
        candidates.append(base)
    if onedrive:
        candidates.append(Path(onedrive) / "Desktop" / "platform-tools" / "adb.exe")

    for c in candidates:
        try:
            if c and Path(c).exists():
                return str(c)
        except Exception:
            continue
    return None


# Ports used by the common Android emulators for their adb listener.
_EMULATOR_PORTS = [5555, 5554, 62001, 62025, 21503, 7555, 5037]


def _ensure_adb_ready(adb: str) -> list[dict]:
    """Start the adb server and auto-connect known emulator ports, then list
    devices. Returns the connected device list."""
    # 1. Start the local adb server (no-op if already running).
    _run_adb(adb, ["start-server"], timeout=20)

    devices = _adb_devices(adb)
    if devices:
        return devices

    # 2. Nothing attached: try the well-known emulator loopback ports.
    for port in _EMULATOR_PORTS:
        if port == 5037:  # that is the server port, never a device
            continue
        _run_adb(adb, ["connect", f"127.0.0.1:{port}"], timeout=8)
    return _adb_devices(adb)


def _adb_devices(adb: str) -> list[dict]:
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


_PRINTABLE = frozenset(range(0x20, 0x7F)) | {0x09, 0x0A, 0x0D}


def _is_probably_file(buf: bytes) -> bool:
    """Reject shell diagnostics that `adb exec-out` merged into stdout.

    exec-out writes stderr to the same pipe as stdout, so a failed
    `su -c "cat '<file>'"` yields text like
    `cat: /data/data/.../mLocalInfo.xml: Permission denied` instead of the file.
    That text is long enough to pass a plain length check and would be sent to
    the server as a "save", which then fails with a confusing format error.
    A real save is either XML (starts with `<`, BOM/whitespace aside) or a
    binary container with bytes outside the printable range; such text is neither.
    """
    head = buf[:512]
    if any(b == 0 for b in head):
        return True
    if any(b not in _PRINTABLE for b in head):
        return True
    # Plain-text payloads are only a file when they are the document itself, so a
    # leading `cat: …` diagnostic is rejected even if XML follows it.
    return head.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"<")


def _looks_like_shell_error(buf: bytes) -> bool:
    """True when `buf` is shell diagnostics rather than file content."""
    if not buf:
        return False
    if len(buf) > 64 and _is_probably_file(buf):
        return False
    text = buf[:200].decode("utf-8", "replace")
    return bool(_SHELL_ERR_RE.search(text))


_SHELL_ERR_RE = __import__("re").compile(
    r"(permission denied|no such file|not found|is a directory|read-only"
    r"|operation not permitted|inaccessible|unknown option|not debuggable)",
    __import__("re").I,
)


def _find_on_device(adb: str, serial: str, pkg: str, filename: str) -> str | None:
    """Ask the device where `filename` actually lives for this package.

    Install layouts differ (`saves/`, `files/`, or the package root) and so do
    the usable roots (`/data/data` vs `/data/user/0`), so a hardcoded path fails
    on some builds with "No such file or directory". `find` needs root, and on
    an unrooted device the whole call fails, in which case the caller falls back
    to the static candidate list.
    """
    roots = " ".join(
        base.format(pkg=pkg)
        for base in (
            "/data/data/{pkg}",
            "/data/user/0/{pkg}",
            "/data/user_de/0/{pkg}",
            "/sdcard/Android/data/{pkg}",
            "/storage/emulated/0/Android/data/{pkg}",
        )
    )
    script = (
        f"find {roots} -maxdepth 3 -name {filename} -type f 2>/dev/null | head -n 5"
    )
    for args in (
        ["-s", serial, "exec-out", "su", "-c", script],
        ["-s", serial, "shell", f"su -c '{script}'"],
    ):
        code, out, _ = _run_adb(adb, args, timeout=25)
        if code != 0 or not out:
            continue
        if _looks_like_shell_error(out):
            continue
        for line in out.decode("utf-8", "replace").splitlines():
            path = line.strip().lstrip("\ufeff")
            if path.startswith("/") and path.endswith(filename):
                return path
    return None


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
        return _ensure_adb_ready(adb)

    def adbInfo(self) -> dict:
        """Diagnostics for the UI: which adb was found and what it sees."""
        adb = _find_adb()
        if not adb:
            return {"found": False, "path": "", "devices": [], "message": "adb not found"}
        devices = _ensure_adb_ready(adb)
        return {
            "found": True,
            "path": adb,
            "devices": devices,
            "message": "ok" if devices else "adb found but no device connected",
        }

    # ADB — package helpers (v1.15 exact semantics)
    def _pkgs_for(self, serial: str) -> list[str]:
        preferred = _active_package.get(serial)
        out: list[str] = []
        for p in [preferred, *GAME_PACKAGES]:
            if p and p not in out:
                out.append(p)
        return out

    def _is_pkg_installed(self, adb: str, serial: str, pkg: str) -> bool:
        code, out, _ = _run_adb(adb, ["-s", serial, "shell", "pm", "path", pkg], timeout=10)
        return code == 0 and b"package:" in out

    def _pull_privileged(self, adb: str, serial: str, remote: str, diag: list[str] | None = None) -> bytes | None:
        notes: list[str] = []

        def accept(out: bytes) -> bytes | None:
            # Length alone is not enough: exec-out can return a shell error
            # message of any length. Only accept bytes that look like a file.
            if len(out) > 64 and _is_probably_file(out):
                return out
            text = out[:200].decode("utf-8", "replace").strip()
            if text:
                notes.append(text)
            return None

        tries = [
            ["-s", serial, "exec-out", "su", "-c", f"cat '{remote}'"],
            ["-s", serial, "exec-out", "su", "0", "cat", remote],
            ["-s", serial, "exec-out", "su", "-c", f"cat \"{remote}\""],
        ]
        for args in tries:
            code, out, _ = _run_adb(adb, args, timeout=60)
            if code == 0:
                ok = accept(out)
                if ok is not None:
                    return ok
        if remote.startswith("/data/data/"):
            pkg = remote.split("/data/data/")[1].split("/")[0]
            rel = remote.split(f"/data/data/{pkg}/")[1]
            for args in (
                ["-s", serial, "exec-out", "run-as", pkg, "cat", rel],
                ["-s", serial, "exec-out", "su", "-c", f"run-as {pkg} cat {rel}"],
            ):
                code, out, _ = _run_adb(adb, args, timeout=60)
                if code == 0:
                    ok = accept(out)
                    if ok is not None:
                        return ok
        tmp = "/data/local/tmp/igg_pull_tmp.bin"
        code, _, _ = _run_adb(adb, ["-s", serial, "shell", f"su -c 'cp \"{remote}\" {tmp} && chmod 644 {tmp}'"], timeout=30)
        if code == 0:
            with tempfile.TemporaryDirectory() as td:
                local = Path(td) / "pull.bin"
                code2, _, _ = _run_adb(adb, ["-s", serial, "pull", tmp, str(local)], timeout=60)
                if code2 == 0 and local.exists():
                    buf = local.read_bytes()
                    ok = accept(buf)
                    if ok is not None:
                        return ok
        if diag is not None:
            diag.extend(notes)
        return None

    def forceStop(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            return {"ok": False, "package": "", "error": "adb not found"}
        errs: list[str] = []
        for pkg in self._pkgs_for(serial):
            code, _, err = _run_adb(adb, ["-s", serial, "shell", "am", "force-stop", pkg], timeout=10)
            if code == 0:
                _active_package[serial] = pkg
                return {"ok": True, "package": pkg}
            errs.append(f"{pkg}: {err.decode('utf-8','replace').strip()}")
        return {"ok": False, "package": "", "error": " | ".join(errs)}

    def _read_candidates(self, adb: str, serial: str, pkg: str, filename: str, diag: list[str]) -> tuple[str, bytes] | None:
        """Read `filename` for `pkg`, discovering the real path on the device.

        Returns the path that worked together with its bytes, or None. The
        discovered path is cached per (serial, pkg, filename) so a later push
        writes back to the same location.
        """
        known = _PATH_CACHE.get((serial, pkg, filename))
        discovered = _find_on_device(adb, serial, pkg, filename)
        ordered: list[str] = []
        for path in [discovered, known, *candidate_paths_for_package(pkg, filename)]:
            if path and path not in ordered:
                ordered.append(path)
        for remote in ordered:
            buf = self._pull_privileged(adb, serial, remote, diag)
            if buf and len(buf) >= 8:
                _PATH_CACHE[(serial, pkg, filename)] = remote
                return remote, buf
        return None

    def pull(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        errs: list[str] = []
        for pkg in self._pkgs_for(serial):
            if not self._is_pkg_installed(adb, serial, pkg):
                errs.append(f"{pkg}: package not installed")
                continue
            diag: list[str] = []
            found = self._read_candidates(adb, serial, pkg, SAVE_FILE, diag)
            if found:
                remote, buf = found
                _active_package[serial] = pkg
                head = buf[: min(len(buf), 256)].decode("utf-8", "replace").lstrip("\ufeff").lstrip()
                return {"b64": base64.b64encode(buf).decode("ascii"), "file": remote, "package": pkg, "plain": head.startswith("<")}
            errs.append(f"{pkg}: {diag[0]}" if diag else f"{pkg}: could not read {SAVE_FILE} in any known folder")
        raise RuntimeError(
            "Could not read mGameInfo from emulator. Tried: " + " | ".join(errs)
            + ". Check Root and open Township at least once."
        )

    def pullLocalInfo(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        errs: list[str] = []
        for pkg in self._pkgs_for(serial):
            if not self._is_pkg_installed(adb, serial, pkg):
                errs.append(f"{pkg}: package not installed")
                continue
            diag: list[str] = []
            found = self._read_candidates(adb, serial, pkg, LOCAL_INFO_FILE, diag)
            if found:
                remote, buf = found
                _active_package[serial] = pkg
                return {"b64": base64.b64encode(buf).decode("ascii"), "file": remote, "package": pkg}
            errs.append(f"{pkg}: {diag[0]}" if diag else f"{pkg}: could not read {LOCAL_INFO_FILE} in any known folder")
        raise RuntimeError(
            "Could not read mLocalInfo from emulator. Tried: " + " | ".join(errs)
            + ". Check Root and open Township at least once."
        )

    def push(self, serial: str, b64: str, options: dict | None = None) -> dict:
        options = options or {}
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        data = base64.b64decode(b64)
        if len(data) > 24 * 1024 * 1024:
            raise RuntimeError("Save output exceeds the 24 MB safety limit.")
        head = data[: min(len(data), 256)].decode("utf-8", "replace").lstrip("\ufeff").lstrip()
        if not head.startswith("<"):
            raise RuntimeError("Save must be plain XML (v1.15 plaintext mode).")
        if len(data) < 16:
            raise RuntimeError("Save output too short to push.")
        if not options.get("alreadyStopped"):
            _ = self.forceStop(serial)
            time.sleep(0.4)
        with tempfile.TemporaryDirectory() as td:
            local = Path(td) / SAVE_FILE
            local.write_bytes(data)
            tmp = "/data/local/tmp/mGameInfo_push.bin"
            code, _, err = _run_adb(adb, ["-s", serial, "push", str(local), tmp], timeout=60)
            if code != 0:
                raise RuntimeError("adb push failed: " + err.decode("utf-8", "replace").strip())
            errs: list[str] = []
            for pkg in self._pkgs_for(serial):
                # Write back to where the pull actually found the file; a
                # discovered path beats the static default, which may not exist.
                xml_path = _PATH_CACHE.get((serial, pkg, SAVE_FILE)) or save_path_for_package(pkg)
                bak_path = xml_path.replace(f"/{SAVE_FILE}", f"/{SAVE_FILE[:-4]}.bak")
                shell = f"su -c 'cp \"{tmp}\" \"{xml_path}\"; cp \"{tmp}\" \"{bak_path}\"; chmod 600 \"{xml_path}\" \"{bak_path}\"'"
                code2, out2, err2 = _run_adb(adb, ["-s", serial, "shell", shell], timeout=30)
                combined = (out2 + err2).decode("utf-8", "replace").strip()
                if code2 == 0 and not __import__("re").search(r"permission denied|not found|no such file|failed|error:", combined, __import__("re").I):
                    _active_package[serial] = pkg
                    if options.get("restart", True):
                        _run_adb(adb, ["-s", serial, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], timeout=12)
                    return {"ok": True, "package": pkg, "paths": {"xml": xml_path, "bak": bak_path}, "size": len(data), "plaintext": True, "relaunched": options.get("restart", True)}
                errs.append(f"{pkg}: {combined or 'su cp failed'}")
            raise RuntimeError("Push failed — " + " | ".join(errs))

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


def _fatal(message: str) -> None:
    """A windowed EXE has no console, so an unhandled exception would leave the
    user with nothing at all. Show a native dialog instead."""
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, 0x10)
    except Exception:  # noqa: BLE001
        pass


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
    try:
        main()
    except Exception as e:  # noqa: BLE001
        _fatal(
            f"{APP_NAME} could not start.\n\n{e}\n\n"
            "If the interface never appears, install the Microsoft Edge WebView2 "
            "Runtime (it is preinstalled on Windows 11)."
        )
        raise


