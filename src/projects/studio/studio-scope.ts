import {
  CORE_STAGES,
  isWorkspaceStage,
  type JsonObject,
  STAGE_LABEL,
  STAGE_ORDER,
  type StageKind,
  stageNodeOnBranch,
  type StudioProject,
  type StudioScope,
  type WorkspaceStage,
} from './studio-graph';

/**
 * Entry steps and the forward-only rule: the single source of truth for
 * which stages a project may run (agent tool gating, the executor guard,
 * the workspace tabs and the dashboard badge all read it).
 */

/**
 * Data flow between stages: each stage lists the stages that consume its
 * output. "After" a stage means reachable from it in this graph, never the
 * tab order. Device selection runs on the simulation node, so it has no
 * stage of its own.
 */
export const STAGE_FLOW: Record<WorkspaceStage, readonly WorkspaceStage[]> = {
  specs: ['visualization'],
  visualization: ['design'],
  design: ['simulation', 'emc', 'components'],
  simulation: ['magnetics', 'thermal', 'emc', 'mtbf', 'bom'],
  magnetics: ['thermal', 'mtbf', 'bom', 'components'],
  // Junction / hotspot temperatures for MTBF, the heatsink line for the BOM.
  thermal: ['mtbf', 'bom'],
  mtbf: [],
  bom: [],
  emc: [],
  components: [],
};

/** Projects made before entry steps existed behave as full projects. */
export const FULL_SCOPE: StudioScope = {
  mode: 'entry',
  entry: 'specs',
  locked: true,
};

export function scopeOf(project: Pick<StudioProject, 'scope'>): StudioScope {
  return project.scope ?? FULL_SCOPE;
}

export const isFullScope = (scope: StudioScope): boolean =>
  scope.mode === 'entry' && scope.entry === 'specs';

/** Every stage reachable from `stage` (itself excluded), in display order. */
export function downstreamOf(stage: WorkspaceStage): WorkspaceStage[] {
  const seen = new Set<WorkspaceStage>();
  const queue = [...STAGE_FLOW[stage]];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...STAGE_FLOW[next]);
  }
  return STAGE_ORDER.filter((s) => seen.has(s));
}

/** Stages the project may run: the entry step and everything after it. */
export function allowedStages(scope: StudioScope): WorkspaceStage[] {
  if (scope.mode === 'undecided') return [];
  const allowed = new Set([scope.entry, ...downstreamOf(scope.entry)]);
  return STAGE_ORDER.filter((s) => allowed.has(s));
}

export const isStageAllowed = (scope: StudioScope, stage: StageKind): boolean =>
  (allowedStages(scope) as readonly StageKind[]).includes(stage);

/**
 * Tabs of the workspace: nothing while undecided; the full flow shows the
 * core stages plus any newer stage that has a result; an entry step shows
 * itself plus the downstream stages that have a result.
 */
export function visibleStages(
  scope: StudioScope,
  hasResult: (stage: WorkspaceStage) => boolean,
): WorkspaceStage[] {
  if (scope.mode === 'undecided') return [];
  const core = new Set<WorkspaceStage>(isFullScope(scope) ? CORE_STAGES : []);
  return allowedStages(scope).filter(
    (s) => s === scope.entry || core.has(s) || hasResult(s),
  );
}

/**
 * Steps the agent may offer next: allowed stages fed directly by a stage
 * that has a ready result, that have no result themselves.
 */
export function nextSteps(
  scope: StudioScope,
  ready: (stage: WorkspaceStage) => boolean,
): WorkspaceStage[] {
  if (scope.mode === 'undecided') return [];
  const allowed = allowedStages(scope);
  const out = new Set<WorkspaceStage>();
  for (const stage of allowed) {
    if (!ready(stage)) continue;
    for (const next of STAGE_FLOW[stage]) {
      if (allowed.includes(next) && !ready(next)) out.add(next);
    }
  }
  return STAGE_ORDER.filter((s) => out.has(s));
}

/** Stages with a ready result on the project's active branch. */
export function readyOn(project: StudioProject): (stage: StageKind) => boolean {
  return (stage) => stageNodeOnBranch(project, stage)?.status === 'ready';
}

