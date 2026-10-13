# Project lifecycle migration: which steps can move to Nest now

Read-only investigation, 2026-05. Paths are relative to the workspace root `c:\Users\PMLS\Desktop\tailorflow ai\qdonis`.
FE = `qdonis/` (old React+Vite), core = `qdonis-core/`, BE = `new-qdonis-nest-backend/` (branch `feature/core-migration-studio-agent-catalog`).

## 0. Summary answer

1. **The live product runs two flows, not one.** Every new or opened project goes to the chat-first **Studio**
   (`App.tsx:1935`, `App.tsx:2356-2367` `openProjectInStudio`, rendered at `App.tsx:5781-5830`). Studio has 7 stages:
   `specs, visualization, design, simulation, devices, magnetics, thermal` (`lib/studio/types.ts:21-23`).
   The old **wizard** screens from your list (Design Intent, Topology, BOM, MTBF, Report, EMC, Component Selection via Mouser,
   Patent) are still in `App.tsx` and `components/`, but the only way into them now is the admin read-only view
   (`App.tsx:1510-1530` `handleViewProjectAsAdmin` sets `currentStep` without a Studio session). The wizard's own saves are
   switched off (`App.tsx:146` `LEGACY_WIZARD_SAVES = false`).
   **Decision needed:** port wizard-only steps (BOM, MTBF, Report, EMC, Mouser sourcing, patents) as backend features, or
   drop them as legacy. This report classifies both.
2. **qdonis-core is used only by the circuit/netlist/simulation/device-library path.** That covers Circuit Visualization,
   Design (sizing + netlist), Simulation, Studio Devices selection, circuit edit, waveform stats, loss recalculation and the
   legacy assistant. Everything else is either an LLM call with a prompt kept in the FE, pure TypeScript math, or Supabase CRUD.
   None of those touch core.
3. **Can move now (Class A):** project CRUD/list/rename/duplicate/delete/progress, Studio project graph persistence and heavy
   payload storage (S3), auto project naming, Design Intent / mandatory parameters / stage parameters, Constraints
   (`processRequirements`), topology recommendation (LLM), sharing (roles, invitations, share links, activity), teams,
   chat history, document parsing, token pre-checks, MTBF, EMC, BOM aggregation/export, step summaries + report PDF,
   Mouser sourcing (wizard), patent query generation (LLM half).
4. **Mixed (Class C):** Magnetics and Thermal. Their engines are pure TS (`lib/studio/magneticsEngine.ts`,
   `lib/studio/thermalEngine.ts`, plus legacy `services/magnetics*`, `thermal*`) and run without core when the user enters the
   parts or losses. When they start from a simulation, they need core's `/api/studio/waveform-stats` and
   `/api/simulate/recalculate_loss`. The engines can move now. The simulation-fed input goes behind an interface the teammate fills.
5. **Teammate's BE work (already done or in progress):** only the Studio agent (`POST /studio/agent`, done). Topology-name
   static list and PyYAML helpers are WIP (no module registered in `app.module.ts:145-155`). **No Project, Share, Team or
   Chat model exists in Prisma** (`prisma/schema/**` has user, billing, settings and documents only). No S3 client exists in BE.
   So none of the Class A work overlaps his.
6. **Supabase project data is broken today.** `services/supabaseClient.ts:10-17` says requests carry only the anon key
   since Clerk was removed, so RLS rejects them. Projects, shares, teams and chat do not persist correctly right now. That makes the
   Projects module the most urgent piece.

## (a) Summary table

Legend: A = no core, movable now · B = depends on core (teammate) · C = mixed.
"LLM (FE prompt)" means the prompt is built in the browser and sent to the generic BE proxy `POST /ai/bedrock/converse`
(`services/bedrockService.ts:39-48, 72-142`).

