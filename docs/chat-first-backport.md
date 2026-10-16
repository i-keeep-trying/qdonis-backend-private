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
2. Topology library (done): the teammates' YAML / prompt fixes (VSI, NPC, T-type, 1-ph / 3-ph AFE, interleaved buck,
   flyback PFC, totem pole, DAB, full-bridge CT, Zeta, diode bridge; 11 prompts) merged into `assets/` keeping
   the `schematic:` layouts and control blocks; checked by running ngspice.
3. Deterministic sizing (`topology_improver.py` -> `simulation/sizing/`) — done: SI-prefix parsing, DAB output
   power references `{components.R_LOAD.resistance}`, single-phase PFC operating point and sizing, VSI / NPC /
   T-type / AFE sizing.
4. Loss vs junction temperature (loss engine + endpoint + chart); circuit inventory `power_sources`,
   `output_voltage`, `load_resistance`; waveform stats `links` of nested parts — done.
5. Devices folded into the Simulation stage (agent tools / prompt, stage list, web) — done.
6. Magnetics: operating point per part, editable per-part inputs, 3D model — done.
7. Thermal: nested-resistor loss fix, R_ISO excluded, cooling recommendation (+ agent rule) — done.
8. Simulation / Specs UI: split view, waveform viewer (toggle chips, DC output names), loss table, constraint
   domains — done.

## Change log

Newest first.

### 2026-10-16 — Part 8: Simulation and Specs UI (qdonis-web)

From web `6d59ca0`, `1309970`, `cab4f1f`:

- Simulation tab: tabs are now **Waveforms & losses** (waveforms left, losses right; stacked below ~1040 px
  through a container query), **Results** and **Netlist**. The losses column is the loss table, the library
  selection (`DevicesPanel`) and the compact loss-vs-Tj chart. The side-rail loss bars are gone (`loss-bars.tsx`
  removed).
- Loss table: Tj chip and models in the header, a share bar per device, the backend's total in a Σ footer. The
  switching-events column is gone. The gate-drive and leakage columns only show when a device has them; only the
  two default models carry Qg / I_leak data.
- Waveform viewer: in the split view, every signal is a toggle chip in one wrapping row, with All / Gates only
  and no header. Panels are 165 px high there. All panels share one time cursor (x spikes). DC output names
  (`V_DC_OUT`, `VDC`, `VDC_*` …) are shown by default, like `VOUT` (`isOutputSignal`).
- Specs: the constraints list is grouped for reading by engineering domain and sub-group
  (`constraint-domains.ts`, chat-first `constraintDomains`). It has domain tabs with counts and "need a value",
  a "Needs a value" filter, and open counts per group. The inspector shows domain · group and the category label.
  Stored categories are unchanged.

Not ported: the Tj input with Recalculate and the per-row part dropdowns of the old embedded `SimulationScreen`
loss table (and with them "parts picked in the loss table kept across re-runs", chat-first `loss_component_models`).
The new web never had that table: parts are changed through the device selection, which re-runs keep. Also not
ported: chat-first's "add constraint uses the open domain's category", because the new web has no add-constraint row.

### 2026-10-16 — Part 7: thermal

- `thermal.stage.ts` `passiveLosses`: a nested resistor without its own telemetry is now estimated from its own
  series capacitor and the parent pins it spans, using the waveform-stats `links` (Part 4):
  P = C·ΔV²·fsw·tanh(T/4RC). A secondary-side snubber sees n·ΔV_pri. The old estimate took the first capacitor
  under the parent and the primary voltage for every resistor, so RSN_P, RSN_S and R_ISO all showed the same
  0.11 W. When the part cannot be resolved, it is listed with "re-run the design and simulation to export it".
- R_ISO and other `*_ground_anchor` resistors are left out of the budget and listed under assumptions as
  "Excluded from the budget". They are SPICE references for the isolated side, not real parts.
