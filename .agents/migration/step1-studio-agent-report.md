# Step 1 report: Studio agent moved to qdonis-backend

Date: 2026-10-09. Final. Review verdict: APPROVED (`step1-review.json`, `step1-review.md`), with 6 non-blocking
findings listed under "Review follow-ups".

**Nothing was committed or pushed.** All changes are uncommitted on `feature/studio-agent` in qdonis-backend
(HEAD `67f1944`) and qdonis (HEAD `6b783c7`). No worktrees. qdonis-core (`239d79a`) is untouched:
`git status` there shows only the pre-existing untracked `.agents/`. No `.env` file was edited or printed.

## What changed

`POST /api/v1/studio/agent` (JWT, SSE, charged) replaces the Python `POST /api/studio/agent`. It sends
Bedrock the same system prompt, tools, repaired history and inference settings, and streams the same events
(`text`, `tool_call {id,name,input}`, `done {usage,stop_reason,model}`, `error`). The frontend uses it by
default. `VITE_STUDIO_AGENT_BACKEND=core` switches back to Python.

### qdonis-backend: files added

- `src/ai/bedrock/` shared Bedrock layer:
  - `bedrock.types.ts`: request/result/stream-event types, `BEDROCK_RUNTIME` token, `JsonValue`, `FunctionToolDefinition`.
  - `bedrock-runtime.provider.ts`: SDK client factory (explicit SigV4 creds or bearer token, `maxAttempts: 3`, connect 10 s, socket `BEDROCK_TIMEOUT_MS`).
  - `bedrock.client.ts`: `assertConfigured`, `resolveModel`, `converse` (ConverseCommand), `converseStream`
    (ConverseStreamCommand → normalised events). Overall deadline `BEDROCK_TIMEOUT_MS`, 60 s idle watchdog,
    abort on caller signal, usage extraction. Replaces `src/ai/bedrock.client.ts` (deleted).
  - `bedrock-errors.ts`: `BedrockError` + mapping of SDK errors (HTTP status or exception name, in-stream exceptions, network codes) to the existing user-safe messages. Logs name/status/message only.
  - `bedrock-tools.ts`: `convertTools`, a port of Python `convert_tools`.
- `src/studio/` (layout follows `src/auth`):
  - `studio.module.ts`, `studio.controller.ts`, `studio.types.ts`, `dto/studio-agent.dto.ts`.
  - `agent/studio-agent.service.ts`: one step: build request, stream, charge once, then tool calls and `done`.
  - `agent/studio-system-prompt.text.ts`: the prompt text, generated verbatim from the Python constant.
  - `agent/studio-system-prompt.ts`: topology library and project snapshot, truncated to 9,000 code points.
  - `agent/studio-tools.ts`: the 17 tools, generated verbatim from Python `build_tools`.
  - `agent/message-normalizer.ts`: history repair (`to_converse_messages` port).
  - `agent/python-json.ts`: Python-exact `json.dumps`, float `repr`, `str()`, `strip()`, code-point truncation.
  - `agent/topology-library.ts`: 35 topology ids (static until the topology library moves).
  - `agent/studio-request.builder.ts`.
- Unit specs: `src/config/configuration.spec.ts`, `src/ai/ai.service.spec.ts`, `src/ai/bedrock/bedrock.client.spec.ts`,
  `src/ai/bedrock/bedrock-tools.spec.ts`, `src/studio/agent/{python-json,message-normalizer,studio-request.parity,studio-agent.service}.spec.ts`,
  `src/studio/dto/studio-agent.dto.spec.ts`.
- `test/studio.e2e-spec.ts`, `test/helpers/bedrock-fakes.ts`, `test/parity/studio-agent-fixtures.ts`.
- Parity harness: `test/parity/capture/studio_agent_capture.py`, `test/parity/capture/README.md`,
  `test/parity/fixtures/studio-agent/inputs/01..16-*.json` (16 inputs), 16 generated fixtures, `topology-ids.json`.
