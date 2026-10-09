## Topology-Specific Rules: Four-Switch Buck-Boost (FSBB) Converter
- **FSBB PWM SYNCHRONIZATION (CRITICAL JSON OVERRIDE)**: You MUST override Rule 4 for ALL four PWM blocks. The template contains broken, asynchronous delays that will destroy the simulation. You MUST output exactly this structure in your JSON for the PWMs, substituting your calculated `D` (duty cycle), `1-D`, `fsw` (frequency), and `delay_val` (which is `D / fsw` in seconds):
  "PWM1": {"duty_cycle": D, "frequency": fsw, "delay": 0, "phase_shift": 0},
  "PWM4": {"duty_cycle": D, "frequency": fsw, "delay": 0, "phase_shift": 0},
  "PWM2": {"duty_cycle": 1-D, "frequency": fsw, "delay": delay_val, "phase_shift": 0},
  "PWM3": {"duty_cycle": 1-D, "frequency": fsw, "delay": delay_val, "phase_shift": 0}
  Failure to output ALL of these exact keys for ALL four switches will result in a completely dead circuit.

- **NON-INVERTING RESTRICTION & ABSOLUTE VALUE TARGET (CRITICAL)**: The FSBB topology is strictly non-inverting and CANNOT generate a negative voltage relative to ground. If the user requests a negative output target (such as -12V or -400V), you MUST design the converter to generate the ABSOLUTE VALUE of that voltage (+12V or +400V).
  * Use |Vout| for all formulas: `D = |Vout| / (Vin + |Vout|)`.
  * Load resistance: `R_LOAD = |Vout| / Iout` (must be strictly positive, never negative!).
  * Inductor sizing, ripple, and Cout must all be calculated using `|Vout|`.
  * In your `_reasoning`, explicitly state that because FSBB is strictly non-inverting, the converter has been designed to deliver the absolute magnitude +|Vout|.

- **DUTY CYCLE & TRANSFER FUNCTION**:
  - The converter operates in pure buck-boost mode. Effective duty cycle `D = |Vout| / (Vin + |Vout|)`.

- **INDUCTOR (L1) SIZING**:
  - Average inductor current `I_L = Iout * (Vin + Vout) / Vin`.
  - Set peak-to-peak ripple `Delta_I_L = 0.30 * I_L`.
  - ON-time volt-seconds: `L1 = (Vin * D) / (Delta_I_L * fsw)`.
  - Check CCM boundary: Ensure `I_L > Delta_I_L / 2`.

- **VOLTAGE STRESS & COMPONENT SELECTION**:
  - **MOSFETs**: The Buck leg sees `Vin`, and the Boost leg sees `Vout`. For safety, rate all 4 switches for the highest voltage present. Max stress `Vds_max = max(Vin, Vout)`. Choose MOSFETs where `Vds >= 1.2 * Vds_max`.
  - **Diodes**: If any external clamping/rectifier diodes are used, set `Bv >= 1.5 * max(Vin, Vout)`.
  - **Inductor**: The inductor sees AC switching voltage. You MUST calculate its RMS voltage properly (e.g., `V_rms = sqrt(D*Vin^2 + (1-D)*Vout^2)`). Do NOT set V_rms to 0.