- `thermal-engine.ts` `recommendCooling` produces `ThermalResult.cooling`: method tier, Rθsa target, heat, sink
  temperature, size from volumetric resistance (≈ 650 / 115 / 65 cm³·°C/W), airflow, mounting, alternatives and
  notes. The agent payload carries it as `cooling_recommendation`. The agent prompt now says to end every
  `run_thermal` with a "Recommended cooling" section (core `08fa795`; captured in Part 5's agent fixtures). The
  web shows a "Recommended cooling" card, and older results fall back to the heatsink card.
- Exported nested-resistor waveforms (`V_<ref>.csv`) came with Part 1.

### 2026-10-16 — Part 6: magnetics

- `studio-stages/magnetics-operating-point.ts`: the old frontend's `magneticsOperatingPoint.ts` (cab4f1f), ported
  verbatim with typed inputs.
  - It builds the converter operating point (Vin, Vout, Pout, η, fsw, line frequency, phases), taking each value
    from the specs first, then the design values, the circuit inventory (Part 4) and the simulation.
  - It then builds the winding waveforms of each part from the converter's steady-state relations: DC-DC CCM/DCM,
    flyback (also PFC), forward, bridges, LLC, DAB, PFC / AFE / inverter over a half line cycle, and the
    rectifier transformer.
- `planMagnetics` uses these estimates where a part has no simulated waveform, scaled to the plot-trace RMS when
  there is one. A dual centre-tapped primary is designed per half.
- Each requirement and design carries `inputs` (basis, rows, assumptions). The result carries `operatingPoint`,
  and the agent payload carries `operating_point` and `design_inputs`.
- Per-part overrides (6d59ca0): `partOverrides` / `clearOverrides` / `clearAllOverrides` on `POST …/magnetics/run`.
  - A circuit part with entered values is designed from idealised waveforms built from them.
  - The values persist in `data.overrides` until reset, and the payload lists them as `entered_in_workspace`.
  - Entered parts take the edits in place.
- Engine: `MagneticRequirement.inputs` → `MagneticDesign.inputs`.
- The magnetics view adds `inputs`, `coreGeometry` (library Ae / window, for the 3D model), `overrides` and
  `operatingPoint`.
- Web Magnetics tab:
  - **Part tabs.**
  - **"Input parameters" panel:**
    - It shows the converter operating point, the part's own operating point, and the design inputs per kind,
      editable. The inputs are prefilled from the entered values, or derived from the design: flyback
      D = 3·(Irms/Ipk)² and V_pri = λ/(D·T); transformer V_pri = 2λ·fsw.
    - It has Run design and Reset <ref>.
  - **3D model** (`magnetic-3d-model.tsx`, Plotly mesh3d):
    - Two core halves with a seam, and the gap highlighted and labelled.
    - Bobbin, pins, windings with the designed turns, layers and wire, tape, and lead-outs.
    - View presets and an X-ray toggle.

  Ambient was already editable in the settings bar.

Not ported: the old view's removal of the stat cards and large title, which is a layout choice the new web
does not share.

### 2026-10-16 — Part 5: devices folded into the Simulation stage

Core `326d618` and web `cab4f1f`: device selection is part of the Simulation stage. There is no standalone
selection from entered stresses.

- Agent: chat-first `studio_agent.py`.
  - `STAGES` has no `devices`.
  - `select_devices` is simulation-only: its `devices`, `fsw_khz`, `junction_temperature_c` and
    `from_simulation` inputs are gone.
  - The prompt lines changed, and the "Recommended cooling" rule was added.
  - Fixtures were re-captured. The Part 5 reference is the Part 4 reference plus chat-first `studio_agent.py`.
  - This keeps the backend's pre-synced `edit_circuit` wording: the synced-schematic core rewrote it, and that
    is the synced port's business.
  - The executor's `select_devices` reports to the simulation stage, and the snapshot has no `devices` section.
- `POST …/stages/simulation/devices` (was `devices/run`, without `inputs`) picks parts on the simulation's
  waveforms. It updates the simulation node in place (`rev + 1`; `forked` is always false) and never creates a
  devices node.
  - `selectDevicesFromStresses`, its compute job, DTO, format helper, parity test and `_standalone.json`
    fixture are removed. `studio_capture.py` no longer writes it.
- Stages: `STAGE_ORDER` (the rail, progress out of 6, branch DTOs) has no `devices`. `StageKind` keeps it as a
  former stage (`STAGE_KINDS`), so stored nodes still load and show in the history. Its results open the
  Simulation view. Thermal has no `devices` origin any more; old results keep theirs for display.
- Web:
  - The Devices view, the stress form and the device loss table are removed.
  - `StudioView` has no `devices`. `?view=devices` now opens Simulation, and the URL is rewritten.
  - `WorkspaceStage` is the rail's stages. History and branch labels use `STAGE_LABEL`, so old nodes still read
    "Devices".
  - `selectDevices` posts to the new route and returns the simulation node.
  - The mock store and fixtures have no devices node (store version 3).

### 2026-10-16 — Part 4: loss vs Tj, circuit inventory, waveform-stats links

- `loss-engine.ts`:
  - `lossesVsTemperature` and `modelTemperatures` (core `326d618`): each device is evaluated at every model
    temperature within −75…250 °C, on the same waveforms.
  - `calculateLosses` and the new function share `lossDevices`.
  - `JsonLossModel.temperatures` lists the tables' t axes.
- Compute job `lossVsTemperature`.
- `GET /projects/:projectId/simulations/:nodeId/loss-vs-temperature` returns
  `{ curves: [{ component, model, diodeModel, deviceType, points: [{ tjC, totalLossW, conductionLossW,
  switchingLossW }] }] }`. It uses the stored raw waveforms, the simulation's selected parts, and the device types
  of the branch circuit the node belongs to.
- Web: a loss-vs-Tj chart (`loss-temperature-chart.tsx`) with Tj marked, as one RTK query keyed by the parts in
  use.
- `circuitInventory` gets `power_sources` (power voltage sources, without sense / ref / carrier sources),
  `output_voltage` (analysis `target_vout` …) and `load_resistance` (core `326d618`).
- `waveformStats`: nested parts carry `links`, their `[ref, pin]` connections (core `08fa795`).

Parity: the Part 4 reference is the Part 3 reference plus chat-first `studio_waveforms.py`. The synced core already
had the loss engine and inventory changes, because `326d618` is the common ancestor.
- New `test/parity/capture/studio_derived_capture.py`:
  - It re-derives `waveform_stats` and adds `loss_vs_temperature` for the studio fixtures, from their committed
    archives.
  - It writes `_inventory.json`, the inventory of all 35 library topologies, read with the PyYAML-compatible
    loader.
- `studio.parity.spec.ts` checks both.

Tested (all parts):

| Repo | Checks |
|---|---|
| backend | full jest suite: 1608 of 1610 pass (1 skipped; the known dev-layout race failed `schematic.service.spec`, which passes alone); new `chat-first-stages.spec.ts`; typecheck; lint of the changed files |
| web | vitest: 100 tests, including new tests for constraint domains, the output-signal default and the scope panel height; typecheck; eslint |

Not run: the live app in the browser.

### 2026-10-15 — Part 3: deterministic sizing

Ported from core `topology_improver.py` (`a4fdaf2`, `7f41908`, `6b8f8dd`, `ed875a3`) into
`simulation/sizing/sizing.logic.ts`:

- `extract_numeric_param`: only the SI prefix written right after the number scales it (`65 kHz`, `200 mV`,
  `4.7 uF`); `380 VDC bus` or `325 V peak` no longer read as kilo / milli.
- Sized without the model (`prepareSizing`, as core checks them before any call): DAB (aliases), T-type,
  3-ph AFE, 1-ph AFE, diode bridge. DAB `pout_avg_w` divides by `{components.R_LOAD.resistance}`, so the
  design summary carries the load to re-runs.
- Scaled after the model's reply (`processReply`): single-phase PFCs (boost, interleaved, totem pole: line
  amplitude, load, divider, multiplier, loop target, integrator pre-charge, hold-up capacitor; flyback PFC: DCM
  on-time duty, Lm, turns ratio, snubbers, no diode Tt), VSI (modulation index and frequency of the SPWM
  references, gate drive, balancing resistors, Bv, per-phase load), Vienna, NPC (reference amplitude, Vdc/2
  normalisation, per-phase load), interleaved buck (phase-shifted high / low side PWMs with 40 ns dead time).
  For these and the AFEs every model edit to the control is dropped; elsewhere only behavioural-source
  expressions using `if(` / `limit(` ... (unsupported by ngspice).
