# MTBF and BOM stages

The old app (qdonis / qdonis-core, `fix/added_topologies` and later) had MTBF Estimation and Bill of Materials
screens after Component Selection. The new Studio had the engines (`engines/reliability`, `engines/bom`) and
project-level endpoints (`/projects/:id/mtbf`, `/projects/:id/bom`), but no stage or web view, and those
endpoints read `projects.data.selectedParts`, which nothing in the Studio writes. Report Summary is out of scope
(the user's decision, 2026-10-16).

Plan (one part per turn, the user commits each):

- [x] Part 1: MTBF stage (backend + agent + web)
- [x] Part 2: BOM stage (backend + agent + web)

## Design

- MTBF is a Studio stage (`mtbf`) after Thermal: a node on the branch, like magnetics and thermal.
  `STAGE_ORDER` has 7 stages; DB enum `studio_stage` gains `mtbf` (migration `20261016120000_studio_stage_mtbf`).
- Parts come from the branch, not from a component-selection step:
  - the circuit inventory (library topology or the edited circuit, with design values);
  - switch and diode part numbers, peak voltage and voltage rating from the Simulation device selection;
  - junction / hotspot temperatures and status from the Thermal stage, magnetics hotspots from the Magnetics
    stage (core + material as the part), other parts at the ambient (Thermal, then specs, else 40 °C assumed).
- Left out by default (the user can include them): loads, source/line impedance models, winding/ESR
  resistors, solver helpers (`R_ISO`, ground anchors/ties, `*_drive`), MOSFET body diodes. Per-part
  include/exclude is stored as `settings.overrides`.
- Standalone mode: parts entered by hand (`origin: input`), like magnetics/thermal.
- The engine is the ported old one, unchanged (same formulas, statuses, current-stress default). Result:
  system MTBF/FIT, per-part λ, contribution, status, calculation details and curves, every standard at its
  environment (`byMethod`), issues.

- BOM is a Studio stage (`bom`) after MTBF (`STAGE_ORDER` has 8; enum migration
  `20261016180000_studio_stage_bom`). The shared parts logic lives in `src/studio-stages/branch-parts.ts`
  (circuit parts, default exclusions, device selection, magnetics designs), used by both MTBF and BOM.
- One line per physical part of the circuit (loads, line models, helpers and body diodes unlisted by default),
  with the Simulation device selection (manufacturer, part number, ratings), the custom-wound magnetics
  (core + material, turns, wire) and a heatsink line (`HS1`) from the Thermal cooling recommendation.
- Distributor parts: the user searches Mouser per line from the BOM view (existing `POST /sourcing/mouser/search`)
  and picks one. A whole-BOM automatic search was not done: Mouser pacing makes it minutes long. Prices are the
  first price break (single unit, USD), as in the old screen.
- The user's choices (`choices`: part, quantity, listed or not, added lines) are stored on the node and kept
  when the BOM is rebuilt from the branch; choices for parts no longer in the circuit are dropped.
- Export: XLSX / CSV of the listed lines through the existing `engines/bom` writer (old column layout), stored
  in S3, signed link.

## Change log

### 2026-10-17: NPC simulation, device choice and prices

Found on the 2 kW NPC project (BOM £8,967.75 for two lines, £992 per switch):
- The project's design and simulation date from 2026-10-15, before the NPC library fixes (Part 2 of
  `chat-first-backport.md`). Their decks are the old single leg with both DC sources grounded, so the bottom rail is
  the midpoint: SW4 and D_CLAMP_N see ~1 V, the output is wrong, and later "modify design" runs edited the same
  broken deck. On current code the library NPC simulates correctly (2 kW, 48 Ω/phase: 309 V line-line, 3.7 A,
  401 V on the outer switches). The project has to be re-designed from the circuit; nothing in the code reads the
  old decks.
