import { STAGE_ORDER } from '../../projects/studio/studio-graph';
import { FULL_SCOPE } from '../../projects/studio/studio-scope';
import { buildStudioRequest } from './studio-request.builder';
import { buildStudioTools } from './studio-tools';
import {
  allowedTools,
  checkInputs,
  namedSteps,
  stageOfTool,
  STAGE_CONTRACTS,
  toolRefusal,
} from './stage-contracts';
import { scopeAddendum, scopedTools } from './studio-scope-agent';

const none = () => false;
const thermal = {
  mode: 'entry' as const,
  entry: 'thermal' as const,
  locked: false,
};

describe('stage contracts', () => {
  it('has a contract and a tool for every stage', () => {
    for (const stage of STAGE_ORDER) {
      expect(STAGE_CONTRACTS[stage].tools.length).toBeGreaterThan(0);
      for (const tool of STAGE_CONTRACTS[stage].tools) {
        expect(stageOfTool(tool)).toBe(stage);
      }
    }
  });

  it('is ready when every required input is given', () => {
    const check = checkInputs(
      'magnetics',
      [
        { name: 'kind', value: 'inductor' },
        { name: 'Inductance', value: '47' },
        { name: 'DC current', value: '10' },
        { name: 'fsw', value: '100' },
      ],
      none,
      false,
    );
    expect(check.missing).toEqual([]);
    expect(check.blocked).toBeNull();
  });

  it('needs only one input of an alternative group', () => {
    const check = checkInputs(
      'magnetics',
      [
        { name: 'kind', value: 'inductor' },
        { name: 'inductance', value: '47' },
        { name: 'fsw', value: '100' },
      ],
      none,
      false,
    );
    expect(check.missing.map((i) => i.key)).toEqual(['i_dc']);
    expect(
      checkInputs(
        'magnetics',
        [
          { name: 'kind', value: 'inductor' },
          { name: 'inductance', value: '47' },
          { name: 'fsw', value: '100' },
          { name: 'RMS current', value: '9' },
        ],
        none,
        false,
      ).missing,
    ).toEqual([]);
  });

  it('takes inputs from ready results on the branch', () => {
    const check = checkInputs('thermal', [], (s) => s === 'devices', false);
    expect(check.missing.map((i) => i.key)).toEqual(['ambient']);
    expect(check.fromResults.map((r) => r.input.key)).toContain(
      'device_losses',
    );
  });

  it('blocks a BOM without a circuit, pointing at Circuit', () => {
    expect(checkInputs('bom', [], none, false).blocked).toMatchObject({
      redirect: 'visualization',
    });
    expect(
      checkInputs('bom', [], (s) => s === 'visualization', false).blocked,
    ).toBeNull();
  });

  it('blocks a simulation without a design or a netlist, pointing at Design', () => {
    const blocked = checkInputs('simulation', [], none, false);
    expect(blocked.blocked).toMatchObject({ redirect: 'design' });
    expect(checkInputs('simulation', [], none, true).blocked).toBeNull();
    expect(
      checkInputs('simulation', [], (s) => s === 'design', false).blocked,
    ).toBeNull();
  });
});

describe('steps named in a message', () => {
  it.each([
    ['Design a 47 µH inductor for 10 A DC at 100 kHz.', []],
    ['Q1 dissipates 6 W, do I need a heatsink?', []],
    ['Pick a MOSFET for a 400 V boost converter.', []],
    ["I'm working on a 65 W USB-C charger for laptops.", []],
    ['Design a 48 V to 12 V, 10 A buck converter.', []],
    ['Use the magnetics tool: 47 µH, 10 A, 100 kHz', ['magnetics']],
    ['Run the thermal analysis: Q1 loses 6 W', ['thermal']],
    ['Check the thermals: D1 1.2 W', ['thermal']],
    ['Simulate this netlist.', ['simulation']],
    ['Do the device selection for a 400 V boost', ['simulation']],
    ['Estimate the MTBF and build the BOM', ['mtbf', 'bom']],
    ['Check conducted EMI of my PFC filter', ['emc']],
    ['Select parts for these components: C1 47 µF', ['components']],
    ['Show me the schematic of a flyback', ['visualization']],
    ['Size the components of a buck', ['design']],
  ])('%s -> %j', (text, expected) => {
    expect(namedSteps(text)).toEqual(expected);
  });
});

