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
import json
import socket
import ssl
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
from http.client import HTTPConnection, HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urlunsplit

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
APP_VERSION = "1.1.4"

# Where the app UI comes from. Override with env IGG_VIP_URL or
# %APPDATA%\IGG-VIP-Studio\server.txt
DEFAULT_SERVER_URL = "https://igg-vip-studio-07u9.onrender.com"

# Render serves every service through a wildcard record, so a name that the
# local resolver rejects is a resolver fault, not a missing service. When the
# OS resolver cannot answer we ask a public DNS-over-HTTPS endpoint for the
# address and connect to it directly, which is what lets the EXE work on a
# machine whose DNS is broken.
DOH_ENDPOINTS = (
    ("https://1.1.1.1/dns-query", "cloudflare-dns.com"),
    ("https://8.8.8.8/resolve", "dns.google"),
)

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


def normalize_base_url(url: str) -> str:
    """Reduce whatever the user configured to a single https origin.

    A stale `server.txt` pointing at the retired Vercel host was a silent
    hang, so an unusable value falls back to the baked Render origin rather
    than leaving the window blank.
    """
    raw = (url or "").strip()
    if not raw:
        return DEFAULT_SERVER_URL
    if "://" not in raw:
        raw = "https://" + raw
    try:
        u = urlsplit(raw)
    except ValueError:
        return DEFAULT_SERVER_URL
    # urlsplit accepts spaces and other junk inside the netloc, so the
    # hostname is checked against the DNS alphabet before it is trusted.
    host = u.hostname or ""
    if u.scheme not in ("http", "https") or not re.fullmatch(
        r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*",
        host,
    ):
        return DEFAULT_SERVER_URL
    return urlunsplit((u.scheme, u.netloc, "", "", ""))


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


def _doh_lookup(host: str) -> str | None:
    """Ask a public DNS-over-HTTPS resolver for `host`'s address.

    Only used when the OS resolver fails. The endpoints are addressed by IP so
    this path never depends on the very resolution that is broken.
    """
    for endpoint, _sni in DOH_ENDPOINTS:
        try:
            url = f"{endpoint}?{urlencode({'name': host, 'type': 'A'})}"
            req = urllib.request.Request(url, headers={"accept": "application/dns-json"})
            with urllib.request.urlopen(req, timeout=6) as resp:  # noqa: S310
                payload = json.loads(resp.read().decode("utf-8", "replace"))
            for ans in payload.get("Answer", []):
                if ans.get("type") == 1 and re.fullmatch(
                    r"\d{1,3}(?:\.\d{1,3}){3}", str(ans.get("data", ""))
                ):
                    return str(ans["data"])
        except Exception:  # noqa: BLE001
            continue
    return None


