import {
  CONFIDENCE_LEVELS,
  type Confidence,
  isMandatoryParameterId,
  MANDATORY_PARAMETER_DEFINITIONS,
  type MandatoryParameterId,
  type MandatoryParameterSource,
  type MandatoryParametersAnalysis,
  type MandatoryParameterStatus,
  PARAMETER_SOURCES,
} from './catalog/mandatory-parameters';
import { asArray, asString, isRecord } from './ai/json-response';

/**
 * Design-intent (mandatory parameter) rules, ported from the old frontend
 * (`designIntentService.ts` normalisation and the `App.tsx` review handlers).
 */

const definitionOf = (id: MandatoryParameterId) =>
  MANDATORY_PARAMETER_DEFINITIONS.find((d) => d.id === id);

const withMissing = (
  parameters: MandatoryParameterStatus[],
  notes: string | null,
) => ({
  parameters,
  missingParameters: parameters.filter((p) => p.isMissing),
  notes,
});

/** One model entry -> a complete, valid status (old `ensureStatusShape`). */
export function ensureStatusShape(
  id: MandatoryParameterId,
  payload: Record<string, unknown> | undefined,
): MandatoryParameterStatus {
  const source = asString(payload?.source);
  const confidence = asString(payload?.confidence);
  const text = (value: unknown): string | null =>
    value === null || value === undefined
      ? null
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);

  const status: MandatoryParameterStatus = {
    id,
    label: asString(payload?.label) || definitionOf(id)?.label || id,
    detectedValue: text(payload?.detectedValue),
    source: (PARAMETER_SOURCES as readonly string[]).includes(source ?? '')
      ? (source as MandatoryParameterSource)
      : 'assistant_recommendation',
    confidence: (CONFIDENCE_LEVELS as readonly string[]).includes(
      confidence ?? '',
    )
      ? (confidence as Confidence)
      : 'low',
    reasoning:
      asString(payload?.reasoning) ||
      'No explicit evidence supplied in the current design intent.',
    recommendedValue: text(payload?.recommendedValue),
    recommendationReasoning: asString(payload?.recommendationReasoning),
    isMissing:
      typeof payload?.isMissing === 'boolean' ? payload.isMissing : true,
    missingReason:
      asString(payload?.missingReason) ||
      'Pending clarification from the designer.',
  };
  const citation = payload?.citation;
  const documentName = isRecord(citation)
    ? asString(citation.documentName)
    : null;
  if (isRecord(citation) && documentName && citation.pageNumber) {
    status.citation = {
      documentName,
      pageNumber: Number(citation.pageNumber) || 1,
    };
  }
  return status;
}

/** Model JSON -> analysis covering every required parameter. */
export function buildAnalysis(
  parsed: Record<string, unknown>,
  requiredStageParams: MandatoryParameterId[],
): MandatoryParametersAnalysis {
  const required = new Set<string>(requiredStageParams);
  const seen = new Map<MandatoryParameterId, MandatoryParameterStatus>();
  for (const entry of asArray(parsed.parameters)) {
    if (!isRecord(entry) || !isMandatoryParameterId(entry.id)) continue;
    seen.set(entry.id, ensureStatusShape(entry.id, entry));
  }
  for (const def of MANDATORY_PARAMETER_DEFINITIONS) {
    if ((def.isAlwaysMandatory || required.has(def.id)) && !seen.has(def.id)) {
      seen.set(def.id, ensureStatusShape(def.id, undefined));
    }
  }
  return withMissing([...seen.values()], asString(parsed.notes));
}

/** Stage-specific ids from the model (always-mandatory ones are implied). */
export function parseStageParameters(
  parsed: Record<string, unknown>,
): MandatoryParameterId[] {
  const stageIds = new Set<string>(
    MANDATORY_PARAMETER_DEFINITIONS.filter((d) => !d.isAlwaysMandatory).map(
      (d) => d.id,
    ),
  );
  const ids: MandatoryParameterId[] = [];
  for (const item of asArray(parsed.requiredParameters)) {
    if (
      isRecord(item) &&
      isMandatoryParameterId(item.id) &&
      stageIds.has(item.id)
    ) {
      if (!ids.includes(item.id)) ids.push(item.id);
    }
  }
  return ids;
}

/** Re-analysis keeps values the designer typed or accepted (old `mergeMandatoryAnalysis`). */
export function mergeAnalysis(
  fresh: MandatoryParametersAnalysis,
  previous: MandatoryParametersAnalysis | null,
): MandatoryParametersAnalysis {
  if (!previous) return withMissing(fresh.parameters, fresh.notes);
  const overrides = new Map<MandatoryParameterId, MandatoryParameterStatus>();
  for (const p of previous.parameters) {
    if (
      p.detectedValue &&
      (p.source === 'user_input' ||
        (p.source === 'assistant_recommendation' && !p.isMissing))
    ) {
      overrides.set(p.id, p);
    }
  }
  const merged = fresh.parameters.map((p) => {
    const o = overrides.get(p.id);
    return o
      ? {
          ...p,
          detectedValue: o.detectedValue,
          source: o.source,
          confidence: o.confidence,
          reasoning: o.reasoning,
          isMissing: o.isMissing,
          missingReason: o.missingReason,
        }
      : p;
  });
  return withMissing(merged, fresh.notes);
}

