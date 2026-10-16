import {
  STAGE_LABEL,
  STAGE_ORDER,
  type StageKind,
  type StudioScope,
} from '../../projects/studio/studio-graph';
import { allowedStages, isFullScope } from '../../projects/studio/studio-scope';

/**
 * What each stage needs to run (its input contract) and which agent tools
 * belong to it. Missing inputs are decided here, deterministically; the
 * model only extracts values from the conversation and judges intent.
 */

export interface StageInput {
  /** Stable key the model passes back (`values[].name` may be key or label). */
  key: string;
  label: string;
  unit: string | null;
  required: boolean;
  /** Inputs sharing a group are alternatives: any one of them is enough. */
  group?: string;
  /** A ready result of one of these stages provides the value. */
  satisfiedBy?: StageKind[];
  /** Cannot be typed in: it comes from an earlier stage or an attachment. */
  artifact?: 'netlist' | 'design';
  /** Earlier step to suggest when an artifact input is missing. */
  redirect?: StageKind;
  /** Typical value shown as the table's suggestion. */
  suggestion?: string;
}

export interface StageContract {
  stage: StageKind;
  /** One line for the step chooser and the prompt. */
  summary: string;
  /** Tools that run this stage (running one locks the entry step). */
  tools: string[];
  /** Tools allowed only to capture this stage's inputs when it is the entry step. */
  prerequisiteTools: string[];
  inputs: StageInput[];
  /** Pre-written prompt of the tool selector (the client may show it). */
  template: string;
}

const LOAD = 'load';
const CURRENT = 'current';

