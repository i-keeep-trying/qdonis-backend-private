import { AppError, ErrorCode } from '../../common/errors/error-codes';
import {
  type Branch,
  createEmptyProject,
  isStageKind,
  type JsonObject,
  newId,
  type StageNode,
  stageNodeOnBranch,
  type StudioProject,
} from './studio-graph';
import { humanizeTopology, mapTopologyNameToBackend } from './topology-names';

/**
 * Server-side half of the old `lib/studio/persistence.ts`: validating a
 * submitted graph, normalising it for storage, deriving the legacy summary
 * keys and converting legacy wizard projects. Heavy payloads are split out by
 * the caller (see ProjectsService.saveStudio).
 */

export const MAX_NODES = 2_000;
export const MAX_BRANCHES = 200;
export const MAX_MESSAGES = 5_000;

/** Simulation keys that never live in `projects.data` (stored as S3 blobs). */
export const HEAVY_SIM_KEYS = ['plots', 'raw_time_series_zip'] as const;

export const heavyBlobName = (nodeId: string): string => `studio/${nodeId}`;

/** Raw time series of a simulation node, kept apart from its plots (only the stage engines read it). */
export const rawSeriesBlobName = (nodeId: string): string =>
  `studio/${nodeId}/raw`;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Scalars as text; anything else as JSON (never `[object Object]`). */
const scalarText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
};

function invalid(message: string): never {
  throw AppError.badRequest(
    ErrorCode.ValidationFailed,
    `Invalid studio project: ${message}`,
  );
}