/** Designer edits a value (empty = clear it); adds the parameter if absent. */
export function setParameterValue(
  analysis: MandatoryParametersAnalysis,
  id: MandatoryParameterId,
  rawValue: string,
  rawReasoning?: string,
): MandatoryParametersAnalysis {
  const value = rawValue.trim();
  const reasoning = rawReasoning?.trim();
  const index = analysis.parameters.findIndex((p) => p.id === id);
  if (index === -1) {
    if (!value) return analysis;
    const added: MandatoryParameterStatus = {
      id,
      label: definitionOf(id)?.label ?? id,
      detectedValue: value,
      source: 'user_input',
      confidence: 'high',
      reasoning:
        reasoning ||
        'Value provided directly by the designer in the mandatory capture step.',
      recommendedValue: null,
      recommendationReasoning: null,
      isMissing: false,
      missingReason: null,
    };
    return withMissing([...analysis.parameters, added], analysis.notes);
  }
  const updated = analysis.parameters.map((p) => {
    if (p.id !== id) return p;
    const isMissing = value.length === 0;
    return {
      ...p,
      detectedValue: isMissing ? null : value,
      source: isMissing ? p.source : ('user_input' as const),
      confidence: isMissing ? ('low' as const) : ('high' as const),
      reasoning: isMissing
        ? 'Awaiting explicit user input for this specification.'
        : reasoning ||
          'Value provided directly by the designer in the mandatory capture step.',
      isMissing,
      missingReason: isMissing ? 'Please supply this value to continue.' : null,
    };
  });
  return withMissing(updated, analysis.notes);
}

/** Accept the assistant's suggested value. */
export function acceptRecommendation(
  analysis: MandatoryParametersAnalysis,
  id: MandatoryParameterId,
): MandatoryParametersAnalysis {
  const updated = analysis.parameters.map((p) => {
    if (p.id !== id) return p;
    const suggested = (p.recommendedValue ?? '').trim();
    if (!suggested) return p;
    return {
      ...p,
      detectedValue: suggested,
      source: 'assistant_recommendation' as const,
      confidence:
        p.confidence === 'high' ? ('high' as const) : ('medium' as const),
      reasoning: p.recommendationReasoning
        ? `Assistant recommendation accepted: ${p.recommendationReasoning}`
        : 'Assistant recommendation accepted for this requirement.',
      isMissing: false,
      missingReason: null,
    };
  });
  return withMissing(updated, analysis.notes);
}

/** Turn an AI assumption into a confirmed value. */
export function approveAssumption(
  analysis: MandatoryParametersAnalysis,
  id: MandatoryParameterId,
): MandatoryParametersAnalysis {
  const updated = analysis.parameters.map((p) => {
    if (p.id !== id) return p;
    const value =
      p.isMissing && p.recommendedValue ? p.recommendedValue : p.detectedValue;
    return {
      ...p,
      detectedValue: value,
      source: 'confirmed_assumption' as const,
      reasoning:
        p.isMissing && p.recommendationReasoning
          ? `Confirmed: ${p.recommendationReasoning}`
          : 'Confirmed assumption from AI analysis.',
      isMissing: false,
      missingReason: null,
    };
  });
  return withMissing(updated, analysis.notes);
}

/** "Delete" resets the parameter to missing (it stays in the checklist). */
export function resetParameter(
  analysis: MandatoryParametersAnalysis,
  id: MandatoryParameterId,
): MandatoryParametersAnalysis {
  const updated = analysis.parameters.map((p) => {
    if (p.id !== id) return p;
    const reset: MandatoryParameterStatus = {
      ...p,
      detectedValue: null,
      source: 'assistant_recommendation',
      confidence: 'low',
      reasoning: 'Parameter was removed by user.',
      isMissing: true,
      missingReason: 'Please provide this value to continue.',
    };
    delete reset.citation;
    return reset;
  });
  return withMissing(updated, analysis.notes);
}

/** Stored analysis from project data, or null if absent / malformed. */
export function storedAnalysis(
  data: Record<string, unknown>,
): MandatoryParametersAnalysis | null {
  const raw = data.mandatoryParametersAnalysis;
  if (!isRecord(raw) || !Array.isArray(raw.parameters)) return null;
  const parameters = raw.parameters
    .filter(isRecord)
    .filter((p) => isMandatoryParameterId(p.id))
    .map((p) => ({
      ...ensureStatusShape(p.id as MandatoryParameterId, p),
      // Stored values are already reviewed: keep a null reason as null.
      missingReason: asString(p.missingReason),
    }));
  return withMissing(parameters, asString(raw.notes));
}
