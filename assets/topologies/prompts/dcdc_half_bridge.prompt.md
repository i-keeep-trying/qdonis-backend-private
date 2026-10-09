## Topology-Specific Rules: Half-Bridge Converter
- **Turns Ratio**: The half-bridge applies only `Vin / 2` to the primary. You MUST use the formula `turns_ratio = 2 * (Vout / Vin)`. For high power (>10A), use `1.04 * 2 * (Vout / Vin)`.
- **Duty Cycle & Dead Time**: DO NOT use duty cycle to regulate. Leave `duty_cycle = 0.45`.
  - **CRITICAL DEAD-TIME**: You MUST mathematically recalculate and emit `tdelay` for the second switch (PWM2) to be EXACTLY half the period: `tdelay = 0.5 / frequency`.
- **Diode Margin**: Set diode `Bv >= 2.5 * Vout` for center-tapped secondary, or `1.5 * max_v_stress` for full-bridge rectifiers.
- **Center-Tapped Coupling (`ct_transformer`)**: 
  - DO NOT emit `K1`, `K2`, or `K12` as keys. Emit ONLY `k_coupling = 0.99999`.
  - Anti-phase secondaries are expressed ONLY via `phase_s1` / `phase_s2` (`same` or `opposite`), never by sign-flipping `k_coupling`.