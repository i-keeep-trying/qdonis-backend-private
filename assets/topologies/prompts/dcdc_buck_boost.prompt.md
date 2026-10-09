## Topology-Specific Rules: Inverting Buck-Boost Converter
- **NMOS ENFORCEMENT (CRITICAL OVERRIDE)**: You MUST strictly obey Rule 14. Do NOT use a PMOS. You MUST select an NMOS for the high-side switch. The simulation engine automatically floats the PWM source between the Gate and Source. Set `vlow = 0` and `vhigh = 15`.

- **NEGATIVE VOLTAGE MATH (CRITICAL)**: This topology naturally generates a negative output voltage. For all component sizing and duty cycle calculations, you MUST use the ABSOLUTE value of the output voltage target. Include a 0.5V diode drop compensation: `V_target = |Vout| + 0.5V`.

- **DUTY CYCLE**: 
  - Calculate: `D = V_target / (Vin + V_target)`.

- **INDUCTOR (L1) SIZING**:
  - Average inductor current: `I_L = |Iout| / (1 - D)`.
  - Set peak-to-peak ripple: `Delta_I_L = 0.30 * I_L`.
  - Calculate: `L1 = (Vin * D) / (Delta_I_L * fsw)`.
  - Check Continuous Conduction Mode (CCM) boundary: Ensure `I_L > Delta_I_L / 2`.

- **VOLTAGE STRESS & COMPONENT SELECTION**:
  - **MOSFET**: In this topology, the switch must block the input voltage plus the absolute output voltage. Max stress `Vds_max = Vin + V_target`. Choose an NMOS where `Vds >= 1.2 * Vds_max`.
  - **Diode**: The diode also blocks the input plus absolute output. Set `Bv >= 1.5 * (Vin + V_target)`.
  - **Inductor RMS**: The inductor sees AC switching voltage. You MUST calculate its RMS voltage properly: `V_rms = sqrt(D * Vin^2 + (1-D) * V_target^2)`. Do NOT set V_rms to 0.