- NPC library (`dcac_neutral_point_clamped.yaml`): nothing shared the off-state voltage of the inner switches, so
  SW2/SW3 ratcheted to 530-710 V (capacitive coupling at each output step, held only by the clamp diodes on one
  side). Added `R_SHARE2_x` / `R_SHARE3_x`, 100 kΩ across SW2 / SW3 of each phase (static sharing, as in hardware);
  1 MΩ was too weak (500-610 V). Inner switches now 403-433 V and all 12 switches get the same part. The renderer
  places the new parts (no saved positions, like the diode-bridge `C_OUT`). Manifest updated.
- Device ratings (`devices/library/part-ratings.ts`): `CAB525F12XM3` (F variant) was not parsed, so the LUT's
  800 V / 1100 A was used for a 1200 V / 525 A module; it entered the 650-800 V classes and won on loss. Module
  voltage now also reads `F`; modules named by current (`CAB450M12XM3`, `CAS120M12BM2`) take that current instead
  of the LUT's 2-3× range; the family check covers `A` / `F` codes. New `isModulePart`.
- Device selection (`simulation/loss/device-selection.ts`), a deliberate difference from qdonis-core: a module is
  only a candidate when no discrete part of the voltage class carries the peak current, and in `auto` the IGBTs
  (all modules) only compete when no discrete MOSFET does. Before: 800 V / 40 A picked `CAB004A12GM4`, 1000 V /
  15 A a 2300 V `CHB` module. The 2 kW NPC now gets `E4M0045075J2` (750 V discrete, £8.97) and `E6D10065A`
  (£4.33).
- BOM pricing (`SourcingService.exactPart`): Mouser lists some parts only as the reel (`E4M0045075J2-TR`); the
  lookup searches `BeginsWith` and takes the exact number, else a `-TR` / `REEL` packaging of it.
- Agent prompt (BOM line): no estimated costs, price ranges, per-category budgets or currency conversions; no
  recounting parts for another phase count (the agent had written a "$3,760-4,420 single-phase" table). 16 parity
  fixtures updated by script.
- Web: the Power devices panel is no longer `sticky` (with 18 devices it covered the loss-vs-Tj chart while
  scrolling); the loss-vs-Tj chart reserves a legend row per two curves (compact) and anchors the legend to the
  bottom of the plot (`yref: container`), so 18 curves no longer spill over the panel. Chat replies render `$` as
  text (`$$…$$` math still works): "$260 — $400" had become inline math.
- Parity fixtures: netlist, schematic, schematic-apply and sizing re-captured for the NPC from the Part 5 reference
  plus this YAML (the unchanged reference reproduced the old fixtures byte for byte first); studio `_catalogue.json`
  (43 rating / family fields) and `_inventory.json` (NPC, 6 resistors) written from the backend. The gated ngspice
  parity fixture for the NPC is still the old single-phase circuit and failed before this change too.
- Not changed: the specs ask 310 V RMS line-to-neutral (438 V peak) from 800 V, but the NPC's modulation limit is
  0.98 × 400 V = 392 V peak (277 V RMS); it needs ≥ 894 V DC, or 310 V line-to-line.
- Tests: `part-ratings.spec.ts` (ratings, module detection, discrete-first selection, module fallback),
  `sourcing.service.spec.ts` (reel packaging, exact first). Full suite 1634 pass (+ the known flaky schematic spec,
  passes alone); web typecheck, lint, 101 tests.

### 2026-10-16: accuracy pass on MTBF and BOM

Found by replaying the 2 kW NPC project (three-phase) through both planners:
- The circuit draws every phase leg (`SW1_a`, `SW1_b`, `SW1_c`), but the simulation runs one leg (`SW1`), and the
  device selection, thermal temperatures and magnetics designs use those refs. Nothing matched, so every switch and
  diode had no part, ran at the ambient in MTBF, and the BOM showed "Not sourced". `branch-parts.ts` `byRef` matches
  the exact ref first, then the ref without its phase suffix. MTBF and BOM both use it.
