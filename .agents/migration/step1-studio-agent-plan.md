# Step 1 — Studio agent: qdonis-core (Python) -> qdonis-backend (NestJS)

Implementation plan. Investigation only was done in this step; nothing is coded yet.

Absolute roots used below:
- `BE` = `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend` (branch `feature/studio-agent`, already checked out)
- `FE` = `d:\1. TailorFlowAI Work\Qdonis v2\qdonis` (branch `feature/studio-agent`, already checked out)
- `CORE` = `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-core` (READ-ONLY, `feature/chat-first` @ `239d79a`)
- `PY` = `CORE\.venv\Scripts\python.exe`

Hard rules for every item: no commits, no pushes, no worktrees, never modify `CORE`, never edit any `.env` value
(refer to secrets by key name only), follow `BE\AGENTS.md` (ConfigService only, no `any`, `import type`,
repository -> service -> controller, global deny-by-default `JwtAuthGuard`, pino redact for secrets).

## 0. Facts established during exploration (do not re-derive)

Backend (`BE`)
- `src/ai/bedrock.client.ts`: raw `fetch` to `/model/<id>/converse`, bearer `BEDROCK_API_KEY`, text-only, no system,
  no tools. `STATUS_MESSAGES` maps 400/403/404/429/500/503 to user-safe strings; `BedrockError` = user-safe error.
- `src/ai/ai.service.ts`: `prepare(userId, dto)` (assertConfigured, resolveModel, `subscriptions.ensureAccount`,
  402 `INSUFFICIENT_TOKENS` when balance <= 0), `converse()` (Bedrock call, `ceil(total * stepMultiplier(step))`,
  private `charge()` with idempotency key `ai:<user>:<uuid>`, reason `ai_usage`, partial "remainder" charge on 402),
  private `stepMultiplier()` (normalises step to snake_case, reads `step_multipliers` setting, default 1).
- `src/ai/ai.controller.ts`: `POST ai/bedrock/converse`, SSE: `text/event-stream; charset=utf-8`,
  `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `: heartbeat` comment every 20 s, then ONE
  `data:` event `{done:true, content, usage:{inputTokens,outputTokens,totalTokens}, charged, balance}` or `{error}`.
  Abort via `response.on('close')`.
- `src/ai/ai.module.ts` imports `BillingModule`, `SettingsModule`; exports nothing yet.
- `BillingModule` exports `TokensService`, `SubscriptionsService`, `CatalogService`, `BillingAdminService`.
- Settings: `src/settings/settings.schema.ts` `DEFAULT_STEPS` (10 wizard steps, multiplier 1); `SettingsService.get`
  returns stored value or defaults.
- Config: `src/config/env.validation.ts` (`BEDROCK_API_KEY?` MinLength 20, `BEDROCK_REGION='us-east-1'` default,
  `BEDROCK_ALLOWED_MODELS` default first = `us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
  `BEDROCK_MAX_OUTPUT_TOKENS=64000`, `BEDROCK_TIMEOUT_MS=600000`; `crossValidate()` requires `BEDROCK_API_KEY` in
  production). `src/config/configuration.ts` `bedrock: {apiKey, region, allowedModels, maxOutputTokens, timeoutMs}`.
- Pino redact list lives in `src/app.module.ts` (`redact.paths`).
- Global `ValidationPipe`: `whitelist`, `forbidNonWhitelisted`, `transform`, `stopAtFirstError`.
- Errors: `AppError.*` + `ErrorCode` in `src/common/errors/error-codes.ts` (`AI_NOT_CONFIGURED`, `VALIDATION_FAILED`, ...).
- Routes used for testing: `POST /api/v1/auth/login` `{email,password}` -> `{accessToken}`; `GET /api/v1/users/me`
  (my id); `GET /api/v1/billing/me` (`{balance}`); `GET /api/v1/billing/me/ledger`; admin grant
  `POST /api/v1/admin/users/:id/tokens` body `AdminGrantTokensDto {amount, note, expiresInDays?}` (ADMIN only).
- Tests: unit Jest `rootDir: src`, `*.spec.ts` (there are currently ZERO unit specs, so `npm test` exits 1 today);
  e2e `test/jest-e2e.json` + `test/setup-env.ts` (sets fake env; default DB `localhost:5433/qdonis_test`, override
  with `E2E_DATABASE_URL`). `test/ai.e2e-spec.ts` mocks `global.fetch` for `bedrock-runtime` — this breaks once the
  SDK is used (SDK uses node:https, not fetch) and must be rewritten (item 4).
- Baseline: `npm run typecheck` and `npm run lint:check` pass. Local Postgres 5432 has `qdonis_dev` but no test DB.
- `.env` sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`; `BEDROCK_API_KEY` empty/absent. `PORT=3000`.

Python (`CORE`)
- `qdonis_backend/studio_agent.py` (843 lines): `MAX_TOKENS=4096`, `TEMPERATURE=0.3`, `STAGES`, `BLOCKING_TOOLS`,
  `_humanize_topology`, `build_tools(topology_ids)` = **17 tools** in this order: `update_specs`,
  `generate_constraints`, `update_constraints`, `ask_user`, `suggest_topologies`, `select_topology`, `run_design`,
  `modify_design`, `set_design_values`, `run_simulation`, `import_netlist`, `edit_circuit`, `select_devices`,
  `design_magnetics`, `run_thermal`, `open_view`, `manage_branch`. `SYSTEM_PROMPT` literal; `build_system_prompt`
  appends `## Topology library ...` + ``## Current project snapshot (active branch)\n```json\n<_compact(state, 9000)>\n```\n``.
  `_compact` = `json.dumps(ensure_ascii=False, default=str)` (Python separators `", "` / `": "`), truncated by code
  points to 9000 + `"…(truncated)"`. `to_converse_messages()` history repair. `stream_agent_step()` builds
  `{modelId, system:[{text}], messages, inferenceConfig:{maxTokens:4096, temperature:0.3}, toolConfig}` and maps
  the ConverseStream to events `text`, `tool_call {id,name,input}` (after the stream, sorted by contentBlockIndex,
  malformed JSON -> `{}`), `done {usage:{prompt_tokens,completion_tokens,total_tokens} | {}, stop_reason, model}`,
  `error {error: "The assistant could not respond: <exc>"}`.
