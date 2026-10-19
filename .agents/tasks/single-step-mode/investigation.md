# Single-step mode: feasibility and architecture

Read-only investigation of `qdonis-backend` (main @ 62fcbf8) and `qdonis-web` (main @ 98c4ce9). No code was changed.
Paths below are relative to each repo root (`BE` = qdonis-backend, `FE` = qdonis-web).

## 0. Summary answer

**Yes, it is possible, and about half of it already exists.** The backend was built with modular stages in mind:

- The system prompt already has a section "Stages are modular: do only what was asked"
  (BE `src/studio/agent/studio-system-prompt.text.ts:35-54`). It tells Q to collect only one stage's inputs, assume
  them if the user says so, and never run upstream stages unless they are truly needed.
- Devices, Magnetics and Thermal already have a **standalone input mode** (entered values, no upstream nodes) and
  return structured `missing_inputs` when values are missing (`magnetics.stage.ts:285-302`,
  `thermal.stage.ts:444-456`, `simulation/loss/device-selection.ts:626-702`).
- The chat already renders **interactive widgets**: option buttons, an editable value table, topology cards, and spec
  approval. Answers go back to the agent through `POST /projects/:id/chat/widgets/:widgetId/answer`
  (BE `studio-chat.controller.ts:79`).

**What is missing** is everything that makes it an explicit, enforced mode:

1. No persisted **scope/mode** on a project. The agent decides per message, and the prompt can override it.
2. No **"step vs start from scratch" choice** widget, and no intent step on the first prompt.
3. No **per-input "I'll provide / Q assumes" choice**. The value table only lets the user leave a cell blank, and it is
   disabled once a spec table exists (`studio-tools.executor.ts:390-399`).
4. No **tool gating**. All 17 tools are always offered, and the executor runs any of them.
5. No **provenance** for standalone stage inputs. Only spec rows carry `source: user|assumed|derived`.
6. The **workspace side panel always shows all 7 tabs** (`FE stage-rail.tsx`, iterating `STUDIO_VIEWS`).

Verdict: feasible without a DB migration. Scope lives in the existing `projects.data.studio` meta JSON, next to
`initialPrompt` and `focus`. The work is mostly in the chat service, tool layer and a few FE components. Rough effort
is **M–L overall, about 2 engineer-weeks across both repos**. Magnetics, Thermal, Devices and Specs are easy as single
steps. Design and Simulation are harder because they hard-depend on graph nodes (a topology, or design netlists / a
.cir file).

---

## A. Architecture map: the agent loop end to end

### Two agent entry points (only one is live)

| Endpoint | Where | Loop owner | Used by FE? |
|---|---|---|---|
| `POST /api/v1/studio/agent` (SSE) | BE `src/studio/studio.controller.ts:41-98`, `src/studio/agent/studio-agent.service.ts` | **Client** runs the tools. It is a stateless port of qdonis-core `stream_agent_step`. | **No.** No FE reference found (grep for `/studio/agent` in `FE src`). It is kept for parity. |
| `POST /api/v1/projects/:projectId/chat/messages` (SSE) and `POST .../chat/widgets/:widgetId/answer` (SSE) | BE `src/studio-chat/studio-chat.controller.ts:59-100`, `studio-chat.service.ts` | **Server** runs the tools. | **Yes.** FE `features/studio/services/studio-service.http.ts:411-430` |

The live flow (studio-chat):

1. `prepareSend` (`studio-chat.service.ts:189`) checks access (`canEdit`), idempotency, attachments, balance
   (`AiStepRunner.prepareStream`), and that only one run is active per user and project (`claim`). It stores the user
   message as a `project_chat_messages` row. The text the model sees goes in `metadata.llmText`.
2. `turn` (`:420`) loops up to `MAX_STEPS = 10` (`:67`). Each step does this:
   - Loads the graph (`projects.loadStudio`) and builds the snapshot with `buildAgentSnapshot`
     (`src/studio-chat/agent-snapshot.ts`).
   - Builds the request with `buildStudioRequest` (`src/studio/agent/studio-request.builder.ts`). That is the system
     prompt, the topology library, and the snapshot JSON truncated to 9,000 chars (`studio-system-prompt.ts:52-66`),
     plus all tools from `buildStudioTools` (`studio-tools.ts:47`).
   - Streams Bedrock `converseStream` (`ai/bedrock/bedrock.client.ts`) and emits `text.delta`.
   - Charges usage (`runner.chargeStream`, step key `studio_agent`).
   - Executes each tool call with `StudioToolsExecutor.execute` (`studio-tools.executor.ts:178`). This emits
     `tool.started` / `tool.finished`, plus `workspace.updated` with the changed stages and a focus view, and `widget`
     when the tool returns one.
   - Ends the turn when there are no tool calls, or when a blocking tool ran (`BLOCKING_TOOLS = ask_user,
     suggest_topologies`, `:76`), or when any widget was shown.