| # | Step | Entry files | Logic type | qdonis-core? | Supabase usage | Class | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Design Intent (stage-params + mandatory params analysis) | `components/DesignIntentReview.tsx`, `MandatoryParametersCapture.tsx`, `services/designIntentService.ts:91,344` | LLM (FE prompt) | No | via `projects.project_data` only | A | Wizard only. Called at `App.tsx:787-800, 1800-1810` |
| 2 | Constraints / initial spec (`processRequirements`) | Studio `lib/studio/stages.ts:125-201` (`generateConstraints`); wizard `App.tsx:1134`; `services/geminiService.ts:673-811` | LLM (FE prompt) + TS merge | No | `requests`, `sessions` (wizard, `dataStorageService.ts:44,77`) | A | Studio stores the result in the specs node |
| 3 | Specs table edits / approve | `stages.ts:235-303` (`updateSpecs`, `approveSpecs`, `updateConstraints`) | Pure TS state | No | project_data | A | Run by agent tools on the client |
| 4 | Topology recommendation | wizard `geminiService.ts:921-1060` `getTopNTopologies`, `App.tsx:2108`; Studio: the agent proposes, then `recordTopologyOptions` `stages.ts:304` | LLM (FE prompt) | No (wizard). Studio list of ids comes from core-derived static list | `topology_generations` (`dataStorageService.ts:125`) | A | The topology **catalog** (ids/YAML) is the teammate's (`src/topologies`) |
| 5 | Circuit Visualization (`select_topology`) | `stages.ts:380-414`, `components/CircuitVisualizationScreen.tsx`, `services/circuitVisualizationService.ts` | core `/api/visualize` + `/api/studio/circuit-info` | **Yes** | project_data | B | Ledger rows 7, 31 |
| 6 | Circuit edit | `stages.ts:434-492` | core `/api/studio/edit-circuit` + `/api/simulate/status` | **Yes** | project_data | B | Ledger rows 33, 15 |
| 7 | Design (sizing + netlist) | `stages.ts:508-650` (`runDesign`, `modifyDesign`, `setDesignValues`), `components/DesignScreen.tsx` | core `/api/simulate/prepare`, `/api/design/modify-netlist`, `/api/simulate/sync_parameters` | **Yes** | project_data | B | `importNetlist` / `classifyDeck` / `UNSAFE_CONTROL` (`stages.ts:663-710`) are pure TS → A |
| 8 | Simulation Run | `stages.ts:713-823`, `components/SimulationScreen.tsx` | core `/api/simulate*`, ngspice | **Yes** | `simulation_plots` table + `simulation-plots` bucket (`simulationStorageService.ts:15, 117-260, 342-520`) | C | Run = B. Storing results/plots = A (S3 per AGENTS.md "Storage") |
| 9 | Devices (Studio component selection) | `stages.ts:825-1000`, `components/studio/views/DevicesView.tsx` | core `/api/studio/select-devices`, device LUTs | **Yes** | project_data | B | Ledger rows 34, 35 |
| 10 | Magnetics Design | Studio `stages.ts:1176-1395` + `lib/studio/magneticsEngine.ts` (830 lines); wizard `services/magneticsDesignerService.ts`, `generateDesignsTwoPhase.ts`, `magneticsCalculations.ts`, `simulationToMagneticsMapper.ts` | Pure TS physics (Steinmetz/iGSE, Dowell). Wizard also uses LLM (FE prompt) | Only for waveforms from a simulation (`stages.ts:1251` → core `/api/studio/waveform-stats`) | `magnetic_components`, `design_options` (wizard, `dataStorageService.ts:358-486`) | C | Engine + entered-parts path = A. Sim-fed waveforms = B seam |
| 11 | Thermal & Loss Analysis | Studio `stages.ts:1521-1728` + `lib/studio/thermalEngine.ts:141`; wizard `services/thermalCalculations.ts:232`, `thermalIntegration.ts:291`, `ThermalAnalysisScreen.tsx` | Pure TS | Only sim-fed losses (`stages.ts:1619` waveform-stats, `1662-1669` core `recalculate_loss`) | project_data | C | Entered losses / Devices-stage losses = A |
| 12 | Component Selection (wizard, Mouser) | `components/ComponentSelectionScreen.tsx`, `services/mouserService.ts`, `aiSearchOptimizer.ts:31,102`, `geminiService.ts:1509` (`App.tsx:4743`) | LLM (FE prompt) + Mouser REST from the browser | No | `mouser_search_cache`, `mouser_component_options`, `mouser_api_usage`, RPC `cleanup_expired_mouser_cache` (`dataStorageService.ts:580-931`) | A | **Mouser API key in the browser** (`mouserService.ts:5, 172, 712`) |
| 13 | Schematic components for thermal/BOM (wizard) | `geminiService.ts:1190-1402` `getCircuitSchematicData` (`App.tsx:4284`), `netlistParser.ts:638` | LLM (FE prompt) + TS parse | No | — | A | Wizard only |
| 14 | MTBF | `components/MTBFEstimationScreen.tsx`, `services/mtbfCalculations.ts:692, 793` (MIL-HDBK-217F / Telcordia SR-332, `:5-29`) | Pure TS | No | project_data (`mtbfSummary`) | A | `geminiService.ts:2330` LLM variant: no call site found in `App.tsx`/hooks |
| 15 | Bill of Materials | `components/BOMScreen.tsx`, `BOMExportScreen.tsx:14, 93-94` (xlsx, price tiers) | Pure TS aggregation + XLSX in browser | No | project_data (`bomData`, `selectedParts`) | A | Export file → S3 or streamed response |
| 16 | Report | `components/ReportSummaryScreen.tsx`, `services/reportPdfService.ts:365, 1534`, `stepSummaryService.ts:29-399` | Pure TS + PDF in the browser | No | — | A | Generated from project data |
| 17 | EMC calculator | `components/EMCCalculatorModal.tsx`, `services/emcCalculations.ts:37-389` (+ `__tests__/emcCalculations.test.ts`) | Pure TS | No | — (not persisted) | A | Stateless calculator, opened from `App.tsx` EMC modal |
| 18 | Patent search | `components/PatentSearchScreen.tsx`, `TopologyDisplayScreen.tsx:18-19`, `services/patentQueryGenerator.ts:156, 278, 435`, `clarivateService.ts:410-548` | LLM (FE prompt) + Clarivate via BE `/patents/*` | No | `patent_analysis` via `dataStorageService.ts:976-1109` | A | **BE has no `/patents` routes** (controller list), so this is broken today |
| 19 | Project naming | `designIntentService.ts:246-292` (dup. in `geminiService.ts:176-219`), `App.tsx:1901-1922` | LLM (FE prompt), FE renames after create | No | `projects.name` | A | Should be server-side after create |
| 20 | Studio chat agent | `lib/studio/agent.ts:71-125` → BE `POST /studio/agent` | LLM in BE (done) | Migrated (ledger row 36) | `token_usage` side tracking (StudioShell) | done | Tools still execute in the browser (`agent.ts:126-238`) |
| 21 | Legacy assistant (ChatPanel) | `services/assistantService.ts:18, 55, 213` | core `/api/assistant*` | **Yes** | `chat_messages` (`chatHistoryService.ts:25-155`) | C | Assistant = B (ledger 29/30). Chat history CRUD = A |
| 22 | Composer / circuit editor / optimize | `circuitVisualizationService.ts:708, 772`, `circuitEditorService.ts:389-413` | core | Yes | — | dropped | Ledger §6: dropped by user decision |