/**
 * `{ mode, entry, locked }` as stored in `data.studio.scope`; null when
 * malformed. A stored `devices` entry (before device selection moved onto
 * the simulation) becomes a Simulation entry.
 */
export function parseScope(value: unknown): StudioScope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as JsonObject;
  if (raw.mode === 'undecided') return { mode: 'undecided' };
  const entry = raw.entry === 'devices' ? 'simulation' : raw.entry;
  if (raw.mode === 'entry' && isWorkspaceStage(entry)) {
    return { mode: 'entry', entry, locked: raw.locked === true };
  }
  return null;
}

/** The project's entry step (null while undecided), for the dashboard badge. */
export function entryStepOf(scope: StudioScope): WorkspaceStage | null {
  return scope.mode === 'entry' ? scope.entry : null;
}

export const stageLabel = (stage: StageKind): string => STAGE_LABEL[stage];

/** Result of choosing an entry step: the new scope, or why it is refused. */
export function chooseEntry(
  current: StudioScope,
  entry: WorkspaceStage,
): { ok: true; scope: StudioScope } | { ok: false; reason: string } {
  if (current.mode === 'entry' && current.locked) {
    if (current.entry === entry) return { ok: true, scope: current };
    return {
      ok: false,
      reason: `This project starts at ${STAGE_LABEL[current.entry]} and that step has already run, so the entry step can no longer change. Continue with a later step instead.`,
    };
  }
  // The full flow has nothing to lock: every stage is open from the start.
  return {
    ok: true,
    scope: { mode: 'entry', entry, locked: entry === 'specs' },
  };
}

/** The scope after a stage ran: the entry step locks when it first runs. */
export function lockAfterRun(scope: StudioScope, ran: StageKind): StudioScope {
  if (scope.mode !== 'entry' || scope.locked) return scope;
  return ran === scope.entry || isStageAllowed(scope, ran)
    ? { ...scope, locked: true }
    : scope;
}

/**
 * Earlier stages an entry step may still write, only to hold its inputs:
 * Design needs a topology (and the electrical values as specs); Simulation
 * of an uploaded .cir stores it as a design on its topology.
 */
export const INPUT_STAGES: Partial<
  Record<WorkspaceStage, readonly StageKind[]>
> = {
  design: ['specs', 'visualization'],
  simulation: ['visualization', 'design'],
};

/** Stages whose results a graph change added or rewrote. */
function changedStages(
  before: StudioProject,
  after: StudioProject,
): StageKind[] {
  const out = new Set<StageKind>();
  for (const node of Object.values(after.nodes)) {
    const old = before.nodes[node.id];
    if (!old || old.rev !== node.rev || old.status !== node.status) {
      out.add(node.stage);
    }
  }
  return [...out];
}

/**
 * The forward-only rule on every graph write (chat, workspace buttons and
 * queued jobs alike): a single-step project may only write its allowed
 * stages and the entry step's input stages, and the entry step locks the
 * first time one of its allowed stages gets a result. An undecided project
 * becomes a full design with its first result; full projects are unaffected.
 */
export function applyScopeRules(
  before: StudioProject,
  after: StudioProject,
): { ok: true; project: StudioProject } | { ok: false; stage: StageKind } {
  const scope = scopeOf(after);
  // No step attached or named: the first result makes it a full design.
  if (scope.mode === 'undecided') {
    return {
      ok: true,
      project: changedStages(before, after).length
        ? { ...after, scope: FULL_SCOPE }
        : after,
    };
  }
  if (isFullScope(scope)) return { ok: true, project: after };
  const inputs = INPUT_STAGES[scope.entry] ?? [];
  let next: StudioScope = scope;
  for (const stage of changedStages(before, after)) {
    if (isStageAllowed(scope, stage)) {
      next = lockAfterRun(next, stage);
    } else if (!inputs.includes(stage)) {
      return { ok: false, stage };
    }
  }
  return {
    ok: true,
    project: next === scope ? after : { ...after, scope: next },
  };
}