const NODE_STATUSES = new Set(['running', 'ready', 'error']);
const NODE_SOURCES = new Set(['agent', 'user', 'upload', 'legacy']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Structural validation of a submitted graph. Stage `data` stays opaque (its
 * shape belongs to each stage), but ids, links and enums must be sound so a
 * malformed save can never corrupt the stored project.
 */
export function parseStudioProject(value: unknown): StudioProject {
  if (!isObject(value)) invalid('expected an object');
  if (value.version !== 1) invalid('version must be 1');
  const { nodes, branches, branchOrder, activeBranchId, messages } = value;
  if (!isObject(nodes)) invalid('nodes must be an object');
  if (!isObject(branches)) invalid('branches must be an object');
  if (!Array.isArray(branchOrder)) invalid('branchOrder must be an array');
  if (!Array.isArray(messages)) invalid('messages must be an array');
  if (typeof activeBranchId !== 'string') invalid('activeBranchId is required');

  const nodeEntries = Object.entries(nodes);
  if (nodeEntries.length > MAX_NODES) invalid(`more than ${MAX_NODES} nodes`);
  const branchEntries = Object.entries(branches);
  if (branchEntries.length === 0) invalid('at least one branch is required');
  if (branchEntries.length > MAX_BRANCHES) {
    invalid(`more than ${MAX_BRANCHES} branches`);
  }
  if (messages.length > MAX_MESSAGES)
    invalid(`more than ${MAX_MESSAGES} messages`);

  const parsedNodes: Record<string, StageNode> = {};
  for (const [id, raw] of nodeEntries) {
    if (!ID_PATTERN.test(id) || !isObject(raw) || raw.id !== id) {
      invalid(`node ${id.slice(0, 40)} is malformed`);
    }
    if (!isStageKind(raw.stage)) invalid(`node ${id} has an unknown stage`);
    const parentId = raw.parentId ?? null;
    if (parentId !== null && typeof parentId !== 'string') {
      invalid(`node ${id} has an invalid parentId`);
    }
    if (typeof raw.status !== 'string' || !NODE_STATUSES.has(raw.status)) {
      invalid(`node ${id} has an invalid status`);
    }
    const data = raw.data ?? {};
    if (!isObject(data)) invalid(`node ${id} data must be an object`);
    parsedNodes[id] = {
      ...(raw as unknown as StageNode),
      parentId,
      data,
      rev:
        typeof raw.rev === 'number' && raw.rev >= 0 ? Math.floor(raw.rev) : 1,
      source:
        typeof raw.source === 'string' && NODE_SOURCES.has(raw.source)
          ? (raw.source as StageNode['source'])
          : 'agent',
    };
  }
  for (const node of Object.values(parsedNodes)) {
    if (node.parentId !== null && !parsedNodes[node.parentId]) {
      invalid(`node ${node.id} points at a missing parent`);
    }
  }

  const parsedBranches: Record<string, Branch> = {};
  for (const [id, raw] of branchEntries) {
    if (!ID_PATTERN.test(id) || !isObject(raw) || raw.id !== id) {
      invalid(`branch ${id.slice(0, 40)} is malformed`);
    }
    const name = str(raw.name)?.trim();
    if (!name || name.length > 100) invalid(`branch ${id} needs a name`);
    const headId = raw.headId ?? null;
    if (
      headId !== null &&
      (typeof headId !== 'string' || !parsedNodes[headId])
    ) {
      invalid(`branch ${id} head is missing`);
    }
    parsedBranches[id] = { ...(raw as unknown as Branch), name, headId };
  }

  const order = (branchOrder as unknown[]).filter(
    (id): id is string => typeof id === 'string' && Boolean(parsedBranches[id]),
  );
  for (const id of Object.keys(parsedBranches)) {
    if (!order.includes(id)) order.push(id);
  }
  if (!parsedBranches[activeBranchId]) invalid('activeBranchId is unknown');

  return {
    version: 1,
    nodes: parsedNodes,
    branches: parsedBranches,
    branchOrder: [...new Set(order)],
    activeBranchId,
    focus: isStageKind(value.focus) ? value.focus : null,
    messages: messages.filter(isObject),
    ...(str(value.initialPrompt)
      ? { initialPrompt: str(value.initialPrompt)!.slice(0, 20_000) }
      : {}),
    createdAt: str(value.createdAt) ?? new Date().toISOString(),
  };
}

export interface HeavyPayload {
  plots?: unknown;
  raw_time_series_zip?: unknown;
}

/** Heavy simulation payload of a node, or null when it has none. */
export function heavyOf(node: StageNode): HeavyPayload | null {
  if (node.stage !== 'simulation') return null;
  const { plots, raw_time_series_zip } = node.data;
  const hasPlots = isObject(plots) && Object.keys(plots).length > 0;
  const hasZip = Boolean(raw_time_series_zip);
  if (!hasPlots && !hasZip) return null;
  return {
    ...(hasPlots ? { plots } : {}),
    ...(hasZip ? { raw_time_series_zip } : {}),
  };
}

/**
 * Storage form of a graph (old `serializeProject`): heavy simulation keys
 * removed (`plotsCached` marks that a blob holds them), schematic TSX dropped,
 * and anything still `running` turned into a retryable error, because a save
 * can never capture a job that is still in flight.
 */
export function serializeProject(project: StudioProject): StudioProject {
  const nodes: Record<string, StageNode> = {};
  for (const [id, node] of Object.entries(project.nodes)) {
    let data: JsonObject = node.data;
    if (node.stage === 'simulation') {
      // `plots` as an array is the plot index (light); only the legacy
      // object of samples is heavy.
      const heavyKeys = HEAVY_SIM_KEYS.filter(
        (k) => k in data && !(k === 'plots' && Array.isArray(data.plots)),
      );
      data = { ...data };
      for (const key of heavyKeys) delete data[key];
      if (heavyKeys.length > 0 || data.plotsCached) data.plotsCached = true;
    }
    if (node.stage === 'visualization' && isObject(data.circuit)) {
      if ('tsx_code' in data.circuit) {
        const circuit = { ...data.circuit };
        delete circuit.tsx_code;
        data = { ...data, circuit };
      }
    }
    // A queued constraints run (`constraints.runId`) finishes its list itself.
    if (
      node.stage === 'specs' &&
      isObject(data.constraints) &&
      data.constraints.status === 'running' &&
      typeof data.constraints.runId !== 'string'
    ) {
      const constraints = data.constraints;
      const hasItems =
        Array.isArray(constraints.items) && constraints.items.length > 0;
      data = {
        ...data,
        constraints: hasItems
          ? { ...constraints, status: undefined }
          : {
              ...constraints,
              status: 'error',
              error: 'Interrupted before it finished — generate it again.',
            },
      };
    }
    // A server job (`data.runId`, see SimulationRunsService) owns its node
    // and finishes it; anything else still running can never complete.
    const running =
      node.status === 'running' && typeof node.data.runId !== 'string';
    nodes[id] = {
      ...node,
      data,
      status: running ? 'error' : node.status,
      error: running
        ? 'Interrupted before it finished — run it again.'
        : (node.error ?? null),
    };
  }
  return { ...project, nodes };
}

/**
 * Full `projects.data` for a saved graph (old `toProjectData`): keeps keys
 * the Studio does not own, derives the legacy summary keys the dashboard and
 * reports read, and embeds the graph under `studio`.
 */
export function toProjectData(
  project: StudioProject,
  base: JsonObject | null,
): JsonObject {
  const specs = stageNodeOnBranch(project, 'specs');
  const vis = stageNodeOnBranch(project, 'visualization');
  const design = stageNodeOnBranch(project, 'design');
  const sim = stageNodeOnBranch(project, 'simulation');
  const topologyId = str(vis?.data.topologyId) ?? str(design?.data.topologyId);
  const rows = Array.isArray(specs?.data.rows)
    ? (specs.data.rows as unknown[]).filter(isObject)
    : [];
  const baseStep = str(base?.currentStep);

  const circuit = isObject(vis?.data.circuit) ? { ...vis.data.circuit } : null;
  if (circuit) delete circuit.tsx_code;

  return {
    ...(base ?? {}),
    currentStep: baseStep && baseStep !== 'welcome' ? baseStep : 'input',
    userInput: project.initialPrompt ?? str(base?.userInput) ?? '',
    initialSpecification: rows.length
      ? {
          specification: {
            derivedParametersList: rows.map((r) => ({
              name: r.name,
              value: r.value,
              unit: str(r.unit) ?? '',
              notes: str(r.note) ?? '',
            })),
            ...(topologyId
              ? { recommendedTopology: { name: topologyId } }
              : {}),
            assumptionsMade: rows
              .filter((r) => r.source === 'assumed')
              .map(
                (r) =>
                  `${String(r.name)}: ${String(r.value)} ${str(r.unit) ?? ''}`,
              ),
          },
          citations: [],
        }
      : (base?.initialSpecification ?? null),
    selectedTopologyForSketch: topologyId
      ? {
          name: topologyId,
          pros: [],
          cons: [],
          rationale: str(vis?.data.reason) ?? '',
        }
      : (base?.selectedTopologyForSketch ?? null),
    circuitVisualizationData: circuit ?? base?.circuitVisualizationData ?? null,
    // Lightweight marker only: enough for progress, not the waveforms.
    simulationData:
      sim?.status === 'ready'
        ? {
            success: true,
            metadata: sim.data.metadata,
            results: sim.data.results ? { _studio: true } : undefined,
          }
        : design
          ? { success: true, metadata: design.data.metadata }
          : (base?.simulationData ?? null),
    studio: serializeProject(project),
  };
}

function legacySpecRows(projectData: JsonObject): JsonObject[] {
  const spec = isObject(projectData.initialSpecification)
    ? projectData.initialSpecification.specification
    : undefined;
  const fromSpec =
    isObject(spec) && Array.isArray(spec.derivedParametersList)
      ? spec.derivedParametersList
      : null;
  const fromConstraints = Array.isArray(projectData.constraintParameters)
    ? (projectData.constraintParameters as unknown[])
        .filter(isObject)
        .map((p) => ({ name: p.name ?? p.label, value: p.value, unit: p.unit }))
    : [];
  const list = (fromSpec ?? fromConstraints).filter(isObject);
  return list
    .filter((p) => p.name || p.parameterName)
    .map((p) => ({
      id: newId('row'),
      name: scalarText(p.name ?? p.parameterName),
      value: scalarText(p.value),
      unit: str(p.unit) ?? '',
      category: 'electrical',
      source: 'user',
      note: str(p.notes) ?? str(p.rationale) ?? '',
    }));
}

/** Old wizard `project_data` -> a Studio graph on the `main` branch. */
export function fromLegacyProject(projectData: JsonObject): StudioProject {
  const userInput = str(projectData.userInput);
  let project = createEmptyProject(userInput || undefined);
  const branchId = project.activeBranchId;
  // Widened on purpose: `push` reassigns it from a closure.
  let parentId = null as string | null;
  const t = new Date().toISOString();

  const push = (
    stage: StageNode['stage'],
    data: JsonObject,
    summary: string,
  ) => {
    const node: StageNode = {
      id: newId('n'),
      parentId,
      stage,
      status: 'ready',
      rev: 1,
      data,
      source: 'legacy',
      createdAt: t,
      updatedAt: t,
      summary,
    };
    project = { ...project, nodes: { ...project.nodes, [node.id]: node } };
    parentId = node.id;
  };

  const rows = legacySpecRows(projectData);
  if (rows.length) {
    push(
      'specs',
      { application: userInput?.slice(0, 120), rows, approved: true },
      `${rows.length} spec rows`,
    );
  }

  const sketch = isObject(projectData.selectedTopologyForSketch)
    ? projectData.selectedTopologyForSketch
    : null;
  const topologyName = str(sketch?.name);
  const topologyId = topologyName
    ? mapTopologyNameToBackend(topologyName)
    : null;
  if (topologyId) {
    push(
      'visualization',
      {
        topologyId,
        topologyName: humanizeTopology(topologyId),
        reason: sketch?.rationale,
        circuit: projectData.circuitVisualizationData ?? null,
        editedCircuit: projectData.editedCircuitVisualizationData ?? null,
      },
      humanizeTopology(topologyId),
    );
  }

  const branch = project.branches[branchId];
  project = {
    ...project,
    branches: {
      ...project.branches,
      [branchId]: { ...branch, headId: parentId },
    },
    focus: parentId ? project.nodes[parentId].stage : null,
  };
  const stages = Object.values(project.nodes).map((n) => n.stage);
  project.messages = [
    {
      id: newId('m'),
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: parentId
            ? `I've opened this project in the Studio. Everything from the earlier workflow is on the **main** branch — ${stages.join(' → ')}. What would you like to do next?`
            : "This project is empty. Tell me what you'd like to design, or attach a .cir netlist to simulate.",
        },
      ],
      createdAt: t,
    },
  ];
  return project;
}