3. Persistence: `project_chat_messages` (`prisma/schema/projects/project-chat-message.prisma`). History is **private
   per user per project**. `metadata` holds `StudioChatMeta` (`studio-chat.types.ts:155-170`): display `blocks`,
   `attachments`, `status`, `branchId`, and the raw model turns `llm[]` that are replayed as the transcript
   (`transcript()`, last 60 rows).
4. Streaming: SSE with `event: <type>`, `data: <json>`, and a 20 s heartbeat (`studio-chat.controller.ts:183-225`).
   Event union: `ChatStreamEvent` (`studio-chat.types.ts:172-206`), mirrored in FE `features/studio/types/chat.ts`.
   If the client disconnects, the run continues. FE reconnects via `GET chat/runs/active`.
5. FE consumer: `features/studio/hooks/use-chat-stream.ts`. On `workspace.updated` it invalidates
   `StudioWorkspace`/`StudioHistory` tags and calls `router.replace(routes.project(id, focus))` (`:129-141`).

### Parity lock (important constraint)

`buildStudioRequest` and `buildStudioTools` are byte-checked against qdonis-core fixtures
(`src/studio/agent/studio-request.parity.spec.ts`, `test/parity/fixtures/studio-agent`). Any scope feature must leave
the **scope-less** request identical (new optional parameters only). "Start from scratch" must stay exactly the
current flow, so the full-mode request should be byte-identical to today's request anyway.

### Tools today (`studio-tools.ts`; executor dispatch `studio-tools.executor.ts:208-260`; labels/stages `TOOL_INFO` `:76-95`)

| Tool | Stage | Consumes | Produces |
|---|---|---|---|
| `update_specs` | specs | conversation | spec rows (`name, value, unit, category, required, source: user/assumed/derived, note`), approval request |
| `generate_constraints` | specs | **specs node with rows** (hard: `design.service.ts:521`) | constraints list in 10 categories (queued `SimulationRun` kind) |
| `update_constraints` | specs | constraints | edited constraints |
| `ask_user` | – (blocking) | question + `fields` **or** `options` | `fields` / `question` widget |
| `suggest_topologies` | specs (blocking) | approved specs | `topologies` widget; stored `topologyOptions` |
| `select_topology` | visualization | topology id from library | visualization node (schematic, inventory) |
| `edit_circuit` | visualization | instruction | currently returns a not-available outcome (`executor:235-244`) |
| `run_design` | design | **visualization node required** (`simulation.service.ts:175, 234`); specs optional (AI sizing if specs ready, else library defaults `:157-205`) | design node (values, decks, reasoning) |
| `modify_design` / `set_design_values` | design | **design node with decks required** (`:321, 421, 457`) | updated design |
| `import_netlist` | design | `.cir` chat attachment + topology id | design node (origin import) |
| `run_simulation` | simulation (+devices) | **design node with decks required** (`executor:779-795`, `simulation.service.ts:541`) | simulation node (measurements, waveforms in S3, losses, auto device selection) |
| `select_devices` | devices | standalone `devices[]` stresses **or** branch simulation (`:759`) | devices node (selection, losses) |
| `design_magnetics` | magnetics | standalone `parts[]` **or** branch circuit (topology at least) | magnetics node (cores, turns, losses, `assumed_values`) |
| `run_thermal` | thermal | standalone `devices`/`magnetics_losses`/`other_losses` **or** branch simulation / devices | thermal node (loss budget, Tj, heatsink) |
| `open_view` | – | stage | focus only |
| `manage_branch` | – | create/switch/rename | branch ops |

Not agent tools: **EMC, MTBF and BOM** exist only as REST calculators or project endpoints
(`studio-stages.controller.ts`: `CalculatorsController`, `ProjectMtbfController`, `BomController`). They are not stages
in `STAGE_ORDER` and have no workspace tab. Making them single steps means adding tools, stages and views first.

