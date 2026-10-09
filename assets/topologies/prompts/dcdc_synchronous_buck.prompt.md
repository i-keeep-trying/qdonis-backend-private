## Topology-Specific Rules: Synchronous Buck Converter
- **Duty Cycle & Dead Time (CRITICAL)**:
  - High-side switch (PWM1) uses `duty_cycle = Vout / Vin`.
  - Low-side synchronous switch (PWM2) MUST have `duty_cycle = 1 - D - (2 * dead_time / period)`.
  - PWM2 MUST have `tdelay = (D * period) + dead_time`.
  - Example: D=0.45, fsw=200kHz (period=5us), dead_time=100ns -> PWM1 D=0.45, tdelay=0; PWM2 D=0.51, tdelay=2.35e-6.
- **Inductor Sizing**: 
  - Average current `I_L = Iout`.
  - `L = (Vin - Vout) * duty_cycle / (Delta_I_L * fsw)`.