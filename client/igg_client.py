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
import secrets
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
APP_VERSION = "1.1.27"

# Where the app UI comes from. Override with env IGG_VIP_URL or
# %APPDATA%\IGG-VIP-Studio\server.txt
#
# The old service (igg-vip-studio-46) was suspended by Render for exceeding
# the 750 free instance hours the *workspace* gets each month. Since the EXE
# has no bundled copy of the UI, a suspended origin leaves the window on
# Render's notice page instead of the tool - which reads as "the EXE will not
# open". `server.txt` still overrides this without rebuilding.
DEFAULT_SERVER_URL = "https://igg-vip-studio-491.onrender.com"

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
# Bundled fresh-city profile (extracted from the proven TS-Lite asset): a
# complete LocalInfo + mGameInfo pair for a brand-new city, in the game's
# own container encoding.
FRESH_PROFILE_DIR = "fresh_profile"
FRESH_LOCAL_PROFILE = "localinfo.profile"
FRESH_SAVE_PROFILE = "mgameinfo.profile"

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
    """Candidate paths for mGameInfo.xml (save file)."""
    out: list[str] = []
    for base in _SAVE_BASES:
        root = base.format(pkg=pkg)
        for sub in _SAVE_SUBDIRS:
            path = f"{root}/{sub}/{filename}" if sub else f"{root}/{filename}"
            if path not in out:
                out.append(path)
    return out


def localinfo_candidate_paths_for_package(pkg: str) -> list[str]:
    """Candidate paths for mLocalInfo.xml — prioritizes files/ over saves/."""
    out: list[str] = []
    # LocalInfo lives in files/ or package root in most builds; saves/ is wrong.
    localinfo_subdirs = ("files", "shared_prefs", "", "saves", "app_data")
    for base in _SAVE_BASES:
        root = base.format(pkg=pkg)
        for sub in localinfo_subdirs:
            path = f"{root}/{sub}/{LOCAL_INFO_FILE}" if sub else f"{root}/{LOCAL_INFO_FILE}"
            if path not in out:
                out.append(path)
    return out


def save_path_for_package(pkg: str) -> str:
    return f"/data/data/{pkg}/saves/{SAVE_FILE}"


def localinfo_path_for_package(pkg: str) -> str:
    return f"/data/data/{pkg}/files/{LOCAL_INFO_FILE}"


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
# A refused write does not always say "permission denied". On MEmu's
# SettingsProvider the answer is a Java stack trace on stdout —
# "Exception occurred while executing 'put': java.lang.SecurityException" —
# which matched none of the plain patterns originally used here, so every
# refusal was classified as "the id did not change" and the real reason
# never reached the user.
_ADB_WRITE_REJECTED = re.compile(
    r"permission denied|not found|no such file|failed|error:|unknown id"
    r"|not allowed|not permitted|read-only file system"
    r"|exception occurred|securityexception|java\.lang\.|denied by",
    re.I,
)

_SETTING_EL_RE = re.compile(r"<setting\b[^>]*?/?>", re.I)
_ANDROID_ID_NAME_RE = re.compile(r'\bname\s*=\s*"android_id"', re.I)
_VALUE_ATTR_RE = re.compile(r'\bvalue\s*=\s*"[^"]*"')
_DEFAULT_VALUE_ATTR_RE = re.compile(r'\bdefaultValue\s*=\s*"[^"]*"', re.I)


def _rewrite_secure_android_id(xml: str, new_id: str) -> tuple[str, int]:
    """Rewrite android_id inside the <setting> element that declares it.

    Scoped to that one element because both the attribute order and the
    value attribute's name vary between builds: AOSP writes
    `name="android_id" value="..."`, while MEmu's provider writes
    `package="root" defaultSysSet="true"` and keeps the id in
    `defaultValue="..."`. A regex that pins one ordering finds nothing in
    the other and answers "entry not found" against a file that plainly
    holds the id — which is how the reset ended up refusing with no usable
    reason. Whichever of the two the row actually carries is rewritten in
    place, and the attribute's own name is preserved so the file keeps its
    shape.

    Returns the rewritten text and how many rows were touched.
    """
    hits = 0

    def repl(m: re.Match[str]) -> str:
        nonlocal hits
        el = m.group(0)
        if not _ANDROID_ID_NAME_RE.search(el):
            return el
        # `value` wins when the row carries both: that is the one
        # `settings get` returns. `\bvalue` cannot match inside
        # `defaultValue`, so the two never collide.
        if _VALUE_ATTR_RE.search(el):
            new_el, n = _VALUE_ATTR_RE.subn(f'value="{new_id}"', el)
        else:
            new_el, n = _DEFAULT_VALUE_ATTR_RE.subn(f'defaultValue="{new_id}"', el)
        if n == 0:
            return el
        hits += 1
        return new_el

    return _SETTING_EL_RE.sub(repl, xml), hits


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
        f"find {roots} -maxdepth 5 -name {filename} -type f 2>/dev/null | head -n 5"
    )
    iname_pat = "*localinfo*" if "localinfo" in filename.lower() else f"*{filename}*"
    sweep = (
        f"find {roots} -maxdepth 5 -iname {iname_pat} -type f 2>/dev/null | head -n 10"
    )
    for script_each in (script, sweep):
        for args in (
            ["-s", serial, "exec-out", "su", "-c", script_each],
            ["-s", serial, "shell", f"su -c '{script_each}'"],
        ):
            code, out, _ = _run_adb(adb, args, timeout=25)
            if code != 0 or not out:
                continue
            if _looks_like_shell_error(out):
                continue
            for line in out.decode("utf-8", "replace").splitlines():
                path = line.strip().lstrip("\ufeff")
                if not path.startswith("/"):
                    continue
                if path.endswith(filename):
                    return path
                if "localinfo" in filename.lower() and "localinfo" in path.lower():
                    return path
    return None


