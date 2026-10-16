import {
  type StageKind,
  stageNodeOnBranch,
  type StudioProject,
} from './studio/studio-graph';
import { scopeOf, visibleStages } from './studio/studio-scope';

export interface Progress {
  completed: number;
  total: number;
}

type Data = Record<string, unknown>;

const has = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== false && value !== '';
const nonEmptyArray = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0;

/** Old wizard formula (10 steps), from `ProjectService.calculateProgress`. */
export function legacyProgress(data: Data): Progress {
  let completed = 0;
  if (has(data.initialSpecification) || has(data.mandatoryParametersAnalysis)) {
    completed += 1;
  }
  if (has(data.initialSpecification)) completed += 1;
  if (nonEmptyArray(data.topologyRecommendations)) completed += 1;
  if (has(data.circuitVisualizationData) || has(data.simulationData)) {
    completed += 1;
  }
  if (has(data.simulationData)) completed += 1;
  if (nonEmptyArray(data.magneticComponents)) completed += 1;
  if (nonEmptyArray(data.thermalComponents)) completed += 1;
  if (nonEmptyArray(data.sourcingComponents)) completed += 1;
  const mtbf = data.mtbfSummary;
  if (
    typeof mtbf === 'object' &&
    mtbf !== null &&
    Object.values(mtbf).some((v) => typeof v === 'number' && v > 0)
  ) {
    completed += 1;
  }
  if (nonEmptyArray(data.bomData) || nonEmptyArray(data.selectedParts)) {
    completed += 1;
  }
  return { completed, total: 10 };
}

/**
 * Studio projects: READY stages on the active branch, out of the stages the
 * project shows (the 7 core stages for a full project, the entry step and
 * the later steps it has started for an entry-step project).
 */
export function studioProgress(project: StudioProject): Progress {
  const node = (stage: StageKind) => stageNodeOnBranch(project, stage);
  const shown = visibleStages(scopeOf(project), (stage) =>
    Boolean(node(stage)),
  );
  const completed = shown.filter(
    (stage) => node(stage)?.status === 'ready',
  ).length;
  // Undecided projects show no stage yet: 0 of 1 (the step still to choose);
  // `progress_total` must stay positive.
  return { completed, total: Math.max(shown.length, 1) };
}
