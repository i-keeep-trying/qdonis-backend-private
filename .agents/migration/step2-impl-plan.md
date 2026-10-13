# Step 2 implementation plan: catalog + visualization move to qdonis-backend

Source of truth: the APPROVED design
`d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend\.agents\migration\step2-catalog-visualization-design.md`
(revision 3). Section numbers below (§1.4, §2.5, D14 …) refer to it. Do not redesign; when this plan and the
design disagree, the design wins.

Roots: BE = `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-backend`, FE = `d:\1. TailorFlowAI Work\Qdonis v2\qdonis`,
CORE = `d:\1. TailorFlowAI Work\Qdonis v2\qdonis-core` (read-only, HEAD `239d79a`). Short paths starting with
`src\`, `test\`, `assets\`, `scripts\` are under BE; `lib\`, `services\`, `src\types\` under FE when the item says FE.

## Hard rules for every item

- No commit, no push, no stash/reset/discard, no worktrees. Stay on `feature/studio-agent` in BE and FE.
- Never write inside CORE. Record `git -C CORE status --porcelain` before item 1 and compare after items 1, 9 and 13
  (only the pre-existing untracked `.agents/` is allowed).
- No `.env` edits, never print secrets. No Supabase, no S3, no Prisma in this step; nothing writes user data to disk.
  Dev-time writes only to `assets\` (import script) and `test\parity\fixtures\catalog\` (capture). Spec temp dirs live
  under `os.tmpdir()` and are removed in `afterEach`.
- Do not stop/restart the user's servers (:3000 Nest `start:dev` in watch mode, :5001 Flask, :5173 Vite). Own
  processes use :3100 / :5101 and are stopped afterwards.
- The :3000 watch server recompiles on every save. That is why assets land first (item 1) and each new module is
  registered in `src\app.module.ts` only in the same item that makes it compile and load cleanly.
- Pre-existing uncommitted changes not ours: BE (step-1 work, `AGENTS.md`), FE `services/designIntentService.ts`.
  Do not touch them.
- Lint is type-checked: no `any`, `import type` for type-only imports. Use pwsh `Select-String` for searching the
  untracked `src\studio` tree (the grep tool skipped it during planning).

Standard BE checks (run from BE): `npm run typecheck`, `npm run lint:check`, `npm test`, `npm run build`.
Targeted unit run: `npm test -- <path-or-pattern>`.

# Implementation Plan

- [ ] 1. Asset import: `.gitattributes`, import script, copied assets and manifest (§2.1-2.3).
      Create `.gitattributes` with `assets/** -text`. Write `scripts\import-core-assets.mjs` exactly per §2.2:
      `execFileSync('git', [...])` with argument arrays, `maxBuffer` 64 MB, default `--core` = sibling `qdonis-core`
      resolved from the script location, verify commit `239d79a29c6fc6e97b2038aded19e5a71dbf1081^{commit}` (exit 2),
      `ls-tree -r -z --full-tree` with the eight pathspecs and filters, assert counts 35/35/31/483/122/253/4 before
      writing (exit 1), write blobs from `git cat-file blob <sha>` to `assets\<path minus qdonis_backend/data/>`
      (skip same hash, exit 1 on different hash, never overwrite), then `assets\MANIFEST.json` (§2.3 shape, LF,
      sorted by path in code-unit order, no timestamp, does not list itself). `--check` mode is read-only and fails
      on missing/extra/mismatched files. Paths are handled as JS strings (two stems contain U+00A0).
      Files: `.gitattributes`, `scripts\import-core-assets.mjs`, `assets\**` (963 data files + `MANIFEST.json`).
      Verify: `node scripts/import-core-assets.mjs` exits 0; `(Get-ChildItem -Recurse -File assets).Count` = 964;
      a second run exits 0 and `Get-FileHash assets\MANIFEST.json` is unchanged; `node scripts/import-core-assets.mjs --check`
      exits 0; CORE `git status --porcelain` unchanged; `git check-attr text -- assets/topologies/primitives/dcdc_buck.yaml`
      reports `unset`.

- [ ] 2. Add the `yaml` dependency.
      `npm install yaml@2.9.1 --save-exact` (changes `package.json`, `package-lock.json`; `package-lock.json` already
      had unrelated step-1 diffs, leave them).
      Files: `package.json`, `package-lock.json`.
      Verify: `npm ls yaml` shows `yaml@2.9.1`; `package.json` has `"yaml": "2.9.1"` (no caret); `npm run typecheck` passes.

- [ ] 3. Shared helpers and the `python-json` move (§1.1).
      Move `src\studio\agent\python-json.ts` and its spec to `src\common\python\` unchanged except: export
      `PY_WHITESPACE` (the existing `PY_SPACE` string; keep `PY_SPACE` internal usage working). Update only the
      import paths in `src\studio\agent\message-normalizer.ts`, `studio-system-prompt.ts`, `studio-agent.service.ts`.
      Add `src\common\python\python-semantics.ts` (+ spec): `pyTruthy`, `pyOr`, `pyLowerStr`, `pyStrKey`
      (`null`/`undefined` → `'None'`, bools → `'True'`/`'False'`, numbers via `pythonNumber`), `pythonRound(x, 6)`
      (half-even on `x.toFixed(50)` for 1e3 ≤ |x| < 1e21, else `Number(x.toFixed(6))`). Add
      `src\common\assets\assets-root.ts` (`ASSETS_ROOT = resolve(__dirname, '..', '..', '..', 'assets')`) and
      `src\common\assets\asset-manifest.ts` (`readManifest`, `loadVerifiedSubtree` with set equality, size, SHA-256,
      batches of 32; `AssetValidationError` with message `Asset validation failed: <rel path>: <reason>`), plus
      `src\common\assets\asset-manifest.spec.ts` (temp dirs: missing file, extra file, size mismatch, hash mismatch,
      missing manifest each throw naming the path) and `src\common\assets\manifest.spec.ts` (real assets: 963 files,
      hashes match, counts 35/35/31/483/122/253 + 4, `source.commit` full SHA, no extra file in `assets\`).
      Add `TopologyNotFound: 'TOPOLOGY_NOT_FOUND'` to `src\common\errors\error-codes.ts`.
      Files: `src\common\python\{python-json,python-json.spec,python-semantics,python-semantics.spec}.ts`,
      `src\common\assets\{assets-root,asset-manifest,asset-manifest.spec,manifest.spec}.ts`,
      `src\common\errors\error-codes.ts`, the three studio agent files (import path only); delete
      `src\studio\agent\python-json.ts` and `python-json.spec.ts`.
      Verify: `npm run typecheck`; `npm test -- src/common src/studio` all green (the 16 step-1 fixtures unchanged).

- [ ] 4. Topologies module (§1.2, §1.5 name resolution, §2.4 topology rules, §2.5 PyYAML schema).
      Create `src\topologies\`: `topologies.module.ts`, `topologies.controller.ts` (`GET /topologies` →
      `{success: true, topologies: ids()}`, `@ApiTags('topologies') @ApiBearerAuth()`), `topologies.service.ts`
      (`ids`, `resolveId`, `schematic` frozen, `definition` `structuredClone`), `topologies.repository.ts`
      (`OnModuleInit` → `loadTopologyCatalog(ASSETS_ROOT)`, log `Loaded 35 topologies in <n> ms`),
      `topologies.types.ts` (`TopologyCatalog`, re-exported `JsonObject`/`JsonValue` via `export type` from
      `src\ai\bedrock\bedrock.types.ts`, `DeepReadonly`, `topologyNotFound(name: unknown)` factory using
      `AppError.notFound(ErrorCode.TopologyNotFound, …)` with 256-char truncation), `dto\topology-list.dto.ts`,
      `library\pyyaml-schema.ts` (`parseDocument` with `version '1.1'`, `schema 'yaml-1.1'`, `merge`, `uniqueKeys:false`,
      `strict`, custom bool/int/float/null/timestamp tags with the exact §2.5 regexes, `doc.errors` check, `visit`
      Pair key check, `toJS({maxAliasCount: 100})`, non-JSON values rejected), `library\topology-names.ts` (19
      aliases verbatim from Python `data_utils`, `resolveTopologyName` steps 1-6 of §1.5, no filesystem),
      `library\topology-catalog.loader.ts` (all §2.4 topology rules; deep freeze; ids code-unit sorted). The loader's
      `params` check and the "`circuitInventory(definition)` runs once" rule need item 6's pure
      `src\studio\circuit\circuit-inventory.ts`; to keep dependency direction (`topologies` must not import `studio`),
      implement the `params` walk inline in the loader now, and add the `circuitInventory` dry run in item 6 by
      importing the pure function from `src\studio\circuit\circuit-inventory.ts` (pure file, no Nest imports, so no
      module cycle). Register `TopologiesModule` in `src\app.module.ts`.
      Unit specs now (fixtures arrive in item 9; write specs against the fixture files and run them after item 9):
      `library\pyyaml-schema.spec.ts` error cases that need no fixture (timestamp, non-finite, `1:`/`yes:`/`~:`/`1.5:`
      keys throw; quoted `"yes":` and `<<` accepted), `library\topology-catalog.loader.spec.ts` temp-copy rejections
      (missing JSON partner, mismatched `id`, bad `params`) and real-assets load (35 ids equal
      `test\parity\fixtures\studio-agent\topology-ids.json`).
      Files: `src\topologies\**`, `src\app.module.ts`.
      Verify: `npm run typecheck`; `npm test -- src/topologies` (non-fixture specs) green; `npm run build`.

- [ ] 5. Devices module (§1.3, §2.4 device rules). Independent of item 4.
      Create `src\devices\`: module, controller (`GET /devices?kind=` via `ListDevicesQueryDto` with
      `@IsIn(DEVICE_KINDS)` required; `GET /devices/catalogue`), service (`models(kind)`, `catalogue()` frozen
      precomputed), repository (`OnModuleInit` → `loadDeviceLibrary(ASSETS_ROOT)`, log
      `Loaded 858 device models (596 usable) in <n> ms`), `devices.types.ts`, `dto\list-devices.dto.ts`,
      `dto\device-catalogue.dto.ts`, `library\device-library.loader.ts` (§2.4 rules; models sorted by `part_number`
      code-unit order; catalogue sorted by relative path, D19), `library\part-ratings.ts` (ports of
      `device_selection._voltage_from_part`, `_current_from_part`, `_family`, read the Python in
      `CORE\qdonis_backend\device_selection.py` for the exact regexes). Register `DevicesModule` in `src\app.module.ts`.
      Files: `src\devices\**`, `src\app.module.ts`.
      Verify: `npm run typecheck`; `npm run build`; a loader smoke spec `src\devices\library\device-library.loader.spec.ts`
      asserts counts 228/246/122 models and 596 catalogue parts and passes with `npm test -- src/devices`.

- [ ] 6. Circuit-info in the studio module (§1.4, §5.2). Depends on items 3 and 4.
      Add `src\studio\circuit\to-number.ts` (regex built from `PY_WHITESPACE`, `_SI` table incl. `meg`, `µ`),
      `src\studio\circuit\circuit-inventory.ts` (pure `iterComponents`, `applyUpdates` with `defineProperty` writes and
      falsy-`params` replacement, `circuitInventory`, `switchingFrequency` with D22 tie rule, `assertInventoryInput`
      depth > 32 / > 10,000 / truthy non-object `params` → `AppError.badRequest(ErrorCode.ValidationFailed, <index path>)`),
      `src\studio\circuit\circuit-info.service.ts` (order: required check → `loadTopologyDict` with the exact §1.4 guard
      → `assertInventoryInput` → `applyUpdates` → `circuitInventory`), `src\studio\dto\circuit-info.dto.ts`
      (`topology_id` optional string ≤ 256 nullable; `circuit` optional plain object nullable; `recalculated_parameters`
      optional array ≤ 2,000 of objects nullable; unknown keys rejected), types in `src\studio\studio.types.ts`
      (`CircuitInventory`, `InventoryComponent`, `InventoryMagnetic`, `null` never `undefined`). Controller handler
      `@Post('circuit-info') @HttpCode(HttpStatus.OK)` → `{ success: true, inventory }`. `StudioModule` imports
      `TopologiesModule`, provides `CircuitInfoService`. Add the `circuitInventory(definition)` dry run to
      `topology-catalog.loader.ts` (item 4 note). Add `src\studio\circuit\to-number.spec.ts` fixture-free cases
      (`'\u001c1k'` → 1000, `'\ufeff1'` → null, `1e400` → Infinity, containers → null).
      Files: `src\studio\circuit\**`, `src\studio\dto\circuit-info.dto.ts`, `src\studio\studio.types.ts`,
      `src\studio\studio.controller.ts`, `src\studio\studio.module.ts`, `src\topologies\library\topology-catalog.loader.ts`.
      Verify: `npm run typecheck`; `npm test -- src/studio src/topologies src/common` green; `npm run build`.

- [ ] 7. Visualization module (§1.5, D14, D15). Depends on item 4.
      Create `src\visualization\`: module (`imports: [TopologiesModule]`), controller (`@Post() @HttpCode(HttpStatus.OK)`,
      `@ApiTags('visualization') @ApiBearerAuth()`), service (`resolveId(dto.topology_name)` → `topologyNotFound` or
      `{success: true, circuit_json, tsx_code: STATIC_TSX_PLACEHOLDER, metadata: {topology, elements_count, has_netlist: false, source: 'static_library'}}`,
      no `netlist` key), `visualization.types.ts`, `dto\visualize.dto.ts` (`topology_name` required string 1..256,
      `parameters` `@IsOptional() @IsObject()`, unknown keys rejected). Register `VisualizationModule` in `src\app.module.ts`.
      Files: `src\visualization\**`, `src\app.module.ts`.
      Verify: `npm run typecheck`; `npm run build`; `npm test` green.

- [ ] 8. Replace the step-1 static id list with the catalog (§4). Depends on item 4.
      Delete `src\studio\agent\topology-library.ts`. `StudioAgentService` constructor becomes
      `(ai: AiService, bedrock: BedrockClient, topologies: TopologiesService)`; `runStep` passes
      `topologyIds: this.topologies.ids()`. `studio-request.builder.ts`, `studio-system-prompt.ts` (except the item-3
      import), `studio-tools.ts`, `studio-system-prompt.text.ts` stay byte-unchanged. Update
      `src\studio\agent\studio-request.parity.spec.ts`: the "same topology library" test becomes
      `expect([...(await loadTopologyCatalog(ASSETS_ROOT)).ids]).toEqual(loadTopologyIds())`, plus one test that
      `buildStudioSystemPrompt` and `buildStudioTools` output for fixture 01 is identical with catalog ids and with
      `fixture.topology_ids`. Update `src\studio\agent\studio-agent.service.spec.ts`: pass
      `{ ids: () => loadTopologyIds() } as unknown as TopologiesService` and assert the system text contains the
      `## Topology library` line.
      Files: `src\studio\agent\topology-library.ts` (delete), `src\studio\agent\studio-agent.service.ts`,
      `src\studio\agent\studio-request.parity.spec.ts`, `src\studio\agent\studio-agent.service.spec.ts`.
      Verify: `npm test -- src/studio` green with all 16 fixtures × 4 request checks and 16 replays; `git diff --stat`
      shows no change in `studio-system-prompt.text.ts`, `studio-tools.ts`, `studio-request.builder.ts`;
      `Select-String -Path src -Recurse -Pattern STUDIO_TOPOLOGY_IDS` (pwsh, recursive) finds nothing.

- [ ] 9. Python parity capture (§8, §8.1). Independent of items 1-8 (it reads core only); its outputs gate item 10.
      Create `test\parity\capture\catalog_capture.py` following `studio_agent_capture.py` (HERE/BACKEND_ROOT/DEFAULT_CORE,
      `--core`, `sys.dont_write_bytecode = True`, re-exec with `PYTHONHASHSEED=0` + `PYTHONDONTWRITEBYTECODE=1`, core
      `git status --porcelain` checked before/after). Import `qdonis_backend.api_server` with `threading.Thread.start`
      patched to a no-op during import; patch `qdonis_backend.simulator.generate_spice_netlist` →
      `"<netlist omitted by capture>"` and `qdonis_backend.tsx_formatter.generate_fallback_json` → raise
      `RuntimeError('CAPTURE_FALLBACK_REACHED')` (patch where `api_server` looks them up — check its imports). No LLM,
      no ngspice, `app.test_client()`. Hand-written inputs in `test\parity\fixtures\catalog\inputs.json` (visualize
      names and all §8.1 circuit-info cases, incl. `nest_expected_status: 200` for the `params: []` + update case).
      Outputs to `test\parity\fixtures\catalog\`: `topologies.json`, `models-{mosfet,diode,igbt}.json`,
      `device-library.json`, `visualize.json` (35 ids + inputs, `fallback_reached`, no traceback/details, `platform`),
      `circuit-info.json` (35 ids + §8.1 cases), `yaml-safe-load.json` (key order kept), `pyyaml-scalars.json`,
      `topology-names.json` (~40 vectors incl. `dcdc_buck.yaml.yaml`), `to-number.json` (~40 vectors). Non-finite →
      `{"$float": ...}`, `allow_nan=False`, deterministic, no timestamps. Add a "Catalog capture" section to
      `test\parity\capture\README.md` and a TS loader `test\parity\catalog-fixtures.ts` (mirrors
      `studio-agent-fixtures.ts`, decodes `$float`).
      Files: `test\parity\capture\catalog_capture.py`, `test\parity\capture\README.md`,
      `test\parity\fixtures\catalog\**`, `test\parity\catalog-fixtures.ts`.
      Verify: `& "..\qdonis-core\.venv\Scripts\python.exe" -B test\parity\capture\catalog_capture.py` exits 0 twice
      with byte-identical outputs (compare `Get-FileHash` of every fixture); `visualize.json` has 35 `static_library`
      entries with `fallback_reached: false` and the alias inputs with `fallback_reached: true`; CORE `git status`
      unchanged; `npm run lint:check` covers the new TS loader.

- [ ] 10. Parity specs against the fixtures (§8.2). Depends on items 4-9.
      Add/finish: `src\topologies\library\pyyaml-schema.spec.ts` (`pyyaml-scalars.json` finite values deep-equal),
      `src\topologies\library\topology-catalog.parity.spec.ts` (35 YAMLs deep-equal `yaml-safe-load.json` with key
      order checked at every mapping), `src\topologies\library\topology-names.spec.ts` (vector + path inputs,
      `constructor`/`__proto__` → null), `src\devices\library\device-library.parity.spec.ts` (models and catalogue
      deep-equal in order; the U+00A0 rows), `src\studio\circuit\to-number.spec.ts` (`to-number.json`),
      `src\common\python\python-semantics.spec.ts` (`pythonRound` exact tie, `pyTruthy` table),
      `src\studio\circuit\circuit-info.parity.spec.ts` (every case through `CircuitInfoService` with a real catalog,
      key-order-insensitive, non-finite → `null` after a JSON round trip, `nest_expected_status`, D22 tie, cached
      definition unchanged after updates), `src\visualization\visualization.parity.spec.ts` (§3.3: 35 ids deep-equal
      Python minus `netlist` with `has_netlist: false`; aliases return the canonical schematic; `nope` → 404).
      Comparison rule from §8: `toEqual` (order-insensitive keys) except the YAML key-order spec.
      Files: the spec files above.
      Verify: `npm test` — all suites green (step-1 suites included); report the suite/test counts.

- [ ] 11. E2E suite (§8.3). Depends on items 4-8.
      Create `test\catalog.e2e-spec.ts`, booting `AppModule` like `test\studio.e2e-spec.ts` (SilentMail override,
      `configureApp`, `app.listen(0)`, registered+verified user via the real auth API). Cases: 401 without a token for
      all 7 routes; 200 + fixture bodies for `/topologies`, `/devices?kind=*`, `/devices/catalogue`; `/visualization`
      `dcdc_buck` → 200 (not 201), no `netlist`, `has_netlist: false`; `/studio/circuit-info` `dcdc_buck` → 200;
      400 for `kind=foo`, missing `kind`, `/visualization` `{}` and `{topology_name: 5}`; 404 `TOPOLOGY_NOT_FOUND`
      for `nope`; circuit-info `{}` 400, unknown id 404, `params: [1]` 400, `params: []` 200 with `params: {}`, with an
      update row 200 and value applied, depth 33 → 400 and 32 → 200, `{circuit: {name: "x"}}` → 404; the raw-JSON
      `__proto__`/`constructor` prototype case (§8.3 assertions); balance unchanged after all calls.
      Files: `test\catalog.e2e-spec.ts`.
      Verify: `$env:E2E_DATABASE_URL = '<DATABASE_URL with database qdonis_e2e>'; npm run test:e2e` (build the URL in
      the shell from `.env` without printing it) — 5 suites (auth, billing, ai, studio, catalog) all green.

- [ ] 12. Frontend flag switch (§6). Depends on items 4-7 for live use, not for compiling.
      FE: create `services\api\stageBackend.ts` (header comment + `STAGE_BACKEND`); add
      `readonly VITE_STAGE_BACKEND?: 'nest' | 'core';` to `src\types\global.d.ts` `ImportMetaEnv`. In
      `services\circuitVisualizationService.ts` import `apiRequest` (and `ApiError` if needed) from `./api/apiClient`
      without shadowing the local core `API_BASE_URL`; in nest mode `getAvailableTopologies` →
      `apiRequest('/topologies')` (rethrow), `getAvailableMosfets/Diodes/Igbts` → `apiRequest('/devices', {query: {kind}})`
      returning `models` (`[]` on error), `visualizeCircuit` → `apiRequest('/visualization', {method: 'POST', body: request, signal: controller.signal})`
      inside the existing retry/timeout loop. In `lib\studio\stages.ts` `fetchInventory` nest mode →
      `apiRequest('/studio/circuit-info', {method: 'POST', body: {topology_id, circuit: circuit || undefined, recalculated_parameters: recalculated || undefined}})`,
      keeping `try/catch → null`. Core branches stay today's code. Comment-only edits in `lib\studio\agent.ts` header
      and `lib\studio\types.ts:98`. No `.env` change; do not touch `services\designIntentService.ts`.
      Files (FE): `services\api\stageBackend.ts`, `src\types\global.d.ts`, `services\circuitVisualizationService.ts`,
      `lib\studio\stages.ts`, `lib\studio\agent.ts`, `lib\studio\types.ts`.
      Verify (from FE): `npx tsc --noEmit -p tsconfig.json` → total errors ≤ 398 and 0 errors in the changed files
      (filter the output by file name); `$env:NODE_OPTIONS='--max-old-space-size=8192'; npm run build` passes.

- [ ] 13. Live check against own processes (§8.4).
      `npm run build`, then start Nest from `dist` on :3100 (`$env:PORT='3100'` in that shell only) and core on :5101
      with the core venv the same way step 1 did (see `step1-studio-agent-report.md`, "Live Bedrock"). Register a
      `catalog-live-*@example.com` user via the real API (or reuse an e2e-style token), then compare the 7 routes'
      bodies Nest vs Python with the key-order-insensitive rule (`/visualization` minus `netlist` and `has_netlist`).
      Stop both processes, confirm :3100/:5101 are free and :3000/:5001/:5173 untouched, CORE `git status` unchanged.
      Files: none (record results in the report).
      Verify: all 7 comparisons equal; processes stopped (`Get-NetTCPConnection -LocalPort 3100,5101` empty).

- [ ] 14. Ledger update and report.
      Update `.agents\migration\core-migration-ledger.md` per the design's "Ledger updates" list: rows 3, 4, 5, 6, 7,
      31, 35 → `done` with evidence (row 7 plan text per D14/D15); section 2 assets → `done (copied)` with target
      `assets/...`, new rows for `mosfet_database.json` and `models/{C3D10065A,E3M0060065K}.json`; section 4 `pyyaml`
      → `yaml 2.9.1` done; section 5 additions (D18 path traversal, raw-name static lookup to the LLM, swallowed model
      parse errors, filesystem-order catalogue); section 7 D14-D23 and D12 superseded; section 8 counts updated plus a
      checklist item to remove the `VITE_STAGE_BACKEND=core` branches. Write
      `.agents\migration\step2-catalog-visualization-report.md` in the style of the step-1 report: files added/changed,
      decisions, flag usage, re-run commands, verification table with real results, not-verified items (browser steps
      from §8.4), side effects (test users), final `git status --porcelain` of BE and FE, and "nothing committed or pushed".
      Files: `.agents\migration\core-migration-ledger.md`, `.agents\migration\step2-catalog-visualization-report.md`.
      Verify: final full suite from BE: `npm run typecheck`, `npm run lint:check`, `npm run build`, `npm test`,
      `npm run test:e2e` (with `E2E_DATABASE_URL`), `node scripts/import-core-assets.mjs --check`; FE tsc baseline and
      build as in item 12; `git log -1` in BE and FE unchanged (`67f1944` / `6b783c7`), `git worktree list` shows one
      worktree, `git ls-remote --heads origin feature/studio-agent` empty.

## Dependency summary

1 → 2 → 3 → 4 → {5, 6, 7, 8} (5 independent of 4; 6, 7, 8 need 4; 6 needs 3) → 9 (needs only core; can run any
time after 1) → 10 (needs 4-9) → 11 → 12 → 13 → 14.

## Assumptions noted

- The design puts the `circuitInventory` dry run in the topology loader while `circuit-inventory.ts` lives under
  `src\studio\circuit\`. Importing that pure file from `src\topologies\library\` does not create a Nest module cycle;
  the rule "topologies must not import studio" is read as "no Nest module/provider import". If the reviewer objects,
  the fallback is to move only the pure file to `src\common\circuit\` and leave a note in the report.
- `yaml@2.9.1` is taken from the approved design; if npm cannot resolve that exact version, stop and report rather
  than picking another.