Cross-cutting (all Class A, no core):

| Feature | FE source | Supabase tables / functions |
|---|---|---|
| Project create/list/get/update/rename/describe/delete/duplicate/versions/search/last-accessed/progress | `services/projectService.ts:31-920`, `hooks/useProjects.ts:239`, `hooks/useAutoSave.ts`, `components/HomePage.tsx` | `projects`, `project_versions`, `project_shares`, `simulation_plots` + bucket (duplicate: `simulationStorageService.ts:146-207`) |
| Sharing (roles, invitations, share links, activity, permission check) | `services/sharingService.ts:47-1316`, `types/sharingTypes.ts:388`, `hooks/useSharing.ts`, `ShareProjectModal.tsx`, `ShareLinkAccessPage.tsx`, `AcceptInvitationPage.tsx` | `project_shares`, `pending_invitations`, `share_links`, `project_activity_log`, `email_delivery_log`, edge fn `send-invitation-email` (`emailService.ts`) |
| Teams + team invitations + team token analytics | `services/teamService.ts:159-1036`, `hooks/useTeams.ts`, `CreateTeamModal.tsx`, `TeamSettingsModal.tsx`, `AcceptTeamInvitationPage.tsx` | `teams`, `team_members`, `team_invitations`, `team_token_usage`, edge fn `send-team-invitation-email` |
| Chat history (legacy panel) | `services/chatHistoryService.ts:25-155` | `chat_messages` (migrations 007/008) |
| Studio project graph + heavy payloads | `lib/studio/persistence.ts:19-275`, `lib/studio/blobCache.ts` (IndexedDB) | `projects.project_data.studio`, bucket `simulation-plots` `<user>/<project>/studio/<node>.json.gz` (`simulationStorageService.ts:209-250`) |
| Session / request logging, export | `services/dataStorageService.ts:44-272` | `sessions`, `requests`, `topology_generations` |
| Token usage per project/step | `services/tokenUsageService.ts:66-335` | `token_usage`, views `project_token_summary`, `step_token_summary` (migration 005) |
| Token pre-check before generation | `App.tsx:1950-2000` (hard-coded 7,500), `services/subscriptionService.ts:168-199` | none (already BE billing) |
| Document parsing (PDF/DOCX → text) | `services/documentParserService.ts:1-2, 98-283` (pdfjs, mammoth, `[BASE64_PDF:]` fallback) | none |

## (b) Per-step detail

### 1. Design Intent / mandatory parameters / stage parameters — Class A
- Entry: wizard step `mandatoryCapture` renders `DesignIntentReview` (`App.tsx:5195-5212`). Handlers call
  `analyzeRequiredStageParameters` then `analyzeMandatoryParameters` (`App.tsx:787-800` re-analyze, `1800-1810` first run).
