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
| Drawing -> YAML (`applySchematic`) and the input check of client drawings | `src/schematic/library/apply.ts`, `drawing-input.ts` |
| Endpoints (render / check / apply on the branch's Circuit stage) | `src/schematic/schematic.{controller,service}.ts` |

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

Layouts from scratch (a sheet with no saved positions: Auto-arrange, a new group, a circuit without a layout):
- `power.ts` — when the sheet's power stage has a real bridge (two or more legs, or a 3+ device leg): legs as
  vertical columns between the DC rails, rail columns (DC link, source) on the source side, anti-parallel diodes /
  snubbers beside each device, gate drive left of the gate, the power-flow chain from the midpoints outwards
  (`basis: structure`).
- `drawing-seed.ts` — otherwise the old `json_library` drawing seeds the top level (match by name, name family,
  then type + connectivity), spread 1.2-1.6x and nudged apart (`basis: drawing`).
- `auto-groups.ts` — without a saved grouping: control parts per phase / channel, then by connected cluster
  (over 14 parts split by networkx's greedy modularity, ported), named by function. The power stage stays on top.

Parity: `test/parity/capture/schematic_capture.py` renders every sheet of every topology plus four project-layout
variants (a moved part, half / no wires, two unplaced parts) in the core; `render.parity.spec.ts` compares the
whole result. The fixtures also hold every sheet laid out from scratch and the automatic grouping (with its sheets). The capture
runs the core's `build_comp_nets` with an insertion-ordered set (its member order otherwise depends on the hash
seed); the output was checked to be identical across seeds.

## Drawing -> YAML and the endpoints

`applySchematic(base, drawing, rows, sheet, layout, oldDrawing)` turns an edited drawing of one sheet into
`{layout_only, circuit, layout, param_changes, added, removed, rewired, changes, errors}`: value edits, removed parts
(nested children promoted; parts an analysis measures can not go), parts added from the palette or copied
(`meta.copyOf`), rewiring (nets rewritten only if the connectivity really changed), unconnected pins, a default
`.model` for a new switch; the netlist generator validates the result. Only the sheet's parts are in scope; a
group block can not be deleted as a whole.

Routes (`projects/:projectId/branches/:branchId/stages/visualization/schematic`, JWT, project access):

| Route | Access | Does |
|---|---|---|
| `POST /` `{sheet?, fresh?, regroup?}` | view | Draws a sheet: `{schematic, layout, sheet, sheets, palette, basis, groupsExplicit, seededFromDrawing, libraryLayout}` |
| `POST /check` `{schematic, sheet?, layout?}` | edit | What the edit would change (nothing stored), plus the new `inventory` |
| `POST /apply` `{schematic, sheet?, layout?}` | edit | Re-checks and stores. Moves only: the Circuit node's `layout` in place. Circuit changes: a new Circuit result (`customCircuit`, `layout`, `inventory`, `netlist`, an `edits` entry, `customStructure: true`), forking a `<topology> + edit` branch when later stages build on it. Edits with errors: 400 `SCHEMATIC_INVALID`; the node changed meanwhile: 409 |

- The circuit of a branch is its `customCircuit` (when edited) or the library YAML; design values come from the
  branch's design. `customCircuit` is plain JSON without the `schematic:` section (re-attached from the library, so
  library layout updates show through); whole numbers read back as YAML ints, as the old Studio's browser round
  trip did (`stored-circuit.ts`).
- The engine runs sandboxed, so `readDrawing` / `readLayout` keep only the fields editing uses, with types and
  sizes checked (5000 parts, 20000 wires); only that is stored. Wires' `hidden` flag is dropped (the render derives
  it).

## Edited circuits downstream

Every step that reads the circuit takes the branch's (`branchCircuit(customCircuit, library)` in
`stored-circuit.ts`): the design (library defaults and the queued AI sizing: `DesignRunInput.circuit`), design
value edits, the simulation (`SimulationRunInput.circuit`: loss device types, measurements), device selection and
the thermal stage's loss recalculation; magnetics / thermal inventories already took `customCircuit`.

Editing a circuit that has a design: the apply forks (later stages build on it), and the design is carried onto
the new branch (`carriedDesignValues` in `simulation/design-values.ts`): its rows are kept (rows of removed parts
dropped, values edited in the schematic replace the row value, as typed), and the decks are regenerated from the
edited circuit, so the next simulation runs exactly what is drawn. Simulation and later stages are not carried
(run them again). Not carried: an uploaded deck, or decks that can not be generated (`designCarried: false`).

## Developer layout tool (DEV-LAYOUT, temporary)

For hand-tuning the library layouts once. Remove before the public release: everything is tagged `DEV-LAYOUT`
(`grep -rn "DEV-LAYOUT"` in both repos). Only where `SCHEMATIC_LAYOUT_TOOL=true` (never in production); 404
elsewhere (`dev-layout/layout-tool.guard.ts`).

| Route | Does |
|---|---|
| `GET /dev/schematic/library-status` | Every library topology: parts, has a layout, tuned |
| `POST /dev/schematic/render` `{topologyId, sheet?, fresh?, regroup?, layout?}` | Draws a library topology without a project (`layout`: the unsaved layout being tuned) |
| `POST /dev/schematic/check` `{topologyId, schematic, sheet?, layout?}` | Layout only or not (the tuner saves presentation only) |
| `POST /dev/schematic/library-layout` `{topologyId, layout, tuned?}` | Writes the `schematic:` section of `assets/topologies/primitives/<id>.yaml`, updates its `MANIFEST.json` entry, reloads the library |
| `DELETE .../stages/visualization/schematic/layout` | Drops a branch's own layout (the library layout shows again) |

