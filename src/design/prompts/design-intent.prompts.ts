import {
  MANDATORY_PARAMETER_DEFINITIONS,
  type MandatoryParameterId,
} from '../catalog/mandatory-parameters';

/**
 * Prompts of the design-intent step, ported verbatim from the old frontend
 * `services/designIntentService.ts`. Do not reword without re-validating the
 * outputs: the UI and later steps depend on their JSON shapes.
 */

function inputsSection(userInput: string, documentText: string | null): string {
  const userInputSection = userInput
    ? `User Requirements:\n"""${userInput}"""`
    : 'User Requirements:\n""';
  const fileContentSection = documentText
    ? `\n\nUploaded Document Excerpt:\n"""${documentText}"""`
    : '';
  return `${userInputSection}${fileContentSection}`;
}

export function stageParametersPrompt(
  userInput: string,
  documentText: string | null,
): string {
  const stageParamsList = MANDATORY_PARAMETER_DEFINITIONS.filter(
    (def) => !def.isAlwaysMandatory,
  )
    .map((def) => `- ${def.id}: ${def.label} — ${def.description}`)
    .join('\n');

  return `
You are an expert power electronics engineer. Analyze the design requirements and determine which stage-specific parameters are necessary for THIS specific design.

<inputs>
${inputsSection(userInput, documentText)}
</inputs>

<stage_specific_parameters>
${stageParamsList}
</stage_specific_parameters>

Task: Determine which of the above stage-specific parameters are NECESSARY for this design based on:
1. The topology implied by the requirements (AC-DC, DC-DC, linear, switching, etc.)
2. Input/output specifications (AC input → needs PFC/rectification, high power → needs EMC, etc.)
3. Regulatory requirements (geography, standards, power levels)
4. Design constraints and application context

Output ONLY the parameter IDs that are relevant, with brief reasoning for each.

JSON schema:
{
  "requiredParameters": [
    {
      "id": "parameter_id",
      "reasoning": "Brief explanation why this is needed for this design"
    },
    ...
  ],
  "overallReasoning": "High-level summary of design type and why these parameters matter"
}

Example for a 230VAC to 12VDC, 50W LED driver:
{
  "requiredParameters": [
    {"id": "pfc_requirement", "reasoning": "AC input >75W typically requires PFC for harmonic compliance"},
    {"id": "input_filter_emc", "reasoning": "AC-powered device needs EMC filtering for conducted emissions"},
    {"id": "rectification_output_stage", "reasoning": "AC to DC conversion requires rectification stage"},
    {"id": "pwm_requirement", "reasoning": "Switching converter topology for efficiency at this power level"},
    {"id": "output_filter", "reasoning": "LED driver needs smooth DC with low ripple"}
  ],
  "overallReasoning": "AC-DC flyback/buck-boost converter with PFC for LED lighting application"
}
`;
}

export function mandatoryParametersPrompt(
  userInput: string,
  documentText: string | null,
  requiredStageParams: MandatoryParameterId[],
): string {
  const required = new Set<string>(requiredStageParams);
  const parametersToAnalyze = MANDATORY_PARAMETER_DEFINITIONS.filter(
    (def) => def.isAlwaysMandatory || required.has(def.id),
  )
    .map((def) => `- ${def.id}: ${def.label} — ${def.description}`)
    .join('\n');

  return `
You are an expert power electronics engineer. Extract parameter values from the design requirements.

<inputs>
${inputsSection(userInput, documentText)}
</inputs>

<parameters_to_extract>
${parametersToAnalyze}
</parameters_to_extract>

Requirements:
- Output JSON only.
- Extract values for ALL parameters listed above.
- Populate "missingParameters" with entries that require clarification.
- For each object provide:
  * "id": exact ID from the catalogue.
  * "label": matching human-friendly label.
  * "detectedValue": explicit value from the inputs, or null if absent.
  * "source": one of ["user_input","uploaded_document","llm_inference","assistant_recommendation"].
    - Use "user_input" for values explicitly stated in user requirements.
    - Use "uploaded_document" for values found in the uploaded document.
    - Use "llm_inference" for values you infer from context (these are ASSUMPTIONS).
    - Use "assistant_recommendation" for suggested values when data is missing (these are ASSUMPTIONS).
  * "confidence": "high", "medium", or "low".
  * "reasoning": concise evidence trail (<60 words).
  * "recommendedValue": suggested value when clarification is needed (null otherwise).
  * "recommendationReasoning": justification for the recommendation (null if not needed).
  * "isMissing": true when clarification is required.
  * "missingReason": short explanation when "isMissing" is true.
  * "citation": (optional) object with "documentName" and "pageNumber" when source is "uploaded_document". Try to infer page number from document context if possible.
- Categorize parameters as CONFIRMED (source: user_input or uploaded_document) vs ASSUMPTIONS (source: llm_inference or assistant_recommendation).
- Avoid generic defaults; only infer when the input context supports it and mark confidence accordingly.
- Provide "notes" with optional overall remarks or null.

JSON schema:
{
  "parameters": [MandatoryParameterStatus, ...],
  "missingParameters": [MandatoryParameterStatus, ...],
  "notes": string | null
}
`;
}

export function projectNamePrompt(requirements: string): string {
  return `
You are an expert technical copywriter specializing in naming electronic circuit design projects.

Your task is to generate a short, professional, and descriptive **project name** based on the following circuit design requirements.

Guidelines:
- Reflect the **core circuit type** (e.g., AC-DC, DC-DC, Buck, Boost, Converter, Power Supply, Regulator, etc.)
- Include the **main purpose or application** if mentioned (e.g., robotics, medical, automotive, aerospace, IoT)
- Maintain a **technical and professional tone**
- Be **concise and clear** (maximum 50 characters)
- Avoid filler words, marketing buzzwords, or vague terms
- Return **only the project name**, without quotes, punctuation, or explanations

Circuit Requirements:
${requirements}

Examples of ideal names:
- 24V DC-DC Converter for Robotics
- Medical Device AC-DC Power Supply
- Oilfield Monitoring 15V Converter
- EV Subsystem 48V to 12V Module
- Satellite Comms 3.3V Power Stage
`;
}

/** Sent alongside PDF documents, which the model reads as attachments. */
export const PDF_ATTACHMENT_NOTE =
  '\n\nThe user has also attached PDF specification document(s). Read them and use every relevant design parameter, specification and requirement they contain.';
