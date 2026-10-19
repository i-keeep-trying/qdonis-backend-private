"""Re-derives the studio fixtures' core outputs that need no ngspice run.

Run from qdonis-backend (system Python is fine; nothing here simulates):
  python -B test\\parity\\capture\\studio_derived_capture.py [--core D:\\path\\to\\qdonis-core]

From the archives already in test/parity/fixtures/studio/<id>.json it rewrites
`waveform_stats` and adds `loss_vs_temperature` (with the parts the library
selection chose). It also writes test/parity/fixtures/studio/_inventory.json:
`circuit_inventory` of every library topology.
"""
import base64, contextlib, io, json, os, shutil, subprocess, sys, tempfile, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "fixtures" / "studio"


def write(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=1, sort_keys=True, default=str) + "\n", encoding="utf-8", newline="\n")


def main() -> int:
    if os.environ.get("PYTHONHASHSEED") != "0":
        env = {**os.environ, "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.call([sys.executable, "-B", *sys.argv], env=env)
    sys.dont_write_bytecode = True
    core = Path(sys.argv[sys.argv.index("--core") + 1]) if "--core" in sys.argv else HERE.parents[3] / "qdonis-core"
    sys.path.insert(0, str(core.resolve()))

    import yaml
    from qdonis_backend.data_utils import resolve_yaml_path
    from qdonis_backend.simulator.loss_engine import losses_vs_temperature
    from qdonis_backend.studio_circuit import circuit_inventory
    from qdonis_backend.studio_waveforms import waveform_stats

    def load_yaml(topology):
        with open(resolve_yaml_path(topology), "r", encoding="utf-8") as handle:
            return yaml.safe_load(handle)

    for path in sorted(OUT_DIR.glob("*.json")):
        if path.name.startswith("_"):
            continue
        record = json.loads(path.read_text(encoding="utf-8"))
        if "zip" not in record:
            continue
        ts = tempfile.mkdtemp(prefix="qstudio_derived_")
        try:
            with zipfile.ZipFile(io.BytesIO(base64.b64decode(record["zip"]))) as z:
                z.extractall(ts)
            with contextlib.redirect_stdout(io.StringIO()):
                record["waveform_stats"] = waveform_stats(record["zip"], load_yaml(record["topology"]))
                record["loss_vs_temperature"] = losses_vs_temperature(
                    ts, component_models=record["selection"]["component_models"], device_types=record["device_types"])
        finally:
            shutil.rmtree(ts, ignore_errors=True)
        write(path, record)
        print(path.stem, len(record["loss_vs_temperature"]), "curves", flush=True)

    primitives = core / "qdonis_backend" / "data" / "topologies" / "primitives"
    inventory = {}
    for yaml_path in sorted(primitives.glob("*.yaml")):
        with open(yaml_path, "r", encoding="utf-8") as handle:
            inventory[yaml_path.stem] = circuit_inventory(yaml.safe_load(handle))
    write(OUT_DIR / "_inventory.json", inventory)
    print(len(inventory), "inventories", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
