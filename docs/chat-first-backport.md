# chat-first fixes -> new repos

While qdonis / qdonis-core were being migrated, `feature/chat-first` kept getting fixes. The backend was ported
from core `239d79a` (Oct 7) and its library from core `feature/synced-schematic` `0054f72`, and the web from
qdonis around `6c95ef4`, so everything below was missing. This doc tracks bringing it over (branch
`feature/synced-schematic` in qdonis-backend and qdonis-web), one part at a time.

## Source commits

| Repo | Commit | Date | What |
|---|---|---|---|
| core | `326d618` | 10-09 | loss vs Tj, circuit inventory (power sources, Vout target, load), devices stage dropped (only `dcdc_boost.json` reached the new assets) |
| core | `a4fdaf2` | 10-10 | design-summary deck line, measurement echo, line-cycle windows, sizing (SI prefixes, PFC operating point), 9 YAMLs + prompts |
| core | `7f41908` | 10-11 | VSI/NPC: main-DC ground, diode-bridge C_OUT, PWM period detection, SPICE-suffix time settings, sizing, YAMLs |
| core | `08fa795` | 10-12 | nested-resistor V_ export, waveform-stats `links`, "Recommended cooling" agent rule |
| core | `6b8f8dd` | 10-12 | T-type / 3-ph AFE: diode Tt optional, no plot cmds for auto-telemetry, sizing, YAMLs |
| core | `ed875a3` | 10-13 | 1-ph AFE deterministic sizing, YAML, prompt |
| core | `27fb90b` | 10-12 | untracked `time_series/` (nothing to port) |
| web | `cab4f1f` | 10-09 | devices merged into Simulation, loss-vs-Tj chart, magnetics operating point, Specs constraint domains |
| web | `fe35eb0` | 10-10 | magnetics UI, 3D magnetic model, waveform viewer |
| web | `6d59ca0` | 10-12 | split simulation view, editable magnetics, thermal fixes, cooling recommendation (old doc: `qdonis/docs/MAGNETICS_AND_LOSS_ANALYSIS_FLOW.md` "Change log") |
| web | `1309970` | 10-12 | waveform viewer shows DC output names (V_DC_OUT, VDC ...) by default |

## Reference core for parity

Scratch clone of core `feature/synced-schematic` with `feature/chat-first` merged: the Python code merges
cleanly; 8 YAMLs conflict (Part 2). Each part re-captures the parity fixtures from a reference that has only
that part's Python on top of `0054f72`, so a fixture never contains a later part's behaviour.

## Plan

1. Netlist / simulator fixes (core `simulator/`) — done.
2. Topology library: the teammates' YAML / prompt fixes (VSI, NPC, T-type, 1-ph / 3-ph AFE, interleaved buck,
   flyback PFC, totem pole, DAB, full-bridge CT, Zeta, diode bridge; 11 prompts) merged into `assets/` keeping
   the `schematic:` layouts and control blocks; checked by running ngspice.
3. Deterministic sizing (`topology_improver.py` -> `simulation/sizing/`): SI-prefix parsing, DAB output power
   references `{components.R_LOAD.resistance}`, single-phase PFC operating point and sizing, VSI / NPC / T-type /
   AFE sizing.
4. Loss vs junction temperature (loss engine + endpoint + chart); circuit inventory `power_sources`,
   `output_voltage`, `load_resistance`; waveform stats `links` of nested parts.
5. Devices folded into the Simulation stage (agent tools / prompt, stage list, web), parts picked in the loss
   table kept across re-runs.
6. Magnetics: operating point per part, editable per-part inputs and ambient, 3D model.
7. Thermal: nested-resistor loss fix, R_ISO excluded, cooling recommendation (+ agent rule).
8. Simulation / Specs UI: split view, waveform viewer (toggle chips, DC output names), loss table, constraint
   domains.

## Change log

Newest first.

### 2026-10-15 — Part 1: netlist / simulator fixes

Ported from core `a4fdaf2`, `7f41908`, `08fa795`, `6b8f8dd` (`simulator/netlist_generator.py`,
`simulator/__init__.py`, `simulator/measure_and_plot.py`, `api_server._run_rerun_simulation`):

- Design summary: every prepared deck carries `* qdonis-design: {criteria, params}` as its second line (each
  requirement's criteria and the parameters output formulas reference as `{components.REF.PARAM}`). A re-run
  applies it to a copy of the template YAML before evaluating results, so regulation error / output power use the
  designed targets. `netlist/design-summary.ts`, used in `generateAnalysisCirs` and `rerun.pipeline.ts`.
- AVG / RMS / PP windows of circuits with a line-frequency (< 1 kHz) sine source span whole line cycles
  (`alignWindowToLineCycles`, `netlist/timing.ts`).
- Transient `time_domain` settings accept SPICE suffixes (`30m`) and `step_size` / `tmax`; the PWM period falls
  back to a carrier / PULSE source before 100 kHz (`detectPwmPeriod`).
- Ground: the minus pin of the main DC source (VIN, VDC, V_BUS ... or role `dc_bus` / `input_source` ...)
  grounds its net, not only `VIN` (`comp-nets.ts`).
- Single-phase diode bridge always gets an output capacitor `C_OUT` (`ensureDiodeBridgeFilterCapacitor`).
- Diode `.model` has no `Tt` unless the part sets one (`models.ts`).
- Nested resistors (snubbers) export `V_<ref>.csv` for the Thermal stage (not R_ISO / ground anchors); internal
  auto-telemetry (`Gate_`, `V_M_`, `I_D` ...) gets no interactive `plot` command (`control-blocks.ts`).
- Measurement parsing: the `print` echo only refines a `meas` value it agrees with (a cut echo `= 3.8` no longer
  replaces `3.810305e+02`) (`results/measurements.ts`).

Fixtures re-captured from the Part 1 reference (synced `0054f72` + chat-first `simulator/`): netlist, sync,
sizing, schematic, schematic-apply. The core's summary orders one part's parameters by Python's set (hash seed),
so the netlist and sizing specs sort them (`test/parity/design-summary.ts`). The schematic capture of
`dcdc_full_bridge_centertapped` / `half_wires` is not deterministic run to run (three ground labels permute;
`build_comp_nets` output was checked identical), so that fixture was kept. New unit tests:
`netlist/design-summary.spec.ts` (summary round trip, suffix parsing, PWM period, line cycles, measurement echo).
Tested: full jest suite (1597 passed), typecheck, lint of the changed files.
