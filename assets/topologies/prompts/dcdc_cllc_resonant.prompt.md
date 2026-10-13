## Topology-Specific Rules: CLLC Resonant Converter (Full-Bridge)
- **PWM SYMMETRY & DIAGONAL DEAD-TIME (CRITICAL JSON OVERRIDE)**: 
  A CLLC relies on perfectly symmetrical diagonal gate drives and dead-time for ZVS. Firing the top and bottom switches of the same leg simultaneously will cause a fatal short circuit.
  1. DO NOT use duty cycle to regulate. You MUST lock `"duty_cycle": 0.45` for all eight switches to ensure proper dead-time.
  2. You MUST override Rule 4 and explicitly output ALL EIGHT PWM blocks. 
  3. Diagonal primary pairs and their synchronous secondary rectifiers MUST fire in unison and alternate. 
  `PWM1`, `PWM4` (Primary) and `PWM6`, `PWM7` (Secondary) fire together at 0s. 
  `PWM2`, `PWM3` (Primary) and `PWM5`, `PWM8` (Secondary) fire delayed by exactly half the switching period (`T_half = 0.5 / frequency`). 
  "PWM1": {"duty_cycle": 0.45, "frequency": fsw, "delay": 0}
  "PWM4": {"duty_cycle": 0.45, "frequency": fsw, "delay": 0}
  "PWM6": {"duty_cycle": 0.45, "frequency": fsw, "delay": 0}
  "PWM7": {"duty_cycle": 0.45, "frequency": fsw, "delay": 0}
  "PWM2": {"duty_cycle": 0.45, "frequency": fsw, "delay": T_half}
  "PWM3": {"duty_cycle": 0.45, "frequency": fsw, "delay": T_half}
  "PWM5": {"duty_cycle": 0.45, "frequency": fsw, "delay": T_half}
  "PWM8": {"duty_cycle": 0.45, "frequency": fsw, "delay": T_half}
  (CRITICAL: Use the exact key `"delay"`, DO NOT use "tdelay").

- **Turns Ratio**: The primary is a full-bridge, so the full `Vin` is applied. You MUST use the formula `turns_ratio = (Vout / Vin)`.
- **Resonant Frequency Lock**: Operate EXACTLY at the resonant frequency!
  - `fsw = f_r`.
  - Calculate Quality Factor `Q = Zo / Rac` (where `Zo = sqrt(L_r / C_r)`) to be between 0.3 and 0.5.
  - Explicitly satisfy `f_r = 1 / (2 * pi * sqrt(L_r * C_r))`.
- **Duty Cycle & Dead Time**: DO NOT use duty cycle to regulate. Leave `duty_cycle = 0.45`.
  - **CRITICAL DEAD-TIME**: You MUST emit `tdelay` for the second switch (PWM2): `tdelay = 0.5 / frequency`.
- **Center-Tapped Transformer (`ct_transformer`)**:
  - DO NOT emit `K1`, `K2`, or `K12`. Emit ONLY `k_coupling = 0.99999`.
  - Anti-phase secondaries are expressed ONLY via `phase_s1` / `phase_s2` (`same` or `opposite`), never by sign-flipping `k_coupling`.
- **Diode Avalanche Protection**: For the center-tapped secondary, set diode `Bv >= 2.5 * Vout`.
- **Secondary Impedance Scaling**: You MUST calculate the secondary resonant components by scaling the primary components using the square of the turns ratio ($N_s^2$). $L_s = L_r \times N_s^2$ and $C_s = C_r / N_s^2$. Do NOT output arbitrary microhenry values for high-current/low-voltage secondary tanks.
- **Parasitics Minimization**: For any target power over 1kW, you MUST set all series source resistors (RVIN_series) to 0.001 ohms maximum.
- **MOSFET Selection**: MUST calculate the expected RMS current ($I = Power / Voltage$). The chosen .model NMOS Rs parameter must be low enough that the total voltage drop across two series MOSFETs does not exceed 1% of the bus voltage. Modify the Rs parameter dynamically if necessary.