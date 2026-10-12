"""Captures qdonis-core waveform stats, device selection and loss recalculation.

Run with the core venv from qdonis-backend (one topology at a time is fine):
  ..\\qdonis-core\\.venv\\Scripts\\python.exe test\\parity\\capture\\studio_capture.py [--only id ...]
Writes test/parity/fixtures/studio/<id>.json and test/parity/fixtures/studio/_catalogue.json.

Each fixture holds the sliced time-series ZIP (base64, as the rerun returns it)
and core's outputs computed from it, so the TS port is checked on identical input.
"""
import argparse, base64, contextlib, io, json, os, shutil, subprocess, sys, tempfile, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "fixtures" / "studio"
# Small archives only (dcdc_full_bridge_centertapped also matched, but its fixture is 56 MB).
DEFAULT_IDS = ["dcdc_buck", "dcdc_flyback", "dcac_single_phase_h_bridge"]
STRESSES = [
    {"ref": "Q1", "kind": "switch", "v_block_v": 400, "fsw_khz": 100, "i_peak_a": 12, "i_rms_a": 6, "duty": 0.4},
    {"ref": "Q2", "kind": "switch", "v_block_v": 400, "fsw_khz": 100, "i_peak_a": 12, "i_rms_a": 6, "duty": 0.4, "zvs": True},
    {"ref": "D1", "kind": "diode", "v_block_v": 60, "fsw_khz": 100, "i_avg_a": 3, "duty": 0.5},
    {"ref": "Q9", "kind": "switch", "v_block_v": 800, "fsw_khz": 20, "i_peak_a": 150, "i_rms_a": 80},
]


def main() -> int:
    if os.environ.get("PYTHONHASHSEED") != "0":
        env = {**os.environ, "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.call([sys.executable, "-B", *sys.argv], env=env)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(HERE.parents[3] / "qdonis-core"))
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()

    import yaml
    from qdonis_backend import api_server
    from qdonis_backend.data_utils import resolve_yaml_path
    from qdonis_backend.simulator import generate_analysis_cirs
    from qdonis_backend.simulator.measure_and_plot import NgspiceMeasurePlotter
    from qdonis_backend.simulator.time_series_utils import slice_steady_state
    from qdonis_backend.simulator.loss_engine import calculate_losses
    from qdonis_backend.simulator.device_selection import catalogue, select_devices, select_devices_from_stresses
    from qdonis_backend.studio_waveforms import waveform_stats

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with contextlib.redirect_stdout(io.StringIO()):
        (OUT_DIR / "_catalogue.json").write_text(json.dumps(catalogue(), indent=1) + "\n", encoding="utf-8", newline="\n")
        standalone = {
            "auto": select_devices_from_stresses(STRESSES[:3], tj=100.0),
            "igbt": select_devices_from_stresses(STRESSES, tj=125.0, preference="igbt"),
            "missing": select_devices_from_stresses([{"ref": "Q1", "kind": "switch"}], tj=100.0),
        }
    (OUT_DIR / "_standalone.json").write_text(
        json.dumps({"stresses": STRESSES, "results": standalone}, indent=1, sort_keys=True, default=str) + "\n",
        encoding="utf-8", newline="\n")

    for topology in args.only or DEFAULT_IDS:
        out = tempfile.mkdtemp(prefix=f"qstudio_{topology}_")
        record = {"topology": topology}
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                yaml_path = str(resolve_yaml_path(topology))
                decks = generate_analysis_cirs(yaml_path, "all")["analysis_cirs"]
                files = {"dc": "dc_analysis.cir", "ac": "ac_analysis.cir", "transient": "transient_analysis.cir"}
                for key, content in decks.items():
                    Path(out, files[key]).write_text(content, encoding="utf-8", newline="\n")
                with open(yaml_path, "r", encoding="utf-8") as handle:
                    yaml_data = yaml.safe_load(handle)
                NgspiceMeasurePlotter().execute_and_process(
                    output_dir=out, yaml_path=yaml_path, yaml_data=yaml_data,
                    all_analysis_files=[(n, str(Path(out, files[k])), None) for n, k in (("DC", "dc"), ("AC", "ac"), ("Transient", "transient"))],
                    analysis_filter=list(decks.keys()), skip_plots=True)
                ts = os.path.join(out, "time_series")
                device_types = api_server._device_types_for_yaml(yaml_path)
                slice_steady_state(ts, 20.0, keep_refs=[r for r, k in (device_types or {}).items() if k])
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                    for name in sorted(os.listdir(ts)):
                        z.write(os.path.join(ts, name), name)
                zip_b64 = base64.b64encode(buf.getvalue()).decode()
                record["zip"] = zip_b64
                record["device_types"] = device_types
                record["waveform_stats"] = waveform_stats(zip_b64, yaml_data)
                sel = select_devices(ts, tj=100.0, device_types=device_types)
                record["selection"] = sel
                record["selection_losses"] = calculate_losses(ts, component_models=sel["component_models"], tj=100.0, device_types=device_types)
                record["selection_igbt"] = select_devices(ts, tj=100.0, device_types=device_types, preference="igbt")
                first = next((s for s in sel["selections"] if s.get("alternatives")), None)
                if first:
                    override = {first["ref"]: first["alternatives"][0]["part"]}
                    record["override"] = override
                    record["selection_override"] = select_devices(ts, tj=100.0, device_types=device_types, overrides=override)
                record["recalc_150"] = calculate_losses(ts, component_models=sel["component_models"], tj=150.0, device_types=device_types)
        except Exception as error:
            record["error"] = f"{type(error).__name__}: {error}"
        finally:
            shutil.rmtree(out, ignore_errors=True)
        Path(OUT_DIR, f"{topology}.json").write_text(
            json.dumps(record, indent=1, sort_keys=True, default=str) + "\n", encoding="utf-8", newline="\n")
        print(topology, "error" in record and record["error"] or "ok", round(len(record.get("zip", "")) / 1e6, 2), "MB zip", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
