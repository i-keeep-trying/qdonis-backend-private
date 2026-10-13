// Ported verbatim from the old frontend; keep numerically identical (see specs).
/**
 * Thermal analysis and full loss budget for the Studio's Thermal stage.
 *
 * Loss budget — every part that turns power into heat:
 *   • semiconductors: conduction + switching + leakage from the LUT loss
 *     engine on the simulated waveforms (gate charge is NOT junction heat, it
 *     is booked under gate drive);
 *   • magnetics: core (iGSE) + DC and AC (Dowell) copper loss from the
 *     Magnetics stage, or I²·R of the netlist winding resistance when the
 *     magnetics have not been designed yet;
 *   • capacitors: I_rms²·ESR with the simulated capacitor current;
 *   • resistors (snubbers, damping, sense, bleeders): time-averaged v·i of
 *     the simulated waveforms (or V_rms²/R, I_rms²·R); nested RC snubbers
 *     without telemetry are estimated as C·ΔV²·f_sw;
 *   • gate drive: Q_g·V_drv·f_sw per switch (dissipated in the driver and
 *     gate resistors).
 * Load resistors are the output power, not loss.
 *
 * Thermal network per semiconductor (steady state):
 *   Tj = Ta + P·(Rθjc + Rθcs) + ΣP·Rθsa      (shared heatsink)
 *   Tj = Ta + P·Rθja                          (no heatsink)
 * The shared heatsink is sized so the worst device still meets
 * Tj ≤ Tj,max − margin. Magnetics use the temperature rise from the
 * magnetics stage. All assumptions are returned so the agent can explain them.
 */

export interface ThermalDeviceInput {
  ref: string;
  kind: 'switch' | 'diode';
  /** Heat in the die: conduction + switching + leakage, W. */
  lossW: number;
  technology?: 'SiC' | 'GaN' | 'Si' | 'IGBT';
  breakdown?: { conductionW: number; switchingW: number; leakageW: number };
  model?: string;
  /** How the loss was obtained (default: the loss engine on the simulated waveforms). */
  method?: string;
}

export interface ThermalMagneticInput {
  ref: string;
  lossW: number;
  coreW?: number;
  copperW?: number;
  /** Null when only the winding resistance is known (no core / rise data). */
  tempRiseC: number | null;
  source: 'magnetics design' | 'winding resistance' | 'user input';
}

export type LossCategory =
  'semiconductor' | 'magnetic' | 'capacitor' | 'resistor' | 'gate_drive';

export interface LossItem {
  ref: string;
  category: LossCategory;
  lossW: number;
  /** How the number was obtained. */
  method: string;
  detail?: string;
  /** Power rating of the part, W (resistors), if known. */
  ratingW?: number;
  status?: 'ok' | 'warm' | 'over';
}

export interface ThermalSettings {
  ambientC: number;
  marginC?: number; // design margin below Tj,max
  maxJunctionC?: number; // override for every device
  rthCs?: number; // case-to-sink incl. pad/grease, °C/W
  strategy?: 'auto' | 'none' | 'shared';
  /** Output power, W (from the load in the simulation, else the specs). */
  outputPowerW?: number | null;
  outputPowerSource?: 'simulation' | 'specs' | 'input';
}

export interface ThermalDeviceResult {
  ref: string;
  kind: 'switch' | 'diode';
  technology: string;
  lossW: number;
  breakdown?: ThermalDeviceInput['breakdown'];
  rthJc: number;
  rthCs: number;
  rthJa: number;
  tjMaxC: number;
  tjNoHeatsinkC: number;
  tjC: number;
  marginC: number;
  status: 'ok' | 'warm' | 'over';
}

export interface ThermalResult {
  ambientC: number;
  strategy: 'none' | 'shared';
  heatsink: null | {
    rsaRequired: number;
    sinkTempC: number;
    cooling: string;
    feasible: boolean;
  };
  devices: ThermalDeviceResult[];
  magnetics: Array<{
    ref: string;
    lossW: number;
    coreW?: number;
    copperW?: number;
    hotspotC: number | null;
    limitC: number;
    status: 'ok' | 'warm' | 'over';
    source: ThermalMagneticInput['source'];
  }>;
  /** Every heat source, largest first. */
  budget: LossItem[];
  /** Parts whose loss could not be evaluated (and why). */
  notEvaluated: Array<{ ref: string; reason: string }>;
  totals: {
    semiconductorW: number;
    magneticsW: number;
    capacitorW: number;
    resistorW: number;
    gateDriveW: number;
    totalW: number;
    outputPowerW?: number;
    outputPowerSource?: 'simulation' | 'specs' | 'input';
    efficiencyPct?: number;
  };
  assumptions: string[];
  warnings: string[];
}

