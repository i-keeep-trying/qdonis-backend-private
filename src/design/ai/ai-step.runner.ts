import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { Injectable, Logger } from '@nestjs/common';

import { AiService } from '../../ai/ai.service';
import { BedrockClient } from '../../ai/bedrock/bedrock.client';
import { AppError, ErrorCode } from '../../common/errors/error-codes';
import type { ProjectAccess } from '../../projects/project-permissions';
import { TeamsRepository } from '../../teams/teams.repository';

export interface AiStepInput {
  actorId: string;
  /** Project the step runs for; team projects are charged to the team pool. */
  access?: ProjectAccess | null;
  /** Step key for the admin multiplier and the ledger (snake_case). */
  step: string;
  prompt: string;
  /** Extra content blocks placed before the prompt (e.g. a PDF document). */
  attachments?: ContentBlock[];
  system?: string;
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
  /** An allowlisted model for this step; omitted = the default model. */
  modelId?: string;
}

/** Who is charged: the caller, or the team owner's pool for team projects. */
export interface StepPayer {
  userId: string;
  teamId: string | null;
}

export interface AiStepResult {
  text: string;
  modelId: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  charged: number;
  responseTimeMs: number;
}

/**
 * Runs one server-side AI step: picks who pays (the caller, or the team
 * owner's pool for team projects within the team cap), checks the balance
 * before calling Bedrock, then charges the provider-reported usage once with
 * project/step metadata. Prompts never come from the client.
 */
@Injectable()
export class AiStepRunner {
  private readonly logger = new Logger(AiStepRunner.name);

  constructor(
    private readonly ai: AiService,
    private readonly bedrock: BedrockClient,
    private readonly teams: TeamsRepository,
  ) {}

  /**
   * Fails fast (503 AI off, 402 no tokens / team cap reached) before a
   * response stream starts. `run` checks again, so this is only an early exit.
   */
  async precheck(
    input: Pick<AiStepInput, 'actorId' | 'access'>,
  ): Promise<void> {
    const payer = await this.payer(input);
    await this.ai.prepare(payer.userId);
  }

  /**
   * For a step the caller streams itself (the Studio chat): who pays and the
   * model to call, after the same checks as `run`.
   */
  async prepareStream(
    input: Pick<AiStepInput, 'actorId' | 'access'>,
  ): Promise<{ modelId: string; payer: StepPayer }> {
    const payer = await this.payer(input);
    return { modelId: await this.ai.prepare(payer.userId), payer };
  }

  /** Charges one completed streamed call to `payer`; returns the payer's balance. */
  async chargeStream(
    input: Pick<AiStepInput, 'actorId' | 'access' | 'step'> & {
      payer: StepPayer;
      modelId: string;
      inputTokens: number;
      outputTokens: number;
    },
  ): Promise<{ charged: number; balance: number }> {
    const { charged, balance } = await this.ai.chargeUsage(input.payer.userId, {
      modelId: input.modelId,
      step: input.step,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      context: {
        projectId: input.access?.projectId ?? null,
        teamId: input.payer.teamId,
        actorId: input.actorId,
      },
    });
    await this.recordTeamUsage(input.payer.teamId, input, charged);
    return { charged, balance };
  }

  async run(input: AiStepInput): Promise<AiStepResult> {
    const payer = await this.payer(input);
    const modelId = await this.ai.prepare(payer.userId, input.modelId);
    const started = Date.now();

    const result = await this.bedrock.converse({
      modelId,
      system: input.system ? [input.system] : undefined,
      messages: [
        {
          role: 'user',
          content: [...(input.attachments ?? []), { text: input.prompt }],
        },
      ],
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      signal: input.signal,
    });

    const { inputTokens, outputTokens } = result.usage;
    const { charged } = await this.ai.chargeUsage(payer.userId, {
      modelId,
      step: input.step,
      inputTokens,
      outputTokens,
      context: {
        projectId: input.access?.projectId ?? null,
        teamId: payer.teamId,
        actorId: input.actorId,
      },
    });
    await this.recordTeamUsage(payer.teamId, input, charged);

    return {
      text: result.text,
      modelId,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      charged,
      responseTimeMs: Date.now() - started,
    };
  }

  private async recordTeamUsage(
    teamId: string | null,
    input: Pick<AiStepInput, 'actorId' | 'access' | 'step'>,
    charged: number,
  ): Promise<void> {
    if (!teamId || charged <= 0) return;
    await this.teams
      .recordUsage({
        teamId,
        userId: input.actorId,
        projectId: input.access?.projectId ?? null,
        tokens: charged,
        operation: input.step,
      })
      .catch((error: unknown) =>
        // The tokens are already charged; a missing usage row only affects
        // team analytics, so it is logged rather than failing the step.
        this.logger.error(
          `Team usage not recorded for team ${teamId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  private async payer(
    input: Pick<AiStepInput, 'actorId' | 'access'>,
  ): Promise<StepPayer> {
    const teamId = input.access?.teamId ?? null;
    if (!teamId) return { userId: input.actorId, teamId: null };
    const team = await this.teams.findTeam(teamId);
    if (!team) return { userId: input.actorId, teamId: null };
    if (team.tokenLimit !== null && team.tokensUsed >= team.tokenLimit) {
      throw AppError.paymentRequired(
        ErrorCode.TeamTokenLimitReached,
        'Team has reached its token limit.',
        { tokenLimit: team.tokenLimit, tokensUsed: team.tokensUsed },
      );
    }
    return { userId: team.ownerId, teamId: team.id };
  }
}