- `qdonis_backend/bedrock_client.py`: `convert_tools()` (OpenAI function tools -> `{tools:[{toolSpec:{name,
  description (or name), inputSchema:{json}}}]}`), `_normalize_usage`, timeouts connect 10 s / read 300 s /
  stream read 60 s, botocore `retries.max_attempts=2` (= 2 retries, 3 attempts), region `AWS_REGION` ->
  `AWS_DEFAULT_REGION` -> `us-east-1`, model `BEDROCK_MODEL_ID` or the same default as Nest.
- `api_server.py:2855` `POST /api/studio/agent`: 400 when `messages` is not a non-empty list; non-dict
  `project_state` -> `{}`; `topology_ids = list_builtin_topologies()` (directory listing of
  `qdonis_backend/data/topologies/json_library`, sorted) = **35 ids** at HEAD (verified with `PY`). SSE headers
  `text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, `Connection: close`. No auth, no charging.
- `api_server.py` has 37 `@app.route` decorators at HEAD (ledger source of truth).
- Python bug found: `missing = [tid for tid in expected if ...]` iterates a `set`, so the order of synthesized
  "(no result recorded)" results is hash-random. Nest will use the assistant turn's tool-use order (deterministic).

Frontend (`FE`)
- `lib/studio/agent.ts` `streamStep()` (line ~74): `fetch(`${API_BASE_URL}/api/studio/agent`)` with
  `API_BASE_URL = VITE_QDONIS_API_URL || http://127.0.0.1:5001`, no auth; reads `body.error` on non-OK; parses
  `data:` events by `\n\n`, ignores non-`data:` chunks (so `: heartbeat` comments are safe); `done.usage` is passed
  to `usageReporter` (StudioShell -> `saveTokenUsage` Supabase tracking, not charging).
- Wire blocks (`lib/studio/types.ts` `ChatBlock`): `{type:'text',text}`, `{type:'tool_use',id,name,input}`,
  `{type:'tool_result',tool_use_id,content,is_error?}`. Content is always an array.
- Nest helpers: `services/api/apiClient.ts` exports `API_BASE_URL` (`VITE_BACKEND_URL` or
  `http://localhost:3000/api/v1`), `getAccessToken()`, `ApiError`; `services/bedrockService.ts` shows the pattern
  (bearer, `credentials:'include'`, refresh-once on 401, `INSUFFICIENT_TOKENS` -> `ApiError(402, ...)`,
  `invalidateBilling()` from `services/api/billingApi`, `tokenUpdateEvents.emit()`).
- `npx tsc --noEmit -p tsconfig.json` baseline: **398 errors** (pre-existing, none in `lib/studio/agent.ts`).
  Scripts: `npm run build` (vite build), `npm test` (jest). No Playwright installed.

## 1. Design decisions (fixed for the implementer)

- D1 Auth mode: if `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` are set -> SigV4 with those credentials passed
  explicitly to the SDK (`credentials: {accessKeyId, secretAccessKey}`); else if `BEDROCK_API_KEY` is set -> bearer
  mode via SDK `token: { token: apiKey }` + `authSchemePreference: ['httpBearerAuth']`; else not configured (503
  `AI_NOT_CONFIGURED`). Rationale: SigV4 is what is configured today; bearer keeps the existing deployment option.
  Exposed as `bedrock.authMode: 'sigv4' | 'bearer' | 'none'`.
- D2 Region precedence: `BEDROCK_REGION` (explicit, Bedrock-specific) -> `AWS_REGION` -> `us-east-1`.
  `BEDROCK_REGION` loses its class default (becomes optional) so "unset" is detectable. Matches Python, which reads
  `AWS_REGION`, while still letting Bedrock live in a different region than other AWS services.
- D3 Empty strings: new optional AWS vars and `BEDROCK_API_KEY` get an `emptyToUndefined` transform so `KEY=` in
  `.env` means unset (avoids `MinLength` failures on blank lines).
- D4 SDK: `@aws-sdk/client-bedrock-runtime`, exact version = the current `latest` at install time
  (`npm install --save-exact`). It must expose `token` and `authSchemePreference` in `BedrockRuntimeClientConfig`
  (typecheck proves it). Client settings: `maxAttempts: 3` (= botocore 2 retries), `requestHandler:
  { connectionTimeout: 10_000, requestTimeout: <BEDROCK_TIMEOUT_MS> }` (plain object form, no direct
  `@smithy/*` import). Overall per-call deadline `BEDROCK_TIMEOUT_MS` via `AbortSignal.timeout`; stream idle
  watchdog 60 s (Python stream read timeout) as a code constant `STREAM_IDLE_TIMEOUT_MS`.