const PACKAGE: Record<string, { rthJc: number; rthJa: number; tjMax: number }> =
  {
    'switch:SiC': { rthJc: 0.55, rthJa: 40, tjMax: 175 },
    'switch:GaN': { rthJc: 0.8, rthJa: 45, tjMax: 150 },
    'switch:IGBT': { rthJc: 0.45, rthJa: 40, tjMax: 175 },
    'switch:Si': { rthJc: 0.6, rthJa: 40, tjMax: 150 },
    'diode:SiC': { rthJc: 1.2, rthJa: 50, tjMax: 175 },
    'diode:Si': { rthJc: 1.5, rthJa: 50, tjMax: 150 },
  };

const MAGNETIC_LIMIT_C = 120;

const status = (
  t: number,
  limit: number,
  margin: number,
): 'ok' | 'warm' | 'over' =>
  t > limit ? 'over' : t > limit - margin ? 'warm' : 'ok';

function coolingFor(rsa: number): string {
  if (rsa >= 3)
    return `Small extruded aluminium heatsink, natural convection (Rθsa ≈ ${rsa.toFixed(1)} °C/W)`;
  if (rsa >= 1.2)
    return `Medium extruded heatsink, natural convection (Rθsa ≈ ${rsa.toFixed(2)} °C/W)`;
  if (rsa >= 0.4)
    return `Finned heatsink with forced air / fan (Rθsa ≈ ${rsa.toFixed(2)} °C/W)`;
  return `Liquid cold plate or very high airflow (Rθsa ≈ ${rsa.toFixed(2)} °C/W)`;
}

