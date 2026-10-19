## Topology-Specific Rules: Totem-Pole Bridgeless PFC Rectifier
- **AC input convention**: The input voltage requested by the user is the line **RMS** value. The AC source amplitude is the peak `Vpk = sqrt(2) * Vin_rms`; use the user's line frequency (default 50 Hz).
- **Control scaling is automatic**: The application writes the AC source amplitude/frequency, the load (`Vout^2 / Pout`), the output voltage target and every behavioural-source control expression (current-reference multiplier, error amplifiers, feed-forward) from the user's Vin, Vout and Pout. Do NOT edit any behavioural (B_*/E_*/G_*) source or control block (gain, integrator, comparator, ...).
- **Output capacitor**: Size the bulk capacitor for the twice-line-frequency ripple: `C >= Pout / (2*pi*2*f_line * Vout * dV)` with `dV = 5% of Vout`.
- **PFC inductor (L_PFC)**: Size for 20-30% current ripple at the line peak: `L = Vpk * (1 - Vpk/Vout) / (Delta_I * fsw)` with `Delta_I = 0.25 * I_pk`, `I_pk = 2 * Pout / (eta * Vpk)`.
- **Semiconductors**: Both the fast (HF) and line-frequency (LF) legs block `Vout`. Use `Bv >= 1.5 *` the blocking voltage.
