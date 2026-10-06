#!/usr/bin/env python3
"""Generic framed Township API caller — one JSON request on stdin, one JSON reply on stdout.

Mirrors `fetch_city.py`'s transport (same codec, same headers) but takes the
endpoint, the frame version headers, an optional `ts-token` and an arbitrary
JSON body, so any authenticated endpoint (SendBox, CheckCity, …) can be called
without growing a script per endpoint. The request travels on stdin rather
than argv so the account token never shows up in the process list.

stdin : {"endpoint":"SendBox","bver":"39.0.5","fver":"3900","token":"…",
         "query":"?cityId=XXXX","body":{…}}
stdout: {"ok":true,"status":200,"resp":{…}}
        {"ok":false,"status":403,"error":"Forbidden","body":"…"}
        {"ok":false,"error":"…"}
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from ts_township_core import API_URL, _build_request_body, _decrypt_response
except Exception as e:  # pragma: no cover — reported as JSON, never a traceback
    print(json.dumps({"ok": False, "error": f"import: {e}"}))
    sys.exit(1)

# Per-request socket stall guard (seconds). SendBox/CheckCity replies are tiny;
# this only exists to stop a dead socket from hanging the caller forever.
NET_TIMEOUT_S = 30


def _error_text(raw: bytes) -> str:
    """Pull the human part out of the game's plain-JSON error body."""
    try:
        j = json.loads(raw.decode("utf-8", "replace"), strict=False)
    except Exception:
        return ""
    err = j.get("error") if isinstance(j, dict) else None
    if isinstance(err, dict):
        return str(err.get("code") or err.get("message") or "")
    if isinstance(err, str):
        return err
    return ""


def main() -> None:
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception:
        print(json.dumps({"ok": False, "error": "stdin is not JSON"}))
        sys.exit(1)

    endpoint = str(req.get("endpoint") or "").strip()
    bver = str(req.get("bver") or "").strip()
    fver = str(req.get("fver") or "").strip()
    token = str(req.get("token") or "").strip()
    query = str(req.get("query") or "")
    body = req.get("body")

    if not endpoint or not bver or not fver:
        print(json.dumps({"ok": False, "error": "endpoint/bver/fver required"}))
        sys.exit(2)

    try:
        body_bytes, ts_id = _build_request_body(body if isinstance(body, dict) else {})
        headers = {
            "ts-bp": "i",
            "ts-bver": bver,
            "ts-fver": fver,
            "ts-gpid": "new",
            "ts-id": ts_id,
            "Content-Type": "application/octet-stream",
            "User-Agent": "python-requests/2.31.0",
            "Accept": "*/*",
            "Connection": "keep-alive",
        }
        if token:
            headers["ts-token"] = token

        url = API_URL.format(endpoint=endpoint) + query
        rq = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(rq, timeout=NET_TIMEOUT_S) as resp:
                status, raw, hdrs = resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as e:
            status, raw, hdrs = e.code, e.read(), e.headers

        if status == 200:
            ts = hdrs.get("ts-id") or ""
            if not ts:
                for k, v in hdrs.items():
                    if str(k).lower() == "ts-id":
                        ts = v
                        break
            if ts:
                # Framed reply: AES-CTR + gunzip, same envelope as FetchCity.
                plain = _decrypt_response(raw, ts)
                print(json.dumps({
                    "ok": True,
                    "status": status,
                    "resp": json.loads(plain, strict=False),
                }))
                return
            # Unframed plain JSON (some error shapes come back like this even
            # with HTTP 200); hand it through instead of inventing a failure.
            print(json.dumps({
                "ok": True,
                "status": status,
                "resp": json.loads(raw.decode("utf-8", "replace"), strict=False),
            }))
            return

        # Non-200: the game answers with plain JSON, e.g.
        # {"error":{"code":"Forbidden"}} (transient rate limit — retryable) or
        # {"error":"Wrong parameter"} (bad ts-token / tag — not retryable).
        msg = _error_text(raw)
        print(json.dumps({
            "ok": False,
            "status": status,
            "error": msg or f"HTTP {status}",
            "body": raw.decode("utf-8", "replace")[:300],
        }))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}))
        sys.exit(3)


if __name__ == "__main__":
    main()
