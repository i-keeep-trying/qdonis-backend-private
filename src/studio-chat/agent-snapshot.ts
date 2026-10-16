import { specsOf } from '../design/studio-specs.logic';
import {
  ancestry,
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import {
  changedParameterLines,
  clip,
  componentLine,
  constraintsSnapshot,
  designParameterLines,
  rec,
  records,
  scalar,
  selectionLines,
  summarizeSimulation,
} from './agent-results';
import { money } from '../studio-stages/bom.stage';
import type { AttachmentRef } from './studio-chat.types';

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const fixed = (v: unknown, digits: number): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '?';

/**
 * The active branch as the Studio agent sees it (port of the old frontend
 * `buildAgentSnapshot`), from the graph with stage data.
 */
export function buildAgentSnapshot(
  project: StudioProject,
  attachments: AttachmentRef[],
): Record<string, unknown> {
  const active = project.branches[project.activeBranchId];
  const specsNode = stageNodeOnBranch(project, 'specs');
  const specs = specsOf(specsNode);
  const vis = stageNodeOnBranch(project, 'visualization');
  const design = stageNodeOnBranch(project, 'design');
  const sim = stageNodeOnBranch(project, 'simulation');
  const magnetics = stageNodeOnBranch(project, 'magnetics');
  const thermal = stageNodeOnBranch(project, 'thermal');
  const mtbf = stageNodeOnBranch(project, 'mtbf');
  const bom = stageNodeOnBranch(project, 'bom');

  const inventory = rec(vis?.data.inventory);
  const thermalResult = rec(thermal?.data.result);

  return {
    active_branch: active?.name,
    branches: project.branchOrder.map((id) => {
      const b = project.branches[id];
      return {
        name: b.name,
        stages: ancestry(project, b.headId).map((n) => n.stage),
        active: id === project.activeBranchId,
      };
    }),
    workspace_focus: project.focus,
    specs: specs
      ? {
          application: specs.application,
          approved: specs.approved,
          rows: specs.rows.map(
            (r) =>
              `${r.name}: ${r.value}${r.unit ? ` ${r.unit}` : ''} [${r.source || 'user'}]`,
          ),
          last_topology_options: specs.topologyOptions?.map(
            (o) => o.topology_id,
          ),
          constraints: constraintsSnapshot(specs),
        }
      : null,
    visualization: vis
      ? {
          topology_id: vis.data.topologyId,
          status: vis.status,
          error: vis.error || undefined,
          has_schematic: Boolean(vis.data.circuit),
          structurally_edited: vis.data.customStructure === true,
          components: records(inventory.components).map(componentLine),
        }
      : null,
    design: design
      ? {
          status: design.status,
          error: design.error || undefined,
          topology_id: design.data.topologyId,
          origin: design.data.origin,
          decks: Object.keys(rec(design.data.decks)),
          quick_params: str(design.data.quickParamsLine),
          parameters: designParameterLines(design.data),
          reasoning_excerpt: str(design.data.reasoning)
            ? clip(design.data.reasoning, 700)
            : undefined,
        }
      : null,
    simulation: sim
      ? {
          status: sim.status,
          error: sim.error || undefined,
          losses_evaluated_at_tj_c:
            rec(sim.data.summary).lossJunctionC ?? undefined,
          selected_devices:
            selectionLines(sim.data.deviceSelection) ??
            'not selected yet (generic default models in the loss analysis)',
          ...(sim.status === 'ready' ? summarizeSimulation(sim.data, 40) : {}),
        }
      : null,
    magnetics: magnetics
      ? {
          origin:
            magnetics.data.origin === 'input'
              ? 'entered part values (standalone)'
              : 'circuit on this branch',
          ...(magnetics.data.origin === 'input'
            ? { entered_parts: magnetics.data.inputs }
            : {}),
          settings: {
            material: rec(magnetics.data.settings).material,
            ambient_c: rec(magnetics.data.settings).ambientC,
          },
          designs: records(magnetics.data.designs).map((d) => {
            const warnings = Array.isArray(d.warnings) ? d.warnings.length : 0;
            const stacked = typeof d.stacked === 'number' ? d.stacked : 1;
            const secondary = scalar(d.turnsSecondary);
            return `${scalar(d.ref)}: ${stacked > 1 ? `${stacked}x` : ''}${scalar(d.core)} ${scalar(d.material)}, N=${scalar(d.turnsPrimary)}${secondary ? `:${secondary}` : ''}, gap ${fixed(d.airGap_mm, 2)} mm, Bpk ${fixed(d.bPeak_T, 3)} T, loss ${fixed(d.totalLoss_W, 2)} W, ΔT ${fixed(d.tempRise_C, 0)} °C${warnings ? ` [${warnings} warnings]` : ''}`;
          }),
        }
      : null,
    thermal: thermal
      ? {
          origin:
            thermal.data.origin === 'input'
              ? 'entered losses (standalone)'
              : 'simulation on this branch',
          ...(thermal.data.origin === 'input'
            ? { entered: thermal.data.inputs }
            : {}),
          ambient_c: thermalResult.ambientC,
          heatsink: thermalResult.heatsink,
          devices: records(thermalResult.devices).map(
            (d) =>
              `${String(d.ref)}: ${fixed(d.lossW, 2)} W → Tj ${fixed(d.tjC, 0)} °C (max ${String(d.tjMaxC)})`,
          ),
          totals: thermalResult.totals,
          warnings: thermalResult.warnings,
        }
      : null,
    mtbf: mtbf
      ? {
          origin:
            mtbf.data.origin === 'input'
              ? 'entered parts (standalone)'
              : 'circuit on this branch',
          ...rec(mtbf.data.settings),
          mtbf_hours: rec(mtbf.data.result).mtbfHours,
          failure_rate_fit: rec(mtbf.data.result).failureRateFit,
          top_contributors: [...records(rec(mtbf.data.result).components)]
            .sort((a, b) => Number(b.contribution) - Number(a.contribution))
            .slice(0, 5)
            .map(
              (c) =>
                `${String(c.designator)}: ${fixed(c.lambda, 1)} FIT (${fixed(c.contribution, 1)} %)`,
            ),
          issues: rec(mtbf.data.result).issues,
        }
      : null,
    bom: bom
      ? {
          totals: bom.data.totals,
          lines: records(bom.data.lines)
            .filter((l) => l.included === true)
            .map(
              (l) =>
                `${(Array.isArray(l.refs) ? l.refs : [l.ref]).map(String).join(', ')} ×${String(l.quantity)}: ${String(l.partNumber ?? l.description)}${typeof l.unitPrice === 'number' ? ` (${money(l.unitPrice, typeof l.currency === 'string' ? l.currency : null)} each)` : ''}`,
            ),
        }
      : null,
    other_branches: project.branchOrder
      .filter((id) => id !== project.activeBranchId)
      .map((id) => {
        const b = project.branches[id];
        const d = stageNodeOnBranch(project, 'design', id);
        const sm = stageNodeOnBranch(project, 'simulation', id);
        const summary =
          sm?.status === 'ready' ? summarizeSimulation(sm.data, 15) : null;
        return {
          name: b.name,
          topology_id: stageNodeOnBranch(project, 'visualization', id)?.data
            .topologyId,
          design_changes: d ? changedParameterLines(d.data) : undefined,
          simulation: summary
            ? {
                measurements: summary.measurements,
                total_semiconductor_loss_w: summary.total_semiconductor_loss_w,
              }
            : undefined,
        };
      }),
    preview_stages: [],
    attachments: attachments.map((a) => ({ name: a.name, kind: a.kind })),
  };
}
