import type {
  FunctionToolDefinition,
  JsonObject,
} from '../../ai/bedrock/bedrock.types';
import {
  STAGE_LABEL,
  STAGE_ORDER,
  type StageKind,
  type StudioScope,
} from '../../projects/studio/studio-graph';
import {
  allowedStages,
  downstreamOf,
  isFullScope,
} from '../../projects/studio/studio-scope';
import { MTBF_METHODS } from '../../studio-stages/dto/stages.dto';
import {
  allowedTools,
  inputLabel,
  STAGE_CONTRACTS,
  stageOfTool,
} from './stage-contracts';

/**
 * The entry-step half of the Studio agent request: extra tools (choosing
 * the entry step, checking inputs, the EMC / components / BOM / MTBF
 * stages), the tool allow-list of the project's scope and the prompt
 * section that explains the scope. Only used when a scope is passed, so the
 * scope-less request stays byte-identical to qdonis-core.
 */

export interface AgentScope {
  scope: StudioScope;
  /** Allowed stages with a ready result on the active branch. */
  ready: StageKind[];
  /** Steps that may be offered next. */
  next: StageKind[];
  /** Steps the user's latest message names (decided by the server, not the model). */
  named?: StageKind[];
}

function fn(
  name: string,
  description: string,
  properties: JsonObject,
  required: string[] = [],
): FunctionToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
  };
}

const stageEnum = { type: 'string', enum: [...STAGE_ORDER] };

const PARTS_SCHEMA: JsonObject = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'Designator, e.g. C1, Q1, L1.' },
      type: {
        type: 'string',
        description:
          'capacitor, resistor, inductor, transformer, mosfet, igbt, diode, ic, connector, ...',
      },
      value: {
        type: 'string',
        description: 'Value with unit, e.g. "47 µF", "10 kΩ", "22 µH".',
      },
      rating: {
        type: 'string',
        description: 'Voltage / current / power rating, e.g. "50 V", "3 A".',
      },
      manufacturer: { type: 'string' },
      part_number: { type: 'string' },
      quantity: { type: 'integer' },
      description: { type: 'string' },
    },
    required: ['ref', 'type'],
  },
};

const ASSUMED: JsonObject = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Names of the inputs YOU assumed (the user did not give them). Shown to the user as assumptions.',
};

