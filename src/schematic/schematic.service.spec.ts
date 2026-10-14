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