def _list_package_dir(adb: str, serial: str, pkg: str) -> str:
    """Best-effort `ls` of the package data dir for error diagnostics."""
    for base in (f"/data/data/{pkg}", f"/data/user/0/{pkg}"):
        for sub in ("", "/files", "/shared_prefs", "/saves"):
            target = f"{base}{sub}"
            for args in (
                ["-s", serial, "exec-out", "su", "-c", f"ls {target} 2>&1 | head -n 20"],
                ["-s", serial, "shell", f"su -c 'ls {target} 2>&1 | head -n 20'"],
            ):
                try:
                    code, out, _ = _run_adb(adb, args, timeout=15)
                except Exception:
                    continue
                if code == 0 and out:
                    text = out.decode("utf-8", "replace").strip()
                    if text and "No such file" not in text and "Permission denied" not in text:
                        return f"{target}: {text[:300]}"
    return ""


class NativeBridge:
    """Exposed to the page as window.iggNative (method names match the app)."""

    def version(self) -> str:
        return APP_VERSION

    # Stable machine id for license binding: minted once, persisted under
    # %APPDATA%/IGG-VIP-Studio/device.id, so reopening the EXE back to back
    # returns the same id on one PC and different ids on different PCs.
    def deviceId(self) -> str:
        return get_device_id()

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

    # file export (the WebView2 shell can silently drop blob-URL downloads,
    # so the UI prefers this native path and keeps the blob as fallback)
    def exportFile(self, name: str, b64: str) -> dict:
        try:
            data = base64.b64decode(b64)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"bad payload: {e}")
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(name)).strip("._") or "export.bin"
        if len(data) > 64 * 1024 * 1024:
            raise RuntimeError("Export exceeds the 64 MB safety limit.")
        target = Path.home() / "Downloads"
        try:
            target.mkdir(parents=True, exist_ok=True)
        except Exception:  # noqa: BLE001
            target = Path(tempfile.gettempdir())
        dest = target / safe
        n = 1
        while dest.exists():
            n += 1
            stem, suffix = safe.rsplit(".", 1) if "." in safe else (safe, "")
            dest = target / f"{stem}-{n}.{suffix}" if suffix else target / f"{stem}-{n}"
        dest.write_bytes(data)
        return {"ok": True, "path": str(dest), "size": len(data)}

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
            known = _PATH_CACHE.get((serial, pkg, LOCAL_INFO_FILE))
            discovered = _find_on_device(adb, serial, pkg, LOCAL_INFO_FILE)
            ordered: list[str] = []
            for path in [discovered, known, *localinfo_candidate_paths_for_package(pkg)]:
                if path and path not in ordered:
                    ordered.append(path)
            for remote in ordered:
                buf = self._pull_privileged(adb, serial, remote, diag)
                if buf and len(buf) >= 8:
                    _PATH_CACHE[(serial, pkg, LOCAL_INFO_FILE)] = remote
                    _active_package[serial] = pkg
                    return {"b64": base64.b64encode(buf).decode("ascii"), "file": remote, "package": pkg}
            errs.append(f"{pkg}: {diag[0]}" if diag else f"{pkg}: could not read {LOCAL_INFO_FILE} in any known folder")
            listing = _list_package_dir(adb, serial, pkg)
            if listing:
                errs.append(f"{pkg} dir: {listing}")
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
        # Push plain XML like v1.15 reference client — game accepts plain XML
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

    def wipeFiles(self, serial: str, paths: list[str] | tuple[str, ...]) -> dict:
        """Delete exact device files (fresh-start wipe), then force-stop.

        Both paths are attempted even if one fails. Every destructive call
        carries the device serial; blank or relative paths are rejected
        without touching the device.
        """
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        cleaned: list[str] = []
        errs: list[str] = []
        for remote in paths or []:
            p = str(remote or "").strip()
            if not p or not p.startswith("/"):
                errs.append(f"{p or '(empty)'}: rejected (absolute device path required)")
                continue
            ok = False
            notes: list[str] = []
            for shell in (f"su -c 'rm -f \"{p}\"'", f"su 0 rm -f \"{p}\""):
                code, out, err = _run_adb(adb, ["-s", serial, "shell", shell], timeout=30)
                combined = (out + err).decode("utf-8", "replace").strip()
                if code == 0 and not re.search(
                    r"permission denied|not found|no such file|failed|error:|not allowed", combined, re.I
                ):
                    ok = True
                    break
                notes.append(combined or f"exit {code}")
            if ok:
                code, out, _ = _run_adb(adb, ["-s", serial, "shell", f"su -c 'ls \"{p}\"'"], timeout=30)
                if code == 0 and out.strip():
                    ok = False
                    notes.append("file still present after rm")
            if ok:
                cleaned.append(p)
            else:
                errs.append(f"{p}: " + (" | ".join(n for n in notes if n) or "delete failed"))
        stop = self.forceStop(serial)
        if not stop.get("ok"):
            errs.append(str(stop.get("error") or "force-stop failed"))
        return {"ok": not errs, "wiped": cleaned, "error": " | ".join(errs)}

    # Fresh-start ("New Account") helpers: enumerate + read + restore the
    # full state-file set (city, login, prefs, databases) and reset the
    # Android ID, so a ban cannot survive in an identity file we never saw.
    def _active_pkg(self, adb: str, serial: str) -> str | None:
        for pkg in self._pkgs_for(serial):
            if self._is_pkg_installed(adb, serial, pkg):
                return pkg
        return None

    def listStateFiles(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        pkg = self._active_pkg(adb, serial)
        if not pkg:
            raise RuntimeError("Township package not installed on " + serial)
        found: list[str] = []
        for base in (f"/data/data/{pkg}", f"/data/user/0/{pkg}"):
            for sub in ("saves", "files", "shared_prefs", "databases"):
                code, out, _ = _run_adb(
                    adb, ["-s", serial, "shell", f"su -c 'ls \"{base}/{sub}\"'"], timeout=15
                )
                if code != 0:
                    continue
                for name in out.decode("utf-8", "replace").split():
                    name = name.strip()
                    if not name or name in (".", ".."):
                        continue
                    # Skip bulky caches and opaque storage; identity + saves only.
                    if sub in ("saves", "files") and name not in (
                        SAVE_FILE, SAVE_FILE[:-4] + ".bak", LOCAL_INFO_FILE,
                    ):
                        continue
                    if len(found) < 64:
                        found.append(f"{base}/{sub}/{name}")
        # De-duplicate while keeping discovery order.
        uniq: list[str] = []
        for p in found:
            if p not in uniq:
                uniq.append(p)
        _active_package[serial] = pkg
        return {"ok": True, "package": pkg, "files": uniq}

    def readFile(self, serial: str, path: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        p = str(path or "").strip()
        if not p.startswith("/"):
            raise RuntimeError("absolute device path required")
        buf = self._pull_privileged(adb, serial, p)
        if not buf:
            raise RuntimeError("could not read " + p)
        return {"b64": base64.b64encode(buf).decode("ascii"), "file": p, "size": len(buf)}

    def writeFile(self, serial: str, path: str, b64: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        p = str(path or "").strip()
        if not p.startswith("/"):
            raise RuntimeError("absolute device path required")
        try:
            data = base64.b64decode(b64)
        except Exception:
            raise RuntimeError("backup payload is not valid base64")
        if not data or len(data) > 24 * 1024 * 1024:
            raise RuntimeError("backup payload has an unusable size")
        with tempfile.TemporaryDirectory() as td:
            local = Path(td) / "restore.bin"
            local.write_bytes(data)
            tmp = "/data/local/tmp/mGameInfo_restore.bin"
            code, _, err = _run_adb(adb, ["-s", serial, "push", str(local), tmp], timeout=60)
            if code != 0:
                raise RuntimeError("adb push failed: " + err.decode("utf-8", "replace").strip())
            shell = f"su -c 'cp \"{tmp}\" \"{p}\" && chmod 600 \"{p}\"'"
            code2, out2, err2 = _run_adb(adb, ["-s", serial, "shell", shell], timeout=30)
            combined = (out2 + err2).decode("utf-8", "replace").strip()
            if code2 != 0 or re.search(
                r"permission denied|not found|no such file|failed|error:", combined, re.I
            ):
                raise RuntimeError(f"restore failed for {p}: {combined or 'su cp failed'}")
        return {"ok": True, "file": p, "size": len(data)}

    def readAndroidId(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        # NOTE: the su form must be ONE shell string. Passing su/-c/payload as
        # separate argv items makes `adb shell` join them with spaces and the
        # device runs a broken command ("Unknown id: put").
        for args in (
            ["-s", serial, "shell", "settings", "get", "secure", "android_id"],
            ["-s", serial, "shell", "su -c 'settings get secure android_id'"],
            ["-s", serial, "shell", "su 0 settings get secure android_id"],
        ):
            code, out, _ = _run_adb(adb, args, timeout=15)
            val = out.decode("utf-8", "replace").strip().lower()
            if code == 0 and re.fullmatch(r"[0-9a-f]{16}", val or ""):
                return {"ok": True, "androidId": val}
        raise RuntimeError("could not read Android ID (need root)")

    def resetAndroidId(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        try:
            old = self.readAndroidId(serial).get("androidId", "")
        except RuntimeError as e:
            raise RuntimeError("read current Android ID first: " + str(e))
        for _ in range(5):
            new_id = secrets.token_hex(8)
            if new_id != old:
                break
        # Same single-string rule as above; also try the plain shell first
        # (relaxed emulators allow it) before the su variants. The `content`
        # command hits the same provider through a different door — delete +
        # re-insert sometimes lands where a plain update is ignored.
        put_cmds = [
            f"settings put secure android_id {new_id}",
            f"su -c 'settings put secure android_id {new_id}'",
            f"su 0 settings put secure android_id {new_id}",
            f"su -c 'settings delete secure android_id'",
            f"su -c 'content delete --uri content://settings/secure --where \"name=''android_id''\"'",
            f"su -c 'content insert --uri content://settings/secure --bind name:s:android_id --bind value:s:{new_id}'",
            f"su -c 'content update --uri content://settings/secure/android_id --bind value:s:{new_id}'",
        ]
        # A put can report success while the provider silently keeps the old
        # value (hardened emulators), so every apparent success is verified
        # by re-read immediately and the next variant is tried on mismatch.
        last_err = ""
        for cmd in put_cmds:
            code, out, err = _run_adb(adb, ["-s", serial, "shell", cmd], timeout=15)
            combined = (out + err).decode("utf-8", "replace").strip()
            if code != 0 or _ADB_WRITE_REJECTED.search(combined):
                # Keep the device's own words — see _ADB_WRITE_REJECTED.
                last_err = combined or "su failed"
                continue
            check = ""
            try:
                check = self.readAndroidId(serial).get("androidId", "")
            except RuntimeError:
                check = ""
            if check == new_id:
                last_err = ""
                break
            last_err = "id unchanged after write"
        if last_err:
            # The provider is dropping every write. On these builds the id
            # lives in settings_secure.xml, not settings.db, and
            # forceAndroidId edits exactly that file — it has existed for
            # this case all along and simply had no caller, which is why the
            # tool used to give up and send the user to MEmu's own dialog
            # instead of doing the work itself. The reboot is part of it:
            # the provider only reloads that file at boot.
            try:
                return self._forceAndroidIdRebooted(serial)
            except RuntimeError as e:
                detail = last_err if last_err not in ("su failed", "id unchanged after write") else str(e)
                raise RuntimeError(
                    "Android ID reset refused"
                    + (": " + detail if detail else "")
                    + " — change it in the emulator's device settings instead "
                    "(MEmu multi-instance properties), then Verify"
                ) from e
        self._drop_ssaid_cache(adb, serial)
        try:
            check = self.readAndroidId(serial).get("androidId", "")
        except RuntimeError:
            check = ""
        if check and check != new_id:
            raise RuntimeError("Android ID did not change (old and new match)")
        return {"ok": True, "oldAndroidId": old, "androidId": new_id}

    def _forceAndroidIdRebooted(self, serial: str) -> dict:
        """Direct file edit + reboot, for providers that silently drop `settings put`.

        The id on such builds lives in
        /data/system/users/0/settings_secure.xml and the SettingsProvider only
        reloads that file at boot, so the reboot is part of the operation
        rather than a follow-up the caller must remember. Always verified by
        a re-read once the device is back: a write that did not take must
        never be reported as a success.
        """
        adb = _find_adb()
        r = self.forceAndroidId(serial)
        self._drop_ssaid_cache(adb, serial)
        if r.get("needsReboot"):
            self.rebootDevice(serial)
            self.waitForDevice(serial, 180)
            time.sleep(5)  # let SettingsProvider finish coming up
        check = ""
        try:
            check = self.readAndroidId(serial).get("androidId", "")
        except RuntimeError:
            check = ""
        if not check or check != r.get("androidId"):
            raise RuntimeError(
                "settings_secure.xml was written but the id still reads "
                + (check or "<unreadable>")
                + " after reboot"
            )
        return {
            "ok": True,
            "oldAndroidId": r.get("oldAndroidId", ""),
            "androidId": r["androidId"],
            "rebooted": bool(r.get("needsReboot")),
        }

    def _drop_ssaid_cache(self, adb: str, serial: str) -> None:
        """Delete the per-app SSAID store so no stale mapping survives.

        Since Android 8 each app's SSAID is derived from the device Android
        ID and cached in settings_ssaid.xml. After an ID change the stale
        file would keep serving the OLD derived id — removing it forces a
        recompute. Best-effort: never fails the caller.
        """
        for base in ("/data/system/users/0", "/data/system/users/10"):
            try:
                _run_adb(
                    adb,
                    ["-s", serial, "shell", f"su -c 'rm -f \"{base}/settings_ssaid.xml\"'"],
                    timeout=15,
                )
            except Exception:  # noqa: BLE001
                continue

    # Fresh-start device identity, part 2: the Google Services (GSF) Android
    # ID. This is a DIFFERENT 16-hex id from Settings.Secure (gservices.db),
    # and Play SDKs key on it — resetting only Settings.Secure leaves the
    # GSF id behind, so the server re-links the "new" city to the ban.
    # Deleting the databases forces GMS to mint fresh ids on next sync.
    _GSF_DB_CANDIDATES = (
        "/data/data/com.google.android.gsf/databases/gservices.db",
        "/data/user/0/com.google.android.gsf/databases/gservices.db",
    )

    def _gsf_db_path(self, adb: str, serial: str) -> str | None:
        for remote in self._GSF_DB_CANDIDATES:
            code, out, _ = _run_adb(
                adb, ["-s", serial, "shell", f"su -c 'ls \"{remote}\"'"], timeout=15
            )
            if code == 0 and out.strip():
                return remote
        return None

    def readGsfId(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        remote = self._gsf_db_path(adb, serial)
        if not remote:
            return {"ok": False, "reason": "gservices.db not found"}
        buf = self._pull_privileged(adb, serial, remote)
        if not buf:
            return {"ok": False, "reason": "could not read " + remote}
        try:
            import sqlite3

            with tempfile.TemporaryDirectory() as td:
                local = Path(td) / "gservices.db"
                local.write_bytes(buf)
                con = sqlite3.connect(f"file:{local}?mode=ro", uri=True)
                try:
                    row = con.execute(
                        "SELECT value FROM main WHERE name='android_id' LIMIT 1"
                    ).fetchone()
                finally:
                    con.close()
            val = str((row or [None])[0] or "").strip().lower()
            if re.fullmatch(r"[0-9a-f]{16}", val or ""):
                return {"ok": True, "gsfId": val, "file": remote}
            return {"ok": False, "reason": "no android_id row in gservices.db"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "reason": "gservices.db unreadable: " + str(e)[:80]}

    def resetGsfId(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        deleted: list[str] = []
        errs: list[str] = []
        for base in (
            "/data/data/com.google.android.gsf/databases",
            "/data/user/0/com.google.android.gsf/databases",
        ):
            for name in ("gservices.db", "gservices.db-shm", "gservices.db-wal", "checkin.db", "checkin.db-shm", "checkin.db-wal"):
                remote = f"{base}/{name}"
                code, _, _ = _run_adb(
                    adb, ["-s", serial, "shell", f"su -c 'rm -f \"{remote}\"'"], timeout=15
                )
                if code != 0:
                    continue
                code2, out2, _ = _run_adb(
                    adb, ["-s", serial, "shell", f"su -c 'ls \"{remote}\"'"], timeout=15
                )
                if code2 == 0 and out2.strip():
                    errs.append(f"{name}: still present")
                else:
                    deleted.append(remote)
        if not deleted:
            return {"ok": False, "deleted": [], "error": " | ".join(errs) or "GSF databases not found"}
        return {"ok": True, "deleted": deleted, "error": " | ".join(errs)}

    def nukeSecureSettings(self, serial: str) -> dict:
        """Move settings_secure.xml aside so the OS regenerates device ids.

        Last resort for emulators whose settings provider silently drops
        `settings put` writes (put "succeeds", re-read shows the old id).
        The file is RENAMED (not deleted) and a reboot is required for the
        fresh id to mint — call rebootDevice right after.
        """
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        moved: list[str] = []
        for base in ("/data/system/users/0", "/data/system/users/10"):
            src = f"{base}/settings_secure.xml"
            dst = f"{base}/settings_secure.xml.iggbak"
            code, out, _ = _run_adb(
                adb, ["-s", serial, "shell", f"su -c 'ls \"{src}\"'"], timeout=15
            )
            if code != 0 or not out.strip():
                continue
            code2, out2, err2 = _run_adb(
                adb, ["-s", serial, "shell", f"su -c 'mv \"{src}\" \"{dst}\"'"], timeout=15
            )
            combined = (out2 + err2).decode("utf-8", "replace").strip()
            if code2 != 0 or re.search(r"permission denied|failed|error:", combined, re.I):
                return {"ok": False, "error": f"cannot move {src}: {combined or 'su failed'}"}
            moved.append(src)
        if not moved:
            return {"ok": False, "error": "settings_secure.xml not found"}
        return {"ok": True, "moved": moved}

    def rebootDevice(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        code, out, err = _run_adb(adb, ["-s", serial, "reboot"], timeout=20)
        combined = (out + err).decode("utf-8", "replace").strip().lower()
        if code == 0:
            return {"ok": True}
        # The device drops the connection the moment it reboots, so a
        # timeout/closed/offline verdict IS the success signal — the reboot
        # is already underway. Only hard errors (unauthorized, denied)
        # mean it never started.
        if (
            code == 124
            or "timed out" in combined
            or "closed" in combined
            or "device offline" in combined
            or "no devices" in combined
            or "not found" in combined
            or not combined
        ):
            return {"ok": True, "rebooting": True}
        raise RuntimeError("reboot failed: " + (combined or f"exit {code}"))

    def waitForDevice(self, serial: str, timeout: int = 180) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        try:
            timeout = max(30, min(600, int(timeout)))
        except (TypeError, ValueError):
            timeout = 180
        code, out, err = _run_adb(adb, ["-s", serial, "wait-for-device"], timeout=timeout)
        combined = (out + err).decode("utf-8", "replace").strip()
        if code != 0:
            raise RuntimeError("device did not come back online: " + (combined or "adb timed out"))
        return {"ok": True}

    # Fresh-start device identity, part 3: direct file edit with root.
    # Some emulator builds silently ignore `settings put` (put "succeeds",
    # re-read shows the old id). With root confirmed, editing
    # settings_secure.xml itself cannot be ignored — but the provider only
    # picks it up on boot, so callers must rebootDevice right after.
    _SECURE_XML_CANDIDATES = (
        "/data/system/users/0/settings_secure.xml",
        "/data/system/users/10/settings_secure.xml",
    )

    def forceAndroidId(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        try:
            old = self.readAndroidId(serial).get("androidId", "")
        except RuntimeError:
            old = ""
        for _ in range(5):
            new_id = secrets.token_hex(8)
            if new_id != old:
                break
        target: str | None = None
        original = ""
        for remote in self._SECURE_XML_CANDIDATES:
            code, out, _ = _run_adb(
                adb, ["-s", serial, "shell", f"su -c 'cat \"{remote}\"'"], timeout=15
            )
            if code == 0 and "android_id" in out.decode("utf-8", "replace"):
                target = remote
                original = out.decode("utf-8", "replace")
                break
        if not target:
            raise RuntimeError("settings_secure.xml not readable (need root)")
        updated, n = _rewrite_secure_android_id(original, new_id)
        if n == 0:
            raise RuntimeError("android_id entry not found in settings_secure.xml")
        with tempfile.TemporaryDirectory() as td:
            local = Path(td) / "settings_secure.xml"
            local.write_text(updated, encoding="utf-8")
            tmp = "/data/local/tmp/igg_secure.xml"
            code, _, err = _run_adb(adb, ["-s", serial, "push", str(local), tmp], timeout=30)
            if code != 0:
                raise RuntimeError("adb push failed: " + err.decode("utf-8", "replace").strip())
            shell = f"su -c 'cp \"{tmp}\" \"{target}\" && chmod 600 \"{target}\"'"
            code2, out2, err2 = _run_adb(adb, ["-s", serial, "shell", shell], timeout=30)
            combined = (out2 + err2).decode("utf-8", "replace").strip()
            if code2 != 0 or re.search(r"permission denied|failed|error:", combined, re.I):
                raise RuntimeError("could not write settings_secure.xml: " + (combined or "su failed"))
            code3, out3, _ = _run_adb(
                adb, ["-s", serial, "shell", f"su -c 'grep android_id \"{target}\"'"], timeout=15
            )
            if new_id not in out3.decode("utf-8", "replace"):
                raise RuntimeError("settings file did not take the new id")
        return {"ok": True, "oldAndroidId": old, "androidId": new_id, "needsReboot": True}

    # Fresh-start device identity, part 4: evict Google service state.
    # GMS holds the advertising id, checkin identity and signed-in accounts;
    # clearing its packages signs the emulator out and forces fresh GSF/ad
    # ids on next sync. Safe on a Township burner emulator; Play Store simply
    # asks to sign in again.
    def clearGms(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        cleared: list[str] = []
        skipped: list[str] = []
        errs: list[str] = []
        # Play Games signs back in silently and restores cloud saves, so it
        # goes too — otherwise the banned city returns by itself.
        for pkg in (
            "com.google.android.gms",
            "com.google.android.gsf",
            "com.google.android.play.games",
        ):
            if not self._is_pkg_installed(adb, serial, pkg):
                skipped.append(pkg)
                continue
            _run_adb(adb, ["-s", serial, "shell", "am", "force-stop", pkg], timeout=10)
            code, out, err = _run_adb(adb, ["-s", serial, "shell", "pm", "clear", pkg], timeout=60)
            combined = (out + err).decode("utf-8", "replace").strip()
            if code == 0 and "success" in combined.lower():
                cleared.append(pkg)
            else:
                errs.append(f"{pkg}: " + (combined or f"exit {code}"))
        if not cleared:
            return {"ok": False, "cleared": [], "skipped": skipped, "error": " | ".join(errs) or "GMS packages not found"}
        out_dict: dict = {"ok": True, "cleared": cleared, "skipped": skipped}
        if errs:
            out_dict["error"] = " | ".join(errs)
        return out_dict

    # Fresh-start ("New Account") one-shot wipe: force-stop + `pm clear`.
    # PackageManager deletes the app's ENTIRE internal tree (saves, prefs,
    # databases, cache) atomically — no per-file enumeration that can miss a
    # directory or choke on a journal file. External app storage is removed
    # explicitly afterwards (belt and suspenders).
    def pmClear(self, serial: str) -> dict:
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        errs: list[str] = []
        for pkg in self._pkgs_for(serial):
            if not self._is_pkg_installed(adb, serial, pkg):
                errs.append(f"{pkg}: package not installed")
                continue
            code, _, err = _run_adb(
                adb, ["-s", serial, "shell", "am", "force-stop", pkg], timeout=10
            )
            if code != 0:
                errs.append(f"{pkg}: force-stop failed: " + err.decode("utf-8", "replace").strip())
                continue
            code, out, err = _run_adb(
                adb, ["-s", serial, "shell", "pm", "clear", pkg], timeout=60
            )
            combined = (out + err).decode("utf-8", "replace").strip()
            if code != 0 or "success" not in combined.lower():
                errs.append(f"{pkg}: pm clear failed: " + (combined or f"exit {code}"))
                continue
            # External app storage can survive `pm clear` on some builds.
            sdcard: list[str] = []
            for shell in (
                f"rm -rf \"/sdcard/Android/data/{pkg}/files\"",
                f"su -c 'rm -rf \"/sdcard/Android/data/{pkg}/files\"'",
            ):
                code3, _, _ = _run_adb(adb, ["-s", serial, "shell", shell], timeout=30)
                if code3 == 0:
                    break
            else:
                sdcard.append("external storage not confirmed")
            _active_package[serial] = pkg
            _PATH_CACHE.pop((serial, pkg, SAVE_FILE), None)
            _PATH_CACHE.pop((serial, pkg, LOCAL_INFO_FILE), None)
            out_dict: dict = {"ok": True, "package": pkg, "serial": serial}
            if sdcard:
                out_dict["sdcard"] = " | ".join(sdcard)
            return out_dict
        raise RuntimeError("pm clear failed — " + (" | ".join(errs) or "no package worked"))

    def reinstallTownship(self, serial: str) -> dict:
        """Nuclear wipe: back up the APK, uninstall, reinstall from backup.

        Uninstall removes EVERYTHING the package owns — internal tree,
        external storage, code cache — deeper than `pm clear`, and needs no
        root. After reinstall the game has no files at all, so whatever it
        shows next either is a genuinely fresh city or came back over the
        network (cloud/account restore), which no local wipe can prevent.
        """
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        pkg: str | None = None
        for cand in self._pkgs_for(serial):
            if self._is_pkg_installed(adb, serial, cand):
                pkg = cand
                break
        if not pkg:
            raise RuntimeError("Township package not installed on " + serial)
        code, out, err = _run_adb(adb, ["-s", serial, "shell", "pm", "path", pkg], timeout=15)
        remotes = re.findall(rb"package:(/\S+\.apk)", out)
        if code != 0 or not remotes:
            raise RuntimeError(
                "could not locate base APK for " + pkg + ": " + err.decode("utf-8", "replace").strip()
            )
        with tempfile.TemporaryDirectory() as td:
            locals_: list[str] = []
            total = 0
            for i, remote in enumerate(remotes):
                local = str(Path(td) / f"base{i}.apk")
                code2, _, err2 = _run_adb(
                    adb, ["-s", serial, "pull", remote.decode("utf-8", "replace"), local], timeout=180
                )
                if code2 != 0 or not Path(local).exists():
                    raise RuntimeError(
                        "APK backup failed: " + err2.decode("utf-8", "replace").strip()
                    )
                total += Path(local).stat().st_size
                locals_.append(local)
            _run_adb(adb, ["-s", serial, "shell", "am", "force-stop", pkg], timeout=10)
            code3, out3, err3 = _run_adb(adb, ["-s", serial, "uninstall", pkg], timeout=120)
            combined = (out3 + err3).decode("utf-8", "replace").strip()
            if code3 != 0 or "success" not in combined.lower():
                raise RuntimeError("uninstall failed: " + (combined or f"exit {code3}"))
            if len(locals_) > 1:
                code4, out4, err4 = _run_adb(
                    adb, ["-s", serial, "install-multiple", *locals_], timeout=300
                )
            else:
                code4, out4, err4 = _run_adb(
                    adb, ["-s", serial, "install", "-r", locals_[0]], timeout=300
                )
            combined4 = (out4 + err4).decode("utf-8", "replace").strip()
            if code4 != 0 or "success" not in combined4.lower():
                raise RuntimeError(
                    "reinstall failed (APK backup kept in temp, game currently uninstalled): "
                    + (combined4 or f"exit {code4}")
                )
            if not self._is_pkg_installed(adb, serial, pkg):
                raise RuntimeError("reinstall reported success but package is missing")
        _active_package[serial] = pkg
        _PATH_CACHE.pop((serial, pkg, SAVE_FILE), None)
        _PATH_CACHE.pop((serial, pkg, LOCAL_INFO_FILE), None)
        return {"ok": True, "package": pkg, "serial": serial, "apkCount": len(remotes), "apkBytes": total}

    def _freshProfileDir(self) -> Path:
        """Locate the bundled fresh-city profile (frozen EXE or source tree)."""
        roots: list[Path] = []
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            roots.append(Path(meipass))
        roots.append(Path(__file__).resolve().parent)
        for root in roots:
            d = root / FRESH_PROFILE_DIR
            if (d / FRESH_LOCAL_PROFILE).is_file() and (d / FRESH_SAVE_PROFILE).is_file():
                return d
        raise RuntimeError(
            "fresh profile missing from install (fresh_profile/"
            f"{FRESH_LOCAL_PROFILE} + {FRESH_SAVE_PROFILE})"
        )

    def injectFreshProfile(self, serial: str) -> dict:
        """Hand the game a complete ready-made city (TS-Lite-style Level 1).

        Wiping alone can never work: once the device has no save at all the
        game asks Playrix "which city belongs to this device?", and the server
        re-links the same old city from its device fingerprint — that is why a
        proven-empty wipe still comes back as the old city. TS-Lite never lets
        that request happen: it force-stops the game and copies a complete
        LocalInfo + mGameInfo pair into the saves folder, so the game loads
        the provided city instead of minting or restoring one.

        Runs the competitor's script command-for-command, in its own order:
        `setenforce 0` → `rm -rf <saves>/*` → `mkdir -p` → `cp -af` both
        files → `chmod 777` → `restorecon -vR` → `setenforce 1` → its
        `[ -f ]` SUCCESS/FAILURE probe. Both of the first two steps were
        missing from the earlier attempt: SELinux must be relaxed while the
        root-owned files land, and the whole saves folder must be cleared —
        one stale file left behind is enough for the game to fall back to
        the old city. `wc -c` stays as our extra gate (SUCCESS only proves
        the files exist), so a partial copy can never be reported as
        success.
        """
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        pkg = self._active_pkg(adb, serial)
        if not pkg:
            raise RuntimeError("Township package not installed on " + serial)
        profile = self._freshProfileDir()
        src_local = profile / FRESH_LOCAL_PROFILE
        src_save = profile / FRESH_SAVE_PROFILE
        want: dict[str, int] = {
            "local": src_local.stat().st_size,
            "save": src_save.stat().st_size,
        }
        stopped = self.forceStop(serial)
        if not stopped.get("ok"):
            raise RuntimeError("could not stop the game first: " + str(stopped.get("error")))
        # Most specific target first: wherever the real save was found, then
        # the conventional candidates (layouts differ between builds).
        dirs: list[str] = []
        for fname in (SAVE_FILE, "LocalInfo.xml", LOCAL_INFO_FILE):
            found = _find_on_device(adb, serial, pkg, fname)
            if found:
                parent = found.rsplit("/", 1)[0]
                if parent not in dirs:
                    dirs.append(parent)
        for base in (f"/data/data/{pkg}", f"/data/user/0/{pkg}", f"/data/user_de/0/{pkg}"):
            for sub in ("saves", "files"):
                d = f"{base}/{sub}"
                if d not in dirs:
                    dirs.append(d)
        # Stage the profile where root can copy it from (adb push can only
        # reach /data/local/tmp without root).
        tmp_l = "/data/local/tmp/igg_fresh_localinfo"
        tmp_s = "/data/local/tmp/igg_fresh_mgameinfo"
        for src, tmp in ((src_local, tmp_l), (src_save, tmp_s)):
            code, _, err = _run_adb(adb, ["-s", serial, "push", str(src), tmp], timeout=90)
            if code != 0:
                raise RuntimeError("adb push failed: " + err.decode("utf-8", "replace").strip())
        attempts: list[str] = []
        # The competitor's script, reproduced command-for-command (its native
        # nativeGetBackupScript builds exactly this, in this order):
        #   setenforce 0 ; rm -rf <DIR>/* ; mkdir -p <DIR> ;
        #   cp -af L1 <DIR>/LocalInfo.xml && cp -af M1 <DIR>/mGameInfo.xml &&
        #   chmod 777 ... && restorecon -vR <DIR> ; setenforce 1 ;
        #   [ -f ... ] && [ -f ... ] && echo SUCCESS || echo FAILURE
        for d in dirs:
            ds = d.rstrip("/") + "/"
            script = (
                "setenforce 0 ; "
                f'rm -rf "{ds}"* ; '
                f'mkdir -p "{d}" ; '
                f'cp -af "{tmp_l}" "{ds}LocalInfo.xml" && '
                f'cp -af "{tmp_s}" "{ds}mGameInfo.xml" && '
                f'chmod 777 "{ds}LocalInfo.xml" && '
                f'chmod 777 "{ds}mGameInfo.xml" && '
                f'restorecon -vR "{d}" ; '
                "setenforce 1 ; "
                f'[ -f "{ds}LocalInfo.xml" ] && [ -f "{ds}mGameInfo.xml" ] '
                '&& echo "SUCCESS" || echo "FAILURE" ; '
                f'wc -c "{ds}LocalInfo.xml" "{ds}mGameInfo.xml"'
            )
            # su -mm -c first: mount-master mode, what the competitor runs;
            # plain su -c is the fallback for su builds that reject -mm.
            for wrap in ("su -mm -c ", "su -c "):
                shell = wrap + '"' + script.replace('"', '\\"') + '"'
                code, out, err = _run_adb(adb, ["-s", serial, "shell", shell], timeout=60)
                combined = (out + err).decode("utf-8", "replace")
                if code != 0:
                    attempts.append(
                        f"{d}: {wrap.strip()} exit {code} {combined.strip()[:180]}"
                    )
                    continue
                if "FAILURE" in combined or "SUCCESS" not in combined:
                    attempts.append(f"{d}: {combined.strip()[:220] or 'no output'}")
                    continue
                # SUCCESS only proves existence — prove the exact sizes too.
                verdict: dict[str, int] = {}
                ok = True
                for fname, size in (
                    ("LocalInfo.xml", want["local"]),
                    ("mGameInfo.xml", want["save"]),
                ):
                    m = re.search(
                        r"(?m)^(\d+)\s+\S*" + re.escape(fname) + r"\s*$", combined
                    )
                    got = int(m.group(1)) if m else -1
                    verdict[fname] = got
                    if got != size:
                        ok = False
                if ok:
                    _active_package[serial] = pkg
                    _PATH_CACHE.pop((serial, pkg, SAVE_FILE), None)
                    _PATH_CACHE.pop((serial, pkg, LOCAL_INFO_FILE), None)
                    return {
                        "ok": True,
                        "package": pkg,
                        "dir": d,
                        "sizes": want,
                        "verified": verdict,
                    }
                attempts.append(f"{d}: verification mismatch {verdict} (want {want})")
        raise RuntimeError(
            "fresh profile injection failed — "
            + (" | ".join(attempts)[:600] or "no writable saves folder")
        )

    def launchGame(self, serial: str) -> dict:
        """Start the game the way the competitor does after injecting: the
        standard LAUNCHER intent via `monkey` (no activity name needed), with
        a resolved `am start` as the fallback for builds without monkey.
        """
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        pkg = self._active_pkg(adb, serial)
        if not pkg:
            raise RuntimeError("Township package not installed on " + serial)
        errs: list[str] = []
        for args in (
            ["-s", serial, "shell",
             f"monkey -p {pkg} -c android.intent.category.LAUNCHER 1"],
            ["-s", serial, "shell",
             f'am start -n "$(cmd package resolve-activity --brief {pkg} '
             '| grep -m1 /)"'],
        ):
            code, out, err = _run_adb(adb, args, timeout=30)
            combined = (out + err).decode("utf-8", "replace").strip()
            if (
                code == 0
                and combined
                and not re.search(r"no activities found|error:", combined, re.I)
            ):
                return {"ok": True, "package": pkg, "output": combined[:300]}
            errs.append(combined[:200] or f"exit {code}")
        raise RuntimeError("could not launch the game — " + " | ".join(errs))

    def verifyWipe(self, serial: str) -> dict:
        """Prove the wipe: none of the save/login files may still exist.
        `pm clear` printing Success is trusted, but this closes the loop —
        if anything survived, the wipe is reported as incomplete instead of
        letting a stale city through to Verify.
        """
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        pkg: str | None = None
        for cand in self._pkgs_for(serial):
            if self._is_pkg_installed(adb, serial, cand):
                pkg = cand
                break
        if not pkg:
            raise RuntimeError("Township package not installed on " + serial)
        remaining: list[str] = []
        checked = 0
        for filename in (SAVE_FILE, SAVE_FILE[:-4] + ".bak", LOCAL_INFO_FILE):
            for base in (f"/data/data/{pkg}", f"/data/user/0/{pkg}"):
                for sub in ("saves", "files"):
                    remote = f"{base}/{sub}/{filename}"
                    checked += 1
                    code, out, _ = _run_adb(
                        adb, ["-s", serial, "shell", f"su -c 'ls \"{remote}\"'"], timeout=15
                    )
                    if code == 0 and out.strip():
                        remaining.append(remote)
        if remaining:
            return {"ok": False, "remaining": remaining, "checked": checked}
        return {"ok": True, "checked": checked}

    _FINGERPRINT_PROPS = (
        "ro.product.model",
        "ro.product.manufacturer",
        "ro.product.brand",
        "ro.product.device",
        "ro.build.fingerprint",
        "ro.build.version.release",
    )

    def deviceFingerprint(self, serial: str) -> dict:
        """Read-only hardware profile. No ADB command changes these values —
        they are pinned by the emulator instance itself. Shown so a MEmu
        clone (fresh fingerprint) can be told apart from the banned one.
        """
        adb = _find_adb()
        if not adb:
            raise RuntimeError("adb not found - connect an emulator first")
        props: dict[str, str] = {}
        for name in self._FINGERPRINT_PROPS:
            code, out, _ = _run_adb(adb, ["-s", serial, "shell", "getprop", name], timeout=10)
            if code == 0 and out.strip():
                props[name] = out.decode("utf-8", "replace").strip()
        return {"ok": True, "props": props}

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


