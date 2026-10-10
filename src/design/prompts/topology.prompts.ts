/**
 * Top-3 topology recommendation (old `getTopNTopologies` in
 * `services/geminiService.ts`), ported verbatim. The list must stay in sync
 * with the simulation topology library.
 */
export const SUPPORTED_TOPOLOGY_NAMES = [
  'Buck',
  'Boost',
  'Buck-Boost',
  'Ćuk',
  'SEPIC',
  'Zeta',
  'Synchronous Buck Converter',
  'Interleaved Multiphase Buck Converter',
  'FSBB Converter',
  'Flyback',
  'Active-Clamp Flyback Converter',
  'Push-Pull',
  'Half-Bridge',
  'Full-Bridge',
  'Phase Shift Full Bridge Converter',
  'Half-Bridge LLC Resonant',
  'Full-Bridge LLC Resonant',
  'Single-Switch Forward',
  'CLLC Resonant Converter',
  'Dual Active Bridge Converter',
  'Two Switch Forward Converter',
  'Single Phase Full Bridge Inverter',
  'Three-Phase Voltage Source Inverter (SPWM)',
  'Three Level Neutral Point Clamped',
  'T-Type Multilevel Inverter',
  'Single Phase Diode Bridge Rectifier',
  'Single Phase Full Wave Rectifier (Transformer)',
  'Centre Tapped Full Wave Rectifier',
  'Single Phase Boost PFC Rectifier',
  'Interleaved Boost PFC Rectifier',
  'Totem Pole Bridgeless PFC Rectifier',
  'Three Phase Active Front End',
  'Single Phase Active Front End',
  'Three-Phase Vienna Rectifier',
  'Flyback PFC DCM',
] as const;