---

## B. Project / flow model

### Prisma (multi-file schema, `prisma/schema/`)

- `projects/project.prisma`: `Project.data Json` holds the Studio meta under `data.studio` (version 2:
  `initialPrompt`, `focus`, `messages`, `createdAt`; `studio-persistence.ts:434-469`). It also has
  `progressCompleted`/`progressTotal` and optimistic `revision`.
- `studio/studio-node.prisma`: `StudioNode(projectId, id, parentId, stage StudioStage, status, rev, data Json, source,
  summary)`. Each node is one stage result, like a commit. The tree is built through `parentId`.
- `studio/studio-branch.prisma`: named head pointers (`headNodeId`, `forkedFromNodeId`, `position`).
- `studio/studio-branch-cursor.prisma`: each user's active branch.
- `studio/simulation-run.prisma`: queued jobs (design sizing, simulation, constraints) with leases.
- Enums: `StudioStage {specs, visualization, design, simulation, devices, magnetics, thermal}`,
  `StudioNodeSource {agent,user,upload,legacy}`, `StudioNodeStatus {running,ready,error}`.

### Graph semantics (`src/projects/studio/studio-graph.ts`)

- `STAGE_ORDER` (`:10`) is only a **display order**. It is not a dependency graph.
- A branch's state is the ancestry of its head (`branchPath`). `stageNodeOnBranch` picks the latest node of a stage
  on that path.
- `commitStage` (`:187`) updates in place if the stage is the head with no children. It forks a new branch if later
  work exists. Otherwise it appends to the head. **Any stage can be committed on an empty branch.** Nothing in the
  graph enforces ordering.

**So the flow is free-form, as far as the data model goes:** a tree of stage commits. The ordering and dependencies
live in three places:

1. **Prompt**: the "full design conversation" ordering, specs → constraints → topology → design → simulation →
   magnetics → thermal (`studio-system-prompt.text.ts:55-110`).
2. **Code preconditions** in services: design needs a visualization node, simulation needs design decks,
   constraints need spec rows, device/thermal "from simulation" need a ready simulation
   (`StageInputMissing` errors listed in §A).
3. **Engine fallbacks**: magnetics/thermal read specs for fsw and ambient when present
   (`specTemperatures`, `specValue`), and default ambient to 40 °C.

### Frontend state

- Server data lives in RTK Query (`features/studio/api.ts`). `StudioWorkspace` (`types/workspace.ts:24-39`) is
  validated by zod in `studio-service.http.ts:60-71`. It has `stages: Record<StageKind, StageSummary>` (all 7, always)
  and `defaultView`.
- Redux slice `features/studio/store/studio-slice.ts` holds UI-only state per project: active branch, chat run
  status, save status, fork notice, composer request. There is no flow model on the FE.
- The open tab lives only in the URL (`?view=`; `hooks/use-studio-view.ts`, `schemas/view.ts`).

---

## C. Per-step input contracts

| Stage | Contract today | Where | Standalone today? |
|---|---|---|---|
| Specs | Free-form rows; the prompt lists the minimum fields (Vin, Vout, P/I, isolation, ripple, efficiency, ambient/Tj) | prompt `:62-73`; tool schema | Yes |
| Circuit (visualization) | `topology_id` from the library enum | tool schema | Yes |
| Design | Topology (**hard**, needs a visualization node) + specs (soft) | `simulation.service.ts:157-205` | **No**: needs a visualization node. Specs only change AI sizing vs library defaults. |
| Simulation | Design decks (**hard**) or imported `.cir` + topology id | `executor:779-795`, `import_netlist` | **No**: needs a design node. A `.cir` upload gives a quasi-standalone path. |
| Devices | Per device: `ref, kind, v_block_v, fsw_khz, one of i_peak/i_rms/i_avg`; optional `duty, zvs` | tool JSON schema `studio-tools.ts` `select_devices`; validator `device-selection.ts:626-660` (`missing_inputs`) | Yes |
| Magnetics | Per kind: inductor `inductance_uh, i_dc_a` (+ripple, duty assumed); flyback `inductance_uh, turns_ratio, v_primary_v, i_peak_a or power_w`; transformer `turns_ratio, v_primary_v, i_rms_a or power_w`; resonant `inductance_uh, i_peak/i_rms`; all `fsw_khz` | tool schema; class-validator `studio-stages/dto/stages.dto.ts` `MagneticPartDto`; validator `partRequirement` `magnetics.stage.ts:82-205` (returns `missing` and `assumed`) | Yes |
| Thermal | Per device: `ref`, `loss_w` or conduction + switching; optional magnetics/other losses, `output_power_w`, `ambient_c` | tool schema; `ThermalInputsDto` (`stages.dto.ts`); validator `thermal.stage.ts:421-456` | Yes |

