import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import {
  normName,
  recordTopologyOptions,
  specsOf,
  type SpecCategory,
  type SpecSource,
  type StageOutcome,
  type TopologyOption,
  updateConstraints,
  updateSpecs,
} from '../design/studio-specs.logic';
import { ProjectsService } from '../projects/projects.service';
import { createBranch } from '../projects/studio/studio-branches';
import {
  isStageKind,
  stageNodeOnBranch,
  type JsonObject,
  type StageKind,
  type StudioProject,
} from '../projects/studio/studio-graph';
import { StudioGraphService } from '../projects/studio/studio-graph.service';
import { SimulationService } from '../simulation/simulation.service';
import {
  DECK_KINDS,
  type DeckKind,
  type RecalculatedParameter,
} from '../simulation/simulation.types';
import { SpecsService } from '../specs/specs.service';
import type { MagneticPartInput } from '../studio-stages/magnetics.stage';
import type { BomCategory, LineChoicePatch } from '../studio-stages/bom.stage';
import {
  MTBF_METHODS,
  MTBF_PART_TYPES,
  type MtbfMethod,
  type MtbfPartInput,
  type MtbfPartType,
} from '../studio-stages/mtbf.stage';
import { StudioStagesService } from '../studio-stages/studio-stages.service';
import type { ThermalInputs } from '../studio-stages/thermal.stage';
import { TopologiesService } from '../topologies/topologies.service';
import { VisualizationService } from '../visualization/visualization.service';
import {
  componentLine,
  constraintsPayload,
  describeSelection,
  designPayload,
  deviceLosses,
  list,
  rec,
  records,
  summarizeSimulation,
} from './agent-results';
import {
  type AttachmentRef,
  type ChatWidget,
  type StageResult,
  type ToolOutcome,
  VIEW_OF_STAGE,
} from './studio-chat.types';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;

/** An attachment of the conversation with the text the agent may read. */
export interface ChatAttachment extends AttachmentRef {
  text: string | null;
}

export interface ToolContext {
  user: Actor;
  projectId: string;
  /** The branch the run works on; moved when a result forks. */
  branchId: string;
  attachments: ChatAttachment[];
  signal: AbortSignal;
  /** Generates widget ids. */
  newId: (prefix: string) => string;
}

/** Chip label and stage of each tool (old frontend `TOOL_STATUS`, shortened). */
export const TOOL_INFO: Record<
  string,
  { label: string; stage: StageKind | null }
> = {
  update_specs: { label: 'Updating specs', stage: 'specs' },
  generate_constraints: { label: 'Building constraints', stage: 'specs' },
  update_constraints: { label: 'Updating constraints', stage: 'specs' },
  ask_user: { label: 'Asking you', stage: null },
  suggest_topologies: { label: 'Comparing topologies', stage: 'specs' },
  select_topology: { label: 'Loading the schematic', stage: 'visualization' },
  run_design: { label: 'Sizing components', stage: 'design' },
  modify_design: { label: 'Re-engineering the design', stage: 'design' },
  set_design_values: { label: 'Updating values', stage: 'design' },
  run_simulation: { label: 'Running ngspice', stage: 'simulation' },
  import_netlist: { label: 'Importing your netlist', stage: 'design' },
  edit_circuit: { label: 'Editing the circuit', stage: 'visualization' },
  select_devices: { label: 'Selecting devices', stage: 'simulation' },
  design_magnetics: { label: 'Designing magnetics', stage: 'magnetics' },
  run_thermal: { label: 'Solving the thermal network', stage: 'thermal' },
  run_mtbf: { label: 'Predicting the MTBF', stage: 'mtbf' },
  build_bom: { label: 'Building the BOM', stage: 'bom' },
  open_view: { label: 'Switching view', stage: null },
  manage_branch: { label: 'Updating branches', stage: null },
};

/** How often a queued stage run is checked, and for how long at most. */
const POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 15 * 60_000;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
/** A model-given scalar as text ('' for anything else). */
const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : '';
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const fail = (
  summary: string,
  extra: Record<string, unknown> = {},
): StageResult => ({
  ok: false,
  summary,
  payload: { error: summary, ...extra },
});

/** Errors that end the whole run (no tokens, AI or storage off) instead of the tool. */
const FATAL = new Set<number>([
  HttpStatus.UNAUTHORIZED,
  HttpStatus.PAYMENT_REQUIRED,
  HttpStatus.FORBIDDEN,
]);

const SPEC_CATEGORIES = new Set([
  'electrical',
  'performance',
  'thermal',
  'mechanical',
  'compliance',
  'other',
]);

function forkNote(
  forked: boolean,
  branchName: string,
): Record<string, unknown> {
  return forked
    ? {
        branch_created: branchName,
        note: `A new branch "${branchName}" was created so earlier results are preserved.`,
      }
    : { branch: branchName };
}

