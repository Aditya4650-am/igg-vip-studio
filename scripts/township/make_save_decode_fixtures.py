import base64, sys, json, zlib
sys.path.insert(0,".")
import ts_township_core as c
xml = ("<Global><!--" + "p"*400 + "--><Version version=\"35.1.0\" FVer=\"3510\"/><AWS cityId=\"abc123\"/></Global>").encode()

# The 0x53 fixture only proves the length mask is read correctly if the document
# length actually differs between the two candidate masks (tag 0x53 vs key byte
# 0x42). At most lengths they agree, so shrink the padding until they diverge.
def _wrong_mask_truncates(n):
    return ((n ^ 0x53) ^ 0x42) < n

if not _wrong_mask_truncates(len(xml)):
    for pad in range(399, 0, -1):
        cand = ("<Global><!--" + "p"*pad + "--><Version version=\"35.1.0\" FVer=\"3510\"/><AWS cityId=\"abc123\"/></Global>").encode()
        if _wrong_mask_truncates(len(cand)):
            xml = cand
            break
    assert _wrong_mask_truncates(len(xml)), "no padding yields a discriminating 0x53 fixture"
fx = {}
fx["plain"] = xml
co = zlib.compressobj(8, zlib.DEFLATED, 31, 8, zlib.Z_DEFAULT_STRATEGY)
fx["gzip"] = co.compress(xml) + co.flush()
fx["x79"] = bytes(c._encode_0x79(bytearray(xml[:])))
fx["x54"] = bytes(c._encode_x54(bytearray(xml[:]), encode_bytes=len(xml)))
key = c.get_hash_table2(66)
d = bytearray(xml[:]); n = len(d)
for i in range(n):
    d[i] ^= key[i % len(key)]
    if i > 0: d[i] = c.u8(d[i] + xml[i-1])
d[0] = c.u8(d[0] + 0x54)
fx["x53"] = bytes([0x53, c.u8(n) ^ 0x53, c.u8(n >> 8)]) + bytes(d)
kt = c.get_hash_table2(0x7D ^ 0x3C)
d2 = bytearray(xml[:])
for i in range(len(d2)): d2[i] ^= kt[i % len(kt)]
fx["x7d"] = bytes(d2)
# Every fixture must decode back to the source document through the reference
# decoder. This is what keeps the generator honest: an encoder that repeats a
# decoder's mistake would otherwise produce fixtures that agree with each other
# and pass while real device files fail.
for name, val in fx.items():
    got = bytes(c.ts_decode_bytearray(bytearray(val), len(val)))
    assert got == xml, f"{name}: reference decoder did not round-trip ({got[:40]!r})"

out = {"expect": xml.decode(), "cases": {k: base64.b64encode(v).decode() for k, v in fx.items()}}
open("save-decode.fixtures.json","w").write(json.dumps(out, indent=2))
print("wrote", list(fx))