- 3-ph AFE: chat-first tuning (0.5 / 0.1 mH, C_DC by power up to 15 mF, Kp 0.02, ki 500, current clamp,
  feed-forward 10 / (Vdc/2), 20 kHz carrier, `.model` lines without Tt, `use_ic`, 40-50 ms window, VOUT probe).
  1-ph AFE: `.param V_TARGET / V_PEAK`, Kp 0.05, ki 10, clamp, `.ic`, C_DC for 2x line ripple, Bv. Diode bridge:
  load, line resistance, C_OUT for the ripple (added if missing, also when the model names it), ratings,
  two-line-cycle window. T-type: R-L load, current reference and feed-forward amplitude / phase, C1 / C2,
  snubbers, midpoint `.ic`.
- Full-bridge centre-tapped (model path): turns ratio covers the rectifier drop (~0.8 V + 6 mOhm x Iout); Lm raised
  until the magnetizing current is under 10 % of the reflected load current.
- System prompt: "shunt resistors are not parasitics" (do not lower balancing / divider / pull-down / snubber
  resistors). Quick-params templates for the diode bridge.

**Control-block mapping (beyond chat-first).** The chat-first adapters write behavioural sources (`B_MULT`,
`B_Verr`, `B_ctrl_a`, `G_INT` ...) that the library rebuilt as control blocks, so their scaling silently went
nowhere. `controlUpdate` writes the block when only the block exists: MULT gain; REF_V value; LIM_PI / LIM_MAG
upper; INT_V ki / ic / upper; LPF_MAG ic; VAC_NORM / FF_D expressions; REF_x and K_FF_x / K_NORM_x gains; CAR;
the VSI's sine-source amplitude / frequency instead of a raw `SINE()` line. Blocks that already match need no
update (POL comparators, Vienna feed-forward on the measured bus, 1-ph AFE `V_TARGET` / `V_PEAK`). The same
change is in the parity reference. Without it: boost PFC 120 VAC -> 380 V gave 340 V, totem pole regulated to
the template's 400 V instead of 380 V.

