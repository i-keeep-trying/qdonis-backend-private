/**
 * `.model` lines and subcircuit templates, ported from qdonis-core
 * `simulator/netlist_generator.py` (`generate_component_models`,
 * `subckt_templates_needed`).
 */

import {
  PyError,
  fmt,
  formatFixed,
  get,
  has,
  isDict,
  item,
  iter,
  lower,
  or,
  pyStr,
  roundInt,
  toFloat,
  truthy,
  type Dict,
} from './py';

const SEMICONDUCTOR = ['transistor', 'mosfet', 'igbt', 'vg-fet'];

/** Model family used for SPICE emission (vg-fet / igbt map to mosfet). */
export function transistorFamily(ctype: unknown, params: Dict): string {
  let family = lower(
    or(get(params, 'family'), ctype === 'transistor' ? 'bjt' : ctype),
  );
  if (family === 'vg-fet') family = 'mosfet';
  if (family === 'igbt') family = 'mosfet';
  return family;
}

/** MOSFET channel letter (`p` when the channel type text contains a p). */
export function mosfetChannel(params: Dict): 'p' | 'n' {
  const channelType = or(
    get(params, 'channelType'),
    get(params, 'type', 'nmos'),
  );
  return pyStr(channelType).toLowerCase().includes('p') ? 'p' : 'n';
}

/** Default MOSFET model name. */
export function mosfetModelName(params: Dict, channel: 'p' | 'n'): unknown {
  const partNumber = get(params, 'part_number');
  return or(
    get(params, 'model'),
    truthy(partNumber)
      ? `${pyStr(partNumber)}_${channel.toUpperCase()}MOS`
      : `${channel}mos_model`,
  );
}

/** Python set of model names (values compared by their Python text). */
class NameSet {
  private readonly names = new Set<string>();
  add(name: unknown) {
    this.names.add(typeof name === 'string' ? `s:${name}` : `o:${pyStr(name)}`);
  }
  has(name: unknown) {
    return this.names.has(
      typeof name === 'string' ? `s:${name}` : `o:${pyStr(name)}`,
    );
  }
}