/** A stage-action response (`{ node, branchId, forked, branchName }`). */
interface Landed {
  node: { data: JsonObject; status: string; error: string | null; id: string };
  branchId: string;
  forked: boolean;
  branchName: string;
}

/**
 * Executes the Studio agent's tools on the server (the old frontend ran
 * them in `lib/studio/agent.ts` + `stages.ts`) through the same stage
 * services the workspace uses. Every tool returns what the model is told
 * plus what changed, so the chat can refresh the workspace.
 */
@Injectable()
export class StudioToolsExecutor {
  constructor(
    private readonly projects: ProjectsService,
    private readonly graph: StudioGraphService,
    private readonly specs: SpecsService,
    private readonly visualization: VisualizationService,
    private readonly simulation: SimulationService,
    private readonly stages: StudioStagesService,
    private readonly topologies: TopologiesService,
  ) {}

  async execute(
    ctx: ToolContext,
    name: string,
    input: JsonObject,
  ): Promise<ToolOutcome> {
    const stage = TOOL_INFO[name]?.stage ?? null;
    try {
      return await this.run(ctx, name, input);
    } catch (error) {
      if (
        ctx.signal.aborted ||
        (error instanceof HttpException && FATAL.has(error.getStatus()))
      ) {
        throw error;
      }
      const message =
        error instanceof HttpException
          ? messageOf(error)
          : error instanceof Error
            ? error.message
            : String(error);
      return this.outcome(ctx, fail(message), stage ? [stage] : []);
    }
  }

  private run(
    ctx: ToolContext,
    name: string,
    input: JsonObject,
  ): Promise<ToolOutcome> {
    switch (name) {
      case 'update_specs':
        return this.updateSpecs(ctx, input);
      case 'generate_constraints':
        return this.generateConstraints(ctx, str(input.notes));
      case 'update_constraints':
        return this.updateConstraints(ctx, input);
      case 'ask_user':
        return this.askUser(ctx, input);
      case 'suggest_topologies':
        return this.suggestTopologies(ctx, input);
      case 'select_topology':
        return this.selectTopology(
          ctx,
          text(input.topology_id),
          str(input.reason),
        );
      case 'run_design':
        return this.runDesign(ctx, str(input.notes));
      case 'modify_design':
        return this.modifyDesign(ctx, text(input.instruction));
      case 'set_design_values':
        return this.setDesignValues(ctx, input);
      case 'run_simulation':
        return this.runSimulation(ctx, input);
      case 'import_netlist':
        return this.importNetlist(ctx, input);
      case 'edit_circuit':
        return Promise.resolve(
          this.outcome(
            ctx,
            fail(
              'Structural circuit edits are not available. Use set_design_values or modify_design for value changes, or select another library topology.',
            ),
            [],
          ),
        );
      case 'select_devices':
        return this.selectDevices(ctx, input);
      case 'design_magnetics':
        return this.designMagnetics(ctx, input);
      case 'run_thermal':
        return this.runThermal(ctx, input);
      case 'run_mtbf':
        return this.runMtbf(ctx, input);
      case 'build_bom':
        return this.buildBom(ctx, input);
      case 'open_view':
        return Promise.resolve(this.openView(ctx, input));
      case 'manage_branch':
        return this.manageBranch(ctx, input);
      default:
        return Promise.resolve(
          this.outcome(ctx, fail(`Unknown tool ${name}`), []),
        );
    }
  }

  // --- specs ---------------------------------------------------------------------

  private async updateSpecs(ctx: ToolContext, input: JsonObject) {
    const rows = records(input.rows)
      .filter((r) => typeof r.name === 'string' && r.name.trim())
      .map((r) => ({
        name: String(r.name),
        value: text(r.value),
        unit: str(r.unit),
        category: SPEC_CATEGORIES.has(String(r.category))
          ? (r.category as SpecCategory)
          : undefined,
        required: typeof r.required === 'boolean' ? r.required : undefined,
        source: ['user', 'assumed', 'derived'].includes(String(r.source))
          ? (r.source as SpecSource)
          : undefined,
        note: str(r.note),
      }));
    const requestApproval = input.request_approval === true;
    const done = await this.apply(ctx, (studio) =>
      updateSpecs(
        studio,
        {
          application: str(input.application),
          rows,
          remove: list(input.remove).filter(
            (x): x is string => typeof x === 'string',
          ),
          requestApproval,
          approved: input.approved === true,
        },
        'agent',
      ),
    );
    const widget: ChatWidget | undefined =
      done.result.ok && requestApproval
        ? {
            id: ctx.newId('w'),
            kind: 'spec_approval',
            approved: false,
            resolution: null,
          }
        : undefined;
    return { ...this.outcome(ctx, done.result, ['specs'], 'specs'), widget };
  }