export const STAGE_CONTRACTS: Record<StageKind, StageContract> = {
  specs: {
    stage: 'specs',
    summary:
      'Full design from scratch: requirements, specification table, constraints and topology choice, then every later step.',
    tools: [
      'update_specs',
      'generate_constraints',
      'update_constraints',
      'suggest_topologies',
    ],
    prerequisiteTools: [],
    template: 'Design a complete converter: ',
    inputs: [
      { key: 'vin', label: 'Input voltage', unit: 'V', required: true },
      { key: 'vout', label: 'Output voltage', unit: 'V', required: true },
      {
        key: 'pout',
        label: 'Output power',
        unit: 'W',
        required: true,
        group: LOAD,
      },
      {
        key: 'iout',
        label: 'Output current',
        unit: 'A',
        required: true,
        group: LOAD,
      },
      {
        key: 'ambient',
        label: 'Ambient temperature',
        unit: '°C',
        required: true,
      },
      { key: 'isolation', label: 'Isolation', unit: null, required: false },
      {
        key: 'efficiency',
        label: 'Efficiency target',
        unit: '%',
        required: false,
      },
    ],
  },
  visualization: {
    stage: 'visualization',
    summary: 'Show a library topology as a schematic with its components.',
    tools: ['select_topology', 'edit_circuit'],
    prerequisiteTools: [],
    template: 'Show me the schematic of a ',
    inputs: [
      { key: 'topology', label: 'Topology', unit: null, required: true },
    ],
  },
  design: {
    stage: 'design',
    summary:
      'Size every component of a topology (L, C, switches) and build its netlists.',
    tools: ['run_design', 'modify_design', 'set_design_values'],
    prerequisiteTools: ['select_topology', 'update_specs'],
    template: 'Size the components of a ',
    inputs: [
      {
        key: 'topology',
        label: 'Topology',
        unit: null,
        required: true,
        satisfiedBy: ['visualization'],
      },
      {
        key: 'vin',
        label: 'Input voltage',
        unit: 'V',
        required: true,
        satisfiedBy: ['specs'],
      },
      {
        key: 'vout',
        label: 'Output voltage',
        unit: 'V',
        required: true,
        satisfiedBy: ['specs'],
      },
      {
        key: 'pout',
        label: 'Output power',
        unit: 'W',
        required: true,
        group: LOAD,
        satisfiedBy: ['specs'],
      },
      {
        key: 'iout',
        label: 'Output current',
        unit: 'A',
        required: true,
        group: LOAD,
        satisfiedBy: ['specs'],
      },
      {
        key: 'fsw',
        label: 'Switching frequency',
        unit: 'kHz',
        required: false,
        satisfiedBy: ['specs'],
      },
    ],
  },
  simulation: {
    stage: 'simulation',
    summary:
      'Run ngspice on a design or on your own .cir netlist: waveforms, measurements, losses.',
    tools: ['run_simulation'],
    prerequisiteTools: ['import_netlist'],
    template: 'Simulate my circuit (netlist attached): ',
    inputs: [
      {
        key: 'netlist',
        label: 'Netlist (.cir file or a design)',
        unit: null,
        required: true,
        satisfiedBy: ['design'],
        artifact: 'netlist',
        redirect: 'design',
      },
      {
        key: 'topology',
        label: 'Topology of the netlist',
        unit: null,
        required: false,
        satisfiedBy: ['visualization'],
      },
    ],
  },
  devices: {
    stage: 'devices',
    summary:
      'Pick MOSFETs, IGBTs and diodes from the device library and compute their losses.',
    tools: ['select_devices'],
    prerequisiteTools: [],
    template: 'Pick a power device for ',
    inputs: [
      {
        key: 'kind',
        label: 'Device type (switch / diode)',
        unit: null,
        required: true,
        satisfiedBy: ['simulation'],
        suggestion: 'switch',
      },
      {
        key: 'v_block',
        label: 'Blocking voltage',
        unit: 'V',
        required: true,
        satisfiedBy: ['simulation'],
      },
      {
        key: 'fsw',
        label: 'Switching frequency',
        unit: 'kHz',
        required: true,
        satisfiedBy: ['simulation'],
      },
      {
        key: 'i_peak',
        label: 'Peak current',
        unit: 'A',
        required: true,
        group: CURRENT,
        satisfiedBy: ['simulation'],
      },
      {
        key: 'i_rms',
        label: 'RMS current',
        unit: 'A',
        required: true,
        group: CURRENT,
        satisfiedBy: ['simulation'],
      },
      { key: 'duty', label: 'Duty cycle', unit: null, required: false },
    ],
  },
  magnetics: {
    stage: 'magnetics',
    summary:
      'Design inductors and transformers: core, turns, gap, wire, core and copper losses.',
    tools: ['design_magnetics'],
    prerequisiteTools: [],
    template: 'Design the magnetics for ',
    inputs: [
      {
        key: 'kind',
        label: 'Part type (inductor / flyback / transformer / resonant)',
        unit: null,
        required: true,
        satisfiedBy: ['simulation'],
        suggestion: 'inductor',
      },
      {
        key: 'inductance',
        label: 'Inductance',
        unit: 'µH',
        required: true,
        satisfiedBy: ['simulation'],
      },
      {
        key: 'i_dc',
        label: 'DC current',
        unit: 'A',
        required: true,
        group: CURRENT,
        satisfiedBy: ['simulation'],
      },
      {
        key: 'i_peak',
        label: 'Peak current',
        unit: 'A',
        required: true,
        group: CURRENT,
        satisfiedBy: ['simulation'],
      },
      {
        key: 'i_rms',
        label: 'RMS current',
        unit: 'A',
        required: true,
        group: CURRENT,
        satisfiedBy: ['simulation'],
      },
      {
        key: 'fsw',
        label: 'Switching frequency',
        unit: 'kHz',
        required: true,
        satisfiedBy: ['simulation'],
      },
      {
        key: 'turns_ratio',
        label: 'Turns ratio (transformers)',
        unit: null,
        required: false,
      },
      {
        key: 'v_primary',
        label: 'Primary voltage (transformers)',
        unit: 'V',
        required: false,
      },
      {
        key: 'ripple',
        label: 'Ripple current (peak-peak)',
        unit: 'A',
        required: false,
      },
    ],
  },
  thermal: {
    stage: 'thermal',
    summary:
      'Loss budget, junction temperatures and heatsink sizing from losses or a simulation.',
    tools: ['run_thermal'],
    prerequisiteTools: [],
    template: 'Check the thermals: ',
    inputs: [
      {
        key: 'device_losses',
        label: 'Device losses (per device)',
        unit: 'W',
        required: true,
        satisfiedBy: ['simulation', 'devices'],
      },
      {
        key: 'ambient',
        label: 'Ambient temperature',
        unit: '°C',
        required: true,
        satisfiedBy: ['specs'],
        suggestion: '40',
      },
      {
        key: 'magnetics_losses',
        label: 'Magnetics losses',
        unit: 'W',
        required: false,
        satisfiedBy: ['magnetics'],
      },
      {
        key: 'pout',
        label: 'Output power (for efficiency)',
        unit: 'W',
        required: false,
      },
    ],
  },
  emc: {
    stage: 'emc',
    summary:
      'Conducted-emissions scan of a PFC input filter (108-264 V) against the EN 55015 limit.',
    tools: ['run_emc'],
    prerequisiteTools: [],
    template: 'Check conducted EMI of my PFC input filter: ',
    inputs: [
      {
        key: 'pfc_inductor',
        label: 'PFC inductor',
        unit: 'mH',
        required: true,
      },
      { key: 'dc_bus', label: 'DC bus voltage', unit: 'V', required: true },
      { key: 'input_power', label: 'Input power', unit: 'W', required: true },
      {
        key: 'input_rms',
        label: 'Input RMS voltage',
        unit: 'V',
        required: true,
        suggestion: '230',
      },
      {
        key: 'cap_1',
        label: 'First input capacitor (X)',
        unit: 'nF',
        required: true,
      },
      {
        key: 'cap_2',
        label: 'Second input capacitor (X)',
        unit: 'nF',
        required: true,
      },
      {
        key: 'filter_inductor',
        label: 'Input filter inductor',
        unit: 'mH',
        required: true,
      },
      {
        key: 'margin',
        label: 'Pass margin',
        unit: 'dB',
        required: false,
        suggestion: '6',
      },
      {
        key: 'lisn',
        label: 'LISN resistance',
        unit: 'Ω',
        required: false,
        suggestion: '50',
      },
    ],
  },
  components: {
    stage: 'components',
    summary:
      'Choose real parts for every component (capacitors, resistors, inductors, semiconductors), with supplier part numbers when sourcing is available.',
    tools: ['select_components'],
    prerequisiteTools: [],
    template: 'Select parts for these components: ',
    inputs: [
      {
        key: 'parts',
        label: 'Components (designator, type, value, rating)',
        unit: null,
        required: true,
        satisfiedBy: ['design', 'devices', 'magnetics'],
      },
    ],
  },
  bom: {
    stage: 'bom',
    summary:
      'Bill of materials of the selected parts, with quantities and cost.',
    tools: ['build_bom'],
    prerequisiteTools: [],
    template: 'Build a bill of materials for: ',
    inputs: [
      {
        key: 'parts',
        label: 'Parts (designator, manufacturer, part number, quantity)',
        unit: null,
        required: true,
        satisfiedBy: ['components'],
      },
      {
        key: 'build_quantity',
        label: 'Build quantity',
        unit: 'units',
        required: false,
        suggestion: '1',
      },
    ],
  },
  mtbf: {
    stage: 'mtbf',
    summary:
      'Reliability prediction (MIL-HDBK-217F, Telcordia SR-332, IEC TR 62380, FIDES 2022): failure rates and system MTBF.',
    tools: ['run_mtbf'],
    prerequisiteTools: [],
    template: 'Estimate the MTBF of: ',
    inputs: [
      {
        key: 'method',
        label: 'Prediction method',
        unit: null,
        required: true,
        suggestion: 'MIL-HDBK-217F',
      },
      {
        key: 'environment',
        label: 'Environment',
        unit: null,
        required: true,
      },
      {
        key: 'parts',
        label: 'Parts (designator, type)',
        unit: null,
        required: true,
        satisfiedBy: ['components', 'bom'],
      },
      {
        key: 'temperature',
        label: 'Operating temperature',
        unit: '°C',
        required: false,
        satisfiedBy: ['thermal'],
      },
    ],
  },
};

