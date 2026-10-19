"""Captures qdonis-core synced-schematic edits (`schematic_sync.apply_schematic`): drawing -> YAML.

Point --core at a checkout of qdonis-core `feature/synced-schematic`:
  python -B test\\parity\\capture\\schematic_apply_capture.py --core D:\\path\\to\\qdonis-core
Writes test/parity/fixtures/schematic-apply/<topology>.json: for every topology the unedited drawing of
every sheet (must apply as layout only) and a set of edits made on the rendered drawing (values, moves,
removals, palette parts, copies, control blocks, labels, rewiring, invalid edits, a deleted block).
Same insertion-ordered `build_comp_nets` as schematic_capture.py. Results omit the circuit's (unchanged)
`schematic:` section; edits keep only the layout's grouping.
"""
import argparse, contextlib, copy, io, json, sys, types
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "fixtures" / "schematic-apply"
sys.path.insert(0, str(HERE))
from schematic_capture import OrderedSet  # noqa: E402

VALUE_KEYS = {"R": ("resistance", "47k"), "C": ("capacitance", "4.7u"), "L": ("inductance", "22u")}


def pin(cid, terminal):
    return {"type": "pin", "compId": cid, "terminal": terminal}


def wire(wid, a, b):
    return {"id": wid, "from": a, "to": b}


def part(cid, ctype, x, y, parameters=None, meta=None):
    return {"id": cid, "type": ctype, "x": x, "y": y, "rotation": 0, "mirrorX": False, "mirrorY": False,
            "parameters": parameters or {}, "meta": meta or {}}


def pin_ends(sch):
    return [e for w in sch["wires"] for e in (w["from"], w["to"])
            if e.get("type") == "pin" and not str(e["compId"]).startswith(("~", "#", "^"))]


