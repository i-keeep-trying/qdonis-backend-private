# qdonis-core -> qdonis-backend migration ledger

Self-contained record of what qdonis-core (Python/Flask) provides and where each piece goes in
qdonis-backend (NestJS). qdonis-core will be deleted once every row below is `done` or `dropped`.

- Source: `qdonis-core/.agents/tasks/core-inventory-2026-10-08.md` (sections 2-13), cross-checked against the
  37 `@app.route` decorators of `qdonis_backend/api_server.py` at `239d79a` (`feature/chat-first`).
  Line numbers below are at that commit (the inventory used older numbering).
- Frontend (`qdonis`, branch `feature/studio-agent`) call sites re-checked on 2026-10-09.
- Status: `todo` / `in-progress` / `done` / `dropped`.

## 1. Routes (37)

| # | Route (core line) | FE call sites | Planned Nest endpoint / module | Status | Parity evidence |
|---|---|---|---|---|---|
| 1 | `GET /health` (512) | `services/assistantService.ts:334`, `services/circuitVisualizationService.ts:203` | existing `GET /health` (`src/health`); add ngspice probe with simulation | todo | |
| 2 | `GET /health/ready` (525) | none | `GET /health/ready` (ngspice + compiler probes) | todo | |
| 3 | `GET /api/topologies` (536) | `circuitVisualizationService.ts:234` | `GET /api/v1/topologies` (topology library module) | todo | |
| 4 | `GET /api/models/mosfet` (576) | `circuitVisualizationService.ts:263` | `GET /api/v1/devices?kind=mosfet` (device library module) | todo | |
| 5 | `GET /api/models/diode` (593) | `circuitVisualizationService.ts:287` | same, `kind=diode` | todo | |
| 6 | `GET /api/models/igbt` (608) | `circuitVisualizationService.ts:311` | same, `kind=igbt` | todo | |
| 7 | `POST /api/visualize` (623) | `circuitVisualizationService.ts:346` (also via `lib/studio/stages.ts`) | `POST /api/v1/visualization` (static json_library + netlist; LLM fallback on shared Bedrock layer) | todo | |
| 8 | `POST /api/simulate/prepare` (986) | `circuitVisualizationService.ts:556` (studio stages) | `POST /api/v1/simulation/prepare` (async job) | todo | |
| 9 | `POST /api/simulate/rerun` (1240) | `circuitVisualizationService.ts:496` | `POST /api/v1/simulation/rerun` (async job, ngspice) | todo | |
| 10 | `POST /api/simulate/sync_parameters` (1304) | `circuitVisualizationService.ts:1076` | `POST /api/v1/simulation/sync-parameters` | todo | |
| 11 | `POST /api/simulate/verify-rerun` (1370) | `circuitVisualizationService.ts:980` | `POST /api/v1/simulation/verify-rerun` (LLM, shared Bedrock layer, charged) | todo | |
| 12 | `POST /api/netlist/ai-fix` (1629) | `circuitVisualizationService.ts:624` | `POST /api/v1/netlist/ai-fix` (async LLM, charged) | todo | |
| 13 | `POST /api/simulate` (1683) | `circuitVisualizationService.ts:402` | `POST /api/v1/simulation` (one-shot async job) | todo | |
| 14 | `POST /api/simulate/recalculate_loss` (1746) | `circuitVisualizationService.ts:1102` | `POST /api/v1/simulation/recalculate-loss` | todo | |
| 15 | `GET /api/simulate/status/<task_id>` (1798) | `circuitVisualizationService.ts:435, 519, 578, 664, 1034`; `lib/studio/stages.ts:420` | `GET /api/v1/jobs/:id` (persistent job store, per-user) | todo | |
| 16 | `POST /api/optimize` (1836) | `circuitVisualizationService.ts:708` (always 501) | none | dropped | stub always answered 501 |
| 17 | `POST /api/compose` (1892) | `circuitVisualizationService.ts:772` | none | dropped | composer not used (user decision) |
| 18-28 | `POST /api/editor/{load,state,add-component,delete-component,update-params,add-net,delete-net,update-net,valid-pins,export,recompile}` (2108-2365, 11 routes) | `services/circuitEditorService.ts:413` | none | dropped | editor not used (user decision) |
| 29 | `POST /api/assistant` (2425) | `services/assistantService.ts:55` | legacy assistant module on the shared Bedrock layer (charged) | todo | |
| 30 | `POST /api/assistant/stream` (2526) | `services/assistantService.ts:213` | same, SSE (`content`/`tool_call`/`done`/`error`) | todo | |
| 31 | `POST /api/studio/circuit-info` (2656) | `lib/studio/stages.ts:366` | `POST /api/v1/studio/circuit-info` | todo | |
| 32 | `POST /api/studio/waveform-stats` (2682) | `lib/studio/stages.ts:1054` | `POST /api/v1/studio/waveform-stats` | todo | |
| 33 | `POST /api/studio/edit-circuit` (2734) | `lib/studio/stages.ts:448` | `POST /api/v1/studio/edit-circuit` (async LLM, charged) | todo | |
| 34 | `POST /api/studio/select-devices` (2814) | `lib/studio/stages.ts:863` | `POST /api/v1/studio/select-devices` (async) | todo | |
| 35 | `GET /api/studio/device-library` (2848) | none found | `GET /api/v1/devices/catalogue` | todo | |
| 36 | `POST /api/studio/agent` (2855) | `lib/studio/agent.ts` (`openAgentStream`, flag `VITE_STUDIO_AGENT_BACKEND=core`) | `POST /api/v1/studio/agent` (`src/studio`, JWT, charged, step `studio_agent`) | done | see below |
| 37 | `POST /api/design/modify-netlist` (3076) | `circuitVisualizationService.ts:1004` | `POST /api/v1/design/modify-netlist` (async LLM, charged) | todo | |

