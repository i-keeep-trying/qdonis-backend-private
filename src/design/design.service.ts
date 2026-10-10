import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { ProjectActivityType, Role } from '../generated/prisma/enums';
import { ProjectAccessService } from '../projects/project-access.service';
import type { ProjectAccess } from '../projects/project-permissions';
import { ProjectsRepository } from '../projects/projects.repository';
import { ProjectsService } from '../projects/projects.service';
import { loadStudioProject } from '../projects/studio/studio-persistence';
import { stageNodeOnBranch } from '../projects/studio/studio-graph';
import { AiStepRunner, type AiStepResult } from './ai/ai-step.runner';
import {
  asArray,
  asString,
  isRecord,
  parseModelJson,
  validCitations,
} from './ai/json-response';
import { SpecDocumentsService } from './ai/spec-documents.service';
import {
  ENGINEERING_CATEGORY_IDS,
  type EngineeringCategoryId,
  type MandatoryParametersAnalysis,
} from './catalog/mandatory-parameters';
import {
  acceptRecommendation,
  approveAssumption,
  buildAnalysis,
  mergeAnalysis,
  parseStageParameters,
  resetParameter,
  setParameterValue,
  storedAnalysis,
} from './design-intent.logic';
import type {
  AnalyzeDesignIntentDto,
  EditDesignParameterDto,
  GenerateConstraintsDto,
  ProcessRequirementsDto,
  RecommendTopologiesDto,
  UpdateConstraintsDto,
  UpdateSpecsDto,
} from './dto/design.dto';
import {
  mandatoryParametersPrompt,
  PDF_ATTACHMENT_NOTE,
  projectNamePrompt,
  stageParametersPrompt,
} from './prompts/design-intent.prompts';
import { requirementsPrompt } from './prompts/requirements.prompts';
import { buckBoostFallback, topologyPrompt } from './prompts/topology.prompts';
import type { StreamedWork } from './sse-result';
import {
  applyGeneratedConstraints,
  approveSpecs,
  constraintsPromptInput,
  type StageOutcome,
  type StageResult,
  specsOf,
  updateConstraints,
  updateSpecs,
} from './studio-specs.logic';

type Actor = Pick<AuthenticatedUser, 'id' | 'role'>;
type Data = Record<string, unknown>;

export interface TopologyRecommendation {
  topologies: unknown[];
  cached: boolean;
  revision: number | null;
  usage: ReturnType<typeof usageOf> | null;
}

const MODEL_MAX_TOKENS = 64_000;
const NAME_MAX = 50;

function usageOf(r: AiStepResult) {
  return {
    model_name: r.modelId,
    prompt_tokens: r.usage.promptTokens,
    completion_tokens: r.usage.completionTokens,
    total_tokens: r.usage.totalTokens,
    charged: r.charged,
    response_time_ms: r.responseTimeMs,
  };
}

/** First line of the reply, unquoted, capped at 50 chars (old behaviour: 47 + '...'). */
export function cleanProjectName(raw: string): string | null {
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const name = line.replace(/^["'`*]+|["'`*.]+$/g, '').trim();
  if (!name) return null;
  return name.length > NAME_MAX
    ? `${name.substring(0, NAME_MAX - 3)}...`
    : name;
}

/** Topology parameter maps compared key-order independently (old areParamsEqual). */
export function sameParameters(a: Data, b: Data): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) return false;
  return ka.every((k) => {
    const x = a[k];
    const y = b[k];
    if (
      typeof x === 'object' &&
      typeof y === 'object' &&
      x !== null &&
      y !== null
    ) {
      return JSON.stringify(x) === JSON.stringify(y);
    }
    return x === y;
  });
}

/**
 * Design steps that do not need the simulation core: design intent,
 * requirement analysis, Studio specs/constraints, topology recommendation and
 * project naming. All prompts and post-processing run here; results are
 * persisted on the project.
 */
@Injectable()
export class DesignService implements OnModuleInit {
  private readonly logger = new Logger(DesignService.name);

