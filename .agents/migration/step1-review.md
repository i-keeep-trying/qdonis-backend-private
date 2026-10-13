# Studio agent step moved from qdonis-core to a charged NestJS SSE endpoint

The Python `POST /api/studio/agent` is ported to `POST /api/v1/studio/agent` in qdonis-backend. The endpoint is JWT-protected by the global guard, checks the balance (402) before any Bedrock call, streams the same `text` / `tool_call` / `done` / `error` events, and charges each completed step once through a refactored `AiService.chargeUsage`. A shared `src/ai/bedrock/` layer replaces the hand-rolled `fetch` client with `@aws-sdk/client-bedrock-runtime` (SigV4 from the new AWS keys, bearer fallback), and `/ai/bedrock/converse` now goes through the same layer. Parity rests on 16 fixtures captured from the real Python `stream_agent_step`: every fixture deep-equals the request (system prompt, tools, repaired messages, inference config) and replays the expected events. The frontend change is confined to `lib/studio/agent.ts`, with a `VITE_STUDIO_AGENT_BACKEND=core` fallback. Nothing was committed, no worktrees exist, and qdonis-core is unmodified.

Watch for: a Stop or disconnect mid-stream gives the user the partial text without charging, even though Bedrock bills the input (about 12k tokens per step) (confirmed, documented trade-off); parallel requests from a low-balance user each pass the `balance > 0` gate, and each step costs more than the signup bonus (likely); the 401 retry in the frontend reuses the cached token instead of forcing a refresh (confirmed).

**Verdict**: APPROVED

## High-level view

Pure functions in `src/studio/agent/` (Python-exact JSON, history repair, prompt and tool text, request builder) are checked one by one against Python-captured fixtures. `StudioAgentService` owns stream-to-events and the charging order, and the controller is only SSE plumbing. `max_tokens` 4096, temperature 0.3, the default model (`BEDROCK_ALLOWED_MODELS[0]`), the 9,000 code-point cut, the 17 tools and the 35 topology ids are all backed by fixtures. In the live run, both servers got 11,920 prompt tokens back from Bedrock for the same input.

Charging reuses the converse formula, idempotency key and remainder rule. The charge happens before `tool_call`/`done`, so a failed charge withholds the tool calls. Anything that ends the stream before metadata arrives is not charged (D9). This costs more here than on converse, because the user already has the streamed text.

The ledger lists the deliberate deviations. The DTO is also stricter than Python in ways the ledger does not list (role `system`, non-string ids), though the frontend never sends them.

The `/ai/bedrock/converse` contract survives the SDK swap, but the SDK's `maxAttempts: 3` now retries throttles and 5xx where the old `fetch` client did not.

<details>
<summary>Issues (6)</summary>

1. **Aborted streams are free** (non-blocking): a client that stops mid-stream keeps the streamed text and is never charged. In `studio-agent.service.ts`, charge usage whenever metadata arrived, even if the signal aborted afterwards. Also consider charging a prompt-size estimate on abort, or record the decision explicitly with the product owner.
2. **Concurrent steps bypass the balance gate** (non-blocking): `prepare` only checks `balance > 0`, and one step costs about 12k tokens, so N parallel requests are served for at most the remaining balance. Add a per-user in-flight limit for `/studio/agent`, or reserve tokens before the call.
3. **Frontend 401 retry does not refresh** (non-blocking): `openAgentStream` calls `getAccessToken()` again, which returns the same cached token until `refreshAt`. Call `refreshSession()` on 401, in `lib/studio/agent.ts` and in the `bedrockService.ts` it was copied from.
4. **No e2e check of the wire request after the ValidationPipe** (non-blocking): the parity spec builds from raw fixture JSON, and the e2e happy path compares only events. Assert `fake.sent[0].input` deep-equals `fixture.expected_request` in `test/studio.e2e-spec.ts`.
5. **Undocumented DTO strictness** (non-blocking): role `system`, numeric `id`/`tool_use_id` and non-string `text` now return 400, where Python skipped or coerced them. Add these to the D11 deviations in the ledger.
6. **Converse now retries** (non-blocking): `maxAttempts: 3` changes `/ai/bedrock/converse` latency on 429/5xx compared with the old single `fetch`. Note it in the ledger, or set `maxAttempts: 1` for `converse()` if the old behaviour matters.

</details>

<details>
<summary>Details</summary>

### Charging around a streamed step