The writer (`library/layout-yaml.ts`, port of `layout_to_yaml` / `replace_schematic_section`) refuses to write
when anything but the section would change or the layout does not read back identically. Saved assets no longer
match core `0054f72` (`import-core-assets.mjs --check` reports them); commit them with the backend.

## Plan

1. Control blocks in the netlist generator — done.
2. Topology library refreshed from core `feature/synced-schematic` (layouts, block-based control loops) — done.
3. YAML -> drawing (`src/schematic/`): symbol registry, placement, wires, sheets (3a), layouts from scratch (3b) —
   done.
4. Drawing -> YAML: check / apply endpoints; the Circuit stage stores the edited circuit and layout — done.
5. Edited circuits are designed and simulated; the design is carried over an edit — done.
6. qdonis-web: engine synced mode and wire router — done (engine protocol and web change log:
   `qdonis-web/docs/synced-schematic.md`).
7. qdonis-web: synced schematic in the Circuit tab (sheets, check, apply) — done (see the web doc).
8. Developer layout tool (temporary, tagged `DEV-LAYOUT`) — done (web side: see the web doc).

Still open from the original notes: hand-tuning every library layout with the tuner (by the user, at the end);
removing `DEV-LAYOUT` when the Studio goes public; probes / scopes from the drawing; the chat agent does not know
about sheets.

## Change log

### 2026-10-15 — Developer layout tool, backend (part 8)
- `SCHEMATIC_LAYOUT_TOOL` (env validation, configuration, `.env.example`); `schematic/dev-layout/`
  (guard, controller, service); `library/layout-yaml.ts`; `SchematicService.resetLayout`;
  `TopologiesService.reload`.
- Checks: every library YAML's section is rewritten byte for byte from its parsed layout (35); the save test
  writes a layout, checks the rest of the file and the boot-time asset check, then restores `assets/`; the
  guard; all unit tests pass (1592).

### 2026-10-15 — Edited circuits are designed and simulated (part 5)
- `simulation.service.ts`: the design (both paths), `setDesignValues`, `runSimulation` and `selectDevices` use the
  branch's circuit; the "Designing an edited circuit is not available yet" refusals are gone.
  `simulation-runs.service.ts`, `sizing/design-sizing.service.ts`: run inputs carry `circuit`.
  `library-circuit-data.provider.ts` / `thermal.stage.ts`: loss recalculation takes it too.
- `design-values.ts`: `rowUpdates` (shared with `setDesignValues`), `carriedDesignValues`; `schematic.service.ts`
  carries the design over an edit (`designCarried` in the apply answer).
- Checks: `schematic.service.spec.ts` drives the real `SimulationService` on an in-memory graph (design of an
  edited circuit, carry-over onto the fork with the original branch untouched, value edits and the queued
  simulation input on the edited circuit); all unit tests pass (1551).

### 2026-10-15 — Drawing -> YAML, schematic endpoints (part 4)
- `library/apply.ts` (port of `apply_schematic` and its helpers), `values.ts` `coerce`, `library/drawing-input.ts`
  (input check), `library/stored-circuit.ts`; `SchematicModule` (controller, service, DTOs) registered in
  `app.module.ts`; `VisualizationData` gains `customCircuit`, `layout` and a typed `edits`; error codes
  `SHEET_NOT_FOUND`, `SCHEMATIC_INVALID`.
- Parity: `test/parity/capture/schematic_apply_capture.py` -> `fixtures/schematic-apply/` (19 MB): every sheet
  unedited, plus edits on the top level and one group sheet (move, value, removal, palette part, control block,
  copy, labels, ground, rewire, floating part, bad name, unknown type, switch model, deleted block), each run
  through the input check in `apply.parity.spec.ts`. `schematic.service.spec.ts` covers the endpoints' flow on an
  in-memory graph (render, sheet 404, check, move in place, value edit stored and redrawn, errors, malformed
  input, revision conflict, view-only).
- Checks: 662 apply cases identical to the core; all unit tests pass (1548). Not run: the e2e suite (needs a
  database).

### 2026-10-15 — Layouts from scratch (part 3b)
- `library/power.ts` (port of `schematic_power.py`), `library/drawing-seed.ts` (`_seed_from_drawing`),
  `library/auto-groups.ts` (`auto_groups`, with networkx `connected_components` / `greedy_modularity_communities`
  ported: each merge takes the largest gain, ties to the smallest pair, as networkx's heaps order).
- `render` takes the old drawing (`RenderOptions.drawing`), reports `basis` structure / drawing and
  `seeded_from_drawing`; `resolveGroups` falls back to the automatic proposal. `expressionNets` moved to `model.ts`.
- Checks: 374 render cases identical to the core, now including Auto-arrange of every sheet and every sheet of the
  automatic grouping (of these from-scratch layouts, 35 are by structure and 35 seeded from the old drawing;
  11 topologies get automatic sheets, the modularity split runs on 7); all unit tests pass (873).

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
