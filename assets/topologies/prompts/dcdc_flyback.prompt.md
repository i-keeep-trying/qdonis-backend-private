## Topology-Specific Rules: Flyback Converter
- **CRITICAL OVERRIDE TO RULE 7**: For Flyback Converters, Magnetizing Inductance (`Lm`) varies by orders of magnitude depending on the power level. You MUST use your calculated `Lm` value and explicitly IGNORE Rule 7's anchoring constraints for this specific component.

- **RC SNUBBER POWER DRAIN (CRITICAL)**: The template uses a simple RC snubber (`RRSN_P`, `CCSN_P`), NOT an RCD clamp. If you size `CCSN_P` in the nanofarad range, it will burn massive power ($P = C \cdot V^2 \cdot f_{sw}$) every cycle and collapse the output voltage. You MUST keep `CCSN_P` very small (e.g., `100e-12` to `470e-12`) and `RRSN_P` between `10` and `100` to lightly damp ringing without draining primary power.

- **DIODE DROP COMPENSATION**: In low-voltage outputs, the diode forward voltage ($V_f \approx 0.5V$) causes significant errors. For ALL calculations below, use `V_target = Vout + 0.5V` instead of just `Vout`.

- **CONDUCTION MODE SEGREGATION (CRITICAL)**: You must explicitly choose between CCM and DCM based on the user's constraints, and STRICTLY use the math for that specific mode. 

- **PATH A: Continuous Conduction Mode (CCM)**
  - **Turns Ratio & Duty Cycle**: Choose a nominal duty cycle (e.g., D = 0.45). `turns_ratio = (V_target / Vin) * ((1 - D) / D)`. Alternatively, if turns_ratio is fixed, calculate `D = V_target / (V_target + Vin * turns_ratio)`.
  - **Critical Inductance (L_crit) - THE CCM BOUNDARY**: To guarantee CCM, you MUST calculate the critical inductance: `L_crit = (Vin * D)^2 / (2 * P_in * fsw)`, where `P_in = V_target * Iout`.
  - **Magnetizing Inductance (Lm)**: You MUST set `Lm` safely above `L_crit` (e.g., `Lm = 1.5 * L_crit`) to guarantee CCM operation.
  - **Verification**: Use ONLY the CCM transfer function: `V_target = Vin * turns_ratio * (D / (1 - D))`.

- **PATH B: Discontinuous Conduction Mode (DCM)**
  - **Turns Ratio & Duty Cycle**: Choose a nominal D (e.g., 0.40). Ensure `turns_ratio < (V_target / Vin) * ((1 - D) / D)` to allow core discharge.
  - **Magnetizing Inductance (Lm)**: In DCM, open-loop voltage is dictated by energy storage. Calculate `Lm = (Vin^2 * D^2 * R_LOAD) / (2 * V_target^2 * fsw)`.
  - **Critical Inductance Check**: You MUST verify `Lm < L_crit` to ensure DCM operation.
  - **Verification**: Use ONLY the DCM transfer function: `V_target = Vin * D * sqrt(R_LOAD / (2 * Lm * fsw))`. Do NOT use CCM equations.

- **MOSFET Selection**: `Vds_max = Vin + (V_target / turns_ratio) + Vspike` (Estimate `Vspike` as ~30% of `Vin`). Choose a MOSFET with Vds rating >= 1.2 * Vds_max.
- **Diode Breakdown Margin**: Set `Bv >= 1.5 * (V_target + (turns_ratio * Vin))`.