- `.agents/migration/core-migration-ledger.md`, this report.

### qdonis-backend: files changed

- `package.json`, `package-lock.json`: `@aws-sdk/client-bedrock-runtime` `3.1148.0` (exact). Note: `package-lock.json`
  already had unrelated uncommitted changes (`dev` → `devOptional` flags) before this step.
- `src/config/env.validation.ts`: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (optional,
  validated). `BEDROCK_REGION` is now optional with no default. Both AWS keys or neither. Production needs the
  key pair or `BEDROCK_API_KEY`. Blank values were already treated as unset by `validateEnv`.
- `src/config/configuration.ts`: `bedrock.authMode` (`sigv4` | `bearer` | `none`), `accessKeyId`, `secretAccessKey`,
  region precedence `BEDROCK_REGION` → `AWS_REGION` → `us-east-1`.
- `.env.example`: the three AWS keys plus comments on auth mode and region precedence. `BEDROCK_REGION` is blank.
- `src/app.module.ts`: registers `StudioModule`. Adds pino redact paths `*.secretAccessKey`, `*.accessKeyId`, `*.apiKey`,
  `*.credentials`, `*.token`, `*.AWS_SECRET_ACCESS_KEY`, `*.AWS_ACCESS_KEY_ID`, `*.BEDROCK_API_KEY`.
- `src/ai/ai.service.ts`: public `prepare(userId, requestedModel?)` and `chargeUsage(userId, {modelId, step, inputTokens, outputTokens})`.
  `converse()` uses both, with the same charging formula, idempotency key and remainder logic.
- `src/ai/ai.controller.ts`: passes `dto.modelId` to `prepare` and imports `BedrockError` from its new path.
  The SSE contract is unchanged.
- `src/ai/ai.module.ts`: provides the SDK client and exports `AiService` + `BedrockClient`.
- `src/settings/settings.schema.ts`: adds `studio_agent` to `DEFAULT_STEPS`.
- `test/ai.e2e-spec.ts`: Bedrock is now mocked with `.overrideProvider(BEDROCK_RUNTIME)` instead of `global.fetch`.
  All original assertions are kept. It also checks the multi-block message shape.
- `test/setup-env.ts`: fake AWS keys, so the real `.env` keys never load in tests.

### qdonis (frontend): files changed

- `lib/studio/agent.ts` only. `openAgentStream()` posts to `${API_BASE_URL}/studio/agent` (apiClient base,
  default `http://localhost:3000/api/v1`). It sends the Bearer token from `getAccessToken()`, uses `credentials: 'include'`,
  and retries once on 401. The retry calls `getAccessToken()` again, which returns the cached token until
  `refreshAt`, so it can resend the rejected token (same as `services/bedrockService.ts`; review follow-up 3). `INSUFFICIENT_TOKENS` becomes `ApiError(402, ...)` with the same message as bedrockService.
  Error text comes from `message` (Nest) or `error` (core). On `done` in nest mode it calls `invalidateBilling()` and
  `tokenUpdateEvents.emit()`. SSE parsing, the tool loop, the usage reporter, `stages.ts` and the legacy assistant are unchanged.

## Decisions

- Region precedence: `BEDROCK_REGION`, then `AWS_REGION`, then `us-east-1`.
- Auth precedence: AWS key pair (SigV4) wins over `BEDROCK_API_KEY` (bearer, via SDK `token` +
  `authSchemePreference: ['httpBearerAuth']`). With neither, the endpoint returns 503 `AI_NOT_CONFIGURED`.
- Step multiplier key: `studio_agent`. It is listed in the `step_multipliers` defaults; when unset the multiplier is 1.
- Charging: one `chargeUsage` per step, after the stream completes and before `tool_call`/`done` are written.
  If the charge itself fails, the client gets one `error` event and no tool calls. An abort or provider error before
  usage metadata arrives is not charged; this matches `/ai/bedrock/converse`, and the gap is noted in the ledger.