- D5 Testability: the SDK client is created by a Nest factory provider under token `BEDROCK_RUNTIME`
  (type: `Pick<BedrockRuntimeClient, 'send'>`), so unit and e2e tests use `.overrideProvider(BEDROCK_RUNTIME)`.
- D6 `/ai/bedrock/converse` stays non-streaming (SDK `ConverseCommand`), same body, same SSE contract, same error
  strings (map SDK `$metadata.httpStatusCode` / exception name through the existing `STATUS_MESSAGES`).
- D7 Charging reuse: `AiService` gains public `prepare(userId, requestedModel?)` and
  `chargeUsage(userId, {modelId, step, inputTokens, outputTokens})`; `converse()` uses them; `AiModule` exports
  `AiService` + `BedrockClient`. Studio never touches `TokensService` directly.
- D8 Step key: `studio_agent` (snake_case, passes `IsMultiplierMap`), added to `DEFAULT_STEPS` so admins see it;
  stored settings without it fall back to multiplier 1.
- D9 Exactly-once charge: one idempotency key per request (`ai:<user>:<uuid>` inside `chargeUsage`), charged once
  when the stream's `metadata.usage` arrives and the stream completed, before `done` is written. Abort or provider
  error before usage -> no charge (same as existing converse on failure; documented in ledger as known gap).
- D10 SSE wire parity: event payloads byte-for-byte Python shapes (`{type:'text',text}`,
  `{type:'tool_call',id,name,input}`, `{type:'done',usage,stop_reason,model}`, `{type:'error',error}`); `done.usage`
  is `{prompt_tokens,completion_tokens,total_tokens}` or `{}` when no metadata. Error text keeps the prefix
  `The assistant could not respond: ` but appends the user-safe `BedrockError` message, never the raw exception
  (security deviation, documented). Headers: Python's set (`Cache-Control: no-cache`, `X-Accel-Buffering: no`,
  `Connection: close`) with `Content-Type: text/event-stream; charset=utf-8`; plus `: heartbeat` comments every 20 s
  like the Nest converse endpoint (frontend ignores them).
- D11 Request validation is stricter only on the wire: `content` must be an array of blocks (frontend always sends
  arrays), `project_state` must be an object if present, `messages` 1..200. Unknown block `type` strings are
  accepted by the DTO and dropped by the normaliser (Python parity). Pre-stream errors use the standard Nest JSON
  error body (`{code,message,...}`); the frontend is updated to read `message`.
- D12 Topology ids: static `STUDIO_TOPOLOGY_IDS` (the 35 ids captured from Python) in
  `src/studio/agent/topology-library.ts`; a parity test asserts equality with the captured list. Replaced by the
  migrated topology library in a later step (ledger row).
- D13 Python-exact serialisation: `src/studio/agent/python-json.ts` implements `pythonJsonDumps` (separators
  `", "`/`": "`, `ensure_ascii=False`, Python float repr: scientific when exponent < -4 or >= 16, 2-digit exponent,
  e.g. `1e-05`, `1e+16`; integers with |n| < 1e21 printed as integers), `pythonStr` for tool-result scalars
  (`True`/`False`, float repr, `None` -> empty), `pythonStrip` (Python `str.strip()` whitespace set, which includes
  `\x1c-\x1f` and excludes `\uFEFF`), and code-point `truncate`. Rationale: the system prompt must deep-equal Python.
- D14 System prompt is a TS template literal (backticks escaped) in `src/studio/agent/studio-system-prompt.ts`;
  exactness is enforced by the parity fixtures, not by eye.
- D15 No restructuring of the workflow: the work is one tightly coupled vertical slice; the existing build loop
  implements this file. No Prisma schema change is needed.

## 2. Implementation items (ordered by dependency)

- [ ] 1. Config/env wiring for AWS credentials, auth mode and region precedence (D1-D3).
      Add to `EnvironmentVariables`: `AWS_ACCESS_KEY_ID?` (`@Matches(/^[A-Z0-9]{16,128}$/)`),
      `AWS_SECRET_ACCESS_KEY?` (`@IsString @MinLength(16)`), `AWS_REGION?` (same regex as `BEDROCK_REGION`), all with
      an `emptyToUndefined()` transform (also applied to `BEDROCK_API_KEY`); make `BEDROCK_REGION` optional without
      default. `crossValidate`: key id and secret both or neither; production requires `BEDROCK_API_KEY` OR the AWS
      key pair (replaces the current BEDROCK_API_KEY-only rule). `configuration.ts` `bedrock` gains
      `authMode`, `accessKeyId?`, `secretAccessKey?`, `region = BEDROCK_REGION ?? AWS_REGION ?? 'us-east-1'`.
      `.env.example`: add the three AWS keys (empty) with a comment on auth-mode and region precedence; mark
      `BEDROCK_REGION` optional. `src/app.module.ts` redact paths: add `'*.secretAccessKey'`, `'*.accessKeyId'`,
      `'*.apiKey'`, `'*.credentials'`, `'*.token'` (guards accidental logging of SDK/config objects).
      `test/setup-env.ts`: set fake `AWS_ACCESS_KEY_ID: 'AKIAE2EFAKEKEY000000'`, `AWS_SECRET_ACCESS_KEY:
      'e2e-fake-secret-0000000000000000'`, `AWS_REGION: 'us-east-1'` so the real `.env` keys never load in tests.
      Add `src/config/configuration.spec.ts`: authMode selection (sigv4 / bearer / none), region precedence (3
      cases), half key pair rejected, blank values treated as unset.
      Files: `BE\src\config\env.validation.ts`, `BE\src\config\configuration.ts`, `BE\.env.example`,
      `BE\src\app.module.ts`, `BE\test\setup-env.ts`, `BE\src\config\configuration.spec.ts` (new)
      Verify: `npm run typecheck`; `npm test -- src/config` passes; `npm run start:dev` boots with the current
      `.env` (no validation error), then stop it.

