# Topology test campaign (Chat-First cases)

Started 2026-10-22. Every case of the `Chat-First` tab of `Practical Converter Simulation Test Cases.xlsx`
(108 cases, 34 library topologies, plus 3 added cases for the single-switch forward, which the sheet did not
cover) was run through the backend's own pipeline, the failures were fixed, and the cases were run again.
The results workbook is `D:\qdonis_recent\Chat-First Test Results (new repos).xlsx` (one row per case:
baseline and after-fix numbers, observations, fix IDs; an issues tab with root causes and fixes).

## How the cases are run

A temporary jest spec (kept outside the repo in `D:\qdonis_recent\chat-first-test-harness`, with the scripts,
the raw results and a README on resuming; it runs as `src/zz-cases.spec.ts`, never commit it) drives the same
code the Studio uses, headless (no database, no S3):

1. Specs as the Studio agent writes them from "[Topology], Vin = .., Vout = .., Output power = ..": input /
   output voltage (AC inputs as RMS, three-phase as line-to-line RMS, inverter outputs as line-to-line RMS),
   output power, assumed 50 Hz line / output frequency, 1 % ripple, 95 % efficiency target, 40 °C ambient.
2. `specsToParameters` -> sizing exactly as `DesignSizingService.size` (deterministic adapters or the real
   Bedrock call with the sizing system prompt) -> decks.
3. `runJob('rerun')` (ngspice, results, loss analysis) -> `selectDevices` -> `completedSimulation`.
4. `planMagnetics` on a branch specs -> visualization -> design -> simulation.
5. Per topology: the Studio drawing (top level and every sheet) is rendered and its connectivity compared with
   the YAML nets (parts missing from the drawing, nets split into pieces, nets shorted together).

Pass criterion used in the workbook: output within ±3 % of the target (±5 % "marginal").

## Status (2026-10-22)

- Baseline (before the fixes): all 108 cases run; 44 within ±3 % of the target.
- After the fixes: 55 cases re-run so far (the full re-run was stopped twice by low memory on the laptop):
  54 within ±3 %, 1 marginal (diode bridge 24 V -> 21 V, +3.8 %). Not re-run yet: C025-C057 (interleaved
  buck, flyback, ACF, forward, push-pull, FB-CT, PSFB, LLCs, half bridge, CLLC, DAB 800 / 400 V) and C089-C111
  (flyback PFC 120 / 230 V, inverters, NPC, T-type, single-switch forward); the fixes that cover them were
  verified on individual cases (VSI 600 -> 380 V: 334 -> 381.5 V; H-bridge 380 -> 120 V: 0 -> 119 V).
- Every library drawing matches its netlist (connectivity check of all sheets).
- Open: **O1 DAB loss / magnetics at high power.** Output is right, but the ideal tank keeps a start-up DC bias
  (150-465 A in Lk at 1000 V / 50 kW) and the sawtooth gate logic glitches the opposite switch of each leg at
  every ramp reset, so the loss numbers are not reliable. A series DC-blocking capacitor (~87 uF) removes the
  primary DC (tested by hand); gates from a continuous phase (sin(2 pi f t), sin(2 pi (f t - ctrl)) with a dead
  band) remove the reset glitch; with blocking caps on both sides the currents become symmetric but the tank RMS
  still has to be checked before changing the template.
- To finish: re-run the not-yet-run cases (harness at concurrency 2-3 with nothing else running), then
  rebuild the workbook.

## Change log

### 2026-10-22 — fixes from the campaign

See the workbook's "Issues & fixes" tab for the per-case evidence; summary per change:

- **ngspice device currents (`save all`) — `ngspice/ngspice.runner.ts`.** All three deck sanitizers commented
  out every `save` line, including the generator's `save all @D1[id] @M1[id] ...`. Without it ngspice keeps
  only the last value of device-internal vectors, so every device probed that way (PFCs, flyback PFC, totem
  pole, Vienna, H-bridge, T-type, DAB) had a constant current: PFC switch 0.1 A, diodes 0 A, loss 0.02 W for
  1.5 kW. `save all ...` lines are now kept (they restrict nothing); other `save` lines are still removed.
- **Timeout / cleanup on Windows — `ngspice.runner.ts`, `rerun.pipeline.ts`.** On a timeout the runner
  rejected right after `kill`, before ngspice released its files; the scratch-dir cleanup then threw `EBUSY`,
  which replaced the timeout as the run's error. It now rejects once the process has exited (5 s grace), and
  the cleanup retries and never replaces the run's own result or error.
- **Magnetics thermal runaway — `engines/magnetics/magnetics-engine.ts`.** The loss -> temperature loop had no
  bound: past ~200 °C the Steinmetz fit explodes (core loss 4e12 W, temperature 1e21 °C, negative Bsat
  limit). Losses and Bsat are evaluated at most at 200 °C; such designs are reported as infeasible by the
  hotspot / rise checks instead of absurd numbers.
- **Magnetics switching frequency — `studio-stages/stage-math.ts`, `magnetics.stage.ts`.** The frequency came
  from the YAML inventory, which still had the template's value when the sizing changed a drive source the
  design table hides (DAB: 20 kHz instead of 70 kHz). It is now read from the design's decks (most common
  PULSE period, 1 kHz - 5 MHz), falling back to the inventory and the specs.
- **Inverter load inductors — `magnetics.stage.ts`.** Inductors with a `load` role (the VSI / T-type test
  load) are not designed as magnetic parts (they gave 100 kW "losses"); the result says they were skipped.