  constructor(
    private readonly runner: AiStepRunner,
    private readonly documents: SpecDocumentsService,
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsService,
    private readonly repository: ProjectsRepository,
  ) {}

  /** New projects created from a prompt get a generated name in the background. */
  onModuleInit(): void {
    this.projects.onProjectCreated(({ projectId, actorId, prompt }) => {
      if (!prompt) return;
      void this.nameInBackground(projectId, actorId, prompt);
    });
  }

  // --- project name -------------------------------------------------------------

  async prepareName(
    user: Actor,
    projectId: string,
  ): Promise<StreamedWork<{ name: string; renamed: boolean }>> {
    const access = await this.access.require(user, projectId, 'canEdit');
    const data = await this.dataOf(projectId);
    const requirements =
      asString(data.userInput)?.trim() ||
      loadStudioProject(data).initialPrompt?.trim() ||
      '';
    if (!requirements) {
      throw AppError.badRequest(
        ErrorCode.StageInputMissing,
        'The project has no requirements to name it from',
      );
    }
    await this.runner.precheck({ actorId: user.id, access });
    return async (signal) => {
      const name = await this.generateName(
        user.id,
        access,
        requirements,
        signal,
      );
      if (!name) return { name: access.projectName, renamed: false };
      await this.repository.updateMeta(projectId, { name });
      await this.repository.logActivity({
        projectId,
        userId: user.id,
        type: ProjectActivityType.RENAME,
        details: { old_name: access.projectName, new_name: name, via: 'ai' },
      });
      return { name, renamed: true };
    };
  }

