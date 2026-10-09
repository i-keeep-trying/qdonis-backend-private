# Step 2 design: topology library, device library, circuit-info and visualization move to qdonis-backend

> **APPROVED** (revision 3, final). The round-3 review findings (1 MEDIUM, 3 NIT) are applied below; see
> "Round 3 (revision 3)" at the end. No further design-review loop. All prior decisions stand, including D14
> (`POST /api/v1/visualization` ships without a netlist) and D15 (no LLM fallback).

Previous status: revision 2, resolving the round-2 review
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\.agents\migration\step2-design-review.json` /
`step2-design-review.md` (CHANGES_REQUESTED, 0 HIGH / 1 MEDIUM / 12 NIT). All 13 round-2 findings and the
outstanding round-1 finding 10 are addressed; see the final section. Design only; no production code, no commits.

Path convention (finding 9): every path is absolute. Where a table cell or list gives a short path, the section
states its absolute root first. The three roots are:
- BE = `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend`
- FE = `d:\1. TailorFlowAI Work\Qdonis v2\qdonis`
- CORE = `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-core` (read-only)

Fixed rule for any remaining short path: one starting with `assets\`, `src\`, `test\`, `scripts\` or `dist\` is
under BE; one starting with `lib\`, `components\`, `services\`, `types\` or `App.tsx` is under FE; one starting with
`qdonis_backend\` is under CORE.
Python reference: `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-core` at `239d79a29c6fc6e97b2038aded19e5a71dbf1081`
(`feature/chat-first`), read-only. Frontend: `d:\1. TailorFlowAI Work\Qdonis v2\qdonis` on `feature/studio-agent`.

## Overview

Seven read-only Python routes move into NestJS: `GET /api/topologies`, `GET /api/models/{mosfet,diode,igbt}`,
`GET /api/studio/device-library`, `POST /api/studio/circuit-info` and `POST /api/visualize`. Their data
(35 topology YAMLs, 35 schematic JSONs, 858 device model JSONs, plus 31 prompts and 4 single files carried for
later steps) is copied byte-for-byte from the core git commit into
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\assets\`, recorded in a SHA-256 manifest, and loaded, verified
and validated once at boot into frozen in-memory catalogs. A bad or missing asset stops the process at startup;
no request ever touches the filesystem. Three new feature modules (`topologies`, `devices`, `visualization`) follow
the `src/auth` layout; circuit-info is added to the existing `src/studio` module. The Studio agent stops using the
static id list from step 1 and reads ids from the topology catalog, producing the same system prompt and tool
schema byte for byte. `POST /api/v1/visualization` ships now as a clean split: the static schematic without the
SPICE netlist, because no live frontend path reads that netlist (evidence in section 3). The LLM fallback is
dropped: it is unreachable for the 35 canonical ids, and the alias inputs that reached it now resolve to the
canonical static schematic. The frontend switches the five migrated call sites behind one flag,
`VITE_STAGE_BACKEND=nest|core` (default `nest`).

Technology stack (locked): NestJS 11 / Express 5 (existing), class-validator DTOs (existing), Node `fs/promises`
+ `crypto` for loading and hashing, and one new dependency, `yaml@2.9.1` (exact pin, ISC, eemeli/yaml), configured
with a PyYAML-compatible scalar schema. No database, no Prisma schema change, no new env vars in the backend.

## 1. Module layout and route map

Layout mirrors `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\auth` and step 1's
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\studio`
(module / controller / service / repository / types at the module root, `dto\` folder, subdomain subfolders).
Repositories here hold the in-memory catalog loaded from `assets\` (there is no Prisma access), so the
repository → service → controller rule keeps its meaning: data source in the repository, rules in the service,
no logic in the controller.

### 1.1 Shared helpers

- `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\common\assets\assets-root.ts`:
  `export const ASSETS_ROOT = resolve(__dirname, '..', '..', '..', 'assets')`. The path depth is the same for
  `src\common\assets\*.ts` (ts-jest, `nest start`) and `dist\common\assets\*.js` (`nest build` keeps `rootDir: src`),
  so both resolve to `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\assets`. No env var (decision D16).
- `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\common\assets\asset-manifest.ts`:
  - `readManifest(root): Promise<AssetManifest>` parses `assets\MANIFEST.json` (shape in 2.3).
  - `loadVerifiedSubtree(root, manifest, prefix): Promise<Map<string, Buffer>>`. Lists every file on disk under
    `root/prefix` recursively. The disk set and the manifest entries under `prefix` must be identical; then each
    file's byte length and SHA-256 must match. Files are read in batches of 32 to avoid EMFILE. Returns
    relative POSIX path → bytes.
  - `AssetValidationError extends Error`, message `Asset validation failed: <relative path>: <reason>`.
- `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\common\python\python-json.ts` (+ `python-json.spec.ts`):
  step 1's `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\studio\agent\python-json.ts` and its spec, moved
  unchanged. It now has three consumers (agent, topology names, circuit inventory), and `topologies` must not import
  from `studio`, because `studio` imports `topologies`. The import path (and only the import path) is updated in
  `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\studio\agent\message-normalizer.ts`,
  `...\src\studio\agent\studio-system-prompt.ts` and `...\src\studio\agent\studio-agent.service.ts` (same folder). The only addition is an exported `PY_WHITESPACE` character-class string (the existing `PY_SPACE`).
- `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\common\python\python-semantics.ts` (+ spec): `pyTruthy(v)`
  (Python falsiness for decoded JSON: `null`, `false`, `0`, `-0`, `''`, `[]`, `{}`, plus `undefined`), `pyOr(a, b)`,
  `pyLowerStr(v)` (`str(v or "").lower()`), `pyStrKey(v)` (Python `str()` of a JSON scalar: `null`→`'None'`,
  booleans→`'True'`/`'False'`, numbers via `pythonNumber`, strings unchanged), `pythonRound(x, 6)` (section 1.4).
  `pyStrKey(v)`: `null` **or `undefined`** → `'None'` (Python `str(comp.get("ref"))` on a component without `ref`
  gives `"None"`, so an update row with `ref: "None"` applies to ref-less components; finding 6).
  `pyStrKey` accepts only `null`/`undefined`/boolean/number/string; callers never pass arrays or objects
  (`applyUpdates` filters them out first, 1.4).

### 1.2 Topology library: `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\topologies\`

File cells in the tables of 1.2-1.5 are relative to the module folder named in the heading.

| File | Contents |
|---|---|
| `topologies.module.ts` | `TopologiesModule`: controller `TopologiesController`; providers `TopologiesRepository`, `TopologiesService`; exports `TopologiesService`. |
| `topologies.controller.ts` | `@ApiTags('topologies') @ApiBearerAuth() @Controller('topologies')`. `@Get()` → `{ success: true, topologies: service.ids() }`. |
| `topologies.service.ts` | `ids(): readonly string[]`, `resolveId(name: string): string \| null`, `schematic(id): DeepReadonly<JsonObject>` (cached frozen object), `definition(id): JsonObject` (always a `structuredClone`, since callers mutate it). |
| `topologies.repository.ts` | `@Injectable() TopologiesRepository implements OnModuleInit`. `onModuleInit` awaits `loadTopologyCatalog(ASSETS_ROOT)` and logs `Loaded 35 topologies in <n> ms`. Exposes the `TopologyCatalog`. A throw aborts Nest bootstrap. |
| `topologies.types.ts` | `TopologyCatalog { ids: readonly string[]; definitions: ReadonlyMap<string, JsonObject>; schematics: ReadonlyMap<string, DeepReadonly<JsonObject>> }`; `JsonObject`/`JsonValue` re-exported (`export type`) from `src\ai\bedrock\bedrock.types.ts`; `export type DeepReadonly<T> = T extends readonly (infer U)[] ? ReadonlyArray<DeepReadonly<U>> : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;`; and the shared 404 factory `export function topologyNotFound(name: unknown): HttpException { const s = String(name ?? ''); return AppError.notFound(ErrorCode.TopologyNotFound, \`Topology '${s.length > 256 ? s.slice(0, 256) : s}' not found\`); }`. `CircuitInfoService` and `VisualizationService` both throw `topologyNotFound(...)`; there is no other truncate helper. |
| `dto\topology-list.dto.ts` | `TopologyListResponseDto { success: true; topologies: string[] }` (Swagger only). |
| `library\topology-catalog.loader.ts` | Pure `loadTopologyCatalog(root): Promise<TopologyCatalog>` (validation rules in 2.4). Used by the repository and directly by unit/parity specs. |
| `library\pyyaml-schema.ts` | `parsePyYaml(text, path): JsonValue` with PyYAML `SafeLoader` scalar semantics (section 2.5). |
| `library\topology-names.ts` | `TOPOLOGY_NAME_ALIASES` (`ReadonlyMap`, the 19 Python entries verbatim) and `resolveTopologyName(name, ids: ReadonlySet<string>): string \| null`, a port of `data_utils.get_builtin_topology_path` (section 1.5). |

### 1.3 Device library: `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\devices\`

| File | Contents |
|---|---|
| `devices.module.ts` | `DevicesModule`: controller `DevicesController`; providers `DevicesRepository`, `DevicesService`; exports `DevicesService` (select-devices and the loss engine use it later). |
| `devices.controller.ts` | `@ApiTags('devices') @ApiBearerAuth() @Controller('devices')`. `@Get()` with `@Query() ListDevicesQueryDto` → `{ success: true, models }`. `@Get('catalogue')` → `{ success: true, parts }`. |
| `devices.service.ts` | `models(kind: DeviceKind): readonly DeviceModelSummary[]`, `catalogue(): readonly CataloguePart[]`. Both are precomputed frozen arrays. |
| `devices.repository.ts` | `OnModuleInit` → `loadDeviceLibrary(ASSETS_ROOT)`; logs `Loaded 858 device models (596 usable) in <n> ms`. |
| `devices.types.ts` | `DeviceKind = 'mosfet' \| 'diode' \| 'igbt'`, `DEVICE_KINDS`, `MODEL_TYPES_BY_KIND` (`mosfet` → `['MOSFET with Diode']`, `diode` → `['Diode']`, `igbt` → `['IGBT']`), `DeviceModelSummary {part_number,type,v_rating,i_rating}`, `CataloguePart {part,type,kind,family,v_rating,i_rating,i_lut}`, `DeviceModel {path, stem, metadata, document}`. |
| `dto\list-devices.dto.ts` | `ListDevicesQueryDto { @IsIn(DEVICE_KINDS) kind!: DeviceKind }` (required) and `DeviceListResponseDto`. |
| `dto\device-catalogue.dto.ts` | `DeviceCatalogueResponseDto` (Swagger only). |
| `library\device-library.loader.ts` | Pure `loadDeviceLibrary(root)`: verify, parse, validate (2.4), then build `modelsByKind` and `catalogue`. |
| `library\part-ratings.ts` | Ports of `device_selection._voltage_from_part`, `_current_from_part` and `_family` (same regexes, `toUpperCase()`, `replace('DNX_', '')` only after upper-casing, Python `or` fallbacks). |

`models(kind)` ports `api_server._get_models_by_type`. It covers every library file whose stem does not end in
`_bodydiode` (case-insensitive) and whose `metadata.type` is in `MODEL_TYPES_BY_KIND[kind]`. Each entry is
`{part_number: stem, type, v_rating: metadata.voltage_rating_V ?? 0, i_rating: metadata.current_rating_A ?? 0}`,
sorted by `part_number` in code-unit order (the same as Python `sorted` for these BMP-only stems). `catalogue()` ports
`device_selection.catalogue` exactly. It skips `_bodydiode` stems and types outside
`{'MOSFET with Diode','IGBT','Diode'}`. `kind` is `diode` for `Diode` and `switch` otherwise. Then
`v_rating = voltageFromPart(stem) || Number(meta.voltage_rating_V || 0)`,
`i_lut = Number(meta.current_rating_A || 0)`, `i_rating = currentFromPart(stem) || i_lut`, and
`i_lut: i_lut || i_rating`. Order is by relative path, code-unit order (decision D19).

### 1.4 Circuit info: added to `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\studio\`

| File | Contents |
|---|---|
| `studio.module.ts` | Adds `imports: [AiModule, TopologiesModule]` and the provider `CircuitInfoService`. |
| `studio.controller.ts` | New handler `@Post('circuit-info') @HttpCode(HttpStatus.OK)` → `{ success: true, inventory: this.circuitInfo.inventory(dto) }`. The agent handler is unchanged. |
| `studio.types.ts` | Adds `CircuitInventory`, `InventoryComponent`, `InventoryMagnetic` (same keys as `qdonis\lib\studio\types.ts` `CircuitInventory`; every optional Python `None` is emitted as `null`, never `undefined`). |
| `dto\circuit-info.dto.ts` | `CircuitInfoRequestDto` (rules in 5.2). |
| `circuit\circuit-info.service.ts` | `@Injectable() CircuitInfoService`, using `TopologiesService`. `inventory(dto)` runs, in this order: "`topology_id` or `circuit`" check → `loadTopologyDict` → `assertInventoryInput` → `applyUpdates` → `circuitInventory` (rules below). |
| `circuit\circuit-inventory.ts` | Pure: `iterComponents`, `applyUpdates`, `circuitInventory`, `switchingFrequency`, `assertInventoryInput` (structure checks, 5.2). |
| `circuit\to-number.ts` | Pure port of `studio_circuit.to_number`. The regex is built from Python's whitespace class, not JS `\s` (they differ on U+001C–U+001F, U+0085 and U+FEFF): `new RegExp(\`^[${PY_WHITESPACE}]*([-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?)[${PY_WHITESPACE}]*(meg\|[fpnuµmkg])?\`, 'i')`, with `PY_WHITESPACE` imported from `src\common\python\python-json.ts`. Then the `_SI` table and `Number()` for the mantissa. Booleans, `null` and containers → `null`; numbers → themselves. Only strings reach the regex (Python's `str()` of a list or dict starts with `[` or `{`, which never matches, so containers → `null` is exact). A non-finite result (`'1e400'` → `Infinity`) is returned as is. |

Port rules for the circuit code (each is a Python behaviour the parity fixtures check):

- `load_topology_dict`: if `circuit` is an object and `pyTruthy(circuit.components)`, use `structuredClone(circuit)`
  (copies own enumerable properties only). Otherwise the catalog path is taken, guarded exactly like this
  (finding 3):
  ```ts
  const id = typeof dto.topology_id === 'string' ? this.topologies.resolveId(dto.topology_id) : null;
  if (id === null) throw topologyNotFound(dto.topology_id); // from src\topologies\topologies.types.ts
  yamlDict = this.topologies.definition(id); // fresh clone
  ```
  This covers a truthy `circuit` without truthy `components` combined with a `null`, missing or `''`
  `topology_id` (for example `{circuit: {name: "x"}}` or `{topology_id: "", circuit: {a: 1}}`): both pass the
  "topology_id or circuit" check and then get 404 `TOPOLOGY_NOT_FOUND`. Python parity: `resolve_yaml_path(None)`
  → `"None"` → not found → `FileNotFoundError` → 404. `resolveId` is never called with a non-string. The
  message is built by the shared `topologyNotFound` factory (1.2), which `VisualizationService` uses too.
- `assertInventoryInput(yamlDict)` runs on the loaded dict (user circuit or library clone) before any update.
  Walk: components in `yamlDict.components` are depth 1; items in a component's `internal` array are that
  component's depth + 1. Rules: any visited component at depth > 32 → 400; more than 10,000 visited components
  → 400; a component's `params` is valid when `!pyTruthy(params)` (absent, `null`, `[]`, `''`, `0`, `false`, `{}`;
  read as `{}` everywhere) or when it is a plain object; a truthy non-plain-object `params` (`[1]`, `'x'`, `5`,
  `true`) → 400. Every 400 is `VALIDATION_FAILED` with the component index path in the message (for example
  `components[2].internal[0].params must be an object`).
- `iter_components`: pre-order walk; yields `(comp, parentRef ?? null)`. Only arrays are iterated; non-array
  `components`/`internal` values and non-object items are skipped (Python iterates dict keys or characters and
  skips them, so the result is the same).
- `apply_updates`: rows where `pyTruthy(row.ref) && pyTruthy(row.param) && row.after !== null &&
  row.after !== undefined` build `updates[pyStrKey(ref)][pyStrKey(param)] = after` (Python
  `row.get("after") is not None`, so a row with no `after` key is skipped). A row whose `ref` or `param` is an
  array or object is skipped, and a component whose `ref` is an array or object matches no update (D23). For each component (pre-order), `updates[pyStrKey(comp.ref)]`
  is applied by assigning `params[param]`. When an update applies to a component whose `params` is falsy
  (absent, `null`, `[]`, `''`, `0`, `false`), `params` is first replaced by a fresh `{}` via
  `Object.defineProperty(comp, 'params', …)`; Python's `setdefault` returned the falsy value and crashed (500),
  D21. Components with falsy `params` and no matching update are left untouched. Writes use
  `Object.defineProperty` (enumerable, writable, configurable), so a key like `constructor` stays an own
  property. `__proto__` keys never arrive: the global `ValidationPipe` (`transform: true`) drops them before the
  service runs (D23, finding 1). `defineProperty` is kept as defense in depth for direct callers of the pure
  function. A new key is appended in insertion order, existing keys keep their position (same as Python
  `setdefault`).
- `circuit_inventory` (port of `CORE\qdonis_backend\studio_circuit.py:101-137`; exact rules, finding 2). For each
  `(comp, parent)` from `iterComponents(yamlDict.components)`:
  ```
  params = pyTruthy(comp.params) ? comp.params : {}
  skip comp iff comp.type === 'node'
           && !['voltage_source','current_source','pwm_control'].includes(params.node_type)
           // every other comp.type is kept whatever its node_type; a non-string node_type never matches
  key_params = Object.fromEntries(Object.entries(params).slice(0, 6)
                 .filter(([, v]) => !(v !== null && typeof v === 'object')))   // drops objects and arrays
  components.push({ ref: comp.ref ?? null, type: comp.type ?? null, role: comp.role ?? null,
                    inside: parent /* raw parent ref, or null at top level */, params: key_params })
  if (MAGNETIC_TYPES.has(comp.type))   // inductor, transformer, ct_transformer, dual_ct_transformer, coupled_inductor
    magnetics.push({ ref: comp.ref ?? null, type: comp.type, role: comp.role ?? null,
                     inductance: toNumber(params.inductance),
                     magnetizing_inductance: toNumber(params.Lm_primary),
                     turns_ratio: toNumber(params.turns_ratio),
                     coupling: toNumber(pyOr(params.k_coupling, params.coupling_coefficient)),
                     saturation_current: toNumber(params.saturation_current) })
  ```
  `input_voltage`: second pass over `iterComponents`; the first component with
  `params.node_type === 'voltage_source'` and `pyStr(comp.role ?? '').startsWith('input')` (Python
  `str(comp.get("role", ""))`; `pyStr` is `pythonStr` from `python-json.ts`. Python gives `"None"` for a `null`
  role and `pythonStr` gives `''`; neither starts with `input`, so the result is the same) gives
  `toNumber(pyOr(params.voltage, params.amplitude))`, then stop; none → `null`.
  Inventory key order is Nest's own insertion order: `id, name, components, magnetics, switching_frequency,
  input_voltage`, with `id = yamlDict.id ?? null`, `name = yamlDict.name ?? null` (raw values). Python's wire
  order is alphabetical (Flask sorts keys, section 8); the frontend does not depend on key order, and Nest must
  not sort to imitate it.
- `_switching_frequency` (`CORE\qdonis_backend\studio_circuit.py:82-98`). For each component:
  `params` as above; `role = pyLowerStr(comp.role)`; `nodeType = pyLowerStr(params.node_type)`;
  `weight = (nodeType.includes('pwm') || role.includes('pwm') || role.includes('carrier')) ? 2 : 1`.
  For each key of `frequency, fsw, switching_frequency, carrier_frequency, f_sw` in that order: `v = toNumber(params[key])`;
  if `pyTruthy(v) && v >= 1e3`, push `v` `weight` times. Period candidate iff
  `pyLowerStr(params.source) === 'pulse' || nodeType.includes('pwm')`: `period = toNumber(pyOr(params.per, params.period))`;
  if `pyTruthy(period) && 1e-8 < period && period <= 1e-3`, push `pythonRound(1 / period, 6)` `weight` times.
  Result: `null` when there are no candidates; otherwise the most frequent value, and on a tie the value whose
  first occurrence is earliest (D22).
- `pythonRound(x, 6)`: correctly rounded half-even on the exact decimal value of the double. Uses
  `x.toFixed(50)`, which is exact for 1e3 ≤ |x| < 1e21, the only range used here (`1/period` is between 1e3 and
  1e8), followed by decimal half-even rounding of that string and `Number(...)`. For other |x| it returns
  `Number(x.toFixed(6))`.

### 1.5 Visualization: `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\visualization\`

| File | Contents |
|---|---|
| `visualization.module.ts` | `VisualizationModule`: `imports: [TopologiesModule]`, controller, service. |
| `visualization.controller.ts` | `@ApiTags('visualization') @ApiBearerAuth() @Controller('visualization')`. `@Post() @HttpCode(HttpStatus.OK)` → `service.visualize(dto)`. |
| `visualization.service.ts` | `visualize(dto): VisualizationResponse`: `resolveId(dto.topology_name)`; `null` → `throw topologyNotFound(dto.topology_name)`; then the cached schematic. |
| `visualization.types.ts` | `VisualizationResponse { success: true; circuit_json: DeepReadonly<JsonObject>; tsx_code: string; metadata: {...} }` (`DeepReadonly`, `JsonObject` imported with `import type` from `src\topologies\topologies.types.ts`), `STATIC_TSX_PLACEHOLDER = '// TSX bypassed. Loaded from static JSON library.'` (the Python string verbatim). |
| `dto\visualize.dto.ts` | `VisualizeRequestDto` (5.2) and `VisualizationResponseDto` (Swagger). |

Response (status 200):
`{ success: true, circuit_json: <schematic>, tsx_code: STATIC_TSX_PLACEHOLDER, metadata: { topology: <resolved id>, elements_count: schematic.components.length, has_netlist: false, source: 'static_library' } }`.
There is no `netlist` key (section 3).

`resolveTopologyName(name, ids)` ports `get_builtin_topology_path`, but only checks catalog membership:

1. `base = pythonStrip(name)`; strip one trailing `.yaml` or `.yml`.
2. ``clean = pythonStrip(base.replace(new RegExp(`[${PY_WHITESPACE}]*\\([^)]*\\)`, 'gu'), ''))``.
3. `norm = clean.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_').replace(/_+/g, '_')`.
4. `target = ALIASES.get(norm) || ALIASES.get(base.toLowerCase()) || norm`;
   `key = target.endsWith('.yaml') ? target.slice(0, -5) : target`; if `ids.has(key)` return `key`. (Python appends
   `.yaml` only when `target_name` lacks it, so `dcdc_buck.yaml.yaml` → base `dcdc_buck.yaml` → file
   `dcdc_buck.yaml` → found; finding 8. The vector `dcdc_buck.yaml.yaml` → `dcdc_buck` is in `topology-names.json`.)