- [ ] 2. Install the SDK and build the generic shared Bedrock layer `src/ai/bedrock/` (D4-D6).
      `npm view @aws-sdk/client-bedrock-runtime version`, then `npm install --save-exact @aws-sdk/client-bedrock-runtime@<that>`.
      Create:
      - `bedrock.types.ts`: `BedrockRequest { modelId; system?: string[]; messages: Message[]; toolConfig?: ToolConfiguration; maxTokens; temperature; signal: AbortSignal }` (SDK `Message`/`ToolConfiguration` via `import type`), `BedrockUsage {inputTokens, outputTokens, totalTokens}`, `BedrockConverseResult {text, content: ContentBlock[], usage, stopReason}`, stream event union `BedrockStreamEvent = {type:'text',index,text} | {type:'tool_use_start',index,id,name} | {type:'tool_use_delta',index,input} | {type:'stop',stopReason} | {type:'usage',usage}`, and the OpenAI-style `FunctionToolDefinition` type.
      - `bedrock-runtime.provider.ts`: `BEDROCK_RUNTIME` injection token + factory reading `ConfigService<AppConfiguration,true>` and building `new BedrockRuntimeClient({...})` per D1/D4 (returns a client in mode `none` too; `assertConfigured` blocks calls).
      - `bedrock-errors.ts`: move `BedrockError`; `toBedrockError(error, {timedOut, aborted})` mapping SDK errors (`$metadata.httpStatusCode`, `ThrottlingException`, `ValidationException`, `AccessDeniedException`, `ResourceNotFoundException`, `ServiceUnavailableException`, network) to the existing `STATUS_MESSAGES`, timeout ("The AI request timed out; retry with a smaller input"), cancel ("Request cancelled"), network ("Could not reach the AI provider; retry the request"); logs only name/status/message, never the error object.
      - `bedrock-tools.ts`: `convertTools(defs)` = exact port of Python `convert_tools` (skip non-function / nameless, description fallback to name, default schema `{type:'object',properties:{}}`, `undefined` when empty).
      - `bedrock.client.ts` (moved from `src/ai/bedrock.client.ts`, which is deleted): `assertConfigured()` (uses `authMode`), `resolveModel()`, `converse(req)` (ConverseCommand, `maxTokens = min(req.maxTokens, maxOutputTokens)`, `system` -> `[{text}]` only when non-empty, `toolConfig` only when set, `send(cmd, {abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)])})`, empty text with no toolUse -> `BedrockError('The AI provider returned an empty response')`), `async *converseStream(req)` (ConverseStreamCommand, maps `contentBlockStart/Delta`, `messageStop`, `metadata.usage` to `BedrockStreamEvent`, idle watchdog that aborts after 60 s without an event, all errors through `toBedrockError`).
      Update imports in `ai.service.ts`, `ai.controller.ts`, `ai.module.ts` (providers: `BedrockClient`, `bedrockRuntimeProvider`; exports: `AiService`, `BedrockClient`).
      Unit spec `src/ai/bedrock/bedrock.client.spec.ts` with a fake `send`: request shape (system/tool omission, maxTokens cap), stream mapping incl. interleaved text/tool blocks, abort propagates and yields "Request cancelled", idle timeout, 429 -> "busy" message, empty response error. Spec `bedrock-tools.spec.ts`.
      Files: `BE\package.json`, `BE\package-lock.json`, `BE\src\ai\bedrock\{bedrock.types.ts,bedrock-runtime.provider.ts,bedrock-errors.ts,bedrock-tools.ts,bedrock.client.ts,bedrock.client.spec.ts,bedrock-tools.spec.ts}`, delete `BE\src\ai\bedrock.client.ts`, edit `BE\src\ai\ai.service.ts`, `BE\src\ai\ai.controller.ts`, `BE\src\ai\ai.module.ts`
      Verify: `npm run typecheck`, `npm run lint:check`, `npm test -- src/ai` pass.

- [ ] 3. Refactor `AiService` for reuse and add the `studio_agent` step key (D7, D8). Depends on 2.
      `prepare(userId, requestedModel?: string): Promise<string>` (same checks, same 402 payload);
      `chargeUsage(userId, {modelId, step?: string, inputTokens, outputTokens}): Promise<{charged, balance, multiplier}>`
      wrapping the existing private `charge()` + `stepMultiplier()`; `converse()` now calls
      `bedrock.converse({modelId, messages: dto.messages.map(m => ({role, content:[{text}]})), ...})` then
      `chargeUsage`. `ai.controller.ts` passes `dto.modelId` to `prepare`. Add `'studio_agent'` to `DEFAULT_STEPS`
      in `settings.schema.ts`. Add `src/ai/ai.service.spec.ts` (mocked Tokens/Subscriptions/Settings): 402 on zero
      balance, multiplier applied (`studio_agent: 2` -> double), remainder charge on 402, one `consume` call per
      `chargeUsage`.
      Files: `BE\src\ai\ai.service.ts`, `BE\src\ai\ai.controller.ts`, `BE\src\settings\settings.schema.ts`, `BE\src\ai\ai.service.spec.ts` (new)
      Verify: `npm run typecheck`, `npm run lint:check`, `npm test -- src/ai` pass.