  private async generateConstraints(ctx: ToolContext, notes?: string) {
    const started = await this.specs.generateConstraints(
      ctx.user,
      ctx.projectId,
      ctx.branchId,
      notes,
    );
    this.land(ctx, started);
    await this.settle(ctx, 'specs', (node) => {
      return rec(node.data.constraints).status !== 'running';
    });
    const studio = await this.load(ctx);
    const specs = specsOf(stageNodeOnBranch(studio, 'specs'));
    const constraints = specs?.constraints;
    if (!specs || !constraints || constraints.status === 'error') {
      return this.outcome(
        ctx,
        fail(
          constraints?.error ?? 'The constraints list could not be generated.',
        ),
        ['specs'],
        'specs',
      );
    }
    return this.outcome(
      ctx,
      {
        ok: true,
        summary: `${constraints.items.length} engineering constraints generated`,
        payload: {
          ...constraintsPayload(specs),
          ...forkNote(started.forked, started.branchName),
          note: 'The full list is shown in the Specs tab under Constraints. run_design receives it automatically.',
        },
      },
      ['specs'],
      'specs',
    );
  }

  private async updateConstraints(ctx: ToolContext, input: JsonObject) {
    const items = records(input.items)
      .filter((i) => typeof i.name === 'string' && i.name.trim())
      .map((i) => ({
        name: String(i.name),
        value: text(i.value),
        category: str(i.category),
        reasoning: str(i.reasoning),
      }));
    const done = await this.apply(ctx, (studio) => {
      if (
        specsOf(stageNodeOnBranch(studio, 'specs'))?.constraints?.status ===
        'running'
      ) {
        return {
          project: studio,
          result: {
            ok: false,
            summary:
              'The constraints list is being generated. Wait for it to finish.',
          },
        };
      }
      return updateConstraints(
        studio,
        {
          items,
          remove: list(input.remove).filter(
            (x): x is string => typeof x === 'string',
          ),
        },
        'agent',
      );
    });
    return this.outcome(ctx, done.result, ['specs'], 'specs');
  }

  // --- conversation widgets ------------------------------------------------------

  private async askUser(ctx: ToolContext, input: JsonObject) {
    const prompt = text(input.question).trim();
    const studio = await this.load(ctx);
    // The in-chat value table is only for the first round of questions:
    // once a spec table exists, the user edits values there instead.
    const hasSpecs = Boolean(
      specsOf(stageNodeOnBranch(studio, 'specs'))?.rows.length,
    );
    const fields = hasSpecs
      ? []
      : records(input.fields).filter(
          (f) => typeof f.name === 'string' && f.name.trim(),
        );
    let widget: ChatWidget;
    let payload: Record<string, unknown>;
    if (fields.length) {
      widget = {
        id: ctx.newId('w'),
        kind: 'fields',
        prompt,
        fields: fields.map((f) => ({
          name: String(f.name).trim(),
          unit: str(f.unit) ?? null,
          suggestion: str(f.suggestion) ?? null,
          required: f.required === true,
        })),
        resolution: null,
      };
      payload = {
        displayed: 'value_table',
        note: "Editable value table shown in the chat. Stop here and wait for the user's filled-in values.",
      };
    } else {
      widget = {
        id: ctx.newId('w'),
        kind: 'question',
        prompt,
        options: records(input.options)
          .filter((o) => typeof o.label === 'string' && o.label.trim())
          .map((o, i) => ({ id: `o${i + 1}`, label: String(o.label).trim() })),
        multiple: input.multi_select === true,
        resolution: null,
      };
      payload = {
        displayed: true,
        note: "Shown to the user with the options. Stop here and wait for the user's reply.",
      };
    }
    return {
      ...this.outcome(
        ctx,
        { ok: true, summary: 'Question shown', payload },
        [],
      ),
      widget,
    };
  }

  private async suggestTopologies(ctx: ToolContext, input: JsonObject) {
    const options: TopologyOption[] = records(input.options)
      .map((o) => ({
        topology_id: this.topologies.resolveId(o.topology_id) ?? '',
        title: text(o.title),
        summary: text(o.summary),
        pros: list(o.pros).filter((x): x is string => typeof x === 'string'),
        cons: list(o.cons).filter((x): x is string => typeof x === 'string'),
        recommended: o.recommended === true,
      }))
      .filter((o) => o.topology_id);
    if (!options.length) {
      return this.outcome(
        ctx,
        fail('None of these topologies is in the library.', {
          available: this.topologies.ids(),
        }),
        [],
      );
    }
    await this.projects.mutateStudio(
      ctx.projectId,
      ctx.user.id,
      (studio) => recordTopologyOptions(studio, options),
      ctx.branchId,
    );
    const widget: ChatWidget = {
      id: ctx.newId('w'),
      kind: 'topologies',
      options: options.map((o) => ({
        topologyId: o.topology_id,
        title: o.title || this.topologies.title(o.topology_id),
        summary: o.summary,
        pros: o.pros ?? [],
        cons: o.cons ?? [],
        recommended: o.recommended === true,
      })),
      resolution: null,
    };
    return {
      ...this.outcome(
        ctx,
        {
          ok: true,
          summary: `${options.length} topology option${options.length === 1 ? '' : 's'} shown`,
          payload: {
            displayed: options.map((o) => o.topology_id),
            note: 'Cards shown in chat. Stop and wait for the user to pick one.',
          },
        },
        ['specs'],
      ),
      widget,
    };
  }

