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
