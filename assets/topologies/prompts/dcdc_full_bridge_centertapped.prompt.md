## Topology-Specific Rules: Full-Bridge (Center-Tapped) Converter
- **Turns Ratio**: The primary applies the full `Vin`. Use `turns_ratio = (Vout + 1.0) / (Vin * 0.85)` (accounting for diode drops and effective D).
- **Phase-Shift Regulation**: You MUST NOT regulate voltage using `frequency` or `duty_cycle`. Regulate using the phase shift (`tdelay`) of the right leg (PWM3/PWM4).
- **Resonant Inductor (L_R)**: Size L_R to keep duty cycle loss <= 5%. `L_R_max = (0.05 * Vin) / (2 * I_primary * fsw)`.
- **Duty Cycle Loss Comp**: `D_loss = (2 * L_R * I_primary * fsw) / Vin`. Set `D_eff = ((Vout + 1.0) / (Vin * turns_ratio)) + D_loss`.
- **Overlap & Delays**: `t_overlap = D_eff * (0.5 / frequency)`. 
  `PWM3_tdelay = (0.5 / frequency) + t_overlap - (duty_cycle / frequency)`
  `PWM4_tdelay = PWM3_tdelay + (0.5 / frequency)`
- **Center-Tapped Transformer**: DO NOT emit `K1`, `K2`, or `K12`. Emit ONLY `k_coupling = 0.99999`. Anti-phase secondaries are expressed ONLY via `phase_s1` / `phase_s2` (`same` or `opposite`), never by sign-flipping `k_coupling`.
- **Diode Margin**: Center-tapped diode `Bv >= 2.5 * Vout` to prevent Zener clamping action.