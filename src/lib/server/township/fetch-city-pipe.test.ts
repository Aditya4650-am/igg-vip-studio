import { strict as assert } from "node:assert";
import { createDecipheriv } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decryptResponseBody } from "./desban.server.ts";

/**
 * The handover half of FetchCity.
 *
 * `fetch_city.py --pipe-decrypt` stops after the HTTP transfer and asks its
 * caller to open the response envelope, because doing that in Python costs
 * ~22 us per byte - 3.5 s for a 150 KB city, 17 s for a 750 KB one, all by
 * itself more than the rest of the download put together, and the reason a
 * large city outlived the old 90 s deadline while a small one finished.
 *
 * So the two sides have to agree exactly: the helper's own encryptor produces
 * the ciphertext, and `decryptResponseBody` has to hand back the very plaintext
 * the Python decryptor would have. A disagreement here is not a slow download,
 * it is a garbled one - and a garbled save is exactly the "green tick that
 * changed nothing" this repo refuses to ship.
 *
 * The oracle is generated live by the Python reference rather than checked in,
 * so this cannot drift away from ts_township_core.py.
 */

const here = dirname(fileURLToPath(import.meta.url));
const coreDir = [
  join(process.cwd(), "scripts/township"),
  join(here, "../../../../scripts/township"),
  join(here, "../../../scripts/township"),
].find((p) => existsSync(join(p, "ts_township_core.py")));
assert.ok(coreDir, "ts_township_core.py not found");

const SIZES = [16, 1000, 8192, 70000];

const PY = `
import base64, json, sys
sys.path.insert(0, ${JSON.stringify(coreDir)})
from ts_township_core import TS_AES_KEY, ts_aes_decode, ts_aes_encode

rows = []
for idx, n in enumerate(${JSON.stringify(SIZES)}):
    plain = bytes(((k + 1) * (idx + 3)) % 256 for k in range(n))
    iv = bytes(((k + 1) * 7 + idx) % 256 for k in range(12))
    out, tag = bytearray(), bytearray()
    ts_aes_encode(key=TS_AES_KEY, iv=iv, in_body=plain, out_buff=out, out_dest=tag)
    ref, reftag = bytearray(), bytearray()
    ts_aes_decode(key=TS_AES_KEY, iv=iv, in_body=bytes(out), out_buff=ref, out_dest=reftag)
    rows.append({
        "n": n,
        "ts_id": "002" + iv.hex() + tag.hex(),
        "key_b64": base64.b64encode(TS_AES_KEY).decode("ascii"),
        "body_b64": base64.b64encode(bytes(out)).decode("ascii"),
        "plain_b64": base64.b64encode(plain).decode("ascii"),
        "port_matches": bytes(ref) == plain,
    })
print(json.dumps(rows))
`;

type Row = {
  n: number;
  ts_id: string;
  key_b64: string;
  body_b64: string;
  plain_b64: string;
  port_matches: boolean;
};

function oracle(): Row[] {
  const bins = [process.env.PYTHON_BIN, "python3", "python"].filter((b): b is string => Boolean(b));
  let last = "";
  for (const bin of bins) {
    const r = spawnSync(bin, ["-c", PY], { encoding: "utf8", timeout: 120_000 });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    if (r.status === 0) return JSON.parse(r.stdout) as Row[];
    last = `${bin} exited ${r.status}: ${String(r.stderr || r.error?.message).slice(0, 600)}`;
    break;
  }
  throw new Error(last || "no python interpreter available");
}

const rows = oracle();

test("the Python reference agrees with itself, or the oracle is worthless", () => {
  assert.equal(rows.length, SIZES.length, "the oracle dropped a size");
  for (const r of rows) {
    assert.equal(r.port_matches, true, `the Python decryptor could not read its own output at ${r.n} B`);
  }
});

test("Node opens exactly what the helper encrypted", () => {
  for (const r of rows) {
    const got = decryptResponseBody(r.body_b64, r.ts_id, r.key_b64);
    assert.equal(got.toString("base64"), r.plain_b64, `native AES-CTR disagreed with the port at ${r.n} B`);
    assert.equal(got.length, r.n, "CTR must not change the payload length");
  }
});

test("the counter really is iv || 2, not iv || 1", () => {
  // A construction that is subtly wrong (GCM's J0 is iv||1, the first *data*
  // block is inc32 of it) still returns a full-length buffer - so the check
  // above only means something if a neighbouring counter provably does not
  // reproduce the plaintext.
  const r = rows[0]!;
  const plain = Buffer.from(r.plain_b64, "base64");
  const key = Buffer.from(r.key_b64, "base64");
  const iv12 = Buffer.from(r.ts_id.slice(3, 27), "hex");

  for (const n0 of [1, 3]) {
    const ctr = Buffer.concat([iv12, Buffer.alloc(4)]);
    ctr.writeUInt32BE(n0, 12);
    const d = createDecipheriv("aes-128-ctr", key, ctr);
    const out = Buffer.concat([d.update(Buffer.from(r.body_b64, "base64")), d.final()]);
    assert.notEqual(out.toString("base64"), plain.toString("base64"), `n0=${n0} must not match`);
  }
});
