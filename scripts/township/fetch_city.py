#!/usr/bin/env python3
"""CLI FetchCity — prints JSON {ok, xml_b64} or {ok:false, error}."""
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


def fetch_city(target_city_id: str, bver: str, fver: str, city_ver: int = 0) -> bytes:
    json_body = {
        "cityId": "",
        "cityVer": city_ver,
        "fetchCityId": target_city_id,
        "important": True,
    }
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
    url = API_URL.format(endpoint="FetchCity") + "?cityId="
    req = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read()
        resp_ts_id = resp.headers.get("ts-id") or resp.headers.get("Ts-Id") or ""
        if not resp_ts_id:
            for k, v in resp.headers.items():
                if str(k).lower() == "ts-id":
                    resp_ts_id = v
                    break
    if not resp_ts_id:
        raise RuntimeError("Server response missing ts-id header")
    json_bytes = _decrypt_response(raw, resp_ts_id)
    json_obj = json.loads(json_bytes, strict=False)
    b64_data = (json_obj.get("result") or {}).get("data")
    if not b64_data:
        raise RuntimeError(f"FetchCity no data: {json_obj}")
    decoded = ts_decode_bytearray(bytearray(base64.b64decode(b64_data)), len(base64.b64decode(b64_data)))
    return bytes(ts_uncompress(decoded))


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: fetch_city.py cityId [bver] [fver]"}))
        sys.exit(1)
    city = sys.argv[1].strip()
    bver = sys.argv[2] if len(sys.argv) > 2 else ""
    fver = sys.argv[3] if len(sys.argv) > 3 else ""
    if not bver or not fver:
        print(json.dumps({"ok": False, "error": "missing game version/FVer; refresh LocalInfo first"}))
        sys.exit(2)
    try:
        xml = fetch_city(city, bver, fver)
        print(json.dumps({"ok": True, "xml_b64": base64.b64encode(xml).decode("ascii")}))
    except Exception as e:
        msg = str(e)
        if "HTTP 403" in msg:
            # 403 is metadata rejection, not a blocked host: older build versions
            # are refused outright. Say so, because "Forbidden" alone reads as a
            # network or account problem and sends people the wrong way.
            msg = (
                "FetchCity HTTP 403: Forbidden — the game build version was rejected. "
                "Refresh LocalInfo so the real version is used; if it is already current, "
                "this build is below the version the server still accepts."
            )
        print(json.dumps({"ok": False, "error": msg[:400]}))
        sys.exit(2)


if __name__ == "__main__":
    main()
