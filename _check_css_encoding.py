from pathlib import Path

path = Path(r"C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server\src\styles.css")
data = path.read_bytes()
print("bytes=", len(data))
print("start=", data[:24])
text = data.decode("utf-8")
for code in (0xC3, 0xE2, 0xF0, 0xC2, 0xEF, 0x80, 0xFFFD):
    print(hex(code), text.count(chr(code)))
for lineno, line in enumerate(text.splitlines(), start=1):
    if "feature-tab:nth-of-type" in line or "sidebar-device-block > .kicker" in line or "sidebar-tools > .kicker" in line:
        print(lineno, repr(line))
try:
    raw = text.encode("cp1252")
    print("cp1252-bytes=", len(raw), raw[:24])
    fixed = raw.decode("utf-8")
    print("roundtrip-identical=", fixed == text)
    print("fixed-sample=", repr(fixed[1000:1180]))
except Exception as exc:
    print("roundtrip-error=", type(exc).__name__, str(exc)[:300])
