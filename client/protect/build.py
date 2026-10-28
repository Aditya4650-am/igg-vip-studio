#!/usr/bin/env python3
"""Build the protected client: Nuitka compile, then pack_exe.py encryption.

    python protect/build.py                 # full build -> dist/IGG VIP TOOL.exe
    python protect/build.py --skip-nuitka   # re-pack an already-built payload

Replaces the old PyInstaller step. PyInstaller stores recoverable Python
bytecode (`pyinstxtractor` + a decompiler gets the whole source back), which is
the opposite of what this repo now wants; Nuitka compiles the same code to
machine code and pack_exe.py then encrypts the result at rest.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pack_exe

HERE = Path(__file__).resolve().parent
CLIENT = HERE.parent
BUILD_DIR = CLIENT / "build" / "protect"
PAYLOAD = BUILD_DIR / "IGG VIP TOOL.exe"
DIST = CLIENT / "dist" / "IGG VIP TOOL.exe"

PRODUCT = "IGG VIP TOOL"
COMPANY = "IGG VIP"
DESCRIPTION = "IGG VIP TOOL - Desktop Client"


def client_version() -> str:
    """Read filevers=(1,1,27,0) out of PyInstaller-style version_info.txt."""
    text = (CLIENT / "version_info.txt").read_text(encoding="utf-8")
    m = re.search(r"filevers=\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)", text)
    if not m:
        return "1.0.0.0"
    return ".".join(m.groups())


def nuitka_cmd(version: str, gcc_for_loader: str | None) -> list[str]:
    cmd = [
        sys.executable, "-m", "nuitka",
        "--assume-yes-for-downloads",
        # Python 3.13+ cannot use Nuitka's MinGW toolchain (MSVC required
        # there); 3.12 — what CI pins — uses MinGW, which is also what packs
        # the loader, so both halves of the build share one compiler.
        *(["--mingw64"] if sys.version_info < (3, 13) else []),
        "--onefile",
        "--windows-console-mode=disable",
        f"--company-name={COMPANY}",
        f"--product-name={PRODUCT}",
        f"--file-description={DESCRIPTION}",
        f"--file-version={version}",
        f"--product-version={version}",
        f"--windows-icon-from-ico={CLIENT / 'icon.ico'}",
        # adb.exe and the two AdbWin*.dll files are binaries, and
        # `--include-data-dir` deliberately skips .exe/.dll as "code" (it would
        # have reported "No data files in directory" and shipped no adb at all).
        # --include-raw-dir copies a directory verbatim.
        "--include-raw-dir=" + str(CLIENT / "adb") + "=adb",
        "--include-data-dir=" + str(CLIENT / "fresh_profile") + "=fresh_profile",
        # Do NOT pass --include-package=webview: Nuitka's always-on pywebview
        # plugin decides `webview.platforms.*` itself (winforms/edgechromium/
        # win32 yes, gtk/qt/cocoa/android no) and a user decision for the whole
        # package is a fatal conflict with it. The backends are imported
        # statically in webview/guilib.py, so they are reached without help.
        f"--output-dir={BUILD_DIR}",
        "--remove-output",
        "--show-progress",
        "-o", PAYLOAD.name,
        str(CLIENT / "igg_client.py"),
    ]
    # PyInstaller listed these as hidden imports for the same reason.
    if _present("bottle"):
        cmd.insert(-1, "--include-module=bottle")
    if _present("proxy_tools"):
        cmd.insert(-1, "--include-module=proxy_tools")
    return cmd


def _present(mod: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError):
        return False


def run(cmd: list[str], what: str) -> None:
    print(f"\n=== {what}\n$ {' '.join(str(c) for c in cmd)}", flush=True)
    t0 = time.time()
    proc = subprocess.run([str(c) for c in cmd], cwd=CLIENT)
    if proc.returncode != 0:
        raise SystemExit(f"{what} failed (exit {proc.returncode})")
    print(f"=== {what} ok ({time.time() - t0:.0f}s)", flush=True)


def verify(output: Path) -> dict:
    """Launch the protected EXE and prove it still works after encryption.

    The windowed build has no console, so the client writes its self-test to
    the file named by `IGG_CLIENT_PROBE`. Everything asserted here is a
    property a user's first launch depends on: the loader decrypted and ran
    the payload, Nuitka's onefile extracted it, and the bundled `adb/` and
    `fresh_profile/` are reachable from where it now executes.
    """
    import json
    import os

    probe = BUILD_DIR / "probe.json"
    if probe.exists():
        probe.unlink()

    env = os.environ.copy()
    env["IGG_CLIENT_PROBE"] = str(probe)
    try:
        subprocess.run([str(output)], env=env, cwd=CLIENT, timeout=600, check=False)
    except subprocess.TimeoutExpired as exc:
        raise SystemExit("the protected EXE did not exit during self-test") from exc

    if not probe.is_file():
        raise SystemExit(
            "the protected EXE produced no self-test report — it failed before the "
            "client code ran (loader integrity check, decryption, or extraction)."
        )

    report = json.loads(probe.read_text(encoding="utf-8"))
    problems = []
    if report.get("error"):
        problems.append(f"error: {report['error']}")
    if not report.get("adb"):
        problems.append("bundled adb not found from the built EXE")
    if not report.get("fresh_profile"):
        problems.append("bundled fresh_profile not found from the built EXE")
    if not report.get("compiled"):
        problems.append("code is not compiled (Nuitka marker missing) — bytecode would be extractable")
    if problems:
        raise SystemExit("self-test FAILED:\n  - " + "\n  - ".join(problems))

    print("self-test ok:")
    for key in ("adb", "fresh_profile", "argv0", "roots"):
        print(f"  {key}: {report.get(key)}")
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skip-nuitka", action="store_true", help="pack the existing payload")
    ap.add_argument("--gcc", help="gcc for the loader (default: auto-detect)")
    ap.add_argument("--keep", action="store_true", help="keep the intermediate loader EXE")
    ap.add_argument("--no-verify", action="store_true", help="skip launching the built EXE")
    args = ap.parse_args(argv)

    version = client_version()
    print(f"{PRODUCT} {version}")

    if not args.skip_nuitka:
        BUILD_DIR.mkdir(parents=True, exist_ok=True)
        run(nuitka_cmd(version, args.gcc), "Nuitka compile")

    if not PAYLOAD.is_file():
        raise SystemExit(f"payload missing: {PAYLOAD}")

    run(
        [
            sys.executable,
            str(HERE / "pack_exe.py"),
            "--payload", str(PAYLOAD),
            "--output", str(DIST),
            *(["--gcc", args.gcc] if args.gcc else []),
            *(["--keep"] if args.keep else []),
        ],
        "Pack (AES-256-GCM + loader)",
    )

    if not args.no_verify:
        verify(DIST)

    out = DIST.read_bytes()
    print(f"\nDone. {DIST}")
    print(f"  sha256: {hashlib.sha256(out).hexdigest()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