Studio agent (row 36) evidence, 2026-10-09:
- Fixtures: `test/parity/fixtures/studio-agent/01..16-*.json` + `topology-ids.json`, captured from core `239d79a`
  by `test/parity/capture/studio_agent_capture.py` (re-run is byte-identical; core `git status` unchanged).
- Specs: `src/studio/agent/studio-request.parity.spec.ts` (16 fixtures: system prompt, toolConfig, messages,
  full request deep-equal), `src/studio/agent/studio-agent.service.spec.ts` (16 fixture replays: events,
  charge once), `test/studio.e2e-spec.ts` (401, 400, 402 before any Bedrock call, charge once, multiplier,
  error event, abort on disconnect). All green.
- Live Bedrock: same first-turn request to Nest and Python gave identical `prompt_tokens` (11,920), event types
  (`text`, `tool_call`, `done`), tool (`ask_user`, input keys `fields`, `question`), `stop_reason` `tool_use`.
  One `ai_usage` ledger entry with `step: studio_agent`; two-turn loop continued after `tool_result`
  (`end_turn`). Details in `step1-studio-agent-report.md`.

## 2. Data assets

| Asset | Core path | Count / size | Consumer route(s) | Target in BE | Status |
|---|---|---|---|---|---|
| Topology YAML (simulation source of truth) | `qdonis_backend/data/topologies/primitives/*.yaml` | 35 | 7-15, 31, 33 | `data/topologies/primitives/` (checksummed copy) | todo |
| Pre-drawn schematics (viewer JSON) | `qdonis_backend/data/topologies/json_library/*.json` | 35 (316 KB) | 3, 7, 31, 33; ids also feed the agent | `data/topologies/json_library/` | todo (ids frozen in `src/studio/agent/topology-library.ts` meanwhile) |
| Per-topology sizing prompts | `qdonis_backend/data/topologies/prompts/*.prompt.md` | 31 (57 KB) | 8, 13 (LLM sizing) | `data/topologies/prompts/` | todo |
| Device loss LUTs | `qdonis_backend/data/models/library/{diode,igbt,mosfet}/**/*.json` | 483 + 122 + 253 = 858 (3.2 MB) | 4-6, 9, 13, 14, 34, 35 | `data/models/library/` | todo |
| SPICE component templates | `qdonis_backend/data/spice/spice_components.json` | 1 (28 KB) | netlist generation (7-13) | `data/spice/` | todo |
| tscircuit data | `qdonis_backend/data/tscircuit/{tsx_components.json,symbols.json}` | 34 KB | composer/editor only | none | dropped (with composer/editor) |
| Legacy assistant prompt | repo `prompts/assistant_system.txt` | 15.7 KB | 29, 30 | `src/assistant/prompts/` | todo |
| Electrical guidelines + magnetics domain text | repo `prompts/electrical_guidelines.txt`, `assistant_service.load_domain_knowledge` | 1 file + inline text | 29, 30 | `src/assistant/prompts/` | todo |
| Other repo prompts | repo `prompts/` (10 files total) | 10 | 29, 30, sizing | review per file when porting the assistant | todo |
| Studio agent system prompt + 17 tool schemas | inline in `qdonis_backend/studio_agent.py` | 1 + 17 | 36 | `src/studio/agent/studio-system-prompt.text.ts`, `studio-tools.ts` | done |
| RAG / FAISS index | `qdonis_backend/data/vectordb/*` | 91 MB | 17 only | none | dropped |
| Backups / notes | `data/topologies/backup_*`, `primitive_topologies.zip`, `*_FIX*.md` | n/a | none | none (read for context only) | dropped |

