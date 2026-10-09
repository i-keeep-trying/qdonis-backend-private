# Parity capture: Studio agent (qdonis-core -> qdonis-backend)

`studio_agent_capture.py` runs the real qdonis-core `studio_agent.stream_agent_step`
with the Bedrock client replaced by a recorder (no Bedrock call, no network) and
writes one fixture per input:

- `../fixtures/studio-agent/inputs/NN-*.json`: hand-written inputs
  `{name, description, messages, project_state, bedrock_stream?, bedrock_error?, wire_invalid?}`.
- `../fixtures/studio-agent/NN-*.json`: generated. `expected_request` is the exact
  Converse request Python builds (modelId, system, messages, inferenceConfig,
  toolConfig); `expected_events` is what Python streams for the scripted
  `bedrock_stream`.
- `../fixtures/studio-agent/topology-ids.json`: the core topology library ids.

The Jest specs `src/studio/agent/studio-request.parity.spec.ts` (request builder)
and `src/studio/agent/studio-agent.service.spec.ts` (event mapping, charging)
replay every fixture. The fixtures are committed data, so the specs keep running
after qdonis-core is deleted.

## Re-run

From the qdonis-backend root, with the qdonis-core venv:

```powershell
& "..\qdonis-core\.venv\Scripts\python.exe" test\parity\capture\studio_agent_capture.py
# other checkout:  ... studio_agent_capture.py --core D:\path\to\qdonis-core
npm test -- src/studio
```

- The script re-executes itself with `PYTHONHASHSEED=0` (the core orders some
  synthesized tool results by set iteration) and `PYTHONDONTWRITEBYTECODE=1`, so
  re-runs are byte-identical and nothing is written inside qdonis-core.
- `BEDROCK_MODEL_ID` is ignored so the default model is captured.
- The two error inputs (14, 15) make the core log a traceback; that is expected.

## Writing inputs

- Write numbers the way the frontend (JS `JSON.stringify`) can produce them: an
  integral value is an int (`5`, not `5.0`). Python would print `5.0` for a float
  the browser can never send. Integers above 2^53 cannot round-trip through JS.
- Avoid integer-like object keys (`"1"`): JS orders them first, Python keeps
  insertion order.
- Set `wire_invalid` when Python accepts an input that the stricter Nest DTO
  rejects (e.g. a non-object `project_state`); the DTO spec asserts the 400.