5. `orig = name.endsWith('.yaml') ? name.slice(0, -5) : name` (raw, unstripped, as Python); if `ids.has(orig)`
   return it. This step is what finds `acdc_single_phase_full_wave(transformer)`.
6. Otherwise `null`.

The function never touches the filesystem. Python's `resolve_yaml_path` also accepted any existing local path,
and `importlib` joins allowed `..` segments. Both are dropped (D18).

### 1.6 Route map (prefix `api/v1`, global `JwtAuthGuard`)

| Ledger row | Python route (core line) | Nest endpoint | Module | Success body | Ledger plan reconciled |
|---|---|---|---|---|---|
| 3 | `GET /api/topologies` (536) | `GET /api/v1/topologies` | topologies | `{success:true, topologies: string[35]}` | same as planned |
| 4 | `GET /api/models/mosfet` (576) | `GET /api/v1/devices?kind=mosfet` | devices | `{success:true, models:[{part_number,type,v_rating,i_rating}]}` (228) | same |
| 5 | `GET /api/models/diode` (593) | `GET /api/v1/devices?kind=diode` | devices | same shape (246) | same |
| 6 | `GET /api/models/igbt` (608) | `GET /api/v1/devices?kind=igbt` | devices | same shape (122) | same |
| 35 | `GET /api/studio/device-library` (2848) | `GET /api/v1/devices/catalogue` | devices | `{success:true, parts:[{part,type,kind,family,v_rating,i_rating,i_lut}]}` (596) | same; no FE call site yet |
| 31 | `POST /api/studio/circuit-info` (2656) | `POST /api/v1/studio/circuit-info` | studio | `{success:true, inventory:{id,name,components,magnetics,switching_frequency,input_voltage}}` | same |
| 7 | `POST /api/visualize` (623) | `POST /api/v1/visualization` | visualization | see 1.5 | changed: planned "static json_library + netlist; LLM fallback on shared Bedrock layer" becomes "static json_library, no netlist, no LLM fallback" (section 3) |