describe('tool gating', () => {
  it('gives an undecided project only the start of the full flow and the entry choice', () => {
    expect([...allowedTools({ mode: 'undecided' })].sort()).toEqual([
      'ask_user',
      'choose_entry_step',
      'offer_entry_steps',
      'open_view',
      'update_specs',
    ]);
    // A step's own tool needs the user's choice first.
    expect(toolRefusal({ mode: 'undecided' }, 'design_magnetics')).toMatch(
      /offer_entry_steps with step "magnetics"/,
    );
    expect(
      toolRefusal({ mode: 'undecided' }, 'check_step_inputs'),
    ).not.toBeNull();
  });

  it('refuses upstream tools and allows downstream ones', () => {
    expect(toolRefusal(thermal, 'run_thermal')).toBeNull();
    expect(toolRefusal(thermal, 'run_mtbf')).toBeNull();
    expect(toolRefusal(thermal, 'run_simulation')).toMatch(/not after it/);
    expect(toolRefusal(thermal, 'update_specs')).not.toBeNull();
    expect(toolRefusal(thermal, 'choose_entry_step')).toBeNull();
    expect(
      toolRefusal({ ...thermal, locked: true }, 'choose_entry_step'),
    ).toMatch(/can no longer change/);
  });

  it('lets a Design entry record its topology and specs', () => {
    const design = {
      mode: 'entry' as const,
      entry: 'design' as const,
      locked: false,
    };
    expect(toolRefusal(design, 'select_topology')).toBeNull();
    expect(toolRefusal(design, 'update_specs')).toBeNull();
    expect(toolRefusal(design, 'suggest_topologies')).not.toBeNull();
  });

  it('keeps every core tool for a full project', () => {
    const allowed = allowedTools(FULL_SCOPE);
    for (const tool of buildStudioTools([])) {
      expect(allowed.has(tool.function.name)).toBe(true);
    }
    expect(allowed.has('choose_entry_step')).toBe(false);
  });
});

describe('scoped request', () => {
  const base = {
    modelId: 'm',
    messages: [],
    projectState: {},
    topologyIds: ['dcdc_buck'],
    signal: new AbortController().signal,
  };
  const names = (scope: Parameters<typeof scopedTools>[1]) =>
    scopedTools(buildStudioTools(['dcdc_buck']), scope).map(
      (t) => t.function.name,
    );

  it('is unchanged without a scope', () => {
    const plain = buildStudioRequest(base);
    expect(plain.system?.[0]).not.toContain('## Entry steps');
    expect(plain.toolConfig?.tools).toHaveLength(buildStudioTools([]).length);
  });

  it('offers only the tools of the scope', () => {
    expect(names({ scope: thermal, ready: [], next: [] })).toEqual(
      expect.arrayContaining(['run_thermal', 'check_step_inputs', 'run_mtbf']),
    );
    expect(names({ scope: thermal, ready: [], next: [] })).not.toContain(
      'run_simulation',
    );
    expect(names({ scope: FULL_SCOPE, ready: [], next: [] })).toHaveLength(21);
  });

  it('adds `assumed` to stage tools of a single-step project', () => {
    const tool = scopedTools(buildStudioTools([]), {
      scope: thermal,
      ready: [],
      next: [],
    }).find((t) => t.function.name === 'run_thermal');
    expect(
      (tool?.function.parameters as { properties: Record<string, unknown> })
        .properties.assumed,
    ).toBeDefined();
  });

  it('explains the scope in the prompt', () => {
    const undecided = scopeAddendum({
      scope: { mode: 'undecided' },
      ready: [],
      next: [],
    });
    expect(undecided).toMatch(/full design by default/);
    expect(undecided).toMatch(/NEVER start at a single step on your own/);
    expect(undecided).toMatch(/latest message names: NONE/);
    expect(
      scopeAddendum({
        scope: { mode: 'undecided' },
        ready: [],
        next: [],
        named: ['thermal'],
      }),
    ).toMatch(/latest message names: `thermal`/);
    const text = scopeAddendum({ scope: thermal, ready: [], next: [] });
    expect(text).toMatch(/starts at Thermal/);
    expect(text).toMatch(/Never run, offer or suggest/);
  });
});