  // --- circuit / design ----------------------------------------------------------

  private async selectTopology(
    ctx: ToolContext,
    requested: string,
    reason?: string,
  ) {
    const topologyId = this.topologies.requireId(requested);
    const landed = (await this.visualization.selectTopology(
      ctx.user,
      ctx.projectId,
      ctx.branchId,
      topologyId,
    )) as unknown as Landed;
    this.land(ctx, landed);
    const inventory = rec(landed.node.data.inventory);
    return this.outcome(
      ctx,
      {
        ok: true,
        summary: `Schematic loaded · ${this.topologies.title(topologyId)}`,
        payload: {
          topology_id: topologyId,
          ...(reason ? { reason } : {}),
          schematic_elements: list(rec(landed.node.data.circuit).components)
            .length,
          components: records(inventory.components).map(componentLine),
          ...forkNote(landed.forked, landed.branchName),
        },
      },
      ['visualization'],
      'visualization',
      landed,
    );
  }

  private async runDesign(ctx: ToolContext, notes?: string) {
    const studio = await this.load(ctx);
    const usedSpecs = Boolean(
      specsOf(stageNodeOnBranch(studio, 'specs'))?.rows.length,
    );
    const started = (await this.simulation.runDesign(
      ctx.user,
      ctx.projectId,
      ctx.branchId,
      notes,
    )) as unknown as Landed;
    this.land(ctx, started);
    const node = await this.settle(
      ctx,
      'design',
      (n) => n.status !== 'running',
    );
    if (node.status === 'error') {
      return this.outcome(
        ctx,
        fail(
          `Design failed: ${node.error ?? 'unknown error'}`,
          forkNote(started.forked, started.branchName),
        ),
        ['design'],
        'design',
        started,
      );
    }
    const count = records(node.data.recalculatedParameters).length;
    return this.outcome(
      ctx,
      {
        ok: true,
        summary: `Design ready · ${count} component values`,
        payload: designPayload(node.data, {
          used_specs: usedSpecs,
          ...forkNote(started.forked, started.branchName),
        }),
      },
      ['design'],
      'design',
      started,
    );
  }

  private async modifyDesign(ctx: ToolContext, instruction: string) {
    if (!instruction.trim())
      return this.outcome(ctx, fail('Say what to change.'), []);
    const before = await this.load(ctx);
    const previous = new Map(
      (
        records(
          stageNodeOnBranch(before, 'design')?.data.recalculatedParameters,
        ) as unknown as RecalculatedParameter[]
      ).map((r) => [`${r.ref}.${r.param}`, r.after]),
    );
    const started = (await this.simulation.editDesign(
      ctx.user,
      ctx.projectId,
      ctx.branchId,
      'modify',
      instruction.trim(),
    )) as unknown as Landed;
    this.land(ctx, started);
    const node = await this.settle(
      ctx,
      'design',
      (n) => n.status !== 'running',
    );
    if (node.status === 'error') {
      return this.outcome(
        ctx,
        fail(
          `Modification failed: ${node.error ?? 'unknown error'}`,
          forkNote(started.forked, started.branchName),
        ),
        ['design'],
        'design',
        started,
      );
    }
    const changed = (
      records(
        node.data.recalculatedParameters,
      ) as unknown as RecalculatedParameter[]
    )
      .filter((r) => previous.get(`${r.ref}.${r.param}`) !== r.after)
      .map((r) => ({ ref: r.ref, param: r.param, value: r.after }));
    return this.outcome(
      ctx,
      {
        ok: true,
        summary: `Design modified · ${changed.length} values changed`,
        payload: designPayload(node.data, {
          changed,
          ...forkNote(started.forked, started.branchName),
        }),
      },
      ['design'],
      'design',
      started,
    );
  }

