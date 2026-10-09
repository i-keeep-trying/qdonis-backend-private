## Topology-Specific Rules: Single-Switch Forward Converter
- **Duty Cycle**: Regulate using `D = Vout / (Vin * turns_ratio)`. Maximum D is limited by the reset winding (typically < 0.5).
- **Diode Margin**: For isolated topologies, set `Bv >= 1.5 * max_v_stress`.