- [ ] 4. Keep `/ai/bedrock/converse` green on the SDK: rewrite `test/ai.e2e-spec.ts` mocking. Depends on 2-3.
      Replace the `global.fetch` spy with `.overrideProvider(BEDROCK_RUNTIME).useValue({ send: jest.fn(...) })`
      returning `{output:{message:{content:[{text}]}}, usage:{inputTokens,outputTokens}}` or throwing an SDK-like
      error `{name:'ThrottlingException', $metadata:{httpStatusCode:429}}`; capture the `ConverseCommand.input` to
      assert `inferenceConfig.maxTokens === 64000`. Keep every existing assertion (401, 400 on maxTokens 999999,
      `charged: 1000, balance: 9000`, model allowlist 400, 429 -> /busy/ no charge, partial charge to 0 then 402,
      exactly one negative ledger entry).
      Test DB (one-time, local, reversible): create database `qdonis_e2e` on the local 5432 server using the
      credentials of `DATABASE_URL` (node `pg` one-liner `CREATE DATABASE qdonis_e2e`), then
      `$env:DATABASE_URL=<same URL with /qdonis_e2e>; npx prisma migrate deploy`. Always run e2e with
      `$env:E2E_DATABASE_URL=<that URL>`. Never point e2e at `qdonis_dev`.
      Files: `BE\test\ai.e2e-spec.ts`
      Verify: `npm run test:e2e -- ai` passes (all 5 existing cases).

- [ ] 5. Parity capture harness (Python, run against CORE read-only) and fixtures. Independent of 1-4.
      Create `BE\test\parity\capture\capture_studio_agent.py` and `BE\test\parity\capture\README.md` (how to run).
      The script: takes `--core <path>` (default `..\..\..\..\qdonis-core` resolved from the script), inserts it in
      `sys.path`, unsets `BEDROCK_MODEL_ID`, sets nothing else; imports `qdonis_backend.studio_agent` and
      `qdonis_backend.data_utils.list_builtin_topologies`; monkeypatches `studio_agent.get_bedrock_client` with a
      fake whose `converse_stream(**kwargs)` records `kwargs` and returns `{"stream": <scripted events>}` (or raises
      when the input asks for an error) — so NO Bedrock call is made and both the exact request and the emitted
      events are captured from the real `stream_agent_step`. For each input file in
      `BE\test\parity\fixtures\studio-agent\inputs\*.json` (`{name, description, messages, project_state,
      bedrock_stream?, bedrock_error?}`) it writes `BE\test\parity\fixtures\studio-agent\<name>.json` =
      `{name, description, captured_from:{repo:'qdonis-core', commit:<git rev-parse HEAD>, branch}, topology_ids,
      input:{messages, project_state}, bedrock_stream, expected_request, expected_events}` with
      `json.dumps(..., ensure_ascii=False, indent=2)` and `PYTHONHASHSEED=0` re-exec for determinism. Also writes
      `topology-ids.json`.
      Author the input files (12):
      `01-first-turn` (one user text, empty state); `02-consecutive-same-role` (user,user,assistant,assistant,user);
      `03-orphan-tool-result` (tool_result with no matching tool_use, plus one mismatched id);
      `04-tool-use-without-result` (assistant tool_use followed by plain user text; and history ending with an
      assistant tool_use); `05-leading-assistant` (starts with assistant, then a user turn made only of tool results,
      then assistant, then real user); `06-empty-and-invalid-blocks` (empty/whitespace text incl. `\u001f` and
      `\ufeff`, message with no blocks, unknown block type, tool_use in a user turn, tool_result in an assistant
      turn, missing id/name/tool_use_id, non-object tool input, role `system`); `07-long-project-state`
      (> 9,000 chars, non-ASCII `µ`/`—` and an astral emoji straddling the 9,000 code-point boundary, floats
      `1e-05`, `0.000001`, `1.5`, `1e+21`, `12345678901234567`, nested arrays/objects, booleans, null);
      `08-multiple-tool-calls` (assistant with 3 tool_uses, results returned out of order, one `is_error`, text after
      results, result `content` as object / array / string / empty string / number / boolean / null);
      `09-trailing-assistant-and-empty` (ends with assistant text -> "Continue." appended; a second history that
      repairs to nothing -> "Hello"); `10-realistic-design-loop` (realistic snapshot shaped like FE
      `buildAgentSnapshot`: specs rows, topology, design summary, other_branches; update_specs -> approve ->
      suggest_topologies -> select_topology); `11-stream-text-and-tools` (scripted stream: text deltas, two toolUse
      blocks at indexes 2 and 1, one with malformed JSON input, one with empty input, `messageStop` `tool_use`,
      `metadata.usage`); `12-stream-error-and-no-metadata` (scripted stream with text then no metadata ->
      `done.usage == {}`; second variant raises mid-stream -> `error` event).
      Files: `BE\test\parity\capture\capture_studio_agent.py`, `BE\test\parity\capture\README.md`,
      `BE\test\parity\fixtures\studio-agent\inputs\01..12-*.json`, generated `BE\test\parity\fixtures\studio-agent\*.json`, `topology-ids.json`
      Verify: `& "<PY>" "BE\test\parity\capture\capture_studio_agent.py"` exits 0, writes 12 fixtures + ids (35
      entries); re-running produces byte-identical files (`git diff --stat` on the fixtures dir shows no change after
      a second run); `git -C CORE status --short` is unchanged (core untouched).

