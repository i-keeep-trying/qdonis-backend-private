"""Capture qdonis-core simulation results (the /api/simulate/rerun pipeline).

For each library topology: generate the decks (`generate_analysis_cirs`),
run them through `NgspiceMeasurePlotter.execute_and_process` exactly as
`_run_rerun_simulation` does (skip_plots=False is replaced by True: the PNG
plots are not part of the API payload unless Plotly figures are empty),
then slice the steady state and run the loss engine.

Writes test/parity/fixtures/simulation/<topology>.json with:
  decks, measurements (raw .meas), results, plots, loss_analysis,
  time_series (CSV file names -> sha256 after slicing), timing.
Run from qdonis-backend with the core venv:
  & "..\\qdonis-core\\.venv\\Scripts\\python.exe" -B test\\parity\\capture\\simulation_capture.py [--only id ...]
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND_ROOT = HERE.parents[2]
DEFAULT_CORE = BACKEND_ROOT.parent / "qdonis-core"
OUT_DIR = BACKEND_ROOT / "test" / "parity" / "fixtures" / "simulation"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", default=str(DEFAULT_CORE))
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()
    core = Path(args.core).resolve()
    if os.environ.get("PYTHONHASHSEED") != "0":
        env = {**os.environ, "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.call([sys.executable, "-B", *sys.argv], env=env)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(core))

    import yaml
    from qdonis_backend.data_utils import list_builtin_topologies, resolve_yaml_path
    from qdonis_backend.simulator import generate_analysis_cirs
    from qdonis_backend.simulator.measure_and_plot import NgspiceMeasurePlotter
    from qdonis_backend.simulator.time_series_utils import slice_steady_state
    from qdonis_backend.simulator.loss_engine import calculate_losses
    from qdonis_backend import api_server

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ids = args.only or list_builtin_topologies()
    for topology in ids:
        started = time.time()
        record: dict = {"topology": topology}
        out = tempfile.mkdtemp(prefix=f"qcap_{topology}_")
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                yaml_path = str(resolve_yaml_path(topology))
                decks = generate_analysis_cirs(yaml_path, "all")["analysis_cirs"]
                record["decks"] = decks
                files = {"dc": "dc_analysis.cir", "ac": "ac_analysis.cir", "transient": "transient_analysis.cir"}
                for key, content in decks.items():
                    Path(out, files[key]).write_text(content, encoding="utf-8", newline="\n")
                with open(yaml_path, "r", encoding="utf-8") as handle:
                    yaml_data = yaml.safe_load(handle)
                plotter = NgspiceMeasurePlotter()
                captured = {}
                original = plotter.parse_measurements

                def spy(log_content, _orig=original):
                    parsed = _orig(log_content)
                    captured.update(parsed)
                    return parsed

                plotter.parse_measurements = spy
                output = plotter.execute_and_process(
                    output_dir=out,
                    yaml_path=yaml_path,
                    yaml_data=yaml_data,
                    all_analysis_files=[
                        ("DC", str(Path(out, files["dc"])), None),
                        ("AC", str(Path(out, files["ac"])), None),
                        ("Transient", str(Path(out, files["transient"])), None),
                    ],
                    analysis_filter=list(decks.keys()),
                    skip_plots=True,
                )
                record["measurements"] = captured
                record["results"] = output.get("results", output) or {}
                record["plots"] = output.get("plotly_figures", {})
                ts_dir = os.path.join(out, "time_series")
                record["time_series_raw"] = sorted(os.listdir(ts_dir)) if os.path.isdir(ts_dir) else []
                loss = None
                if os.path.isdir(ts_dir) and os.listdir(ts_dir):
                    device_types = api_server._device_types_for_yaml(yaml_path)
                    record["device_types"] = device_types
                    try:
                        slice_steady_state(ts_dir, 20.0, keep_refs=[r for r, k in (device_types or {}).items() if k])
                    except Exception as error:
                        record["slice_error"] = f"{type(error).__name__}: {error}"
                    try:
                        loss = calculate_losses(ts_dir, component_models={}, tj=100.0, device_types=device_types)
                    except Exception as error:
                        record["loss_error"] = f"{type(error).__name__}: {error}"
                record["loss_analysis"] = loss
                record["time_series"] = {
                    name: hashlib.sha256(Path(ts_dir, name).read_bytes()).hexdigest()
                    for name in sorted(os.listdir(ts_dir))
                } if os.path.isdir(ts_dir) else {}
        except Exception as error:
            record["error"] = f"{type(error).__name__}: {error}"
        finally:
            shutil.rmtree(out, ignore_errors=True)
        record["seconds"] = round(time.time() - started, 1)
        Path(OUT_DIR, f"{topology}.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=1, sort_keys=True, default=str) + "\n",
            encoding="utf-8", newline="\n",
        )
        print(f"{topology}: {record['seconds']}s {'ERROR ' + record['error'] if 'error' in record else 'ok'}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
