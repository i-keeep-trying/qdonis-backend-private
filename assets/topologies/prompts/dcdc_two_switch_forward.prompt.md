## Topology-Specific Rules: Two-Switch Forward Converter
- **PWM SYNCHRONIZATION (CRITICAL JSON OVERRIDE)**: A Two-Switch Forward converter requires BOTH primary switches to conduct simultaneously. The template defaults will cause a dead 0V circuit. You MUST override Rule 4 here: You MUST explicitly include both the `PWM1` and `PWM2` blocks in your JSON output. For BOTH blocks, you MUST output `"delay": 0`, `"tdelay": 0`, and `"phase_shift": 0`. You MUST also output the exact same `duty_cycle` and `frequency` for both. Do NOT omit these keys.

- **CRITICAL OVERRIDE TO RULE 7**: Explicitly IGNORE Rule 7's anchoring constraints for the Magnetizing Inductance (`Lm`) and the Output Inductor (`L_OUT` or equivalent), as these vary wildly by power level.

- **DUTY CYCLE LIMIT (CORE RESET)**: To allow the transformer core to fully demagnetize through the primary clamping diodes during the OFF-time, the duty cycle `D` MUST strictly be less than 0.5. Choose a nominal target of `D = 0.40` to `0.45`.

- **DIODE DROP COMPENSATION**: The secondary side has a forward and freewheeling diode. The average voltage lost to these diodes is roughly 0.5V. For all transfer function calculations below, use `V_target = Vout + 0.5V`.

- **TRANSFORMER TURNS RATIO & DUTY CYCLE**: 
  - The transfer function of a forward converter is Buck-derived: `V_target = Vin * turns_ratio * D`.
  - Calculate required turns ratio: `turns_ratio = V_target / (Vin * D)`. (Where D is your nominal chosen duty cycle, e.g., 0.45).

- **OUTPUT FILTER INDUCTOR (L_OUT) SIZING**: 
  - The secondary side LC filter behaves exactly like a Buck converter.
  - Set peak-to-peak inductor ripple current: `Delta_I_L = 0.30 * Iout`.
  - Calculate `L_OUT = ((Vin * turns_ratio) - V_target) * D / (Delta_I_L * fsw)`.
  - Check Continuous Conduction Mode (CCM) boundary: Ensure `L_OUT > ( (1 - D) * R_LOAD ) / (2 * fsw)`.

- **MAGNETIZING INDUCTANCE (Lm)**:
  - Unlike a flyback, a forward converter transformer does not store energy. `Lm` should be large enough to keep the magnetizing current small.
  - Target a peak magnetizing current (`I_mag_pk`) that is ~10% of the reflected primary load current.
  - `I_pri = Iout * turns_ratio`.
  - `I_mag_pk = 0.10 * I_pri`.
  - Calculate: `Lm = (Vin * D) / (I_mag_pk * fsw)`.

- **VOLTAGE STRESS & COMPONENT SELECTION**:
  - **MOSFETs (Primary)**: The primary diodes clamp the reverse voltage to the input bus. Max stress `Vds_max = Vin`. Choose MOSFETs where `Vds >= 1.2 * Vin`. (Do NOT add Vout to the primary switch stress, this is unique to Two-Switch Forward).
  - **Primary Diodes**: Block the input bus. `Bv >= 1.2 * Vin`.
  - **Secondary Diodes**: Block the secondary transformer voltage. `Bv >= 1.5 * (Vin * turns_ratio)`.