- Deliberate differences from Python (all in the ledger):
  - Missing tool results are synthesized in tool-use order, not hash order. The parity test sorts only those runs.
  - `error` text is `The assistant could not respond: ` plus a user-safe message instead of raw exception text.
  - Request validation is stricter (D11). A non-object `project_state` gets 400 where Python used `{}`
    (fixture 10, `wire_invalid`).
  - `: heartbeat` comments every 20 s.
- `/ai/bedrock/converse` now goes through the SDK `ConverseCommand`. Body, SSE framing, heartbeats,
  402/idempotency/multiplier charging and error strings are unchanged.

## Frontend flag

`VITE_STUDIO_AGENT_BACKEND`:

- `nest` (default, or unset): qdonis-backend, JWT, charged.
- `core`: Python `${VITE_QDONIS_API_URL}/api/studio/agent`, unauthenticated, uncharged.

It is documented in the header comment of `lib/studio/agent.ts`. It is not added to any `.env`. To use core
for one run: `$env:VITE_STUDIO_AGENT_BACKEND='core'; npm run dev`.

## How to re-run

```powershell
# parity capture (qdonis-backend root; writes fixtures, never touches core)
& "..\qdonis-core\.venv\Scripts\python.exe" test\parity\capture\studio_agent_capture.py
# backend checks
npx prisma validate; npm run typecheck; npm run lint:check; npm run build; npm test
# e2e: disposable local DB qdonis_e2e (created in this step on the local 5432 server, migrated)
$env:E2E_DATABASE_URL = '<DATABASE_URL with database qdonis_e2e>'; npm run test:e2e
```

## Verification results (all executed 2026-10-09)

| Command (qdonis-backend) | Result |
|---|---|
| `npx prisma validate` | pass (no schema change) |
| `npx prisma generate` | pass |
| `npm run typecheck` | pass |
| `npm run lint:check` | pass (0 problems) |
| `npm run build` | pass (`dist/main.js`, `dist/studio/studio.module.js`) |
| `npm test` | 9 suites, 173 tests, all pass (before this step there were 0 unit specs) |
| `npm run test:e2e` (against `qdonis_e2e`) | 4 suites (auth, billing, ai, studio), 70 tests, all pass; studio suite has 7 tests, ai suite keeps its 5 |
| capture run twice | 16 fixtures + 35 topology ids; second run byte-identical (SHA-256); core `git status` unchanged |

Parity gate: all 16 fixtures pass the request parity spec. Each fixture is checked four ways: system prompt equal,
toolConfig equal, messages equal, full request deep-equal. Every fixture's Python `bedrock_stream` replayed through
the real `BedrockClient` + `StudioAgentService` gives Python's `expected_events`. `error` events are compared by
type and prefix. `chargeUsage` is called exactly once with step `studio_agent` when usage exists, and never
otherwise. Edge cases covered:

- consecutive same-role turns
- orphan and mismatched tool results
- tool use without result, including a trailing tool use
- leading assistant turn and a result-only leading user turn
- empty, whitespace and invalid blocks (U+001F, U+0085, U+FEFF)
- project_state over 9,000 code points, with an astral emoji at the cut and Python float repr
- 9 tool calls with every result shape
- trailing assistant turn ("Continue.") and history that repairs to nothing ("Hello")
- interleaved stream blocks, malformed or empty tool JSON, a nameless block
- no metadata (`usage: {}`), metadata without usage (zeros)
- errors mid-stream and on the call itself

Endpoint e2e (Bedrock mocked):

- 401 without a token and no Bedrock call.
- 400 for empty messages, string content, and non-object `project_state`.
- Happy path: headers `text/event-stream`, `no-cache`, `X-Accel-Buffering: no`; events equal the fixture; one Bedrock call.
  Balance drops by exactly input + output tokens, with exactly one negative ledger entry (`ai_usage`, `step: studio_agent`).
