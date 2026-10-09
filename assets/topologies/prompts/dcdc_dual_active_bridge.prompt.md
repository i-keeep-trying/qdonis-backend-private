## Topology-Specific Rules: Dual Active Bridge (DAB) DC-DC Converter

The Dual Active Bridge (DAB) converter is an isolated bidirectional topology consisting of a primary full bridge, a high-frequency transformer with series leakage inductance $L_k$, a secondary full bridge, and a closed-loop phase-shift controller.

### 1. MAIN POWER & LOAD RESISTOR SIZING ($R_{LOAD}$)
- **Main Converter Power**: Extract the nominal high-voltage converter power $P_{out}$ (e.g. from user constraints or $P_{out} = V_{out} \cdot I_{out}$).
- **DO NOT CONFUSE WITH AUXILIARY SUPPLIES**: Never use auxiliary gate driver or control power (e.g. 12V/15V auxiliary power supplies) as the converter's power rating!
- **Load Resistance Formula**:
  $$R_{LOAD} = \frac{V_{out}^2}{P_{out}}$$
  * Example 1 (48V to 400V, 1kW): $R_{LOAD} = \frac{400^2}{1000} = \mathbf{160\,\Omega}$ (NEVER $13333\,\Omega$!).
  * Example 2 (400V to 400V, 10kW): $R_{LOAD} = \frac{400^2}{10000} = \mathbf{16\,\Omega}$.
  * Example 3 (60V to 60V, 2.88kW): $R_{LOAD} = \frac{60^2}{2880} = \mathbf{1.25\,\Omega}$.

---

### 2. TRANSFORMER RATIO & MAGNETIZING INDUCTANCE ($T1$)
- **Turns Ratio ($n = N_s / N_p$)**:
  Since both primary and secondary are full H-bridges, the matched turns ratio is:
  $$n = \frac{V_{out}}{V_{in}}$$
  * For $V_{in} = 48\text{V}, V_{out} = 400\text{V} \implies n = \frac{400}{48} = \mathbf{8.3333}$.
  * For $V_{in} = 400\text{V}, V_{out} = 400\text{V} \implies n = \mathbf{1.0}$.
- **Magnetizing Inductance ($L_m$) Sizing**:
  Magnetizing current ripple must be kept $\le 5\%$ of rated primary current ($I_{in\_nom} = P_{out} / V_{in}$) to prevent excessive circulating ripple current and massive conduction losses:
  $$L_m \ge \frac{V_{in}^2}{4 \cdot f_s \cdot (0.05 \cdot P_{out})}$$
  * **Strict Minimum Floor**: Always enforce $L_m \ge 500\,\mu\text{H}$ (e.g. $500\,\mu\text{H}$ to $5\,\text{mH}$).
  * **CRITICAL**: NEVER set $L_m = 10\,\mu\text{H}$ on a 48V primary at 100kHz! A 10µH inductance draws an intolerable 24A peak-to-peak circulating reactive current through the primary switches! Set $L_m \ge 500\,\mu\text{H}$ ($L_m = 500\,\mu\text{H}$ reduces ripple to $<0.5\,\text{A}$).

---

### 3. LEAKAGE INDUCTANCE ($L_k$) & DYNAMIC POWER HEADROOM
- **DAB Power Transfer Equation**:
  The theoretical maximum power transfer of a DAB at maximum phase shift ($D = 0.25 \implies \phi = 90^\circ$) is:
  $$P_{max} = \frac{V_{in} \cdot (V_{out} / n)}{8 \cdot f_s \cdot L_k}$$
- **Physical Choke Avoidance**:
  The physical choke limit is $L_{k\_choke} = \frac{V_{in} \cdot (V_{out} / n)}{8 \cdot f_s \cdot P_{out}}$. If $L_k \ge L_{k\_choke}$, the converter physically cannot deliver rated power even at $100\%$ control saturation!
- **Required Sizing (1.5x to 2.5x Headroom)**:
  Size $L_k$ for $1.5\times$ to $2.0\times$ power headroom ($P_{max} \approx 1.5 \cdot P_{out}$):
  $$L_k = \frac{V_{in} \cdot (V_{out} / n)}{8 \cdot f_s \cdot (1.5 \cdot P_{out})}$$
  * For $V_{in} = 48\text{V}, V_{out} = 400\text{V}, n = 8.3333, P_{out} = 1000\text{W}, f_s = 100\text{kHz}$:
    $$L_k = \frac{48 \cdot 48}{8 \cdot 100000 \cdot 1500} = \mathbf{1.92\,\mu\text{H}} \approx \mathbf{2.0\,\mu\text{H}}$$
    (Setting $L_k = 50\,\mu\text{H}$ chokes power to only $57.6\,\text{W}$ and is strictly prohibited!).
  * For $V_{in} = 400\text{V}, V_{out} = 400\text{V}, n = 1.0, P_{out} = 10000\text{W}, f_s = 70\text{kHz}$:
    $$L_k = \frac{400 \cdot 400}{8 \cdot 70000 \cdot 15000} \approx \mathbf{19.0\,\mu\text{H}}$$