const MODEL_HEAD = /^\s*\.model\s+([^\s(]+)/i;
const MODEL_ANY = /\.model\s+([^\s(]+)/gi;

function positiveVoltage(value: unknown): number | null {
  if (typeof value === 'boolean') return null;
  let number: number;
  try {
    number = Math.abs(toFloat(value));
  } catch {
    return null;
  }
  return Number.isFinite(number) && number > 0 ? number : null;
}

const TARGET_KEYS = new Set([
  'target_vout',
  'vout',
  'output_voltage',
  'target_output_voltage',
  'target_voltage',
]);

function collectVoltageTargets(value: unknown, out: number[]): void {
  if (isDict(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.trim().toLowerCase().replaceAll(' ', '_');
      if (TARGET_KEYS.has(normalized)) {
        const target = positiveVoltage(entry);
        if (target !== null) out.push(target);
      }
      collectVoltageTargets(entry, out);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) collectVoltageTargets(entry, out);
  }
}

/** Integer NMOS Kp: the YAML value rounded, else the voltage-tier fallback. */
function nmosKp(design: Dict, params: Dict): unknown {
  const operating: number[] = [];
  const ratings: number[] = [];
  for (const candidate of iter(get(design, 'components', []))) {
    const candidateParams = or(get(candidate, 'params', {}), {}) as Dict;
    if (
      get(candidate, 'type') === 'voltage_source' ||
      get(candidateParams, 'node_type') === 'voltage_source'
    ) {
      const v = positiveVoltage(get(candidateParams, 'voltage'));
      if (v !== null) operating.push(v);
    }
    if (get(candidate, 'type') === 'transistor') {
      const rating = positiveVoltage(get(candidateParams, 'voltage_rating'));
      if (rating !== null) ratings.push(rating);
    }
  }
  collectVoltageTargets(get(design, 'analysis', {}), operating);
  const ov = operating.length
    ? Math.max(...operating)
    : ratings.length
      ? Math.max(...ratings)
      : null;

  let fallback: bigint;
  if (ov === null) fallback = 50n;
  else if (ov < 50) fallback = roundInt(20 + (20 * ov) / 50);
  else if (ov <= 400) fallback = roundInt(40 + (30 * (ov - 50)) / 350);
  else fallback = roundInt(70 + 30 * (1 - 400 / ov));

  const rawKp = get(params, 'Kp');
  if (rawKp === null || rawKp === undefined) return fallback;
  let numeric: number;
  try {
    numeric = toFloat(rawKp);
  } catch {
    return rawKp;
  }
  if (Number.isNaN(numeric)) return rawKp; // round(nan): ValueError -> raw value
  if (!Number.isFinite(numeric)) {
    throw new PyError(
      'OverflowError',
      'cannot convert float infinity to integer',
    );
  }
  return roundInt(numeric);
}

function diodeBv(design: Dict): unknown {
  const topo = pyStr(get(design, 'id', '')).toLowerCase();
  if (['three_phase', '700', '800'].some((t) => topo.includes(t))) return 1200n;
  if (
    [
      'afe',
      'pfc',
      'vienna',
      'inverter',
      'h_bridge',
      'boost',
      '400',
      '450',
    ].some((t) => topo.includes(t))
  ) {
    return 800n;
  }
  return 100n;
}

/** `generate_component_models`: de-duplicated `.model` lines, then custom models. */
export function generateComponentModels(design: Dict): string {
  const models: string[] = [];
  const used = new NameSet();

  for (const cm of iter(get(design, 'models', []))) {
    if (typeof cm === 'string') {
      const match = MODEL_HEAD.exec(cm);
      if (match) used.add(match[1]);
    }
  }
  for (const comp of iter(get(design, 'components', []))) {
    if (get(comp, 'type') === 'custom_spice') {
      const line = pyStr(get(get(comp, 'params', {}), 'spice_line', ''));
      for (const match of line.matchAll(MODEL_ANY)) used.add(match[1]);
    }
  }

  for (const comp of iter(get(design, 'components', []))) {
    const ctype = item(comp, 'type');
    const params = or(get(comp, 'params', {}), {}) as Dict;

    if (ctype === 'diode') {
      const name = or(
        or(get(params, 'model'), get(params, 'model_name')),
        'Dmodel',
      );
      if (!used.has(name)) {
        const Is = get(params, 'Is', 1e-12);
        const n = get(params, 'n', 1.1);
        const Rs = get(params, 'Rs', 0.1);
        const Cjo = get(params, 'Cjo', 10e-12);
        // No default Tt: a diode without a recovery time is modelled without one.
        const Tt = get(
          params,
          'Tt',
          get(params, 'reverse_recovery_time', null),
        );
        let Bv = get(params, 'Bv');
        if (Bv === null || Bv === undefined) Bv = diodeBv(design);
        const Ibv = get(params, 'Ibv', 1e-6);
        const ttText = truthy(Tt) ? ` Tt=${fmt(Tt)}` : '';
        models.push(
          `.model ${pyStr(name)} D(Is=${fmt(Is)} n=${fmt(n)} Rs=${fmt(Rs)} Cjo=${fmt(Cjo)}${ttText} Bv=${fmt(Bv)} Ibv=${fmt(Ibv)})`,
        );
        used.add(name);
      }
    } else if (SEMICONDUCTOR.includes(ctype as string)) {
      const family = transistorFamily(ctype, params);
      if (family === 'bjt') {
        const t = lower(get(params, 'type', 'npn'));
        const name = `${t}_model`;
        if (!used.has(name)) {
          const Is = get(params, 'Is', 1e-15);
          const Bf = get(params, 'Bf', 100n);
          const Vaf = get(params, 'Vaf', 200n);
          const Cje = get(params, 'Cje', 20e-12);
          const Cjc = get(params, 'Cjc', 10e-12);
          const Tf = get(params, 'Tf', 5e-9);
          const Tr = get(params, 'Tr', 50e-9);
          models.push(
            `.model ${name} ${t.toUpperCase()}(Is=${fmt(Is)} Bf=${fmt(Bf)} Vaf=${fmt(Vaf)} Cje=${fmt(Cje)} Cjc=${fmt(Cjc)} Tf=${fmt(Tf)} Tr=${fmt(Tr)})`,
          );
          used.add(name);
        }
      } else if (family === 'mosfet') {
        const channel = mosfetChannel(params);
        const partNumber = get(params, 'part_number');
        const name = mosfetModelName(params, channel);
        if (!used.has(name)) {
          if (channel === 'n' && truthy(partNumber) && has(params, 'rds_on')) {
            let handled = false;
            try {
              const rdsOn = toFloat(params.rds_on);
              const tr = toFloat(get(params, 'tr', 20e-9));
              if (rdsOn * 8 === 0)
                throw new PyError(
                  'ZeroDivisionError',
                  'float division by zero',
                );
              const kp = 1 / (rdsOn * 8);
              const cEq = Math.max(0.1, 5 * (0.001 / Math.max(rdsOn, 1e-6)));
              const c = `${formatFixed(cEq, 1)}n`;
              models.push(
                `.model ${pyStr(name)} NMOS(Vto=3 Lambda=0.01 Kp=${formatFixed(kp, 3)} Cbd=${c} Cbs=${c} Cgdo=${c} Is=1e-14 Tt=${fmt(tr)} Rs=${fmt(rdsOn)})`,
              );
              used.add(name);
              handled = true;
            } catch (error) {
              if (
                !(error instanceof PyError) ||
                !['ValueError', 'TypeError'].includes(error.pyType)
              ) {
                throw error;
              }
            }
            if (handled) continue;
          }
          if (channel === 'n') {
            const kp = nmosKp(design, params);
            models.push(
              `.model ${pyStr(name)} NMOS(Vto=3 Lambda=0.01 Kp=${pyStr(kp)} Cbd=1n Cbs=1n Cgdo=100p Is=1e-14 Tt=100n Rs=0.01)`,
            );
            used.add(name);
            continue;
          }
          const Vto = get(params, 'Vto', -2.0);
          const Lambda = get(params, 'Lambda', 0.02);
          const Kp = or(get(params, 'Kp'), get(params, 'Kn', 20e-3));
          const fields = [
            `Vto=${fmt(Vto)}`,
            `Lambda=${fmt(Lambda)}`,
            `Kp=${fmt(Kp)}`,
          ];
          for (const key of [
            'Gamma',
            'Phi',
            'RD',
            'RS',
            'CBD',
            'CBS',
            'IS',
            'PB',
            'CGSO',
            'CGDO',
          ]) {
            const value = get(params, key);
            if (value !== null && value !== undefined)
              fields.push(`${key}=${fmt(value)}`);
          }
          models.push(`.model ${pyStr(name)} PMOS(${fields.join(' ')})`);
          used.add(name);
        }
      } else if (family === 'jfet') {
        const polarity = lower(get(params, 'polarity', 'n'));
        const name = `${polarity}jfet_model`;
        if (!used.has(name)) {
          const Vto = get(params, 'Vto', -2.0);
          const Idss = get(params, 'Idss', 10e-3);
          const Lambda = get(params, 'Lambda', 0.01);
          const fields = [
            `Vto=${fmt(Vto)}`,
            `Idss=${fmt(Idss)}`,
            `Lambda=${fmt(Lambda)}`,
          ];
          for (const key of ['Beta', 'RD', 'RS', 'CGS', 'CGD', 'IS', 'PB']) {
            const value = get(params, key);
            if (value !== null && value !== undefined)
              fields.push(`${key}=${fmt(value)}`);
          }
          models.push(
            `.model ${name} ${polarity === 'n' ? 'NJF' : 'PJF'}(${fields.join(' ')})`,
          );
          used.add(name);
        }
      }
    }
  }

  const custom = get(design, 'models', []);
  if (truthy(custom)) {
    for (const cm of iter(custom)) {
      if (typeof cm === 'string') models.push(cm);
    }
  }
  return models.join('\n');
}

const XFMR = [
  '* --- Transformer (parametric, series-R + core loss) ---',
  '.subckt Xfmr P1 P2 S1 S2 params: Lm=100u Ns=3.6 K=0.99 Rwp=0.5 Rws=0.1 Rcore=1e6 Cww=0',
  'Rwp  P1  P1a {Rwp}',
  'Rws  S1  S1a {Rws}',
  'Lp   P1a P2  {Lm}',
  'Ls   S1a S2  {Lm*Ns*Ns}',
  'K1   Lp  Ls  {K}',
  'Rcore P1a P2 {Rcore}',
  'Cww  P1a S1a {Cww}',
  '.ends Xfmr',
  '',
].join('\n');

const CT_XFMR = [
  '* --- Center-tapped Transformer (parametric, series-R + core loss) ---',
  '* NOTE: Rct is a HIGH-impedance resistor (typically 100meg-1gig Ohms) that provides DC bias',
  '* for the secondary side to prevent SPICE singular matrix / convergence failures.',
  '* It does NOT break electrical isolation - leakage current is negligible (~1pA).',
  '.subckt Xctfmr P1 P2 S1 S2 CT params: Lm=100u Ns=3.6 K1=0.99 K2=0.99 K12=0.99 Rwp=0.1 Rws1=0.05 Rws2=0.05 Rcore=1e12 Cww1=5e-11 Cww2=5e-11 Rct=100meg',
  'Rwp P1 P1a {Rwp}',
  'Rws1 S1 S1a {Rws1}',
  'Rws2 S2 S2a {Rws2}',
  'Lp P1a P2 {Lm}',
  'Ls1 S1a CT {Lm*Ns*Ns}',
  'Ls2 S2a CT {Lm*Ns*Ns}',
  'K1 Lp Ls1 {K1}',
  'K2 Lp Ls2 {K2}',
  'K12 Ls1 Ls2 {K12}',
  'Rcore P1a P2 {Rcore}',
  'Cww1 P1a S1a {Cww1}',
  'Cww2 P1a S2a {Cww2}',
  'Rct CT 0 {Rct}',
  '.ends Xctfmr',
  '',
].join('\n');

const DUAL_CT_XFMR = [
  '* --- Common-Core Coupled Inductor Model (Robust) ---',
  '* NOTE: Default params are placeholders - always pass actual values from YAML',
  '.subckt Xdualctfmr P1 CT_P P2 S1 CT_S S2 Lm_primary=100u Ns=1 K=0.99 Rp1=0.05 Rp2=0.05 Rs1=0.05 Rs2=0.05',
  '* --- PRIMARY WINDINGS ---',
  '* Center-tapped primary: P1->CT and P2->CT ensure correct Push-Pull phasing',
  'Rp1_res P1 P1_int {Rp1}',
  'Lp1 P1_int CT_P {Lm_primary/4}',
  'Rp2_res P2 P2_int {Rp2}',
  'Lp2 CT_P P2_int {Lm_primary/4}',
  '* --- SECONDARY WINDINGS ---',
  'Rs1_res S1 S1_int {Rs1}',
  'Ls1 S1_int CT_S {Lm_primary*Ns*Ns/4}',
  'Rs2_res S2 S2_int {Rs2}',
  'Ls2 CT_S S2_int {Lm_primary*Ns*Ns/4}',
  '* --- COUPLING ---',
  '* Kall couples all inductors with coupling coefficient from YAML',
  'K1 Lp1 Lp2 {K}',
  'K2 Lp1 Ls1 {K}',
  'K3 Lp1 Ls2 {K}',
  'K4 Lp2 Ls1 {K}',
  'K5 Lp2 Ls2 {K}',
  'K6 Ls1 Ls2 {K}',
  '* --- DAMPING (Crucial for convergence) ---',
  '* Damping resistors provide safe path for leakage during switching dead-time',
  'Rdamp1 P1_int CT_P 1k',
  'Rdamp2 P2_int CT_P 1k',
  'Rdamp3 S1_int CT_S 1k',
  'Rdamp4 S2_int CT_S 1k',
  '.ends Xdualctfmr',
  '',
].join('\n');

/** Only the subcircuit templates the design uses. */
export function subcktTemplatesNeeded(design: Dict): string {
  const types = iter(get(design, 'components', [])).map((c) => get(c, 'type'));
  const blocks: string[] = [];
  if (types.includes('transformer')) blocks.push(XFMR);
  if (types.includes('ct_transformer')) blocks.push(CT_XFMR);
  if (types.includes('dual_ct_transformer')) blocks.push(DUAL_CT_XFMR);
  return blocks.join('\n');
}
