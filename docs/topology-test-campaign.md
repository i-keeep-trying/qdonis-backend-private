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
- After the fixes (both rounds, see the change log): all 108 cases re-run, **all 108 within ±3 %** of the target
  (largest error 2.1 %, Vienna C073). The full re-run showed 9 cases still off after the first round (half bridge, CLLC,
  DAB 400 V, T-type 380 V, diode bridge 21 V); the second round fixed them. Second-round cases were re-run with
  the model replies recorded in the first run (same sizing input, no new Bedrock call).
- Every library drawing matches its netlist (connectivity check of all sheets, all 35 topologies, after the
  DAB and T-type template changes).
- Open: **O1 DAB loss / magnetics at high power.** Output is right (all three DAB cases within 1.2 %), but the
  ideal tank keeps a start-up DC bias (about 100 A in Lk at 1000 V / 50 kW) and the primary ramp reset still
  glitches the opposite switch of each leg, so the loss numbers are not reliable. A series DC-blocking capacitor (~87 uF) removes the
  primary DC (tested by hand); gates from a continuous phase (sin(2 pi f t), sin(2 pi (f t - ctrl)) with a dead
  band) remove the reset glitch; with blocking caps on both sides the currents become symmetric but the tank RMS
  still has to be checked before changing the template.

## Change log

### 2026-10-23 — simulation runs killed as "interrupted" (run queue, not a topology)

- **Pool time zone — `src/prisma/prisma.service.ts`.** The Prisma pg adapter sends DateTime values without an
  offset; the local Postgres session is `Asia/Calcutta`, so every timestamp the app wrote landed 5 h 30 min in the
  past (`created_at` 15:35Z next to `started_at` = `NOW()` 21:05Z for the same run). Run leases were therefore
  expired the moment they were written: with `SIMULATION_CONCURRENCY=2` the poller (every 5 s) re-claimed the
  running run into the free slot (a duplicate ngspice), and the next re-claim (attempts > 2) failed it with "The
  simulation was interrupted before it finished". Short runs got away with it; minute-long ones (DAB, 2-5 min) did
  not — run `73c518ce` (DAB 500 V -> 800 V, 20 kW) failed after 95 s with 4 attempts. The pool now sets
  `-c TimeZone=UTC`. Timestamps already in the database stay shifted.
- The campaign harness calls the simulation pipeline directly, not through the run queue, so it never hit this.
- **Stuck chat tool card — `qdonis-web/src/features/studio/hooks/use-chat-stream.ts`.** The backend restart
  reset the chat stream (`ERR_CONNECTION_RESET`); the backend stored the reply as `stopped` ("Running ngspice:
  Stopped"), but the web hook only set an error banner and never refetched, so the card kept spinning
  ("working...") until a reload. A stream that drops after the turn was accepted is now followed like a turn
  picked up after a reload (the same poller, now shared as `follow`): it polls `chat/runs/active` every 2 s,
  tolerating up to 15 failed checks (~30 s, a backend restart), refreshes the conversation and workspace, and
  shows the stored reply when the turn ends. If the server stays unreachable, the reply is marked stopped
  locally and the "could not be reached" banner shows. Typecheck, lint and studio tests pass; the drop itself
  was not reproduced in the browser.

### 2026-10-22 (later) — fixes from the full after-fix re-run

The first round's fixes were committed (0d8b248); the full re-run of the remaining cases then showed these:

- **Half-bridge output trim never ran — `sizing/open-loop-trim.ts`.** The trim simulated only the requirement
  that states `target_vout`; the half bridge states it only on its line / load steps, which measure deviations,
  so no output was found and the trim stopped silently (C052-C054 at -4 to -10 %). When that requirement does
  not measure the output, the first one that does (`vout_avg*`, `vout_steady*`, ...) is used; every other
  topology keeps its requirement.
- **CLLC added to the open-loop trim — `open-loop-trim.ts`.** It was missing (the LLCs had it): 400 / 800 V
  cases came out 5 % low.
- **Resonant tank repair by Q — `sizing.logic.ts` (`adaptResonantTank`).** The first fix kept the model's L
  and recomputed C. For the 800 V / 50 kW CLLC the model's L*C was 66x off, and keeping L gave a Q = 3.3 tank
  (527 V instead of 800 V). The tank is now moved to fsw by keeping L, keeping C or keeping sqrt(L / C),
  whichever leaves Q (sqrt(L / C) over the reflected AC load 8 R / (pi^2 n^2), per side of T1) closest to 0.4;
  the reasoning says which was kept.
- **DAB secondary gates — DAB YAML.** The smoothed (tanh) wrap of `sec_ramp` (first round, needed at 50 kW)
  swept through mid values once per cycle and turned the secondary switches on in the wrong state: tank DC
  72 A, 370 V for 400 V at 10 kW (C059 -0.3 % -> -7.5 %). `sec_ramp` is now the unwrapped ramp - ctrl and S5..S8
  use windows on it (0..0.48; 0.50..0.98 plus the part below -0.02): C058 / C059 / C060 within 1.2 %.
- **T-type third-harmonic injection — T-type YAML, `adaptTType`.** 600 V DC -> 380 V line-to-line needs
  0.633 Vdc, above the 0.612 Vdc of sine modulation (feed-forward capped: 362.9 V, -4.5 %). A 1/6 third harmonic
  in series with each phase's feed-forward (new V_VFF3_A/B/C, one per control sheet, same phase for all three)
  drives no current into the floating load star and lifts the range to 0.707 Vdc; the feed-forward cap is
  raised to 9.5 * 2 / sqrt(3).
- **Diode bridge drop — `adaptDiodeBridge`.** The capacitor solve assumed 1.6 V for the two conducting diodes;
  the template diode drops ~0.4 V each at these currents, so 24 V -> 21 V came out +3.8 %. The drop now comes
  from the template diode's Shockley + Rs model at the mean conduction current (pi / 2 I_dc).
- **Fixtures:** DAB and T-type schematic / schematic-apply re-captured with the core scripts on a
  `feature/synced-schematic` worktree (method re-validated: the committed YAML reproduced the committed fixtures
  byte for byte); netlist (DAB, T-type) from the TS generator; sizing vectors of the DAB, T-type, diode bridge,
  CLLC and LLC cases (only those case blocks re-written); studio `_inventory` (DAB, T-type); `MANIFEST.json`.
  The full jest run also showed that round 1 had not re-captured the schematic-apply fixtures of the Zeta and
  Cuk (their solver options changed); both re-captured the same way (validated on the pre-campaign YAML). The
  T-type layout keys are in the DEV-LAYOUT writer's order (`layout-yaml.spec`).
- **Test note:** `dev-layout.service.spec` rewrites `dcdc_buck.yaml` and `MANIFEST.json` while it runs (and
  restores them); in a parallel jest run `schematic.service.spec` can read the buck mid-rewrite and fail on
  `tuned`. Pre-existing; both pass alone and with `--runInBand`.

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
