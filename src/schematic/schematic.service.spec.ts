import type { HttpException } from '@nestjs/common';

import { CircuitInfoService } from '../circuits/circuit-info.service';
import type { ProjectAccessService } from '../projects/project-access.service';
import type { ProjectsService } from '../projects/projects.service';
import {
  commitStage,
  createEmptyProject,
  stageNodeOnBranch,
  type JsonObject,
  type StudioProject,
} from '../projects/studio/studio-graph';
import type { StudioGraphService } from '../projects/studio/studio-graph.service';
import { TopologiesRepository } from '../topologies/topologies.repository';
import { TopologiesService } from '../topologies/topologies.service';
import { VisualizationService } from '../visualization/visualization.service';
import type { VisualizationData } from '../visualization/visualization.types';
import type { SchematicSymbol } from './schematic.types';
import { SchematicService } from './schematic.service';
import type { DesignSizingService } from '../simulation/sizing/design-sizing.service';
import type { SimulationRunsService } from '../simulation/simulation-runs.service';
import { SimulationService } from '../simulation/simulation.service';
import type { DesignData } from '../simulation/simulation.types';

const USER = { id: 'u1', role: 'USER' } as const;
const PROJECT = '00000000-0000-4000-8000-000000000001';

/** In-memory Studio graph behind the services the schematic uses. */
function setup(topologyId = 'dcdc_buck') {
  let studio: StudioProject = createEmptyProject();
  let revision = 1;
  let canEdit = true;
  let beforeMutate: ((s: StudioProject) => StudioProject) | null = null;
  const access = {
    require: jest.fn((_u: unknown, _p: string, permission: string) => {
      if (permission === 'canEdit' && !canEdit) {
        throw Object.assign(new Error('read only'), { status: 403 });
      }
      return Promise.resolve({});
    }),
  } as unknown as ProjectAccessService;
  const projects = {
    loadStudio: jest.fn(() => Promise.resolve(structuredClone(studio))),
    mutateStudio: jest.fn(
      (
        _p: string,
        _u: string,
        mutate: (s: StudioProject) => StudioProject,
        branchId?: string,
      ) => {
        let current = structuredClone(studio);
        if (beforeMutate) current = beforeMutate(current);
        if (branchId) current.activeBranchId = branchId;
        studio = mutate(current);
        revision += 1;
        return Promise.resolve({ revision });
      },
    ),
  } as unknown as ProjectsService;
  const graph = {
    stage: jest.fn(
      (_p: string, _u: string, branchId: string, stage: 'visualization') =>
        Promise.resolve(stageNodeOnBranch(studio, stage, branchId)),
    ),
  } as unknown as StudioGraphService;
  return {
    access,
    projects,
    graph,
    get studio() {
      return studio;
    },
    readOnly: () => {
      canEdit = false;
    },
    /** Someone else changes the graph between the read and the write. */
    raceWith: (change: (s: StudioProject) => StudioProject) => {
      beforeMutate = change;
    },
    init(
      service: SchematicService,
      topologies: TopologiesService,
      circuits: CircuitInfoService,
    ) {
      const vis = new VisualizationService(
        access,
        projects,
        graph,
        topologies,
        circuits,
      ).build(topologyId);
      studio = commitStage(
        studio,
        'visualization',
        vis as unknown as JsonObject,
        { source: 'user' },
      ).project;
      return { service, branchId: studio.activeBranchId };
    },
  };
}