- Logic: `services/designIntentService.ts` builds prompts and calls `callBedrock` (`:173`, `:425`) inside `withAiStep`
  (`:34, :61`) so BE applies the step multiplier (`stage_parameters_analysis`, `mandatory_parameters` in
  `src/settings/settings.schema.ts:141-154`). Duplicate older copies sit in `geminiService.ts:266-499`.
- Persisted: `mandatoryParametersAnalysis`, `constraintParameters` inside `projects.project_data` (`App.tsx:1527-1529`).
- Billing: charged server-side by `/ai/bedrock/converse`. FE also writes `token_usage` (`tokenUsageService.ts:66`).
- Move: `POST /projects/:id/design-intent/analyze` with server-held prompts. Output validated by a DTO and stored on the project.

### 2. Constraints (Studio specs → constraints) — Class A
- `generateConstraints` (`stages.ts:125-201`) builds the user text from the specs rows and hand-set constraints. It calls
  `processRequirements` (`geminiService.ts:673-811`, `callBedrock` at `:811`), maps `derivedParametersList` into
  `ConstraintItem`s, merges by normalized name (`stages.ts:72`), and decides fork vs. in-place commit
  (`stages.ts:173-182`). Pure TS helpers: `specsToParameters` `:73`, `specNumbers` `:316`, `specValue` `:328`,
  `specTemperatures` `:352`.
- Persisted: `specs` node `data.constraints` in `project_data.studio` (`persistence.ts:29-36` handles interrupted runs).
- Move: whole function server-side. BE owns versioning (commit/fork) once the project graph lives in BE.

### 3. Topology — Class A (recommendation) / B (catalog)
- Wizard: `getTopNTopologies` (`geminiService.ts:921-1060`) via `App.tsx:2108-2147`. It caches by deep-equal of params
  (`App.tsx:2028-2047`), invalidates downstream (`App.tsx:2063-2069`, `src/utils/stepInvalidation.ts`), and saves
  `topology_generations` (`dataStorageService.ts:125`).
- Studio: the BE agent proposes topologies from the static id list (`src/studio/agent/topology-library.ts`, 35 ids).
  The FE records options with `recordTopologyOptions` (`stages.ts:304`).
- The topology **library** (YAML, json_library, prompts) is core data the teammate is porting (ledger §2, step2 design §1.2).
  Recommendation logic is LLM-only and can move now. It should read ids from his `TopologiesModule` when that lands.

### 4. Circuit Visualization — Class B
- `selectTopology` (`stages.ts:380-414`) → `visualizeCircuit` (`circuitVisualizationService.ts:346`, core `POST /api/visualize`) and
  `fetchInventory` (`stages.ts:364-377`, core `POST /api/studio/circuit-info`). Calls carry **no auth header**
  (`stages.ts:366-370`). Teammate's step 2 covers this (`step2-catalog-visualization-design.md` §1.4-1.6).
- The only movable part is persisting the visualization node (project graph).

### 5. Design — Class B (with a small A part)
- `runDesign` (`stages.ts:508-560`) → `prepareNetlist` (core `/api/simulate/prepare` + polling `/api/simulate/status`
  `stages.ts:416-428`). `modifyDesign` `:561` → core `/api/design/modify-netlist`. `setDesignValues` `:603` →
  `syncParametersToNetlist` (core `/api/simulate/sync_parameters`).
- Class A part: `importNetlist`/`classifyDeck`/`UNSAFE_CONTROL` (`stages.ts:663-710`). These are a netlist upload safety filter
  and must move server-side, because a client-side filter is not a security control. `quickParamsService.ts` (TS) and
  `computeDesignNumbers.ts` (TS) feed legacy DesignScreen.

### 6. Simulation Run — Class C
- Run: `runSimulation` (`stages.ts:713-783`) → core `/api/simulate`, `/api/simulate/rerun`, ngspice. Teammate's area (ledger 8-15).
- Storage (movable now): `SimulationStorageService` (`simulationStorageService.ts`). It keeps a decimated preview row in
  `simulation_plots` (`:342-520`) and gzipped full-res plots and Studio heavy payloads in bucket `simulation-plots` at
  `<userId>/<projectId>/plots.json.gz` and `.../studio/<nodeId>.json.gz` (`:15-18, 117-250`). `persistence.ts:18`
  strips `plots` and `raw_time_series_zip` from the saved graph (`HEAVY_SIM_KEYS`). `persistHeavyPayloads`/`restoreHeavyPayloads` are at `:199-275`.
  RLS on this table/bucket allows **anon read/insert/update** (`migrations/012_fix_simulation_plots_rls.sql:80-92`).
- Target: S3 object store (AGENTS.md "Storage") behind a `ProjectArtifactsService`. The teammate's simulation job writes
  results through it.