- [ ] 6. Studio agent core logic (pure functions) under `src/studio/agent/`. Depends on 2 (types) and 5 (fixtures).
      - `python-json.ts`: `pythonJsonDumps`, `pythonFloatRepr`, `pythonStr`, `pythonStrip`, `truncateCodePoints` (D13).
      - `topology-library.ts`: `STUDIO_TOPOLOGY_IDS` (35 ids from `topology-ids.json`, same order).
      - `studio-tools.ts`: `buildStudioTools(topologyIds): FunctionToolDefinition[]` — exact port of `build_tools`
        (17 tools, same names, descriptions, schemas, required lists, property order; `topology_enum` falls back to
        `{type:'string'}` when the list is empty), `STAGES`.
      - `studio-system-prompt.ts`: `STUDIO_SYSTEM_PROMPT` (verbatim), `humanizeTopology` (Python `.title()`
        semantics: capitalise first letter of each ASCII letter run, lowercase the rest), `buildStudioSystemPrompt(state, ids)`.
      - `message-normalizer.ts`: `toConverseMessages(history: unknown[]): Message[]` — line-by-line port of
        `to_converse_messages` (accepts string content too, `pythonStrip` for text, `pythonStr`/`(empty)` for scalar
        tool results, dict -> `{json}`, list -> `{json:{items}}`, synthesized missing results in assistant tool-use
        order, all three repair passes, leading-trim loops, `Hello` / `Continue.`).
      - `studio-request.builder.ts`: `buildStudioRequest({messages, projectState, topologyIds, modelId})` returning
        `{modelId, system:[text], messages, maxTokens: 4096, temperature: 0.3, toolConfig: convertTools(buildStudioTools(ids))}`
        and `toConverseInput()` producing the exact SDK input shape for parity comparison.
      Specs: `python-json.spec.ts` (float repr table, separators, escapes, code-point truncation),
      `message-normalizer.spec.ts` (targeted repair cases), and `studio-request.parity.spec.ts` that, for every
      fixture in `../../../test/parity/fixtures/studio-agent/*.json`, builds the request with
      `modelId = expected_request.modelId` and asserts `JSON.parse(JSON.stringify(actual))` `toEqual`
      `expected_request` (canonicalising only runs of synthesized `(no result recorded)` results by `toolUseId`, per
      the Python set-order bug), plus `STUDIO_TOPOLOGY_IDS` equals `topology-ids.json`, plus system text equality is
      asserted separately so a diff points at the prompt.
      Files: `BE\src\studio\agent\{python-json.ts,topology-library.ts,studio-tools.ts,studio-system-prompt.ts,message-normalizer.ts,studio-request.builder.ts}` and specs `{python-json,message-normalizer,studio-request.parity}.spec.ts`
      Verify: `npm test -- src/studio/agent` — all 12 fixtures deep-equal; typecheck + lint pass.

- [ ] 7. `src/studio` module mirroring `src/auth` + streaming service + SSE controller (D9-D11). Depends on 3 and 6.
      - `studio.types.ts`: constants `STUDIO_AGENT_STEP = 'studio_agent'`, `STUDIO_MAX_TOKENS = 4096`,
        `STUDIO_TEMPERATURE = 0.3`, `PROJECT_STATE_LIMIT = 9000`, `BLOCKING_TOOLS`; wire types `StudioWireBlock`,
        `StudioAgentEvent` union (text / tool_call / done / error with the exact Python keys).
      - `dto/studio-agent.dto.ts`: `StudioContentBlockDto` (`type` `@IsString @MaxLength(64)`, `text?`
        `@IsString @MaxLength(1_000_000)`, `id?`/`name?`/`tool_use_id?` `@IsString @MaxLength(256)`, `input?` and
        `content?` `@Allow()`, `is_error?` `@IsBoolean`), `StudioMessageDto` (`role` `@IsIn(['user','assistant'])`,
        `content` `@IsArray @ArrayMaxSize(500) @ValidateNested({each:true}) @Type(() => StudioContentBlockDto)`),
        `StudioAgentRequestDto` (`messages` `@IsArray @ArrayMinSize(1) @ArrayMaxSize(200)` nested,
        `project_state?` `@IsOptional @IsObject`); Swagger `@ApiProperty` on all.
      - `agent/studio-agent.service.ts`: `prepare(userId)` -> `ai.prepare(userId)` (model = allowlist default);
        `async *runStep(userId, modelId, dto, signal): AsyncGenerator<StudioAgentEvent>` — builds the request,
        iterates `bedrock.converseStream`, yields `text` events live, accumulates tool uses by index, after the
        stream yields `tool_call` events sorted by index (skip nameless; JSON.parse failure -> `{}` + warn log),
        then if usage arrived calls `ai.chargeUsage(userId, {modelId, step: STUDIO_AGENT_STEP, ...})` exactly once,
        then yields `done {type, usage, stop_reason, model}`; on `BedrockError` yields
        `error: 'The assistant could not respond: ' + message`; unexpected errors logged with request context and
        mapped to a generic message; aborted signal -> stop silently, no charge.
      - `studio.controller.ts`: `@ApiTags('studio') @ApiBearerAuth() @Controller('studio')`, `@Post('agent')`,
        `@ApiOperation`, `@ApiProduces('text/event-stream')`, `@ApiPaymentRequiredResponse`; `await service.prepare`
        BEFORE headers (so 401/400/402/503 stay JSON); then headers per D10, heartbeat 20 s, `response.on('close')`
        abort, `for await` writes `data: <JSON.stringify(event)>\n\n`, `finally` clears heartbeat and ends.
        No logic beyond SSE plumbing (follow `ai.controller.ts`).
      - `studio.module.ts`: imports `AiModule`; controller `StudioController`; provider `StudioAgentService`.
        Register `StudioModule` in `src/app.module.ts` after `AiModule`.
      Specs: `dto/studio-agent.dto.spec.ts` (`plainToInstance` + `validate` with the app pipe's options: valid
      fixture inputs pass; empty messages, bad role, string content, unknown extra key, non-object project_state,
      oversize text rejected), `agent/studio-agent.service.spec.ts` (fake `BedrockClient.converseStream` and
      `AiService`; replays each fixture's `bedrock_stream` and asserts the emitted events deep-equal
      `expected_events`, comparing `error` events by `type` + prefix only; `chargeUsage` called once with step
      `studio_agent` and input+output tokens; not called on abort / error / missing usage).
      Files: `BE\src\studio\{studio.module.ts,studio.controller.ts,studio.types.ts}`, `BE\src\studio\dto\studio-agent.dto.ts`, `BE\src\studio\agent\studio-agent.service.ts`, specs listed above, `BE\src\app.module.ts`
      Verify: `npm run typecheck`, `npm run lint:check`, `npm test` (all unit specs) pass.