`runStep` ends the provider stream, then checks `if (signal.aborted) return;` before calling `chargeUsage`. With the SDK abort wired to `response.on('close')`, a client disconnect at any point before the last event rejects the pending `iterator.next()`. The catch then returns without a charge (confirmed, `studio-agent.service.ts` lines 96-101). This is the D9 decision and the ledger lists it. The asymmetry with converse is new, though. On converse an abort meant the user got nothing. Here every `text` delta was already written to the socket, so the Stop button yields a free partial answer while Bedrock bills the ~11.9k-token prompt. The post-loop abort check also skips the charge in the narrow case where metadata already arrived. That case at least should be charged, because the usage is known.

A second gap comes from combining the reused gate with the new cost profile (likely). `AiService.prepare` admits any user with `balance > 0`, and the remainder rule then charges whatever is left. One Studio step costs more than the whole 10k signup bonus, so a user with a few tokens can open several steps in parallel. Every step is served, and only the remainder is collected once. The rule is unchanged from converse, but here each request has a fixed ~12k-token floor.

### Parity evidence

```
inputs/*.json --(real Python stream_agent_step, fake boto client)--> fixtures/*.json
        |                                                        expected_request / expected_events
        v
buildStudioRequest -> buildConverseInput  ==deep-equal==  expected_request   (parity spec, x16)
fake SDK stream    -> BedrockClient -> StudioAgentService ==  expected_events (service spec, x16)
```

The fixtures cover all of the following:

- consecutive same-role turns
- orphan and mismatched results
- trailing tool uses
- leading assistant and result-only turns
- Python-only whitespace (U+001F, U+0085, U+FEFF)
- the 9,000 code-point cut through an astral character
- float repr
- the "Hello" and "Continue." fallbacks
- interleaved and malformed tool blocks
- missing metadata
- mid-stream and on-call errors

The e2e is missing one layer. The HTTP happy path compares events but not `fake.sent[0].input`, so nothing proves that class-transformer's handling of `input` / `content` / `project_state` leaves the request identical to the raw-fixture build. The live run's identical prompt-token count makes a difference unlikely.

### Bedrock layer side effects on converse

The SDK brings two behaviour changes. `maxAttempts: 3` adds retries on throttles and 5xx, so a 429 now takes longer to surface on `/ai/bedrock/converse`. With the AWS key pair set, converse also switches from bearer to SigV4 without any visible signal (intended by D1). Bearer mode is exercised only by typecheck and config specs.

### Validation strictness

The DTO is stricter than Python in ways the ledger does not list. Role `system`, numeric ids and non-string `text` now get 400, where Python skipped or `str()`-ed them. The frontend `ChatBlock` type never produces these, so nothing breaks today.

### Frontend switch

`openAgentStream` is a near copy of `bedrockService`, including its weakness. On 401 it calls `getAccessToken()` again, and that returns the cached token unless `refreshAt` has passed. A revoked or rejected token is therefore retried unchanged instead of refreshed (confirmed against `apiClient.ts` lines 220-223). The `done` handler refreshes the billing UI only in `nest` mode. The Supabase `saveTokenUsage` reporter still runs, which is open question 3 in the report.

### Side effects and unverified paths

Side effects left behind: the `qdonis_e2e` database, and five `studio-live-*@example.com` accounts in `qdonis_dev`. Browser end-to-end and live bearer mode are not verified.

</details>

<details>
<summary>File map</summary>

qdonis-backend:
- `src/ai/bedrock/*`: new SDK client, provider token, error mapping, tool conversion and types; replaces deleted `src/ai/bedrock.client.ts`.
- `src/ai/ai.service.ts`: `prepare(userId, model?)`, public `chargeUsage`.
- `src/ai/ai.controller.ts`, `src/ai/ai.module.ts`: import path, provider wiring, exports.
- `src/studio/*`: module, SSE controller, types, DTO, `agent/` (service, normalizer, python-json, prompt text, tools, topology ids, request builder) plus specs.
- `src/config/env.validation.ts`, `configuration.ts`, `.env.example`: AWS key pair, auth mode, region precedence.
- `src/app.module.ts`: `StudioModule`, redact paths.
- `src/settings/settings.schema.ts`: `studio_agent` step key.
- `test/*`: SDK-based converse e2e, studio e2e, fakes, parity harness and 16 fixtures.
- `package.json`/`package-lock.json`: `@aws-sdk/client-bedrock-runtime@3.1148.0`.

qdonis:
- `lib/studio/agent.ts`: Nest endpoint with JWT, 402 mapping, billing refresh, `core` fallback flag.

Full diff: `git diff` plus untracked files in both repos on `feature/studio-agent`.

</details>
