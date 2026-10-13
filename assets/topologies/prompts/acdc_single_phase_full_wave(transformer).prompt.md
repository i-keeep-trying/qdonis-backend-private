## Topology-Specific Rules: Single Phase Full Wave (Transformer) Rectifier
- **Parasitics Minimization**: You MUST set all series trace resistances or transformer winding resistances (`R_PRI`, `R_SEC`) to 0.001 ohms (1 milliohm).
- **Load Resistor Calculation**: You MUST calculate the load resistor value based on your power target using $R_{load} = V_{out}^2 / P_{out}$, rather than hardcoding an arbitrary resistance.
- **Output Filtering**: The output MUST include a parallel output smoothing capacitor (`C_OUT`) to filter the full-wave rectified output into a steady DC voltage. You can either provide a specific value (e.g., 0.0022F) or calculate it based on a 5% allowable voltage ripple.
