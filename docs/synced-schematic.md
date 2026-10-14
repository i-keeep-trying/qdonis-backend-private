# Synced schematic

The Studio schematic shows exactly the circuit that is simulated, and edits made in the drawing change what is
simulated. The topology YAML is the only source of truth: the netlist is generated from it and the drawing is
drawn from it. Layout (positions, wire routes, sheets) is the only drawing-specific data.

Ported from qdonis-core / qdonis `feature/synced-schematic` (Python `schematic_*.py`, `control_blocks.py`,
the engine's synced mode). The full original design notes are `qdonis/docs/SYNCED_SCHEMATIC.md` on that branch.

## Pieces

| Piece | Where |
|---|---|
| Simulink-style control blocks (`type: gain`, `pi`, `pwm` ...) expanded into plain ngspice | `src/simulation/netlist/signal-blocks.ts` |
| Topology library (YAML incl. `schematic:` layouts), copied from core `0054f72` | `assets/`, `scripts/import-core-assets.mjs` |
| Solver settings per analysis (`solverOptions`) | `src/simulation/netlist/netlist-generator.ts` |
| YAML -> drawing (symbol registry, placement, wires, sheets, hidden parts) | `src/schematic/library/` |

## Control blocks

One YAML component per block, drawn as one symbol, expanded by `emitControlBlock` (hooked into the shared
element loop of the netlist generator, so base netlist and analysis decks both get it). Signals are voltages
referred to ground; inputs `in` / `in1`.. (comparator `inp` / `inn`), output `out`; `gate_driver` has a
floating `g` / `s` output. Parameter reference: the table in the original design notes ("Control block
reference"). Not to be confused with `control-blocks.ts`, which writes the `.control` analysis sections.

## Library assets and solver settings

`assets/` is a byte copy of core `feature/synced-schematic` `0054f72` (`MANIFEST.json` records it). Compared with
the migration base `239d79a`: every YAML has a `schematic:` section (hand-tuned layout, sheets), the hand-made
control loops of 11 topologies are control blocks, five designs are fixed (Zeta, totem pole, Vienna, T-type,
full-bridge LLC), `spice_components.json` has no `led`. To refresh: delete the changed files, set `COMMIT` in
`scripts/import-core-assets.mjs`, run it, then `--check` (it never overwrites a file).

Solver options (`.options`) are resolved per deck, lowest precedence first: defaults, `simulation.spice_options`,
`analysis.spice_settings`, `analysis.<type>.spice_settings`. The base netlist takes the first analysis present
of transient / dc / ac. Most library topologies keep their tolerances under `analysis.transient.spice_settings`,
which before this were read but never written; the YAML fixes above were verified with them applied.

Parity: `test/parity/capture/control_blocks_capture.py` records the core's output for every block type (defaults
and the parameter forms the library uses); `signal-blocks.parity.spec.ts` replays it.

## YAML -> drawing (`src/schematic/library/`)

`renderForTopology(circuit, {recalculated, layout, sheet, fresh, regroup})` returns the engine drawing of one sheet
(`schematic`: components, wires, `symbols` pin table), the full updated `layout`, the sheet list and the `palette`.

- `symbols.ts` — the one table YAML type / variant <-> engine symbol, YAML pin -> terminal, pin geometry, extents,
  palette. A part whose pins do not fit becomes a generic `BLOCK`.
- `model.ts` — connectivity comes from the netlist generator (`buildCompNets`), so the drawing can not show a
  connection that is not simulated. Regions: `main` (power stage) / `control` (drive, sensing, regulation);
  the two are joined by net labels only.
- `layout.ts` — layout layers: the project's layout over the YAML's `schematic:` section (project positions win;
  wires and grouping come from the project once it has its own; a layout grouping parts the circuit no longer has
  is dropped).
- `sheets.ts` — groups are presentation only (flat netlist): a group is a `SHEET` block (`#<group>`) on the top
  level with a pin per boundary net, and `PORT`s (`^<group>:<net>`) on its own sheet.
- `render.ts` — positions: saved, else beside what a part connects to (parallel partners, ground / label rules,
  islands stacked below). `wiring.ts` — saved wires still on one net are kept, the rest is a shortest pin-to-pin
  tree; far-apart pieces get drawing-only labels (`~NAME@REF.pin`); lone labels and >= 1 MOhm resistors to ground
  are hidden (`meta.hidden`), not removed.

Not ported yet (needed only for a layout from scratch, part 3b): the power-stage structure placement
(`schematic_power.py`), seeding from the old `json_library` drawings, and the automatic grouping proposal. All 35
library topologies have a saved layout and grouping, so the library draws without them.

Parity: `test/parity/capture/schematic_capture.py` renders every sheet of every topology plus four project-layout
variants (a moved part, half / no wires, two unplaced parts) in the core; `render.parity.spec.ts` compares the
whole result. The capture runs the core's `build_comp_nets` with an insertion-ordered set (its member order
otherwise depends on the hash seed); the output was checked to be identical across seeds.

## Plan

1. Control blocks in the netlist generator — done.
2. Topology library refreshed from core `feature/synced-schematic` (layouts, block-based control loops) — done.
3. YAML -> drawing (`src/schematic/`): symbol registry, placement, wires, sheets — done (3a). 3b: power-stage
   structure placement, seeding from the old drawings, automatic grouping (layouts from scratch).
4. Drawing -> YAML: check / apply endpoints; the Circuit stage stores the edited circuit and layout.
5. Edited circuits are designed and simulated (today the design stage refuses them).
6. qdonis-web: engine synced mode and wire router.
7. qdonis-web: synced schematic in the Circuit tab (sheets, check, apply).
8. Developer layout tool (temporary, tagged `DEV-LAYOUT`).

## Change log

### 2026-10-15 — YAML -> drawing renderer (part 3a)
- New `src/schematic/` (`schematic.types.ts`, `library/{symbols,values,geometry,model,layout,sheets,wiring,render}.ts`):
  port of `schematic_symbols.py`, the render path of `schematic_sync.py` and the sheet views of
  `schematic_sheets.py`. Pure functions only; no endpoint yet (part 4).
- `signal-blocks.ts`: block defaults keep Python's int / float (bigint), so palette defaults print as the core's.
- Checks: 217 render cases (every sheet of 35 topologies + project-layout variants) and the palette / symbol table
  identical to the core; all unit tests pass (716).

### 2026-10-15 — Topology library from core `feature/synced-schematic`; per-analysis solver settings
- `assets/`: 37 files re-imported from core `0054f72` (35 YAMLs, `json_library/dcdc_boost.json`,
  `spice/spice_components.json`); `import-core-assets.mjs` and `manifest.spec.ts` name the new commit.
- `netlist-generator.ts`: `solverOptions(design, analysisType)` (port of core `solver_options`); every deck
  writes the options of its own analysis. 29 of 35 library decks get different `.options`.
- Parity fixtures re-captured from `0054f72`: `netlist/` (35), `sizing/vectors.json`, `sync/vectors.json`
  (`sizing_capture.py` / `sync_capture.py` take `--core`). The other fixture sets are unaffected and still pass.
- Checks: asset `--check` passes (963 files); all unit tests pass (497).

### 2026-10-15 — Control blocks in the netlist generator
- `signal-blocks.ts`: port of `control_blocks.py` (18 block types: emission, pins, symbol pin geometry, value
  text, palette defaults). `netlist-generator.ts`: blocks are emitted in the element loop; the unknown-type error
  lists them (and no longer lists `led`, removed in the core).
- Checks: 101 parity cases identical to the core; the 35 library netlists unchanged.
