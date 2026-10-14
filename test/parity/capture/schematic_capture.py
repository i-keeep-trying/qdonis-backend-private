"""Captures qdonis-core synced-schematic rendering (`schematic_sync.render_for_topology`).

The synced schematic exists on qdonis-core `feature/synced-schematic` only, so point --core at a
checkout of that branch:
  python -B test\\parity\\capture\\schematic_capture.py --core D:\\path\\to\\qdonis-core
Writes test/parity/fixtures/schematic/<topology>.json: every sheet of the library layout, plus
project-layout variants (moved parts, dropped wires) that exercise the placer and the wire builder.

`build_comp_nets` iterates Python sets, so its member order depends on the hash seed. The capture
runs it with an insertion-ordered set instead (same nets, same names; only the iteration order is
fixed), which is the order the TypeScript port uses.
"""
import argparse, contextlib, copy, io, json, sys, types
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "fixtures" / "schematic"


class OrderedSet:
    """The parts of `set` that build_comp_nets uses, iterating in insertion order."""

    def __init__(self, items=()):
        self._d = dict.fromkeys(items)

    def add(self, item):
        self._d[item] = None

    def __and__(self, other):
        return OrderedSet(k for k in self._d if k in other._d)

    def __or__(self, other):
        return OrderedSet([*self._d, *other._d])

    def __iter__(self):
        return iter(self._d)

    def __len__(self):
        return len(self._d)

    def __bool__(self):
        return bool(self._d)

    def __contains__(self, item):
        return item in self._d


def variants(layout):
    """Project layouts derived from the library layout (what a user's edits leave behind)."""
    comps = layout.get("components") or {}
    wires = layout.get("wires") or []
    real = [cid for cid in comps if not cid.startswith(("~", "#", "^"))]
    out = []
    if real:
        moved = copy.deepcopy(layout)
        cid = real[0]
        moved["components"][cid] = {**moved["components"][cid], "x": moved["components"][cid]["x"] + 200}
        out.append(("moved", {"components": moved["components"], "wires": moved.get("wires") or []}))
    if wires:
        out.append(("half_wires", {"components": comps, "wires": wires[: len(wires) // 2]}))
        out.append(("no_wires", {"components": comps, "wires": []}))
    if len(real) > 2:
        keep = {k: v for k, v in comps.items() if k not in real[1:3]}
        out.append(("unplaced", {"components": keep, "wires": wires}))
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
    static = None
    for topology in ids:
        with open(resolve_yaml_path(topology), encoding="utf-8") as f:
            circuit = yaml.safe_load(f)
        cases = []
        with contextlib.redirect_stdout(io.StringIO()):
            top = ss.render_for_topology(topology, copy.deepcopy(circuit))
            static = static or {"palette": top.pop("palette"), "symbols": top["schematic"].pop("symbols")}
            top.pop("palette", None)
            top["schematic"].pop("symbols", None)
            cases.append({"name": "top", "sheet": None, "layout": None, "result": top})
            for entry in top["sheets"]:
                r = ss.render_for_topology(topology, copy.deepcopy(circuit), sheet=entry["id"])
                r.pop("palette"), r["schematic"].pop("symbols")
                cases.append({"name": f"sheet:{entry['id']}", "sheet": entry["id"], "layout": None, "result": r})
            library = ss.library_layout(circuit) or {}
            for name, layout in variants(library):
                project = {**layout, "groups": library.get("groups")}
                r = ss.render_for_topology(topology, copy.deepcopy(circuit), layout=project)
                r.pop("palette"), r["schematic"].pop("symbols")
                cases.append({"name": name, "sheet": None, "layout": project, "result": r})
        (OUT_DIR / f"{topology}.json").write_text(
            json.dumps({"topology": topology, "cases": cases}, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8", newline="\n")
        print(topology, [c["result"]["basis"] for c in cases])
    (OUT_DIR / "_static.json").write_text(json.dumps(static, ensure_ascii=False, indent=1) + "\n",
                                          encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
