## Topology-Specific Rules: Boost Converter
- **Duty Cycle**: Regulate the output voltage using `duty_cycle = 1 - (Vin / Vout)`.
- **Inductor Sizing**:
  - Average current `I_L = Iout / (1 - duty_cycle)`.
  - ON-time volt-seconds: `L = Vin * duty_cycle / (Delta_I_L * fsw)`.
  - Check if CCM (`I_L > Delta_I_L / 2`).