describe('SchematicService', () => {
  let topologies: TopologiesService;
  let circuits: CircuitInfoService;

  beforeAll(async () => {
    const repository = new TopologiesRepository();
    await repository.onModuleInit();
    topologies = new TopologiesService(repository);
    circuits = new CircuitInfoService(topologies);
  });

  const make = (topologyId?: string) => {
    const env = setup(topologyId);
    const service = new SchematicService(
      env.access,
      env.projects,
      env.graph,
      topologies,
      circuits,
    );
    const { branchId } = env.init(service, topologies, circuits);
    return { env, service, branchId };
  };

  const drawingOf = (r: {
    schematic: { components: SchematicSymbol[]; wires: unknown[] };
  }) =>
    structuredClone({
      components: r.schematic.components,
      wires: r.schematic.wires,
    });

  it('draws the library circuit with its saved layout', async () => {
    const { service, branchId } = make();
    const r = await service.render(USER, PROJECT, branchId, {});
    expect(r.basis).toBe('saved');
    expect(r.libraryLayout).toEqual({ present: true, tuned: true });
    expect(r.schematic.components.some((c) => c.id === 'L1')).toBe(true);
    expect(r.schematic.symbols).toBeDefined();
    expect(r.palette.length).toBeGreaterThan(20);
  });

  it('reports an unknown sheet as 404', async () => {
    const { service, branchId } = make();
    await expect(
      service.render(USER, PROJECT, branchId, { sheet: 'nope' }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('checks an unedited drawing as layout only', async () => {
    const { service, branchId } = make();
    const drawn = drawingOf(await service.render(USER, PROJECT, branchId, {}));
    const check = await service.check(USER, PROJECT, branchId, {
      schematic: drawn,
    });
    expect(check).toMatchObject({
      layoutOnly: true,
      errors: [],
      inventory: null,
    });
  });

  it('keeps a move in place and draws it from then on', async () => {
    const { env, service, branchId } = make();
    const drawn = drawingOf(await service.render(USER, PROJECT, branchId, {}));
    const l1 = drawn.components.find((c) => c.id === 'L1') as SchematicSymbol;
    l1.x = (l1.x ?? 0) + 200;
    const nodesBefore = Object.keys(env.studio.nodes).length;
    const applied = await service.apply(USER, PROJECT, branchId, {
      schematic: drawn,
    });
    expect(applied.forked).toBe(false);
    expect(Object.keys(env.studio.nodes)).toHaveLength(nodesBefore);
    const data = applied.node?.data as unknown as VisualizationData;
    expect(data.customCircuit).toBeNull();
    const again = await service.render(USER, PROJECT, branchId, {});
    expect(again.schematic.components.find((c) => c.id === 'L1')?.x).toBe(l1.x);
  });

  it('records a value edit as an edited circuit that is drawn and netlisted', async () => {
    const { service, branchId } = make();
    const drawn = drawingOf(await service.render(USER, PROJECT, branchId, {}));
    const l1 = drawn.components.find((c) => c.id === 'L1') as SchematicSymbol;
    l1.parameters.inductance = '68u';
    const check = await service.check(USER, PROJECT, branchId, {
      schematic: drawn,
    });
    expect(check.layoutOnly).toBe(false);
    expect(check.paramChanges).toEqual([
      expect.objectContaining({ ref: 'L1', param: 'inductance', value: '68u' }),
    ]);
    expect(check.inventory?.magnetics[0]?.inductance).toBe('68 µH');

    const applied = await service.apply(USER, PROJECT, branchId, {
      schematic: drawn,
    });
    const data = applied.node?.data as unknown as VisualizationData;
    expect(data.customStructure).toBe(true);
    expect(data.customCircuit).toBeDefined();
    expect(data.customCircuit?.schematic).toBeUndefined();
    expect(data.edits).toHaveLength(1);
    expect(data.netlist).toContain('6.8e-05');
    const again = await service.render(USER, PROJECT, applied.branchId, {});
    expect(
      again.schematic.components.find((c) => c.id === 'L1')?.parameters
        .inductance,
    ).toBe('68u');
    expect(again.basis).toBe('saved');
  });

  it('refuses an edit with errors and stores nothing', async () => {
    const { env, service, branchId } = make();
    const drawn = drawingOf(await service.render(USER, PROJECT, branchId, {}));
    drawn.components.push({
      id: 'CNEW1',
      type: 'C',
      x: 0,
      y: -400,
      rotation: 0,
      mirrorX: false,
      mirrorY: false,
      parameters: {},
      display: '',
      meta: { pins: {} },
    });
    const before = structuredClone(env.studio);
    await expect(
      service.apply(USER, PROJECT, branchId, { schematic: drawn }),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        code: 'SCHEMATIC_INVALID',
      }) as unknown,
    });
    expect(env.studio).toEqual(before);
  });

  it('rejects a malformed drawing', async () => {
    const { service, branchId } = make();
    const error = (await service
      .check(USER, PROJECT, branchId, {
        schematic: { components: [{ id: 'X', type: 'R', x: 'a', y: 0 }] },
      })
      .catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(400);
  });

  it('edits an already edited circuit', async () => {
    const { service, branchId } = make();
    const drawn = drawingOf(await service.render(USER, PROJECT, branchId, {}));
    (
      drawn.components.find((c) => c.id === 'L1') as SchematicSymbol
    ).parameters.inductance = '68u';
    await service.apply(USER, PROJECT, branchId, {
      schematic: structuredClone(drawn),
    });
    const moved = structuredClone(drawn);
    (
      moved.components.find((c) => c.id === 'L1') as SchematicSymbol
    ).parameters.inductance = '33u';
    const second = await service.apply(USER, PROJECT, branchId, {
      schematic: moved,
    });
    expect(
      (second.node?.data as unknown as VisualizationData).edits,
    ).toHaveLength(2);
  });

  it('refuses an edit when the circuit changed meanwhile', async () => {
    const { env, service, branchId } = make();
    const drawn = drawingOf(await service.render(USER, PROJECT, branchId, {}));
    (
      drawn.components.find((c) => c.id === 'L1') as SchematicSymbol
    ).parameters.inductance = '68u';
    env.raceWith((s) => {
      const node = stageNodeOnBranch(s, 'visualization', branchId);
      if (node) s.nodes[node.id] = { ...node, rev: node.rev + 1 };
      return s;
    });
    await expect(
      service.apply(USER, PROJECT, branchId, { schematic: drawn }),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('needs edit rights to change the circuit', async () => {
    const { env, service, branchId } = make();
    const drawn = drawingOf(await service.render(USER, PROJECT, branchId, {}));
    env.readOnly();
    await expect(
      service.apply(USER, PROJECT, branchId, { schematic: drawn }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.render(USER, PROJECT, branchId, {}),
    ).resolves.toBeDefined();
  });

  it('opens a group sheet of a controlled converter', async () => {
    const { service, branchId } = make(
      'acdc_single_phase_boost_power_factor_correction',
    );
    const top = await service.render(USER, PROJECT, branchId, {});
    expect(top.sheets.length).toBeGreaterThan(0);
    const sheet = await service.render(USER, PROJECT, branchId, {
      sheet: top.sheets[0].id,
    });
    expect(sheet.sheet.id).toBe(top.sheets[0].id);
    expect(sheet.schematic.components.some((c) => c.type === 'PORT')).toBe(
      true,
    );
  });
});

describe('an edited circuit is designed and simulated', () => {
  let topologies: TopologiesService;
  let circuits: CircuitInfoService;

  beforeAll(async () => {
    const repository = new TopologiesRepository();
    await repository.onModuleInit();
    topologies = new TopologiesService(repository);
    circuits = new CircuitInfoService(topologies);
  });

  const make = () => {
    const env = setup('dcdc_buck');
    const enqueue = jest.fn(() => Promise.resolve());
    const schematic = new SchematicService(
      env.access,
      env.projects,
      env.graph,
      topologies,
      circuits,
    );
    const simulation = new SimulationService(
      env.access,
      env.projects,
      env.graph,
      topologies,
      null as never,
      { enqueue } as unknown as SimulationRunsService,
      null as never,
      null as never,
      null as unknown as DesignSizingService,
    );
    const { branchId } = env.init(schematic, topologies, circuits);
    return { env, schematic, simulation, enqueue, branchId };
  };

  /** Edits Cout's capacitance in the drawing and applies it. */
  const editCout = async (
    schematic: SchematicService,
    branchId: string,
    value: string,
  ) => {
    const r = await schematic.render(USER, PROJECT, branchId, {});
    const drawn = structuredClone({
      components: r.schematic.components,
      wires: r.schematic.wires,
    });
    const cout = drawn.components.find(
      (c) => c.id === 'Cout',
    ) as SchematicSymbol;
    cout.parameters.capacitance = value;
    return schematic.apply(USER, PROJECT, branchId, { schematic: drawn });
  };

  const designOf = (env: ReturnType<typeof make>['env'], branchId: string) =>
    stageNodeOnBranch(env.studio, 'design', branchId)?.data as unknown as
      DesignData | undefined;

  it('designs the edited circuit, not the library one', async () => {
    const { schematic, simulation, branchId } = make();
    await editCout(schematic, branchId, '470u');
    const design = await simulation.runDesign(USER, PROJECT, branchId);
    const data = design.node?.data as unknown as DesignData;
    expect(data.decks.transient).toContain('0.00047');
  });

  it('carries the design over when the designed circuit is edited', async () => {
    const { env, schematic, simulation, branchId } = make();
    await simulation.runDesign(USER, PROJECT, branchId);
    await simulation.setDesignValues(USER, PROJECT, branchId, [
      { ref: 'L1', param: 'inductance', value: '3.3e-05' },
    ]);
    const applied = await editCout(schematic, branchId, '470u');
    expect(applied.forked).toBe(true);
    expect(applied.designCarried).toBe(true);
    const carried = designOf(env, applied.branchId);
    expect(carried?.recalculatedParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: 'L1',
          param: 'inductance',
          after: '3.3e-05',
        }),
      ]),
    );
    expect(carried?.decks.transient).toContain('3.3e-05');
    // the design table row takes the value as typed in the schematic
    expect(carried?.decks.transient).toContain('Cout n_Cout_esr 0 470u');
    // The original branch keeps its circuit and design.
    expect(designOf(env, branchId)?.decks.transient).not.toContain('0.00047');
  });

  it('edits design values and queues the simulation on the edited circuit', async () => {
    const { simulation, schematic, enqueue, branchId } = make();
    const applied = await editCout(schematic, branchId, '470u');
    await simulation.runDesign(USER, PROJECT, applied.branchId);
    const edited = await simulation.setDesignValues(
      USER,
      PROJECT,
      applied.branchId,
      [{ ref: 'L1', param: 'inductance', value: '3.3e-05' }],
    );
    const decks = (edited.node?.data as unknown as DesignData).decks;
    expect(decks.transient).toContain('3.3e-05');
    expect(decks.transient).toContain('0.00047');
    await simulation.runSimulation(USER, PROJECT, applied.branchId, [
      'transient',
    ]);
    const queued = (
      enqueue.mock.calls[0] as unknown as [{ run: { circuit?: unknown } }]
    )[0];
    expect(queued.run.circuit).toEqual(
      expect.objectContaining({ components: expect.any(Array) as unknown }),
    );
  });
});