/** Tools added by entry steps, in the order they are offered. */
function extraTools(): FunctionToolDefinition[] {
  return [
    fn(
      'choose_entry_step',
      "Set the step this project starts at, when the user named one step (or picked one). 'specs' means a full design from scratch. The step's inputs are checked in the same call: follow the returned input_check status exactly as for check_step_inputs (never build your own input table). Later steps stay available; earlier ones never do. Allowed until the entry step has run.",
      {
        step: stageEnum,
        reason: {
          type: 'string',
          description: 'One short line: why this step.',
        },
        values: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['name', 'value'],
          },
          description:
            "Every input value the user already gave for this step (the step's inputs are checked at once).",
        },
        assume_missing: {
          type: 'boolean',
          description:
            'True ONLY when the user said these are all their inputs and you should work out the rest.',
        },
      },
      ['step'],
    ),
    fn(
      'offer_entry_steps',
      "Ask the user an either/or question: start at ONE specific step, or start from scratch (the full design). Use it only when the request looks like the job of one step but the user did not name that step or attach its tool. Ends your turn; the user's click arrives as the next message.",
      {
        step: {
          type: 'string',
          enum: STAGE_ORDER.filter((s) => s !== 'specs'),
          description: 'The one step the request looks like.',
        },
        recommended: {
          type: 'string',
          enum: ['step', 'scratch'],
          description: 'Which option you recommend.',
        },
        reason: {
          type: 'string',
          description: 'One line tied to the request: why you recommend it.',
        },
      },
      ['step', 'recommended', 'reason'],
    ),
    fn(
      'check_step_inputs',
      "Check, before running a step, which of its required inputs are still missing. Pass EVERY value the user gave for that step (from their messages, attachments or tables). The server decides what is missing: 'ready' -> run the step now; 'assume' -> assume the listed inputs, run the step, then list your assumptions; 'needs_input' -> a value table was shown, stop and wait; 'needs_earlier_step' -> a choice to start earlier was shown, stop and wait.",
      {
        step: stageEnum,
        values: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Input key or label (see the step contract).',
              },
              value: { type: 'string' },
            },
            required: ['name', 'value'],
          },
        },
        assume_missing: {
          type: 'boolean',
          description:
            'True ONLY when the user said these are all the inputs they have and you should work out the rest yourself.',
        },
      },
      ['step', 'values', 'assume_missing'],
    ),
    fn(
      'run_emc',
      'EMC tool: conducted-emissions scan of a PFC boost input filter over 108-264 V against the EN 55015 limit (worst-case margin per input voltage, pass/fail). All values are entered directly.',
      {
        pfc_inductor_mh: { type: 'number' },
        ht_rail_voltage_v: { type: 'number', description: 'DC bus voltage.' },
        input_power_w: { type: 'number' },
        input_rms_voltage_v: { type: 'number' },
        first_input_cap_nf: { type: 'number' },
        second_input_cap_nf: { type: 'number' },
        input_filter_inductor_mh: { type: 'number' },
        pass_margin_db: { type: 'number', description: 'Default 6 dB.' },
        lisn_resistance_ohm: { type: 'number', description: 'Default 50 Ω.' },
        assumed: ASSUMED,
      },
      [
        'pfc_inductor_mh',
        'ht_rail_voltage_v',
        'input_power_w',
        'input_rms_voltage_v',
        'first_input_cap_nf',
        'second_input_cap_nf',
        'input_filter_inductor_mh',
      ],
    ),
    fn(
      'select_components',
      'COMPONENT SELECTION tool: the parts list of the design with a real part per component. STANDALONE from entered `parts`, or omit `parts` to take the components of the branch (design values, selected devices, designed magnetics). With search_supplier=true the supplier catalogue is searched for parts without a part number (only when sourcing is configured on the server).',
      {
        parts: PARTS_SCHEMA,
        search_supplier: { type: 'boolean' },
        assumed: ASSUMED,
      },
    ),
    fn(
      'build_bom',
      'BOM tool: bill of materials (lines, quantities, unit and extended prices, stock) from the parts of the Components stage, or from entered `parts`.',
      {
        parts: PARTS_SCHEMA,
        build_quantity: {
          type: 'integer',
          description: 'Boards to build; multiplies every quantity. Default 1.',
        },
        assumed: ASSUMED,
      },
    ),
    fn(
      'run_mtbf',
      'MTBF tool: failure rate per part and system MTBF. Parts come from `parts`, else the Components / BOM stage; temperatures from `temperature_c`, else the Thermal stage.',
      {
        method: { type: 'string', enum: [...MTBF_METHODS] },
        environment: {
          type: 'string',
          description:
            'Environment of the method, e.g. "Ground, Benign" or "Ground, Fixed" (MIL-HDBK-217F).',
        },
        parts: PARTS_SCHEMA,
        temperature_c: {
          type: 'number',
          description: 'Operating temperature of every part.',
        },
        assumed: ASSUMED,
      },
      ['method', 'environment'],
    ),
  ];
}

/** Adds `assumed` to a stage tool's schema (entry-step projects record provenance). */
function withAssumed(tool: FunctionToolDefinition): FunctionToolDefinition {
  const params = tool.function.parameters as JsonObject;
  const properties = params.properties as JsonObject;
  if ('assumed' in properties) return tool;
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: {
        ...params,
        properties: { ...properties, assumed: ASSUMED },
      },
    },
  };
}

/** The core tools filtered to the scope, plus the entry-step tools it allows. */
export function scopedTools(
  core: FunctionToolDefinition[],
  agent: AgentScope,
): FunctionToolDefinition[] {
  const allowed = allowedTools(agent.scope);
  const all = [...core, ...extraTools()].filter((t) =>
    allowed.has(t.function.name),
  );
  if (agent.scope.mode === 'undecided' || isFullScope(agent.scope)) return all;
  return all.map((t) => (stageOfTool(t.function.name) ? withAssumed(t) : t));
}

function stepLines(stages: readonly StageKind[]): string {
  return stages
    .map(
      (s) =>
        `- \`${s}\` — ${s === 'specs' ? 'Start from scratch' : STAGE_LABEL[s]}: ${STAGE_CONTRACTS[s].summary}`,
    )
    .join('\n');
}

function contractLines(stage: StageKind): string {
  const contract = STAGE_CONTRACTS[stage];
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const input of contract.inputs) {
    if (input.group) {
      if (seen.has(input.group)) continue;
      seen.add(input.group);
    }
    const from = input.satisfiedBy?.length
      ? ` (or from a ${input.satisfiedBy.map((s) => STAGE_LABEL[s]).join(' / ')} result)`
      : '';
    rows.push(
      `  - \`${input.key}\` ${inputLabel(stage, input)}${input.unit ? ` [${input.unit}]` : ''}: ${input.required ? 'required' : 'optional'}${from}`,
    );
  }
  return `- ${STAGE_LABEL[stage]} (${contract.tools.join(', ')}):\n${rows.join('\n')}`;
}