Copy rule for every `todo` asset: copy byte-for-byte, record a SHA-256 manifest in BE, and add a test that the
loader reads every file.

## 3. Environment variables

| Core name | Nest name / decision | Status |
|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | same names; SigV4 credentials passed explicitly to the SDK (`bedrock.authMode = sigv4`) | done |
| `AWS_BEARER_TOKEN_BEDROCK` | `BEDROCK_API_KEY` (bearer mode when no AWS key pair) | done |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | `BEDROCK_REGION` -> `AWS_REGION` -> `us-east-1` (`AWS_DEFAULT_REGION` dropped) | done |
| `AWS_PROFILE` | dropped (no ambient credential chain) | dropped |
| `BEDROCK_MODEL_ID` | `BEDROCK_ALLOWED_MODELS[0]` | done |
| `BEDROCK_CONNECT_TIMEOUT` (10 s) | constant `CONNECT_TIMEOUT_MS` in `bedrock-runtime.provider.ts` | done |
| `BEDROCK_READ_TIMEOUT` (300 s) | `BEDROCK_TIMEOUT_MS` (per-call deadline + socket inactivity) | done |
| `BEDROCK_STREAM_READ_TIMEOUT` (60 s) | constant `STREAM_IDLE_TIMEOUT_MS` | done |
| `OPENROUTER_API_KEY`, `OPENROUTER_API_BASE`, `LLM_*_MODEL` | dropped with the composer; nothing else should use OpenRouter | dropped (verify when porting 29/30) |
| `LLM_MAX_TOKENS`, `LLM_TEMPERATURE`, `LLM_TIMEOUT` | per-feature constants | todo |
| `NGSPICE_EXECUTABLE`, `NGSPICE_PATH`, `NGSPICE_TIMEOUT`, `NGSPICE_LOG_FILE` | `NGSPICE_PATH`, `NGSPICE_TIMEOUT_MS` (validated) | todo |
| `MAX_UPLOAD_MB` (50) | `BODY_LIMIT` (now `5mb`; simulation payloads may need more, decide per route) | todo |
| `ASSISTANT_NETLIST_CHAR_LIMIT`, `ASSISTANT_DESIGN_REASONING_CHAR_LIMIT` | assistant constants | todo |
| `CORS_ALLOWED_ORIGINS`, `CORS_ORIGINS_REPLACE` | `CORS_ORIGINS` | done (existing) |
| `VECTOR_*`, `EMBEDDING_MODEL`, `CACHE_*`, `TSX_FORMATTER_*` | dropped (RAG/composer) | dropped |
| `DATA_DIR`, `PROMPTS_DIR`, `SIMULATOR_OUTPUT_DIR` | data shipped with the app; temp dirs per job | todo |
| gunicorn/PM2 (`HOST`, `PORT`, `WORKERS`, ...) | `PORT` (existing) | done |

## 4. Runtime dependencies

| Core dependency | Use | Nest replacement | Status |
|---|---|---|---|
| boto3 / botocore | Bedrock | `@aws-sdk/client-bedrock-runtime` 3.1148.0 (exact pin) | done |
| **ngspice 46** (system binary; built from source in prod, apt version in Docker) | simulation | must stay a system binary in the BE runtime image; pin 46 | todo |
| flask, flask-cors, gunicorn | HTTP | NestJS | done |
| pyyaml | topology YAML | `yaml` package | todo |
| numpy / pandas | loss engine, CSV slicing | plain TS | todo |
| scipy `RegularGridInterpolator` | device loss LUTs (V, I, T) | hand-written trilinear interpolation + numeric parity tests | todo |
| matplotlib | PNG fallback plots | drop the fallback (Plotly dicts only) | todo |
| python-dotenv | config | `@nestjs/config` | done |
| langchain*, sentence-transformers, torch, faiss, pydantic composer schema | composer / RAG | none | dropped |
| Bun / tscircuit compiler | composer / editor recompile | none | dropped |

## 5. Known Python bugs NOT to carry over

- Studio agent: synthesized "(no result recorded)" tool results were ordered by `set` iteration (hash order).
  Nest uses the assistant's tool-use order. (fixed in step 1)
- Studio agent: SSE `error` carried raw exception text (`str(exc)`). Nest sends
  `The assistant could not respond: <user-safe message>`. (fixed in step 1)
- Studio agent / every route: no auth and no charging; anyone reaching the host spent the AWS credential.
  Nest: global JWT guard + balance check + charge. (fixed in step 1 for the agent)
- Error responses return Python tracebacks / `details: str(e)`.
- `topology_improver.optimize_topology_parameters` returns `{}` on some paths and a tuple on others; callers
  unpack two values and the failure is swallowed (inventory 3.4).
