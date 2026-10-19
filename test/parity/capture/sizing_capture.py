"""Captures qdonis-core sizing (topology_improver) pieces that do not need the LLM.

Run with the core venv from qdonis-backend:
  ..\\qdonis-core\\.venv\\Scripts\\python.exe test\\parity\\capture\\sizing_capture.py
Writes test/parity/fixtures/sizing/vectors.json:
  - system prompt (with the MOSFET DB), per-topology prompt suffix,
  - user prompts for sample constraints,
  - post-processing of a canned LLM reply (normalisation, PWM rules, DAB/AFE
    adapters, YAML application, change list, quick-params line, decks),
  - the deterministic DAB sizing used without an LLM.
"""
import contextlib, copy, io, json, os, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "fixtures" / "sizing" / "vectors.json"

PARAMS = [
    {"Input Voltage": "48 V", "Output Voltage": "12 V", "Output Current": "5 A", "Switching Frequency": "200 kHz",
     "derivedParametersList": [{"name": "Input Voltage", "value": "48 V"}, {"name": "Output Voltage", "value": "12 V"}],
     "assumptionsMade": ["Efficiency = 95 % (assumed)"]},
    {"vin": 400, "vout": "-48V", "pout": "3 kW", "fsw": "70kHz", "application": "EV charger"},
]


def fake_reply(design):
    """A plausible LLM reply touching every rule (ints and floats kept apart)."""
    comps = {}
    for comp in design.get("components", []):
        ref, params = comp.get("ref"), comp.get("params") or {}
        if not ref:
            continue
        if params.get("node_type") == "voltage_source":
            comps[ref] = {"voltage": 48}
        elif params.get("node_type") == "pwm_control":
            comps[ref] = {"duty_cycle": 0.3, "frequency": 200000, "delay": 0}
        elif comp.get("type") == "inductor":
            comps[ref] = {"inductance": 2.2e-05, "series_resistance": 0.01, "v_peak": 36.0, "i_peak": 6}
        elif comp.get("type") == "capacitor":
            comps[ref] = {"capacitance": 4.7e-05, "notes": "x", "std_voltage_rating": 25}
        elif comp.get("type") == "diode":
            comps[ref] = {"bv": 72, "Rs": 0.001, "tt": 2e-08}
        elif comp.get("type") == "transistor":
            comps[ref] = {"part_number": "X1", "rds_on": 0.005, "kp": 20}
        elif comp.get("type") == "resistor" and "LOAD" in str(ref).upper():
            comps[ref] = {"resistance": 2.4}
    comps["NOPE"] = {"x": 1}
    return json.dumps({"_reasoning": "## Sizing\n$D = 0.3$", "components": comps})


def main() -> int:
    if os.environ.get("PYTHONHASHSEED") != "0":
        env = {**os.environ, "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.call([sys.executable, "-B", *sys.argv], env=env)
    core = Path(sys.argv[sys.argv.index("--core") + 1]) if "--core" in sys.argv else HERE.parents[3] / "qdonis-core"
    sys.path.insert(0, str(core.resolve()))
    import yaml
    from qdonis_backend import topology_improver as ti
    from qdonis_backend.data_utils import list_builtin_topologies, resolve_yaml_path
    from qdonis_backend.simulator import generate_analysis_cirs

    prompts_seen = {}

    class FakeChoice:
        def __init__(self, text):
            self.message = type("M", (), {"content": text})()

    def fake_chat(model, messages, **kwargs):
        prompts_seen["system"] = messages[0]["content"]
        prompts_seen["user"] = messages[1]["content"]
        prompts_seen["temperature"] = kwargs.get("temperature")
        return type("R", (), {"choices": [FakeChoice(prompts_seen["reply"])]})()

    import qdonis_backend.config as cfg
    cfg.chat_complete = fake_chat
    import qdonis_backend.bedrock_client as bc
    bc.get_bedrock_client = lambda: object()
    ti._write_llm_log = lambda *a, **k: None

    out = {"system_base": ti.SYSTEM_PROMPT, "cases": []}
    tmp = Path(os.environ.get("TEMP", "/tmp"), "qsizing")
    tmp.mkdir(exist_ok=True)
    for topology in list_builtin_topologies():
        yaml_path = str(resolve_yaml_path(topology))
        with open(yaml_path, encoding="utf-8") as f:
            original = yaml.safe_load(f)
        for idx, params in enumerate(PARAMS):
            prompts_seen.clear()
            prompts_seen["reply"] = fake_reply(original)
            target = tmp / f"{topology}_{idx}.yaml"
            with contextlib.redirect_stdout(io.StringIO()):
                res = ti.optimize_topology_parameters(yaml_path, copy.deepcopy(params), str(target))
                updates, reasoning = (res if isinstance(res, tuple) else (res, None))
                changes = ti.build_parameter_change_list(original, updates, params) if updates else []
                quick = ti.build_quick_params_line(topology, params, changes)
                decks = generate_analysis_cirs(str(target), "all")["analysis_cirs"] if target.exists() else {}
            out["cases"].append({
                "topology": topology, "params": params, "reply": prompts_seen.get("reply"),
                "system": prompts_seen.get("system"), "user": prompts_seen.get("user"),
                "temperature": prompts_seen.get("temperature"),
                "updates": updates, "reasoning": reasoning, "changes": changes, "quick": quick, "decks": decks,
            })
            target.unlink(missing_ok=True)
    # The system prompt carries the MOSFET DB; store it once, cases keep only the topology suffix.
    for case in out["cases"]:
        if case["system"] and case["system"].startswith(out["system_base"]):
            case["system"] = case["system"][len(out["system_base"]):]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False, default=str) + "\n", encoding="utf-8", newline="\n")
    print("wrote", len(out["cases"]), "cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