Not ported: the 3-ph AFE's in-place migration of pre-block templates (`R_N_star`, `B_INT`), which no library
template or saved design has, and core's unreachable reply-path branches for the topologies sized without the
model.

Checked by sizing and simulating specs off the template point through the reference: boost PFC 120 VAC -> 380 V
378.4 V; interleaved PFC 400 V 399 V; totem 380 V 379.6 V; flyback PFC 12 V 11.5 V (9.7 V before); 1-ph AFE
380 V 380 V; 3-ph AFE 400 V -> 700 V 696 V; Vienna 800 V 806 V; NPC 400 V line-line 397 V; T-type 396 V; VSI
700 V -> 400 V 367 V (m = 0.93; drops); diode bridge 300 V 303.5 V. Interleaved buck: phases balanced (0.04 %),
but its output stays open loop on the model's duty (1.415 V at D = 0.1 for 1.2 V).

Parity reference: Part 2 reference + chat-first `topology_improver.py` + the block mapping. Re-captured: sizing
(sync unchanged; netlist / schematic do not use the sizing). Tested: sizing parity (76), full jest suite (the
known dev-layout race failed `schematic.service.spec` once; passes alone), typecheck, lint of the changed files.

### 2026-10-15 — Part 2: topology library

The teammates' YAML / prompt fixes merged into `assets/topologies` (`MANIFEST.json` updated: 967 files, 35
prompts). Base of every merge: core `326d618` (common ancestor); the library keeps the synced-schematic
control blocks and layouts. Per topology:

