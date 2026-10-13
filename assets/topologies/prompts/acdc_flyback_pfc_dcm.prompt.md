## Topology-Specific Rules: AC/DC Flyback PFC
- **MOSFET Selection**: Account for leakage inductance spikes: `Vds_max = Vin + (Vout / turns_ratio) + Vspike`. Choose MOSFET with Vds rating >= 1.2 * Vds_max.
- **Turns Ratio & Duty Cycle**:
  - Operates in DCM for Power Factor Correction.
  - DCM Duty Cycle formula: `D = (Vout / (Vin * turns_ratio)) * sqrt((2 * L_m * fsw) / R_LOAD)`.
- **Diode Breakdown Margin**: Set `Bv >= 1.5 * (Vout + (turns_ratio * Vin))`.
- **Snubber Sizing**: Size the primary RCD snubber dynamically. Estimate primary leakage inductance Llk as ~1.5% of primary magnetizing inductance Lm. Size Rsnub and Csnub to absorb leakage energy and clamp the drain voltage spike safely.