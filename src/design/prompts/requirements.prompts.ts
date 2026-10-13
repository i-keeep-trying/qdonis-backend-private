import type {
  EngineeringCategoryId,
  MandatoryParameterStatus,
  MandatoryParametersAnalysis,
} from '../catalog/mandatory-parameters';
import { ENGINEERING_CATEGORIES } from '../catalog/mandatory-parameters';

/**
 * Requirements -> engineering specification (old `processRequirements` in
 * `services/geminiService.ts`), ported verbatim.
 */

function authority(parameter: MandatoryParameterStatus): string {
  switch (parameter.source) {
    case 'user_input':
      return 'designer_confirmed';
    case 'uploaded_document':
      return 'document_confirmed';
    case 'confirmed_assumption':
      return 'designer_approved_assumption';
    case 'assistant_recommendation':
      return parameter.isMissing
        ? 'unresolved_recommendation'
        : 'designer_accepted_recommendation';
    case 'llm_inference':
      return parameter.isMissing
        ? 'unresolved_inference'
        : 'derived_assumption';
  }
}

export function reviewedDesignIntentSection(
  analysis?: MandatoryParametersAnalysis | null,
): string {
  if (!analysis?.parameters?.length) return '';
  const reviewedSnapshot = {
    resolved: analysis.parameters
      .filter((p) => !p.isMissing)
      .map((p) => ({
        id: p.id,
        label: p.label,
        value: p.detectedValue,
        authority: authority(p),
      })),
    unresolved: analysis.parameters
      .filter((p) => p.isMissing)
      .map((p) => ({
        id: p.id,
        label: p.label,
        observedValue: p.detectedValue,
        suggestedValue: p.recommendedValue,
        authority: authority(p),
        reasonOpen: p.missingReason,
        suggestionBasis: p.recommendationReasoning,
      })),
    notes: analysis.notes,
  };

  return `
<reviewed_step_1_design_intent>
This is the current Step 1 review after the designer's edits and approvals. It takes precedence over conflicting values in the original input or uploaded document.

Rules for this reviewed data:
- Every item in "resolved" is available for design. Values marked "designer_confirmed", "document_confirmed", "designer_approved_assumption", or "designer_accepted_recommendation" are authoritative: preserve them rather than substituting a new default.
- A "derived_assumption" is a calculated or inferred working value. Preserve it unless a confirmed requirement conflicts with it.
- Every item in "unresolved" remains open. Its observedValue is partial evidence only; its suggestedValue and suggestionBasis are proposals, not confirmed facts. Clearly identify any value you derive from them as an assumption.
- Use "notes" as supplementary Step 1 engineering context when present.

${JSON.stringify(reviewedSnapshot, null, 2)}
</reviewed_step_1_design_intent>`;
}

