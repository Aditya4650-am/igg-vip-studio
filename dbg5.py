import re

m = open("src/lib/game-icon-map.ts", encoding="utf-8").read()
i = m.find("SmallWaterfall")
print(repr(m[i - 80:i + 80]))
i2 = m.find("beauty_swing_giraffe")
print("swing label present:", i2 != -1)
