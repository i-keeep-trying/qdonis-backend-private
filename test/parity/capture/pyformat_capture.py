"""Python number formatting / eval vectors for src/simulation/netlist/py*.ts.

Writes test/parity/fixtures/netlist-py/vectors.json. Deterministic (fixed seed).
Run: & "..\\qdonis-core\\.venv\\Scripts\\python.exe" -B test\\parity\\capture\\pyformat_capture.py
"""

import json
import math
import random
import struct
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "fixtures" / "netlist-py" / "vectors.json"

rng = random.Random(20261011)
values = [0.0, -0.0, 1.0, 0.5, 1.5, 2.5, 0.125, 1e-5, 1e-4, 0.0001234565, 999999.5, 1234565.0,
          1e16, 1e15, 123456789012.0, 5e-324, 1.7976931348623157e308, 0.1, 0.2, 0.3, 2.675,
          1e-10, 1e-12, 4.7e-5, 100e3, 1 / 3, 2 / 3, 1e21, 1e22, 9.999995, 0.0000099999995]
for _ in range(3000):
    kind = rng.random()
    if kind < 0.4:
        values.append(rng.uniform(-1e3, 1e3))
    elif kind < 0.7:
        values.append(10 ** rng.uniform(-15, 20) * rng.choice([1, -1]))
    elif kind < 0.85:
        values.append(round(rng.uniform(-1e6, 1e6), rng.randint(0, 8)))
    else:
        values.append(struct.unpack("<d", struct.pack("<Q", rng.getrandbits(64)))[0])
values = [v for v in values if math.isfinite(v)]

rows = []
for v in values:
    row = {"bits": struct.pack("<d", v).hex(), "g6": format(v, ".6g"), "repr": repr(v),
           "f1": format(v, ".1f"), "f3": format(v, ".3f")}
    if abs(v) < 1e15:
        row["round"] = str(round(v))
    rows.append(row)

exprs = ["1+2", "2*3", "7/2", "7//2", "-7//2", "7%3", "-7%3", "2**10", "2**-1", "2**0.5",
         "1e5*2", "12.0*0.95", "(1+2)*3", "-(3)", "+4", "log10(1000)", "log(10)", "log(8, 2)",
         "sqrt(2)", "sin(pi/6)", "cos(0)", "e", "pi*2", "1/3", "10/4", "5.5//2", "-5.5%2",
         "3*1e-6", "100e3/4", "0.8*15e-3", "1_000+1", "0x10+1", "2**3**2", "-2**2", "1.5e-3*2",
         "(2+3)*(4-1)/5", "1/(2*pi*1e3*1e-6)"]
evals = []
for x in exprs:
    try:
        evals.append({"expr": x, "str": str(eval(x, {"__builtins__": {}}, {"log10": math.log10, "log": math.log, "sin": math.sin, "cos": math.cos, "sqrt": math.sqrt, "pi": math.pi, "e": math.e}))})
    except Exception as error:
        evals.append({"expr": x, "error": type(error).__name__})

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"numbers": rows, "evals": evals}, indent=0) + "\n", encoding="utf-8", newline="\n")
print(f"{len(rows)} numbers, {len(evals)} expressions -> {OUT}")