  private async setDesignValues(ctx: ToolContext, input: JsonObject) {
    const studio = await this.load(ctx);
    const design = stageNodeOnBranch(studio, 'design');
    const rows = records(
      design?.data.recalculatedParameters,
    ) as unknown as RecalculatedParameter[];
    if (!design || !rows.length) {
      return this.outcome(
        ctx,
        fail('No design table to edit yet. Run the design first.', {
          missing: 'design',
        }),
        [],
      );
    }
    const values: Array<{ ref: string; param: string; value: string }> = [];
    const unknown: string[] = [];
    for (const change of records(input.changes)) {
      const ref = text(change.ref).trim().toLowerCase();
      const param = str(change.param)?.toLowerCase();
      const row = rows.find(
        (r) =>
          r.ref.toLowerCase() === ref &&
          (!param || r.param.toLowerCase() === param),
      );
      const value = str(change.value);
      if (!row || !value) {
        unknown.push(text(change.ref));
        continue;
      }
      values.push({ ref: row.ref, param: row.param, value });
    }
    if (!values.length) {
      return this.outcome(
        ctx,
        fail(
          `None of these refs exist in the design table: ${unknown.join(', ')}`,
          { known_refs: [...new Set(rows.map((r) => r.ref))] },
        ),
        [],
      );
    }
    const landed = (await this.simulation.setDesignValues(
      ctx.user,
      ctx.projectId,
      ctx.branchId,
      values,
    )) as unknown as Landed;
    this.land(ctx, landed);
    const applied = values.map((v) => `${v.ref}.${v.param} = ${v.value}`);
    return this.outcome(
      ctx,
      {
        ok: true,
        summary: `Updated ${applied.length} value${applied.length > 1 ? 's' : ''} · netlist synced`,
        payload: {
          applied,
          unknown_refs: unknown.length ? unknown : undefined,
          netlist_synced: true,
          ...forkNote(landed.forked, landed.branchName),
        },
      },
      ['design'],
      'design',
      landed,
    );
  }

  private async importNetlist(ctx: ToolContext, input: JsonObject) {
    const name = str(input.attachment_name);
    const netlists = ctx.attachments.filter(
      (a) => a.kind === 'netlist' && a.text,
    );
    const attachment = name
      ? netlists.find((a) => a.name === name)
      : netlists[netlists.length - 1];
    if (!attachment?.text) {
      return this.outcome(
        ctx,
        fail(
          'No .cir attachment found. Ask the user to attach their netlist with the paperclip button.',
          { missing: 'netlist_attachment' },
        ),
        [],
      );
    }
    const topologyId = this.topologies.requireId(text(input.topology_id));
    const touched: StageKind[] = ['design'];
    let fork: Landed | null = null;
    const studio = await this.load(ctx);
    if (
      stageNodeOnBranch(studio, 'visualization')?.data.topologyId !== topologyId
    ) {
      const vis = (await this.visualization.selectTopology(
        ctx.user,
        ctx.projectId,
        ctx.branchId,
        topologyId,
      )) as unknown as Landed;
      this.land(ctx, vis);
      if (vis.forked) fork = vis;
      touched.unshift('visualization');
    }
    const landed = (await this.simulation.importDesign(
      ctx.user,
      ctx.projectId,
      ctx.branchId,
      { topologyId, fileName: attachment.name, text: attachment.text },
    )) as unknown as Landed;
    this.land(ctx, landed);
    const decks = rec(landed.node.data.decks);
    const [deck] = Object.keys(decks);
    const deckText = text(decks[deck]);
    return this.outcome(
      ctx,
      {
        ok: true,
        summary: `Imported ${attachment.name} as a ${deck} deck`,
        payload: {
          topology_id: topologyId,
          deck,
          has_control_block: /\.control/i.test(deckText),
          lines: deckText.split('\n').length,
          ...forkNote(
            Boolean(fork) || landed.forked,
            (fork ?? landed).branchName,
          ),
        },
      },
      touched,
      'design',
      fork ?? landed,
    );
  }

  // --- simulation / devices ------------------------------------------------------