### 7. Devices (Studio) — Class B
- `selectDevices` / `requestSelection` (`stages.ts:862-1000`) → core `/api/studio/select-devices` with the device LUT library.
  `missingStressInputs` (`:850`) only mirrors BE checks.

### 8. Magnetics Design — Class C
- Studio `runMagnetics` (`stages.ts:1176-1395`). With `parts` entered, it is fully local: `partRequirement`
  (`:1112-1174`) builds idealised waveforms (`synthesizeWaveforms`), and `designMagnetic` (`magneticsEngine.ts`) uses Steinmetz
  data, iGSE (`:349`), Dowell AC resistance (`:233`) and winding search (`:385-458`). Data tables are `services/data/steinmetzData.ts`,
  `materialProperties.ts`, `coreGeometryData.ts`, `wireGaugeData.ts`.
  From a circuit it needs `fetchWaveformStats` (`stages.ts:1042-1100`, core `/api/studio/waveform-stats`, `:1251`).
- Wizard: `extractComponents`/`extractRequirements`/`inferMissingParameters` LLM (`magneticsDesignerService.ts:617-1153`,
  `App.tsx:3068-3085, 3347-3371`). `generateDesignsForUI` (`generateDesignsTwoPhase.ts:842-1086, 1480`) has an LLM phase for
  qualitative choices and a TS phase for the numbers (`App.tsx:3791-3795`). Prompts are in `services/magneticsPrompts.ts` (1,141 lines).
  Tests exist (`services/__tests__/magnetics*.test.ts`).
- Persisted: Studio `magnetics` node. Wizard also uses `magnetic_components`, `design_options` (`dataStorageService.ts:358-486`,
  `projectService.ts:860-920`).
- Move now: engine + data tables + entered-parts path + wizard LLM extraction. The sim waveform provider stays a seam (see §d).

### 9. Thermal & Loss — Class C
- Studio `runThermal` (`stages.ts:1521-1728`) → `analyzeThermal` (`thermalEngine.ts:141`). Inputs come from entered losses,
  the Devices stage (`devicesStageInputs` `:1502`), or simulation waveform stats (`:1619`, core). Post-step electro-thermal
  loss recalculation at the hottest Tj calls core `recalculateLosses` (`:1660-1669`, `/api/simulate/recalculate_loss`).
- Wizard: `thermalCalculations.ts:232`, `thermalIntegration.ts:291, 421`, tests in `__tests__/thermalCalculations.test.ts`.
- Move now: engine and the entered/devices-stage paths. The sim path and loss recalculation go behind the seam.

### 10. Component Selection (wizard / Mouser) — Class A
- `generateSourcingComponentsWithSearchParams` LLM (`geminiService.ts:1509-1722`, `App.tsx:4743`),
  `generateMouserSearchTerms` LLM (`aiSearchOptimizer.ts:31-102`), Mouser keyword/part search from the browser
  (`mouserService.ts:4-5, 544, 1031-1181`), caching + rate-limit logs in Supabase (`dataStorageService.ts:580-931`).
  `evaluateMouserComponent` LLM (`geminiService.ts:2142-2242`).
- Move: `SourcingModule` with a server-side Mouser client (key in `EnvironmentVariables`), a cache table with TTL, a usage log,
  and BE prompts.

### 11. MTBF — Class A
- `calculateMTBFComponents` / `calculateSystemMTBF` (`mtbfCalculations.ts:692, 793`), using MIL-HDBK-217F and Telcordia SR-332 base
  rates (`:5-29`). Pure function of the component list. The result is stored as `mtbfComponents`/`mtbfSummary` in project_data.

### 12. BOM — Class A
- `BOMScreen.tsx` / `BOMExportScreen.tsx`: picks the price from pricing tiers (`:93-94`), computes extended price, and exports XLSX in the
  browser (`:14`, reference template comment `:7`). Move aggregation + export to BE (`GET /projects/:id/bom`,
  `GET /projects/:id/bom/export.xlsx`).

### 13. Report — Class A
- `stepSummaryService.ts:29-399` (pure text summaries per step) + `reportPdfService.ts:365-1534` (PDF generation, client).
  Move to `ReportsModule`: server builds the summary and PDF and streams it, or stores it to S3 with a signed URL.

### 14. EMC — Class A
- `emcCalculations.ts:37-389` (switching frequency, duty, Fourier amplitude, harmonic current, LISN stage voltages, dBµV,
  CISPR limit lookup `getTargetEmissionLevel` `:238`, `runVoltageScan` `:318`, `getSpectrumData` `:389`). Stateless and tested.
  Move as `POST /emc/calculate` (and optionally persist per project).

### 15. Patent search — Class A (LLM) / external
- Query generation and analysis are LLM calls (`patentQueryGenerator.ts:156, 278, 435`, own `PATENT_MODEL_ID`).
  The search calls BE `/patents/search|analytics|:id|:id/citations` (`clarivateService.ts:410-548`), and **no such BE route exists**.
  Needs a `PatentsModule` (Clarivate client with the key in BE) or should be dropped.