/** Tools usable in any decided scope. */
const NEUTRAL_TOOLS = ['ask_user', 'open_view', 'manage_branch'];
/** Tools of the entry-step flow itself. */
export const SCOPE_TOOLS = [
  'choose_entry_step',
  'offer_entry_steps',
  'check_step_inputs',
] as const;
/** Agent tools of the stages added with entry steps (not in the core tool set). */
export const EXTRA_STAGE_TOOLS = [
  'run_emc',
  'select_components',
  'build_bom',
  'run_mtbf',
] as const;

/** The stage a tool runs (null: not a stage tool). */
export function stageOfTool(tool: string): StageKind | null {
  for (const stage of STAGE_ORDER) {
    if (STAGE_CONTRACTS[stage].tools.includes(tool)) return stage;
  }
  return null;
}

/**
 * Tools of a project with no step chosen: only the start of the full flow
 * (asking for the requirements, the spec table). Any later tool needs the
 * user's choice first, so the agent can never run a single step on its own.
 */
export const FULL_FLOW_START_TOOLS: ReadonlySet<string> = new Set([
  'ask_user',
  'update_specs',
  'open_view',
]);

/** Tools that only choose where a project starts (they never commit it to the full flow). */
export const ENTRY_CHOICE_TOOLS: ReadonlySet<string> = new Set([
  'choose_entry_step',
  'offer_entry_steps',
]);