def edits(sch):
    """(name, edited drawing) pairs derived from one rendered sheet."""
    comps = sch["components"]
    real = [c for c in comps if c["type"] not in ("LABEL", "GND", "SHEET", "PORT") and not c["meta"].get("virtual")
            and not c["meta"].get("bare")]
    ends = pin_ends(sch)
    out = []

    def variant(name, fn):
        s = copy.deepcopy(sch)
        if fn(s) is not False:
            out.append((name, s))

    if real:
        def moved(s):
            next(c for c in s["components"] if c["id"] == real[0]["id"])["x"] += 40
        variant("moved", moved)
    for c in real:
        if c["type"] in VALUE_KEYS and VALUE_KEYS[c["type"]][0] in c["parameters"]:
            key, value = VALUE_KEYS[c["type"]]

            def value_edit(s, cid=c["id"], key=key, value=value):
                next(x for x in s["components"] if x["id"] == cid)["parameters"][key] = value
            variant(f"value:{c['id']}", value_edit)
            break
    for c in real:
        if c["type"] in ("R", "C"):
            def remove(s, cid=c["id"]):
                s["components"] = [x for x in s["components"] if x["id"] != cid]
                s["wires"] = [w for w in s["wires"] if cid not in (w["from"].get("compId"), w["to"].get("compId"))]
            variant(f"remove:{c['id']}", remove)
            break
    if len(ends) >= 2:
        a, b = ends[0], ends[-1]

        def add_r(s):
            s["components"].append(part("RNEW1", "R", 0, -400, {"resistance": "10k"}))
            s["wires"] += [wire("WN1", pin("RNEW1", "A"), dict(a)), wire("WN2", pin("RNEW1", "B"), dict(b))]
        variant("add_resistor", add_r)

        def add_block(s):
            s["components"].append(part("KNEW", "CB_gain", 200, -400, {"gain": "2"}))
            s["wires"] += [wire("WB1", pin("KNEW", "in"), dict(a)), wire("WB2", pin("KNEW", "out"), dict(b))]
        variant("add_block", add_block)

        def rewire(s):
            first = next(w for w in s["wires"] if w["from"].get("type") == "pin" and w["to"].get("type") == "pin"
                         and not str(w["to"]["compId"]).startswith(("~", "#", "^")))
            first["to"] = dict(b) if first["to"] != b else dict(a)
        variant("rewire", rewire)

        def label(s):
            s["components"].append(part("NETX1", "LABEL", 0, -500, {"net_name": "NETX"}))
            s["components"].append(part("NETX2", "LABEL", 0, -600, {"net_name": "NETX"}))
            s["wires"] += [wire("WL1", pin("NETX1", "P"), dict(a)), wire("WL2", pin("NETX2", "P"), dict(b))]
        variant("labels", label)

        def ground(s):
            s["components"].append(part("GNDX", "GND", 0, -700))
            s["wires"].append(wire("WG1", pin("GNDX", "P"), dict(b)))
        variant("ground", ground)
    for c in real:
        if c["type"] in ("R", "C", "L"):
            def copy_part(s, src=c):
                s["components"].append(part(f"{src['id']}X", src["type"], src["x"] + 120, src["y"],
                                            dict(src["parameters"]), {"copyOf": src["id"]}))
                s["wires"] += [wire("WC1", pin(f"{src['id']}X", "A"), pin(src["id"], "A")),
                               wire("WC2", pin(f"{src['id']}X", "B"), pin(src["id"], "B"))]
            variant(f"copy:{c['id']}", copy_part)
            break
    variant("floating", lambda s: s["components"].append(part("CNEW1", "C", 0, -800)))
    variant("bad_name", lambda s: s["components"].append(part("1bad", "R", 0, -900)))
    variant("unknown_type", lambda s: s["components"].append(part("QQ1", "TRIAC", 0, -900)))
    variant("switch_model", lambda s: s["components"].append(part("SNEW", "VSW", 0, -900, {"model": "sw_new"})))
    blocks = [c for c in comps if c["type"] == "SHEET"]
    if blocks:
        def delete_block(s, cid=blocks[0]["id"]):
            s["components"] = [x for x in s["components"] if x["id"] != cid]
            s["wires"] = [w for w in s["wires"] if cid not in (w["from"].get("compId"), w["to"].get("compId"))]
        variant("delete_block", delete_block)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", required=True, help="qdonis-core checkout on feature/synced-schematic")
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(args.core).resolve()))
    import yaml
    from qdonis_backend.data_utils import resolve_yaml_path
    from qdonis_backend.simulator import netlist_generator as ng
    from qdonis_backend import schematic_sync as ss

    original = ng.build_comp_nets
    ng.build_comp_nets = types.FunctionType(original.__code__, {**original.__globals__, "set": OrderedSet},
                                            original.__name__, original.__defaults__, original.__closure__)

    primitives = Path(args.core) / "qdonis_backend" / "data" / "topologies" / "primitives"
    ids = args.only or sorted(p.stem for p in primitives.glob("*.yaml"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for topology in ids:
        with open(resolve_yaml_path(topology), encoding="utf-8") as f:
            circuit = yaml.safe_load(f)
        drawing = ss.topology_drawing(topology)
        layout = ss.merge_layouts(ss.library_layout(circuit), None, circuit)
        cases = []
        with contextlib.redirect_stdout(io.StringIO()):
            top = ss.render_for_topology(topology, copy.deepcopy(circuit))
            sheets = [None] + [s["id"] for s in top["sheets"]]
            for sheet in sheets:
                drawn = ss.render_for_topology(topology, copy.deepcopy(circuit), sheet=sheet)["schematic"]
                sch = {"components": drawn["components"], "wires": drawn["wires"]}
                todo = [("unchanged", sch)] + (edits(sch) if sheet in (None, sheets[-1]) else [])
                for name, edited in todo:
                    case = {"name": f"{sheet or 'top'}:{name}", "sheet": sheet, "schematic": edited}
                    try:
                        case["result"] = ss.apply_schematic(copy.deepcopy(circuit), copy.deepcopy(edited), None,
                                                            sheet=sheet, layout=copy.deepcopy(layout), drawing=drawing)
                        # Keep the fixtures small: the YAML's schematic: section is never changed by an edit,
                        # and the layout of an edit is the render's set_sheet_layout (covered by the render
                        # fixtures) plus the new grouping.
                        result = case["result"]
                        result["circuit"].pop("schematic", None)
                        if name != "unchanged":
                            result["layout"] = {"groups": result["layout"].get("groups")}
                    except Exception as error:  # recorded, so the port must fail the same way
                        case["error"] = f"{type(error).__name__}: {error}"
                    cases.append(case)
        (OUT_DIR / f"{topology}.json").write_text(
            json.dumps({"topology": topology, "cases": cases}, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8", newline="\n")
        summary = [c["result"]["layout_only"] if "result" in c else "ERR" for c in cases]
        print(topology, len(cases), sum(1 for s in summary if s is True), sum(1 for c in cases if c.get("result", {}).get("errors")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