- BOM:
  - Designators with the same part are one line (`refs`, quantity = designator count). A change on a grouped line
    is sent for each designator; a designator changed on its own leaves the group.
  - The selected devices are looked up on Mouser by exact manufacturer part number (`SourcingService.exactPart`,
    run by `StudioStagesService` around `planBom`). Results are kept on the node (`lookups`). Parts Mouser does not
    list are retried on a plain rebuild. Without Mouser (not configured, rate limited) the lines stay unpriced.
  - Prices: the break for the line quantity, not always the first. A minimum order above the quantity is bought
    whole. 0-priced breaks are ignored. Currency comes from Mouser (the account's currency; GBP for this key), not
    an assumed USD. The total only adds lines in that currency.
  - Every unpriced line has a `note` saying why (not listed on Mouser, custom wound, heatsink to pick, no part yet).
  - The co-packaged diode name `X - DIODE` from the device selection is ordered as `X`.
  - The export takes the line's own price and currency, and leaves unpriced cells empty instead of `0.00`.
- MTBF: the selected devices' RMS current and current rating feed the engine's current stress (it used a
  placeholder 3 A / 4.5 A for every part). The engine reads the optional `rmsCurrent` / `ratedCurrent`; without
  them it behaves as before.
- Agent: the payload lists `refs`, the unit price and currency, and each line's note. Prompt item 8 and the BOM flow
  line now say devices are priced automatically and the phases are real parts, not duplicates. The 16 parity
  fixtures were updated by script.
- Web:
  - BOM: designators column, notes, "Mouser · matched" tag, quantity fixed for grouped lines, lines not on the BOM
    folded at the end, prices in the line's currency, `normalizeBom` for BOMs saved before this change. Mock store
    version 6, fixture migrated.
  - MTBF: the table shows the current stress.
- Dev setup: `MOUSER_API_KEY` added to the backend `.env` (the old frontend's `VITE_MOUSER_API_KEY`).
- Tests: BOM 11 (phase grouping, lookups and retry, quantity breaks), MTBF 11 (three-phase stress, temperatures and
  current). Full suite: 1629 pass, plus the known flaky schematic spec, which passes alone.
- Not fixed here, because it lives upstream (reported to the user):
  - Thermal sizes the heatsink for one leg.
  - The device library's rating for CAB525F12XM3 (800 V / 1100 A) disagrees with Mouser (1200 V / 525 A
    half-bridge module).
  - The simulation measures about 1 V peak on SW4 and D_CLAMP_N.

### 2026-10-16: agent fallback after a failed stage

In a chat, the agent called `run_mtbf` and `build_bom`, and both failed with `invalid input value for enum
studio_stage: "mtbf"` (and `"bom"`), because the two migrations above had not been applied to the dev database.
The agent then wrote a "manual" MTBF estimate and BOM and listed both stages as done. Fixes:
- Applied `20261016120000_studio_stage_mtbf` and `20261016180000_studio_stage_bom` to the local DB with
  `prisma migrate deploy`. Every environment needs the same step.
- System prompt (Style section): a failed stage tool means the stage did not run, so the agent must never put its
  own estimate or a "manual" result in its place, and must never report the stage as done. The 16 parity fixtures
  were updated by script with the same lines.
- Web: the chat header's stage list (`chat-pane.tsx`, `IDLE_SUBTITLE`) now ends in MTBF and BOM.
- Checks: agent and parity tests pass (147), web studio tests pass (62).

### 2026-10-16: Part 2, BOM stage

Backend:
- `src/studio-stages/branch-parts.ts` (shared with MTBF; MTBF refactored onto it, behaviour unchanged).
- `src/studio-stages/bom.stage.ts`: `planBom` (lines, heatsink, choices merge, pricing, totals, agent payload),
  `exportParts` for the export engine.
- `POST /projects/:id/branches/:branchId/stages/bom/run` (`RunBomStageDto`: optional per-line `changes`) and
  `POST .../stages/bom/export` (`BomExportDto`, `canExport`, activity logged, signed URL); `BomService.exportStage`.
  The project-level `/projects/:id/bom` endpoints (old `selectedParts`) are left as they were.
- Stage registration as for MTBF (graph, labels, views, chat view, Prisma enum + migration).
- Agent: `build_bom` tool (quantities, include/exclude, add/remove lines), `bom` in the stage enums, prompt item 8
  and the flow line, snapshot `bom` block; the parity fixtures updated by the same script as Part 1.
- Tests: `bom.stage.spec.ts` (7: no circuit, buck lines, devices/magnetics/heatsink, choices kept/reset and
  pricing, merge, export rows, all 35 topologies); progress total now 8. Full suite passes except
  `schematic.service.spec` "saved layout", which fails only in full runs: `dev-layout.service.spec` writes the
  topology layout files while it reads them (an existing race; it passes alone).

Web:
- Types `types/bom.ts`, schema `schemas/bom.ts`, service `runBom` / `exportBom` / `searchParts` (HTTP: Mouser
  results mapped to `SourcedPart`; mock: bookkeeping + CSV data URL), RTK mutations (`runBom` tracked by the save
  status), `bom` view/stage everywhere.
- View `components/views/bom/`: stats (parts, cost, manufacturers, in stock), filter, add a part, rebuild from the
  branch, table (list checkbox, part with its source, package, quantity, prices, availability/lead time,
  datasheet, Find on Mouser with a result picker, reset part, remove added line), totals row, Excel / CSV export.
- Mock: buck demo seeded with a BOM node (planner output), store version 5; mock-service BOM test.
- Checks: typecheck, lint, 101 tests pass. Not checked in a browser (login redirect).


### 2026-10-16: Part 1, MTBF stage

Backend:
- `src/studio-stages/mtbf.stage.ts`: `planMtbf` (parts, operating points, exclusions, engine, summary/payload).
- `POST /projects/:id/branches/:branchId/stages/mtbf/run` (`RunMtbfStageDto`); `StudioStagesService.runMtbf`
  (agent) and `runMtbfStage` (web; the form's overrides replace the stored ones).
- Stage registration: `STAGE_ORDER`/`STAGE_LABEL`, `VIEW_OF`, chat `StudioView`, Prisma enum + migration,
  `stageDataView` adds the method/environment `catalog`.
- Agent: `run_mtbf` tool, `mtbf` in the `open_view` / `manage_branch` enums, prompt item 7 and MTBF lines, executor,
  snapshot `mtbf` block. This is a deliberate difference from qdonis-core: the 16 studio-agent parity fixtures were
  updated by script (tool inserted after `run_thermal`, enum entries, the same prompt edits); everything else in
  them still matches the core capture.
- Tests: `mtbf.stage.spec.ts` (10: no circuit, buck parts/exclusions, device/thermal/magnetics inputs, kept
  settings, environment effect, wrong environment, standalone, AFE and isolated-side exclusions, all 35
  topologies finite); progress total is now 7. Full suite: 1619 pass; lint errors only in untouched files.

Web (`qdonis-web`):
- Types `types/mtbf.ts`, schema `schemas/mtbf.ts`, `runMtbf` in the service (HTTP + mock), RTK mutation,
  retry and save-status tracking, `mtbf` view/stage everywhere (`STUDIO_VIEWS`, labels, stage data check).
- View `components/views/mtbf/`: headline stats, standard/environment bar with pending include/exclude changes
  ("Apply n changes"), donuts by part and type, parts table (count checkbox, temperature and its source, voltage
  stress, λ, share, status, expandable formula/factors/curves), standards comparison, issues/recommendations,
  assumptions; empty state (estimate from circuit / enter parts) and the entered-parts form.
- Mock: buck demo seeded with an MTBF node (fixture generated by the backend engine), store version 4.
- Checks: typecheck, lint, 100 tests pass. Not checked in a browser (the dev server redirects to login).
