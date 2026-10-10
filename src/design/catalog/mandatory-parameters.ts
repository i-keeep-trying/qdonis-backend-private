/**
 * Mandatory parameter catalogue and engineering categories (ported verbatim
 * from the old frontend `types.ts`). The order is the display order.
 */
export const MANDATORY_PARAMETER_DEFINITIONS = [
  {
    id: 'application',
    label: 'Application',
    description: 'Intended product or system that will use the power solution.',
    isAlwaysMandatory: true,
  },
  {
    id: 'input_voltage',
    label: 'Input Voltage',
    description: 'Nominal or allowable input voltage range or setpoint.',
    isAlwaysMandatory: true,
  },
  {
    id: 'input_current',
    label: 'Input Current',
    description: 'Nominal or maximum input current drawn by the converter.',
    isAlwaysMandatory: true,
  },
  {
    id: 'output_voltage',
    label: 'Output Voltage',
    description: 'Nominal output voltage or voltage range.',
    isAlwaysMandatory: true,
  },
  {
    id: 'output_current',
    label: 'Output Current',
    description: 'Continuous and/or peak output current requirements.',
    isAlwaysMandatory: true,
  },
  {
    id: 'input_type_ac_dc',
    label: 'Input Type (AC/DC)',
    description: 'Whether the converter input is AC, DC, or supports both.',
    isAlwaysMandatory: true,
  },
  {
    id: 'total_power',
    label: 'Total Power Requirement',
    description: 'Overall power throughput or output power target.',
    isAlwaysMandatory: true,
  },
  {
    id: 'output_configuration',
    label: 'Output Configuration',
    description: 'Indicates single or multiple outputs and qualitative notes.',
    isAlwaysMandatory: true,
  },
  {
    id: 'isolation_required',
    label: 'Isolation Requirement',
    description: 'Whether galvanic isolation is mandatory for safety or noise.',
    isAlwaysMandatory: true,
  },
  {
    id: 'output_isolation_relationship',
    label: 'Output Grounding Relationship',
    description:
      'How multiple outputs relate, e.g., common ground or isolated.',
    isAlwaysMandatory: true,
  },
  {
    id: 'environment',
    label: 'Operating Environment',
    description:
      'Usage environment such as indoor, outdoor, or harsh settings.',
    isAlwaysMandatory: true,
  },
  {
    id: 'geography_regulation',
    label: 'Geographic / Regulatory Domain',
    description: 'Target geography and applicable compliance regimes.',
    isAlwaysMandatory: true,
  },
  {
    id: 'size_constraints',
    label: 'Size Constraints',
    description: 'Physical constraints including footprint or height limits.',
    isAlwaysMandatory: true,
  },
  // Stage-specific parameters - conditionally needed based on design requirements
  {
    id: 'pfc_requirement',
    label: 'Power Factor Correction (PFC)',
    description:
      'Clarifies if active or passive PFC is required or recommended.',
    isAlwaysMandatory: false,
  },
  {
    id: 'input_filter_emc',
    label: 'Input Filter / EMC',
    description:
      'Input filtering and electromagnetic compatibility requirements.',
    isAlwaysMandatory: false,
  },
  {
    id: 'output_stage_filter',
    label: 'Output Stage Filter',
    description:
      'Output stage filtering requirements for ripple and noise reduction.',
    isAlwaysMandatory: false,
  },
  {
    id: 'pwm_requirement',
    label: 'Pulse Width Modulation (PWM)',
    description: 'PWM control strategy and switching frequency requirements.',
    isAlwaysMandatory: false,
  },
  {
    id: 'auxiliary_supply',
    label: 'Auxiliary / Housekeeping Supply',
    description:
      'Requirements for auxiliary power supplies and associated components.',
    isAlwaysMandatory: false,
  },
  {
    id: 'rectification_output_stage',
    label: 'Rectification at Output Stage',
    description: 'Output rectification topology and component requirements.',
    isAlwaysMandatory: false,
  },
  {
    id: 'output_filter',
    label: 'Output Filter',
    description:
      'Output filtering components for voltage regulation and noise suppression.',
    isAlwaysMandatory: false,
  },
] as const;

export type MandatoryParameterId =
  (typeof MANDATORY_PARAMETER_DEFINITIONS)[number]['id'];

export const MANDATORY_PARAMETER_IDS = MANDATORY_PARAMETER_DEFINITIONS.map(
  (d) => d.id,
);

export const isMandatoryParameterId = (
  value: unknown,
): value is MandatoryParameterId =>
  typeof value === 'string' &&
  (MANDATORY_PARAMETER_IDS as readonly string[]).includes(value);

export const PARAMETER_SOURCES = [
  'user_input',
  'uploaded_document',
  'llm_inference',
  'assistant_recommendation',
  'confirmed_assumption',
] as const;
export type MandatoryParameterSource = (typeof PARAMETER_SOURCES)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export interface MandatoryParameterStatus {
  id: MandatoryParameterId;
  label: string;
  detectedValue: string | null;
  source: MandatoryParameterSource;
  confidence: Confidence;
  reasoning: string;
  recommendedValue: string | null;
  recommendationReasoning: string | null;
  isMissing: boolean;
  missingReason: string | null;
  citation?: { documentName: string; pageNumber: number };
}

export interface MandatoryParametersAnalysis {
  parameters: MandatoryParameterStatus[];
  missingParameters: MandatoryParameterStatus[];
  notes: string | null;
}

export const ENGINEERING_CATEGORIES = [
  { id: 'electrical_input_source', label: 'Electrical Input (Source)' },
  { id: 'electrical_output_load', label: 'Electrical Output (Load)' },
  { id: 'functional_constraints', label: 'Functional Constraints' },
  { id: 'component_technology_limits', label: 'Component-Technology Limits' },
  { id: 'environmental_reliability', label: 'Environmental & Reliability' },
  { id: 'mechanical_form_factor', label: 'Mechanical & Form-Factor' },
  { id: 'compliance_regulatory', label: 'Compliance / Regulatory' },
  { id: 'cost_production', label: 'Cost & Production' },
  { id: 'schedule_risk', label: 'Schedule & Risk' },
  { id: 'system_level_interaction', label: 'System-Level Interactions' },
] as const;

export type EngineeringCategoryId =
  (typeof ENGINEERING_CATEGORIES)[number]['id'];
export const ENGINEERING_CATEGORY_IDS = ENGINEERING_CATEGORIES.map((c) => c.id);