export function requirementsPrompt(input: {
  userInput: string;
  categories: EngineeringCategoryId[];
  documentText: string | null;
  hasPdf: boolean;
  reviewed?: MandatoryParametersAnalysis | null;
}): string {
  const { categories } = input;
  const categoryLabels = categories
    .map((id) => ENGINEERING_CATEGORIES.find((c) => c.id === id)?.label ?? id)
    .join(', ');
  const userInputSection = input.userInput
    ? `User Requirements (Manual Input):
"${input.userInput}"`
    : '';
  let fileContentSection = '';
  if (input.hasPdf) {
    fileContentSection += `
Additional Context from Uploaded PDF Document:
The user has uploaded a PDF file (attached). Please extract and analyze the content from this PDF to understand the design requirements and specifications.

Please extract all relevant design parameters, specifications, and requirements from this PDF document.`;
  }
  if (input.documentText) {
    fileContentSection += `
Additional Context from Uploaded Document:
"${input.documentText}"`;
  }
  const reviewed = reviewedDesignIntentSection(input.reviewed);
  const ids = categories.join(', ');

  return `
You are a senior electrical engineer specializing in translating high-level product requirements into concrete circuit-level design specifications.

<goal>
Given:${userInputSection}${fileContentSection}${reviewed}
- The user has indicated particular interest in the following engineering categories:
  ${categoryLabels}

Please analyze both sources of information (manual input and uploaded document content) and intelligently combine them to extract comprehensive design parameters. Use the document content to provide additional context, clarifications, and specifications that complement or expand upon the manual input.

Your task is to derive specific, detailed engineering parameters relevant to the user's specification, with a strong focus on the selected categories. Additionally, provide relevant technical references and citations to support your parameter derivations.
</goal>

<additional_instructions>
- For each derived parameter, provide:
    1.  "name": A clear, descriptive name for the parameter (e.g., "Nominal Input Voltage (VIN)", "Maximum Ambient Operating Temperature", "Required Isolation Voltage").
    2.  "value": The determined engineering-sound value for the parameter (e.g., "48V DC", true, ["UL 60950-1"], "Up to 70°C ambient"). If a parameter relevant to a selected category cannot be reasonably inferred from the user input, its value can be null, with reasoning explaining why.
    3.  "reasoning": A concise explanation (target 30-100 words) for the derived value. Include any general assumptions made (e.g., derating factors, safety margins). Reference specific citations using [1], [2], etc. format within the reasoning text.
    4.  "categoryKey": The ID of the *user-selected engineering category* (from the list: ${ids}) that this parameter primarily falls under. Choose only one category ID per parameter.
    5.  "referencedCitations": An array of citation indices (e.g., [1, 3]) that correspond to the citations used in the reasoning for this parameter.
- Also provide an initial "recommendedTopology", general "assumptionsMade" (not specific to one parameter).
- Include an "overallCitations" array containing all technical references used throughout the response.
</additional_instructions>

<citation_format>
Each citation object should have:
- "title": A descriptive title of the reference (e.g., "IEEE Standard for Power Electronics", "Application Note: Buck Converter Design")
- "uri": A realistic technical URL or standard reference (e.g., "https://ieeexplore.ieee.org/document/example", "IEC 61000-6-3:2020")

Generate realistic technical citations relevant to power electronics, including:
- IEEE standards and papers
- Application notes from semiconductor manufacturers (TI, Analog Devices, Infineon, etc.)
- IEC/ISO standards
- Technical handbooks and design guides
</citation_format>

<output_format>
Provide a response structured ONLY as a JSON object (no markdown \`\`\`json fences or other text). The JSON object should have the following keys:
- "derivedParametersList": An array of objects. Each object represents a derived parameter and MUST contain the keys "name" (string), "value" (string, boolean, array of strings, or null), "reasoning" (string or null), "categoryKey" (string, one of ${ids}), and "referencedCitations" (array of integers).
- "recommendedTopology": An object for an initial single topology suggestion with:
    "name": string (e.g., "Buck", "Flyback"),
    "rationale": string (detailed explanation with citation references),
    "exampleApplications": string.
- "assumptionsMade": An array of strings detailing any general assumptions.
- "overallCitations": An array of citation objects, each with "title" (string) and "uri" (string).

Example for an item in "derivedParametersList":
{
  "name": "Maximum Output Current",
  "value": "2A continuous, 3A peak",
  "reasoning": "The user mentioned powering a small motor which typically has a continuous draw but requires higher peak current during startup [1]. A 50% margin for peak is assumed based on industry best practices [2].",
  "categoryKey": "electrical_output_load",
  "referencedCitations": [1, 2]
}

Example for "overallCitations":
[
  {
    "title": "Motor Drive Applications and Design Guidelines",
    "uri": "https://www.ti.com/lit/an/slva959/slva959.pdf"
  },
  {
    "title": "Power Supply Design Best Practices",
    "uri": "https://www.analog.com/media/en/technical-documentation/application-notes/AN-1613.pdf"
  }
]
</output_format>

<style_notes>
- Use standard engineering units and SI prefixes for parameter values.
- Write in clear, precise technical prose.
- Ensure citation numbering is consistent throughout the response.
- Generate 3-8 relevant technical citations to support the parameter derivations.
</style_notes>
`;
}