/**
 * Tools the agent may call in a scope. Undecided: the full flow (its
 * default) plus choosing a step the user named, or offering the either/or
 * choice. Full flow: every tool. Entry step: the tools of the entry step and
 * every later step, the entry step's input-capturing tools, and the
 * entry-step tools (choosing again only until the entry step ran).
 */
export function allowedTools(scope: StudioScope): Set<string> {
  if (scope.mode === 'undecided') {
    return new Set([...FULL_FLOW_START_TOOLS, ...ENTRY_CHOICE_TOOLS]);
  }
  const out = new Set<string>(NEUTRAL_TOOLS);
  for (const stage of allowedStages(scope)) {
    for (const tool of STAGE_CONTRACTS[stage].tools) out.add(tool);
  }
  if (isFullScope(scope)) {
    out.add('import_netlist');
    out.add('edit_circuit');
    return out;
  }
  for (const tool of STAGE_CONTRACTS[scope.entry].prerequisiteTools) {
    out.add(tool);
  }
  out.add('check_step_inputs');
  if (!scope.locked) out.add('choose_entry_step');
  return out;
}

/** Why a tool is refused in this scope (null: allowed). */
export function toolRefusal(scope: StudioScope, tool: string): string | null {
  if (allowedTools(scope).has(tool)) return null;
  if (scope.mode === 'undecided') {
    const stage = stageOfTool(tool);
    return stage && stage !== 'specs'
      ? `No step was chosen, so ${STAGE_LABEL[stage]} cannot run yet. Call offer_entry_steps with step "${stage}" so the user can choose between it and starting from scratch. Ask for no inputs and give no results until they choose.`
      : 'No step was chosen: start the full design with the requirements (ask_user / update_specs), or call offer_entry_steps.';
  }
  if (tool === 'choose_entry_step') {
    return `The entry step (${STAGE_LABEL[scope.entry]}) already ran, so it can no longer change. Only later steps can follow.`;
  }
  const stage = stageOfTool(tool);
  return stage
    ? `This project starts at ${STAGE_LABEL[scope.entry]}; ${STAGE_LABEL[stage]} is not after it, so it cannot run here. Offer only the next steps.`
    : `${tool} is not available in this project.`;
}

// --- steps the user named ----------------------------------------------------------

/**
 * Words that name a step (or its tool) in a message. Deliberately narrow: a
 * request that only describes a step's job ("design a 47 µH inductor", "do I
 * need a heatsink?") names nothing, so the agent has to ask the either/or
 * question instead of starting the step itself.
 */
