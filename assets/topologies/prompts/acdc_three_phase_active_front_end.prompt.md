## Topology-Specific Rules: Three-Phase Active Front End (AFE) Rectifier

To ensure a Three-Phase Active Front End (AFE) boost rectifier simulates stably, avoids numerical convergence crashes, and regulates cleanly to the target DC bus voltage, strictly adhere to the following power stage, control loop, and SPICE syntax rules:

### 1. 3-Phase Grid Scaling & Input Parameterization
- **Line-to-Line vs. Peak Line-to-Neutral Voltage**:
  - The AC grid sources (`V_A`, `V_B`, `V_C`) require peak line-to-neutral amplitude:
    $$V_{phase,pk} = \frac{V_{in(L-L)}}{\sqrt{3}} \cdot \sqrt{2} \approx 0.8165 \cdot V_{in(L-L)}$$
  - For $V_{in} = 380\text{V}_{RMS(L-L)}$: $V_{phase,pk} \approx 310.27\text{V}$.
  - For $V_{in} = 400\text{V}_{RMS(L-L)}$: $V_{phase,pk} \approx 326.60\text{V}$.
  - You MUST update the `amplitude` parameter of `V_A`, `V_B`, and `V_C` to $V_{phase,pk}$.
  - You MUST update the denominator in the reference current generators `B_REFA`, `B_REFB`, `B_REFC` to match this exact $V_{phase,pk}$ value:
    `expression: v(I_MAG) * (v(V_A_node) - v(N_star)) / V_phase_pk`

### 2. Power Balance & DC Load Sizing
- **DC Load Resistor**:
  - Calculate load resistance using nominal DC bus voltage and power:
    $$R_{DC} = \frac{V_{out}^2}{P_{out}}$$
  - For $700\text{V}$ at $10\text{kW}$: $R_{DC} = \frac{700^2}{10000} = 49.0\,\Omega$.
  - For $700\text{V}$ at $3\text{kW}$: $R_{DC} = \frac{700^2}{3000} = 163.33\,\Omega$.
  - Update `R_DC` parameter `resistance` to this value.
- **Voltage Error Amplifier (`B_ERR`)**:
  - Update the reference target in `B_ERR`: `expression: Vout - v(V_DC)`.
  - The negative terminal of `B_ERR` must be tied to Ground (`GND`), NEVER to `V_DC`.

### 3. Current Sizing & Limiter Clamping
- **Nominal Phase Currents**:
  - RMS phase current: $I_{phase,RMS} = \frac{P_{out}}{\sqrt{3} \cdot V_{in(L-L)}}$.
  - Peak phase current: $I_{phase,pk} = \sqrt{2} \cdot I_{phase,RMS} = \frac{\sqrt{2} \cdot P_{out}}{\sqrt{3} \cdot V_{in(L-L)}}$.
  - For $10\text{kW}$ at $380\text{V}$: $I_{phase,pk} \approx 21.5\text{A}$.
  - For $3\text{kW}$ at $400\text{V}$: $I_{phase,pk} \approx 6.12\text{A}$.
- **Current Magnitude Limiter (`B_VERR_RAW`)**:
  - Set the upper clamp of `B_VERR_RAW` with $30-40\%$ dynamic headroom: $I_{max} = \max(12.0, \text{round}(1.4 \times I_{phase,pk}))$.
  - Use ternary operators instead of `min()`/`max()` functions:
    `expression: (v(V_P) + v(V_I)) > I_max ? I_max : ((v(V_P) + v(V_I)) < 0 ? 0 : (v(V_P) + v(V_I)))`

### 4. Control Loop Architecture & Polarity
- **Integrator (`G_INT`) Polarity**:
  - The voltage error integrator `G_INT` must source current from Ground into the integrator capacitor node `V_I`:
    $I_{int} = g_m \cdot V(V_{ERR})$. In net connections, `+` is tied to `GND` and `-` is tied to `V_I` with $g_m = 0.005$ and $C_{INT} = 10\mu\text{F}$.
  - Never invert integrator polarity or let the integrator node float.
- **Current Error Amplifiers (`B_ERR_A`, `B_ERR_B`, `B_ERR_C`)**:
  - Use ternary anti-windup clamping to $\pm 12\text{V}$:
    `expression: ((v(I_REF_A) - v(V_IACT_A)) * 20) > 12 ? 12 : (((v(I_REF_A) - v(V_IACT_A)) * 20) < -12 ? -12 : ((v(I_REF_A) - v(V_IACT_A)) * 20))`

### 5. Damping Filter Network (No Shunt Grid Overload)
- **Series RC Damping**:
  - Damping resistors `R_DAMP_A`, `R_DAMP_B`, `R_DAMP_C` ($2\,\Omega$) must be in SERIES with `C_EMI_A`, `C_EMI_B`, `C_EMI_C` ($10\,\mu\text{F}$), connected from the phase node to `N_star`.
  - NEVER connect damping resistors in parallel with the capacitors directly across phase-to-neutral; a $2\,\Omega$ shunt across 230VAC dissipates $\sim 80\text{kW}$ and halts the simulation instantly.

### 6. Component Ratings & DC Link Sizing
- **Diode and MOSFET Breakdown Voltage (`Bv`)**:
  - Diode breakdown voltage must satisfy $B_v \ge 1.5 \times V_{out}$ ($1200\text{V}$ for $700\text{V}$ DC bus) to prevent catastrophic avalanche breakdown and voltage clamping.
  - Never emit duplicate `.model` definitions with low breakdown ratings (e.g. $B_v = 100\text{V}$).
- **DC Link Capacitor (`C_DC`)**:
  - Sized at $2200\,\mu\text{F}$ for systems $\ge 5\text{kW}$ ($1500\,\mu\text{F}$ for $< 5\text{kW}$) to stabilize DC link ripple within $1\%$.

### 7. Initial Conditions & Simulation Settings
- **Precharge Initial Conditions**:
  - Precharge DC link: $V(V_{DC}) = V_{out}$.
  - Precharge PI current integrator: $V(V_I) = I_{phase,pk}$.
  - Set `spice_settings: use_ic: false` so ngspice utilizes initial conditions to solve the operating point smoothly without appending `uic` (which causes `b_p#branch` convergence crashes).
- **Preserve Named Nets**:
  - Always preserve named nets (`V_DC`, `V_ERR`, `V_P`, `V_I`, `I_MAG`, `V_A_node`, `V_B_node`, `V_C_node`, `N_star`, `V_CTRL_A`, `V_TRI`) so behavioral source feedback loops remain connected.