// --- graph in tables (studio version 2) --------------------------------------

/**
 * Since the graph moved to the `studio_*` tables, `projects.data.studio`
 * only keeps the project-wide Studio keys (version 2). Nodes and branches
 * are never stored in the data blob any more.
 */
export interface StudioMeta {
  version: 2;
  initialPrompt?: string;
  focus: StudioProject['focus'];
  messages: JsonObject[];
  createdAt: string;
}

export const isGraphInTables = (projectData: JsonObject): boolean =>
  isObject(projectData.studio) && projectData.studio.version === 2;

export function studioMetaOf(project: StudioProject): StudioMeta {
  return {
    version: 2,
    ...(project.initialPrompt ? { initialPrompt: project.initialPrompt } : {}),
    focus: project.focus,
    messages: project.messages,
    createdAt: project.createdAt,
  };
}

/** Project-wide keys of a version-2 `data.studio` (defaults when absent). */
export function readStudioMeta(projectData: JsonObject): StudioMeta {
  const stored = isObject(projectData.studio) ? projectData.studio : {};
  const prompt = str(stored.initialPrompt);
  return {
    version: 2,
    ...(prompt ? { initialPrompt: prompt.slice(0, 20_000) } : {}),
    focus: isStageKind(stored.focus) ? stored.focus : null,
    messages: Array.isArray(stored.messages)
      ? (stored.messages as unknown[]).filter(isObject).slice(-MAX_MESSAGES)
      : [],
    createdAt: str(stored.createdAt) ?? new Date().toISOString(),
  };
}