const STEP_NAMES: Record<StageKind, RegExp> = {
  specs: /\b(from scratch|full design|whole design|complete design)\b/,
  visualization:
    /\b(schematic|visuali[sz]ation|circuit (step|tool|stage|view))\b/,
  design:
    /\b(design (step|tool|stage)|component sizing|size (the |all )?(components|component values|values))\b/,
  simulation: /\b(simulat(e|ion|ions|ing)|ngspice|spice)\b/,
  devices:
    /\b(devices? (step|tool|stage|selection)|power devices?|device library)\b/,
  magnetics: /\b(magnetics?)\b/,
  thermal: /\b(thermals?)\b/,
  emc: /\b(emc|emi|conducted emissions?)\b/,
  components:
    /\b(component selection|components? (step|tool|stage)|select (the )?parts|parts? (selection|list)|part numbers?)\b/,
  bom: /\b(bom|bill of materials?)\b/,
  mtbf: /\b(mtbf|reliability (prediction|analysis|estimate))\b/,
};

/** The steps a user message names, in display order. */
export function namedSteps(text: string): StageKind[] {
  const lower = text.toLowerCase();
  return STAGE_ORDER.filter((stage) => STEP_NAMES[stage].test(lower));
}

// --- missing inputs ---------------------------------------------------------------

export interface InputCheck {
  stage: StageKind;
  /** Values the user gave, by input. */
  provided: Array<{ input: StageInput; value: string }>;
  /** Inputs an existing result on the branch provides. */
  fromResults: Array<{ input: StageInput; stage: StageKind }>;
  /** Required inputs (one per alternative group) nobody provided. */
  missing: StageInput[];
  /** Optional inputs nobody provided. */
  optional: StageInput[];
  /** A missing input only an earlier step (or an attachment) can provide. */
  blocked: { input: StageInput; redirect: StageKind | null } | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Finds the input a model-given name refers to (key or label, loosely). */
export function matchInput(
  contract: StageContract,
  name: string,
): StageInput | undefined {
  const n = norm(name);
  if (!n) return undefined;
  return (
    contract.inputs.find((i) => norm(i.key) === n || norm(i.label) === n) ??
    contract.inputs.find(
      (i) => norm(i.label).startsWith(n) || n.startsWith(norm(i.label)),
    )
  );
}

/**
 * Which inputs of `stage` are still missing, given the values the user gave,
 * the stages with ready results on the branch and the attached netlists.
 */
export function checkInputs(
  stage: StageKind,
  values: Array<{ name: string; value: string }>,
  ready: (stage: StageKind) => boolean,
  hasNetlist: boolean,
): InputCheck {
  const contract = STAGE_CONTRACTS[stage];
  const provided: InputCheck['provided'] = [];
  for (const v of values) {
    const value = v.value.trim();
    const input = matchInput(contract, v.name);
    if (input && value && !provided.some((p) => p.input.key === input.key)) {
      provided.push({ input, value });
    }
  }
  const fromResults: InputCheck['fromResults'] = [];
  for (const input of contract.inputs) {
    const by = input.satisfiedBy?.find((s) => ready(s));
    if (by && !provided.some((p) => p.input.key === input.key)) {
      fromResults.push({ input, stage: by });
    }
  }
  const has = (input: StageInput) =>
    provided.some((p) => p.input.key === input.key) ||
    fromResults.some((r) => r.input.key === input.key) ||
    (input.artifact === 'netlist' && hasNetlist);

  const missing: StageInput[] = [];
  const optional: StageInput[] = [];
  const groups = new Set<string>();
  for (const input of contract.inputs) {
    if (has(input)) continue;
    if (!input.required) {
      optional.push(input);
      continue;
    }
    if (input.group) {
      if (groups.has(input.group)) continue;
      groups.add(input.group);
      const members = contract.inputs.filter((i) => i.group === input.group);
      if (members.some(has)) continue;
    }
    missing.push(input);
  }
  const artifact = missing.find((i) => i.artifact);
  return {
    stage,
    provided,
    fromResults,
    missing,
    optional,
    blocked: artifact
      ? { input: artifact, redirect: artifact.redirect ?? null }
      : null,
  };
}

/** Label of an input with its alternatives (`Peak current or RMS current`). */
export function inputLabel(stage: StageKind, input: StageInput): string {
  if (!input.group) return input.label;
  return STAGE_CONTRACTS[stage].inputs
    .filter((i) => i.group === input.group)
    .map((i) => i.label)
    .join(' or ');
}
