import {
  STAGE_ORDER,
  stageNodeOnBranch,
  type StudioProject,
} from './studio/studio-graph';

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

/** Studio projects: READY stages on the active branch, out of 6. */
export function studioProgress(project: StudioProject): Progress {
  const completed = STAGE_ORDER.filter(
    (stage) => stageNodeOnBranch(project, stage)?.status === 'ready',
  ).length;
  return { completed, total: STAGE_ORDER.length };
}