  private async runSimulation(ctx: ToolContext, input: JsonObject) {
    const studio = await this.load(ctx);
    const design = stageNodeOnBranch(studio, 'design');
    const decks = rec(design?.data.decks);
    const available = DECK_KINDS.filter(
      (k) => typeof decks[k] === 'string' && String(decks[k]).trim(),
    );
    if (!design || !available.length) {
      return this.outcome(
        ctx,
        fail(
          'No netlist to simulate. Run the design (or import a .cir) first.',
          {
            missing: 'design',
          },
        ),
        [],
      );
    }
    const asked = list(input.analyses).filter((k): k is DeckKind =>
      DECK_KINDS.includes(k as DeckKind),
    );
    const analyses = asked.length
      ? available.filter((k) => asked.includes(k))
      : available;
    if (!analyses.length) {
      return this.outcome(
        ctx,
        fail(`The design has no ${asked.join('/')} deck.`, { available }),
        [],
      );
    }
    const started = (await this.simulation.runSimulation(
      ctx.user,
      ctx.projectId,
      ctx.branchId,
      analyses,
    )) as unknown as Landed;
    this.land(ctx, started);
    const node = await this.settle(
      ctx,
      'simulation',
      (n) => n.status !== 'running',
    );
    if (node.status === 'error') {
      return this.outcome(
        ctx,
        fail(
          `Simulation failed: ${node.error ?? 'unknown error'}`,
          forkNote(started.forked, started.branchName),
        ),
        ['simulation'],
        'simulation',
        started,
      );
    }
    const summary = rec(node.data.summary);
    const devices = describeSelection(node.data.deviceSelection);
    const tj =
      typeof summary.lossJunctionC === 'number' ? summary.lossJunctionC : 100;
    return this.outcome(
      ctx,
      {
        ok: true,
        summary: `Simulation complete · ${list(node.data.plots).length} waveforms${devices.length ? ` · ${devices.length} devices selected` : ''}`,
        payload: {
          ...summarizeSimulation(node.data, 60),
          ...(devices.length ? { device_selection: { devices } } : {}),
          losses_evaluated_at_tj_c: tj,
          ...forkNote(started.forked, started.branchName),
        },
      },
      ['simulation'],
      'simulation',
      started,
    );
  }

  private async selectDevices(ctx: ToolContext, input: JsonObject) {
    const overrides: Record<string, string> = {};
    for (const o of records(input.overrides)) {
      if (str(o.ref) && str(o.part)) overrides[str(o.ref)!] = str(o.part)!;
    }
    const preference = ['auto', 'mosfet', 'igbt'].includes(
      String(input.preference),
    )
      ? (input.preference as 'auto' | 'mosfet' | 'igbt')
      : undefined;
    const landed = (await this.simulation.selectDevices(
      ctx.user,
      ctx.projectId,
      ctx.branchId,
      {
        preference,
        overrides: Object.keys(overrides).length ? overrides : undefined,
      },
    )) as unknown as Landed;
    this.land(ctx, landed);
    const data = landed.node.data;
    const devices = describeSelection(data.deviceSelection);
    const { total_semiconductor_loss_w } = deviceLosses({
      losses: rec(data.lossAnalysis).components ?? [],
    });
    return this.outcome(
      ctx,
      {
        ok: true,
        summary: `${devices.filter((d) => d.device !== 'none suitable').length} devices selected · ${total_semiconductor_loss_w.toFixed(2)} W`,
        payload: {
          mode: 'simulated waveforms of the active branch',
          devices,
          total_semiconductor_loss_w,
          junction_temperature_c: rec(data.deviceSelection).junctionC,
          note: 'Devices were chosen from the library by evaluating every viable part on the simulated waveforms. Report these exact parts and reasons; do not claim any other device technology.',
        },
      },
      ['simulation'],
      'simulation',
      landed,
    );
  }

  // --- magnetics / thermal -------------------------------------------------------

  private async designMagnetics(ctx: ToolContext, input: JsonObject) {
    const overrides: Record<string, string> = {};
    for (const o of records(input.core_overrides)) {
      if (str(o.ref) && str(o.core)) overrides[str(o.ref)!] = str(o.core)!;
    }
    const fsw = num(input.fsw_khz);
    const parts = records(input.parts).map(
      (p) =>
        ({
          ...p,
          fsw_khz: num(p.fsw_khz) ?? fsw,
        }) as unknown as MagneticPartInput,
    );
    const result = await this.stages.runMagnetics(
      ctx.user,
      ctx.projectId,
      {
        material: str(input.material),
        maxFluxDensity: num(input.max_flux_density_t),
        currentDensity: num(input.current_density_a_mm2),
        maxTempRiseC: num(input.max_temp_rise_c),
        ambientC: num(input.ambient_c),
        coreOverrides: Object.keys(overrides).length ? overrides : undefined,
        parts: parts.length ? parts : undefined,
        fromCircuit: input.from_circuit === true,
      },
      ctx.branchId,
    );
    return this.plannedOutcome(ctx, result, 'magnetics');
  }

  private async runThermal(ctx: ToolContext, input: JsonObject) {
    const strategy = ['auto', 'none', 'shared'].includes(String(input.heatsink))
      ? (input.heatsink as 'auto' | 'none' | 'shared')
      : undefined;
    const inputs: ThermalInputs = {
      devices: records(input.devices) as unknown as ThermalInputs['devices'],
      magnetics: records(
        input.magnetics_losses,
      ) as unknown as ThermalInputs['magnetics'],
      other_losses: records(
        input.other_losses,
      ) as unknown as ThermalInputs['other_losses'],
      output_power_w: num(input.output_power_w),
    };
    const result = await this.stages.runThermal(
      ctx.user,
      ctx.projectId,
      {
        ambientC: num(input.ambient_c),
        maxJunctionC: num(input.max_junction_c),
        strategy,
        rthCs: num(input.rth_cs),
        marginC: num(input.margin_c),
        inputs,
        fromSimulation: input.from_simulation === true,
      },
      ctx.branchId,
    );
    return this.plannedOutcome(ctx, result, 'thermal');
  }