- **Open-loop output trim — new `sizing/open-loop-trim.ts`, `design-sizing.service.ts`.** The open-loop
  templates (buck, boost, buck-boost, SEPIC, Cuk, Zeta, FSBB, synchronous / interleaved buck, flyback, ACF,
  forward, two-switch forward, push-pull, half bridge, PSFB, full-bridge CT, HB / FB LLC, flyback PFC, 3-phase
  VSI, H-bridge) came out 3-15 % off target because the sized duty / turns ratio ignored the drops. After
  sizing, the output-setting transient requirement is simulated, the average (inverters: line-to-line RMS /
  RMS) measured and the knob rescaled through the converter's conversion law (duty: D, 1/(1-D) or D/(1-D);
  isolated: turns ratio; inverters: reference amplitude), at most twice, to within 1 %. The reasoning gets an
  "Output trim" section with each step.
- **Sizing AI timeout — `design-sizing.service.ts`.** 5 -> 10 min (the LLC / forward replies ran past 5 min
  under load: "Request cancelled" at 300 s); the Bedrock client already allowed 10 min.
- **3-phase VSI third-harmonic injection — VSI YAML, `adaptVsi`.** A common 1/6 third harmonic (new source V6
  in the references' return path) raises the linear range from 0.612 to 0.707 Vdc line-to-line, so
  600 V -> 380 V is reachable (m = 1.03 was capped at 1.0: 334 V).
- **Diode bridge average output — `adaptDiodeBridge`.** With the filter capacitor the output sat near the
  peak (+32-37 % for 207 V from 230 V). The capacitor is now solved (time-stepped bridge model,
  `bridgeAverage`) for the requested average; the reasoning states the ripple consequence.
- **Transformer rectifiers sized deterministically — `adaptTransformerRectifier`.** Centre-tapped: the model
  read the turns ratio per half winding (output at exactly half the target). Full-wave: unfiltered formula
  with a filter capacitor (+5-60 %). Both now solve the turns ratio for the requested average; the full-wave
  output capacitor is pre-charged (its R*C is ~1 s) and sized for >= 2 % ripple.
- **H-bridge gate capacitance — H-bridge YAML.** The ideal S switches have no gate capacitance; with the
  floating gate sources ngspice aborted ("timestep too small") for 2 of 3 sized designs (output 0 V). CG1..CG4
  (1 nF) are added. Its `target_vout_rms` criterion now follows the specs.
- **DAB gate logic — DAB YAML.** Hard comparisons on the phase ramps aborted ngspice at 1000 V / 50 kW
  (output 0 V); the gate logic and the secondary-ramp wrap use narrow tanh steps (~30 ns).
- **Resonant tanks — `adaptResonantTank`.** The model's CLLC tank for 400 -> 800 V resonated at 317 kHz with
  fsw = 100 kHz (output 84 V). The tank capacitors of the CLLC / LLCs are recomputed from the inductors when
  fr is more than 15 % off fsw.
- **Solver settings — Zeta, Cuk YAML.** reltol 0.001 / trtol 2 (Zeta) and 0.005 / 1.0 (Cuk) aborted or ran past
  400 s (garbage ripple) for sized designs; 0.002 / 4 runs in ~10 s with the same Vout.
- **Low-voltage devices — 15 Si MOSFET + 8 Si Schottky models, `part-ratings.ts`, `device-selection.ts`,
  `device-library.loader.ts`.** The library started at 400 V (SiC), so every 5-48 V design was costed with
  650-1200 V SiC parts (interleaved buck 1.2 V / 150 W: 200 W "loss"). Added first-order loss models of the
  Si MOSFETs of `mosfet_database.json` (30 / 100 / 200 V; conduction from Rds(on) with +0.65 %/K, switching
  0.5 V I (2 tr / 2 tf), body diode) and generic Si Schottky diodes (45 / 100 / 200 V); each file's
  `metadata.source` says how it was estimated. Part-number parsing no longer reads TI `CSD...` MOSFETs as
  5780 V Wolfspeed diodes, and the family label comes from `metadata.technology` (Si MOSFET / Si Schottky).
  `MANIFEST.json` lists 990 files (manifest spec updated).
- **Device current peak — `loss/device-selection.ts`.** The selection sized parts by the sample maximum of |i|,
  which caught the ns-wide charge spikes of the ideal device capacitances (DAB 800 V: 270-650 A on 25 A
  average -> 500 A modules). It now uses the 99.9th time-weighted percentile (voltage stays the maximum).
  The DAB body-diode model has no `Tt` any more (100 ns = ~5 uC recovery, 140 A spikes).
- **Parity fixtures re-baselined** for the intentional changes (everything else still matches qdonis-core):
  - schematic render / apply (H-bridge, VSI, DAB): re-captured with the core capture scripts on a
    `feature/synced-schematic` worktree with the new YAMLs; the same run on the old YAMLs reproduced the
    committed fixtures byte for byte;
  - netlist (Zeta, Cuk, VSI, H-bridge, DAB): from the TS generator (it matches core on every other
    template), Python `json.dumps(indent=1, sort_keys=True)` format;
  - sizing `vectors.json` (the 22 cases of the 11 changed topologies): from the TS sizing, written with a
    byte-exact Python-style dumper (verified by a round trip of the unchanged file);
  - studio: `_catalogue.json` (+23 parts, existing entries untouched), `_inventory.json` (H-bridge, VSI, DAB),
    H-bridge waveform stats, buck / flyback device selection (now Si parts).
- **Generated Prisma client** was stale (`emc` stage missing, typecheck failed in `studio-graph.repository.ts`);
  regenerated locally (`npx prisma generate`, git-ignored).