| Topology | Taken from chat-first | Kept from synced |
|---|---|---|
| flyback PFC (DCM) | real AC input (VAC sine, DB1-DB4 bridge, R_LINE, snubbers, bleeder), values, 12 V target | - (layout regenerated) |
| 1-ph AFE | retune as blocks: `KP_V` 0.05, `INT_V` ki 10 (G_INT 0.001 / 100 uF), `LPF_MAG` tau 2.2 ms, ic 18.44, R_DC 53.33 | blocks, layout, 400 V target |
| diode bridge | C_OUT; target 12.7 -> 16.7 V (with the capacitor) | layout |
| 3-ph AFE | 0.1 / 0.5 mH, 5 mF bus at 700 V, neutral divider 10k/10k, Kp 0.02, current loop = 10/350 v_phase feed-forward - 0.1 error clamped +-9.5 (new `K_FF_x`, `SUM_Fx`), 20 kHz carrier, swapped PWM polarity, no diode Tt, analysis, models | blocks incl. conditional anti-windup (layout regenerated) |
| totem pole | polarity detectors already high at v = 0 (no t = 0 shoot-through): comparator `threshold` -1e-6, `width` 1e-7; Pout formula references R_LOAD | blocks, layout |
| NPC | three-phase NPC (phases a/b/c, shared carriers), its analysis | each phase's loop rebuilt as blocks (`SUM_E_x`, `KP_x`, `INT_x`, `K_NORM_x` 1/400 ...), `CAR_UP/LOW` (layout regenerated) |
| T-type | 100 nF snubbers; one consolidated requirement (one run instead of three) | blocks / carriers (chat-first's PULSE carriers are the same waveforms), the 2026-10-11 fix: 20 A peak, 800 V bus / 400 V midpoint criteria, 60 ms, two-cycle windows |
| VSI | 50 Hz modulation, dead band (comparator `threshold` 0.2, `width` 0.02), gate gain 15 / 50 ohm, 100k balancing resistors, Bv 800, load-side phase + line-line measurements, 40 ms run; DC link minus tied to GND | blocks, layout, no `ac` / `time_domain` |
| interleaved buck | four phases | - (layout regenerated) |
| DAB, full-bridge CT, Zeta | Pout formula via R_LOAD; NMOS high side; NMOS high side | blocks / layouts; Zeta duty 0.526 + window |

Prompts: chat-first's (4 new); hand-made part names in them now also name the blocks (1-ph AFE, VSI), and "do not
edit behavioural sources" covers control blocks.

**Ground fix (beyond chat-first).** The Part 1 rule (chat-first `7f41908`) grounded the minus pin of every main
DC source / `input_source`; in circuits that have their own ground this shorts parts of the circuit: the NPC split
link (both rails to 0: ~112 V line-line instead of 380 V) and the flyback PFC's AC source (7 V, 1446 A line
current). Now VIN always, other main sources only when the circuit has no ground node / GND label
(`comp-nets.ts`; the same change in the parity reference's `build_comp_nets`). NPC now 376 V line-line
(217 V phase RMS for a 219 V reference), flyback PFC 9.7 V / 0.21 A.

Layouts regenerated from scratch (draft, automatic grouping) where the parts changed and the layout was untuned:
flyback PFC, interleaved buck, NPC (4 sheets), 3-ph AFE (6 sheets). Tuned layouts kept (new parts are placed by
the renderer: diode bridge C_OUT).

Verified by simulating synced / chat-first / merged through the core pipeline (outputs vs criteria): totem
400.03 V; 1-ph AFE 399.8 V (= chat-first); 3-ph AFE 702.0 V; T-type 20.75 A peak, midpoint 401.1 V; Zeta
11.98 V; full-bridge CT 12.15 V; DAB 59.0 V; diode bridge 16.65 V; VSI 158 V line-line (= chat-first; target 380
open); interleaved buck 1.65 V vs 1.2 V and flyback PFC 9.7 V vs 12 V as in chat-first (their templates rely on
the deterministic sizing, Part 3). Fixtures re-captured from the Part 2 reference (Part 1 reference + ground fix
+ this library): netlist, sync, sizing, schematic, schematic-apply. Full jest suite passes (the dev-layout spec
can race `manifest.spec` / `schematic.service.spec` on `dcdc_buck`, as before).

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