  private async runMtbf(ctx: ToolContext, input: JsonObject) {
    const parts: MtbfPartInput[] = records(input.parts)
      .filter(
        (p) =>
          str(p.ref) !== undefined &&
          (MTBF_PART_TYPES as readonly string[]).includes(String(p.type)),
      )
      .map((p) => ({
        ref: str(p.ref)!,
        type: p.type as MtbfPartType,
        partNumber: str(p.part_number) ?? null,
        temperatureC: num(p.temperature_c) ?? null,
        voltageV: num(p.voltage_v) ?? null,
        ratedVoltageV: num(p.rated_voltage_v) ?? null,
      }));
    const refs = (v: unknown) =>
      list(v).filter((r): r is string => typeof r === 'string' && r !== '');
    const method = (MTBF_METHODS as readonly string[]).includes(
      String(input.prediction_method),
    )
      ? (input.prediction_method as MtbfMethod)
      : undefined;
    const result = await this.stages.runMtbf(
      ctx.user,
      ctx.projectId,
      {
        predictionMethod: method,
        environment: str(input.environment),
        overrides: {
          ...Object.fromEntries(refs(input.include).map((r) => [r, true])),
          ...Object.fromEntries(refs(input.exclude).map((r) => [r, false])),
        },
        parts,
        fromCircuit: input.from_circuit === true,
      },
      ctx.branchId,
    );
    return this.plannedOutcome(ctx, result, 'mtbf');
  }

  private async buildBom(ctx: ToolContext, input: JsonObject) {
    const changes: Record<string, LineChoicePatch> = {};
    const change = (ref: unknown, patch: LineChoicePatch) => {
      const key = str(ref);
      if (key) changes[key] = { ...changes[key], ...patch };
    };
    const count = (v: unknown) =>
      typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000
        ? v
        : undefined;
    const CATEGORIES: readonly string[] = [
      'mosfet',
      'diode',
      'inductor',
      'transformer',
      'capacitor',
      'resistor',
      'ic',
      'heatsink',
      'other',
    ];
    for (const line of records(input.add_lines)) {
      const description = str(line.description);
      if (!description) continue;
      change(line.ref, {
        extra: {
          category: (CATEGORIES.includes(String(line.category))
            ? line.category
            : 'other') as BomCategory,
          description: description.slice(0, 200),
        },
        ...(count(line.quantity) ? { quantity: count(line.quantity) } : {}),
      });
    }
    for (const q of records(input.quantities)) {
      const quantity = count(q.quantity);
      if (quantity) change(q.ref, { quantity });
    }
    for (const ref of list(input.include)) change(ref, { included: true });
    for (const ref of list(input.exclude)) change(ref, { included: false });
    for (const ref of list(input.remove_lines)) change(ref, { extra: null });
    const result = await this.stages.runBom(
      ctx.user,
      ctx.projectId,
      changes,
      ctx.branchId,
    );
    return this.plannedOutcome(ctx, result, 'bom');
  }

  private async plannedOutcome(
    ctx: ToolContext,
    result: {
      ok: boolean;
      summary: string;
      payload?: Record<string, unknown>;
      branchId: string;
      forked: boolean;
    },
    stage: 'magnetics' | 'thermal' | 'mtbf' | 'bom',
  ) {
    const outcome: StageResult = {
      ok: result.ok,
      summary: result.summary,
      payload: result.payload ?? (result.ok ? {} : { error: result.summary }),
    };
    if (!result.ok) return this.outcome(ctx, outcome, []);
    const forked = result.forked && result.branchId !== ctx.branchId;
    const branchName = forked
      ? ((await this.load({ ...ctx, branchId: result.branchId })).branches[
          result.branchId
        ]?.name ?? '')
      : '';
    ctx.branchId = result.branchId;
    return {
      ...this.outcome(ctx, outcome, [stage], stage),
      forked: forked ? { branchId: result.branchId, branchName } : null,
    };
  }

  // --- workspace -----------------------------------------------------------------

  private openView(ctx: ToolContext, input: JsonObject): ToolOutcome {
    const stage = input.stage;
    if (!isStageKind(stage)) {
      return this.outcome(
        ctx,
        fail('Unknown view', { error: `Unknown stage ${String(stage)}` }),
        [],
      );
    }
    return this.outcome(
      ctx,
      { ok: true, summary: `Opened ${stage}`, payload: { focused: stage } },
      [],
      stage,
    );
  }