- Admin multiplier 0.5 halves the charge.
- At zero balance: 402 `INSUFFICIENT_TOKENS` with no Bedrock call.
- Provider 429: one `error` event and no charge.
- Client disconnect: the SDK abort signal fires and nothing is charged.

Live Bedrock (real AWS keys from `.env`, model `us.anthropic.claude-sonnet-4-5-20250929-v1:0`). The user's dev
servers were not running, so I started my own: Nest from `dist` on :3100 (`PORT=3100` in the shell only) and
Python core on :5101. Both were stopped afterwards.

- `POST /api/v1/studio/agent` without a token: 401.
- First turn (`inputs/01-first-turn.json` + a small project_state), Nest: 200 `text/event-stream; charset=utf-8`.
  9 `text` events, then `tool_call ask_user` (input keys `fields`, `question`), then `done` with usage
  `{prompt_tokens: 11920, completion_tokens: 469, total_tokens: 12389}` and `stop_reason: tool_use`.
- Same request to Python `:5101/api/studio/agent`: same event types, same tool name and input keys, and the same
  `prompt_tokens` (11,920, so the provider saw the same prompt, tools and messages). Same `stop_reason`, almost the same text.
- Charging: balance 10,000 → 0, with exactly one `ai_usage` ledger entry (−10,000, `step: studio_agent`). The step cost
  12,389, more than the 10,000 signup bonus, so the existing remainder rule charged what was left. The exact-amount
  check (balance − input − output) is covered by the e2e suite, not live; see open question 1.
- Two-turn loop: step 1 → `update_specs` tool call (`stop_reason: tool_use`). Step 2 sent the assistant `tool_use` plus a
  `tool_result` back; the agent continued with 56 `text` events and `done` (`end_turn`). Step 2 ran as a fresh user,
  because one step costs more than a signup bonus.
- `POST /api/v1/ai/bedrock/converse` `{messages:[{role:'user',content:'Say OK'}]}`: one event
  `{done:true, content:'OK', usage:{inputTokens:9,outputTokens:4,totalTokens:13}, charged:13, balance:9987}`.
  This is the old contract, now on the SDK.
- Log check: no AWS key ids and no bearer tokens in the server log.

Frontend (qdonis):

- `npx tsc --noEmit -p tsconfig.json`: 398 errors, the same as the pre-existing baseline, and 0 in `lib/studio/agent.ts`.
- `npm run build`: passes with `NODE_OPTIONS=--max-old-space-size=8192` (3 m 41 s). With the default heap, Vite ran out
  of memory. I did not re-run the baseline to prove the OOM predates this change. The change adds about 40 lines and
  imports modules that are already in the bundle.

Not verified:

- Browser end-to-end. No browser automation is available in this environment and the dev servers were not running.
  Manual steps:
  1. Start qdonis-backend (`npm run start:dev`, :3000), qdonis-core (:5001, for the stage tools) and `npm run dev` in qdonis.
  2. Sign in and open a Studio project. Send "Design a 12 V to 5 V, 3 A buck converter".
  3. In DevTools → Network, check that the request goes to `http://localhost:3000/api/v1/studio/agent` with
     `Authorization: Bearer …` and that the text streams.
  4. Approve or answer the `ask_user`/`update_specs` card. Check that a stage tool (e.g. `select_topology`) still calls
     `127.0.0.1:5001`, that the loop continues, that Stop aborts the stream, and that the header balance drops.
  5. Stop `npm run dev`, run `$env:VITE_STUDIO_AGENT_BACKEND='core'; npm run dev`, and check that the agent request goes to
     `127.0.0.1:5001/api/studio/agent`.
- Live client-disconnect abort against real Bedrock (covered by unit and e2e tests with a mocked SDK).
- Bearer (`BEDROCK_API_KEY`) mode against real Bedrock. Only SigV4 is configured. Bearer mode is covered by
  typecheck and config unit tests only.

