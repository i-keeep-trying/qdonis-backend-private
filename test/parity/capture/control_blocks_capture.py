"""Captures qdonis-core `simulator/control_blocks.py` output (Simulink-style blocks).

The blocks exist on qdonis-core `feature/synced-schematic` only, so point --core at a
checkout of that branch:
  python -B test\\parity\\capture\\control_blocks_capture.py --core D:\\path\\to\\qdonis-core
Writes test/parity/fixtures/control-blocks/cases.json (emit / describe / pins per case).
"""
import argparse, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "fixtures" / "control-blocks" / "cases.json"

# (ref, type, params): every type with its defaults, plus the parameter forms the library uses.
VARIANTS = [
    ("K_V", "gain", {"gain": 100.0}),
    ("K_P", "gain", {"gain": "1/V_PEAK"}),
    ("K_S", "gain", {"gain": "4.7u"}),
    ("K_X", "gain", {"gain": "bad'quote"}),
    ("K_M", "gain", {"gain": "2MEG"}),
    ("SUM3", "sum", {"signs": "+ - +"}),
    ("SUM0", "sum", {"signs": ""}),
    ("SUMN", "sum", {"signs": "-+"}),
    ("MULT", "product", {"gain": 0.003}),
    ("REF", "const", {"value": "V_TARGET"}),
    ("REF2", "const", {"value": 5}),
    ("I_SENSE", "function", {"expression": "I(VSENSE)", "inputs": 0}),
    ("FN2", "function", {"expression": "in1*in3+in2", "inputs": 1}),
    ("FNQ", "function", {"expression": "V(a)*'2'"}),
    ("LIM", "limiter", {"lower": "-5", "upper": "5k"}),
    ("CMP", "comparator", {"high": 5, "low": 0, "width": 1.0e-06}),
    ("CMPT", "comparator", {"high": 15, "low": -15, "threshold": 0.02}),
    ("LPF", "lowpass", {"tau": 4.7e-06, "ic": 2.5}),
    ("INT", "integrator", {"ki": 20, "ic": 1, "lower": 0, "upper": 80}),
    ("INTC", "integrator", {"ki": 5, "antiwindup": "conditional", "lower": -1, "upper": 1}),
    ("PI_C", "pi", {"kp": 1.0, "ki": 31415.9, "lower": 0.1, "upper": 4.8, "ic": 2.5}),
    ("PIC", "pi", {"kp": 0.3, "ki": 20, "antiwindup": "Conditional"}),
    ("PID1", "pid", {"kp": 2, "ki": 50, "kd": 1e-4, "tf": "10u"}),
    ("CAR", "carrier", {"frequency": "50k", "low": -1, "high": 1, "phase": -90}),
    ("SAW", "carrier", {"frequency": 20000, "shape": "sawtooth", "phase": 450}),
    ("CARZ", "carrier", {"frequency": 0}),
    ("PWM1", "pwm", {"frequency": 100000, "phase": 180, "carrier": "saw"}),
    ("DRV", "gate_driver", {"von": 12, "voff": -5, "rg": 0}),
    ("AND1", "and", {"high": 5}),
    ("XOR1", "xor", {"threshold": 2.5, "width": 0}),
    ("NOT1", "not", {"high": True}),
    ("OR1", "or", {"high": None}),
]


def nets_for(block_pins, ctype, params, ref):
    inputs, outputs = block_pins(ctype, params)
    return {pin: f"{ref}_{pin}".lower() for pin in inputs + outputs}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", required=True, help="qdonis-core checkout on feature/synced-schematic")
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(args.core).resolve()))
    from qdonis_backend.simulator import control_blocks as cb

    cases = [(f"D_{t.upper()}", t, {}) for t in cb.CONTROL_BLOCK_TYPES] + VARIANTS
    out = []
    for ref, ctype, params in cases:
        pins = cb.block_pins(ctype, params)
        record = {"ref": ref, "type": ctype, "params": params,
                  "pins": {"inputs": pins[0], "outputs": pins[1]},
                  "describe": cb.describe(ctype, params), "symbol_pins": cb.symbol_pins(ctype, params)}
        nets = nets_for(cb.block_pins, ctype, params, ref)
        record["nets"] = nets
        try:
            record["lines"] = cb.emit(ref, ctype, params, nets)
        except ValueError as error:
            record["error"] = str(error)
        out.append(record)
        if pins[0] + pins[1]:  # the same block with its first pin unconnected
            first = (pins[0] + pins[1])[0]
            try:
                cb.emit(ref, ctype, params, {**nets, first: ""})
            except ValueError as error:
                out.append({"ref": ref, "type": ctype, "params": params, "nets": {**nets, first: ""},
                            "error": str(error)})
    out.append({"defaults": cb.DEFAULTS, "labels": cb.CONTROL_BLOCK_TYPES, "glyphs": cb.GLYPHS})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {len(out)} records -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