- [ ] 8. Studio endpoint e2e tests with Bedrock mocked. Depends on 4 and 7.
      `test/studio.e2e-spec.ts` (same bootstrap/user helpers as `ai.e2e-spec.ts`, users `@studio.e2e.test`,
      `BEDROCK_RUNTIME` overridden with a fake `send` that returns `{stream: asyncIterable(fixture.bedrock_stream)}`):
      401 without token; 400 for `{messages: []}` and for string content; 402 `INSUFFICIENT_TOKENS` at zero
      balance (drain via a first expensive call, as in ai e2e); happy path from fixture 11 -> headers
      (`text/event-stream`, `no-cache`, `X-Accel-Buffering: no`), events equal `expected_events`, balance drops by
      exactly input+output tokens and exactly one negative ledger entry with reason `ai_usage` and metadata
      `step: 'studio_agent'`; admin multiplier: `PUT /admin/settings/step_multipliers` `{multipliers:{studio_agent:2}}`
      doubles the charge (restore afterwards); abort: fake stream that waits, client aborts (supertest `.abort()`
      or `http.request` + `destroy`), assert the fake `send` saw an aborted signal and no ledger entry was added;
      provider error -> single `error` event with the prefix and no charge.
      Files: `BE\test\studio.e2e-spec.ts`
      Verify: `$env:E2E_DATABASE_URL=...; npm run test:e2e` — ai, auth, billing, studio suites all pass.

- [ ] 9. Frontend switch to the Nest endpoint behind `VITE_STUDIO_AGENT_BACKEND` (default `nest`). Independent of
      backend code but tested against it.
      In `FE\lib\studio\agent.ts`: rename the local base to `CORE_API_URL`; add
      `const STUDIO_AGENT_BACKEND = import.meta.env.VITE_STUDIO_AGENT_BACKEND === 'core' ? 'core' : 'nest';`.
      `streamStep` -> `openAgentStream(body, signal)`: `core` = old call unchanged; `nest` = `fetch(`${API_BASE_URL}/studio/agent`)`
      (`API_BASE_URL`, `getAccessToken`, `ApiError` from `../../services/api/apiClient`) with
      `Authorization: Bearer <token>`, `credentials: 'include'`, `Accept: text/event-stream`; missing token ->
      "Authentication required. Please sign in to use AI features."; 401 -> refresh once and retry (same as
      `bedrockService.ts`); non-OK -> read `{message, code, meta}` (fall back to `error` for core), throw
      `ApiError(402, 'INSUFFICIENT_TOKENS', 'You are out of tokens. Upgrade your plan or buy more tokens.', undefined, meta)`
      for that code. On `done` in nest mode also call `invalidateBilling()` (from `../../services/api/billingApi`)
      and `tokenUpdateEvents.emit()` (dynamic import as in bedrockService). SSE parsing, tool loop, usage reporter
      and every stage call in `lib/studio/stages.ts` stay unchanged. Document the flag in a header comment
      (`nest` = qdonis-backend, JWT, charged; `core` = Python fallback during migration, unauthenticated).
      Files: `FE\lib\studio\agent.ts`
      Verify: `npx tsc --noEmit -p tsconfig.json` in `FE` reports 0 errors in `lib/studio/agent.ts` and a total
      <= 398 (baseline); `npm run build` in `FE` succeeds.

