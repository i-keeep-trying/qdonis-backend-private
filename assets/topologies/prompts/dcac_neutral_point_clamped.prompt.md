## Topology-Specific Rules: Neutral-Point Clamped (NPC) Inverter
- **RMS Output Voltage**: Note that the AC output voltage requested by the user is the **RMS** value, NOT the peak value. You must calculate the peak value (`V_peak = V_rms * sqrt(2)`) when sizing components, calculating the modulation index, or setting the reference sine wave amplitude.
- **Modulation**: CCM/DCM calculations do not apply.
- Ensure the modulation index and carrier/switching frequency are consistent with the target output voltage relative to the DC-link/input voltage.
- `modulation_index ≈ Vout_peak / (Vin / 2)`.
- Keep the output L-C filter consistent with the switching frequency.