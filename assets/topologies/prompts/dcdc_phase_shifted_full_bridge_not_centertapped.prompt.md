## Topology-Specific Rules: Phase-Shifted Full-Bridge (Not Center-Tapped)
- **Turns Ratio**: The primary applies the full `Vin`. Use `turns_ratio = (Vout + 1.0) / (Vin * 0.85)`.
- **Phase-Shift Regulation**: You MUST NOT regulate voltage using `frequency` or `duty_cycle`. Regulate using the phase shift (`tdelay`) of the right leg (PWM3/PWM4).
- **Resonant Inductor (L_R)**: Size L_R to keep duty cycle loss <= 5%. `L_R_max = (0.05 * Vin) / (2 * I_primary * fsw)`.
- **Duty Cycle Loss Comp**: `D_loss = (2 * L_R * I_primary * fsw) / Vin`. Set `D_eff = ((Vout + 1.0) / (Vin * turns_ratio)) + D_loss`.
- **Overlap & Delays**: `t_overlap = D_eff * (0.5 / frequency)`. 
  `PWM3_tdelay = (0.5 / frequency) + t_overlap - (duty_cycle / frequency)`
  `PWM4_tdelay = PWM3_tdelay + (0.5 / frequency)`
- **Diode Margin**: Bridge rectifiers `Bv >= 1.5 * max_v_stress`.