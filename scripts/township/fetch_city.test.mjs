import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * FetchCity download guards.
 *
 * Two things decide whether a *large* city downloads while a small one already
 * did, and neither is a limit on city level, city id or save size:
 *
 *   1. the AES that decrypts the response - the hand-rolled port costs ~22 us
 *      per byte (3.5 s at 150 KB, 17 s at 750 KB), which on the instance is what
 *      pushed a big city past the deadline. `_aes_ctr_decrypt` produces the same
 *      keystream in ~1 ms when `cryptography` is installed, and must agree with
 *      the port byte for byte or not be used at all.
 *   2. the two deadlines - a per-read socket stall guard in fetch_city.py and the
 *      child-process deadline in desban.server.ts. The latter used to be 90 s and
 *      killed exactly the cities the first point made slow, while a killed child
 *      closes with `code === null` and surfaced as a generic failure.
 *
 * The AES half needs a Python interpreter; the deadline half is plain source.
 */

const here = dirname(fileURLToPath(import.meta.url));
const proj = resolve(here, "../..");
const fetchCityPy = join(here, "fetch_city.py");
const desbanTs = join(proj, "src/lib/server/township/desban.server.ts");
const requirementsTxt = join(proj, "requirements.txt");

function runPython(code) {
  const bins = [process.env.PYTHON_BIN, "python3", "python"].filter(Boolean);
  let last = "";
  for (const bin of bins) {
    const r = spawnSync(bin, ["-c", code], { encoding: "utf8", timeout: 120_000 });
    if (r.error && r.error.code === "ENOENT") continue;
    if (r.status === 0) return r.stdout;
    last = `${bin} exited ${r.status}: ${String(r.stderr || r.error?.message).slice(0, 600)}`;
    break;
  }
  throw new Error(last || "no python interpreter available");
}

const PY = `
import json, sys
sys.path.insert(0, ${JSON.stringify(here.replaceAll("\\", "/"))})
from ts_township_core import (
    TS_AES_KEY,
    _aes_ctr_decrypt,
    _build_request_body,
    _decrypt_response,
    ts_aes_decode,
    ts_aes_decode_with_tsid,
    ts_aes_encode,
)

def enc(plain, iv):
    out, tag = bytearray(), bytearray()
    ts_aes_encode(key=TS_AES_KEY, iv=iv, in_body=plain, out_buff=out, out_dest=tag)
    return bytes(out), bytes(tag)

def ref_dec(body, iv):
    out, tag = bytearray(), bytearray()
    ts_aes_decode(key=TS_AES_KEY, iv=iv, in_body=body, out_buff=out, out_dest=tag)
    return bytes(out)

checks = []
for n in (16, 1000, 8192, 70000):
    plain = bytes((i * 7 + 13) % 256 for i in range(n))
    iv = bytes(range(12))
    cipher, tag = enc(plain, iv)
    ts_id = "002" + iv.hex() + tag.hex()
    via = bytes(ts_aes_decode_with_tsid(body=bytearray(cipher), ts_id=ts_id))
    checks.append({
        "n": n,
        "cipher_len": len(cipher),
        "roundtrip": via == plain,
        "fast_equals_reference": via == ref_dec(cipher, iv),
        "fast_available": _aes_ctr_decrypt(bytearray(cipher), bytearray(iv)) is not None,
    })

# The request the downloader builds is still encrypted by the reference port (its
# ts-id tag is a Playrix GHASH variant nothing else can produce) and must come
# back through the same decryptor the response takes.
payload = {"cityId": "", "fetchCityId": "FETCHTEST", "cityVer": 0, "important": True}
body, ts_id = _build_request_body(payload)
request_roundtrip = json.loads(_decrypt_response(bytes(body), ts_id)) == payload

try:
    import cryptography  # noqa: F401
    crypto_installed = True
except Exception:
    crypto_installed = False

print(json.dumps({
    "checks": checks,
    "request_roundtrip": request_roundtrip,
    "crypto_installed": crypto_installed,
}))
`;

test("the fast AES decrypt matches the port, or the port is used instead", () => {
  const r = JSON.parse(runPython(PY));
  assert.equal(r.request_roundtrip, true, "a built request must decrypt back to its own JSON");
  for (const c of r.checks) {
    assert.equal(c.cipher_len, c.n, "CTR must not change the payload length");
    assert.equal(c.roundtrip, true, `round trip failed at ${c.n} bytes`);
    assert.equal(
      c.fast_equals_reference,
      true,
      `the fast AES path disagreed with the port at ${c.n} bytes (fast_available=${c.fast_available})`,
    );
  }
  // Otherwise the comparison above only proves the fallback, which is trivially
  // true - and a download that silently falls back is a slow one again.
  if (r.crypto_installed) {
    for (const c of r.checks) {
      assert.equal(
        c.fast_available,
        true,
        `cryptography is installed but the fast path was skipped at ${c.n} bytes`,
      );
    }
  }
});

test("FetchCity has no deadline small enough to cut off a large city", () => {
  const py = readFileSync(fetchCityPy, "utf8");
  const ts = readFileSync(desbanTs, "utf8");

  // Per-read socket stall guard in the downloader itself.
  const socket = Number(/FETCH_TIMEOUT_S\s*=\s*(\d+)/.exec(py)?.[1]);
  assert.ok(socket >= 300, `fetch_city.py socket timeout regressed to ${socket}s`);

  // Overall child deadline: this is what killed the big cities at 90 s.
  const child = Number(/FETCH_CITY_TIMEOUT_MS\s*=\s*([\d_]+)/.exec(ts)?.[1]?.replaceAll("_", ""));
  assert.ok(child >= 300_000, `fetchCityXml deadline regressed to ${child}ms`);
  assert.ok(!ts.includes("timeout: 90000"), "the old 90 s spawn cap is back");

  // A killed child closes with `code === null`, so it has to say it timed out
  // rather than fall through to the generic "FetchCity thất bại".
  assert.ok(ts.includes("timedOut"), "fetchCityXml no longer tracks its own kill");
  assert.ok(
    ts.includes("máy chủ game phản hồi quá lâu"),
    "a timed-out download is no longer reported as a timeout",
  );

  // The instance has to be given the fast backend, not merely told about it.
  assert.match(
    readFileSync(requirementsTxt, "utf8"),
    /^cryptography[^\n]*$/m,
    "requirements.txt no longer asks for cryptography; the download falls back to the slow port",
  );
});
