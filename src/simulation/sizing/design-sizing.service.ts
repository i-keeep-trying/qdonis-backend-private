import { HttpException, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { AiStepRunner } from '../../design/ai/ai-step.runner';
import { ProjectAccessService } from '../../projects/project-access.service';
import { TopologiesService } from '../../topologies/topologies.service';
import { generateAnalysisCirs } from '../netlist/netlist-generator';
import { pyStr, type Dict } from '../netlist/py';
import { sanitizePreparedDeck } from '../ngspice/ngspice.runner';
import type {
  DeckKind,
  DesignData,
  RecalculatedParameter,
} from '../simulation.types';
import {
  buildChangeList,
  buildQuickParamsLine,
  prepareSizing,
  processReply,
  pyTyped,
  type ChangeRow,
  type SizingOutcome,
} from './sizing.logic';
import { sizingSystemPrompt } from './sizing.prompts';
import { decksSha256 } from './decks-hash';
import { branchCircuit } from '../../schematic/library/stored-circuit';
import {
  buildAiFixUserPrompt,
  buildModifyUserPrompt,
  fixedDeck,
  inconclusive,
  modifyRows,
  parseModifyReply,
  parseVerification,
  verificationPayload,
  type Verification,
} from './netlist-ai.logic';
import {
  AI_FIX_NETLIST_SYSTEM_PROMPT,
  DESIGN_MODIFICATION_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
} from './netlist-ai-prompts.text';

/** An AI edit of existing decks (`/api/design/modify-netlist`, `/api/netlist/ai-fix`). */
export interface DesignEditRunInput {
  mode: 'modify' | 'fix';
  /** The design before the edit (its decks are what the model sees). */
  previous: DesignData;
  parameters: Dict;
  instruction: string;
  actor: Pick<AuthenticatedUser, 'id' | 'role'>;
}

/** What a design run needs; stored as `simulation_runs.input`. */
export interface DesignRunInput {
  topologyId: string;
  /** Specs as the sizing step expects them (old `specsToParameters`). */
  parameters: Dict;
  actor: Pick<AuthenticatedUser, 'id' | 'role'>;
  /** The branch's edited circuit (absent: the library topology). */
  circuit?: Record<string, unknown>;
}

/** Core `LLM_MAX_TOKENS` / `LLM_TEMPERATURE` defaults for the sizing call. */
const MAX_TOKENS = 8192;
const TEMPERATURE = 0.1;
const TIMEOUT_MS = 5 * 60_000;

const UNITS: Record<string, string> = {
  voltage: 'V',
  v_peak: 'V',
  v_rms: 'V',
  bv: 'V',
  std_voltage_rating: 'V',
  target_voltage: 'V',
  frequency: 'Hz',
  inductance: 'H',
  lm_primary: 'H',
  capacitance: 'F',
  resistance: 'Ω',
  rds_on: 'Ω',
  i_peak: 'A',
  i_rms: 'A',
  i_ripple: 'A',
  delta_i: 'A',
  tdelay: 's',
  tr: 's',
  tf: 's',
};

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : pyStr(value);

/** Change rows as the web shows them (`str()` of the values, like core sent them). */
export const designRows = (changes: ChangeRow[]): RecalculatedParameter[] =>
  changes.map((c) => ({
    ref: c.ref,
    param: c.param,
    before: text(c.before),
    after: text(c.after),
    unit: UNITS[c.param.toLowerCase()] ?? null,
  }));

const metadata = (
  topologyId: string,
  sizing: string,
): Record<string, string> => ({
  topology: topologyId,
  sizing,
});

/**
 * Design stage sizing (qdonis-core `/api/simulate/prepare` with parameters):
 * the AI computes component values from the specs, then the decks are built
 * from the sized YAML. The DAB is sized deterministically, without the AI.
 */
@Injectable()
export class DesignSizingService {
  constructor(
    private readonly topologies: TopologiesService,
    private readonly ai: AiStepRunner,
    private readonly access: ProjectAccessService,
  ) {}

  /** 402 / 503 before a run is queued, when the AI cannot be paid for. */
  async precheck(
    actor: DesignRunInput['actor'],
    projectId: string,
  ): Promise<void> {
    const access = await this.access.require(actor, projectId, 'canEdit');
    await this.ai.precheck({ actorId: actor.id, access });
  }

  /**
   * One model call per deck (dc, ac, transient). `modify` follows the user's
   * instruction and reports changed values; `fix` repairs syntax and
   * convergence. The `.end` / `.control` tail of every deck is kept verbatim.
   */
  async edit(
    input: DesignEditRunInput,
    projectId: string,
  ): Promise<DesignData> {
    const access = await this.access.require(input.actor, projectId, 'canEdit');
    const before = input.previous;
    const decks: Partial<Record<DeckKind, string>> = {};
    let reasoning: string | null = null;
    let parameters: Dict | null = null;
    for (const kind of ['dc', 'ac', 'transient'] as const) {
      const content = before.decks[kind];
      if (!content || !content.trim()) continue;
      const modify = input.mode === 'modify';
      const result = await this.ai.run({
        actorId: input.actor.id,
        access,
        step: modify ? 'design_modify' : 'netlist_ai_fix',
        system: modify
          ? DESIGN_MODIFICATION_SYSTEM_PROMPT
          : AI_FIX_NETLIST_SYSTEM_PROMPT,
        prompt: modify
          ? buildModifyUserPrompt(
              kind,
              content,
              input.parameters,
              input.instruction,
            )
          : buildAiFixUserPrompt(kind, content, input.instruction),
        temperature: modify ? 0.2 : 0.1,
        maxTokens: MAX_TOKENS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (modify) {
        const reply = parseModifyReply(content, result.text);
        decks[kind] = reply.deck;
        reasoning ??= reply.reasoning;
        if (!parameters || Object.keys(parameters).length === 0) {
          parameters = reply.parameters;
        }
      } else {
        decks[kind] = fixedDeck(content, result.text);
      }
    }
    if (Object.keys(decks).length === 0) {
      throw new Error(`No analysis decks were provided to ${input.mode}.`);
    }
    // Old frontend `modifyDesign`: merge the changed values into the table.
    const rows = before.recalculatedParameters.map((r) => ({ ...r }));
    for (const change of designRows(modifyRows(parameters ?? {}))) {
      const at = rows.findIndex(
        (r) => r.ref === change.ref && r.param === change.param,
      );
      if (at >= 0)
        rows[at] = { ...rows[at], before: rows[at].after, after: change.after };
      else rows.push(change);
    }
    return {
      ...before,
      decks,
      recalculatedParameters: rows,
      reasoning: reasoning || before.reasoning,
      aiEdit: {
        mode: input.mode,
        instruction: input.instruction,
        beforeDecks: before.decks,
        at: new Date().toISOString(),
      },
    };
  }

  /**
   * `/api/simulate/verify-rerun`: whether a requested change shows in the
   * executed deck and the simulation results. Analysis only; the decks the
   * client names must be the ones that ran (`executedSha256`).
   */
  async verify(input: {
    actor: Pick<AuthenticatedUser, 'id' | 'role'>;
    projectId: string;
    userRequest: string;
    before: Record<string, string>;
    after: Record<string, string>;
    executedSha256: string | null;
    metadata: unknown;
    results: unknown;
  }): Promise<{ verification: Verification; metadata: Dict }> {
    if (
      !input.executedSha256 ||
      decksSha256(input.after) !== input.executedSha256
    ) {
      return {
        verification: {
          status: 'inconclusive',
          summary:
            'The simulation completed, but the executed netlist record did not match the submitted modified deck, so the requested change was not verified.',
          evidence: [
            {
              source: 'simulation_response',
              analysis_type: null,
              claim:
                'The submitted modified deck must match the recorded executed deck.',
              observed: 'The analysis-deck maps differed after normalization.',
              supports: 'inconclusive',
            },
          ],
          limitations: [
            'The verifier will not assess a change against a mismatched execution record.',
          ],
        },
        metadata: {},
      };
    }
    const access = await this.access.require(input.actor, input.projectId);
    try {
      const result = await this.ai.run({
        actorId: input.actor.id,
        access,
        step: 'simulation_verify',
        system: VERIFY_SYSTEM_PROMPT,
        prompt: verificationPayload({
          userRequest: input.userRequest,
          before: input.before,
          after: input.after,
          metadata: input.metadata,
          results: input.results,
          executed: input.after,
        }),
        temperature: 0,
        maxTokens: 1400,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return {
        verification: parseVerification(result.text),
        metadata: { model: result.modelId, usage: result.usage },
      };
    } catch (error) {
      // Billing / availability errors are the caller's to see; anything else
      // is an inconclusive verification, as in core.
      if (error instanceof HttpException) throw error;
      return {
        verification: inconclusive(
          'The simulation completed, but the requested outcome could not be verified automatically.',
          'The verification service did not return a valid result.',
          error instanceof Error ? error.message : String(error),
        ),
        metadata: {},
      };
    }
  }

  /** Sizes the design; the AI call is billed to the actor (or the team pool). */
  async size(input: DesignRunInput, projectId: string): Promise<DesignData> {
    const template = branchCircuit(
      input.circuit,
      this.topologies.design(input.topologyId),
    );
    const params = pyTyped(input.parameters) as Dict;
    const prepared = prepareSizing(structuredClone(template), params);
    let outcome: SizingOutcome;
    let sizing = 'deterministic';
    if ('outcome' in prepared) {
      outcome = prepared.outcome;
    } else {
      // Re-checked at run time: access may have been revoked meanwhile.
      const access = await this.access.require(
        input.actor,
        projectId,
        'canEdit',
      );
      const result = await this.ai.run({
        actorId: input.actor.id,
        access,
        step: 'design_sizing',
        system: sizingSystemPrompt(input.topologyId),
        prompt: prepared.user,
        temperature: TEMPERATURE,
        maxTokens: MAX_TOKENS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      outcome = processReply(
        result.text,
        prepared.yaml,
        template,
        prepared.params,
      );
      sizing = 'ai';
    }
    const changes = Object.keys(outcome.updates).length
      ? buildChangeList(template, outcome.updates, params)
      : [];
    let quick = '';
    try {
      quick = buildQuickParamsLine(input.topologyId, params, changes);
    } catch {
      quick = ''; // core logged it and sent an empty line
    }
    const decks: Partial<Record<DeckKind, string>> = {};
    for (const [kind, deck] of Object.entries(
      generateAnalysisCirs(outcome.yaml, 'all').analysis_cirs,
    )) {
      decks[kind as DeckKind] = sanitizePreparedDeck(deck);
    }
    return {
      topologyId: input.topologyId,
      decks,
      recalculatedParameters: designRows(changes),
      quickParamsLine: quick || null,
      reasoning: outcome.reasoning,
      origin: 'optimizer',
      fileName: null,
      metadata: metadata(input.topologyId, sizing),
    };
  }
}