  private async manageBranch(ctx: ToolContext, input: JsonObject) {
    const name = str(input.name);
    const studio = await this.load(ctx);
    if (input.action === 'switch') {
      const target = Object.values(studio.branches).find(
        (b) => normName(b.name) === normName(name ?? ''),
      );
      if (!target) {
        return this.outcome(
          ctx,
          fail('Branch not found', {
            branches: Object.values(studio.branches).map((b) => b.name),
          }),
          [],
        );
      }
      await this.graph.setActiveBranch(ctx.projectId, ctx.user.id, target.id);
      ctx.branchId = target.id;
      return this.outcome(
        ctx,
        {
          ok: true,
          summary: `Switched to ${target.name}`,
          payload: { active_branch: target.name },
        },
        [],
      );
    }
    if (input.action === 'rename') {
      if (!name)
        return this.outcome(ctx, fail('Give the new branch name.'), []);
      const branch = await this.graph.renameBranch(
        ctx.projectId,
        ctx.user.id,
        ctx.branchId,
        name,
      );
      return this.outcome(
        ctx,
        {
          ok: true,
          summary: `Renamed branch to ${branch.name}`,
          payload: { active_branch: branch.name },
        },
        [],
      );
    }
    const forkBeforeStage = isStageKind(input.fork_from_stage)
      ? input.fork_from_stage
      : undefined;
    const created = await this.graph.mutate(
      ctx.projectId,
      ctx.user.id,
      (project) => {
        const made = createBranch(project, {
          name: name ?? 'experiment',
          fromBranchId: ctx.branchId,
          forkBeforeStage,
        });
        return { project: made.project, value: made.branch };
      },
      { branchId: ctx.branchId, activity: { stepName: 'branches' } },
    );
    const branch = created.value;
    await this.graph.setActiveBranch(ctx.projectId, ctx.user.id, branch.id);
    ctx.branchId = branch.id;
    return {
      ...this.outcome(
        ctx,
        {
          ok: true,
          summary: `Created branch ${branch.name}`,
          payload: {
            active_branch: branch.name,
            kept_stages_before: forkBeforeStage ?? 'all',
          },
        },
        [],
      ),
      forked: { branchId: branch.id, branchName: branch.name },
    };
  }

  // --- helpers -------------------------------------------------------------------

  private load(ctx: Pick<ToolContext, 'projectId' | 'user' | 'branchId'>) {
    return this.projects.loadStudio(ctx.projectId, ctx.user.id, ctx.branchId);
  }

  /** Applies a pure graph change on the run's branch; follows a fork. */
  private async apply(
    ctx: ToolContext,
    change: (studio: StudioProject) => StageOutcome,
  ): Promise<{ result: StageResult; forked: boolean }> {
    let result: StageResult = { ok: false, summary: '', payload: {} };
    let landed = ctx.branchId;
    await this.projects.mutateStudio(
      ctx.projectId,
      ctx.user.id,
      (studio) => {
        const outcome = change(studio);
        result = {
          ok: outcome.result.ok,
          summary: outcome.result.summary,
          payload:
            outcome.result.payload ??
            (outcome.result.ok ? {} : { error: outcome.result.summary }),
        };
        if (!outcome.result.ok) return studio;
        landed = outcome.project.activeBranchId;
        return outcome.project;
      },
      ctx.branchId,
    );
    const forked = landed !== ctx.branchId;
    ctx.branchId = landed;
    return { result, forked };
  }

  /** Follows a stage action to the branch it landed on. */
  private land(ctx: ToolContext, landed: { branchId: string }): void {
    ctx.branchId = landed.branchId;
  }

  /** Waits for a queued stage run on the run's branch to settle. */
  private async settle(
    ctx: ToolContext,
    stage: StageKind,
    done: (node: { status: string; data: JsonObject }) => boolean,
  ) {
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    for (;;) {
      const node = await this.graph.stage(
        ctx.projectId,
        ctx.user.id,
        ctx.branchId,
        stage,
      );
      if (!node) throw new Error(`The ${stage} result is gone.`);
      if (done(node)) return node;
      if (Date.now() > deadline) {
        throw new Error(
          `The ${stage} run is still going; check the workspace.`,
        );
      }
      await sleep(POLL_MS, ctx.signal);
    }
  }

  private outcome(
    ctx: ToolContext,
    result: StageResult,
    stages: StageKind[],
    focus?: StageKind,
    landed?: { forked: boolean; branchId: string; branchName: string },
  ): ToolOutcome {
    return {
      result,
      branchId: ctx.branchId,
      stages,
      focus: focus ? VIEW_OF_STAGE[focus] : null,
      forked: landed?.forked
        ? { branchId: landed.branchId, branchName: landed.branchName }
        : null,
    };
  }
}

function messageOf(error: HttpException): string {
  const body = error.getResponse();
  if (typeof body === 'object' && body !== null) {
    const message = (body as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return error.message;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