export function analyzeThermal(
  devicesIn: ThermalDeviceInput[],
  magneticsIn: ThermalMagneticInput[],
  passives: LossItem[],
  notEvaluated: Array<{ ref: string; reason: string }>,
  settings: ThermalSettings,
): ThermalResult {
  const Ta = settings.ambientC;
  const margin = settings.marginC ?? 25;
  const rthCs = settings.rthCs ?? 0.25;
  const warnings: string[] = [];
  const assumptions = [
    `Ambient ${Ta} °C, design margin ${margin} °C below each device's Tj,max.`,
    'Discrete TO-247 packages; Rθjc from typical datasheet values by technology (the device models carry no thermal data).',
    `Case-to-sink ${rthCs} °C/W (insulating pad + grease); free-air Rθja ≈ 40–50 °C/W.`,
    'Gate-charge power (Qg·Vdrv·fsw) is dissipated in the driver and gate resistors, so it is in the budget but not in the junction temperature.',
  ];

  const devices = devicesIn.filter((d) => d.lossW > 1e-4);
  const base = devices.map((d) => {
    const tech = d.technology || 'Si';
    const pkg =
      PACKAGE[
        `${d.kind}:${tech === 'GaN' && d.kind === 'diode' ? 'Si' : tech}`
      ] || PACKAGE[`${d.kind}:Si`];
    const tjMax = settings.maxJunctionC ?? pkg.tjMax;
    return { ...d, tech, pkg, tjMax, tjNo: Ta + d.lossW * pkg.rthJa };
  });

  const needsSink = base.some((d) => d.tjNo > d.tjMax - margin);
  const strategy: 'none' | 'shared' =
    settings.strategy === 'none'
      ? 'none'
      : settings.strategy === 'shared'
        ? 'shared'
        : needsSink
          ? 'shared'
          : 'none';

  let heatsink: ThermalResult['heatsink'] = null;
  const semiconductorW = devicesIn.reduce(
    (a, d) => a + Math.max(0, d.lossW),
    0,
  );
  const sinkW = base.reduce((a, d) => a + d.lossW, 0);
  if (strategy === 'shared' && base.length) {
    const tsMax = Math.min(
      ...base.map((d) => d.tjMax - margin - d.lossW * (d.pkg.rthJc + rthCs)),
    );
    const rsa = (tsMax - Ta) / Math.max(sinkW, 1e-6);
    const feasible = rsa > 0.05;
    const rsaUsed = feasible ? rsa : 0.05;
    heatsink = {
      rsaRequired: rsa,
      sinkTempC: Ta + sinkW * rsaUsed,
      cooling: feasible
        ? coolingFor(rsa)
        : 'Not achievable with a shared heatsink',
      feasible,
    };
    if (!feasible)
      warnings.push(
        'Even an ideal heatsink cannot keep every junction within limits — reduce losses (device choice, frequency) or split devices across separate heatsinks.',
      );
  }

  const deviceResults: ThermalDeviceResult[] = base.map((d) => {
    const tj = heatsink
      ? heatsink.sinkTempC + d.lossW * (d.pkg.rthJc + rthCs)
      : d.tjNo;
    return {
      ref: d.ref,
      kind: d.kind,
      technology: d.tech,
      lossW: d.lossW,
      breakdown: d.breakdown,
      rthJc: d.pkg.rthJc,
      rthCs,
      rthJa: d.pkg.rthJa,
      tjMaxC: d.tjMax,
      tjNoHeatsinkC: d.tjNo,
      tjC: tj,
      marginC: d.tjMax - tj,
      status: status(tj, d.tjMax, margin * 0.4),
    };
  });
  for (const d of deviceResults) {
    if (d.status === 'over')
      warnings.push(
        `${d.ref}: Tj ≈ ${d.tjC.toFixed(0)} °C exceeds its ${d.tjMaxC} °C limit.`,
      );
  }

  const magnetics = magneticsIn.map((m) => {
    const hot = m.tempRiseC === null ? null : Ta + m.tempRiseC;
    const st = hot === null ? 'ok' : status(hot, MAGNETIC_LIMIT_C, 15);
    if (hot !== null && st === 'over')
      warnings.push(
        `${m.ref}: hotspot ≈ ${hot.toFixed(0)} °C exceeds the ${MAGNETIC_LIMIT_C} °C ferrite / insulation guideline.`,
      );
    return {
      ref: m.ref,
      lossW: m.lossW,
      coreW: m.coreW,
      copperW: m.copperW,
      hotspotC: hot,
      limitC: MAGNETIC_LIMIT_C,
      status: st,
      source: m.source,
    };
  });
  const undesigned = magneticsIn
    .filter((m) => m.source === 'winding resistance')
    .map((m) => m.ref);
  if (undesigned.length)
    warnings.push(
      `${undesigned.join(', ')}: only the netlist winding resistance is counted (no core or AC copper loss) — run the magnetics design for the full figure.`,
    );

  const budget: LossItem[] = [
    ...devicesIn.map((d) => ({
      ref: d.ref,
      category: 'semiconductor' as const,
      lossW: Math.max(0, d.lossW),
      method: d.method || 'LUT loss engine on the simulated waveforms',
      detail: d.breakdown
        ? `conduction ${d.breakdown.conductionW.toFixed(2)} W · switching ${d.breakdown.switchingW.toFixed(2)} W${d.breakdown.leakageW > 5e-3 ? ` · leakage ${d.breakdown.leakageW.toFixed(2)} W` : ''}`
        : undefined,
    })),
    ...magneticsIn.map((m) => ({
      ref: m.ref,
      category: 'magnetic' as const,
      lossW: m.lossW,
      method:
        m.source === 'magnetics design'
          ? 'Magnetics stage (iGSE core + Dowell copper)'
          : m.source === 'user input'
            ? 'Entered value'
            : 'I²·R of the netlist winding resistance (no core loss)',
      detail:
        m.coreW !== undefined
          ? `core ${m.coreW.toFixed(2)} W · copper ${(m.copperW ?? 0).toFixed(2)} W`
          : undefined,
    })),
    ...passives,
  ]
    .filter((item) => item.lossW > 0 || item.category !== 'resistor')
    .sort((a, b) => b.lossW - a.lossW);

  for (const p of passives) {
    if (p.status === 'over')
      warnings.push(
        `${p.ref}: dissipates ${p.lossW.toFixed(2)} W, above its ${p.ratingW} W rating.`,
      );
    else if (p.status === 'warm')
      warnings.push(
        `${p.ref}: dissipates ${p.lossW.toFixed(2)} W, over half its ${p.ratingW} W rating (derate to ≤ 50 %).`,
      );
  }

  const sum = (cat: LossCategory) =>
    budget.filter((b) => b.category === cat).reduce((a, b) => a + b.lossW, 0);
  const magneticsW = sum('magnetic');
  const capacitorW = sum('capacitor');
  const resistorW = sum('resistor');
  const gateDriveW = sum('gate_drive');
  const totalW =
    semiconductorW + magneticsW + capacitorW + resistorW + gateDriveW;
  const pout =
    settings.outputPowerW && settings.outputPowerW > 0
      ? settings.outputPowerW
      : undefined;
  const efficiencyPct = pout ? (pout / (pout + totalW)) * 100 : undefined;
  if (efficiencyPct !== undefined) {
    assumptions.push(
      `Efficiency = Pout / (Pout + Σ losses) with Pout ${pout!.toFixed(1)} W from the ${settings.outputPowerSource === 'simulation' ? 'simulated load' : settings.outputPowerSource === 'input' ? 'entered value' : 'specs'}; control and auxiliary supply losses are not included.`,
    );
  }
  if (notEvaluated.length)
    assumptions.push(
      `Not evaluated: ${notEvaluated.map((n) => `${n.ref} (${n.reason})`).join('; ')}.`,
    );

  return {
    ambientC: Ta,
    strategy,
    heatsink,
    devices: deviceResults,
    magnetics,
    budget,
    notEvaluated,
    totals: {
      semiconductorW,
      magneticsW,
      capacitorW,
      resistorW,
      gateDriveW,
      totalW,
      outputPowerW: pout,
      outputPowerSource: pout ? settings.outputPowerSource : undefined,
      efficiencyPct,
    },
    assumptions,
    warnings,
  };
}
