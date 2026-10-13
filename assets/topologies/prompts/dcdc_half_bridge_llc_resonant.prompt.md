## Topology-Specific Rules: Half-Bridge LLC Resonant Converter
- **PWM SYMMETRY & DEAD-TIME (CRITICAL JSON OVERRIDE)**: 
  A Half-Bridge LLC relies on perfectly symmetrical gate drives and dead-time for ZVS. 
  1. DO NOT use duty cycle to regulate. You MUST lock `"duty_cycle": 0.45` for both switches.
  2. You MUST override Rule 4 and explicitly output BOTH PWM blocks. 
  3. `PWM2` MUST be delayed by exactly half the switching period (`T_half = 0.5 / frequency`). 
  "PWM1": {"duty_cycle": 0.45, "frequency": fsw, "delay": 0, "phase_shift": 0}
  "PWM2": {"duty_cycle": 0.45, "frequency": fsw, "delay": T_half, "phase_shift": 0}
  (CRITICAL: Use the exact key `"delay"`, DO NOT use "tdelay").

- **TRANSFORMER TURNS RATIO & LOAD COMPENSATION**:
  - The half-bridge applies only `Vin / 2` to the primary. 
  - Calculate ideal primary-to-secondary ratio: `n = (Vin / 2) / (Vout + 0.5)`.
  - Calculate base SPICE turns ratio (Ns/Np): `base_ratio = 1 / n`.
  - **OPEN-LOOP COMPENSATION (CRITICAL)**: At high power, the dead-time loss (D=0.45) and massive primary IR drops severely reduce the output voltage. You MUST multiply the base ratio by 1.114: `turns_ratio = base_ratio * 1.114`.

- **RESONANT TANK CALCULATIONS (CRITICAL)**: 
  Operate EXACTLY at the resonant frequency (`fsw = f_r`). You MUST calculate the tank components exactly in this order:
  1. **Actual DC Load**: `Pout = Vout * Iout`. `R_load = (Vout^2) / Pout`.
  2. **Equivalent AC Load**: `R_ac = (8 * (n^2) / (pi^2)) * R_load`.
  3. **Quality Factor & Impedance**: Target `Q = 1` for full load at resonance. `Z_r = Q * R_ac`.
  4. **Resonant Inductor (LLr)**: `L_r = Z_r / (2 * pi * fsw)`.
  5. **Resonant Capacitor (CCr)**: `C_r = 1 / (2 * pi * fsw * Z_r)`.
  6. **Magnetizing Inductance (Lm)**: To ensure enough circulating current for ZVS, set `L_m = 6 * L_r`. Output this to the transformer `Lm` parameter.

- **Center-Tapped Transformer (`ct_transformer`)**:
  - DO NOT emit `K1`, `K2`, or `K12`. Emit ONLY `"k_coupling": 0.99999`.
  - Anti-phase secondaries are expressed ONLY via `phase_s1` and `phase_s2` (`same` or `opposite`), never by sign-flipping coupling. Keep `k_coupling` positive.

- **Diode Avalanche Protection & Stress**: 
  - For the center-tapped secondary, you MUST set the diode breakdown voltage `Bv >= 2.5 * Vout` to prevent Zener clamping action.
  - Primary MOSFETs block full input voltage: `Vds_max = Vin`. Choose `Vds >= 1.2 * Vin`.