### 16. Project naming — Class A
- After create, FE calls `generateProjectName` (`designIntentService.ts:246-292`) then `renameProject`
  (`App.tsx:1901-1922`). Move: BE generates the name asynchronously after `POST /projects` (step `project_name_generation`),
  and the rename is a server write.

## (c) Teammate's existing Nest work (branch `feature/core-migration-studio-agent-catalog`)

`git log`: `21c4519 Migrate Studio agent from qdonis-core; WIP catalog/visualization port`, on top of `67f1944 first commit`.
Working tree clean.

- **Done:** `src/studio/` — `POST /studio/agent` (`studio.controller.ts:24-40`), system prompt + 17 tools
  (`agent/studio-system-prompt.text.ts`, `agent/studio-tools.ts` 662 lines), message normalizer, request builder, parity specs,
  charging step `studio_agent`. The agent takes `project_state` **from the client** (ledger §7 D11).
- **WIP, not wired:** `src/topologies/topologies.types.ts`, `library/topology-names.ts` (55 lines), `library/pyyaml-schema.ts`;
  `src/common/python/python-json.ts`, `python-semantics.ts`; `assets/MANIFEST.json` + `assets/models/**` (device LUT JSON).
  There is no `TopologiesModule` in `app.module.ts:145-155`.
- **Planned by him** (`.agents/migration/core-migration-ledger.md` §1, `step2-*.md`): topologies, devices, circuit-info,
  visualization (step 2), then simulation (prepare/rerun/sync/verify/recalculate-loss/jobs), netlist ai-fix, waveform stats,
  edit-circuit, select-devices, modify-netlist, legacy assistant. Data assets and ngspice are covered in ledger §2/§4.
- **Not present anywhere in BE:** Project / Share / Invitation / ShareLink / Team / TeamMember / ChatMessage / ProjectArtifact
  models, S3 client, patents, sourcing, reports.
- Existing building blocks to reuse: `AiService` + Bedrock client (`src/ai/ai.service.ts`, `bedrock/bedrock.client.ts`),
  `TokensService.consume` with idempotency (`src/billing/tokens.service.ts:91`), `TokenLedgerEntry.metadata` JSON
  (`prisma/schema/billing/token-ledger-entry.prisma`), step multipliers (`settings.schema.ts:112-190`), `MailModule`
  (invitation emails), global `JwtAuthGuard` + `@Roles()`.

## (d) Proposed Nest module breakdown (Class A) and the seam for Class B

Order reflects dependencies. Names only + key fields.

1. **ProjectsModule** (`src/projects/`): CRUD, list (owned / shared / team, paginated in `$transaction`), rename, duplicate
   (deep copy incl. artifacts), soft/hard delete, last-accessed, search, versions, progress computed server-side.
   - `Project`: id, ownerId → User, teamId?, name, description?, status, studio `Json` (graph: nodes/branches/messages,
     `version`), legacyData `Json?` (wizard AppState), progressCompleted Int, progressTotal Int, lastAccessedAt,
     revision Int (optimistic concurrency for autosave), createdAt, updatedAt, deletedAt?.
   - `ProjectVersion`: id, projectId, revision, snapshot `Json`, createdById, label?, createdAt.
2. **ProjectArtifactsModule** (`src/projects/artifacts/` + `src/common/storage/s3.service.ts`): S3 put/get/copy/delete for heavy
   payloads (sim plots, studio node blobs, BOM/report exports). Signed URLs only.
   - `ProjectArtifact`: id, projectId, nodeId?, kind (enum: SIM_PLOTS, STUDIO_NODE_BLOB, BOM_EXPORT, REPORT_PDF, UPLOAD),
     s3Key, contentType, sizeBytes, sha256, createdAt.
3. **ProjectAccess / SharingModule** (`src/sharing/`): one `ProjectAccessService.assert(userId, projectId, action)` used by every
   project route. It replaces `get_user_project_role` (`001_add_project_sharing.sql:309-345`) and all RLS policies.
   - `ProjectMember` (was `project_shares`): projectId, userId, role (enum VIEWER/EDITOR/ADMIN), grantedById, expiresAt?, isActive, unique(projectId,userId).
   - `ProjectInvitation`: projectId, email (citext/lowercased), role, tokenHash, invitedById, message?, expiresAt, acceptedAt?, revokedAt?, unique(projectId,email).
   - `ShareLink`: projectId, tokenHash, linkType (enum ANYONE/DOMAIN/ONE_TIME/PASSWORD), role (VIEWER/EDITOR), allowedDomains String[],
     passwordHash? (argon2/bcrypt), maxUses?, uses, expiresAt?, isActive, lastUsedAt?.
   - `ProjectActivity`: projectId, userId, action, details `Json`, stage?, createdAt.
