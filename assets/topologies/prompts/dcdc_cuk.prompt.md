## Topology-Specific Rules: Cuk Converter
- **Duty Cycle**: Regulate output voltage using `duty_cycle = Vout / (Vin + Vout)`.
- **Inductor Sizing**:
  - Average current L1 `I_L1 = Iout * Vout / Vin`. Average current L2 `I_L2 = Iout`.
  - ON-time volt-seconds for both: `L = Vin * duty_cycle / (Delta_I_L * fsw)`.
  - Check if CCM (`I_L > Delta_I_L / 2`). Size both inductors!