## Side effects to know about

- I created a local database `qdonis_e2e` on the 5432 server (with `prisma migrate deploy`) for the e2e suites.
  You can drop it if you don't want it.
- The live check registered 5 verified test accounts `studio-live-*@example.com` in `qdonis_dev`, via the real
  register and verify-email API. They spent their signup tokens. I did not delete them.

## Open questions

1. Seeded-user passwords (`SEED_ADMIN_PASSWORD` / `SEED_USER_PASSWORD`) are not in `.env`, so I could not log in as
   `admin@example.com` / `user@example.com` or grant tokens. To check the exact live deduction, re-run with an admin
   grant of 50,000 tokens.
2. One Studio step costs about 12k tokens: about 11.9k is the system prompt plus tools, sent on every step. The 10k
   signup bonus covers less than one step. Consider a lower `studio_agent` multiplier, a bigger bonus, or Bedrock
   prompt caching (a later, behaviour-changing decision).
3. Should the frontend keep the Supabase `saveTokenUsage` tracking for agent steps now that the server charges them?
4. Should the Vite build get a larger heap in `package.json` scripts? (Not changed here.)
5. Should an aborted step be charged (see follow-up 1)? This is a product decision. Today it is free.

## Review follow-ups (non-blocking, not implemented)

1. Aborted stream is free. When the client stops mid-stream, the step is not charged, even when usage
   metadata already arrived. Bedrock still bills the ~12k-token prompt (D9).
2. Concurrent balance gate. `prepare()` only checks `balance > 0`, so parallel requests from a low-balance user
   all run. Fix with a per-user in-flight limit or a token reservation.
3. Frontend 401 retry reuses the cached token. Call `refreshSession()` before the retry.
4. The e2e happy path compares SSE events but not the Bedrock request after ValidationPipe. Assert
   `fake.sent[0].input` deep-equals `fixture.expected_request`.
5. Some DTO strictness cases are new 400s: role `system`, numeric `id`/`tool_use_id`, non-string text. They are
   now listed under D11 in the ledger.
6. `/ai/bedrock/converse` now retries throttles and 5xx (SDK `maxAttempts: 3`), where the old client made
   one call. Now listed in the ledger (D13).

## Uncommitted footprint (final `git status --porcelain`)

qdonis-backend, branch `feature/studio-agent`, HEAD `67f1944` (same as `main`/`origin/main`). 21 entries:

```
 M .env.example
 M package-lock.json
 M package.json
 M src/ai/ai.controller.ts
 M src/ai/ai.module.ts
 M src/ai/ai.service.ts
 D src/ai/bedrock.client.ts
 M src/app.module.ts
 M src/config/configuration.ts
 M src/config/env.validation.ts
 M src/settings/settings.schema.ts
 M test/ai.e2e-spec.ts
 M test/setup-env.ts
?? .agents/migration/
?? src/ai/ai.service.spec.ts
?? src/ai/bedrock/
?? src/config/configuration.spec.ts
?? src/studio/
?? test/helpers/
?? test/parity/
?? test/studio.e2e-spec.ts
```

That is 12 modified, 1 deleted and 8 untracked paths (directories collapsed). `.agents/migration/` holds this
report, the plan, the review (`.md` + `.json`) and the ledger.

qdonis, branch `feature/studio-agent`, HEAD `6b783c7` (same as `revamp/auth-stripe`/`origin/revamp/auth-stripe`). 1 entry:

```
 M lib/studio/agent.ts
```

qdonis-core: only the pre-existing untracked `.agents/`. Not modified.

Checks: `git reflog` in both repos shows only clone and checkout, with no commits. `git worktree list` shows only the
main worktree. `git ls-remote --heads origin feature/studio-agent` returns nothing in both repos, so the branch
does not exist on any remote.

**Nothing was committed and nothing was pushed to any remote.**