Answers to the specific questions:

- **Explicit contracts exist** for Devices, Magnetics and Thermal, in three forms: tool JSON schemas, class-validator
  DTOs for the REST stage endpoints, and engine validators that already compute missing and assumed fields.
- Specs, Design and Simulation have **no input schema**. Their requirements are implied by graph preconditions and
  prose in the prompt.
- **A "missing inputs" evaluator can be built mostly from existing code.** The engine validators already return the
  exact per-part missing fields. What does not exist is a single declarative registry per stage (labels, units,
  required/optional, conditional "one of" groups, which upstream artifact satisfies each input). That registry needs
  to be written (≈200 lines). It can reference the tool schemas instead of duplicating them.
- **Standalone today:**
  - Specs, Circuit, Devices, Magnetics and Thermal can run with no prior records.
  - Design hard-depends on a visualization node.
  - Simulation hard-depends on a design node.
  - In single-step mode, the "inputs" for Design are the topology and specs, and they must be committed as nodes
    (select_topology / update_specs) for the stage service to run. These are input-capturing writes, not separate
    "steps" shown to the user.

---

## D. Chat UI

Structured messages are **already supported**:

- Block model: `ChatBlock = text | tool | widget` (FE `types/chat.ts:63-77`). Rendered in order by
  `components/chat/assistant-message.tsx`.
- Widgets: `question` (option buttons, single or multi, `widgets/question-widget.tsx`), `fields` (editable
  Parameter | Value | Unit table with required rows and "add parameter"; blank means "Q proposes",
  `widgets/fields-widget.tsx`), `topologies` (cards), and `spec_approval`.
- Tool chips with a "View →" link to the stage tab (`tool-chip.tsx`).
- Answer path:
  1. The widget calls `onAnswer`, which posts to `chat/widgets/:id/answer`. Validation is zod `widgetAnswerSchema`
     (FE `schemas/chat.ts:26-31`) and class-validator `WidgetAnswerDto` (BE `studio-chat/dto/studio-chat.dto.ts`).
  2. `prepareAnswer` (`studio-chat.service.ts:260`) marks the widget resolved. For `spec_approval` it also mutates the
     graph on the server (`:297-316`).
  3. `answerOf` (`:727-795`) converts the answer into user text for the model, e.g. a markdown table of filled
     values, and the next turn starts.

How the new interactions fit:

1. **"Step vs start from scratch"**: add a new widget kind `scope`, with cards for "Start from scratch (full design)"
   plus one card per available stage. One card is marked `recommended`, with a one-line reason from the model. Model
   it on `TopologyWidget`. On answer, `prepareAnswer` persists the scope on the server, the way `spec_approval` mutates
   the graph today. That is deterministic and does not depend on the model reading button text. Answer DTO:
   `{ kind: 'scope', mode: 'full' | 'stage', stage?: StageKind }`.
2. **"Provide vs Q assumes" per missing input**: add a widget kind `stage_inputs`, an extension of `fields`. Each row
   has the value cell plus a per-row toggle *I'll provide / Q assumes*. Rows the model extracted from the prompt are
   pre-filled and tagged "from your message". Answer: `{ kind: 'stage_inputs', values: Record<string,string>,
   assume: string[] }`. `answerOf` renders a table with a Source column (provided / assume) for the model. This needs a
   new kind rather than reusing `fields`, for two reasons: `askUser` suppresses `fields` once a spec table exists
   (`executor:390-399`), and `fields` has no assume semantics.

---

## E. Side panel (workspace pane)

- Layout: `components/shell/studio-screen.tsx` → `SplitLayout` (chat left, workspace right) → `WorkspacePane`
  (`components/workspace/workspace-pane.tsx`).