  private async nameInBackground(
    projectId: string,
    actorId: string,
    prompt: string,
  ): Promise<void> {
    try {
      const access = await this.access.resolve(
        { id: actorId, role: Role.USER },
        projectId,
      );
      if (!access) return;
      const name = await this.generateName(
        actorId,
        access,
        prompt,
        AbortSignal.timeout(120_000),
      );
      if (name) await this.projects.renameIfDefault(projectId, name);
    } catch (error) {
      // Naming is best effort (old behaviour): the project keeps "My Project".
      this.logger.warn(
        `Name generation for ${projectId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async generateName(
    actorId: string,
    access: ProjectAccess,
    requirements: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const result = await this.runner.run({
      actorId,
      access,
      step: 'project_name_generation',
      prompt: projectNamePrompt(requirements.slice(0, 20_000)),
      temperature: 0.7,
      maxTokens: 8192,
      signal,
    });
    return cleanProjectName(result.text);
  }

  // --- design intent (mandatory parameters) ---------------------------------------

  async prepareDesignIntent(
    user: Actor,
    projectId: string,
    dto: AnalyzeDesignIntentDto,
  ) {
    const access = await this.access.require(user, projectId, 'canEdit');
    const data = await this.dataOf(projectId);
    const userInput = dto.userInput ?? asString(data.userInput)?.trim() ?? '';
    const docs = await this.documents.resolve(user.id, access, dto.documentIds);
    if (!userInput && !docs.text && docs.attachments.length === 0) {
      throw AppError.badRequest(
        ErrorCode.StageInputMissing,
        'Cannot analyse the design intent: the requirements are empty.',
      );
    }
    await this.runner.precheck({ actorId: user.id, access });
    const pdfNote = docs.attachments.length ? PDF_ATTACHMENT_NOTE : '';

    return async (signal: AbortSignal) => {
      const stage = await this.runner.run({
        actorId: user.id,
        access,
        step: 'stage_parameters_analysis',
        prompt: stageParametersPrompt(userInput, docs.text) + pdfNote,
        attachments: docs.attachments,
        temperature: 0.2,
        maxTokens: MODEL_MAX_TOKENS,
        signal,
      });
      let requiredStageParams: ReturnType<typeof parseStageParameters> = [];
      let reasoning = 'Stage parameters determined by Bedrock';
      try {
        const parsed = parseModelJson(stage.text, 'stage parameters');
        requiredStageParams = parseStageParameters(parsed);
        reasoning = asString(parsed.overallReasoning) || reasoning;
      } catch {
        // Old behaviour: an unparseable answer means "no extra stage parameters".
        reasoning = 'Failed to analyze stage parameters (JSON Parse Error)';
      }

      const mandatory = await this.runner.run({
        actorId: user.id,
        access,
        step: 'mandatory_parameters',
        prompt:
          mandatoryParametersPrompt(userInput, docs.text, requiredStageParams) +
          pdfNote,
        attachments: docs.attachments,
        temperature: 0.2,
        maxTokens: MODEL_MAX_TOKENS,
        signal,
      });
      const fresh = buildAnalysis(
        parseModelJson(mandatory.text, 'mandatory parameters'),
        requiredStageParams,
      );

      let analysis = fresh;
      const meta = await this.projects.mutateData(projectId, (current) => {
        analysis = mergeAnalysis(fresh, storedAnalysis(current));
        return {
          ...current,
          userInput: userInput || current.userInput,
          mandatoryParametersAnalysis: analysis,
          requiredStageParams,
          designIntentDocumentIds:
            dto.documentIds ?? current.designIntentDocumentIds ?? [],
        };
      });
      return {
        analysis,
        requiredStageParams,
        reasoning,
        revision: meta.revision,
        usage: {
          stageParameters: usageOf(stage),
          mandatoryParameters: usageOf(mandatory),
        },
      };
    };
  }

  /** Designer review edits (set / accept / approve / reset), applied server-side. */
  async editDesignParameter(
    user: Actor,
    projectId: string,
    dto: EditDesignParameterDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    // Widened on purpose: assigned inside the transaction callback.
    let analysis = null as MandatoryParametersAnalysis | null;
    const meta = await this.projects.mutateData(projectId, (current) => {
      const stored = storedAnalysis(current);
      if (!stored) {
        throw AppError.badRequest(
          ErrorCode.StageInputMissing,
          'Run the design intent analysis first',
        );
      }
      switch (dto.action) {
        case 'set':
          analysis = setParameterValue(
            stored,
            dto.id,
            dto.value ?? '',
            dto.reasoning,
          );
          break;
        case 'accept_recommendation':
          analysis = acceptRecommendation(stored, dto.id);
          break;
        case 'approve_assumption':
          analysis = approveAssumption(stored, dto.id);
          break;
        case 'reset':
          analysis = resetParameter(stored, dto.id);
          break;
      }
      return { ...current, mandatoryParametersAnalysis: analysis };
    });
    return { analysis, revision: meta.revision };
  }

  // --- requirements -> engineering specification ----------------------------------

  async prepareRequirements(
    user: Actor,
    projectId: string,
    dto: ProcessRequirementsDto,
  ) {
    const access = await this.access.require(user, projectId, 'canEdit');
    const data = await this.dataOf(projectId);
    const userInput = dto.userInput ?? asString(data.userInput)?.trim() ?? '';
    const documentIds =
      dto.documentIds ??
      asArray(data.designIntentDocumentIds).filter(
        (v): v is string => typeof v === 'string',
      );
    const docs = await this.documents.resolve(user.id, access, documentIds);
    if (!userInput && !docs.text && docs.attachments.length === 0) {
      throw AppError.badRequest(
        ErrorCode.StageInputMissing,
        'The requirements are empty.',
      );
    }
    const categories = dto.categories ?? [...ENGINEERING_CATEGORY_IDS];
    const reviewed =
      dto.useReviewedIntent === false ? null : storedAnalysis(data);
    await this.runner.precheck({ actorId: user.id, access });

    return async (signal: AbortSignal) => {
      const generated = await this.specification(user.id, access, {
        userInput,
        categories,
        documentText: docs.text,
        attachments: docs.attachments,
        reviewed,
        signal,
      });
      const meta = await this.projects.mutateData(projectId, (current) => ({
        ...current,
        initialSelectedCategories: categories,
        initialSpecification: generated.output,
        // A new specification invalidates the topology choice made from the old one.
        topologyRecommendations: null,
        lastGeneratedTopologyParams: null,
      }));
      return {
        ...generated.output,
        usage: usageOf(generated.result),
        revision: meta.revision,
      };
    };
  }

  /** The old `processRequirements`: prompt, call, validate, filter citations. */
  private async specification(
    actorId: string,
    access: ProjectAccess,
    input: {
      userInput: string;
      categories: EngineeringCategoryId[];
      documentText: string | null;
      attachments: Parameters<AiStepRunner['run']>[0]['attachments'];
      reviewed: MandatoryParametersAnalysis | null;
      signal: AbortSignal;
    },
  ) {
    const result = await this.runner.run({
      actorId,
      access,
      step: 'initial_requirements',
      prompt: requirementsPrompt({
        userInput: input.userInput,
        categories: input.categories,
        documentText: input.documentText,
        hasPdf: Boolean(input.attachments?.length),
        reviewed: input.reviewed,
      }),
      attachments: input.attachments,
      temperature: 0.25,
      maxTokens: MODEL_MAX_TOKENS,
      signal: input.signal,
    });
    const parsed = parseModelJson(result.text, 'initial processing');
    if (!Array.isArray(parsed.derivedParametersList)) {
      throw AppError.badGateway(
        ErrorCode.AiResponseInvalid,
        "AI response is missing 'derivedParametersList'. Please try again.",
      );
    }
    const derivedParametersList = parsed.derivedParametersList.filter(isRecord);
    return {
      result,
      output: {
        specification: {
          derivedParametersList,
          recommendedTopology: isRecord(parsed.recommendedTopology)
            ? parsed.recommendedTopology
            : null,
          assumptionsMade: asArray(parsed.assumptionsMade).filter(
            (a): a is string => typeof a === 'string',
          ),
        },
        citations: validCitations(parsed.overallCitations),
      },
    };
  }

  // --- Studio specs / constraints -----------------------------------------------------

  async updateSpecs(user: Actor, projectId: string, dto: UpdateSpecsDto) {
    await this.access.require(user, projectId, 'canEdit');
    return this.applyStudio(projectId, (studio) =>
      updateSpecs(studio, dto, dto.source ?? 'user'),
    );
  }

  async approveSpecs(user: Actor, projectId: string) {
    await this.access.require(user, projectId, 'canEdit');
    return this.applyStudio(projectId, (studio) => approveSpecs(studio));
  }

  async updateConstraints(
    user: Actor,
    projectId: string,
    dto: UpdateConstraintsDto,
  ) {
    await this.access.require(user, projectId, 'canEdit');
    return this.applyStudio(projectId, (studio) =>
      updateConstraints(studio, dto, dto.source ?? 'user'),
    );
  }

  /** Expands the key specs into the full engineering constraints list (old generateConstraints). */
  async prepareConstraints(
    user: Actor,
    projectId: string,
    dto: GenerateConstraintsDto,
  ) {
    const access = await this.access.require(user, projectId, 'canEdit');
    const studio = loadStudioProject(await this.dataOf(projectId));
    const node = stageNodeOnBranch(studio, 'specs');
    const specs = specsOf(node);
    if (!node || !specs || specs.rows.length === 0) {
      throw AppError.badRequest(
        ErrorCode.StageInputMissing,
        'No specification yet. Build the key spec table (update_specs) before generating constraints.',
      );
    }
    await this.runner.precheck({ actorId: user.id, access });
    const nodeId = node.id;
    const userInput = constraintsPromptInput(specs, dto.notes);

    return async (signal: AbortSignal) => {
      const generated = await this.specification(user.id, access, {
        userInput,
        categories: [...ENGINEERING_CATEGORY_IDS],
        documentText: null,
        attachments: [],
        reviewed: null,
        signal,
      });
      const outcome = await this.applyStudio(projectId, (current) =>
        applyGeneratedConstraints(current, nodeId, {
          derivedParametersList:
            generated.output.specification.derivedParametersList,
          assumptionsMade: generated.output.specification.assumptionsMade,
          citations: generated.output.citations,
        }),
      );
      return { ...outcome, usage: usageOf(generated.result) };
    };
  }

  private async applyStudio(
    projectId: string,
    change: (studio: ReturnType<typeof loadStudioProject>) => StageOutcome,
  ): Promise<StageResult & { revision: number }> {
    let result: StageResult = { ok: false, summary: '' };
    const meta = await this.projects.mutateStudio(projectId, (studio) => {
      const outcome = change(studio);
      result = outcome.result;
      return outcome.project;
    });
    if (!result.ok) {
      throw AppError.conflict(ErrorCode.StageInputMissing, result.summary);
    }
    return { ...result, revision: meta.revision };
  }

  // --- topology recommendation ----------------------------------------------------------

  async prepareTopologies(
    user: Actor,
    projectId: string,
    dto: RecommendTopologiesDto,
  ): Promise<StreamedWork<TopologyRecommendation>> {
    const access = await this.access.require(user, projectId, 'canEdit');
    const data = await this.dataOf(projectId);
    if (Object.keys(dto.parameters).length === 0) {
      throw AppError.badRequest(
        ErrorCode.StageInputMissing,
        'Cannot proceed: Parameters are missing for topology generation.',
      );
    }
    const last = isRecord(data.lastGeneratedTopologyParams)
      ? data.lastGeneratedTopologyParams
      : null;
    const cached = Array.isArray(data.topologyRecommendations)
      ? data.topologyRecommendations
      : null;
    const unchanged = Boolean(last && sameParameters(dto.parameters, last));
    if (!dto.force && unchanged && cached && cached.length > 0) {
      // Same parameters as last time: reuse the result, no model call (old behaviour).
      return () =>
        Promise.resolve({
          topologies: cached,
          cached: true,
          revision: null,
          usage: null,
        });
    }
    await this.runner.precheck({ actorId: user.id, access });
    const requirements = asString(data.userInput)?.trim() || null;

    const simplified: Data = {};
    for (const [key, detail] of Object.entries(dto.parameters)) {
      simplified[key] =
        isRecord(detail) && 'value' in detail ? detail.value : detail;
    }

    return async (signal: AbortSignal) => {
      const result = await this.runner.run({
        actorId: user.id,
        access,
        step: 'topology_generation',
        prompt: topologyPrompt(
          JSON.stringify(simplified, null, 2),
          requirements,
        ),
        temperature: 0.1,
        maxTokens: MODEL_MAX_TOKENS,
        signal,
      });
      const parsed = parseModelJson(result.text, 'topologies');
      const topologies = asArray(parsed.topologies)
        .filter(isRecord)
        .map((t) => ({
          ...t,
          name: asString(t.name) ?? '',
          pros: asArray(t.pros).filter(
            (p): p is string => typeof p === 'string',
          ),
          cons: asArray(t.cons).filter(
            (c): c is string => typeof c === 'string',
          ),
          rationale: asString(t.rationale) ?? '',
          relevantCitations: validCitations(t.relevantCitations),
        }))
        .filter((t) => t.name);

      if (requirements && topologies.length > 0) {
        const lower = requirements.toLowerCase();
        const asked =
          lower.includes('buck-boost') || lower.includes('buck boost');
        const has = topologies.some(
          (t) => t.name.toLowerCase().replace(/[\s\-_]+/g, '') === 'buckboost',
        );
        if (asked && !has) {
          const fallback = buckBoostFallback(requirements, simplified);
          if (topologies.length >= 3) topologies[2] = fallback;
          else topologies.push(fallback);
        }
      }

      const meta = await this.projects.mutateData(projectId, (current) => ({
        ...current,
        topologyRecommendations: topologies,
        lastGeneratedTopologyParams: dto.parameters,
      }));
      return {
        topologies,
        cached: false,
        revision: meta.revision,
        usage: usageOf(result),
      };
    };
  }

  private async dataOf(projectId: string): Promise<Data> {
    const project = await this.repository.findWithData(projectId);
    if (!project)
      throw AppError.notFound(ErrorCode.ProjectNotFound, 'Project not found');
    return isRecord(project.data) ? project.data : {};
  }
}
