import { legacyProgress, studioProgress } from '../project-progress';
import {
  commitStage,
  createEmptyProject,
  stageNodeOnBranch,
} from './studio-graph';
import {
  fromLegacyProject,
  heavyOf,
  loadStudioProject,
  parseStudioProject,
  serializeProject,
  toProjectData,
} from './studio-persistence';
import { humanizeTopology, mapTopologyNameToBackend } from './topology-names';

describe('studio graph', () => {
  it('appends, updates in place, then forks when later work exists', () => {
    let project = createEmptyProject('prompt');
    const first = commitStage(project, 'specs', { rows: [] });
    expect(first.forked).toBe(false);
    project = first.project;

    const inPlace = commitStage(project, 'specs', { rows: [{ name: 'Vout' }] });
    expect(inPlace.nodeId).toBe(first.nodeId);
    expect(inPlace.project.nodes[first.nodeId].rev).toBe(2);
    project = inPlace.project;

    project = commitStage(project, 'visualization', {
      topologyId: 'dcdc_buck',
    }).project;
    const fork = commitStage(project, 'specs', { rows: [{ name: 'Vin' }] });
    expect(fork.forked).toBe(true);
    expect(fork.branchName).toBe('Specs v2');
    expect(fork.project.branchOrder).toHaveLength(2);
    // The original branch still holds the old specs and the circuit.
    const main = fork.project.branchOrder[0];
    expect(
      stageNodeOnBranch(fork.project, 'visualization', main),
    ).not.toBeNull();
    expect(stageNodeOnBranch(fork.project, 'visualization')).toBeNull();
  });

  it('counts ready stages for progress', () => {
    let project = createEmptyProject();
    project = commitStage(project, 'specs', {}).project;
    project = commitStage(project, 'design', {}, { status: 'error' }).project;
    expect(studioProgress(project)).toEqual({ completed: 1, total: 7 });
  });
});

describe('studio persistence', () => {
  it('validates structure and links', () => {
    const project = commitStage(createEmptyProject(), 'specs', {}).project;
    expect(() => parseStudioProject(project)).not.toThrow();
    expect(() => parseStudioProject({ ...project, version: 2 })).toThrow();
    const node = Object.values(project.nodes)[0];
    expect(() =>
      parseStudioProject({
        ...project,
        nodes: { [node.id]: { ...node, parentId: 'missing' } },
      }),
    ).toThrow(/missing parent/);
    expect(() =>
      parseStudioProject({ ...project, activeBranchId: 'nope' }),
    ).toThrow(/activeBranchId/);
  });

  it('strips heavy payloads and interrupted jobs on save', () => {
    let project = createEmptyProject();
    project = commitStage(project, 'simulation', {
      plots: { v: [1] },
      raw_time_series_zip: 'zip',
      results: {},
    }).project;
    project = commitStage(
      project,
      'thermal',
      {},
      { status: 'running' },
    ).project;
    const sim = Object.values(project.nodes).find(
      (n) => n.stage === 'simulation',
    )!;
    expect(heavyOf(sim)).toEqual({
      plots: { v: [1] },
      raw_time_series_zip: 'zip',
    });

    const saved = serializeProject(project);
    const savedSim = saved.nodes[sim.id];
    expect(savedSim.data).toEqual({ results: {}, plotsCached: true });
    const thermal = Object.values(saved.nodes).find(
      (n) => n.stage === 'thermal',
    )!;
    expect(thermal.status).toBe('error');
  });

  it('keeps the plot index and server-run jobs on save', () => {
    const project = commitStage(
      createEmptyProject(),
      'simulation',
      { runId: 'run-1', plots: [{ key: 'V_SW' }], raw_time_series_zip: 'z' },
      { status: 'running' },
    ).project;
    const sim = Object.values(serializeProject(project).nodes).find(
      (n) => n.stage === 'simulation',
    )!;
    expect(sim.status).toBe('running');
    expect(sim.data).toEqual({
      runId: 'run-1',
      plots: [{ key: 'V_SW' }],
      plotsCached: true,
    });
  });

  it('derives legacy summary keys and keeps foreign keys', () => {
    let project = createEmptyProject('Build a buck');
    project = commitStage(project, 'specs', {
      rows: [{ name: 'Vout', value: '12', unit: 'V', source: 'assumed' }],
    }).project;
    project = commitStage(project, 'visualization', {
      topologyId: 'dcdc_buck',
      reason: 'simple',
      circuit: { circuit_json: [], tsx_code: 'x' },
    }).project;
    const data = toProjectData(project, { custom: 1, currentStep: 'welcome' });
    expect(data).toMatchObject({
      custom: 1,
      currentStep: 'input',
      userInput: 'Build a buck',
      selectedTopologyForSketch: { name: 'dcdc_buck', rationale: 'simple' },
      circuitVisualizationData: { circuit_json: [] },
    });
    expect(
      (data.circuitVisualizationData as Record<string, unknown>).tsx_code,
    ).toBeUndefined();
    expect(legacyProgress(data).completed).toBe(3);
  });

  it('converts legacy wizard data into a main-branch graph', () => {
    const studio = fromLegacyProject({
      userInput: 'Old project',
      initialSpecification: {
        specification: { derivedParametersList: [{ name: 'Vin', value: 48 }] },
      },
      selectedTopologyForSketch: { name: 'Buck Converter', rationale: 'r' },
    });
    const stages = Object.values(studio.nodes).map((n) => n.stage);
    expect(stages).toEqual(['specs', 'visualization']);
    expect(stageNodeOnBranch(studio, 'visualization')?.data.topologyId).toBe(
      'dcdc_buck',
    );
    expect(loadStudioProject({ studio }).nodes).toEqual(studio.nodes);
  });
});

describe('topology names', () => {
  it.each([
    ['dcdc_buck', 'dcdc_buck'],
    ['DC-DC Flyback Converter', 'dcdc_flyback'],
    ['dual active bridge (dab)', 'dcdc_dual_active_bridge'],
    ['Dual Active Bridge (DAB) Converter', 'dcdc_dual_active_bridge'],
    ['DC-DC Zeta Converter', 'dcdc_zeta'],
    ['Something New', 'something_new'],
  ])('maps %s -> %s', (input, expected) => {
    expect(mapTopologyNameToBackend(input)).toBe(expected);
  });

  it('humanizes ids', () => {
    expect(humanizeTopology('dcdc_buck_boost')).toBe('Buck Boost · DC-DC');
    expect(humanizeTopology('custom_x')).toBe('custom x');
  });
});