- [ ] 10. Migration ledger. Can be written any time; the Studio row is flipped to done only in item 11.
      Create `BE\.agents\migration\core-migration-ledger.md` (self-contained; `CORE` will be deleted). Source:
      `CORE\.agents\tasks\core-inventory-2026-10-08.md` sections 2-13, cross-checked against the 37 `@app.route`
      lines of `CORE\qdonis_backend\api_server.py` at `239d79a` (list every route; mark routes with no FE caller as
      such). Sections:
      1. Routes table — `route | method | FE call sites (file:line) | planned Nest endpoint / module | status
         (todo / in-progress / done / dropped) | parity evidence`. Studio agent row: `POST /api/studio/agent` ->
         `POST /api/v1/studio/agent` (`src/studio`), evidence = fixture dir + spec names + live check date.
      2. Data assets — 35 topology YAMLs, 35 schematic JSONs (`json_library`), 31 topology prompts, 858 device JSONs,
         `spice_components.json`, assistant / electrical-guideline prompts, core/material tables and anything else
         in inventory §7; columns `asset | CORE path | count | consumer route(s) | target location in BE | status`.
      3. Env vars (CORE name -> Nest name / dropped), incl. `AWS_REGION`, `BEDROCK_MODEL_ID` (-> `BEDROCK_ALLOWED_MODELS[0]`),
         Bedrock timeouts (-> constants / `BEDROCK_TIMEOUT_MS`), OpenRouter keys (dropped/pending).
      4. Runtime deps — ngspice 46 (system dependency for simulation), Python libs and their Node replacements.
      5. Known Python bugs NOT to carry over — include the hash-ordered missing tool results, raw exception text in
         SSE `error`, no auth / no charging on `/api/studio/agent`, plus inventory §3.4 / §4.4 items.
      6. Intentionally dropped — composer `/api/compose`, `/api/editor/*`, RAG/FAISS, optimiser, top-level
         contextualiser, `/api/optimize` stub.
      7. Decisions & deviations from this step — D1, D2, D8, D9 (no charge on abort before usage), D10, D11, D12,
         `VITE_STUDIO_AGENT_BACKEND` flag, legacy assistant (`/api/assistant/stream`) still on CORE, Supabase
         `saveTokenUsage` tracking still fed by `done.usage`.
      8. qdonis-core deletion readiness checklist — every route row done or dropped; every asset copied with
         checksum; FE has no `VITE_QDONIS_API_URL` / `127.0.0.1:5001` references; `VITE_STUDIO_AGENT_BACKEND=core`
         path removed; parity fixtures and capture script live in BE; ngspice provisioned for BE; ledger reviewed.
      Files: `BE\.agents\migration\core-migration-ledger.md`
      Verify: route table row count equals the 37 routes (`Select-String -Path "CORE\qdonis_backend\api_server.py" -Pattern '@app\.route\('` count) minus none; every FE call site from inventory §10 appears.

- [ ] 11. Full verification matrix and parity gate; then mark the Studio row done. Depends on all.
      Backend (`BE`): `npx prisma validate`; `npx prisma generate`; `npm run typecheck`; `npm run lint:check`;
      `npm run build`; `npm test`; `$env:E2E_DATABASE_URL=...; npm run test:e2e`. All must pass.
      Parity gate: `& "<PY>" BE\test\parity\capture\capture_studio_agent.py` (fixtures unchanged) then
      `npm test -- studio-request.parity studio-agent.service` pass.
      Live Bedrock (real credentials from `.env`, small cost): `npm run start:dev`; log in as `admin@example.com`
      and `user@example.com` (passwords in the step prompt) via `POST /api/v1/auth/login`; get the user id from
      `GET /api/v1/users/me`; if `GET /api/v1/billing/me` balance < 20000, grant via
      `POST /api/v1/admin/users/<id>/tokens` `{amount: 50000, note: 'step1 studio agent live check'}` with the admin
      token. Then (PowerShell `Invoke-WebRequest`/`curl.exe -N`) POST `fixtures/studio-agent/inputs/01-first-turn.json`
      body to `/api/v1/studio/agent` with the user token: expect streamed `text` events and a final `done` with
      non-empty usage; balance decreases by exactly `prompt_tokens + completion_tokens` (multiplier 1) and
      `GET /api/v1/billing/me/ledger` shows exactly one new `ai_usage` entry with `step: studio_agent`. Repeat with a
      prompt that forces a tool call ("Design a 12 V to 5 V 3 A buck converter") and confirm a `tool_call` event
      with a valid tool name. Also POST `/api/v1/ai/bedrock/converse` `{messages:[{role:'user',content:'Say OK'}]}`
      and confirm the single `{done:true, content, usage, charged, balance}` event (old contract on the SDK).
      Without a token -> 401. Stop the dev server afterwards.
      Frontend (`FE`): tsc check as in item 9; `npm run build`. Browser (manual, no automation installed): run
      backend (`npm run start:dev`, port 3000), Python core (for stage endpoints, port 5001) and `npm run dev` in
      `FE`; sign in; open a Studio project; send "Design a 12 V to 5 V, 3 A buck converter"; confirm in DevTools
      Network that the agent request goes to `http://localhost:3000/api/v1/studio/agent` with a Bearer header, text
      streams, `ask_user`/`update_specs` render, a stage tool (e.g. `select_topology`) still calls
      `127.0.0.1:5001/api/visualize...`, the loop continues after tool results, Stop aborts the stream, and the
      token balance in the header drops. Set `VITE_STUDIO_AGENT_BACKEND=core` in the shell for one `npm run dev`
      run (do not edit `.env`) and confirm the request goes to `:5001/api/studio/agent`. Watch request size: if a
      long session hits 413, report the `BODY_LIMIT` value needed (do not edit `.env`).
      Record results (commands, pass/fail, dates, balances before/after) in the ledger "parity evidence" column and
      only then set the Studio agent row to `done`.
      Files: `BE\.agents\migration\core-migration-ledger.md`
      Verify: every command above green; ledger Studio row = done with evidence.

## 3. Gaps and assumptions
- If the pinned SDK lacks `token`/`authSchemePreference` typings, use the newest version that has them (typecheck
  is the arbiter); do not fall back to raw fetch.
- Abort before the final `metadata` event is not charged (provider gives no usage); flagged in the ledger.
- The frontend `.env` has no `VITE_BACKEND_URL`; dev uses the apiClient default `http://localhost:3000/api/v1`,
  which matches `PORT=3000`. CORS for the FE origin is already configured because auth already uses Nest.
- No Prisma schema change; `prisma validate/generate` are run only as part of the matrix.
