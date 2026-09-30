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
        TS_AES_KEY,
        _build_request_body,
        _decrypt_response,
        ts_decode_bytearray,
        ts_uncompress,
    )
except Exception as e:
    print(json.dumps({"ok": False, "error": f"import: {e}"}))
    sys.exit(1)


# Per-read socket stall guard. Deliberately large: a high-level city returns a
# much bigger payload than a small one, and neither the level, the city id nor
# the save size is a reason to refuse it.
FETCH_TIMEOUT_S = 300

# --pipe-decrypt: hand the encrypted response body to the caller instead of
# decrypting it here (see decrypt_response).
PIPE_FLAG = "--pipe-decrypt"


def decrypt_response(raw: bytes, ts_id: str, pipe: bool) -> bytes:
    """Return the response's gunzipped JSON envelope.

    The AES that opens the envelope is the single expensive step of the whole
    download - ~22 us per byte in the Python port, so 3.5 s for a 150 KB city
    and 17 s for a 750 KB one, where every other stage together costs under
    10 ms. On the server that is what made a large city outlive its deadline
    while a small one finished.

    So with `pipe` we hand the body over and let the caller decrypt it with the
    native AES it already has, then read the plaintext back from stdin. Same
    bytes either way: the keystream is standard GCM (J0 = iv || 1, data blocks
    from inc32(J0)), verified byte-for-byte against this file's own decryptor on
    two real responses and on round trips from 16 to 300,000 bytes.

    The key travels in that message rather than being repeated in the caller on
    purpose - TS_AES_KEY keeps exactly one home, so the two can never drift into
    decrypting with different keys.
    """
    if not pipe:
        return _decrypt_response(raw, ts_id)

    print(json.dumps({
        "stage": "decrypt",
        "ts_id": ts_id,
        "key_b64": base64.b64encode(TS_AES_KEY).decode("ascii"),
        "body_b64": base64.b64encode(raw).decode("ascii"),
    }), flush=True)
    return bytes(ts_uncompress(sys.stdin.buffer.read()))


def fetch_city(target_city_id: str, bver: str, fver: str, city_ver: int = 0,
               pipe: bool = False) -> bytes:
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
    # This is a *stall* guard, not a budget for the whole download: `urlopen`'s
    # timeout applies per socket read. A large city streams several hundred KB
    # and used to be cut off at 25 s on a slow link, so make it generous - the
    # caller owns the overall deadline (see FETCH_CITY_TIMEOUT_MS in
    # desban.server.ts).
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
    json_bytes = decrypt_response(raw, resp_ts_id, pipe)
    json_obj = json.loads(json_bytes, strict=False)
    b64_data = (json_obj.get("result") or {}).get("data")
    if not b64_data:
        raise RuntimeError(f"FetchCity no data: {json_obj}")
    decoded = ts_decode_bytearray(bytearray(base64.b64decode(b64_data)), len(base64.b64decode(b64_data)))
    return bytes(ts_uncompress(decoded))


def main() -> None:
    args = [a for a in sys.argv[1:] if a != PIPE_FLAG]
    pipe = PIPE_FLAG in sys.argv
    if len(args) < 1:
        print(json.dumps({"ok": False,
                          "error": "usage: fetch_city.py cityId [bver] [fver] [--pipe-decrypt]"}))
        sys.exit(1)
    city = args[0].strip()
    bver = args[1] if len(args) > 1 else ""
    fver = args[2] if len(args) > 2 else ""
    if not bver or not fver:
        print(json.dumps({"ok": False, "error": "missing game version/FVer; refresh LocalInfo first"}))
        sys.exit(2)
    try:
        xml = fetch_city(city, bver, fver, pipe=pipe)
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
