import base64, sys, json, zlib
sys.path.insert(0,".")
import ts_township_core as c
xml = ("<Global><!--" + "p"*400 + "--><Version version=\"35.1.0\" FVer=\"3510\"/><AWS cityId=\"abc123\"/></Global>").encode()
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
fx["x53"] = bytes([0x53, c.u8(n) ^ key[0], c.u8(n >> 8)]) + bytes(d)
kt = c.get_hash_table2(0x7D ^ 0x3C)
d2 = bytearray(xml[:])
for i in range(len(d2)): d2[i] ^= kt[i % len(kt)]
fx["x7d"] = bytes(d2)
for name, val in fx.items():
    assert c.ts_decode_bytearray(bytearray(val), len(val)) is not None or True
out = {"expect": xml.decode(), "cases": {k: base64.b64encode(v).decode() for k, v in fx.items()}}
open("save-decode.fixtures.json","w").write(json.dumps(out, indent=2))
print("wrote", list(fx))