- `WorkspacePane` renders `StageRail` (`stage-rail.tsx`), which **always maps over all of `STUDIO_VIEWS`**
  (`:93`; arrow-key navigation over the same list `:56-70`). It then renders the view component chosen by the URL
  `?view=` from the `VIEWS` map.
- What gets shown is decided by:
  - the URL (`useStudioView(workspace.defaultView)`)
  - backend `defaultView` (focus, else the head node's stage, else specs; `studio-graph.service.ts:511-516`)
  - `workspace.updated.focus` from the chat
  - `ToolChip` links
  - `HistoryDrawer` checkouts
- Each stage view already handles its own empty state and standalone entry. For example, `ThermalView` offers "Enter
  heat sources" when there is no simulation (`views/thermal/thermal-view.tsx:72-97`). Magnetics and Devices have
  equivalent forms (`magnetic-part-form.tsx`, `device-stress-form.tsx`).

**Difficulty: small.** With a `scope` field on `StudioWorkspace`:

- `StageRail` filters to the scoped view.
- `useStudioView` clamps any other `?view=` to the scoped view.
- Backend `defaultView` returns the scoped view.
- `HistoryDrawer` filters nodes to the scoped stage, or stays as is (open decision).
- `ToolChip` links to other stages cannot occur, because the tools are gated.
- Optionally a header pill "Thermal analysis · Expand to full project".

---

## F. Feasibility and implementation proposal

### F1. New data (no Prisma migration)

1. **Project scope** goes in the Studio meta (`projects.data.studio`). This follows the existing `initialPrompt`/`focus`
   pattern and avoids a migration:
   ```ts
   scope?: { mode: 'full' } | { mode: 'stage'; stage: StageKind; chosenAt: string; chosenBy: string } // absent = undecided
   ```
   Files to touch:
   - `StudioProject` (`studio-graph.ts:59`)
   - `StudioMeta` / `studioMetaOf` / `readStudioMeta` / `loadStudioProject` / `parseStudioProject`
     (`studio-persistence.ts:434-469, 517+`)
   - `StudioGraphRepository.header` raw SQL (`studio-graph.repository.ts:118-131`, add `data->'studio'->'scope'`)
   - `StudioGraphService.workspace` (`:113-153`, return `scope`; `defaultView` honours it)

   Writes go through `ProjectsService.mutateStudio`, which already uses revision locking.

   Rationale for project-level rather than branch-level: chat history is per user while the graph is shared, so the
   scope has to be shared state that every collaborator's agent sees.
2. **Input provenance** for standalone stages goes in node `data` (JSON, no migration):
   `inputProvenance: Record<string /* "Q1.loss_w" */, 'user' | 'assumed' | 'derived'>` next to the existing
   `data.inputs`.
   - Spec rows already have `source` (`studio-tools.ts` `update_specs`).
   - Magnetics already reports engine-assumed values (`assumed_values`, `magnetics.stage.ts:507-509`).
   - Add an optional `assumed: string[]` argument to `select_devices`, `design_magnetics` and `run_thermal`. The
     executor writes it into the node.
3. **Stage input contracts** go in a new registry, `src/studio-chat/stage-contracts.ts` (BE). Per stage it holds the
   required and optional inputs, with label, unit, "one of" groups, and which upstream artifact satisfies each input.
   It reuses the existing validators (`partRequirement`, `standaloneDevices`, thermal loss check) for the final check.
   The registry is serialised into the scoped prompt addendum and drives the `stage_inputs` widget rows on the
   server, so the model cannot drop a required input.

### F2. Agent changes (BE)

- `buildStudioRequest` / `buildStudioTools` / `buildStudioSystemPrompt` take an **optional** `scope`. With no scope
  passed, the output is byte-identical, so the legacy endpoint and parity fixtures stay green. The chat path always
  passes the project's scope:
  - **undecided** (first prompt of a new project): tools = `offer_scope` only, with
    `toolConfig.toolChoice = { any: {} }`. `BedrockRequest.toolConfig` is the SDK `ToolConfiguration`, which accepts
    `toolChoice`. `convertTools` does not set it today (`ai/bedrock/bedrock-tools.ts`). The model fills `recommended`
    (`full` or a stage), a reason, and `explicit: boolean`.
    - If `explicit` is true (e.g. "just do the thermal analysis"), the executor sets the scope immediately. It shows a
      small non-blocking chip, "Scoped to Thermal · Change", and the same turn continues into input evaluation.
    - Otherwise it shows the blocking `scope` widget.
  - **full**: the exact current prompt and all tools, unchanged. This is "start from scratch".
  - **stage X**:
    - Append a scoped addendum: only stage X, the contract for X, and the instruction to call `request_stage_inputs`
      before running unless everything is provided.
    - Tool allow-list per stage:
      - thermal: `run_thermal, ask_user, request_stage_inputs, open_view`
      - magnetics: `design_magnetics, …`
      - devices: `select_devices, …`
      - specs: `update_specs, generate_constraints, update_constraints, ask_user`
      - circuit: `select_topology, ask_user`
      - design: `select_topology, update_specs (as input capture), run_design, modify_design, set_design_values`
      - simulation: `import_netlist, run_simulation, set_design_values` (plus design-input tools if there is no .cir)
- **Server-side guard** in `StudioToolsExecutor.execute` (`:178`): reject tools outside the allow-list with
  `fail('This project is scoped to <Stage>…')`. The prompt is not a security boundary.
- New tools: `offer_scope` (blocking unless explicit) and `request_stage_inputs` (blocking; server builds the rows
  from the contract plus the model's extracted values). Add both to `BLOCKING_TOOLS` (`studio-chat.service.ts:76`) and
  `TOOL_INFO`.
- `prepareAnswer`:
  - `scope` answers call `mutateStudio` to set the scope. With mode `full`, the next turn runs the normal flow on the
    original prompt.
  - `stage_inputs` answers produce `llmText` with Provided/Assume columns.
  - Extend the `ChatWidget` / `WidgetAnswer` unions (`studio-chat.types.ts:56-82`) and the `WidgetAnswerDto` `KINDS`
    list (`dto/studio-chat.dto.ts:52`).
- New REST endpoint: `PATCH /projects/:id/studio/scope` (editors only), for "Expand to full project" or changing the
  step from the workspace. It goes in `studio-graph.controller.ts` → `StudioGraphService` → `ProjectsService.mutateStudio`.
- `studioProgress` (`project-progress.ts:46-51`): total = 1 for stage scope, so dashboard progress is meaningful.

### F3. Frontend changes (FE)

- Types and zod:
  - `types/workspace.ts` (`scope`)
  - `studio-service.http.ts:60-71` workspace schema
  - `types/chat.ts` and `schemas/chat.ts` (`scope` and `stage_inputs` widgets and answers)
- Widgets: `components/chat/widgets/scope-widget.tsx` and `stage-inputs-widget.tsx`, registered in
  `assistant-message.tsx` `Widget` switch.
- Side panel:
  - `stage-rail.tsx` takes a `views` prop, filtered by scope.
  - `workspace-pane.tsx` passes it, plus a scope pill with "Expand to full project".
  - `use-studio-view.ts` clamps to allowed views.
  - Optionally filter `history-drawer.tsx`.
- Provenance: an "Assumed" badge plus the existing edit forms in `thermal-view.tsx`, `magnetics-view.tsx` and
  `devices-view.tsx`.
- Mock layer: `services/mock/chat-service.ts`, `studio-store.ts` and the fixtures must learn `scope`, or the mock
  tests break (`studio-service.mock.test.ts`).
- `chat-starters.tsx`: optional stage-specific starters ("Just a thermal check").

### F4. Intent classification

Recommended: **forced first tool call in the main agent** (undecided scope → only `offer_scope`, `toolChoice: any`).
It is one model step and uses the same model and billing path. It sees the full prompt and attachments, and it lets
the model also return extracted input values to pre-fill the input widget.

The alternative is a separate cheap classifier call through `AiStepRunner` with JSON output. That adds latency, a
second prompt to maintain, and a second charge, for no real gain.

**Unverified:** which Bedrock model is configured (admin setting) and whether it honours `toolChoice: any`. Claude
models on Bedrock do. If it does not, a fallback is needed: when scope is undecided and no `offer_scope` call came
back, the server shows the scope widget itself with no recommendation.

### F5. Risks and unknowns

1. **Parity tests.** The changes must keep the scope-less request identical. Run `npm test` for
   `studio-request.parity.spec.ts`.
2. **Design/Simulation are not truly standalone.** They need topology/specs or design/.cir nodes. In single-step mode
   these get created as hidden inputs. Decision needed: does the panel show the Circuit as part of "Design inputs", or
   hide it entirely?
3. **Simulation auto-selects devices** (`runSimulation` returns stages `['simulation','devices']`, `executor:845-853`).
   For a "simulation only" scope, either suppress that or accept it and show device results inside the Simulation view.
4. **Expanding later.** When a single-step project is expanded, earlier nodes become ancestors of the new specs and
   design nodes, because `commitStage` appends to the head. That works (`stageNodeOnBranch` is per stage), but
   re-running the original stage then **forks a branch** because it has children. Acceptable, but the product should
   know.
5. **Prompt drift.** The full prompt already says "do only what was asked", which partly overlaps the new mode. In
   undecided and stage modes it must be overridden by the addendum and the gating. Expect some prompt tuning and
   evaluation runs.
6. **Per-user chat vs shared scope.** A teammate opening a scoped project sees a scoped workspace, but their own chat
   has no scope widget history. Their agent still gets the scope through the request.
7. **Existing projects** have no scope. Treat absent scope plus existing nodes or chat as `full`, so behaviour is
   unchanged. Only brand-new projects (no chat yet) start "undecided".
8. **Assumed-value quality.** "Q assumes" values come from the LLM. They must be shown and editable (spec table
   `source` column; badges and forms in stage views), and results should state they rest on assumptions.
9. EMC, MTBF, BOM, Report and Control are **not** agent stages today. Offering them as single steps is extra scope:
   new tools, a `StudioStage` enum value (that one does need a migration), and new views.

### F6. Open product decisions

- Can a single-step project be expanded to a full project? Recommended: yes, via the workspace pill or chat. The
  existing node is kept.
- Can the user change the chosen step later (thermal → magnetics), or only expand to full? Allowing a switch is
  straightforward, but it means the side panel shows more than one stage.
- Where are assumed values shown and edited: in the stage view (recommended), in a chat summary table, or both?
- Should "explicit" intents skip the choice widget (recommended, with a "Change" chip), or always ask?
- Which stages are offered as single steps in v1? Recommended: Specs, Circuit, Devices, Magnetics, Thermal in v1;
  Design and Simulation in v2, or v1 with the hidden-input approach.
- Dashboard: show a scope badge on project cards, and a progress of "1 of 1"?

### F7. Effort (rough)

| Area | Size |
|---|---|
| BE scope persistence (meta, header SQL, workspace view, PATCH endpoint, progress) | S |
| BE agent: scope-aware request builder, allow-lists, executor guard, `offer_scope` / `request_stage_inputs`, widget kinds, answer handling | M |
| BE stage-input contracts registry + provenance on devices/magnetics/thermal nodes | M |
| BE Design/Simulation as single steps (hidden prerequisites, device auto-selection rules) | M–L |
| FE types/schemas, two new widgets, scoped StageRail/view clamp, expand control, provenance badges | M |
| FE mock service/fixtures | S |
| Tests (BE jest: chat service, executor gating, parity unchanged; FE vitest: schemas, slice, mock service) + prompt evaluation | M |

**Total: M–L, about 2 engineer-weeks.** Magnetics, Thermal and Devices could ship as a v1 in about 1 week.

### F8. Recommended order

1. BE scope field, workspace `scope`, PATCH endpoint (no behaviour change yet).
2. BE scoped request builder and executor guard, plus the `offer_scope` widget (undecided → choice → full / stage).
3. BE contracts, the `request_stage_inputs` widget, and provenance, for Magnetics/Thermal/Devices.
4. FE widgets, scoped side panel, expand control.
5. Design/Simulation single-step support.
6. Prompt evaluation against example prompts ("just thermal", "67 W charger", ".cir simulate", "heatsink for 6 W").

Verification once implemented:

- BE: `npm run lint:check`, `npm run typecheck`, `npm test` (parity spec must stay green).
- FE: `npm run typecheck`, `npm run lint`, `npm test` (vitest).

## What was not verified

- Live behaviour: no requests were sent to the running servers, and no model was called. Everything is from code
  reading.
- Whether the configured Bedrock model supports `toolChoice` (admin-configured model id; not inspected in the DB).
- Internals of `ProjectsService.mutateStudio` beyond its signature, and the full `HistoryGraph` component.
- Dashboard composer / project-card internals (`features/dashboard/*`), beyond confirming that the prompt arrives as
  `pendingInitialPrompt` and is sent as the first chat message (`chat-pane.tsx:57-70`).
