"""Capture qdonis-core netlist output as parity fixtures (no ngspice, no LLM).

For every topology in the core library this records, from
`simulator.generate_analysis_cirs` and `simulator.generate_netlist`:
the base netlist, the three control blocks and the self-contained
analysis decks (dc / ac / transient). Output:
test/parity/fixtures/netlist/<topology>.json

Run from the qdonis-backend root with the qdonis-core venv:
  & "..\\qdonis-core\\.venv\\Scripts\\python.exe" -B test\\parity\\capture\\netlist_capture.py
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND_ROOT = HERE.parents[2]
DEFAULT_CORE = BACKEND_ROOT.parent / "qdonis-core"
OUT_DIR = BACKEND_ROOT / "test" / "parity" / "fixtures" / "netlist"


def core_status(core: Path) -> str:
    return subprocess.run(
        ["git", "-C", str(core), "status", "--porcelain"],
        capture_output=True, text=True, check=True,
    ).stdout


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", default=str(DEFAULT_CORE))
    parser.add_argument("--only", nargs="*", help="topology ids to capture")
    args = parser.parse_args()
    core = Path(args.core).resolve()

    if os.environ.get("PYTHONHASHSEED") != "0":
        env = {**os.environ, "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.call([sys.executable, "-B", *sys.argv], env=env)

    sys.dont_write_bytecode = True
    sys.path.insert(0, str(core))
    before = core_status(core)

    from qdonis_backend.data_utils import list_builtin_topologies, resolve_yaml_path
    from qdonis_backend.simulator import generate_analysis_cirs
    from qdonis_backend.simulator import netlist_generator as ng

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ids = args.only or list_builtin_topologies()
    failures = 0
    for topology in ids:
        record: dict = {"topology": topology}
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                path = str(resolve_yaml_path(topology))
                # Exactly what /api/simulate/prepare returns.
                prepared = generate_analysis_cirs(path, "all")
                _, dc, ac, tran = ng.generate_netlist(ng.load_design(path), None)
            record.update(
                netlist=prepared["netlist"],
                controls={"dc": dc, "ac": ac, "transient": tran},
                analysis_cirs=prepared["analysis_cirs"],
            )
        except Exception as error:  # recorded, so the port must fail the same way
            failures += 1
            record["error"] = f"{type(error).__name__}: {error}"
        (OUT_DIR / f"{topology}.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
            encoding="utf-8", newline="\n",
        )

    if core_status(core) != before:
        print("qdonis-core working tree changed during capture", file=sys.stderr)
        return 1
    print(f"captured {len(ids)} topologies ({failures} with errors) -> {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