- `api_server.py` calls `re.sub` in `_run_prepare_netlist` and `_run_rerun_simulation` without a module-level
  `import re` (latent `NameError` on `plot ... xl` decks).
- Hard-coded developer ngspice path and Downloads/Desktop scanning in `config.py`.
- `/api/design/modify-netlist` calls `build_quick_params_line("buck", ...)` with a hard-coded topology.
- In-memory task dict and editor sessions force a single worker; results deleted after the first fetch.
- Shared `<tmp>/qdonis_<name>.yaml` copies collide across concurrent requests.
- `_warmup_compiler_once` writes to POSIX `/tmp`.
- `llm_logs.json` stores full prompts (user data) on local disk.

## 6. Intentionally dropped

- Composer `POST /api/compose` (LangChain + OpenRouter + FAISS RAG pipeline).
- Circuit editor `POST /api/editor/*` (11 routes, in-memory sessions, tscircuit recompile).
- RAG / FAISS index and the embedding stack (sentence-transformers, torch).
- `optimiser/` package (never wired to the API).
- Top-level `contextualiser`.
- `POST /api/optimize` stub (always 501).

FE call sites of dropped routes (`circuitVisualizationService.ts:708, 772`, `circuitEditorService.ts:413`)
must be removed or hidden before core is deleted.

## 7. Decisions and deviations (step 1, Studio agent)

- D1 Auth mode: AWS key pair (SigV4) when both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set, else
  `BEDROCK_API_KEY` bearer (`token` + `authSchemePreference: ['httpBearerAuth']`), else 503 `AI_NOT_CONFIGURED`.
  Production requires one of the two.
- D2 Region: `BEDROCK_REGION` -> `AWS_REGION` -> `us-east-1` (`BEDROCK_REGION` no longer has a default).
- D8 Step key `studio_agent` (in the `step_multipliers` defaults; stored settings without it -> multiplier 1).
- D9 Charging: once per step, after the stream completed and before `tool_call`/`done` are sent, under one
  idempotency key. Known gap: a step aborted before the provider's usage metadata arrives (client disconnect,
  provider error) is not charged, because Bedrock reports no usage for it. Same as `/ai/bedrock/converse`.
- D10 Wire parity: same event names/keys as Python; `done.usage` `{prompt_tokens, completion_tokens,
  total_tokens}` or `{}`. Extra `: heartbeat` SSE comments every 20 s (the frontend ignores non-`data:` chunks).
- D11 Stricter request validation: `content` must be an array of blocks, `project_state` an object, 1-200
  messages, <= 500 blocks per message, text <= 1,000,000 chars, ids <= 256 chars, unknown keys rejected;
  body capped by `BODY_LIMIT`. These also return 400 now, where Python skipped or `str()`-coerced them: role
  `system`, numeric `id`/`tool_use_id`, non-string `text`. Pre-stream errors are the standard Nest JSON body (`{code, message}`); the
  frontend reads `message` (and still `error` for core).
- D12 Topology ids are a static list (35) until the topology library is migrated.
- D13 `/ai/bedrock/converse` (and the agent) go through the SDK with `maxAttempts: 3`, so throttles and 5xx are
  retried. The old fetch client made one call. Failure latency changes; the contract is the same.
- Open (review, non-blocking): no per-user in-flight limit on `POST /studio/agent` (the gate is `balance > 0`);
  aborted steps are free even after usage arrived (D9); the FE 401 retry reuses the cached token.
- Frontend flag `VITE_STUDIO_AGENT_BACKEND` = `nest` (default) | `core` in `qdonis/lib/studio/agent.ts`.
- Still on core: the legacy assistant (`/api/assistant*`, `ChatPanel`) and every stage tool endpoint the agent's
  tools call (`lib/studio/stages.ts`).
- Supabase `saveTokenUsage` tracking (StudioShell) is still fed by `done.usage`; the authoritative charge is now
  server-side. Decide whether to keep that tracking when the remaining AI routes move.

## 8. qdonis-core deletion readiness checklist

- [ ] Every row in section 1 is `done` or `dropped` (now: 1 done, 13 dropped, 23 todo).
- [ ] Every `todo` asset in section 2 copied into BE with a SHA-256 manifest and a loader test.
- [ ] ngspice 46 provisioned for the BE runtime (Dockerfile / server setup) and probed by `/health/ready`.
- [ ] FE has no `VITE_QDONIS_API_URL` / `127.0.0.1:5001` / `127.0.0.1:5000` references.
- [ ] `VITE_STUDIO_AGENT_BACKEND=core` path removed from `lib/studio/agent.ts`.
- [ ] FE call sites of dropped routes removed (composer, editor, optimize).
- [ ] Parity fixtures and capture scripts for every migrated feature live in BE (`test/parity/`), and their
      specs pass without core present.
- [ ] Ledger reviewed by the user.
