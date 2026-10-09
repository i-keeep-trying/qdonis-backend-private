import type {
  FunctionToolDefinition,
  JsonObject,
} from '../../ai/bedrock/bedrock.types';

/**
 * Studio agent tool registry: exact port of qdonis-core
 * `studio_agent.build_tools` (same names, descriptions, JSON schemas,
 * property order). Exactness is enforced by the parity fixtures under
 * test/parity/fixtures/studio-agent.
 */

/** Workspace stages, in display order (`STAGES` in the core). */
export const STUDIO_STAGES = [
  'specs',
  'visualization',
  'design',
  'simulation',
  'devices',
  'magnetics',
  'thermal',
] as const;

/** Tools whose result is the user's next message (the client stops the loop). */
export const BLOCKING_TOOLS: ReadonlySet<string> = new Set([
  'ask_user',
  'suggest_topologies',
]);

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

export function buildStudioTools(
  topologyIds: readonly string[],
): FunctionToolDefinition[] {
  const topologyEnum: JsonObject = topologyIds.length
    ? { type: 'string', enum: [...topologyIds] }
    : { type: 'string' };

  return [
    fn(
      'update_specs',
      "SPECS / COMPLIANCE tool. Writes rows into the editable specification table shown in the workspace (merged by parameter name; existing rows with the same name are replaced). Output: the specs artifact that the Design and Simulation tools consume. Set request_approval=true once the table is complete enough to design from; the user then approves, edits cells directly, or asks you for changes. Use 'remove' to delete rows by name.",
      {
        application: {
          type: 'string',
          description:
            "One-line summary of what is being designed, e.g. '67 W USB-PD wall charger'.",
        },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description:
                  "Human-readable parameter name, e.g. 'Input Voltage', 'Output Voltage', 'Output Power', 'Output Voltage Ripple', 'Switching Frequency', 'Efficiency'.",
              },
              value: {
                type: 'string',
                description:
                  "Value or range, e.g. '12', '90-264', '<= 1%'. Use 'TBD' only if the user explicitly deferred it.",
              },
              unit: {
                type: 'string',
                description:
                  "SI unit, e.g. 'V', 'VAC', 'W', 'A', 'kHz', '%', 'mV'.",
              },
              category: {
                type: 'string',
                enum: [
                  'electrical',
                  'performance',
                  'thermal',
                  'mechanical',
                  'compliance',
                  'other',
                ],
              },
              required: {
                type: 'boolean',
                description: 'True if the design cannot proceed without it.',
              },
              source: {
                type: 'string',
                enum: ['user', 'assumed', 'derived'],
                description:
                  "'user' = stated by the user, 'assumed' = your engineering assumption the user should confirm, 'derived' = computed from other rows.",
              },
              note: {
                type: 'string',
                description:
                  'Short rationale, especially for assumed/derived values.',
              },
            },
            required: ['name', 'value'],
          },
        },
        remove: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of rows to delete.',
        },
        request_approval: {
          type: 'boolean',
          description: 'Ask the user to review/approve the table.',
        },
        approved: {
          type: 'boolean',
          description:
            "Set true when the user approved the specs in chat (e.g. 'looks good', 'approved'). Pass rows: [] if nothing else changes.",
        },
      },
      ['rows'],
    ),
    fn(
      'generate_constraints',
      'CONSTRAINTS tool. Expands the key specification table into the FULL industrial engineering constraints list (the requirements matrix built before any design work): electrical input/source, output/load, functional constraints, component-technology limits, environmental & reliability, mechanical & form factor, compliance/regulatory, cost & production, schedule & risk, system-level interactions — each item with a value and reasoning, plus assumptions and references. Input: the specs on the active branch. Output: the list in the Specs tab (Constraints view); run_design receives it automatically. Takes about a minute. Constraints the user edited by hand are kept.',
      {
        notes: {
          type: 'string',
          description:
            "Optional extra guidance, e.g. 'automotive grade, AEC-Q101 parts' or 'focus on cost'.",
        },
      },
    ),
    fn(
      'update_constraints',
      'Edit the engineering constraints list (merged by name; edited items are marked as set by the user). Use when the user asks to change, add or drop a specific constraint. Use update_specs for the key spec values (voltages, power, ripple, efficiency, temperature) instead.',
      {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
              category: {
                type: 'string',
                enum: [
                  'electrical_input_source',
                  'electrical_output_load',
                  'functional_constraints',
                  'component_technology_limits',
                  'environmental_reliability',
                  'mechanical_form_factor',
                  'compliance_regulatory',
                  'cost_production',
                  'schedule_risk',
                  'system_level_interaction',
                ],
              },
              reasoning: { type: 'string' },
            },
            required: ['name', 'value'],
          },
        },
        remove: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of constraints to delete.',
        },
      },
    ),
    fn(
      'ask_user',
      "Ask the user a focused question and WAIT for the answer (ends your turn). Two forms:\n- `fields`: an editable value table rendered in the chat (Parameter | Value | Unit) for collecting SEVERAL numeric/text values at once: the key specs while there is no specification table yet, or the direct inputs of the one stage the user asked for (e.g. inductance, DC current, ripple and switching frequency for a standalone magnetics design; device losses for a standalone thermal check). Do not use it to re-collect values already in the workspace spec table: the user edits those there.\n- `options`: 2-5 short clickable choices for one discrete decision (e.g. 'Isolated' / 'Non-isolated').\nThe user can always type a free-form answer instead.",
      {
        question: {
          type: 'string',
          description: 'Markdown question text shown in the chat.',
        },
        fields: {
          type: 'array',
          description:
            'Rows of the in-chat value table (only before a spec table exists). 3-10 rows.',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: "Parameter name, e.g. 'Input Voltage'.",
              },
              unit: {
                type: 'string',
                description:
                  "Unit shown next to the cell, e.g. 'V', 'VAC', 'W', '°C'.",
              },
              suggestion: {
                type: 'string',
                description:
                  "Typical value shown as a placeholder hint (not pre-filled), e.g. '90-264'.",
              },
              required: {
                type: 'boolean',
                description: 'True if you cannot proceed without it.',
              },
              hint: {
                type: 'string',
                description:
                  "Very short clarification, e.g. 'range or nominal'.",
              },
            },
            required: ['name'],
          },
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['label'],
          },
        },
        multi_select: { type: 'boolean' },
      },
      ['question'],
    ),
    fn(
      'suggest_topologies',
      "Present 1-4 candidate topologies as selectable cards in the chat and WAIT for the user's pick (ends your turn). Input: the approved specs. Only use topology ids from the available library. Mark exactly one as recommended when you have a preference.",
      {
        intro: {
          type: 'string',
          description:
            'One or two sentences of reasoning shown above the cards.',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              topology_id: topologyEnum,
              title: { type: 'string' },
              summary: {
                type: 'string',
                description: 'Why it fits these specs (1-2 sentences).',
              },
              pros: { type: 'array', items: { type: 'string' } },
              cons: { type: 'array', items: { type: 'string' } },
              recommended: { type: 'boolean' },
            },
            required: ['topology_id', 'title', 'summary'],
          },
        },
      },
      ['options'],
    ),
    fn(
      'select_topology',
      "VISUALISATION tool. Input: a topology id from the library. Loads the circuit schematic for that topology and shows it in the workspace. Output: the visualisation artifact (topology + schematic) that Design consumes. Use it when the user picks a topology card, names a topology directly ('show me a boost converter'), or wants to change topology.",
      { topology_id: topologyEnum, reason: { type: 'string' } },
      ['topology_id'],
    ),
    fn(
      'run_design',
      'DESIGN tool. Inputs: selected topology (required) + specs table (strongly recommended). Runs the component-sizing optimiser and builds the SPICE decks. Output: the design artifact (calculated component values table, AI reasoning, .cir netlists) shown as tables in the workspace. Takes up to a minute or two. Re-running discards manual design edits.',
      {
        notes: {
          type: 'string',
          description: 'Optional extra guidance for the optimiser.',
        },
      },
    ),
    fn(
      'modify_design',
      "DESIGN tool. Input: the current design artifact + a natural-language instruction (e.g. 'reduce output ripple below 20 mV', 'use a smaller inductor', 'meet 95% efficiency'). An AI engineer edits component values in the netlist and explains why. Output: an updated design artifact.",
      { instruction: { type: 'string' } },
      ['instruction'],
    ),
    fn(
      'set_design_values',
      'DESIGN tool. Directly set specific component values in the design table (e.g. L1 -> 22uH) and, by default, sync them into the .cir netlist so the next simulation uses them.',
      {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: {
                type: 'string',
                description:
                  "Component reference, e.g. 'L1', 'C_out', 'R_load'.",
              },
              value: {
                type: 'string',
                description:
                  "New value with SPICE suffix, e.g. '22u', '100uF', '4.7'.",
              },
              param: {
                type: 'string',
                description:
                  'Optional parameter name if the ref has several rows.',
              },
            },
            required: ['ref', 'value'],
          },
        },
        sync_netlist: { type: 'boolean' },
      },
      ['changes'],
    ),
    fn(
      'run_simulation',
      "SIMULATION tool. Input: the design artifact's .cir netlists (or an imported netlist) + topology. Runs ngspice (DC/AC/transient as available) and the loss engine. Output: the simulation artifact (measurements, waveforms, loss breakdown) shown in the workspace, plus a summary returned to you. Takes up to a few minutes.",
      {
        analyses: {
          type: 'array',
          items: { type: 'string', enum: ['dc', 'ac', 'transient'] },
          description: 'Subset to run; omit to run every deck the design has.',
        },
      },
    ),
    fn(
      'import_netlist',
      'Turn the .cir file the user attached in chat into a design artifact so it can be simulated or modified. You must infer (or ask for) which library topology it corresponds to, because the simulator uses the topology to structure measurements.',
      {
        topology_id: topologyEnum,
        attachment_name: {
          type: 'string',
          description:
            'File name of the attachment; defaults to the most recent .cir.',
        },
      },
      ['topology_id'],
    ),
    fn(
      'edit_circuit',
      "VISUALISATION tool for STRUCTURAL changes: add, remove or rewire components (e.g. add an RC snubber across a switch, add an input LC filter, remove a clamp, add a second output). An AI engineer edits the topology YAML and the schematic together; the result is validated by generating the netlist. Always creates a new branch (the original circuit is kept). Afterwards run_design (then run_simulation) must be re-run because the old design belongs to the old circuit. Check the circuit's component list first: do not add parts that already exist. For value-only changes use set_design_values / modify_design instead.",
      {
        instruction: {
          type: 'string',
          description:
            'Precise structural change, naming the parts/nodes involved and intended values.',
        },
      },
      ['instruction'],
    ),
    fn(
      'select_devices',
      "DEVICES tool, usable on its own: choose the power semiconductors from the device library and evaluate their losses. Two input modes:\n- STANDALONE: pass `devices` with each device's stresses. Nothing else is needed: no specs, design or simulation. Use this whenever the user asks for device / MOSFET / diode selection directly or there is no simulation on the branch. Required per device: ref, kind (switch | diode), v_block_v (peak blocking voltage), fsw_khz, and i_peak_a / i_rms_a / i_avg_a (one or more; peak + RMS gives the best current shape); optional duty (conduction fraction, default 0.5) and zvs (soft turn-on). Parts are evaluated on idealised waveforms built from those stresses; the result appears in the Devices tab and run_thermal uses its losses when there is no simulation.\n- SIMULATION: omit `devices` to choose from the SIMULATED waveforms of the branch (peak voltage, peak/RMS current, switching events) and redo the simulation's loss analysis with the parts. Runs automatically after the first simulation.\nBoth: every viable part is evaluated at the junction temperature; the lowest-loss part with an adequate voltage class (>= 1.3x peak) and a sensible current size wins, and devices in the same circuit position share a part. Allowed kinds: switch = MOSFET with built-in diode, or IGBT + external antiparallel diode; diode = discrete diode. Call it again to change the technology preference or to force specific parts; a re-run without `devices` keeps the previously entered stresses unless from_simulation is true.",
      {
        devices: {
          type: 'array',
          description:
            'Standalone mode: the switches / diodes and their stresses.',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: "Name, e.g. 'Q1', 'D1'." },
              kind: { type: 'string', enum: ['switch', 'diode'] },
              v_block_v: {
                type: 'number',
                description: 'Peak blocking voltage, V.',
              },
              fsw_khz: { type: 'number' },
              i_peak_a: { type: 'number' },
              i_rms_a: { type: 'number' },
              i_avg_a: { type: 'number' },
              duty: {
                type: 'number',
                description: 'Conduction fraction, 0..1 (default 0.5).',
              },
              zvs: {
                type: 'boolean',
                description:
                  'Zero-voltage (soft) turn-on, e.g. resonant / phase-shifted bridges.',
              },
            },
            required: ['ref', 'kind'],
          },
        },
        fsw_khz: {
          type: 'number',
          description:
            'Switching frequency for every entered device that does not set its own.',
        },
        junction_temperature_c: {
          type: 'number',
          description:
            "Tj for the loss evaluation (default: the specs' value, else 100 C).",
        },
        from_simulation: {
          type: 'boolean',
          description:
            'Select from the branch simulation instead of previously entered stresses.',
        },
        preference: {
          type: 'string',
          enum: ['auto', 'mosfet', 'igbt'],
          description: 'Switch technology preference.',
        },
        overrides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              part: { type: 'string', description: 'Library part number.' },
              diode: {
                type: 'string',
                description: 'Antiparallel diode part for an IGBT (optional).',
              },
            },
            required: ['ref', 'part'],
          },
        },
      },
    ),
    fn(
      'design_magnetics',
      "MAGNETICS tool, usable on its own. Two input modes:\n- STANDALONE: pass `parts` with each part's values. Nothing else is needed: no specs, topology, design or simulation. Use this whenever the user asks for magnetics directly or there is no circuit on the branch. Required per kind: inductor = inductance_uh, i_dc_a (i_ripple_pp_a, duty optional); flyback = inductance_uh (magnetizing), turns_ratio, v_primary_v (input voltage), i_peak_a or power_w; transformer = turns_ratio, v_primary_v, i_rms_a or power_w; resonant = inductance_uh, i_peak_a or i_rms_a. Every part also needs fsw_khz (per part or top-level).\n- CIRCUIT: omit `parts` to design every inductor/transformer of the circuit on the active branch (needs at least a selected topology; uses the design values and the simulated winding waveforms when they exist, otherwise idealised waveforms from the specs).\nMethod: flux from the winding volt-seconds, core loss by iGSE, copper loss split into DC/low-frequency and per-harmonic AC loss (Dowell), air gap with fringing, temperature rise. Searches cores (smallest first, stacking up to 3), materials and turns for minimum loss within the flux, window fill and temperature limits. Output: magnetics artifact shown in the workspace. A re-run without `parts` keeps the previously entered parts unless from_circuit is true.",
      {
        parts: {
          type: 'array',
          description:
            'Standalone mode: the magnetic parts to design from these values.',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: "Name, e.g. 'L1', 'T1'." },
              kind: {
                type: 'string',
                enum: ['inductor', 'flyback', 'transformer', 'resonant'],
              },
              role: {
                type: 'string',
                description: "Optional, e.g. 'buck output inductor'.",
              },
              inductance_uh: {
                type: 'number',
                description:
                  'Inductance, or magnetizing inductance for flyback/transformer, µH.',
              },
              turns_ratio: { type: 'number', description: 'Ns/Np.' },
              fsw_khz: { type: 'number' },
              duty: {
                type: 'number',
                description: 'Duty of the energising interval, 0..1.',
              },
              i_dc_a: {
                type: 'number',
                description: 'Inductor DC (average) current, A.',
              },
              i_ripple_pp_a: {
                type: 'number',
                description:
                  'Inductor peak-to-peak ripple, A (default 30 % of I_dc).',
              },
              i_peak_a: {
                type: 'number',
                description: 'Primary peak current (flyback, resonant), A.',
              },
              i_rms_a: {
                type: 'number',
                description: 'Primary RMS current (transformer, resonant), A.',
              },
              v_primary_v: {
                type: 'number',
                description:
                  'Primary winding voltage (transformer) or input voltage (flyback), V.',
              },
              power_w: {
                type: 'number',
                description:
                  'Throughput power, W; used to estimate currents that are not given.',
              },
              unipolar: {
                type: 'boolean',
                description:
                  'Forward-converter transformer (flux 0 -> ΔB only).',
              },
            },
            required: ['ref', 'kind'],
          },
        },
        fsw_khz: {
          type: 'number',
          description:
            'Switching frequency for every entered part that does not set its own.',
        },
        from_circuit: {
          type: 'boolean',
          description:
            "Design the branch circuit's magnetics instead of previously entered parts.",
        },
        material: {
          type: 'string',
          description:
            'Ferrite material, e.g. 3C95, 3C97, 3F36, 4F1, N27. Default: best of a frequency short list.',
        },
        max_flux_density_t: {
          type: 'number',
          description:
            'Absolute peak-flux limit in tesla (default 80 % of Bsat at the hotspot temperature).',
        },
        current_density_a_mm2: {
          type: 'number',
          description: 'Winding current density, default 5 A/mm2.',
        },
        max_temp_rise_c: {
          type: 'number',
          description: 'Allowed temperature rise of the part, default 40 C.',
        },
        ambient_c: { type: 'number' },
        core_overrides: {
          type: 'array',
          items: {
            type: 'object',
            properties: { ref: { type: 'string' }, core: { type: 'string' } },
            required: ['ref', 'core'],
          },
          description:
            "Force a core for a part, e.g. {ref: 'T1', core: 'ETD39'}.",
        },
      },
    ),
    fn(
      'run_thermal',
      'THERMAL tool, usable on its own. Two input modes:\n- STANDALONE: pass `devices` (and optionally `magnetics_losses`, `other_losses`, `output_power_w`) with the losses. Nothing else is needed: no design or simulation. Use this whenever the user asks for a thermal / heatsink check directly or there is no simulation on the branch. Parts designed in the magnetics stage of this branch are added automatically unless entered here.\n- SIMULATION: omit them to build the full LOSS BUDGET from the branch simulation: semiconductors (loss engine), magnetics (magnetics stage, or winding resistance only if not designed), capacitor ESR, resistors (snubbers, damping, sense), gate drive; load resistors give the output power and efficiency; device losses are iterated at the computed junction temperature (electro-thermal loop).\nBoth compute junction temperatures with and without a heatsink, size a shared heatsink and check magnetics hotspots. A re-run without inputs keeps the previously entered losses unless from_simulation is true.',
      {
        devices: {
          type: 'array',
          description:
            'Standalone mode: power semiconductors and their losses.',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              kind: { type: 'string', enum: ['switch', 'diode'] },
              loss_w: {
                type: 'number',
                description:
                  'Total die loss, W (or give conduction + switching).',
              },
              conduction_loss_w: { type: 'number' },
              switching_loss_w: { type: 'number' },
              technology: {
                type: 'string',
                enum: ['Si', 'SiC', 'GaN', 'IGBT'],
              },
            },
            required: ['ref'],
          },
        },
        magnetics_losses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              loss_w: { type: 'number' },
              temp_rise_c: { type: 'number' },
            },
            required: ['ref', 'loss_w'],
          },
        },
        other_losses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              category: {
                type: 'string',
                enum: ['capacitor', 'resistor', 'gate_drive'],
              },
              loss_w: { type: 'number' },
            },
            required: ['ref', 'category', 'loss_w'],
          },
        },
        output_power_w: {
          type: 'number',
          description: 'For the efficiency figure (defaults to the specs).',
        },
        from_simulation: {
          type: 'boolean',
          description:
            'Use the branch simulation instead of previously entered losses.',
        },
        ambient_c: { type: 'number' },
        max_junction_c: {
          type: 'number',
          description: 'Override Tj,max for every device.',
        },
        heatsink: { type: 'string', enum: ['auto', 'none', 'shared'] },
        rth_cs: {
          type: 'number',
          description:
            'Case-to-sink thermal resistance in C/W (pad + grease), default 0.25.',
        },
        margin_c: {
          type: 'number',
          description: 'Design margin below Tj,max, default 25 C.',
        },
      },
    ),
    fn(
      'open_view',
      'Focus a stage view in the workspace without changing anything.',
      {
        stage: {
          type: 'string',
          enum: [
            'specs',
            'visualization',
            'design',
            'simulation',
            'devices',
            'magnetics',
            'thermal',
          ],
        },
      },
      ['stage'],
    ),
    fn(
      'manage_branch',
      "Version control for the project. Branches are created AUTOMATICALLY when an earlier stage is changed after later stages exist, so you rarely need this. Use it when the user explicitly wants to: 'create' an alternative from a stage on the current branch (fork_from_stage), 'switch' to another branch by name, or 'rename' the current branch.",
      {
        action: { type: 'string', enum: ['create', 'switch', 'rename'] },
        name: {
          type: 'string',
          description: 'Branch name to create / switch to / rename to.',
        },
        fork_from_stage: {
          type: 'string',
          enum: [
            'specs',
            'visualization',
            'design',
            'simulation',
            'devices',
            'magnetics',
            'thermal',
          ],
          description:
            "For 'create': the new branch keeps everything BEFORE this stage.",
        },
      },
      ['action'],
    ),
  ];
}