The counts in parentheses were measured on core `239d79a` with the Python functions (`catalogue()` returned 596:
246 Diode, 228 MOSFET with Diode, 122 IGBT). Nest `@Post` defaults to 201, so the two POST handlers set
`@HttpCode(HttpStatus.OK)` to keep Python's 200.

`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\app.module.ts` registers `TopologiesModule`, `DevicesModule` and
`VisualizationModule` next to `StudioModule`.

## 2. Asset copy plan

### 2.1 Measured source inventory (core `239d79a`)

Counted from `git ls-files` (with `core.quotepath=false`) and the directories under
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-core\qdonis_backend\data\`. In the table, "Source" is relative to
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-core\` and "Target" is relative to
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\`:

| Source (in core) | Count | Read by | Target (in BE) | Loaded at boot |
|---|---|---|---|---|
| `qdonis_backend\data\topologies\primitives\*.yaml` | 35 (`template.txt`, `__init__.py` not copied) | rows 31, 7 (id resolution), later 8-15, 33 | `assets\topologies\primitives\` | yes |
| `qdonis_backend\data\topologies\json_library\*.json` | 35 | rows 3, 7, agent ids, later 33 | `assets\topologies\json_library\` | yes |
| `qdonis_backend\data\models\library\diode\*.json` | 483 (237 `_bodydiode`) | rows 4-6, 35 | `assets\models\library\diode\` | yes |
| `qdonis_backend\data\models\library\igbt\*.json` | 122 | rows 4-6, 35 | `assets\models\library\igbt\` | yes |
| `qdonis_backend\data\models\library\mosfet\*.json` | 253 (228 `MOSFET with Diode`, 25 legacy `MOSFET`) | rows 4-6, 35 | `assets\models\library\mosfet\` | yes |
| `qdonis_backend\data\topologies\prompts\*.prompt.md` | 31 (none for 5 acdc ids; one orphan `dcdc_llc_resonant`) | later 8, 13 | `assets\topologies\prompts\` | no (manifest-verified by test) |
| `qdonis_backend\data\spice\spice_components.json` | 1 (28,219 B) | later netlist generation | `assets\spice\spice_components.json` | no |
| `qdonis_backend\data\mosfet_database.json` | 1 (5,193 B), read by `topology_improver.py:18` | later 8, 13 | `assets\mosfet_database.json` | no |
| `qdonis_backend\data\models\C3D10065A.json`, `E3M0060065K.json` | 2, read by `loss_engine.py:21` (`DEFAULT_PLECS_DIODE_MODEL`) | later loss engine | `assets\models\` | no |

Total: 963 files. The models library has no subdirectories, no duplicate stems, and all files are ASCII JSON.
128 stems contain spaces, and two stems contain U+00A0: `C4MS035075K1 \u00a0` (mosfet, a usable
`MOSFET with Diode` part that appears in `models` and `catalogue`) and `C4MS035075K1 \u00a0_bodydiode` (diode,
skipped as `_bodydiode`). Both are copied with their exact UTF-8 names; the manifest stores the path as a JSON
string, and the import script and loader compare paths as JS strings, never through a shell (finding 5). JSON-library stems equal
YAML stems exactly (35/35). None of the step-2 routes read `spice_components.json` or `mosfet_database.json`,
because the netlist is not part of this step. They and the two root model files are copied now so that no core
data is left untracked when core is deleted (new ledger rows; the ledger did not list the last three).

### 2.2 Byte-for-byte copy from git blobs, not the working tree

The core checkout has `core.autocrlf=true`. Its index holds LF files but its working tree holds CRLF
(`git ls-files --eol` → `i/lf w/crlf`). qdonis-backend also has `core.autocrlf=true` and no `.gitattributes`.
Copying the working tree would hash CRLF bytes that a Linux checkout never sees. So:

- Copy source = the blobs of commit `239d79a29c6fc6e97b2038aded19e5a71dbf1081` (`git cat-file blob <sha>`), not the
  files on disk.
- New file `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\.gitattributes` with `assets/** -text`, so no
  platform converts line endings and the bytes on every checkout equal the manifest.

Tool: `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\scripts\import-core-assets.mjs` (Node, next to the existing
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\scripts\serve-client.mjs`). Usage, run from
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend`: `node scripts/import-core-assets.mjs [--core <path>] [--check]`.
The default `--core` is `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-core`, computed as the sibling of the repo root
from the script location, so it does not depend on the shell's working directory. Output always goes to
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\assets\`. It runs `git` through `execFileSync` with argument arrays (no shell, no
interpolation) and `maxBuffer` 64 MB:

1. `git -C <core> rev-parse --verify 239d79a29c6fc6e97b2038aded19e5a71dbf1081^{commit}`; exit 2 if missing.
2. `git -C <core> ls-tree -r -z --full-tree <commit> -- <pathspecs>` with exactly these eight pathspecs (4
   directories, 4 files): `qdonis_backend/data/topologies/primitives`, `qdonis_backend/data/topologies/json_library`,
   `qdonis_backend/data/topologies/prompts`, `qdonis_backend/data/models/library`,
   `qdonis_backend/data/spice/spice_components.json`, `qdonis_backend/data/mosfet_database.json`,
   `qdonis_backend/data/models/C3D10065A.json`, `qdonis_backend/data/models/E3M0060065K.json`. Filters: `*.yaml` in
   primitives, `*.json` in json_library and models/library, `*.prompt.md` in prompts.
3. Assert the counts 35 / 35 / 31 / 483 / 122 / 253 / 4; any mismatch → exit 1 before writing.
4. For each blob: `git cat-file blob <sha>` → `assets/<path without "qdonis_backend/data/">`. If the target exists
   with the same SHA-256 it is skipped. If it exists with a different hash the script exits 1 and never
   overwrites.
5. Write `assets\MANIFEST.json` (2.3) with LF endings, entries sorted by path in code-unit order, no timestamp,
   so a re-run is byte-identical.
6. `--check`: recompute every hash in `assets\` against `MANIFEST.json` and the core blobs. Read-only. Exit 0 / 1.

The script reads core through git only and never writes there.

### 2.3 Manifest

`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\assets\MANIFEST.json`:

```json
{
  "source": {
    "repository": "qdonis-core",
    "commit": "239d79a29c6fc6e97b2038aded19e5a71dbf1081",
    "branch": "feature/chat-first",
    "root": "qdonis_backend/data"
  },
  "generatedBy": "scripts/import-core-assets.mjs",
  "files": [
    { "path": "models/library/diode/C3D02060A.json", "bytes": 1234, "sha256": "<64 hex>" }
  ]
}
```

`path` is relative to `assets/` with forward slashes. The source path is `root + "/" + path`. `MANIFEST.json` does
not list itself.

### 2.4 Boot loader and validator (all failures fatal)

Each repository's `onModuleInit` runs its pure loader. `loadVerifiedSubtree` (1.1) checks set equality, size and
SHA-256 first, then the loader parses and validates. Any failure throws `AssetValidationError`.
`onModuleInit` hooks run in `app.init()`, which `app.listen()` calls in `src\main.ts`, so `app.listen()` rejects
(`NestFactory.create` and `Test.createTestingModule().compile()` do not run the hooks). `bootstrap().catch` in
`main.ts` logs `Failed to start: Asset validation failed: <path>: <reason>` at error level and exits 1. In e2e
tests `app.init()` rejects. Unit/parity specs call the pure loaders directly. Nothing is partially loaded.

Topology catalog (`loadTopologyCatalog`), subtrees `topologies/primitives/` and `topologies/json_library/`:

- Only `*.yaml` files in primitives and `*.json` in json_library. The two stem sets are equal.
- Each YAML: UTF-8 without BOM (`TextDecoder('utf-8', {fatal: true})`). `parsePyYaml` returns a mapping, and
  `id === stem` (true for all 35). `components` is an array. Every component reached by `iterComponents` has
  `params` absent, `null` or a plain object. This boot rule is deliberately stricter than the request rule in
  1.4/5.2 (which also accepts `[]`, `''`, `0`, `false`): the library is fixed data and every library `params` is
  absent or a dict (measured), so any other value means corruption. `circuitInventory(definition)` runs once without throwing, which
  guarantees circuit-info cannot fail for a library id. Values are plain JSON only (2.5).
- Each schematic: strict UTF-8 JSON object with array `components` and array `wires`.
- `ids` = stems sorted in code-unit order (equal to Python `sorted()` for these ASCII ids). Definitions and
  schematics are deep-frozen (`Object.freeze` recursively).

Device library (`loadDeviceLibrary`), subtree `models/library/`:

- Every file is `<kind dir>/<stem>.json` with kind dir in `diode|igbt|mosfet`, and stems are unique across the
  library.
- Strict UTF-8 JSON object. `metadata` is a plain object, and `metadata.type` is one of `Diode`, `IGBT`,
  `MOSFET with Diode`, `MOSFET`. `voltage_rating_V` and `current_rating_A`, when present, are finite numbers ≥ 0.
  Python silently skipped unreadable files (`except: pass`). With verified fixed assets, a parse failure means
  corruption, so it is fatal.
- `modelsByKind` and `catalogue` are precomputed and frozen. Documents are kept in memory (about 3.2 MB of JSON)
  for the later loss engine and are not exposed in step 2.

The remaining subtrees (`topologies/prompts/`, `spice/`, `models/*.json` at the root, `mosfet_database.json`) are
not loaded at boot. `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\common\assets\manifest.spec.ts`
(section 8.2) verifies them; it lives under `src\` because Jest's unit `rootDir` is `src` (finding 4).

Rule: `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\assets\` contains only the 963 copied data files and
`MANIFEST.json`. No code, specs, README or other files go there; the manifest spec and
`import-core-assets.mjs --check` both fail on any extra file.

### 2.5 PyYAML-compatible YAML parsing (`library\pyyaml-schema.ts`)

PyYAML 6.0.3 `safe_load` implements YAML 1.1 with its own implicit resolvers. Measured on the 35 files: 768 plain
scalars like `1e5`, `10e-6`, `1e-12` have no dot, so PyYAML loads them as strings. `circuit-info` returns them
as strings (for example `"Is": "1e-12"` in `dcdc_buck`). Both YAML 1.2 and the stock `yaml` `yaml-1.1` schema
would turn them into numbers, which breaks parity. `parsePyYaml` therefore calls
`parseDocument(text, { version: '1.1', schema: 'yaml-1.1', merge: true, uniqueKeys: false, strict: true, prettyErrors: true, customTags })`,
throws on any entry in `doc.errors`, runs the key check below with `visit(doc, { Pair: … })`, and returns
`doc.toJS({ maxAliasCount: 100 })`. (`parse()` is not used: it stringifies map keys, so a bool/null/float key
could no longer be detected.)
`customTags` is a function that removes the base `bool`, `int`, `float`, `null` and `timestamp` scalar tags and adds
PyYAML-exact ones (they apply to plain scalars only; quoted scalars stay strings):

- bool `^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$` (no `y`/`n`).
- int `^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$`.
  Conversion as `SafeConstructor.construct_yaml_int`: drop `_`; sign; `0b` binary; `0x` hex; a leading `0` means
  octal; `:` means base 60. A result outside `Number.isSafeInteger` throws.
- float `^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$`
  (the dot is required and the exponent sign is required). Conversion as `construct_yaml_float`. A non-finite
  result throws, because JSON cannot carry it.
- null `^(?:~|null|Null|NULL|)$`.
- timestamp: PyYAML's timestamp regex; the resolver throws `unsupported YAML timestamp` (PyYAML would build a
  `datetime`; none occur in the assets).
- `uniqueKeys: false` keeps PyYAML's last-wins rule for duplicate keys. Merge keys `<<` are supported as in
  SafeLoader. Any resulting value that is not plain JSON (`Date`, `Map`, `Set`, `Uint8Array` from explicit
  `!!binary`/`!!set`/`!!omap`) makes validation fail.
- Mapping keys must be strings. Integer-like keys would reorder in JS objects and change the `[:6]` `key_params`
  selection, so a non-string or integer-like key is fatal. The check runs on the document AST:
  `visit(doc, { Pair: (_, pair) => … })` requires
  `isScalar(pair.key) && typeof pair.key.value === 'string' && !/^(0|[1-9][0-9]*)$/.test(pair.key.value)`,
  except merge keys (`<<`), and throws `AssetValidationError` naming the file and key otherwise. None occur in the
  35 files (measured).

## 3. The visualize / netlist decision

Decision D14: ship `POST /api/v1/visualization` now as a clean split. It returns the static json_library schematic
and no `netlist` field (`metadata.has_netlist: false`). It is not deferred to the netlist step, and no netlist is
faked.

### 3.1 What the frontend reads from the visualize response

Every reader of `visualizeCircuit()`'s result. Paths in this table and in 3.1-3.3 are relative to
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis\` (FE):

| Reader | Fields read | Live? |
|---|---|---|
| `lib\studio\stages.ts:396-398` `selectTopology` | stores the whole response as `VisualizationData.circuit`; reads `circuit.circuit_json` (`Array.isArray` → element count, which is `undefined` because the schematic is an object) | live (agent tool `select_topology`) |
| `components\studio\views\CircuitView.tsx:112-119` self-heal | `circuit_json` | live |
| `components\studio\views\CircuitView.tsx:142-143, 196-207` | `circuit_json`; passes `node.data.circuit` as `savedCircuitData` to `CircuitVisualizationScreen` with no `onNetlistGenerated` | live |
| `components\CircuitVisualizationScreen.tsx:285-293` | `circuit_json`, `tsx_code` | live (embedded editor) |
| `components\CircuitVisualizationScreen.tsx:269-270` | `netlist` → `onNetlistGenerated` | only when it fetches itself and a callback is given; Studio passes neither path (it always has `savedCircuitData`, and the editor button is disabled without a circuit) |
| `lib\studio\store.ts:537` | `!!vis.data.circuit` (`has_schematic`) | live |
| `lib\studio\persistence.ts:28-29, 71` | strips `tsx_code`; copies the response into `project_data.circuitVisualizationData` | live (save) |
| `App.tsx:5332` `onNetlistGenerated={setGeneratedNetlist}` → `NetlistInputScreen` prefill | `netlist` | legacy wizard only |
| `components\ProcessSummarySidebar.tsx:219, 563` | `circuitVisualizationData.netlist` (step tick and "Netlist available" label) | legacy wizard only |
| `services\stepSummaryService.ts:126` | `circuitVisualizationData.netlist` | legacy wizard only |
| `lib\studio\types.ts:98-99` | comment only ("circuit_json, netlist, metadata") | n/a |
| `types\stageContracts.ts:211` | lists `'/api/visualize'` in a static contract table; its `endpoints` field has no runtime reader (only `downstreamOf` is imported, by `lib\artifactStore.ts`) | n/a |
| `metadata.*` | no reader (only types in `services\circuitVisualizationService.ts:21-26`) | n/a |

The legacy wizard is not reachable for normal use. `App.tsx:2353-2367` opens every project in the Studio
(`openProjectInStudio`), new projects go to `setStudioSession` (`App.tsx:1935`), and `App.tsx:5780` returns
`StudioShell` before the wizard switch. The admin read-only view renders the wizard with persisted
`circuitVisualizationData`; it never calls visualize when saved data exists. Studio stages that need decks get them
from `/api/simulate/prepare` (`stages.ts:527-537`), not from the visualization artifact. The agent snapshot sends
only `has_schematic`.

So the fields the live frontend uses are `circuit_json` and `tsx_code` (plus the presence of the whole object).
`netlist` is read only by legacy-wizard code.

### 3.2 Why a split and not deferral

Deferring would keep the most-used stage tool (`select_topology`, plus the self-heal) on core, and core cannot be
deleted until the 4k-line netlist generator is ported, all for a field no live path reads. A split removes that
dependency now and invents nothing. Omitting the key is the cleanest signal: every reader uses truthiness
(`response.netlist && …`, `!!…netlist`), the TS type is `netlist?: string`, and `has_netlist: false` states the
truth. `netlist: ""` is what Python sends when generation fails, so it would misreport a failure.

Accepted consequences, to record in the ledger: projects visualized through Nest persist
`circuitVisualizationData` without `netlist`. In the admin legacy view, `ProcessSummarySidebar` then shows no
"Netlist available" label and does not tick `circuit_design` from it. The legacy wizard's netlist prefill gets
nothing when it runs against Nest. `VITE_STAGE_BACKEND=core` restores the Python behaviour. The netlist step will
not add the field back to `/visualization`. If a consumer appears, it gets its own route.

### 3.3 LLM fallback reachability

`api_server.py:675-677` checks `json_library/<raw topology_name>.json`, while the YAML was resolved through
aliases and normalization (`data_utils.get_builtin_topology_path`).

- For the 35 canonical ids the fallback is unreachable: every id that resolves to a YAML has a JSON with the same
  stem (35 = 35, measured).
- It is reachable for non-canonical names that still resolve to a YAML: aliases (`buck`, `push_pull`, `dab`),
  `dcdc_buck.yaml`, padded or mixed-case names (`' dcdc_buck '`; `DCDC_BUCK` on Linux only, because Windows
  lookups ignore case), names with parenthesised acronyms, and arbitrary local file paths. The live Studio sends
  canonical ids: the agent's `select_topology`/`import_netlist` schema is an enum of the ids
  (`studio-tools.ts:49-51, 269, 335`), the picker uses `/topologies`, and `mapTopologyNameToBackend` passes ids
  through. The off-enum path, a model ignoring the enum and the FE normalizer producing for example `push_pull`,
  could reach it.
- Nest handling (D15): there is no LLM fallback. The name resolves to a canonical id with the same rules
  (1.5), and the response is that id's static schematic, so `buck` gets the drawn `dcdc_buck` schematic instead of
  an LLM drawing. Anything that does not resolve gets 404 `TOPOLOGY_NOT_FOUND`, which is the Python behaviour too,
  since Python 404s before the fallback. No Bedrock call, no charge, no netlist.

Verifiable evidence (spec `visualization.parity.spec.ts`, section 8): for all 35 ids the captured Python body has
`metadata.source === 'static_library'` and `fallback_reached === false`. The Nest body deep-equals the Python
body after removing `netlist` and with `has_netlist` replaced by `false`. For the captured alias inputs Python
reports `fallback_reached === true` (the capture replaces `generate_fallback_json` with a sentinel that raises),
and Nest returns the canonical schematic.

## 4. Replacing `topology-library.ts` with the catalog

- Delete `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\studio\agent\topology-library.ts`.
- `StudioAgentService` (`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\studio\agent\studio-agent.service.ts`) constructor becomes `(ai: AiService, bedrock: BedrockClient, topologies: TopologiesService)`.
  `runStep` passes `topologyIds: this.topologies.ids()` where it passed `STUDIO_TOPOLOGY_IDS`.
  `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\studio\agent\studio-request.builder.ts`,
  `...\src\studio\agent\studio-system-prompt.ts` and `...\src\studio\agent\studio-tools.ts` keep taking ids as a
  parameter and are unchanged, apart from the `python-json` import path in `studio-system-prompt.ts` (1.1;
  finding 7).
- Byte identity: `ids()` is the code-unit sort of the json_library stems in `assets\`, which are byte copies of
  the core files `list_builtin_topologies()` lists, and Python `sorted()` gives the same order for ASCII. Same list
  in the same order gives the same `## Topology library` line and the same `enum` in the three tools.
- `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\studio\agent\studio-request.parity.spec.ts`: the test
  "uses the same topology library as the core" becomes
  `expect([...(await loadTopologyCatalog(ASSETS_ROOT)).ids]).toEqual(loadTopologyIds())` against the existing
  `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\test\parity\fixtures\studio-agent\topology-ids.json`. A new assertion checks that `buildStudioSystemPrompt`
  and `buildStudioTools` give identical output for fixture 01 with catalog ids and with `fixture.topology_ids`.
  The 16 fixture tests are unchanged and must stay green.
- `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\studio\agent\studio-agent.service.spec.ts`: pass `{ ids: () => loadTopologyIds() } as unknown as TopologiesService`, and add
  one assertion that the request's system text contains the catalog line.
- The step-1 e2e (`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\test\studio.e2e-spec.ts`) boots `AppModule`, so it runs against the real catalog unchanged.

## 5. Auth, validation and error handling

### 5.1 Auth

All seven endpoints are protected by the global deny-by-default `JwtAuthGuard` with a Bearer access token. No
`@Public()` route: every caller (Studio, the legacy `SimulationScreen`) runs signed in. The device library and
schematics are product data, and Python exposing them without auth is a ledger section 5 issue. No `@Roles()`.
The global `ThrottlerGuard` default (100 requests / 60 s) applies, which is well above the frontend's use (4 catalog
GETs per screen, 2 POSTs per topology selection). Nothing is charged; there is no LLM.

### 5.2 External inputs

| Input | Rule | On failure |
|---|---|---|
| `GET /devices` `kind` (query) | required; `@IsIn(['mosfet','diode','igbt'])`; no other query keys (`forbidNonWhitelisted`) | 400 `VALIDATION_FAILED` |
| `POST /visualization` `topology_name` | required string, 1..256 chars | 400 `VALIDATION_FAILED` (Python: 400 when missing or falsy; 404 `Topology '5' not found` for non-string truthy values such as `5`, `true`, `[1]`, because `resolve_yaml_path` applies `str()` first. Nest's 400 for those is a recorded deviation, D21) |
| `POST /visualization` `parameters` | optional object (`@IsOptional() @IsObject()`); accepted and ignored, as on Python's static path | 400 if not an object |
| `POST /visualization` unknown keys | rejected | 400 |
| `POST /studio/circuit-info` `topology_id` | optional string ≤ 256 (`null` allowed) | 400 |
| `POST /studio/circuit-info` `circuit` | optional plain object (`null` allowed); content free-form, checked by the service | 400 |
| `POST /studio/circuit-info` `recalculated_parameters` | optional array ≤ 2,000 items, each an object (`@IsObject({each: true})`); `null` allowed | 400 (Python: 500 on non-dict rows) |
| neither a non-empty `topology_id` nor a truthy `circuit` | service check, message `topology_id or circuit is required` | 400 `VALIDATION_FAILED` (Python 400) |
| truthy `circuit` without truthy `components`, and `topology_id` missing / `null` / `''` / unresolved | service check (1.4 `load_topology_dict` guard) | 404 `TOPOLOGY_NOT_FOUND`, message `Topology '<id or empty>' not found` (Python 404) |
| `circuit` structure, when used | `assertInventoryInput` (1.4): top-level components are depth 1, `internal` items are their parent's depth + 1, any visited component at depth > 32 rejected; ≤ 10,000 components visited; `params` valid when `!pyTruthy(params)` (absent, `null`, `[]`, `''`, `0`, `false`, `{}`; read as `{}`) or a plain object; a truthy non-object `params` rejected | 400 `VALIDATION_FAILED` with the component index path (Python: 500 for truthy non-dict `params` / `RecursionError` for deep nesting; Python 200 for falsy `params`, and Nest matches) |
| whole body | `BODY_LIMIT` (existing) | 413 `PAYLOAD_TOO_LARGE` |

Ownership of invariants:

- Request shape belongs to the DTOs and `ValidationPipe`, because that is where the existing global pipe enforces
  it.
- "`topology_id` or `circuit`" and the circuit structure belong to `CircuitInfoService`: they depend on Python
  truthiness and the walk, which the DTO cannot express.
- "Cached catalog objects are never mutated" belongs to `TopologiesService`: `definition()` returns a clone, and
  the cached objects are deep-frozen, so a bug throws instead of corrupting shared state.
- "Assets equal the manifest" belongs to the loaders, at boot.

### 5.3 Failure table

| Operation | Condition | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| Boot: catalog / device load | manifest missing or unparsable, file missing or extra, size or SHA-256 mismatch, invalid UTF-8, YAML/JSON parse error, rule violation (2.4) | fatal (process exits 1) | n/a, the app never listens | `error`: `Failed to start: Asset validation failed: <path>: <reason>` (main.ts) |
| `GET /topologies`, `GET /devices`, `GET /devices/catalogue` | none at runtime (in memory); bad `kind` | yes | 200 / 400 envelope | 4xx at `warn` by `AllExceptionsFilter` |
| `POST /visualization` | name does not resolve | yes | 404 `{code: 'TOPOLOGY_NOT_FOUND', message: "Topology '<name>' not found"}` (name truncated to 256) | `warn` |
| `POST /studio/circuit-info` | missing inputs / bad structure / unknown id | yes | 400 `VALIDATION_FAILED` / 404 `TOPOLOGY_NOT_FOUND` | `warn` |
| any of the above | unexpected exception (a bug) | yes (per request) | 500 `INTERNAL_ERROR`, generic message, no exception text (unlike Python's `str(e)` / traceback) | `error` with stack |
| any route | missing or expired token | yes | 401 `UNAUTHENTICATED` / `ACCESS_TOKEN_EXPIRED` | `warn` |

New error code: `TopologyNotFound: 'TOPOLOGY_NOT_FOUND'` in
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\common\errors\error-codes.ts`, thrown with
`AppError.notFound`. Error bodies are the standard Nest envelope. The frontend's Nest branch uses `apiRequest`,
which reads `message`.

## 6. Frontend flag `VITE_STAGE_BACKEND`

Paths in this section that are not written in full are relative to `d:\1. TailorFlowAI Work\Qdonis v2\qdonis\` (FE).

One flag for every migrated stage/catalog route: `nest` (default, or unset) or `core`. Step 1's
`VITE_STUDIO_AGENT_BACKEND` stays separate and unchanged, so the agent can be switched alone.

- New `d:\1. TailorFlowAI Work\Qdonis v2\qdonis\services\api\stageBackend.ts`: header comment documenting the flag,
  and `export const STAGE_BACKEND: 'nest' | 'core' = import.meta.env.VITE_STAGE_BACKEND === 'core' ? 'core' : 'nest';`.
- `d:\1. TailorFlowAI Work\Qdonis v2\qdonis\src\types\global.d.ts`: add `readonly VITE_STAGE_BACKEND?: 'nest' | 'core';` to `ImportMetaEnv`.
- `d:\1. TailorFlowAI Work\Qdonis v2\qdonis\services\circuitVisualizationService.ts`. Import `apiRequest` only; the
  local core `API_BASE_URL` constant is not shadowed. When `STAGE_BACKEND === 'nest'`:
  - `getAvailableTopologies` → `apiRequest<{success: boolean; topologies: string[]}>('/topologies')`, return `topologies`; errors are rethrown as today.
  - `getAvailableMosfets` / `Diodes` / `Igbts` → `apiRequest('/devices', { query: { kind } })`, return `models`; `[]` on error as today.
  - `visualizeCircuit` → inside the existing retry/timeout loop, `apiRequest<CircuitVisualizationResponse>('/visualization', { method: 'POST', body: request, signal: controller.signal })`. `ApiError.message` becomes the thrown error text.
  The `core` branches are today's code, unchanged.
- `d:\1. TailorFlowAI Work\Qdonis v2\qdonis\lib\studio\stages.ts` `fetchInventory` → in `nest` mode
  `apiRequest<{success: boolean; inventory: CircuitInventory}>('/studio/circuit-info', { method: 'POST', body: { topology_id, circuit, recalculated_parameters } })`,
  keeping `try/catch → null`.
- Comment fixes only: `d:\1. TailorFlowAI Work\Qdonis v2\qdonis\lib\studio\agent.ts` header line "Stage tools (./stages) always use qdonis-core" becomes
  "use qdonis-core except the routes behind VITE_STAGE_BACKEND", and
  `d:\1. TailorFlowAI Work\Qdonis v2\qdonis\lib\studio\types.ts:98` notes that
  `netlist` is present only from core.
- `apiRequest` adds the Bearer token, `credentials: 'include'`, a single-flight refresh and a retry on 401 (it calls
  `refreshSession()`, so it does not repeat step 1's follow-up 3). Every other core call (`/health`, simulate,
  edit-circuit, select-devices, waveform-stats, the assistant) is untouched. Not added to any `.env`. One-off
  override: `$env:VITE_STAGE_BACKEND='core'; npm run dev`.

## 7. Environment variables and dependencies

- Backend: none. The assets path is derived from the code location (D16); a deployment ships `assets\` next to
  `dist\` and boot fails loudly otherwise. `EnvironmentVariables`, `configuration.ts` and `.env.example` are
  unchanged. No new secrets, so no new pino redact paths.
- Storage (AGENTS.md "Storage"): step 2 writes no user data. At runtime it reads only the read-only reference
  assets shipped in `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\assets\` (the case AGENTS.md allows). No
  Supabase, S3 or Prisma access. Dev-time writes go only to `assets\` (import script) and
  `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\test\parity\fixtures\catalog\` (capture).
  `src\common\assets\asset-manifest.spec.ts` creates temp dirs under `os.tmpdir()` and removes them in `afterEach`.
- Frontend: `VITE_STAGE_BACKEND` (optional, build-time, not secret).
- New backend dependency: `yaml` `2.9.1`, exact (`npm install yaml@2.9.1 --save-exact`), changing `package.json`
  and `package-lock.json`.

## 8. Testing

Comparison rule (applies to 8.1-8.4): core runs Flask 3.1.3, whose default JSON provider sorts keys
(`sort_keys=True`, not overridden in `api_server.py`). All Python↔Nest body comparisons are therefore `toEqual`-style
deep equality that ignores object key order (arrays stay order-sensitive). Order-sensitive key checks apply only
where Python's order is observable before serialisation: `yaml-safe-load.json` (dumped with `json.dumps` without
`sort_keys`) and the `[:6]` `key_params` selection, which is checked by the selected key set.

Non-finite rule: every fixture file encodes non-finite floats as `{"$float": "inf" | "-inf" | "nan"}` (the
capture uses a custom `json.dumps` `default`/pre-walk; `allow_nan=False` guards against a miss). The spec loader
decodes them to `Infinity`/`-Infinity`/`NaN` for pure-function vectors (`to-number.json`, `pyyaml-scalars.json`).
For HTTP-level comparisons a decoded non-finite Python value is expected as `null` on the Nest side (D23).

### 8.1 Python capture (while core exists)

New `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\test\parity\capture\catalog_capture.py`, documented in
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\test\parity\capture\README.md`. Run it with
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-core\.venv\Scripts\python.exe -B` and `--core` (default
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-core`, resolved from the script location), like step 1.

- `sys.dont_write_bytecode = True` and `sys.path.insert(0, core)`.
- Import `qdonis_backend.api_server` with `threading.Thread.start` patched to a no-op during the import, so the
  TSX warm-up thread does not run.
- Patch `qdonis_backend.simulator.generate_spice_netlist` to return `"<netlist omitted by capture>"`, and
  `qdonis_backend.tsx_formatter.generate_fallback_json` to raise `RuntimeError('CAPTURE_FALLBACK_REACHED')`. No
  LLM call, no ngspice.
- Use `api_server.app.test_client()` for exact wire bodies.

Outputs go to `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\test\parity\fixtures\catalog\`, deterministic, no
timestamps:

- `topologies.json`, `models-mosfet.json`, `models-diode.json`, `models-igbt.json`, `device-library.json`: status + body.
- `visualize.json`: for the 35 ids plus inputs from `inputs.json` (`buck`, `push_pull`, `dcdc_buck.yaml`, `' dcdc_buck '`,
  `Dual Active Bridge (DAB)`, `DCDC_BUCK`, `acdc_single_phase_full_wave(transformer)`, `dcdc_llc_resonant`, `nope`,
  missing name): `{name, request, status, body | {error}, fallback_reached}`. `traceback`/`details` are dropped, so
  no local paths are stored. `platform` is recorded.
- `circuit-info.json`: the 35 ids; `dcdc_buck` with realistic `recalculated_parameters` (existing key, new key,
  `after: null`, numeric ref); an edited `dcdc_buck` circuit with a nested `internal` RC snubber; a circuit whose
  candidates tie; `{}` (400); unknown id (404); alias `buck`; `{circuit: {name: "x"}}` (404) and
  `{topology_id: "", circuit: {a: 1}}` (404) (finding 3); an update row with `ref: "None"` against a circuit
  containing a ref-less component (finding 6); a circuit with a non-`node` component whose `params.node_type` is
  `"foo"` (kept) and a `node` with `node_type: "foo"` (skipped), a magnetic with `coupling_coefficient` only, and a
  `source: "PULSE"` component; a circuit with a component whose `params` is `[]` and no update (Python 200,
  inventory `params: {}`); the same circuit plus an update row targeting that component (Python 500; Nest 200 with
  the value applied, recorded as an expected deviation in the fixture, `nest_expected_status: 200`, D21); a
  component with `params: {inductance: "1e400"}` on an inductor (non-finite magnetics value; Nest `null`, D23);
  `dcdc_buck` with a `recalculated_parameters` row `{ref: "<existing ref>", param: "<existing key>"}` and no
  `after` key (expected inventory equals the unmodified `dcdc_buck` inventory).
- `yaml-safe-load.json`: `yaml.safe_load` of each of the 35 YAMLs, dumped with `json.dumps(ensure_ascii=False)`
  (key order preserved).
- `pyyaml-scalars.json`: `safe_load` of a synthetic document with the plain scalars `1e5 1.0e5 1.0e+5 1e-5 1.5e-5 .5 1. +1 -0 010 08 0o10 0x1F 0b101 1_000 1:30 1:30.5 yes no on off y n ~ null '' .inf -.inf`.
  Non-finite values use the `$float` encoding above.
- `topology-names.json`: about 40 inputs → `Path(get_builtin_topology_path(x)).stem` or `null`, including
  `dcdc_buck.yaml.yaml` → `dcdc_buck` (finding 8).
- `to-number.json`: about 40 inputs (`47u`, `4.7e-5`, `100 kHz`, `1MEG`, `1M`, `1meg`, `2.2µ`, `1e400`, `''`, `true`, `null`, `[1]`, ` 12 V`, `-3.3m`, `'\u001c1k'` → `1000`, `'\ufeff1'` → `null`, …) →
  output (`1e400` → `{"$float": "inf"}`).

Core is only imported. `git -C <core> status --porcelain` must be unchanged before and after.

### 8.2 Unit and parity specs (`npm test`, no core, no DB)

Spec paths in this section are relative to `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\` (BE); all live under
`src\` (Jest unit `rootDir`). Fixtures are read from `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\test\parity\fixtures\catalog\`.

- `src\common\assets\asset-manifest.spec.ts`: temporary directories. Missing file, extra file, size mismatch, hash
  mismatch and missing manifest each throw `AssetValidationError` naming the path.
- `src\common\assets\manifest.spec.ts` (real `assets\`): the manifest lists exactly the 963 files on disk, every
  hash matches, the per-folder counts are 35/35/31/483/122/253 + 4, and `source.commit` is the full SHA.
- `src\topologies\library\pyyaml-schema.spec.ts`: `pyyaml-scalars.json` deep-equal (finite values); timestamps,
  non-finite values, and integer-like (`1:`), bool (`yes:`), null (`~:`) and float (`1.5:`) keys throw; a quoted
  `"yes":` key and a `<<` merge key are accepted.
- `src\topologies\library\topology-catalog.parity.spec.ts`: for each of the 35 YAMLs, `parsePyYaml` deep-equals
  `yaml-safe-load.json` with the same key order at every mapping. The loader rejects a temporary copy with a
  missing JSON partner, a mismatched `id`, or bad `params`.
- `src\topologies\library\topology-names.spec.ts`: `topology-names.json` vector. Path inputs (`../json_library/dcdc_buck`,
  an absolute path) → `null`. `constructor`/`__proto__` → `null`.
- `src\devices\library\device-library.parity.spec.ts`: `models(kind)` deep-equals the three captured bodies'
  `models` (228/246/122) and `catalogue()` deep-equals `device-library.json` `parts` (596), in order. Explicit
  row (finding 5): `models('mosfet')` and `catalogue()` each contain exactly one entry whose `part_number` / `part`
  is `'C4MS035075K1 \u00a0'` (type `MOSFET with Diode`), and no entry for `'C4MS035075K1 \u00a0_bodydiode'`.
- `src\studio\circuit\to-number.spec.ts`, `src\common\python\python-semantics.spec.ts` (`pythonRound` half-even at an
  exact tie, `pyTruthy` table).
- `src\studio\circuit\circuit-info.parity.spec.ts`: every `circuit-info.json` case through `CircuitInfoService`
  with a real catalog. 200 bodies deep-equal (key-order-insensitive; non-finite Python values expected as `null`
  after a `JSON.parse(JSON.stringify(...))` round trip of the Nest result). Error cases have the same status class,
  except cases carrying `nest_expected_status`, which assert that status instead. The tie case asserts D22.
  The cached definition is unchanged after a request with updates.
- `src\visualization\visualization.parity.spec.ts`: section 3.3 evidence.
- Updated step-1 specs: section 4. The moved `python-json.spec.ts` stays green.

### 8.3 E2E (`npm run test:e2e`, against `qdonis_e2e`)

New `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\test\catalog.e2e-spec.ts`, booting `AppModule` the same way as
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\test\studio.e2e-spec.ts`:

- Each of the 7 endpoints returns 401 without a token.
- With a token: 200 and the fixture bodies for `/topologies`, `/devices?kind=*`, `/devices/catalogue`.
  `/visualization` for `dcdc_buck` has status 200 (not 201), no `netlist` key and `has_netlist: false`.
  `/studio/circuit-info` for `dcdc_buck` has status 200.
- `kind=foo` and a missing `kind` return 400; `/visualization` with `{}` or `{topology_name: 5}` returns 400; `nope`
  returns 404 `TOPOLOGY_NOT_FOUND`.
- `/studio/circuit-info` with `{}` returns 400, unknown id 404, `params: [1]` 400. `params: []` returns 200 with
  `params: {}` for that component, and with an update row targeting it returns 200 with the value applied. Depth:
  a chain of 33 nested levels (the deepest component at depth 33) returns 400; 32 levels returns 200.
- `/studio/circuit-info` with `{circuit: {name: "x"}}` returns 404 `TOPOLOGY_NOT_FOUND` (finding 3).
- Prototype keys (finding 1, D23). The request is sent as a raw JSON string so `__proto__` is an own key on the
  wire: `circuit` contains a component with `params: {"__proto__": {"polluted": true}, "r": 1}`, and
  `recalculated_parameters` contains `{ref: <that ref>, param: "__proto__", after: {"polluted": true}}` and
  `{ref: <that ref>, param: "constructor", after: 5}`. Assertions: status 200;
  `({} as Record<string, unknown>).polluted === undefined`; no returned `inventory.components[i].params` has an
  own `__proto__` key (`Object.prototype.hasOwnProperty.call(params, '__proto__') === false`); and
  `constructor` comes back as an own key of that component's `params` with value `5`.
- The no-charge check: the user's balance is unchanged after all calls.

The existing auth, billing, ai and studio suites stay green.

### 8.4 Live and frontend checks

- Build with `nest build`, start Nest from `dist` on port 3100 (shell-only `PORT`), and start core on port 5101
  (the user's :3000 / :5001 / :5173 servers are not touched). For the 7 routes, compare the live bodies with the
  key-order-insensitive rule above; for `/visualization`, minus `netlist` and `has_netlist`. Stop both afterwards.
- Frontend: `npx tsc --noEmit -p tsconfig.json` shows the same error count as the baseline (398 in step 1) and 0 in
  the changed files. `npm run build` passes (with `NODE_OPTIONS=--max-old-space-size=8192`, as in step 1).
  Manual browser steps are documented in the report (select a topology, check that `/api/v1/visualization` and
  `/api/v1/studio/circuit-info` carry Bearer, open the picker, run magnetics; then repeat with
  `VITE_STAGE_BACKEND=core`).

Implementation order, so the user's running `start:dev` never boots without assets: (1) `.gitattributes`, import
script, `assets\` + manifest; (2) `yaml` dependency; (3) shared helpers and the move of `python-json.ts`; (4) the
modules; (5) the step-1 wiring; (6) capture, specs and e2e; (7) the frontend.

## 9. Decisions (to copy into ledger section 7)

- D14 `/visualization` ships without `netlist` (`has_netlist: false`). No live frontend path reads the netlist
  (3.1). The legacy wizard and admin-view labels lose it in `nest` mode.
- D15 There is no LLM fallback. Names resolve through Python's alias and normalization rules to a canonical id and
  return that static schematic; unresolved names get 404. `metadata.topology` is the resolved id (Python echoed the
  raw name; they are identical for canonical ids).
- D16 Assets live in `qdonis-backend\assets\`, located from the code path, with no env var. They are copied from
  git blobs at `239d79a` and protected by `.gitattributes -text`.
- D17 YAML is parsed with PyYAML-exact scalar resolution (`yaml@2.9.1` with custom tags). Strings like `1e5` stay
  strings.
- D18 Topology lookup is catalog-only. Python accepted local file paths and `..` joins (`resolve_yaml_path`,
  `get_builtin_topology_path`) and on Windows matched case-insensitively; Nest resolves only exact catalog ids
  after normalization.
- D19 Device lists are deterministic: `models` sorted by `part_number` (as Python), `catalogue` sorted by
  relative path. Python's catalogue followed `rglob` order, which was alphabetical on Windows (matches) and
  filesystem order on Linux (undefined).
- D20 Asset errors are fatal at boot. Python skipped unreadable model files per request.
- D21 Error bodies are the Nest envelope with codes (`VALIDATION_FAILED`, `TOPOLOGY_NOT_FOUND`, `INTERNAL_ERROR`)
  instead of `{success: false, error: str(e)}` with tracebacks. Malformed circuits get 400 where Python gave 500.
  For falsy `params` (`null`, `[]`, `''`, `0`, `false`) on an updated component, Nest creates the object and
  applies the update where Python crashed (500); without an update both read it as `{}` (200). A non-string
  truthy `topology_name` on `/visualization` gets 400 where Python gave 404. Also: non-string `topology_id`,
  non-object `circuit`, and non-object `visualization.parameters` get 400 (Python ignored them or fell through).
  Circuits deeper than 32 levels or with more than 10,000 components get 400 (Python accepted them up to its
  recursion limit). A non-array `components` gives an empty inventory (Python 500). The frontend sends none of
  these shapes.
- D22 On a switching-frequency tie, Nest picks the first candidate in insertion order. Python picked by `set`
  iteration order. No library topology has a tie (measured).
- D23 Known small deviations, all edge cases: `to_number` parses ASCII digits only (Python `\d` is Unicode).
  Integer-like keys inside a user-supplied `circuit` keep JS object order. A JSON `1.0` ref is compared as `"1"`.
  Keys named `__proto__` in request bodies are dropped by the global `ValidationPipe` (class-transformer
  `plainToInstance`, `transform: true` in `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\app.module.ts`)
  before the service runs, and by the `instanceToPlain` response interceptor on the way out. Python kept them as
  ordinary keys, so for such a `params` object Python's `[:6]` `key_params` slice could include `__proto__` where
  Nest's includes the next key instead. No prototype is ever polluted (asserted in 8.3).
  A non-finite inventory number (for example `to_number('1e400')`) serialises as `null` in Nest; Python emitted
  the invalid JSON token `Infinity`. `to_number` uses Python's whitespace set (not JS `\s`), so the only remaining
  regex difference is ASCII-only digits. Response key order is Nest insertion order; Python's was alphabetical
  (Flask `sort_keys`). Non-scalar update keys never match (Python matched them via `str()` repr, e.g. `"[1]"`).
- D12 (step 1, static ids) is superseded: ids come from the catalog.

Ledger updates the implementation step must make:

- Rows 3, 4, 5, 6, 7, 31 and 35 move to `done` with evidence. Row 7's plan text changes per D14/D15.
- Section 2: primitives, json_library, prompts, the device library and `spice_components.json` become `done (copied)`;
  add rows for `mosfet_database.json` and `models/{C3D10065A,E3M0060065K}.json`.
- Section 4: `pyyaml` → `yaml 2.9.1` becomes `done`.
- Section 5: add the D18 path traversal, the raw-name static lookup that sends aliases to the LLM, the swallowed
  model parse errors and the filesystem-order catalogue.
- Section 7: add D14-D23.
- Section 8: add the step-2 counts, and a checklist item to remove the `VITE_STAGE_BACKEND=core` branches before
  core deletion.

## 10. Out of scope

`/api/studio/edit-circuit` (it will reuse `TopologiesService.schematic/definition`), `/api/studio/select-devices`
(it will reuse `DevicesService`), `/api/studio/waveform-stats`, all `/api/simulate*`, `/api/netlist/ai-fix`,
`/api/design/modify-netlist`, the jobs infrastructure, netlist generation, `/health` probes (the frontend's
`checkBackendHealth` in `CircuitVisualizationScreen.tsx` still pings core; ledger row 1), the legacy assistant,
removing the legacy wizard, caching headers, and any `.env` change. Frontend project persistence
(`d:\1. TailorFlowAI Work\Qdonis v2\qdonis\lib\studio\persistence.ts`, Supabase Storage) is unchanged by this step;
moving it off Supabase belongs to a later step.

## Responses to review findings

### Round 3 (revision 3, approved)

| # | Severity | Response | Where |
|---|---|---|---|
| 1 | MEDIUM | Addressed. `apply_updates` requires `row.after !== null && row.after !== undefined` (Python `is not None`); fixture row without `after` added. | 1.4, 8.1 |
| 2 | NIT | Addressed. D21 lists the extra request-shape deviations. | D21 |
| 3 | NIT | Addressed. `pyStrKey` is scalars-only; non-scalar `ref`/`param` rows are skipped and non-scalar component refs match nothing; D23 notes it. | 1.1, 1.4, D23 |
| 4 | NIT | Addressed. 1.5 step 2 uses `new RegExp(...)` built from `PY_WHITESPACE`. | 1.5 |

### Round 2 (revision 2)

Review: `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\.agents\migration\step2-design-review.md` /
`step2-design-review.json` (same folder), CHANGES_REQUESTED, 0 HIGH / 1 MEDIUM / 12 NIT. All 13 findings are
addressed; none backlogged or ignored. The core decisions (D14 split, D15 no LLM fallback, auth, layout, env) are
unchanged.

| # | Severity | Response | Where |
|---|---|---|---|
| 1 | MEDIUM | Addressed. Request `params` is valid when `!pyTruthy(params)` (read as `{}`) or a plain object; a truthy non-object → 400. `applyUpdates` replaces falsy `params` with a fresh `{}` (via `defineProperty`) before writing. Service order fixed: check → `loadTopologyDict` → `assertInventoryInput` → `applyUpdates` → `circuitInventory`. The boot rule stays strict and is stated as stricter. D21 extended. Fixtures (`params: []` with and without an update) and e2e cases added. | 1.4, 2.4, 5.2, 8.1-8.3, D21 |
| 2 | NIT | Addressed. Sentence corrected: Python `"None"`, `pythonStr` `''`, same result. | 1.4 |
| 3 | NIT | Addressed. Boot failure surfaces from `app.listen()` via `app.init()`; in e2e `app.init()` rejects. | 2.4 |
| 4 | NIT | Addressed. `parseDocument` + `doc.errors` + `visit(doc, { Pair })` key check + `doc.toJS({ maxAliasCount: 100 })`; spec covers bool/null/float/int keys. | 2.5, 8.2 |
| 5 | NIT | Addressed. Section 8 comparison rule: key-order-insensitive deep equality, except `yaml-safe-load.json` and `key_params` selection. Inventory key order stated as Nest's own; D23 notes it. | 1.4, 8, D23 |
| 6 | NIT | Addressed. `$float` encoding for non-finite values in every fixture; Nest `null` vs Python `Infinity` in D23; fixture case added. | 8, 8.1, D23 |
| 7 | NIT | Addressed. `topologyNotFound(name: unknown)` exported from `src\topologies\topologies.types.ts`, used by both services; `truncate` dropped. | 1.2, 1.4, 1.5 |
| 8 | NIT | Addressed. `DeepReadonly<T>` defined in `topologies.types.ts`; `VisualizationResponse.circuit_json` and the catalog's schematic map use it. | 1.2, 1.5 |
| 9 | NIT | Addressed. `to_number` regex built from `PY_WHITESPACE` and `[0-9]`; `\u001c1k` → 1000 and `\ufeff1` → `null` vectors added. | 1.4, 8.1, D23 |
| 10 | NIT | Addressed. Python note corrected (400 missing/falsy, 404 non-string truthy); the Nest 400 recorded in D21. | 5.2, D21 |
| 11 | NIT | Addressed. Depth defined (top level = 1, `internal` = parent + 1, > 32 rejected); e2e 33 → 400, 32 → 200. | 1.4, 5.2, 8.3 |
| 12 | NIT | Addressed. The eight pathspecs are listed. | 2.2 |
| 13 | NIT | Addressed (this is round-1 finding 10). Storage bullet added to 7, persistence note added to 10, row R1-10 added below. | 7, 10 |

### Round 1 (revision 1)

All ten round-1 findings are addressed (finding 10 in revision 2).

| # | Severity | Response | Where |
|---|---|---|---|
| 1 | MEDIUM | Addressed. `__proto__` dropping by `ValidationPipe`/`instanceToPlain` recorded in D23. The 1.4 `apply_updates` sentence is rewritten (`constructor` stays an own key; `__proto__` never arrives; `defineProperty` kept as defense in depth). The 8.3 e2e now asserts 200, no global pollution, no own `__proto__` key in any returned `params`, and `constructor` returned as an own key. | 1.4, 8.3, D23 |
| 2 | MEDIUM | Addressed. Exact `circuit_inventory` and `_switching_frequency` rules written as pseudo-code: skip only `type === 'node'` with a non-listed `node_type`; component entry `{ref,type,role,inside,params}`; magnetics fields from `inductance`/`Lm_primary`/`turns_ratio`/`k_coupling\|coupling_coefficient`/`saturation_current`; period candidate iff `source` lowercases to `pulse` or `node_type` contains `pwm`; inventory key order. Python line references corrected (82-98, 101-137). Fixture cases added. | 1.4, 8.1 |
| 3 | MEDIUM | Addressed. Non-string or unresolved `topology_id` on the catalog path gives 404 `TOPOLOGY_NOT_FOUND` (Python parity); `resolveId` is never called with a non-string. Added to 5.2, the `circuit-info.json` fixture and the e2e list. | 1.4, 5.2, 8.1, 8.3 |
| 4 | MEDIUM | Addressed. The manifest spec is `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\src\common\assets\manifest.spec.ts` everywhere. Rule added: `assets\` holds only the copied data and `MANIFEST.json`. | 2.4, 8.2 |
| 5 | NIT | Addressed. Text now names both U+00A0 stems; explicit mosfet parity row added. | 2.1, 8.2 |
| 6 | NIT | Addressed. `pyStrKey`: `null` or `undefined` → `'None'`; fixture case added. | 1.1, 8.1 |
| 7 | NIT | Addressed. Section 4 says "unchanged apart from the `python-json` import path in `studio-system-prompt.ts`". | 1.1, 4 |
| 8 | NIT | Addressed. Step 4 strips a trailing `.yaml` from `target` before `ids.has`; vector `dcdc_buck.yaml.yaml` → `dcdc_buck` added. | 1.5, 8.1 |
| 9 | NIT | Addressed. Short paths now have a stated absolute root: the BE/FE/CORE roots in the header, a per-table note in 1.2-1.5, 2.1, 3.1, 6 and 8.2, and paths written in full in 4 and 8.1. | header, 1-8 |
| 10 | NIT | Addressed in revision 2. AGENTS.md Storage rule: step 2 writes no user data, reads only repo-shipped read-only assets, no Supabase/S3/Prisma; dev-time writes limited to `assets\` and `test\parity\fixtures\catalog\`; temp dirs cleaned in `afterEach`. Frontend persistence unchanged. | 7, 10 |