const ENTRY_RULES = `## Entry steps
A project either covers the whole design ("start from scratch") or starts at ONE step and only moves forward
from it. The steps a project may run are decided by the app; tools outside them are not available.`;

/** The prompt section describing the scope (appended to the system prompt). */
export function scopeAddendum(agent: AgentScope): string {
  const { scope } = agent;
  if (scope.mode === 'undecided') {
    const named = (agent.named ?? []).filter((s) => s !== 'specs');
    return `\n${ENTRY_RULES}

## This project: no step chosen (full design by default)
Steps the user's latest message names: ${named.length ? named.map((s) => `\`${s}\``).join(', ') : 'NONE'}. Only these may be
started with \`choose_entry_step\`; the app refuses any other step.
The user did not attach a tool. NEVER start at a single step on your own judgement. Until the user chooses, only
the start of the full design is available (ask_user for the requirements, update_specs); the stage tools of the
other steps do not exist yet, so do not promise or describe running them:
- Default: follow the full design conversation above (start from scratch). Asking for the requirements or writing
  the spec table makes this a full-design project.
- The user explicitly NAMES one step or tool (e.g. "do the thermal analysis", "run the MTBF", "use the magnetics
  tool", "just the EMC check", "simulate this .cir file") -> call \`choose_entry_step\` with that step, then check
  its inputs.
- The request looks like the job of one step but does not name it (e.g. "design a 47 µH inductor", "do I need a
  heatsink for 6 W?") -> call \`offer_entry_steps\` with that step: the user clicks "Start at <step>" or "Start
  from scratch". Do not ask for any inputs before they choose.
- The user asks what Q can do, or about the tools -> explain the steps below briefly (one line each) and what each
  needs; do not call a tool.
Steps:
${stepLines(STAGE_ORDER)}
`;
  }
  if (isFullScope(scope)) {
    return `\n${ENTRY_RULES}

## This project: full design (start from scratch)
Follow the full design conversation above. After thermal, these steps are also available — offer them when
useful, never run them unasked: \`run_emc\` (EMC), \`select_components\` (Components), \`build_bom\` (BOM),
\`run_mtbf\` (MTBF).
`;
  }
  const entry = scope.entry;
  const allowed = allowedStages(scope);
  const upstream = STAGE_ORDER.filter((s) => !allowed.includes(s));
  const later = downstreamOf(entry);
  const prereq = STAGE_CONTRACTS[entry].prerequisiteTools;
  return `\n${ENTRY_RULES}

## This project: starts at ${STAGE_LABEL[entry]} (single-step project)
It overrides the full design conversation above: the user wants ${STAGE_LABEL[entry]}${later.length ? ' and possibly later steps' : ''}, nothing earlier.
- Allowed steps: ${allowed.map((s) => STAGE_LABEL[s]).join(', ')}. Never run, offer or suggest ${upstream.length ? upstream.map((s) => STAGE_LABEL[s]).join(', ') : 'other steps'}.
${prereq.length ? `- ${prereq.map((t) => `\`${t}\``).join(' / ')} may be used ONLY to record inputs of ${STAGE_LABEL[entry]} the user gave (e.g. the topology, the electrical values); they are not separate steps.\n` : ''}- Before running a step, call \`check_step_inputs\` with every value the user gave for it and follow the status it
  returns. Set \`assume_missing: true\` only when the user said those are all their inputs and you should do the rest.
- When you assume values, pass their names in the stage tool's \`assumed\` argument, and after the result list them
  in a short table (input, value you used, why).
- ${scope.locked ? `${STAGE_LABEL[entry]} has run: the entry step is fixed.` : `Until ${STAGE_LABEL[entry]} runs the user may still change their mind: then call \`choose_entry_step\` with the new step. If an input only an earlier step can provide is missing, \`check_step_inputs\` shows the user the choice to start earlier.`}
- After a step runs, offer the next steps available: ${agent.next.length ? agent.next.map((s) => STAGE_LABEL[s]).join(', ') : later.length ? `once a step is done: ${later.map((s) => STAGE_LABEL[s]).join(', ')}` : 'none (this is the last step)'}. Do not start them unasked.
Inputs of the allowed steps:
${allowed.map(contractLines).join('\n')}
`;
}