4. **TeamsModule** (`src/teams/`): teams, members, invitations (email via MailModule), team projects.
   - `Team`: id, name, ownerId, createdAt. `TeamMember`: teamId, userId, role (OWNER/ADMIN/MEMBER). `TeamInvitation`: teamId, email, role, tokenHash, expiresAt, acceptedAt?.
   - Team token pool: **open question** (see §e). FE already ignores team pools (`subscriptionService.ts:193-199`).
5. **ProjectChatModule** (legacy panel history; Studio messages live in `Project.studio.messages`):
   - `ProjectChatMessage`: projectId, userId, sender (USER/AI), content, metadata `Json`, createdAt.
6. **DesignIntentModule / SpecsModule** (`src/design-intent/`): server-side prompts for stage params, mandatory params,
   `processRequirements` (constraints), topology recommendation, project naming. Each step uses `AiService` with its step key and writes the
   result into the project graph through `ProjectGraphService` (below). Prompts move from `designIntentService.ts`,
   `geminiService.ts`, `magneticsPrompts.ts` into `src/<module>/prompts/*.ts`.
7. **ProjectGraphService** (inside ProjectsModule): server-owned Studio graph operations ported from `lib/studio/store.ts`
   (`commitStage`, fork/branch, `stageNodeOnBranch`, `specsSignature`, `serializeProject` rules). Stage modules commit through this,
   and the client stops writing whole `project_data` blobs.
8. **MagneticsModule** + **ThermalModule** (`src/magnetics/`, `src/thermal/`): port `magneticsEngine.ts`, `thermalEngine.ts`, the
   `services/data/*` tables and the existing `__tests__` as Jest specs (numeric parity). Endpoints: `POST /projects/:id/magnetics`,
   `POST /projects/:id/thermal` (entered inputs). Sim-fed inputs go through the seam.
9. **ReliabilityModule** (MTBF), **EmcModule**, **BomModule** (aggregate + XLSX), **ReportsModule** (summaries + PDF): pure ports.
10. **SourcingModule** (Mouser client, `MouserSearchCache` {queryHash, response Json, expiresAt}, `MouserApiUsage` {userId, endpoint, status, latencyMs, createdAt}) and **PatentsModule** (Clarivate),
    if the wizard features are kept.
11. **DocumentsModule extension**: `POST /documents/parse` (multipart, size/type limits, pdf/docx → text server-side, original to S3).
    Today parsing is client-side (`documentParserService.ts`).
12. **Billing touch-up**: replace FE `token_usage` writes (`tokenUsageService.ts:66`) with `TokenLedgerEntry.metadata.projectId/step`,
    and expose `GET /projects/:id/usage`. The 7,500-token pre-check (`App.tsx:1950-2000`) becomes a BE guard
    (`TokensService` balance check) on each charged route.

**Integration seam for Class B (teammate implements):** define in `src/projects/stage-providers/` and inject via Nest tokens:

```ts
export interface CircuitProvider {            // visualization, circuit-info, edit-circuit
  visualize(userId: string, input: { topologyId: string; circuit?: unknown }): Promise<VisualizationResult>;
  inventory(userId: string, input: { topologyId: string; circuit?: unknown; recalculated?: unknown[] }): Promise<CircuitInventory>;
  editCircuit(userId: string, input: EditCircuitInput): Promise<JobRef>;
}
export interface DesignProvider {             // prepare / modify-netlist / sync-parameters
  prepare(userId: string, input: DesignInput): Promise<JobRef>;
  modify(userId: string, input: ModifyDesignInput): Promise<JobRef>;
  syncParameters(userId: string, input: SyncInput): Promise<DesignResult>;
}
export interface SimulationProvider {          // simulate / rerun / recalculate-loss / waveform stats
  run(userId: string, input: SimulationInput): Promise<JobRef>;
  waveformStats(userId: string, input: WaveformStatsInput): Promise<WaveformStats>;   // feeds magnetics + thermal
  recalculateLosses(userId: string, input: LossRecalcInput): Promise<LossAnalysis>;
}
export interface DeviceSelectionProvider { select(userId: string, input: DeviceSelectionInput): Promise<JobRef> }
export interface JobsProvider { get(userId: string, jobId: string): Promise<JobStatus<unknown>> }
```

Stage orchestration (auth, project access, token gating, graph commit, artifact upload to S3) lives in our modules. The providers are
pure compute and return DTOs. Until his code lands, bind a provider that throws `501 STAGE_NOT_AVAILABLE`, or temporarily proxies
core server-side so the browser never calls core directly. The Studio agent should move from client-supplied `project_state`
to loading the project server-side by `projectId` once ProjectsModule exists. Agree that change with the teammate, because it touches his DTO
(`src/studio/dto/studio-agent.dto.ts`).