/** `projects.data` for a graph stored in tables: legacy keys + Studio meta. */
export function projectDataFor(
  project: StudioProject,
  base: JsonObject | null,
): JsonObject {
  return { ...toProjectData(project, base), studio: studioMetaOf(project) };
}

/**
 * Makes a graph fit the table constraints before it is written: branch names
 * unique per project (older graphs allowed duplicates), fork points that
 * still exist, and at least one branch.
 */
export function normalizeForTables(project: StudioProject): StudioProject {
  const branches: Record<string, Branch> = {};
  const taken = new Set<string>();
  for (const id of project.branchOrder) {
    const branch = project.branches[id];
    if (!branch) continue;
    const root = branch.name.trim().slice(0, 96) || 'branch';
    let name = root;
    for (let i = 2; taken.has(name.toLowerCase()); i += 1)
      name = `${root} ${i}`;
    taken.add(name.toLowerCase());
    const forkedFromId =
      branch.forkedFromId && project.nodes[branch.forkedFromId]
        ? branch.forkedFromId
        : null;
    branches[id] = { ...branch, name, forkedFromId };
  }
  const branchOrder = project.branchOrder.filter((id) => branches[id]);
  if (branchOrder.length === 0) invalid('at least one branch is required');
  return {
    ...project,
    branches,
    branchOrder,
    activeBranchId: branches[project.activeBranchId]
      ? project.activeBranchId
      : branchOrder[0],
  };
}

/**
 * The graph stored in `projects.data` before the tables existed (version 1),
 * else one converted from legacy wizard data. Only used to import a project
 * into the tables the first time it is opened, and to restore old versions.
 */
export function loadStudioProject(projectData: JsonObject): StudioProject {
  const stored = projectData.studio;
  if (isObject(stored) && stored.version === 2) {
    // Already in tables; a copy of the data blob alone has no results.
    const meta = readStudioMeta(projectData);
    return {
      ...createEmptyProject(meta.initialPrompt),
      focus: meta.focus,
      messages: meta.messages,
      createdAt: meta.createdAt,
    };
  }
  if (
    isObject(stored) &&
    stored.version === 1 &&
    isObject(stored.branches) &&
    isObject(stored.nodes)
  ) {
    try {
      return parseStudioProject({
        ...createEmptyProject(),
        ...stored,
        messages: Array.isArray(stored.messages) ? stored.messages : [],
      });
    } catch {
      // A damaged stored graph falls back to the legacy conversion below.
    }
  }
  return fromLegacyProject(projectData);
}
