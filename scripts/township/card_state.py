#!/usr/bin/env python3
"""FetchCity read for the Cards tab delivery check — prints one JSON line.

Usage: card_state.py <cityId> <bver> <fver>
Output: {"ok": true, "xml_b64": "...", "updAt": <unix_sec>}
      | {"ok": false, "error": "..."}

Why this exists beside fetch_city.py: the card delivery check needs
`result.updAt` — the receiver's last save write — to tell a fresh snapshot
from a stale one (a stale save hides how many boxes are already waiting), and
fetch_city.py deliberately prints only the XML. Everything else is the same
FetchCity call desban.server.ts and the clone features already make: framed
body from ts_township_core, no token header, decoded with the shared codec.
Additive on purpose — fetch_city.py stays the clone/desban path untouched.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import urllib.request
    from ts_township_core import (
        API_URL,
        _build_request_body,
        _decrypt_response,
        ts_decode_bytearray,
        ts_uncompress,
    )
except Exception as e:
    print(json.dumps({"ok": False, "error": f"import: {e}"}))
    sys.exit(1)

# Per-read stall guard for the socket, same idea as fetch_city.py: a big city
# streams several hundred KB, so the guard must not cut off a healthy reply.
FETCH_TIMEOUT_S = 120


def main() -> None:
    if len(sys.argv) < 4:
        print(json.dumps({"ok": False, "error": "usage: card_state.py cityId bver fver"}))
        sys.exit(2)
    city = sys.argv[1].strip()
    bver = sys.argv[2]
    fver = sys.argv[3]
    if not city or not bver or not fver:
        print(json.dumps({"ok": False, "error": "missing cityId/game version; refresh LocalInfo first"}))
        sys.exit(2)

    json_body = {"cityId": "", "cityVer": 0, "fetchCityId": city, "important": True}
    body_bytes, ts_id = _build_request_body(json_body)
    headers = {
        "ts-bp": "i",
        "ts-bver": bver,
        "ts-fver": fver,
        "ts-gpid": "new",
        "ts-id": ts_id,
        "Content-Type": "application/octet-stream",
        "User-Agent": "python-requests/2.31.0",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
    }
    try:
        req = urllib.request.Request(
            API_URL.format(endpoint="FetchCity") + "?cityId=",
            data=body_bytes,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
            raw = resp.read()
            resp_ts_id = resp.headers.get("ts-id") or resp.headers.get("Ts-Id") or ""
            if not resp_ts_id:
                for k, v in resp.headers.items():
                    if str(k).lower() == "ts-id":
                        resp_ts_id = v
                        break
        if not resp_ts_id:
            raise RuntimeError("Server response missing ts-id header")
        plain = _decrypt_response(raw, resp_ts_id)
        obj = json.loads(plain, strict=False)
        result = obj.get("result") or {}
        b64 = result.get("data")
        if not b64:
            raise RuntimeError(f"FetchCity no data: {str(obj)[:200]}")
        packed = base64.b64decode(b64)
        xml = bytes(ts_uncompress(ts_decode_bytearray(bytearray(packed), len(packed))))
        try:
            upd = int(result.get("updAt") or 0)
        except Exception:
            upd = 0
        print(json.dumps({
            "ok": True,
            "xml_b64": base64.b64encode(xml).decode("ascii"),
            "updAt": upd,
        }))
    except Exception as e:
        msg = str(e)
        if "HTTP 403" in msg:
            # 403 is metadata rejection, not a blocked host: older build
            # versions are refused outright. Same wording fetch_city.py uses,
            # because "Forbidden" alone sends people the wrong way.
            msg = (
                "FetchCity HTTP 403: Forbidden — the game build version was rejected. "
                "Refresh LocalInfo so the real version is used; if it is already current, "
                "this build is below the version the server still accepts."
            )
        print(json.dumps({"ok": False, "error": msg[:400]}))
        sys.exit(2)


if __name__ == "__main__":
    main()