## (e) Risks / open questions

1. **LLM prompts and orchestration in the FE.** `POST /ai/bedrock/converse` accepts arbitrary `messages` from any signed-in user
   (`bedrockService.ts:72-90`), so it is a general-purpose paid LLM proxy. The step name is client-chosen (`:79`) and so is the
   multiplier key. Once prompts move to BE, restrict or remove the generic route.
2. **Secrets in the browser bundle:** `VITE_MOUSER_API_KEY` (`mouserService.ts:5`, sent as a query param `:172, :712`),
   `VITE_OPENROUTER_API_KEY` and the Supabase anon key in `qdonis/.env`. `qdonis/supabase/functions/.env` holds `BEDROCK_API_KEY`.
   Rotate them after migration. (Values not reproduced here.)
3. **Supabase RLS is the only authorization today, and it is bypassed or broken.** Anon policies on `simulation_plots`
   (`012_...sql:80-92`), `token_usage` insert `WITH CHECK (true)` (`005_...sql:85-88`), "Anyone can view share links by token"
   (`006_...sql:26-30`). With Clerk gone the anon client cannot pass per-user RLS (`supabaseClient.ts:10-14`). Every rule in
   `001`, `004`, `005`, `006`, `012`, `013` must be re-expressed in `ProjectAccessService`.
4. **Share-link passwords** are hashed client-side with unsalted SHA-256 and compared client-side
   (`sharingService.ts:1297-1316`, `TODO: Use bcrypt`). Share/invitation tokens are stored in plain text
   (`001_...sql:13, 40, 63`). BE should store token hashes, use argon2/bcrypt, check atomically, and rate-limit.
5. **Core endpoints are called without auth from the browser** (`stages.ts:366-370, 420, 448-452, 863-866, 1054`). This is the teammate's area,
   but our seam must make the browser never reach core.
6. **Schema is not fully in migrations.** `projects`, `project_versions`, `teams`, `team_members`, `team_invitations`,
   `team_token_usage`, `sessions`, `requests`, `topology_generations`, `magnetic_components`, `design_options`, `mouser_*`,
   `patent_analysis`, `simulation_plots` have no `CREATE TABLE` in `qdonis/supabase/migrations/`. Their columns can only be inferred from code
   (e.g. `projectService.ts:40-48`). A data export from the live Supabase project is needed to plan a data migration.
   **Whether existing user data must be migrated is unknown.** User ids are Clerk `TEXT` ids (`001_...sql:12`) and BE users are UUIDs.
7. **Progress model mismatch.** `calculateProgress` (`projectService.ts:226-243`) counts 10 wizard keys. Studio projects only populate
   a few through `toProjectData` (`persistence.ts:47-99`). Define progress on Studio stages (7) server-side.
8. **Autosave races.** The client saves whole `project_data` blobs (`useAutoSave`, `StudioShell.tsx`). Concurrent editors overwrite
   each other. Use a `revision` check (409 on mismatch) or server-side graph commits.
9. **Payload size.** `BODY_LIMIT` is 5 MB (ledger §3). Studio graphs and sim data can exceed it. That is why heavy payloads must go to S3.
10. **Team token pools:** `team_token_usage` exists, but FE team checks already fall back to the user (`subscriptionService.ts:193-199`).
    Decide whether team pools are in scope. BE billing (`BillingAccount`, `TokenBatch`) is per-user.
11. **Legacy wizard scope** (summary item 1): decide keep/port vs. drop for BOM, MTBF, Report, EMC, Mouser sourcing, patents,
    `sessions`/`requests` logging, `project_presence` (table exists, no FE usage found by grep).
12. **Patents** currently call non-existent BE routes (`clarivateService.ts:423`). A Clarivate credential is needed if kept.
13. **Things not determined:** exact prompt text sizes per step (not read in full), whether `geminiService.getMtbfCalculations`
    (`:2330`) or `getSuggestedComponentsForBOM` (`:1927`) have live callers outside `App.tsx`/hooks, and the content of edge
    function `main` (`supabase/functions/main/index.ts`, not read).

## Recommendation

Start with ProjectsModule + ProjectAccess/Sharing + ProjectArtifacts (S3). This fixes broken persistence and gives every later stage an
authorized home. Next, move the LLM steps (design intent, constraints, topology recommendation, naming) with BE-held prompts. Then
port the pure engines (magnetics, thermal, MTBF, EMC, BOM, report) with their existing tests as parity specs. Publish the provider
interfaces above to the teammate before he wires simulation, so his modules return DTOs and ours own persistence, access and charging.
