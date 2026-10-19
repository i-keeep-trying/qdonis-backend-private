## Topology-Specific Rules: Three-Phase Voltage Source Inverter (VSI)
- **Output voltage convention**: The AC output voltage requested by the user is the **line-to-line RMS** value (three-phase convention). The phase (line-to-neutral) values are `V_ph,rms = V_LL / sqrt(3)` and `V_ph,pk = V_LL * sqrt(2/3)`.
- **Modulation is automatic**: The SPWM references (V2, V3, V4) and their amplitude/frequency are written by the application from `m = V_ph,pk / (Vdc / 2)` (capped at 1.0) and the output frequency. Do NOT emit `spice_line` for V1..V4.
- **DC link**: Set `V5` `voltage` to the user's DC input voltage. If `V_LL > 0.612 * Vdc` the target is beyond linear SPWM; say so in the reasoning.
- **Load**: Each phase load `R = V_ph,rms^2 / (P / 3)`; the per-phase load resistors (R15, R16, R17) are set by the application when the power is given.
- **Output filter inductors (L1..L3)**: Size for a current ripple of 20-30% of the phase peak current at the switching frequency: `L = Vdc / (8 * fsw * Delta_I)`. Keep `2 * pi * f_out * L` well below `R` so the filter does not drop the fundamental by more than ~3%.
- **Modulation**: CCM/DCM calculations do not apply.
- **DC link**: R13 and R14 are balancing resistors in parallel with C1 and C2 (kept at 100 kOhm by the application). They are NOT series parasitics: never lower them.
- **Gate logic**: The comparators (CMP_AH..CMP_CL, `threshold` 0.2, `width` 0.02) are smooth (tanh) with a dead band around the carrier crossings (dead time); do not edit them.
