# Step 3 progress: netlist generator port (done in chat, no workflow)

Branch: `feature/core-migration-catalog-visualization` in qdonis-backend and qdonis-web. NOTHING committed or pushed.

## Status: netlist generator DONE and verified

Port of qdonis-core `simulator/netlist_generator.py` (4,153 lines) + `simulator.generate_analysis_cirs`
into `src/simulation/netlist/` (pure functions, no Nest):

| File | Ports |
|---|---|
| `py.ts` | Python value semantics: YAML int = `bigint`, float = `number`; `str()`, `repr`, `format(x,'.6g')`, `'.Nf'`, `round()` with exact half-even; `float()`; dict `.get`/`[]` with Python errors |
| `py-eval.ts` | Safe tokenizer/parser for the arithmetic `eval()` the core ran on `{...}` / `{{...}}` (log10, log, sin, cos, sqrt, pi, e; int/float rules). Executes nothing. |
| `comp-nets.ts` | `build_comp_nets`, `need_pins`, pin aliases (`assets/spice/spice_components.json`), node / element-name resolution |
| `spice-command.ts` | `_process_spice_command`, `_token_to_expr`, measurement windows, `meas` lines |
| `models.ts` | `.model` lines (diode / BJT / MOSFET Kp tiers / JFET), subcircuit templates |
| `control-blocks.ts` | DC / AC / transient `.control` blocks incl. loss telemetry and plot commands |
| `netlist-generator.ts` | element emission, `generateNetlist`, `generateNetlistForAnalysis`, `generateAnalysisCirs` |

`pyyaml-schema.ts` gained `parsePyYamlDesign` (ints as bigint); catalog keeps raw YAML (`sources`) and
`TopologiesService.design(id)` returns a fresh design dict for the generator.

`POST /projects/:id/branches/:b/stages/visualization` now fills `netlist` (was null).

## Verification
- Parity fixtures: `test/parity/capture/netlist_capture.py` (core `generate_analysis_cirs`, all 35 topologies,
  105 decks + base netlists + control blocks). Spec `netlist.parity.spec.ts`: 33 topologies byte-identical;
  `acdc_flyback_pfc_dcm` / `dcdc_dual_active_bridge` depend on Python's hash seed in core itself — identical
  except which ground member the "Auto-grounded net N due to X" comment names.
- `test/parity/capture/pyformat_capture.py` -> 3,031 random doubles + 37 expressions from CPython; `py.spec.ts`
  matches `.6g`, `repr`, `.1f`, `.3f`, `round()` and `eval()` exactly.
- backend: lint clean, tsc clean (only teammate's pre-existing studio-branches.e2e-spec error), 297/297 unit
  tests, build OK. Live on :3199: picking dcdc_buck / LLC full bridge returns netlists identical to core.

## Known limits
- Designs that arrive as JSON (edited circuits from the frontend) lose Python's int/float distinction
  (`5` vs `5.0`) unless parsed with a type-preserving JSON parser; handle in the simulation step.

## Next
ngspice runner + output parser (`measure_and_plot.py`), Postgres job table, S3 for time series/plots;
then loss engine, device selection, waveform stats; then LLM sizing / edit-circuit / netlist ai-fix.

## Step 4 (in progress): ngspice runner + results (port of `/api/simulate/rerun` pipeline)
- ngspice found: `D:\Spice64\bin\ngspice.exe` (on PATH).
- Capture script `test/parity/capture/simulation_capture.py` runs core `generate_analysis_cirs` -> `NgspiceMeasurePlotter.execute_and_process(skip_plots=True)` -> `slice_steady_state(20ms)` -> `calculate_losses(tj=100)` and writes `test/parity/fixtures/simulation/<id>.json` (decks, raw measurements, results, plots, loss_analysis, time_series sha256). Full run started in background (dcdc_buck took 16.5 s).
- Python pieces to port (measure_and_plot.py): `execute_and_process` (deck sanitize: drop save/.save when telemetry present, strip `xl a b` from plot lines, `upgrade_legacy_telemetry`; run `ngspice -b -o <log> -n -q <deck>` cwd=out dir; `parse_measurements` of the log), `structure_simulation_results` (outputs via formula DSL [x]/{x}/names + eval with abs,max,min,sqrt,pow,log,log10,exp,sin,cos,tan,pi,e; depth ordering; TRIG/TARG CSV recovery; auto V_/I_ peak/rms injection), `embed_feasibility_in_results` (metrics.constraints target/actual/operator), `generate_plotly_figures` (lines 2529-3024, not read yet).
- Also needed: `signal_names.py` (upgrade_legacy_telemetry), `time_series_utils.slice_steady_state`, `loss_engine.calculate_losses`, `json_loss_model`, api_server `_device_types_for_yaml`, `_zip_directory_to_base64`, `_split_netlist_and_tail`.
- Rerun payload: {success, plotsResolution:'full', results, plots, netlist, analysis_cirs, loss_analysis, raw_time_series_zip, metadata{topology, analysis_type:'all', num_plots, has_netlist, rerun_from_edited_netlist}}.