def resolve_origin_ip(host: str) -> str | None:
    """Address of `host`, preferring the OS resolver and falling back to DoH."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
        if infos:
            return infos[0][4][0]
    except Exception:  # noqa: BLE001
        pass
    return _doh_lookup(host)


class _PinnedHTTPSConnection(HTTPSConnection):
    """TLS to a known IP while still validating the certificate of the hostname.

    Connecting by IP alone would fail verification (and lose SNI), so the socket
    goes to the pinned address but the handshake is verified against `host`.
    """

    def __init__(self, host: str, ip: str, port: int, timeout: float) -> None:
        super().__init__(host, port, timeout=timeout)
        self._pinned_ip = ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)
        if self._tunnel_host:
            self._tunnel()
        ctx = self._context or ssl.create_default_context()
        self.sock = ctx.wrap_socket(self.sock, server_hostname=self.host)


_HOP_HEADERS = {
    "host", "connection", "proxy-connection", "keep-alive",
    "transfer-encoding", "upgrade", "te", "trailer",
}


class _LocalProxy:
    """Serve 127.0.0.1 and forward to the Render origin over a pinned socket.

    WebView2 then only ever talks to localhost, so the client keeps working even
    when the machine cannot resolve the origin name itself. The app uses plain
    HTTP only (no SSE or WebSockets), so proxy framing is not a concern.
    """

    def __init__(self, base_url: str) -> None:
        self.base = normalize_base_url(base_url)
        u = urlsplit(self.base)
        self.scheme = u.scheme
        self.host = u.hostname or ""
        self.port = u.port or (443 if u.scheme == "https" else 80)
        ip = resolve_origin_ip(self.host)
        if not ip:
            raise RuntimeError(f"cannot resolve {self.host}")
        self.ip = ip
        self._server: ThreadingHTTPServer | None = None
        self.url = ""

    def start(self) -> str:
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: object) -> None:  # noqa: ARG002
                pass

            def _forward(self) -> None:
                proxy._handle(self)

            do_GET = _forward
            do_POST = _forward
            do_PUT = _forward
            do_DELETE = _forward
            do_HEAD = _forward
            do_OPTIONS = _forward

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self._server.server_port}"
        return self.url

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length") or 0)
        body = handler.rfile.read(length) if length else None

        headers = {
            k: v
            for k, v in handler.headers.items()
            if k.lower() not in _HOP_HEADERS
        }
        default_port = 443 if self.scheme == "https" else 80
        headers["Host"] = self.host if self.port == default_port else f"{self.host}:{self.port}"
        headers["Connection"] = "close"

        try:
            if self.scheme == "https":
                conn: HTTPConnection | _PinnedHTTPSConnection = _PinnedHTTPSConnection(
                    self.host, self.ip, self.port, 30
                )
            else:
                conn = HTTPConnection(self.ip, self.port, timeout=30)
            conn.putrequest(handler.command, handler.path, skip_host=True, skip_accept_encoding=True)
            for k, v in headers.items():
                conn.putheader(k, v)
            if body is not None:
                conn.putheader("Content-Length", str(len(body)))
            conn.endheaders()
            if body is not None:
                conn.send(body)
            resp = conn.getresponse()
            data = resp.read()
            status, reason = resp.status, resp.reason
            resp_headers = resp.getheaders()
            conn.close()
        except Exception as e:  # noqa: BLE001
            self._reply_error(handler, f"IGG VIP Studio could not reach {self.host}: {e}")
            return

        handler.send_response(status, reason)
        for k, v in resp_headers:
            if k.lower() in _HOP_HEADERS:
                continue
            handler.send_header(k, v)
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Connection", "close")
        handler.end_headers()
        if handler.command != "HEAD":
            handler.wfile.write(data)

    @staticmethod
    def _reply_error(handler: BaseHTTPRequestHandler, message: str) -> None:
        try:
            payload = message.encode("utf-8", "replace")
            handler.send_response(502)
            handler.send_header("Content-Type", "text/plain; charset=utf-8")
            handler.send_header("Content-Length", str(len(payload)))
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(payload)
        except Exception:  # noqa: BLE001
            pass


def _os_resolves(host: str) -> bool:
    try:
        return bool(socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP))
    except Exception:  # noqa: BLE001
        return False


def choose_window_url(base: str) -> str:
    """Load the origin directly, unless this machine cannot resolve it.

    WebView2 resolves the origin name itself, so a machine whose DNS rejects the
    name shows ERR_NAME_NOT_RESOLVED no matter how good the EXE is. When the OS
    resolver fails we serve the app through a loopback proxy backed by DoH, which
    sidesteps that resolver entirely. DNS that works keeps the direct HTTPS load,
    so nothing about the normal case changes.

    `IGG_VIP_PROXY=1` forces the proxy, for the rare case where the resolver
    answers Python but WebView2 still cannot reach the origin.
    """
    host = urlsplit(base).hostname or ""
    forced = (os.environ.get("IGG_VIP_PROXY") or "").strip().lower() in ("1", "true", "yes")
    if not host or (_os_resolves(host) and not forced):
        return base
    try:
        return _LocalProxy(base).start()
    except Exception:  # noqa: BLE001
        return base


def main() -> None:
    url = choose_window_url(normalize_base_url(resolve_server_url()))

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


