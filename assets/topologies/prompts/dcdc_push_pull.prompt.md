## Topology-Specific Rules: Push-Pull Converter
- **PWM SYMMETRY & CONSISTENCY (CRITICAL JSON OVERRIDE)**: 
  1. Choose a SINGLE nominal duty cycle (e.g., `D = 0.40`). You MUST use this exact same `D` value for your turns ratio math AND your final JSON output.
  2. A Push-Pull converter MUST have perfectly symmetrical gate drives. You MUST override Rule 4 and explicitly output BOTH PWM blocks in your JSON. `PWM2` must be delayed by exactly half the switching period ($0.5 / f_{sw}$). Substitute your chosen `D`, `fsw`, and `delay_val`:
  "PWM1": {"duty_cycle": D, "frequency": fsw, "delay": 0, "phase_shift": 0},
  "PWM2": {"duty_cycle": D, "frequency": fsw, "delay": delay_val, "phase_shift": 0}
  Failure to output these exact keys will cause asymmetrical flux and destroy the converter.

- **CRITICAL OVERRIDE TO RULE 7**: Explicitly IGNORE Rule 7's anchoring constraints for `Lm_primary` and `LL1`.

- **DIODE DROP COMPENSATION**: The secondary uses a full-wave rectifier. Use `V_target = Vout + 0.5V` for all calculations.

- **TRANSFORMER TURNS RATIO & COUPLING**: 
  - Transfer function: $V_{target} = 2 \cdot V_{in} \cdot turns\_ratio \cdot D$.
  - Calculate required ratio: `turns_ratio = V_target / (2 * Vin * D)`.

- **Center-Tapped Coupling (`ct_transformer`)**: 
  - DO NOT emit `K1`, `K2`, or `K12` as keys. Emit ONLY `k_coupling = 0.99999`.
  - Anti-phase secondaries are expressed ONLY via `phase_s1` / `phase_s2` (`same` or `opposite`), never by sign-flipping `k_coupling`. Keep `k_coupling` positive.

- **OUTPUT FILTER INDUCTOR (L1) SIZING**: 
  - The secondary LC filter sees an effective frequency of $2 \cdot f_{sw}$.
  - Set peak-to-peak inductor ripple: $\Delta I_L = 0.30 \cdot I_{out}$.
  - Calculate `L1 = ((Vin * turns_ratio) - V_target) * D / (Delta_I_L * fsw)`.

- **MAGNETIZING INDUCTANCE (Lm_primary)**:
  - Push-pull transformers do not store energy. `Lm_primary` should keep the magnetizing current small (~10% of reflected load current).
  - $I_{mag\_pk} = 0.10 \cdot (I_{out} \cdot turns\_ratio)$.
  - Calculate: `Lm_primary = (Vin * D) / (I_mag_pk * fsw)`.

- **VOLTAGE STRESS**:
  - **Primary MOSFETs**: Due to autotransformer action, the OFF-state switch sees exactly TWICE the input voltage. $V_{ds\_max} = 2.5 \cdot V_{in}$. 
  - **Secondary Diodes**: The rectifier diodes must block twice the secondary voltage. $B_v \ge 1.5 \cdot (2 \cdot V_{in} \cdot turns\_ratio)$.