- **Damping Resistor**: Always include damping resistor $R_{damp} = 1\,\text{k}\Omega$ in parallel with $L_k$.

---

### 4. CLOSED-LOOP PI CONTROL & POLE-ZERO CANCELLATION
The DAB converter uses a closed-loop PI controller designed for exact pole-zero cancellation against the output plant pole:
- **Output Plant Pole**:
  $$\omega_p = \frac{1}{R_{LOAD} \cdot C_{OUT}} \quad \left(f_p = \frac{1}{2\pi \cdot R_{LOAD} \cdot C_{OUT}}\right)$$
- **Output Capacitor ($C_{OUT}$)**:
  * For high-voltage systems ($V_{out} \ge 100\text{V}$), use $C_{OUT} = 47\,\mu\text{F}$.
  * For low-voltage high-current systems ($V_{out} < 100\text{V}$), use $C_{OUT} = 4.7\,\text{mF}$.
- **Soft-Start Reference ($V_{ref\_raw}$)**:
  `pwl: "0 0 5m {Vout} 40m {Vout}"`
  Always scale reference to target $V_{out}$ (filtered by $R_{ref} = 1\,\text{k}\Omega, C_{ref} = 2\,\mu\text{F}$).
- **Proportional Gain ($K_p$)**:
  * $K_p = 0.001$ for $V_{in} \ge 200\text{V}$
  * $K_p = 0.002$ for $V_{in} < 200\text{V}$
  * `B_P`: `expression: "V(err) * {Kp}"`
- **Integral Gain ($G_{INT}$)**:
  Compensator zero $\omega_z = \frac{G_{INT}}{K_p \cdot C_{INT}}$ where $C_{INT} = 1\,\mu\text{F}$.
  Exact pole-zero cancellation requires $\omega_z = \omega_p$:
  $$G_{INT} = \frac{K_p \cdot C_{INT}}{R_{LOAD} \cdot C_{OUT}}$$
  * Example 1 (48V to 400V, 1kW, $R_{LOAD} = 160\,\Omega, C_{OUT} = 47\,\mu\text{F}, K_p = 0.002$):
    Plant pole $f_p = 21.16\,\text{Hz}$.
    $$G_{INT} = \frac{0.002 \cdot 1\times 10^{-6}}{160 \cdot 47\times 10^{-6}} = \mathbf{2.66\times 10^{-7}\,\text{A/V}} = \mathbf{0.266\,\mu\text{A/V}}$$
    (NEVER set $G_{INT} = 3.19\,\text{nA/V}$, which disables the integrator and prevents phase shift ramp-up).
  * Example 2 (400V to 400V, 10kW, $R_{LOAD} = 16\,\Omega, C_{OUT} = 47\,\mu\text{F}, K_p = 0.001$):
    Plant pole $f_p = 211.6\,\text{Hz}$.
    $$G_{INT} = \frac{0.001 \cdot 1\times 10^{-6}}{16 \cdot 47\times 10^{-6}} = \mathbf{1.33\times 10^{-6}\,\text{A/V}} = \mathbf{1.33\,\mu\text{A/V}}$$
- **Modulation Clamp ($B_{ctrl}$)**:
  `expression: "min(max(V(ctrl_raw), 0.001), 0.25)"` (bounds phase shift to $D \le 0.25$).

---

### 5. PHASE-SHIFT MODULATION & CARRIER ($V_{ramp}$)
- Sawtooth carrier period $T_{sw} = 1 / f_s$, $t_{fall} = 100\,\text{ns}$, $t_{rise} = T_{sw} - 100\,\text{ns}$.
- Secondary ramp: `B_sec_ramp`: `expression: "V(ramp) - V(ctrl) + (V(ramp) < V(ctrl))"`.
- Gate drive logic enforces 400ns dead time between upper and lower switches of each leg.

---

### 6. FULL TELEMETRY & FULL DURATION PLOTTING
- **DO NOT include a `save` directive** (such as `save v(n_out)...`). A restrictive `save` command discards internal MOSFET and transformer nodes from NGSpice RAM, causing `let v_SW1_auto = ...` to fail with a Fatal Error and aborting the simulation before plots and CSVs can be generated.
- **DO NOT include `xl <min> <max>` on plot commands** (e.g. `xl 35m 35.1m`). All plot and wrdata commands must cover the entire transient simulation timeline (from 0 to $t_{stop}$) so that the complete soft-start ramp and steady-state regulation are visible.