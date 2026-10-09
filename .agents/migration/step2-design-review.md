# Step 2 design review (round 3): catalog, devices, circuit-info, visualization

Reviewed: `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\.agents\migration\step2-catalog-visualization-design.md` (revision 2).
Against: qdonis-backend working tree, qdonis-core `239d79a29c6fc6e97b2038aded19e5a71dbf1081` (read-only; `git status --porcelain` shows only the pre-existing `?? .agents/`), and the qdonis frontend.

Verdict: **CHANGES_REQUESTED** (0 HIGH, 1 MEDIUM, 3 NIT).

All 13 round-2 findings and round-1 finding 10 are resolved as the response table says. I re-checked each fix against the text.

Focus areas:
- (a) Visualize/netlist (D14/D15) is explicit and justified against every frontend reader (3.1). No netlist is faked: the key is omitted and `has_netlist: false`. I re-read `api_server.py:624-707`. Python checks `json_library/<raw name>.json` after `resolve_yaml_path`, so the 3.3 reachability analysis holds. Not a finding.
- (b) Counts re-measured at `239d79a`: 35 / 35 / 31 / 483 / 122 / 253 + 4 = 963, and no non-JSON entries under `models/library`.
- (c) Layout matches `src\auth` (root module/controller/service/types, `dto\`, subdomain folders) and step-1 `src\studio` (`agent\`, `dto\`).
- (d) The agent prompt stays byte-identical. `STUDIO_TOPOLOGY_IDS` is used only in `studio-agent.service.ts:17,64` and `studio-request.parity.spec.ts:6,66`. Both are covered in section 4, and the ids come from the same sorted stems.
- (e) Every new route sits behind the global `JwtAuthGuard`. There is no `@Public()`, and the e2e asserts 401 on all of them.
- (f) No env vars, no `process.env`, no `any` in signatures (`as unknown as` in a spec is fine). Repository holds the data source, service holds the rules, and the controller only wraps the result.
- (g) Paths follow the stated BE/FE/CORE root rule. Response shapes match what `circuitVisualizationService.ts` and `stages.ts` read.

## Findings

### 1. MEDIUM: `apply_updates` "after is not null" does not cover a missing `after`

Where: 1.4 `apply_updates` bullet ("rows whose `ref` and `param` are truthy and whose `after` is not `null`").

Problem: Python's rule is `row.get("after") is not None` (`studio_circuit.py:71`), which also skips rows that have no `after` key. Taken literally in JS, `row.after !== null` is `true` for `undefined`. A row `{ref: "L1", param: "inductance"}` would then do three things:
- write an own `inductance: undefined` key, which then takes a slot in the `[:6]` `key_params` slice and is dropped by `JSON.stringify`, so a real param disappears from the inventory;
- turn a falsy `params` into `{}`;
- for `inductance`, make the magnetics value `null` instead of the original.

Python leaves the component unchanged. The fixtures have `after: null` but no row without `after`, so parity tests would not catch it. Elsewhere the design spells out `null` **or** `undefined` (for example `pyStrKey`), so leaving it out here reads as deliberate.

Fix:
- 1.4: "rows where `pyTruthy(row.ref) && pyTruthy(row.param) && row.after !== null && row.after !== undefined` build `updates[...]`".
- 8.1 `circuit-info.json`: add a `dcdc_buck` case with a row `{ref: "<existing ref>", param: "<existing key>"}` (no `after`). The expected inventory equals the unmodified one.

### 2. NIT: request-shape deviations from Python that D21 does not record

Where: 5.2 and D21.

Problem: D21 records only "malformed circuits 400 where Python 500" and the non-string `topology_name`. The DTOs and limits also change outcomes Python handled differently:
- `circuit-info`: a non-string `topology_id` together with a valid `circuit` (Python 200, since the circuit is used and the id ignored) → Nest 400.
- `circuit-info`: a truthy non-object `circuit` such as `[1]` (Python falls through to the id lookup) → Nest 400.
- `circuit-info`: nesting depth 33 up to about 490, or more than 10,000 components (Python 200) → Nest 400.
- `circuit-info`: a truthy non-array `components` such as `5` (Python `TypeError` 500) → Nest 200 with an empty inventory, because non-arrays are skipped.
- `visualization`: a non-object `parameters` (Python ignores it) → Nest 400.

The frontend sends none of these.

Fix: append to D21: "Also: non-string `topology_id`, non-object `circuit`, and non-object `visualization.parameters` get 400 (Python ignored them or fell through). Circuits deeper than 32 levels or with more than 10,000 components get 400 (Python accepted them up to its recursion limit). A non-array `components` gives an empty inventory (Python 500)."

### 3. NIT: `pyStrKey` is undefined for non-scalar `ref`/`param`

Where: 1.1 `pyStrKey` ("Python `str()` of a JSON scalar") and its use in 1.4 `apply_updates` for `row.ref`, `row.param` and `comp.ref`.

Problem: rows are arbitrary objects, so `ref` can be a truthy array or object (`[1]`, `{a: 1}`). Python keys these as `str([1])` = `"[1]"`. The design doesn't say what `pyStrKey` returns for them. `String([1])` gives `"1"`, which would match a component whose ref is `"1"`, and Python's key would not.

Fix: in 1.1, "`pyStrKey` accepts only `null`/`undefined`/boolean/number/string. In `applyUpdates`, a row whose `ref` or `param` is an array or object is skipped, and a component whose `ref` is an array or object matches no update." Add to D23: "non-scalar update keys never match (Python matched them via `str()` repr)."

### 4. NIT: the 1.5 step-2 regex is written as a pseudo-literal

Where: 1.5 step 2, `base.replace(/[PY_WHITESPACE]*\([^)]*\)/gu, '')`.

Problem: as written, this is a literal character class of the letters `P`, `Y`, `_`, `W` and so on, not the interpolated constant. The 1.4 `to_number` regex shows the correct construction.

Fix: `base.replace(new RegExp(\`[${PY_WHITESPACE}]*\\([^)]*\\)\`, 'gu'), '')`.

## Verified assumptions

- Core HEAD is `239d79a29c6fc6e97b2038aded19e5a71dbf1081`. `git ls-tree` gives primitives `*.yaml` 35, json_library 35, prompts 31, diode 483, igbt 122, mosfet 253, the 4 single files, and 0 non-JSON entries in `models/library`. Total 963.
- `data_utils.get_builtin_topology_path` (`data_utils.py:96-141`) matches 1.5 steps 1-6: `strip`, `.yaml`/`.yml` removal, `\s*\([^)]*\)` removal, `-`/space → `_`, `_+` collapse, the alias `or` chain, `.yaml` appended only when missing, and the raw `orig_name` fallback. `resolve_yaml_path` does `str()` and accepts local paths first, so D18 is correctly recorded.
- `api_server.py:624-707` `/api/visualize`: `topology_name` falsy → 400; `resolve_yaml_path` `FileNotFoundError` → 404; the static lookup uses the raw name; the placeholder string is verbatim; `elements_count = len(components)`; `has_netlist = len(netlist) > 0`; `source: 'static_library'`; `parameters` is read but unused on the static path.
- `api_server.py:2656-2676` `/api/studio/circuit-info`: the "`topology_id` or `circuit`" truthiness check → 400, `FileNotFoundError` → 404, other errors → 500. This matches 5.2.
- `studio_circuit.py:30-137` matches the 1.4 pseudo-code: `to_number`, `load_topology_dict`, `iter_components` (only `dict` items, `internal or []`, raw parent ref), `apply_updates` (`setdefault`), `_switching_frequency` (weights, keys, the `>= 1e3` threshold, the period rule, `round(1/period, 6)`, `max(set, key=count)`), and `circuit_inventory` (node skip rule, `key_params` slice-then-filter, magnetics fields, `input_voltage` via `str(comp.get("role", ""))`, key set). The one exception is finding 1.
- `src\studio\agent\python-json.ts` has a private `PY_SPACE` that equals Python's `str.isspace` set (`\t\n\v\f\r`, U+001C–U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000). `pythonStr(null)` is `''`. The three importers named in 1.1 are the only importers besides the spec.
- `AppError.notFound` = `make(NotFoundException, …)` in `src\common\errors\error-codes.ts`. `ErrorCode.ValidationFailed` exists. `TopologyNotFound` does not exist yet.
- Global `ValidationPipe` in `src\app.module.ts:168-179`: `whitelist`, `forbidNonWhitelisted`, `transform: true`, `enableImplicitConversion: false`. `ResponseTransformInterceptor` runs `instanceToPlain(payload, { enableCircularCheck: true })` and does not wrap the body. Library schematics and the inventory have no shared object references, so the circular check drops nothing.
- `StudioModule` imports only `AiModule`. `StudioController` is `@Controller('studio')` with the constructor `(agent)`. The layouts of `src\auth` and `src\studio` match 1.2-1.5.
- Frontend `circuitVisualizationService.ts`: a local `API_BASE_URL` (core) exists, so importing only `apiRequest` avoids a clash. `getAvailableTopologies` rethrows, and the model getters return `[]` on error. `visualizeCircuit` has the retry/`AbortController` loop. `apiRequest` (`services\api\apiClient.ts:229-241`) supports `method`, `body`, `query` and `signal`. `stages.ts:364-374` `fetchInventory` sends `{topology_id, circuit || undefined, recalculated_parameters || undefined}` and reads `data.inventory`. The visualize callers send only `{topology_name}`.
- `assets\` and `.gitattributes` don't exist yet in qdonis-backend, which matches implementation order step (1).
- Carried over from round 2 and not contradicted by this pass: the device metadata and type counts, PyYAML behaviour on the 35 YAMLs, the `tsconfig.build.json` `rootDir`, the Jest `rootDir`, `yaml@2.9.1` licensing, the throttle defaults, and the `main.ts` `Failed to start` handling.

## Unverified or wrong assumptions

- Wrong: "`after` is not `null`" is equivalent to Python's `is not None` (finding 1).
- Unverified: that `yaml@2.9.1` `customTags` (function form) removes every `yaml-1.1` scalar tag variant. The `pyyaml-scalars.json` spec will confirm it.
- Unverified: the frontend `tsc` baseline of 398 errors (from step 1, not re-measured).
- Unverified in this pass: the two U+00A0 stems (confirmed in round 1 with `core.quotepath=false`).
