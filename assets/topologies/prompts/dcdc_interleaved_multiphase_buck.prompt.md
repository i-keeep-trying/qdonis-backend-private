## Topology-Specific Rules: Interleaved Buck Converter
- **Structure**: Four interleaved synchronous buck phases (N_phases = 4). Phase k uses high-side switch `SW(2k-1)` driven by `PWM(2k-1)`, low-side switch `SW(2k)` driven by `PWM(2k)`, and inductor `Lk`. All switches are NMOS; the high-side gate drives float on their switch nodes, so keep `vlow = 0` and `vhigh = 12` for every PWM.
- **Gate timing is automatic**: Only set `PWM1` `duty_cycle` (the high-side duty) and `frequency`. The phase shifts (k * T / 4), the complementary low-side pulses and the dead time are derived from PWM1 by the application, so do NOT compute tdelay / duty for PWM2..PWM8.
- **Duty Cycle**: Regulate the output voltage using `duty_cycle = (Vout + I_phase * (R_on + R_L)) / Vin`, where `I_phase = Iout / N_phases`, `R_on` is the selected MOSFET on-resistance and `R_L` the inductor series resistance. This compensates the conduction drops of this open-loop design (the ideal `Vout / Vin` undershoots at high current).
- **Inductor Sizing**: Size ALL FOUR inductors (L1..L4) identically.
  - Average current `I_L = Iout / N_phases`.
  - ON-time volt-seconds: `L = (Vin - Vout) * duty_cycle / (Delta_I_L * fsw)`.
  - Check if CCM (`I_L > Delta_I_L / 2`).
- **Switches**: Size all eight MOSFETs (SW1..SW8) for `Vds_max = Vin` and `Id_max = I_L + Delta_I_L / 2`.
- **Output capacitor**: Interleaving cancels most of the ripple; size Cout for the 1% ripple target using the per-phase ripple at `N_phases * fsw`, while keeping `5 * R_LOAD * Cout` below the simulation `tstop`.
