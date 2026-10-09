## Topology-Specific Rules: Buck Converter
- **Duty Cycle**: Regulate the output voltage using `duty_cycle = Vout / Vin`.
- **Inductor Sizing**: 
  - Average current `I_L = Iout`.
  - ON-time volt-seconds: `L = (Vin - Vout) * duty_cycle / (Delta_I_L * fsw)`.
  - Check if CCM (`I_L > Delta_I_L / 2`). If forced into DCM, use DCM equations.