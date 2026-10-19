# Requirements: Entry step (single-step mode) for Qdonis Studio

Repos: `BE` = `g:\Qdonis\qdonis-backend` (NestJS 11, Prisma 7), `FE` = `g:\Qdonis\qdonis-web` (Next.js 16, RTK Query).
Builds on `investigation.md` in this folder. Paths are relative to each repo root.

## 1. Summary

Qdonis must serve both single engineering tasks ("do I need a heatsink?", "simulate this .cir") and whole product
lifecycles. Every project gets exactly one **entry step**, set from the first prompt:

- **Start from scratch** = entry step **Specs** = today's full flow, unchanged.
- Any other choice sets the entry step to that step. From then on the project is **forward-only**: the user can run the
  entry step again and any step **downstream of it by data flow**, never an earlier step.

On the first prompt the agent works out intent. If the user clearly asks for one step, that step is set without a
choice widget. If the prompt is general, the chat shows options (scratch or a step, with a recommendation). For a chosen
step, **deterministic code** works out which required inputs are missing. The model only judges intent ("are these the
only inputs, and should Q assume the rest?"). Missing inputs are asked for in the chat with the existing value-table
widget plus a "Q fills the rest" action. Assumed values are listed in the chat and recorded with provenance on the
stage node. If a step depends on an earlier step whose output the user cannot supply, Q suggests starting at that
earlier step instead.

All steps are offerable as entry steps: the 7 existing stages plus **EMC, MTBF, BOM and Component selection**, which
become real stages (agent tools, stage nodes, workspace views). The side panel shows only the entry step and
downstream steps that are unlocked or done. Dashboard cards show an entry-step badge. Existing projects behave exactly
as today.

## 2. Terms

| Term | Meaning |
|---|---|
| Step | A Studio stage the user sees: Specs, Circuit (`visualization`), Design, Simulation, Devices, Magnetics, Thermal, EMC, Component selection, BOM, MTBF. |
| Entry step | The single step a project starts at. Stored per project (shared by all collaborators and all branches). Absent = undecided or legacy (see §5.1). |
| Full project | A project whose entry step is Specs, or a legacy project. |
| Scoped project | A project whose entry step is not Specs. |
| Downstream of X | Every step reachable from X in the data-flow graph (§4). X is not downstream of itself. |
| Upstream of X | Every step from which X is reachable. |
| Allowed steps | The entry step plus its downstream steps. |
| Step inputs | The values a step needs to run, declared in a per-step input contract (required / optional, label, unit, "one of" groups, whether it can be assumed, and which upstream step can supply it). |
| Input record | A node of an upstream stage that the entry step's own service needs as a precondition (e.g. a `visualization` node for Design, an imported `.cir` design node for Simulation). It is an input of the entry step, not a step the user runs or sees. |
| Provenance | Per input value: `user` (typed or uploaded by the user), `assumed` (proposed by Q), `derived` (read from an existing node or computed from other inputs). |

## 3. User stories

- US-1 Intent: As an engineer with a narrow task, I state it in my first prompt and Q starts that step only, without making me walk through specs and topology.
- US-2 Choice: As a user with a general prompt, I am offered "start from scratch" or a specific step, with Q's recommendation and why.
- US-3 Inputs: As a user of a single step, I see exactly which inputs are missing and can fill them in, or tell Q to fill the rest.
- US-4 Assumptions: As a user, I can see which values Q assumed, in the chat and in the step view.
- US-5 Dependencies: As a user who asks for a step I cannot feed (e.g. simulation with no netlist), Q tells me and offers to start at the step that produces what is missing.
- US-6 Forward-only: As a user of a scoped project, I can carry on to steps that use my result, but the project never turns into a different or earlier task.
- US-7 Side panel: As a user of a scoped project, the workspace shows only my step and the steps after it that are available or done.
- US-8 New steps: As a user, I can start a project at EMC, MTBF, BOM or Component selection, the same way as at any other step.
- US-9 Dashboard: As a user, I can tell from the dashboard which step each project starts at.
- US-10 Collaboration: As a teammate, opening a scoped project shows me the same scope, and my agent obeys it.
- US-11 Continuity: As an existing user, my existing projects and "start from scratch" behave exactly as today.

## 4. Data-flow graph (defines "after")

"After" is defined by which steps consume a step's output, **not** by tab order. `STAGE_ORDER`
(`BE src/projects/studio/studio-graph.ts:10`) is display-only and must not be used for this rule.

Edges grounded in current code:

| Edge (producer → consumer) | Evidence |
|---|---|
| Specs → Circuit | topology suggestions use approved specs (`suggest_topologies`, `BE src/studio/agent/studio-tools.ts`) |
| Specs → Design (soft) | AI sizing from ready specs, else library defaults (`BE src/simulation/simulation.service.ts:157-205`) |
| Circuit → Design (hard) | design needs a ready `visualization` node (`simulation.service.ts:169-175, 229-234`) |
| Design → Simulation (hard) | simulation needs design decks (`BE src/studio-chat/studio-tools.executor.ts:780-795`) |
| Simulation → Devices | auto device selection on simulation (`studio-tools.executor.ts:845-853`), `select_devices` from branch simulation |
| Design, Simulation → Magnetics | `BE src/studio-stages/magnetics.stage.ts:219-226` reads design, visualization, simulation |
| Simulation, Devices, Magnetics → Thermal | `BE src/studio-stages/thermal.stage.ts:328-352` reads simulation, design, visualization, magnetics, devices |
| Design → EMC | EMC inputs are PFC inductor, filter caps/inductor, bus voltage, input power/voltage (`BE src/studio-stages/dto/stages.dto.ts:179-207` `EmcParametersDto`) |
| Thermal → MTBF | MTBF uses thermal components / temperatures (`BE src/studio-stages/studio-stages.service.ts` `projectMtbf`, `thermalOf`) |
| Component selection → MTBF, BOM | MTBF and BOM read selected parts (`studio-stages.service.ts` `projectMtbf`; `BE src/studio-stages/bom.service.ts` `partsOf`) |
| Design, Devices, Magnetics → Component selection | parts to source come from design values (passives), selected semiconductors and magnetics (Outcome B, §6.10) |

Specs soft-feeds Magnetics and Thermal (fsw, ambient via `specTemperatures`/`specValue`). Soft edges count for
"downstream" only through the paths above; they never make a step upstream-required.

Required downstream closure (allowed steps besides the entry step itself):

| Entry step | Downstream steps |
|---|---|
| Specs | all other steps (full flow) |
| Circuit | Design, Simulation, Devices, Magnetics, Thermal, EMC, Component selection, BOM, MTBF |
| Design | Simulation, Devices, Magnetics, Thermal, EMC, Component selection, BOM, MTBF |
| Simulation | Devices, Magnetics, Thermal, Component selection, BOM, MTBF |
| Devices | Thermal, Component selection, BOM, MTBF |
| Magnetics | Thermal, Component selection, BOM, MTBF |
| Thermal | MTBF |
| EMC | none |
| Component selection | BOM, MTBF |
| BOM | none |
| MTBF | none |

Under Outcome A (§6.10, Component selection is the Devices stage) the "Component selection" rows merge into Devices,
and Devices gains BOM and MTBF downstream.

## 5. Functional requirements

### 5.1 Entry step model and persistence
- FR-1 Each project stores at most one entry step, at project level (`projects.data.studio`, next to `initialPrompt` and `focus`; `BE src/projects/studio/studio-persistence.ts:434-469`). It applies to every branch and every collaborator.
- FR-2 States: `undecided` (new project, no entry step yet), `specs` (full), or one non-Specs step (scoped).
- FR-3 A project with no stored entry step that has at least one stage node, at least one chat message from any user, or legacy wizard data is a full project (legacy). It is never shown the choice widget.
- FR-4 Only users with edit rights (`canEdit`) can cause the entry step to be set. Concurrent first prompts on an undecided project must not produce two different entry steps; the first write wins and later turns use it.
- FR-5 Once set, the entry step changes only through an accepted dependency redirect (§5.5), and only to a step upstream of the current one, and only while the current entry step has no `ready` node. There is no "expand to full project" and no switch to an unrelated step.
- FR-6 The workspace API (`GET` workspace, `StudioGraphService.workspace`) and the project list API return the entry step.

### 5.2 Intent handling on the first prompt (undecided projects only)
- FR-7 The first user message of an undecided project is classified for intent by the model: (a) explicit single step, (b) general/ambiguous, plus whether the user said these are the only inputs and Q should assume the rest, plus any input values the model extracted.
- FR-8 Explicit step: the entry step is set immediately, no choice widget is shown, and the same turn continues to input evaluation (§5.4). A small notice in the chat states the step that was chosen.
- FR-9 Ambiguous: the chat shows an options widget with "Start from scratch" and the steps (all 11 offerable), one marked recommended with a one-line reason. The answer sets the entry step on the server, deterministically, without relying on the model reading button text.
- FR-10 If the user explicitly asks for several steps, the entry step is the one from which all others are downstream. If no such step exists, the prompt is treated as ambiguous.
- FR-11 If classification yields no usable result, the options widget is shown without a recommendation.
- FR-12 While undecided, a typed message instead of a widget answer is classified again; the entry step stays undecided until set.

### 5.3 Full flow (entry step Specs, and legacy)
- FR-13 For full projects, the system prompt and tool list sent to Bedrock are byte-identical to today's `buildStudioRequest` / `buildStudioTools` output for the same snapshot (`BE src/studio/agent/studio-request.builder.ts`, `studio-tools.ts:47`).
- FR-14 After "Start from scratch" is chosen, the classification exchange is not replayed to the model, so the first full-flow turn sees the same transcript as a project created today with the same initial prompt.
- FR-15 The scope-less builder call stays byte-identical, so `BE src/studio/agent/studio-request.parity.spec.ts` passes unchanged with unchanged fixtures.
- FR-16 Full projects keep today's side panel (7 views), progress formula (`BE src/projects/project-progress.ts` `studioProgress`, out of 7) and `fields` suppression once a spec table exists (`studio-tools.executor.ts:390-399`).

### 5.4 Step inputs and missing-input evaluation (scoped projects)
- FR-17 Each step has an input contract. Missing-input computation is deterministic code: given the contract, the values extracted from the user, and nodes on the branch, it returns the missing required inputs. The model does not decide what is missing.
- FR-18 For Devices, Magnetics and Thermal the contract's result must agree with the existing engine validators (`BE src/simulation/loss/device-selection.ts:626-702`, `magnetics.stage.ts:82-205` `partRequirement`, `thermal.stage.ts:421-456`).
- FR-19 Inputs available from an existing node on the branch are `derived` and not asked for.
- FR-20 Decision table after the entry step is set:
  - all required inputs present → run the step;
  - some missing and the user said to assume the rest → Q assumes them and runs;
  - some missing and no such instruction → ask in chat (FR-21).
- FR-21 The ask uses the existing `fields` value-table pattern (`FE src/features/studio/components/chat/widgets/fields-widget.tsx`): rows are generated from the contract by the server (the model cannot drop a required row), pre-filled with extracted values, blank cell = "Q proposes". The widget adds a "Q fills the rest" action that submits immediately and treats every blank cell as assumed.
- FR-22 For step inputs, the suppression of the value table once a spec table exists (`studio-tools.executor.ts:390-399`) does not apply.
- FR-23 After any run that used assumed values, the chat lists them (name, value, unit) in the assistant reply.
- FR-24 The stage node records provenance (`user` / `assumed` / `derived`) for every input it used. The step view shows it (e.g. an "Assumed" badge) and lets the user edit an assumed value and re-run, using the existing standalone forms where they exist (`FE .../views/thermal/thermal-view.tsx`, `magnetic-part-form.tsx`, `device-stress-form.tsx`).

### 5.5 Dependency redirect
- FR-25 Each contract marks which required inputs can be assumed. A required input that is the output of an upstream step and cannot be assumed (e.g. a netlist) triggers a redirect suggestion when the user cannot supply it.
- FR-26 The suggestion is shown in the chat as options: start at the producing step (recommended), supply the input (e.g. upload a `.cir`), or keep waiting. Accepting sets the entry step to the earlier step (FR-5) and runs §5.4 for it.
- FR-27 Required minimum rules: Simulation with no design decks and no `.cir` → suggest Design. Design with no topology the user can name, and no permission to assume one → suggest Circuit. Simulation with an uploaded `.cir` is valid standalone (`import_netlist` creates the design node as an input record).
- FR-28 Redirect is recursive: if the suggested step itself lacks a non-assumable input, its own suggestion follows (Simulation → Design → Circuit).

### 5.6 Forward-only enforcement
- FR-29 In scoped projects the agent is offered only tools for allowed steps, plus conversation tools (`ask_user`, `open_view`, `manage_branch`) and input-record writes the entry step needs (e.g. `select_topology` / `import_netlist` for Design / Simulation input capture).
- FR-30 The server rejects any tool call or REST stage write for a step outside the allowed steps, regardless of the prompt. The tool result tells the model the step is upstream of the entry step; no node is written. The prompt is not the boundary.
- FR-31 When the user asks for an upstream step, Q explains it is earlier than the entry step and suggests a new project for it.
- FR-32 Re-running the entry step is always allowed. It follows `commitStage` semantics (`studio-graph.ts:187`): in place when the node is the head with no children, a fork with the existing fork notice when downstream nodes exist. The entry step does not change.
- FR-33 After the entry step completes, Q may offer directly downstream steps as next actions; it never offers upstream steps.

### 5.7 Side panel and navigation (FE)
- FR-34 For scoped projects, the stage rail (`FE src/features/studio/components/workspace/stage-rail.tsx`, which today maps all `STUDIO_VIEWS`, `FE src/features/studio/types/stage.ts:19`) shows the entry step plus downstream steps that are unlocked or done, in data-flow order. Keyboard navigation covers only those.
- FR-35 A downstream step is unlocked when at least one of its direct producers that is visible has a `ready` node. Done = has a node (ready, running or error).
- FR-36 Upstream steps and input records are never shown as steps. An input record (e.g. Design's topology, Simulation's imported netlist) is visible inside the entry step's view as an input with provenance.
- FR-37 `?view=` for a non-visible step (`FE src/features/studio/hooks/use-studio-view.ts`) is clamped to the entry step's view; backend `defaultView` honours the entry step. Links from tool chips and the history drawer to non-visible steps do not open those views.
- FR-38 Undecided projects show today's side panel.

### 5.8 New steps: EMC, MTBF, BOM, Component selection
- FR-39 Each becomes a real stage: `StudioStage` enum value (`BE prisma/schema/enums/studio-stage.prisma`, shipped as a Prisma migration), stage node data, agent tool and executor handler, input contract, workspace view, FE `StageKind`/`StudioView` types and zod schemas, mock service support.
- FR-40 Each runs standalone from entered/assumed inputs, or derives inputs from upstream nodes on the branch when present.
- FR-41 EMC inputs: `EmcParametersDto` fields (`stages.dto.ts:179-207`); runs the existing scan/spectrum engine; stores the result on an EMC node.
- FR-42 MTBF inputs: prediction method, environment (`GET /calculators/mtbf/options`), parts list (designator, type, optional part number), optional temperatures from a Thermal node; uses the existing engine (`studio-stages.service.ts` `mtbf`); stores the result on an MTBF node.
- FR-43 BOM inputs: selected parts (from a Component selection node, or entered); produces BOM rows and summary (`BE src/engines/bom/bom.ts`) on a BOM node; export goes to S3 as today (`bom.service.ts` `export`).
- FR-44 Existing endpoints keep their contracts: `CalculatorsController`, `ProjectMtbfController`, `BomController` (`studio-stages.controller.ts`) still work on legacy `data.selectedParts`.
- FR-45 New stages are not added to the full-flow request (FR-13). See open question O-1.

### 5.9 Component selection (open point, resolved in design)
- FR-46 Outcome A: Component selection is the existing Devices stage (`select_devices`, catalogue in `device-selection.ts`). It is offered under the label "Component selection" (or both labels map to the same stage), no new enum value, and BOM/MTBF consume the devices node's selected parts.
- FR-47 Outcome B: Component selection is a separate stage that sources parts (passives, magnetics, semiconductors) through the existing Mouser integration (`BE src/sourcing/sourcing.service.ts`, `POST /sourcing/mouser/search-by-specs`). It consumes design values, devices and magnetics nodes, or entered part specs, and stores the user's chosen parts on its node for BOM and MTBF.

### 5.10 Dashboard
- FR-48 Project cards (`FE src/features/dashboard/components/project-card.tsx`) show an entry-step badge (e.g. "Magnetics") for scoped projects. Full, legacy and undecided projects show no badge (assumption A-3).
- FR-49 Progress for scoped projects counts ready steps out of the steps currently shown in the side panel. Full projects keep today's formula.

## 6. Non-functional requirements

- NFR-1 Parity: `studio-request.parity.spec.ts` passes with no fixture changes.
- NFR-2 Security: forward-only and entry-step writes are enforced server-side (executor and REST services). All new routes stay behind the global `JwtAuthGuard` and use `ProjectAccessService` (`canEdit` for writes).
- NFR-3 Data: the entry step lives in `projects.data.studio` JSON (no migration for it). Enum additions for new stages ship as one new Prisma migration that only adds enum values. Provenance lives in node `data`.
- NFR-4 Storage: any new files (EMC plots, BOM exports) go to S3 only. No Supabase.
- NFR-5 Cost/latency: intent handling adds at most one model step to the first turn of an undecided project and none to later turns or to full projects.
- NFR-6 Mouser (Outcome B): rate limit, cache and `SupplierNotConfigured` (unset `MOUSER_API_KEY`) behaviour are reused, not re-implemented. No new env vars unless added per AGENTS.md rules.
- NFR-7 Quality gates: BE `npm run lint:check`, `npm run typecheck`, `npm test`; FE `npm run typecheck`, `npm run lint`, `npm test` all pass.

## 7. Acceptance criteria

Each criterion is independently testable. "Scoped(X)" = a project whose entry step is X.

### Entry step model
1. Creating a project and sending no message leaves the entry step `undecided`; `GET` workspace returns that state.
2. A project with no stored entry step and at least one stage node is returned as full (Specs) by the workspace API, and its next chat turn shows no options widget.
3. A project with no stored entry step and at least one chat message (any user) but no nodes is treated as full (AC 2 rules apply).
4. The entry step is stored under `projects.data.studio` and survives a reload; the project list API returns it per project.
5. A viewer's request that would set the entry step (widget answer or message) is rejected with 403 and the entry step is unchanged.
6. Two concurrent first messages on an undecided project result in exactly one stored entry step; both turns run against it.
7. No API lets an editor change the entry step to a downstream step or an unrelated step; attempts return a 4xx and leave it unchanged.

### Intent: ambiguous prompt
8. First message "I'm working on a 67 W USB-C charger" on an undecided project shows an options widget containing "Start from scratch" and all 11 steps, exactly one marked recommended with a non-empty reason, and no stage node is written.
9. Choosing "Start from scratch" stores entry step Specs, and the next turn runs the full flow on the original prompt.
10. Choosing "Magnetics" stores entry step Magnetics via the widget-answer endpoint (`POST /projects/:id/chat/widgets/:widgetId/answer`), independent of model output, and continues with input evaluation.
11. When the classification step returns no usable result (stubbed), the options widget is shown with no recommendation.
12. Typing a message instead of answering the widget keeps the entry step undecided and classifies the new message.
13. "Design the magnetics and thermal" sets entry step Magnetics (Thermal is downstream). "EMC and thermal" shows the options widget.

### Intent: explicit step, inputs
14. Explicit with all inputs: "Inductor for a buck, 22 µH, 3 A DC, 500 kHz" sets entry Magnetics with no options widget and no inputs widget, and runs `design_magnetics` in the same turn.
15. Explicit with partial + assume: "Do I need a heatsink? Q1 dissipates 2 W. Assume anything else." sets entry Thermal, shows no inputs widget, runs `run_thermal`, and the reply lists every assumed value with name, value and unit.
16. Explicit with partial, no instruction: "Do I need a heatsink? Q1 dissipates 2 W." sets entry Thermal and shows a value-table widget whose rows are the contract's missing required inputs, with Q1 loss pre-filled; no thermal node is written yet.
17. In AC 16, the server-generated rows include every missing required input even when the model's tool call lists fewer.
18. Missing-input computation is a pure function covered by unit tests; for Devices, Magnetics and Thermal its output matches the existing validators on the same inputs (`device-selection.ts:626-702`, `magnetics.stage.ts:82-205`, `thermal.stage.ts:421-456`).
19. Inputs already present on a branch node are not asked for and are recorded as `derived`.
20. Submitting the value table with some cells blank records the blank inputs as `assumed` and the filled ones as `user`, then runs the step.
21. Clicking "Q fills the rest" submits immediately; every blank input is recorded as `assumed`, and the step runs.
22. In a scoped project whose branch already has a specs node with rows, the step-inputs value table is still shown (suppression at `studio-tools.executor.ts:390-399` does not apply).
23. The step node stores provenance for every input used; the step view shows an "Assumed" marker on each assumed value and lets the user edit it and re-run.

### Dependency redirect and .cir
24. Explicit "Simulate my buck converter" with no design and no `.cir` shows a redirect suggestion: start at Design (recommended) or upload a `.cir`; no simulation node is written.
25. Accepting the AC 24 suggestion sets the entry step to Design and starts Design input evaluation.
26. In AC 25, if no topology is named and the user has not allowed assumptions, a suggestion to start at Circuit follows; accepting sets entry step Circuit.
27. "Simulate this" with a `.cir` attachment sets entry step Simulation, imports the netlist as an input record, runs the simulation, and shows no redirect.
28. In AC 27, the side panel shows Simulation (and Devices once auto-selected devices are ready) and does not show Design or Circuit; the imported netlist is visible in the Simulation view as a `user` input.
29. A redirect cannot be accepted once the current entry step has a `ready` node; the attempt is rejected and the entry step is unchanged.

### Forward-only
30. In Scoped(Thermal), the agent request's tool list contains no tools for Specs, Circuit, Design, Simulation, Devices or Magnetics.
31. In Scoped(Thermal), a forced `run_simulation` tool call (bypassing the tool list) is rejected by the executor with a result stating the step is upstream of the entry step; no node is written.
32. In Scoped(Thermal), `POST /projects/:id/studio/magnetics` and `POST /projects/:id/branches/:b/stages/magnetics/run` return 409 with an error code, and no node is written; the thermal endpoints keep working.
33. In Scoped(Magnetics), asking "now simulate it" produces a reply explaining Simulation is earlier than the entry step and suggesting a new project; no simulation node is written.
34. In Scoped(Magnetics), asking for thermal runs `run_thermal`, using the magnetics node's losses as `derived` inputs and asking only for missing device losses.
35. Re-running the entry step when it is the branch head with no children updates the node in place; the entry step is unchanged.
36. Re-running the entry step when downstream nodes exist forks a branch with the existing fork notice; the entry step is unchanged and still applies on the new branch.
37. Creating or switching branches in a scoped project keeps the same entry step and allowed steps.
38. The closure table in §4 is covered by a unit test asserting the allowed steps for every entry step.

### Side panel and navigation
39. Scoped(Magnetics) with only a ready magnetics node shows Magnetics and Thermal in the rail, nothing else.
40. Scoped(Magnetics) before the magnetics node is ready shows only Magnetics.
41. Scoped(Thermal) with a ready thermal node shows Thermal and MTBF.
42. Opening `?view=circuit` on Scoped(Magnetics) renders the Magnetics view and rewrites the URL.
43. Backend `defaultView` for a scoped project with no nodes is the entry step's view.
44. Arrow-key navigation in the rail moves only between visible steps.
45. A full project shows today's rail; an undecided project shows today's rail.

### New steps
46. The migration adds the new `StudioStage` values only; `npx prisma migrate diff` from the previous schema shows enum additions and nothing else, and existing rows are unaffected.
47. Explicit "Run an EMC scan: 0.5 mH PFC inductor, 400 V bus, 150 W, 230 V in, …" sets entry EMC, runs the EMC tool, stores an EMC node, and shows the EMC view; no other step is visible.
48. Explicit "MTBF for these parts: Q1 MOSFET, D1 diode, C1 capacitor, MIL-HDBK-217F ground benign" sets entry MTBF, runs it, and stores an MTBF node.
49. An MTBF request with an unknown environment returns the inputs widget (or a validation message), not a 500.
50. Explicit BOM request with a parts list sets entry BOM, stores a BOM node with rows and totals, and the BOM export from that node produces an S3-backed signed URL.
51. `POST /calculators/emc/scan`, `POST /calculators/mtbf`, `POST /projects/:id/mtbf`, `GET /projects/:id/bom` and `POST /projects/:id/bom/export` keep their current request/response contracts (existing tests pass).
52. FE zod schemas accept workspaces containing the new stages; FE mock service supports them, and FE tests pass.
53. Outcome A: "Pick the MOSFET and diode for 400 V, 5 A, 100 kHz" (or choosing "Component selection" in the options widget) sets entry Devices, runs `select_devices`, and BOM/MTBF are downstream of it.
54. Outcome B: choosing "Component selection" sets the new stage; it sources parts through `search-by-specs`, stores chosen parts on its node, and BOM and MTBF read them.
55. Outcome B: with `MOUSER_API_KEY` unset, the step returns a clear "component search is not configured" message to the user and writes no node; the chat turn does not crash.
56. Full projects' agent requests contain none of the new tools (FR-13, FR-45).

### Full flow and legacy
57. For a full project, the system prompt and tool list passed to Bedrock equal today's output for the same snapshot (byte comparison test).
58. The first full-flow turn after "Start from scratch" sends the same messages as a project created today with the same first prompt (the classification exchange is not replayed).
59. `studio-request.parity.spec.ts` passes with unchanged fixtures.
60. For a full project, the `fields` value table is still suppressed once a spec table exists.
61. A legacy project (pre-feature data, chat and nodes) loads with full rail, no badge, unchanged progress (out of 7), and its next turn's request is byte-identical to today's.

### Teammate and dashboard
62. A teammate (editor) opening Scoped(Thermal) for the first time sees the scoped rail; their first message shows no options widget and their agent request is scoped (AC 30 holds).
63. A viewer opening Scoped(Thermal) sees the scoped rail and cannot run any step.
64. The dashboard card of Scoped(Magnetics) shows a "Magnetics" badge; full, legacy and undecided projects show none.
65. Scoped(Magnetics) with magnetics ready and Thermal visible but not run shows 50% on the card.

## 8. Assumptions (flagged for design review)

- A-1 Entry step Specs and "start from scratch" are the same thing. An explicit "just give me the specs" therefore runs the full flow.
- A-2 FR-14 (classification not replayed) is how "same flow as today" is made testable. If the design keeps the exchange in the transcript, FR-13/AC 57 still hold but AC 58 must be dropped.
- A-3 Full/legacy/undecided projects show no badge.
- A-4 A topology is not assumable for Design unless the user allowed assumptions; Circuit is the producing step.
- A-5 EMC is Design-downstream, not Simulation-downstream, because its inputs are component values. The current EMC engine is PFC-boost specific; the EMC contract may need a topology guard.
- A-6 Thermal → MTBF and Component selection → MTBF/BOM follow from what the existing MTBF and BOM code reads.

## 9. Open questions for design

- O-1 FR-13 locks the full-flow request, so the agent cannot run the new steps inside full projects. If full projects must also reach EMC/MTBF/BOM/Component selection through the agent, the requirement has to be relaxed to "parity fixtures stay identical" and the full-flow tool list grows. This needs a product decision.
- O-2 Component selection: Outcome A or B (§5.9). ACs 53-55 cover both.
- O-3 Whether the history drawer hides nodes of non-visible steps or only blocks navigating to them (FR-37 requires the latter at minimum).

## 10. Out of scope

- Changing the entry step after it is set, other than an accepted dependency redirect before the entry step has run.
- "Expand to full project", converting a scoped project into a full one, or running upstream steps in a scoped project.
- Adding the new steps to the full-flow agent request (pending O-1).
- Control-loop and report steps.
- Changes to the stateless `/api/v1/studio/agent` endpoint behaviour beyond keeping it byte-identical.
- Bulk migration of legacy project data into the new stage nodes (legacy `data.selectedParts`, `mtbfSummary` stay as is).
