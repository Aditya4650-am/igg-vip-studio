#!/usr/bin/env python3
"""Build-time best effort: make `cryptography` importable for FetchCity.

Why this exists
---------------
The FetchCity response is decrypted with Playrix's AES-CTR. The hand-rolled port
of it in ts_township_core.py is correct but costs ~22 us per byte - 3.5 s for a
150 KB city and 17 s for a 750 KB one, which on a small instance is what pushed
a large city past the child-process deadline while a small one still finished.
`cryptography` produces the identical keystream in ~1 ms (measured byte-for-byte
against the port), so having it turns a large download from minutes into seconds.

This script is deliberately *never* a build requirement:

- it always exits 0, so a missing apt, a missing pip, a blocked network or a
  Python without the package can never fail the deploy;
- without it, fetch_city.py simply keeps using the port and the download is
  slower - the raised deadline in desban.server.ts still lets it finish;
- every attempt is echoed, because Render's build log is the only place the
  outcome of this can be seen.

Tried in order: Debian's python3-cryptography (lands in the system
dist-packages that the runtime interpreter reads), then pip in each of the
shapes a locked-down image might accept.
"""
from __future__ import annotations

import os
import subprocess
import sys

TAG = "[fast-aes]"
REQ = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "requirements.txt")


def have() -> bool:
    try:
        import cryptography  # noqa: F401
        return True
    except Exception:
        return False


def run(cmd: list, timeout: int = 600) -> int:
    print(f"{TAG} $ {' '.join(cmd)}", flush=True)
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except FileNotFoundError:
        print(f"{TAG}   not available", flush=True)
        return 127
    except Exception as e:  # never let a probe take the build down
        print(f"{TAG}   {type(e).__name__}: {e}", flush=True)
        return 1
    tail = "\n".join(x for x in ((p.stdout or ""), (p.stderr or "")) if x).strip()
    if tail:
        for line in tail.splitlines()[-12:]:
            print(f"{TAG}   {line}", flush=True)
    return p.returncode


def main() -> int:
    print(f"{TAG} python {sys.version.split()[0]} at {sys.executable}", flush=True)
    if have():
        print(f"{TAG} cryptography already importable - nothing to do", flush=True)
        return 0

    # Debian's package puts the module in /usr/lib/python3/dist-packages, which
    # the system interpreter reads - the most reliable destination here.
    if run(["apt-get", "update", "-qq"]) == 0:
        run(["apt-get", "install", "-y", "-qq", "python3-cryptography"])
    if have():
        print(f"{TAG} ok via apt", flush=True)
        return 0

    # pip in the shapes a PEP 668 "externally managed" image might accept.
    # ensurepip first: many runtime images ship python3 without python3-pip.
    run([sys.executable, "-m", "ensurepip", "--default-pip"])
    run([sys.executable, "-m", "pip", "install", "--only-binary=:all:", "-r", REQ])
    run([sys.executable, "-m", "pip", "install", "--only-binary=:all:",
         "--break-system-packages", "-r", REQ])
    run([sys.executable, "-m", "pip", "install", "--only-binary=:all:", "--user", "-r", REQ])

    if have():
        print(f"{TAG} ok via pip", flush=True)
    else:
        print(f"{TAG} UNAVAILABLE - FetchCity keeps the slow AES port; "
              f"downloads still work, they just take longer", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # last line of defence: this must never fail a build
        print(f"{TAG} {type(e).__name__}: {e}", flush=True)
        sys.exit(0)
