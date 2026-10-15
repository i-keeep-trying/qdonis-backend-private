## Topology-Specific Rules: Single-Phase Diode Bridge Rectifier
- **AC input convention**: The input voltage requested by the user is the line **RMS** value. Set the `VAC` amplitude to the peak `Vpk = sqrt(2) * Vin_rms` and the frequency to the user's line frequency (default 50 Hz).
- **Output Filter Capacitor**: Every netlist MUST have an output filter capacitor `C_OUT` connected in parallel with the load `R_LOAD` to filter the rectified DC output and suppress ripple.
  - Sizing: Calculate capacitance based on load power and target ripple: `C_OUT = Pout / (2 * f_line * Vout * Vripple_pp)` where `Vripple_pp = ripple_frac * Vout` (default 5% ripple, i.e. `ripple_frac = 0.05`). Ensure `C_OUT >= 47uF`.
  - Voltage Rating: The capacitor sees the DC output voltage with peak up to `Vpk`. Set `std_voltage_rating` from the standard capacitor list `[6.3, 10, 16, 25, 35, 50, 63, 100, 160, 200, 250, 350, 400, 450, 500, 630, 800, 1000]` with >= 20% margin above `Vpk` (e.g. 400V for 230VAC line, 250V for 120VAC line).
- **Load**: `R_LOAD = Vout^2 / Pout`. Keep `R_LINE` small (<= 1% of R_LOAD, typically 0.5 to 2 ohms).
- **Diodes**: Each diode blocks peak inverse voltage `Vpk`. Set `Bv >= 1.5 * Vpk` and assign `std_voltage_rating` from the standard semiconductor list with >= 50% margin above `Vpk`.