export function topologyPrompt(
  parametersJson: string,
  requirements: string | null,
): string {
  return `
You are Q, an AI-powered engineering specification system with expertise in power electronics circuit topologies.

Based on the following confirmed design parameter values for a power electronic circuit:
${parametersJson}

${requirements ? `User's original design requirements/prompt:\n"${requirements}"\n` : ''}

IMPORTANT: You MUST only recommend topologies from the following supported list. Do not suggest any other topologies.

SUPPORTED TOPOLOGIES (choose only from these 35 options):
1. "Buck" - Step-down DC-DC converter (non-isolated, Vout < Vin)
2. "Boost" - Step-up DC-DC converter (non-isolated, Vout > Vin)
3. "Buck-Boost" - Inverting step-up/down DC-DC converter (non-isolated, naturally inverting, negative output Vout < 0)
4. "Ćuk" - Inverting buck-boost with continuous current (non-isolated, Vout can be higher or lower than Vin)
5. "SEPIC" - Single-ended primary-inductor converter (non-isolated, Vout can be higher or lower than Vin, non-inverting)
6. "Zeta" - Fourth-order non-inverting converter (non-isolated, Vout can be higher or lower than Vin)
7. "Synchronous Buck Converter" - High-efficiency step-down DC-DC converter with synchronous rectification (non-isolated)
8. "Interleaved Multiphase Buck Converter" - Multi-phase buck converter for high-current applications (non-isolated)
9. "FSBB Converter" - Four-Switch Buck-Boost converter for seamless step-up/step-down (non-isolated, strictly non-inverting, positive output only. Never select for negative output)
10. "Flyback" - Isolated step-up/step-down converter with single switch (isolated)
11. "Active-Clamp Flyback Converter" - Isolated flyback with active-clamp for leakage energy recycling and ZVS (isolated)
12. "Push-Pull" - Center-tapped transformer converter driven by two alternating switches (isolated)
13. "Half-Bridge" - Medium-power isolated converter (isolated)
14. "Full-Bridge" - High-power isolated converter driving a center-tapped transformer (isolated)
15. "Phase Shift Full Bridge Converter" - High-power full H-bridge with phase-shift control for ZVS (isolated)
16. "Half-Bridge LLC Resonant" - Half-bridge resonant converter for high efficiency and soft switching (isolated)
17. "Full-Bridge LLC Resonant" - Full-bridge resonant converter for high power and high efficiency (isolated)
18. "Single-Switch Forward" - Single-switch forward converter (isolated)
19. "CLLC Resonant Converter" - Bidirectional isolated resonant converter with symmetric CLLC tanks (isolated)
20. "Dual Active Bridge Converter" - Bidirectional isolated DC-DC converter with two H-bridges (isolated)
21. "Two Switch Forward Converter" - Isolated forward converter with two switches and automatic demagnetization (isolated)
22. "Single Phase Full Bridge Inverter" - Single-phase H-bridge DC-AC inverter (inverter)
23. "Three-Phase Voltage Source Inverter (SPWM)" - Two-level three-phase VSI using SPWM, converting DC to three-phase AC (inverter)
24. "Three Level Neutral Point Clamped" - Single-phase three-level NPC multilevel inverter (inverter)
25. "T-Type Multilevel Inverter" - Single-phase three-level T-Type multilevel inverter (inverter)
26. "Single Phase Diode Bridge Rectifier" - Simple uncontrolled single-phase diode bridge rectifier (rectifier)
27. "Single Phase Full Wave Rectifier (Transformer)" - Single-phase full wave rectifier using a center-tapped transformer (rectifier)
28. "Centre Tapped Full Wave Rectifier" - Center tapped full wave rectifier (rectifier)
29. "Single Phase Boost PFC Rectifier" - Single-phase boost power factor correction converter (rectifier)
30. "Interleaved Boost PFC Rectifier" - Interleaved boost power factor correction converter (rectifier)
31. "Totem Pole Bridgeless PFC Rectifier" - Bridgeless totem-pole power factor correction converter (rectifier)
32. "Three Phase Active Front End" - Three-phase active front end rectifier with PI control (rectifier)
33. "Single Phase Active Front End" - Single-phase active front end rectifier with PI control (rectifier)
34. "Three-Phase Vienna Rectifier" - Three-phase Vienna rectifier with fully corrected and filtered control loop (rectifier)
35. "Flyback PFC DCM" - Flyback Power Factor Correction (PFC) operating in Discontinuous Conduction Mode (rectifier)

CRITICAL RULE: If the user's prompt, requirements, or design context explicitly mentions a specific topology by name (such as 'Buck-Boost' or 'Buck-Boost Converter'), you MUST include that exact topology (matching one of the 35 supported names) in your top 3 recommendations.
CRITICAL POLARITY RULE: If the target output voltage is negative (e.g. -12V, -400V), you MUST NOT recommend "FSBB Converter" (which is strictly non-inverting). You MUST recommend inverting topologies such as "Buck-Boost" or "Ćuk".

Please recommend the top 3 most suitable circuit topologies from the supported list above with supporting technical references.

For each of these 3 topologies, provide:
1. "name": string (MUST be exactly one of the 25 supported topology names above).
2. "pros": An array of 2-4 strings. Each string in this array MUST be a distinct advantage, fully quoted (e.g., "This is a pro."). Keep each pro concise.
3. "cons": An array of 2-4 strings. Each string in this array MUST be a distinct disadvantage, fully quoted (e.g., "This is a con."). Keep each con concise.
4. "rationale": A brief (1-2 sentences) explanation of why this topology is a good candidate, linking back to the provided parameter values. Include citation references using [1], [2], etc. format.
5. "relevantCitations": An array of citation objects, each with "title" (string) and "uri" (string), that specifically support this topology recommendation.

<citation_guidelines>
Generate realistic technical citations for each topology, including:
- IEEE papers on specific topologies
- Application notes from semiconductor manufacturers (TI, Analog Devices, Infineon, Maxim, etc.)
- Technical handbooks and design guides
- Industry standards relevant to the topology
- Academic papers on topology analysis and design

Each citation should be directly relevant to the specific topology being discussed.
</citation_guidelines>

Structure your response ONLY as a JSON object (do not add any text before or after the JSON object, and do not use markdown \`\`\`json fences). The JSON object should have a single key "topologies", which is an array of exactly 3 objects, each matching the structure described above.

Example structure:
{
  "topologies": [
    {
      "name": "Flyback",
      "pros": ["Good for required galvanic isolation and moderate power levels.", "Simple control scheme with single switch.", "Cost-effective for low to medium power applications."],
      "cons": ["Higher transformer stress compared to forward converters.", "Limited power handling capability.", "Requires snubber circuits for voltage spikes."],
      "rationale": "This topology is ideal for isolated applications up to 100W with its simple single-switch design [1]. The flyback's inherent isolation capability matches the galvanic isolation requirement [2].",
      "relevantCitations": [
        {
          "title": "Flyback Converter Design Considerations",
          "uri": "https://www.ti.com/lit/an/slua618a/slua618a.pdf"
        },
        {
          "title": "Isolated DC-DC Converter Topologies",
          "uri": "https://www.analog.com/media/en/technical-documentation/application-notes/AN-1613.pdf"
        }
      ]
    }
  ]
}

Focus on relevance to the provided parameter values and ensure each topology has 2-3 supporting citations.
`;
}

/** Injected when the user asked for buck-boost and the model left it out. */
export function buckBoostFallback(
  requirements: string,
  params: Record<string, unknown>,
): {
  name: string;
  pros: string[];
  cons: string[];
  rationale: string;
  relevantCitations: Array<{ title: string; uri: string }>;
} {
  const text = (v: unknown, fallback: string) =>
    typeof v === 'string' || typeof v === 'number' ? String(v) : fallback;
  return {
    name: 'Buck-Boost',
    pros: [
      'Capable of both step-up and step-down voltage conversion.',
      'Simple structure with a single switch and inductor.',
      'Cost-effective for non-isolated step-up/down requirements.',
    ],
    cons: [
      'Inverting topology (output voltage has opposite polarity of input).',
      'Discontinuous input and output currents lead to high ripple.',
      'Higher switch voltage and current stress compared to Buck or Boost.',
    ],
    rationale: `Buck-Boost is recommended because your design requirements ("${requirements.substring(0, 100)}") explicitly ask for a buck-boost converter to convert ${text(params.inputVoltage, 'the input')} to ${text(params.outputVoltage, 'the output')}.`,
    relevantCitations: [
      {
        title: 'Buck-Boost Converter Design Guide',
        uri: 'https://www.ti.com/lit/an/snva861/snva861.pdf',
      },
    ],
  };
}
