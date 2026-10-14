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

## Control blocks

One YAML component per block, drawn as one symbol, expanded by `emitControlBlock` (hooked into the shared
element loop of the netlist generator, so base netlist and analysis decks both get it). Signals are voltages
referred to ground; inputs `in` / `in1`.. (comparator `inp` / `inn`), output `out`; `gate_driver` has a
floating `g` / `s` output. Parameter reference: the table in the original design notes ("Control block
reference"). Not to be confused with `control-blocks.ts`, which writes the `.control` analysis sections.

Parity: `test/parity/capture/control_blocks_capture.py` records the core's output for every block type (defaults
and the parameter forms the library uses); `signal-blocks.parity.spec.ts` replays it.

## Plan

1. Control blocks in the netlist generator — done.
2. Topology library refreshed from core `feature/synced-schematic` (layouts, block-based control loops).
3. YAML -> drawing (`src/schematic/`): symbol registry, placement, power-stage structure, sheets.
4. Drawing -> YAML: check / apply endpoints; the Circuit stage stores the edited circuit and layout.
5. Edited circuits are designed and simulated (today the design stage refuses them).
6. qdonis-web: engine synced mode and wire router.
7. qdonis-web: synced schematic in the Circuit tab (sheets, check, apply).
8. Developer layout tool (temporary, tagged `DEV-LAYOUT`).

## Change log

### 2026-10-15 — Control blocks in the netlist generator
- `signal-blocks.ts`: port of `control_blocks.py` (18 block types: emission, pins, symbol pin geometry, value
  text, palette defaults). `netlist-generator.ts`: blocks are emitted in the element loop; the unknown-type error
  lists them (and no longer lists `led`, removed in the core).
- Checks: 101 parity cases identical to the core; the 35 library netlists unchanged.
