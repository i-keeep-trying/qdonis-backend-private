"""Captures qdonis-core `/api/simulate/sync_parameters` decks for value edits.

Run with the core venv from qdonis-backend:
  ..\\qdonis-core\\.venv\\Scripts\\python.exe test\\parity\\capture\\sync_capture.py
Writes test/parity/fixtures/sync/vectors.json.
"""
import contextlib, io, json, os, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "fixtures" / "sync" / "vectors.json"
CASES = [
    ("dcdc_buck", [("L1", "inductance", "22u"), ("Cout", "capacitance", "0.00022"), ("PWM", "duty_cycle", "0.45")]),
    ("dcdc_boost", [("L1", "inductance", "1e-4"), ("NOPE", "x", "1")]),
    ("dcdc_flyback", [("R_LOAD", "resistance", "8"), ("R_LOAD", "notes", "ignored")]),
    ("dcdc_synchronous_buck", [("PWM", "frequency", "200k")]),
]


def main() -> int:
    if os.environ.get("PYTHONHASHSEED") != "0":
        env = {**os.environ, "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.call([sys.executable, "-B", *sys.argv], env=env)
    core = HERE.parents[3] / "qdonis-core"
    sys.path.insert(0, str(core))
    import yaml
    from qdonis_backend.api_server import resolve_yaml_path
    from qdonis_backend.topology_improver import apply_parameter_updates_to_yaml
    from qdonis_backend.simulator.netlist_generator import generate_netlist

    vectors = []
    for topology, edits in CASES:
        with contextlib.redirect_stdout(io.StringIO()):
            with open(resolve_yaml_path(topology), "r", encoding="utf-8") as f:
                design = yaml.safe_load(f)
            updates = {}
            for ref, param, after in edits:
                updates.setdefault(ref, {})[param] = str(after)
            apply_parameter_updates_to_yaml(design, updates, None)
            netlist, dc, ac, tran = generate_netlist(design, analysis_filter=None)
        cirs = {}
        for key, ctrl in (("dc", dc), ("ac", ac), ("transient", tran)):
            if ctrl.strip():
                cirs[key] = (netlist + "\n" + ctrl).replace("\r\n", "\n").replace("\r", "\n")
        vectors.append({"topology": topology, "edits": [list(e) for e in edits], "analysis_cirs": cirs})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(vectors, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {len(vectors)} vectors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
