/**
 * YAML topology -> self-contained ngspice decks. Port of qdonis-core
 * `simulator/netlist_generator.py` (`generate_netlist`,
 * `generate_netlist_for_analysis`) and `simulator.generate_analysis_cirs`.
 * Output is byte-identical to the core for the built-in library (see
 * `netlist.parity.spec.ts`).
 */

import {
  buildCompNets,
  buildComponentsIndex,
  componentsDict,
  keyText,
  needPins,
  resolveVoltageNode,
  spiceDevName,
  type CompNets,
} from './comp-nets';
import {
  ABSTOL_DEFAULT,
  CHGTOL_DEFAULT,
  GMIN_DEFAULT,
  MAXORD_DEFAULT,
  METHOD_DEFAULT,
  RELTOL_DEFAULT,
  TRTOL_DEFAULT,
  VNTOL_DEFAULT,
  generateAcControlBlock,
  generateDcControlBlock,
  generateTransientControlBlock,
} from './control-blocks';
import {
  generateComponentModels,
  mosfetChannel,
  mosfetModelName,
  subcktTemplatesNeeded,
  transistorFamily,
} from './models';
import {
  PyError,
  fmt,
  get,
  has,
  isDict,
  item,
  iter,
  len,
  lower,
  or,
  pyEquals,
  pyStr,
  splitWs,
  toFloat,
  truthy,
  type Dict,
} from './py';
import {
  CONTROL_BLOCK_TYPES,
  emitControlBlock,
  isControlBlock,
} from './signal-blocks';
import { designSummaryLine } from './design-summary';
import { requirementsOf } from './spice-command';
import { detectPwmPeriod } from './timing';

export type AnalysisKind = 'dc' | 'ac' | 'transient';
export const ANALYSIS_KINDS: readonly AnalysisKind[] = [
  'dc',
  'ac',
  'transient',
];

const DEFAULT_VSRC_SERIES_R = 1e-3;
const MAX_CAP_ESL = 1e-10;
const CT_COUPLING_MAX = 0.99999;

/** Caps every capacitor's ESL (in place) so output nodes stay clamped. */
function clampCapacitorEsl(design: Dict): void {
  for (const comp of iter(get(design, 'components', []))) {
    if (get(comp, 'type') !== 'capacitor') continue;
    const params = get(comp, 'params');
    if (!isDict(params)) continue;
    const esl = get(params, 'esl');
    if (esl === null || esl === undefined) continue;
    try {
      if (toFloat(esl) > MAX_CAP_ESL) params.esl = MAX_CAP_ESL;
    } catch {
      // TypeError / ValueError: leave it
    }
  }
}

const DIODE_BRIDGE_IDS = [
  'acdc_single_phase_diode_bridge',
  'single_phase_diode_bridge',
];
const C_OUT_DEFAULT = (): Dict => ({
  type: 'capacitor',
  role: 'output_filter',
  params: {
    capacitance: 0.0022,
    voltage_rating: 400.0,
    std_voltage_rating: 400.0,
  },
});

/** `[ref, pin]` of a net member (`[ref, pin]` list or `{ref, pin}` object). */
function netMember(entry: unknown): [unknown, unknown] {
  if (Array.isArray(entry)) return [entry[0] ?? '', entry[1] ?? ''];
  if (isDict(entry)) return [get(entry, 'ref'), get(entry, 'pin')];
  return ['', ''];
}

/**
 * The single-phase diode bridge always gets an output filter capacitor C_OUT
 * (in place), tied to the DC rails when the design lists explicit `nets`.
 */
function ensureDiodeBridgeFilterCapacitor(design: Dict): void {
  const topId = pyStr(
    has(design, 'id') ? get(design, 'id') : get(design, 'topology', ''),
  ).toLowerCase();
  if (!DIODE_BRIDGE_IDS.includes(topId)) return;

  if (!has(design, 'components')) design.components = [];
  const components = design.components;
  if (Array.isArray(components)) {
    const hasCout = components.some(
      (c) =>
        isDict(c) &&
        (c.ref === 'C_OUT' || c.id === 'C_OUT' || c.type === 'capacitor'),
    );
    if (!hasCout) components.push({ ref: 'C_OUT', ...C_OUT_DEFAULT() });
  } else if (isDict(components)) {
    const hasCout = Object.entries(components).some(
      ([key, c]) =>
        key === 'C_OUT' ||
        (isDict(c) && (c.type === 'capacitor' || c.role === 'output_filter')),
    );
    if (!hasCout) components.C_OUT = C_OUT_DEFAULT();
  }

  if (!has(design, 'nets')) design.nets = [];
  const nets = iter(design.nets).filter((net): net is unknown[] =>
    Array.isArray(net),
  );
  let posConnected = false;
  let negConnected = false;
  for (const net of nets) {
    for (const entry of net) {
      const [ref, pin] = netMember(entry);
      if (ref !== 'C_OUT') continue;
      if (pin === 'pos' || pin === '+' || pin === 'pin1') posConnected = true;
      else if (pin === 'neg' || pin === '-' || pin === 'pin2')
        negConnected = true;
    }
  }
  for (const net of nets) {
    let posRail = false;
    let negRail = false;
    for (const entry of net) {
      const [ref, pin] = netMember(entry);
      if (
        (ref === 'R_LOAD' &&
          (pin === 'pos' || pin === '+' || pin === 'pin1')) ||
        ((ref === 'D3' || ref === 'D4') && pin === 'cathode')
      )
        posRail = true;
      if (
        (ref === 'R_LOAD' &&
          (pin === 'neg' || pin === '-' || pin === 'pin2')) ||
        ((ref === 'D1' || ref === 'D2') && pin === 'anode')
      )
        negRail = true;
    }
    if (posRail && !posConnected) {
      net.push(['C_OUT', 'pos']);
      posConnected = true;
    }
    if (negRail && !negConnected) {
      net.push(['C_OUT', 'neg']);
      negConnected = true;
    }
  }
}

/** Drops `.ic` assignments on switching nodes (they crash the first PWM edge). */
export function sanitizeIcStatement(spiceLine: string): string {
  if (!spiceLine || !spiceLine.trim().toLowerCase().startsWith('.ic'))
    return spiceLine;
  const tokens = splitWs(spiceLine);
  const kept = [tokens[0]];
  const removed: string[] = [];
  for (const token of tokens.slice(1)) {
    const m = /^[vV]\(([^)]+)\)=([^\s]+)$/.exec(token);
    if (
      m &&
      ['n_sw', 'n_switch', 'n_mid'].some((t) => m[1].toLowerCase().includes(t))
    ) {
      removed.push(token);
      continue;
    }
    kept.push(token);
  }
  if (removed.length === 0) return spiceLine;
  const comment = `* [NOTE] Stripped .ic on switching node(s) ${removed.join(', ')} to prevent PWM convergence crash`;
  return kept.length > 1 ? `${comment}\n${kept.join(' ')}` : comment;
}

function ctCouplingMagnitude(k: unknown): number {
  let mag: number;
  try {
    mag = Math.abs(toFloat(k));
  } catch {
    return CT_COUPLING_MAX;
  }
  if (!(mag > 0 && mag < 1)) return CT_COUPLING_MAX;
  return Math.min(mag, CT_COUPLING_MAX);
}

function ctCouplingCoefficients(k: unknown, phaseS1: string, phaseS2: string) {
  const mag = ctCouplingMagnitude(k);
  const s1 = phaseS1 === 'opposite' ? -1 : 1;
  const s2 = phaseS2 === 'opposite' ? -1 : 1;
  return [s1 * mag, s2 * mag, s1 * s2 * mag] as const;
}

function deriveLeakageResistance(params: Dict): number | null {
  const I = get(params, 'leakage_current');
  const V = get(params, 'voltage_rating');
  if (I === null || I === undefined || V === null || V === undefined)
    return null;
  try {
    const i = toFloat(I);
    const v = toFloat(V);
    if (i > 0) return v / i;
  } catch {
    // Python: `except Exception: pass`
  }
  return null;
}

/** BJT 'npn'/'pnp', MOSFET / JFET 'n'/'p' of the transistor a PWM node drives. */
function transistorTypeForPwm(design: Dict, pwmRef: unknown): string | null {
  let pwmNet: unknown[] | null = null;
  for (const net of iter(get(design, 'nets', []))) {
    for (const connection of iter(net)) {
      if (
        Array.isArray(connection) &&
        connection.length === 2 &&
        pyEquals(connection[0], pwmRef) &&
        ['pos', 'output', 'out'].includes(connection[1] as string)
      ) {
        pwmNet = net as unknown[];
        break;
      }
    }
  }
  if (!pwmNet) return null;
  for (const connection of pwmNet) {
    if (!(Array.isArray(connection) && connection.length === 2)) continue;
    for (const comp of iter(get(design, 'components', []))) {
      if (
        pyEquals(item(comp, 'ref'), connection[0]) &&
        item(comp, 'type') === 'transistor'
      ) {
        const params = get(comp, 'params', {});
        const family = lower(or(get(params, 'family'), 'bjt'));
        if (family === 'bjt') return lower(get(params, 'type', 'npn'));
        if (family === 'mosfet') return mosfetChannel(params as Dict);
        if (family === 'jfet') return lower(get(params, 'polarity', 'n'));
      }
    }
  }
  return null;
}

const invertPwmPulse = (design: Dict, pwmRef: unknown) =>
  ['pnp', 'p'].includes(transistorTypeForPwm(design, pwmRef) ?? '');

/** Solver option keys taken from the settings layers (`solver_options` in the core). */
const SOLVER_KEYS = [
  'rshunt',
  'cshunt',
  'reltol',
  'abstol',
  'vntol',
  'chgtol',
  'gmin',
  'method',
  'maxord',
  'trtol',
  'itl4',
] as const;

/**
 * Solver options, lowest precedence first: the defaults,
 * `simulation.spice_options`, `analysis.spice_settings`, then the analysis's
 * own `analysis.<type>.spice_settings` (where most library topologies put
 * them).
 */
export function solverOptions(
  design: Dict,
  analysisType: AnalysisKind | null,
): Record<(typeof SOLVER_KEYS)[number], unknown> {
  const out: Record<(typeof SOLVER_KEYS)[number], unknown> = {
    rshunt: 1e12,
    cshunt: 1e-12,
    reltol: RELTOL_DEFAULT,
    abstol: ABSTOL_DEFAULT,
    vntol: VNTOL_DEFAULT,
    chgtol: CHGTOL_DEFAULT,
    gmin: GMIN_DEFAULT,
    method: METHOD_DEFAULT,
    maxord: MAXORD_DEFAULT,
    trtol: TRTOL_DEFAULT,
    itl4: null,
  };
  const analysis = or(get(design, 'analysis'), {});
  const own = analysisType ? or(get(analysis, analysisType), {}) : {};
  const layers = [
    get(or(get(design, 'simulation'), {}), 'spice_options'),
    get(analysis, 'spice_settings'),
    isDict(own) ? get(own, 'spice_settings') : null,
  ];
  for (const layer of layers) {
    if (!isDict(layer)) continue;
    for (const key of SOLVER_KEYS) {
      const value = get(layer, key);
      if (value !== null && value !== undefined) out[key] = value;
    }
  }
  return out;
}

const optionLines = (
  design: Dict,
  analysisType: AnalysisKind | null,
): string[] => {
  const spice = get(get(design, 'analysis', {}), 'spice_settings', {});
  const transientSpice = transientSpiceSettings(design);
  const {
    rshunt,
    cshunt,
    reltol,
    abstol,
    vntol,
    chgtol,
    gmin,
    method,
    maxord,
    trtol,
    itl4,
  } = solverOptions(design, analysisType);

  const lines = [
    `.options rshunt=${fmt(rshunt)} cshunt=${fmt(cshunt)} reltol=${pyStr(reltol)} abstol=${pyStr(abstol)} vntol=${pyStr(vntol)} chgtol=${pyStr(chgtol)} gmin=${pyStr(gmin)}`,
  ];
  let methodOpt = `.options method=${pyStr(method)} maxord=${pyStr(maxord)} trtol=${pyStr(trtol)}`;
  if (truthy(itl4)) methodOpt += ` itl4=${pyStr(itl4)}`;
  lines.push(methodOpt);

  let ic = or(get(spice, 'initial_conditions'), get(spice, 'ic'));
  if (!truthy(ic) && isDict(transientSpice)) {
    ic = or(
      get(transientSpice, 'initial_conditions'),
      get(transientSpice, 'ic'),
    );
  }
  if (!truthy(ic))
    ic = or(get(design, 'initial_conditions'), get(design, 'ic'));
  if (truthy(ic)) {
    if (pyStr(get(design, 'id', '')).toLowerCase() === 'dcac_t_type') {
      let vin = 800.0;
      for (const comp of iter(get(design, 'components', []))) {
        if (get(comp, 'ref') === 'VIN') {
          vin = toFloat(get(get(comp, 'params', {}), 'voltage', 800.0));
          break;
        }
      }
      ic = pyStr(ic).replace(
        /v\(N008\)=[\d.]+/g,
        () => `v(N008)=${pyStr(vin / 2)}`,
      );
    }
    lines.push(`.ic ${pyStr(ic)}`);
  }
  return lines;
};

const transientSpiceSettings = (design: Dict): unknown =>
  get(get(get(design, 'analysis', {}), 'transient', {}), 'spice_settings', {});

type Variant = 'base' | 'analysis';

/** Emits every component (internal parts included); returns the last PWM period. */
function emitElements(
  design: Dict,
  compNets: CompNets,
  lines: string[],
  variant: Variant,
  skip: ReadonlySet<string>,
): number | null {
  let pwmPeriod: number | null = null;
  const all: Array<[Dict, boolean, Dict | null]> = [];
  for (const comp of iter(get(design, 'components', []))) {
    all.push([comp as Dict, false, null]);
    for (const internal of iter(get(comp, 'internal', []))) {
      all.push([internal as Dict, true, comp as Dict]);
    }
  }

  for (const [comp, isInternal, parent] of all) {
    const refValue = item(comp, 'ref');
    const ref = pyStr(refValue);
    const ctype = item(comp, 'type');
    const params = or(get(comp, 'params', {}), {}) as Dict;
    const nets = compNets.get(keyText(refValue)) ?? new Map<string, string>();
    const p = (key: string, dflt?: unknown) => get(params, key, dflt);

    if (variant === 'analysis' && skip.has(keyText(refValue))) continue;
    if (
      isInternal &&
      parent &&
      truthy(parent) &&
      get(parent, 'type') === 'transformer'
    ) {
      if (['CWW', 'Cww'].includes(ref) && ctype === 'capacitor') continue;
    }

    if (ctype === 'node') {
      const nodeType = p('node_type');
      if (nodeType === 'voltage_source') {
        let plus: string;
        let minus: string | null;
        if (nets.has('+') && nets.has('-')) {
          const pins = needPins(ref, nets, ['+', '-']);
          plus = pins.get('+') as string;
          minus = pins.get('-') as string;
        } else if (nets.has('plus') && nets.has('minus')) {
          const pins = needPins(ref, nets, ['plus', 'minus']);
          plus = pins.get('plus') as string;
          minus = pins.get('minus') as string;
        } else if (nets.has('')) {
          plus = nets.get('') as string;
          minus = null;
          for (const gnd of iter(get(design, 'components', []))) {
            if (get(get(gnd, 'params', {}), 'node_type') === 'ground') {
              for (const netList of iter(get(design, 'nets', []))) {
                for (const net of iter(netList)) {
                  if (
                    Array.isArray(net) &&
                    net.length >= 2 &&
                    pyEquals(net[0], item(gnd, 'ref'))
                  ) {
                    minus = truthy(net[1]) ? pyStr(net[1]) : '0';
                    break;
                  }
                }
              }
              if (truthy(minus)) break;
            }
          }
          if (!truthy(minus)) minus = '0';
        } else {
          throw new PyError(
            'ValueError',
            `${ref}: voltage source must have either ['+', '-'], ['plus', 'minus'] pins or [''] pin`,
          );
        }
        const vdc = fmt(p('voltage', 0n));
        const source = pyStr(p('source', 'dc')).toLowerCase();
        const rampRise = p('ramp_rise', null);
        const rs = p('series_resistance', null);
        const noSeriesR =
          (rs !== null && rs !== undefined && toFloat(rs) === 0) ||
          p('series_resistor') === false;
        const srcPos = pyStr(
          or(p('src_node'), noSeriesR ? plus : `${ref}_src`),
        );
        const vName = spiceDevName('V', refValue);
        if (source === 'ac') {
          lines.push(`${vName} ${srcPos} ${minus} DC 0 AC ${vdc}`);
        } else if (source === 'sine') {
          const off = fmt(p('offset', 0n));
          const amp = fmt(p('amplitude', p('voltage', 1n)));
          const freq = fmt(p('frequency', 60n));
          const delay = fmt(p('delay', 0n));
          const damping = fmt(p('damping', 0n));
          const phase = fmt(p('phase', 0n));
          const none = (v: unknown) => v === null || v === undefined;
          if (
            (none(p('delay')) && none(p('damping')) && none(p('phase'))) ||
            (delay === '0' && damping === '0' && phase === '0')
          ) {
            lines.push(
              `${vName} ${srcPos} ${minus} SIN(${off} ${amp} ${freq})`,
            );
          } else {
            lines.push(
              `${vName} ${srcPos} ${minus} SIN(${off} ${amp} ${freq} ${delay} ${damping} ${phase})`,
            );
          }
        } else if (source === 'pulse') {
          const v1 = fmt(p('v1', p('vlow', 0n)));
          const v2 = fmt(p('v2', p('vhigh', 5n)));
          const td = fmt(p('td', p('delay', 0n)));
          const tr = fmt(p('tr', p('trise', 0n)));
          const tf = fmt(p('tf', p('tfall', 0n)));
          const pw = fmt(p('pw', p('pulse_width', 0n)));
          const per = fmt(p('per', p('period', 0n)));
          lines.push(
            `${vName} ${srcPos} ${minus} PULSE(${v1} ${v2} ${td} ${tr} ${tf} ${pw} ${per})`,
          );
        } else if (source === 'pwl') {
          const points = or(or(p('pwl'), p('points')), p('pwl_points', ''));
          lines.push(`${vName} ${srcPos} ${minus} PWL(${pyStr(points)})`);
        } else if (rampRise !== null && rampRise !== undefined) {
          try {
            lines.push(
              `${vName} ${srcPos} ${minus} PWL(0 0 ${fmt(toFloat(rampRise))} ${vdc})`,
            );
          } catch {
            lines.push(`${vName} ${srcPos} ${minus} DC ${vdc}`);
          }
        } else {
          lines.push(`${vName} ${srcPos} ${minus} DC ${vdc}`);
        }
        if (!noSeriesR) {
          const r =
            rs !== null && rs !== undefined && toFloat(rs) > 0
              ? fmt(rs)
              : fmt(DEFAULT_VSRC_SERIES_R);
          lines.push(`R${ref}_series ${srcPos} ${plus} ${r}`);
        }
      } else if (nodeType === 'pwm_control') {
        if (nets.size === 0) {
          throw new PyError(
            'ValueError',
            `PWM node '${ref}' has no connected net in YAML.`,
          );
        }
        let posPin = or(or(nets.get('pos'), nets.get('output')), nets.get('+'));
        let negPin = or(or(nets.get('neg'), nets.get('return')), nets.get('-'));
        if (!truthy(posPin)) posPin = nets.values().next().value;
        if (!truthy(negPin)) negPin = '0';
        const f = toFloat(item(params, 'frequency'));
        const d = toFloat(item(params, 'duty_cycle'));
        if (f === 0)
          throw new PyError('ZeroDivisionError', 'float division by zero');
        const period = 1 / f;
        pwmPeriod = period;
        const tonRaw = d * period;
        const vh = toFloat(p('vhigh', 5.0));
        const vl = toFloat(p('vlow', 0.0));
        const tr = toFloat(p('trise', period / 100));
        const tf = toFloat(p('tfall', period / 100));
        const ton = Math.max(0, tonRaw - (tr + tf) / 2);
        const td = toFloat(p('tdelay', 0.0));
        const rdrv = toFloat(p('drive_resistance', 100.0));
        const internalNode = `n_${ref}_int`;
        const [a, b] = invertPwmPulse(design, refValue) ? [vh, vl] : [vl, vh];
        const pulse = `PULSE(${fmt(a)} ${fmt(b)} ${fmt(td)} ${fmt(tr)} ${fmt(tf)} ${fmt(ton)} ${fmt(period)})`;
        lines.push(`V${ref} ${internalNode} ${pyStr(negPin)} ${pulse}`);
        lines.push(
          `R${ref}_drive ${internalNode} ${pyStr(posPin)} ${fmt(rdrv)}`,
        );
      }
    } else if (ctype === 'resistor') {
      const pins = needPins(ref, nets, ['pos', 'neg'], ctype);
      const [npos, nneg] = [pins.get('pos'), pins.get('neg')];
      const rval = fmt(item(params, 'resistance'));
      const rName = spiceDevName('R', refValue);
      const lp = toFloat(p('parasitic_inductance', 0.0));
      let head = npos as string;
      if (!(isInternal || p('sense') === false)) {
        head = `n_${ref}_sense`;
        lines.push(`V${ref}_SENSE ${npos} ${head} 0`);
      }
      if (lp > 0) {
        const mid = `n_${ref}_mid`;
        lines.push(`L${ref}_PL ${head} ${mid} ${fmt(lp)}`);
        lines.push(`${rName} ${mid} ${nneg} ${rval}`);
      } else {
        lines.push(`${rName} ${head} ${nneg} ${rval}`);
      }
    } else if (ctype === 'capacitor') {
      const pins = needPins(ref, nets, ['pos', 'neg'], ctype);
      const [npos, nneg] = [
        pins.get('pos') as string,
        pins.get('neg') as string,
      ];
      const cval = fmt(item(params, 'capacitance'));
      const cic = p('ic', null);
      const cName = spiceDevName('C', refValue);
      let left = npos;
      if (!isInternal && p('sense') !== false) {
        left = `n_${ref}_sense`;
        lines.push(`V${ref}_SENSE ${npos} ${left} 0`);
      }
      const esr = toFloat(p('esr', p('series_resistance', 0.0)));
      const esl = toFloat(p('esl', 0.0));
      if (esl > 0) {
        lines.push(`L${ref}_ESL ${left} n_${ref}_esl ${fmt(esl)}`);
        left = `n_${ref}_esl`;
      }
      if (esr > 0) {
        lines.push(`R${ref}_ESR ${left} n_${ref}_esr ${fmt(esr)}`);
        left = `n_${ref}_esr`;
      }
      lines.push(
        cic === null || cic === undefined
          ? `${cName} ${left} ${nneg} ${cval}`
          : `${cName} ${left} ${nneg} ${cval} IC=${fmt(cic)}`,
      );
      let rleak: unknown = p('leakage_resistance', null);
      if (rleak === null || rleak === undefined)
        rleak = deriveLeakageResistance(params);
      if (rleak !== null && rleak !== undefined) {
        try {
          if (toFloat(rleak) > 0)
            lines.push(`R${ref}_LEAK ${npos} ${nneg} ${fmt(rleak)}`);
        } catch {
          // Python: `except Exception: pass`
        }
      }
    } else if (ctype === 'inductor') {
      const pins = needPins(ref, nets, ['pos', 'neg'], ctype);
      const [npos, nneg] = [
        pins.get('pos') as string,
        pins.get('neg') as string,
      ];
      const lval = fmt(item(params, 'inductance'));
      const lic = p('ic', null);
      const lName = spiceDevName('L', refValue);
      let nsense = npos;
      if (!isInternal && p('sense') !== false) {
        nsense = `n_${ref}_sense`;
        lines.push(`V${ref}_SENSE ${npos} ${nsense} 0`);
      }
      const rs = toFloat(p('series_resistance', 0.0));
      let lpos = nsense;
      if (rs > 0) {
        lpos = `n_${ref}_ser`;
        lines.push(`R${ref}_ESR ${nsense} ${lpos} ${fmt(rs)}`);
      }
      lines.push(
        lic === null || lic === undefined
          ? `${lName} ${lpos} ${nneg} ${lval}`
          : `${lName} ${lpos} ${nneg} ${lval} IC=${fmt(lic)}`,
      );
      const cp = toFloat(p('parasitic_capacitance', 0.0));
      if (cp > 0) lines.push(`C${ref}_par ${npos} ${nneg} ${fmt(cp)}`);
      const rp = p('core_loss_resistance', null);
      if (rp !== null && rp !== undefined) {
        try {
          if (toFloat(rp) > 0)
            lines.push(`R${ref}_core ${npos} ${nneg} ${fmt(rp)}`);
        } catch {
          // Python: `except Exception: pass`
        }
      }
    } else if (ctype === 'diode') {
      const pins = needPins(ref, nets, ['anode', 'cathode'], ctype);
      const model = pyStr(or(or(p('model'), p('model_name')), 'Dmodel'));
      const dName = spiceDevName('D', refValue);
      if (p('sense') === false || isInternal) {
        lines.push(
          `${dName} ${pins.get('anode')} ${pins.get('cathode')} ${model}`,
        );
      } else {
        lines.push(`V${ref}_SENSE ${pins.get('anode')} n_${ref}_sense 0`);
        lines.push(`R${ref}_SENSE_DAMP n_${ref}_sense n_${ref}_damp 0.001`);
        lines.push(`${dName} n_${ref}_damp ${pins.get('cathode')} ${model}`);
      }
    } else if (
      ['transistor', 'mosfet', 'igbt', 'vg-fet'].includes(ctype as string)
    ) {
      const family = transistorFamily(ctype, params);
      const ct = ctype as string;
      if (family === 'bjt') {
        const pins = needPins(
          ref,
          nets,
          ['collector', 'emitter', 'base'],
          ct,
          family,
        );
        const C = or(or(pins.get('collector'), pins.get('C')), pins.get('pos'));
        const E = or(or(pins.get('emitter'), pins.get('E')), pins.get('neg'));
        const B = pins.get('base');
        const t = lower(p('type', 'npn'));
        lines.push(`V${ref}_SENSE n_${ref}_esense ${pyStr(E)} 0`);
        lines.push(
          `${spiceDevName('Q', refValue)} ${pyStr(C)} ${B} n_${ref}_esense ${t}_model`,
        );
      } else if (family === 'vdmos') {
        const pins = needPins(
          ref,
          nets,
          ['drain', 'source', 'gate'],
          ct,
          family,
        );
        const model = pyStr(or(or(p('model'), p('model_name')), 'power_nmos'));
        const mName = spiceDevName('M', refValue);
        if (p('sense') === false || isInternal) {
          lines.push(
            `${mName} ${pins.get('drain')} ${pins.get('gate')} ${pins.get('source')} ${model}`,
          );
        } else {
          lines.push(`V${ref}_SENSE ${pins.get('drain')} n_${ref}_dsense 0`);
          lines.push(
            `${mName} n_${ref}_dsense ${pins.get('gate')} ${pins.get('source')} ${model}`,
          );
        }
      } else if (family === 'mosfet') {
        const pins = needPins(
          ref,
          nets,
          ['drain', 'source', 'gate'],
          ct,
          family,
        );
        const [D, G, S] = [
          pins.get('drain'),
          pins.get('gate'),
          pins.get('source'),
        ];
        const model = pyStr(mosfetModelName(params, mosfetChannel(params)));
        const mName = spiceDevName('M', refValue);
        if (p('sense') === false || isInternal) {
          lines.push(`${mName} ${D} ${G} ${S} ${S} ${model}`);
        } else {
          lines.push(`V${ref}_SENSE ${D} n_${ref}_dsense 0`);
          lines.push(`${mName} n_${ref}_dsense ${G} ${S} ${S} ${model}`);
        }
      } else if (family === 'jfet') {
        const pins = needPins(
          ref,
          nets,
          ['drain', 'source', 'gate'],
          ct,
          family,
        );
        const polarity = pyStr(p('polarity', 'n'));
        lines.push(`V${ref}_SENSE ${pins.get('drain')} n_${ref}_dsense 0`);
        lines.push(
          `${spiceDevName('J', refValue)} n_${ref}_dsense ${pins.get('gate')} ${pins.get('source')} ${polarity}jfet_model`,
        );
      } else {
        throw new PyError(
          'ValueError',
          `Unsupported transistor family '${family}' for component ${ref}. Valid families: bjt, mosfet, jfet, vdmos`,
        );
      }
    } else if (ctype === 'transformer') {
      needPins(ref, nets, ['P1', 'P2', 'S1', 'S2']);
      const [P1, P2, S1, S2] = ['P1', 'P2', 'S1', 'S2'].map((pin) =>
        nets.get(pin),
      );
      const lm = toFloat(p('Lm_primary'));
      const ns = toFloat(p('turns_ratio'));
      const k = toFloat(p('k_coupling'));
      const phase = lower(or(p('phase'), 'same'));
      const K = phase === 'same' ? k : -k;
      const rwp = toFloat(p('Rp', 0.5));
      const rws = toFloat(p('Rs', 0.1));
      const rcoreRaw = p('core_loss_resistance', 1e6);
      const rcore =
        rcoreRaw === null || rcoreRaw === undefined || toFloat(rcoreRaw) <= 0
          ? 1e6
          : toFloat(rcoreRaw);
      let cww = 0;
      for (const internal of iter(get(comp, 'internal', []))) {
        if (
          ['CWW', 'Cww'].includes(get(internal, 'ref') as string) &&
          get(internal, 'type') === 'capacitor'
        ) {
          cww = toFloat(get(get(internal, 'params', {}), 'capacitance', 0n));
          break;
        }
      }
      if (cww === 0 && has(params, 'Cww')) cww = toFloat(p('Cww', 0n));
      lines.push(`V${ref}_SENSE_PRI ${P1} n_${ref}_p1_sense 0`);
      lines.push(`V${ref}_SENSE_SEC ${S1} n_${ref}_s1_sense 0`);
      lines.push(
        `X${ref} n_${ref}_p1_sense ${P2} n_${ref}_s1_sense ${S2} Xfmr ` +
          `Lm=${fmt(lm)} Ns=${fmt(ns)} K=${fmt(K)} Rwp=${fmt(rwp)} Rws=${fmt(rws)} Rcore=${fmt(rcore)} Cww=${fmt(cww)}`,
      );
    } else if (ctype === 'ct_transformer') {
      needPins(ref, nets, ['P1', 'P2', 'S1', 'S2', 'CT']);
      const [P2, S1, S2, CT] = ['P2', 'S1', 'S2', 'CT'].map((pin) =>
        nets.get(pin),
      );
      const P1 = nets.get('P1');
      const lmRaw = p('Lm_primary', p('inductance'));
      if (lmRaw === null || lmRaw === undefined) {
        throw new PyError(
          'ValueError',
          `${ref}: missing 'Lm_primary' (or 'inductance') for ct_transformer`,
        );
      }
      const lm = toFloat(lmRaw);
      const ns = toFloat(p('turns_ratio'));
      const k = toFloat(p('k_coupling', p('coupling_coefficient', 0.99)));
      const [K1, K2, K12] = ctCouplingCoefficients(
        k,
        lower(or(p('phase_s1'), 'same')),
        lower(or(p('phase_s2'), 'same')),
      );
      const rwp = toFloat(p('Rp', p('winding_resistance_p', 0.1)));
      const rws1 = toFloat(p('Rs1', p('winding_resistance_s1', 0.05)));
      const rws2 = toFloat(p('Rs2', p('winding_resistance_s2', 0.05)));
      const rcoreRaw = p('core_loss_resistance', 1e6);
      const rcore =
        rcoreRaw === null || rcoreRaw === undefined || toFloat(rcoreRaw) <= 0
          ? 1e6
          : toFloat(rcoreRaw);
      lines.push(`V${ref}_SENSE_PRI ${P1} n_${ref}_p1_sense 0`);
      lines.push(`V${ref}_SENSE_SEC1 ${S1} n_${ref}_s1_sense 0`);
      lines.push(`V${ref}_SENSE_SEC2 ${S2} n_${ref}_s2_sense 0`);
      const fields = [
        `Lm=${fmt(lm)}`,
        `Ns=${fmt(ns)}`,
        `K1=${fmt(K1)}`,
        `K2=${fmt(K2)}`,
        `K12=${fmt(K12)}`,
        `Rwp=${fmt(rwp)}`,
        `Rws1=${fmt(rws1)}`,
        `Rws2=${fmt(rws2)}`,
        `Rcore=${fmt(rcore)}`,
        `Cww1=${fmt(p('interwinding_capacitance_s1', 5e-11))}`,
        `Cww2=${fmt(p('interwinding_capacitance_s2', 5e-11))}`,
        `Rct=${fmt(p('center_tap_resistance', 1e12))}`,
        `Cct=${fmt(p('center_tap_capacitance', 0n))}`,
      ];
      lines.push(
        `X${ref} n_${ref}_p1_sense ${P2} n_${ref}_s1_sense n_${ref}_s2_sense ${CT} Xctfmr ${fields.join(' ')}`,
      );
    } else if (ctype === 'dual_ct_transformer') {
      needPins(ref, nets, ['P1', 'CT_P', 'P2', 'S1', 'CT_S', 'S2']);
      const [P1, CTP, P2, S1, CTS, S2] = [
        'P1',
        'CT_P',
        'P2',
        'S1',
        'CT_S',
        'S2',
      ].map((pin) => nets.get(pin));
      const lm = toFloat(p('Lm_primary', p('inductance', 100e-6)));
      const ns = toFloat(p('turns_ratio', 2.0));
      const base = variant === 'base';
      const K = ctCouplingMagnitude(
        base
          ? p('coupling_coefficient', 0.995)
          : p('k_coupling', p('coupling_coefficient', 0.995)),
      );
      const wr = (short: string, long: string) =>
        toFloat(base ? p(long, 0.05) : p(short, p(long, 0.05)));
      const rp1 = wr('Rp1', 'winding_resistance_p1');
      const rp2 = wr('Rp2', 'winding_resistance_p2');
      const rs1 = wr('Rs1', 'winding_resistance_s1');
      const rs2 = wr('Rs2', 'winding_resistance_s2');
      lines.push(`V${ref}_SENSE_PRI1 ${P1} n_${ref}_p1_sense 0`);
      lines.push(`V${ref}_SENSE_PRI2 ${P2} n_${ref}_p2_sense 0`);
      lines.push(`V${ref}_SENSE_SEC1 ${S1} n_${ref}_s1_sense 0`);
      lines.push(`V${ref}_SENSE_SEC2 ${S2} n_${ref}_s2_sense 0`);
      lines.push(
        `X${ref} n_${ref}_p1_sense ${CTP} n_${ref}_p2_sense n_${ref}_s1_sense ${CTS} n_${ref}_s2_sense Xdualctfmr ` +
          [
            `Lm_primary=${fmt(lm)}`,
            `Ns=${fmt(ns)}`,
            `K=${fmt(K)}`,
            `Rp1=${fmt(rp1)}`,
            `Rp2=${fmt(rp2)}`,
            `Rs1=${fmt(rs1)}`,
            `Rs2=${fmt(rs2)}`,
          ].join(' '),
      );
    } else if (ctype === 'b_source') {
      needPins(ref, nets, ['+', '-']);
      const expression = p('expression', '0');
      const bName = spiceDevName('B', refValue);
      const isCurrent =
        has(params, 'i_expression') ||
        lower(p('source_type', '')) === 'i' ||
        lower(p('type', '')) === 'i';
      if (isCurrent) {
        lines.push(
          `${bName} ${nets.get('+')} ${nets.get('-')} i='${pyStr(or(p('i_expression'), expression))}'`,
        );
      } else {
        lines.push(
          `${bName} ${nets.get('+')} ${nets.get('-')} v='${pyStr(expression)}'`,
        );
      }
    } else if (ctype === 'e_source') {
      const eName = spiceDevName('E', refValue);
      if (has(params, 'expression') || has(params, 'value')) {
        needPins(ref, nets, ['+', '-']);
        const expr = or(p('expression'), p('value'));
        lines.push(
          `${eName} ${nets.get('+')} ${nets.get('-')} VALUE = { ${pyStr(expr)} }`,
        );
      } else {
        needPins(ref, nets, ['+', '-', 'ctrl+', 'ctrl-']);
        lines.push(
          `${eName} ${nets.get('+')} ${nets.get('-')} ${nets.get('ctrl+')} ${nets.get('ctrl-')} ${fmt(p('gain', 1n))}`,
        );
      }
    } else if (ctype === 'g_source') {
      needPins(ref, nets, ['+', '-', 'ctrl+', 'ctrl-']);
      lines.push(
        `${spiceDevName('G', refValue)} ${nets.get('+')} ${nets.get('-')} ${nets.get('ctrl+')} ${nets.get('ctrl-')} ${fmt(p('gain', p('transconductance', 1n)))}`,
      );
    } else if (ctype === 'switch') {
      const pins = needPins(ref, nets, ['pos', 'neg', 'ctrl+', 'ctrl-'], ctype);
      const model = pyStr(or(or(p('model'), p('model_name')), 'sw_mod'));
      lines.push(
        `${spiceDevName('S', refValue)} ${pins.get('pos')} ${pins.get('neg')} ${pins.get('ctrl+')} ${pins.get('ctrl-')} ${model}`,
      );
    } else if (isControlBlock(ctype)) {
      lines.push(...emitControlBlock(ref, ctype, params, nets));
    } else if (ctype === 'custom_spice') {
      const raw = p('spice_line', `* Empty custom spice for ${ref}`);
      if (typeof raw !== 'string') {
        throw new PyError('TypeError', 'sequence item: expected str instance');
      }
      lines.push(
        variant === 'base' && raw.trim().toLowerCase().startsWith('.ic')
          ? sanitizeIcStatement(raw)
          : raw,
      );
    } else {
      throw new PyError(
        'ValueError',
        `Unknown component type '${pyStr(ctype)}' for component ${ref}. ` +
          'Valid types: node, resistor, capacitor, inductor, diode, transistor, transformer, ct_transformer, dual_ct_transformer, b_source, e_source, g_source, custom_spice, switch, ' +
          `and control blocks: ${Object.keys(CONTROL_BLOCK_TYPES).join(', ')}. ` +
          'Check circuit.yaml and Pydantic schema for supported component types.',
      );
    }
  }
  return pwmPeriod;
}

const header = (design: Dict, notes: string[]): string[] => {
  const name = get(design, 'name');
  return [
    truthy(name)
      ? `* Auto-generated SPICE netlist - ${pyStr(name)}`
      : '* Auto-generated SPICE netlist (self-contained)',
    ...notes,
  ];
};

/** `.param` reference block of the base netlist. */
function paramBlock(design: Dict): string[] {
  const out = [
    '',
    '* ---- Key simulation parameters (for reference & manual editing) ----',
  ];
  for (const comp of iter(get(design, 'components', []))) {
    const ref = pyStr(get(comp, 'ref', ''));
    const ctype = get(comp, 'type', '');
    const params = or(get(comp, 'params', {}), {}) as Dict;
    const p = (key: string, dflt?: unknown) => get(params, key, dflt);
    const set = (v: unknown) => v !== null && v !== undefined;
    if (ctype === 'node') {
      const nodeType = p('node_type', '');
      if (nodeType === 'voltage_source') {
        if (set(p('voltage')))
          out.push(
            `.param ${ref}_voltage = ${fmt(p('voltage'))}      $ Input voltage (V)`,
          );
        if (set(p('series_resistance'))) {
          out.push(
            `.param ${ref}_Rs = ${fmt(p('series_resistance'))}      $ Source series resistance (Ohm)`,
          );
        }
      } else if (nodeType === 'pwm_control') {
        const fsw = p('frequency');
        const d = p('duty_cycle');
        const td = p('tdelay', 0.0);
        const vh = p('vhigh', 5.0);
        const vl = p('vlow', 0.0);
        if (set(fsw)) {
          const f = toFloat(fsw);
          if (f === 0)
            throw new PyError('ZeroDivisionError', 'float division by zero');
          out.push(
            `.param ${ref}_Fsw = ${fmt(fsw)}      $ Switching frequency (Hz)`,
          );
          out.push(
            `.param ${ref}_Tsw = ${fmt(1 / f)}      $ Switching period (s)`,
          );
        }
        if (set(d)) out.push(`.param ${ref}_D = ${fmt(d)}      $ Duty cycle`);
        if (truthy(td))
          out.push(
            `.param ${ref}_tdelay = ${fmt(td)}      $ Gate drive delay (s)`,
          );
        if (set(vh))
          out.push(
            `.param ${ref}_Vhigh = ${fmt(vh)}      $ Gate drive high level (V)`,
          );
        if (set(vl))
          out.push(
            `.param ${ref}_Vlow = ${fmt(vl)}      $ Gate drive low level (V)`,
          );
        if (set(p('trise')))
          out.push(
            `.param ${ref}_trise = ${fmt(p('trise'))}      $ Rise time (s)`,
          );
        if (set(p('tfall')))
          out.push(
            `.param ${ref}_tfall = ${fmt(p('tfall'))}      $ Fall time (s)`,
          );
      }
    } else if (ctype === 'inductor') {
      if (set(p('inductance')))
        out.push(
          `.param ${ref}_L = ${fmt(p('inductance'))}      $ Inductance (H)`,
        );
      if (set(p('series_resistance'))) {
        out.push(
          `.param ${ref}_DCR = ${fmt(p('series_resistance'))}      $ Winding resistance (Ohm)`,
        );
      }
    } else if (ctype === 'capacitor') {
      if (set(p('capacitance')))
        out.push(
          `.param ${ref}_C = ${fmt(p('capacitance'))}      $ Capacitance (F)`,
        );
      if (set(p('esr')))
        out.push(`.param ${ref}_ESR = ${fmt(p('esr'))}      $ ESR (Ohm)`);
    } else if (ctype === 'resistor') {
      if (set(p('resistance')))
        out.push(
          `.param ${ref}_R = ${fmt(p('resistance'))}      $ Resistance (Ohm)`,
        );
    } else if (ctype === 'transformer') {
      const lm = or(p('inductance'), p('Lm'));
      const ns = or(p('turns_ratio'), p('Ns'));
      const k = p('coupling', p('K'));
      const rwp = p('primary_resistance', p('Rwp'));
      const rws = p('secondary_resistance', p('Rws'));
      if (set(lm))
        out.push(
          `.param ${ref}_Lm = ${fmt(lm)}      $ Magnetising inductance (H)`,
        );
      if (set(ns))
        out.push(`.param ${ref}_Ns_Np = ${fmt(ns)}      $ Turns ratio Ns/Np`);
      if (set(k))
        out.push(`.param ${ref}_K = ${fmt(k)}      $ Coupling coefficient`);
      if (set(rwp))
        out.push(
          `.param ${ref}_Rwp = ${fmt(rwp)}      $ Primary winding resistance (Ohm)`,
        );
      if (set(rws))
        out.push(
          `.param ${ref}_Rws = ${fmt(rws)}      $ Secondary winding resistance (Ohm)`,
        );
    }
  }
  let vin: unknown = null;
  let rload: unknown = null;
  for (const comp of iter(get(design, 'components', []))) {
    const params = or(get(comp, 'params', {}), {}) as Dict;
    if (
      get(comp, 'type') === 'node' &&
      get(params, 'node_type') === 'voltage_source'
    ) {
      if (vin === null || vin === undefined) vin = get(params, 'voltage');
    }
    if (
      get(comp, 'type') === 'resistor' &&
      lower(get(comp, 'role', '')).includes('load')
    ) {
      if (rload === null || rload === undefined)
        rload = get(params, 'resistance');
    }
  }
  if (rload !== null && rload !== undefined) {
    out.push(`.param R_LOAD = ${fmt(rload)}      $ Load resistance (Ohm)`);
    if (vin !== null && vin !== undefined) {
      out.push(
        '* Estimated Iload = Vout / R_LOAD  (check simulation results for actual Vout)',
      );
    }
  }
  return out.length > 2 ? out : [];
}

export interface GeneratedNetlist {
  netlist: string;
  controls: Record<AnalysisKind, string>;
}

/** `generate_netlist(design, analysis_filter)`: base netlist + control blocks. */
export function generateNetlist(
  design: Dict,
  analysisFilter: readonly string[] | null = null,
): GeneratedNetlist {
  ensureDiodeBridgeFilterCapacitor(design);
  clampCapacitorEsl(design);
  const [compNets, notes] = buildCompNets(design);
  buildComponentsIndex(design);
  // The combined netlist takes the transient settings when there is a
  // transient analysis (the usual run).
  const analyses = get(design, 'analysis', {});
  const primary =
    (['transient', 'dc', 'ac'] as const).find(
      (kind) =>
        has(analyses, kind) &&
        (!analysisFilter?.length || analysisFilter.includes(kind)),
    ) ?? null;
  const lines = [...header(design, notes), ...optionLines(design, primary)];

  const transientSpice = transientSpiceSettings(design);
  const spice = get(get(design, 'analysis', {}), 'spice_settings', {});
  const isDab = pyStr(get(design, 'id', ''))
    .toLowerCase()
    .includes('dual_active_bridge');
  const save = isDab
    ? null
    : or(
        or(
          or(
            get(spice, 'save'),
            isDict(transientSpice) ? get(transientSpice, 'save') : null,
          ),
          get(get(get(design, 'analysis', {}), 'spice_settings', {}), 'save'),
        ),
        get(design, 'save'),
      );
  if (truthy(save)) {
    lines.push(
      `.save ${Array.isArray(save) ? save.map(pyStr).join(' ') : pyStr(save)}`,
    );
  }

  lines.push(...paramBlock(design));
  lines.push('');

  // Legacy `variables.ac_source` scan (no output; kept for its error behaviour).
  for (const req of requirementsOfAc(design)) {
    for (const acSource of iter(
      get(get(req, 'variables', {}), 'ac_source', []),
    )) {
      get(acSource, 'component');
    }
  }

  const models = generateComponentModels(design);
  if (models.trim()) lines.push(models);
  const subckts = subcktTemplatesNeeded(design);
  if (subckts.trim()) lines.push(subckts);

  const pwmPeriod =
    emitElements(design, compNets, lines, 'base', new Set()) ??
    detectPwmPeriod(design) ??
    1e-5;

  const wanted =
    analysisFilter === null ? null : analysisFilter.map((a) => a.toLowerCase());
  const want = (kind: string) => wanted === null || wanted.includes(kind);
  const controls: Record<AnalysisKind, string> = {
    dc: want('dc') ? generateDcControlBlock(design, compNets) : '',
    ac: want('ac') ? generateAcControlBlock(design, compNets) : '',
    transient: want('transient')
      ? generateTransientControlBlock(design, compNets, pwmPeriod)
      : '',
  };
  lines.push('', '.end');
  return { netlist: lines.join('\n'), controls };
}

function requirementsOfAc(design: Dict): unknown[] {
  const ac = get(get(design, 'analysis', {}), 'ac', {});
  return isDict(ac) ? iter(get(ac, 'requirements', [])) : iter(ac);
}

const NET_PAIR = (connection: unknown): connection is [unknown, unknown] =>
  Array.isArray(connection) && connection.length === 2;

/**
 * `generate_netlist_for_analysis`: the circuit for one analysis, where AC /
 * DC injection sources replace the voltage sources at their nets.
 */
export function generateNetlistForAnalysis(
  design: Dict,
  kind: AnalysisKind,
): string {
  ensureDiodeBridgeFilterCapacitor(design);
  clampCapacitorEsl(design);
  const [compNets, notes] = buildCompNets(design);
  buildComponentsIndex(design);

  const existing = new Set<string>();
  for (const comp of iter(get(design, 'components', []))) {
    existing.add(keyText(item(comp, 'ref')));
    for (const internal of iter(get(comp, 'internal', [])))
      existing.add(keyText(item(internal, 'ref')));
  }
  const replace = new Set<string>();
  const sourcesToAdd: Dict[] = [];
  const analysisData = get(design, 'analysis', {});

  if (kind === 'ac') {
    const requirements = requirementsOf(get(analysisData, 'ac', {}));
    const netIndex: Array<Array<[unknown, unknown]>> = [];
    for (const net of iter(get(design, 'nets', []))) {
      const members: Array<[unknown, unknown]> = [];
      for (const connection of iter(net)) {
        if (NET_PAIR(connection)) members.push([connection[0], connection[1]]);
        else {
          const ref =
            typeof connection === 'string'
              ? connection
              : truthy(connection)
                ? (connection as unknown[])[0]
                : null;
          if (truthy(ref)) members.push([ref, '']);
        }
      }
      netIndex.push(members);
    }
    const all = new Map<string, Dict>();
    const sourceNets = new Map<string, number>();
    for (const req of requirements) {
      for (const envVar of iter(get(req, 'environment', []))) {
        if (get(envVar, 'ref') !== 'ac_sources') continue;
        for (const [componentRef, config] of Object.entries(envVar as Dict)) {
          if (
            componentRef === 'ref' ||
            componentRef === 'net' ||
            all.has(componentRef)
          )
            continue;
          if (!isDict(config)) {
            throw new PyError(
              'ValueError',
              'dictionary update sequence element #0 has length 1; 2 is required',
            );
          }
          const source: Dict = { ...config, component: componentRef };
          all.set(componentRef, source);
          const netSpec = get(source, 'net');
          if (truthy(netSpec) && len(netSpec) === 2) {
            const [specRef, specPin] = netSpec as unknown[];
            const idx = netIndex.findIndex((members) =>
              members.some(
                ([r, pin]) => pyEquals(r, specRef) && pyEquals(pin, specPin),
              ),
            );
            if (idx >= 0) sourceNets.set(componentRef, idx);
          }
        }
      }
    }
    for (const source of all.values()) sourcesToAdd.push(source);
    const index = componentsDict(design);
    for (const idx of sourceNets.values()) {
      for (const [onNet] of netIndex[idx] ?? []) {
        const data = get(index, keyText(onNet));
        if (!truthy(data)) continue;
        if (
          get(data, 'type') === 'node' &&
          ['voltage_source', 'pwm_control'].includes(
            get(get(data, 'params', {}), 'node_type') as string,
          )
        ) {
          replace.add(keyText(onNet));
        }
      }
    }
  } else if (kind === 'dc') {
    const requirements = requirementsOf(get(analysisData, 'dc', {}));
    const processed = new Set<string>();
    const validNets: Array<[unknown, unknown]> = [];
    for (const net of iter(get(design, 'nets', []))) {
      for (const connection of iter(net)) {
        if (NET_PAIR(connection))
          validNets.push([connection[0], connection[1]]);
      }
    }
    for (const req of requirements) {
      for (const envVar of iter(get(req, 'environment', []))) {
        if (get(envVar, 'ref') !== 'dc_sources') continue;
        for (const [componentRef, config] of Object.entries(envVar as Dict)) {
          if (
            ['ref', 'description', 'net'].includes(componentRef) ||
            processed.has(componentRef)
          )
            continue;
          if (!isDict(config)) continue;
          const source: Dict = { ...config, component: componentRef };
          const netSpec = get(source, 'net');
          if (truthy(netSpec) && len(netSpec) === 2) {
            const [specRef, specPin] = netSpec as unknown[];
            if (
              validNets.some(
                ([r, pin]) => pyEquals(r, specRef) && pyEquals(pin, specPin),
              )
            ) {
              sourcesToAdd.push(source);
              processed.add(componentRef);
              if (existing.has(keyText(specRef))) replace.add(keyText(specRef));
            }
          } else {
            sourcesToAdd.push(source);
            processed.add(componentRef);
            if (existing.has(componentRef)) replace.add(componentRef);
          }
        }
      }
    }
  }

  const lines = [...header(design, notes), ...optionLines(design, kind)];
  const models = generateComponentModels(design);
  if (models.trim()) lines.push(models);
  const subckts = subcktTemplatesNeeded(design);
  if (subckts.trim()) lines.push(subckts);

  emitElements(design, compNets, lines, 'analysis', replace);

  if (sourcesToAdd.length > 0) {
    if (kind === 'ac') lines.push('\n* AC sources for measurement injection');
    else if (kind === 'dc')
      lines.push('\n* DC sources for measurement injection');
    for (const source of sourcesToAdd) {
      const netSpec = get(source, 'net');
      const sourceRef = pyStr(get(source, 'component'));
      const sourceType = get(source, 'type', 'voltage');
      if (!(truthy(netSpec) && len(netSpec) === 2)) continue;
      const [specRef, specPin] = netSpec as unknown[];
      try {
        const pos = resolveVoltageNode(design, compNets, specRef, specPin);
        const original = get(componentsDict(design), keyText(specRef));
        const nodeType = truthy(original)
          ? get(get(original, 'params', {}), 'node_type')
          : null;
        if (kind === 'ac') {
          const injection = get(source, 'injection_point', 'analysis');
          let dcBias: unknown;
          if (nodeType === 'voltage_source') {
            dcBias = get(
              source,
              'dc_bias',
              get(get(original, 'params', {}), 'voltage', 12.0),
            );
          } else if (nodeType === 'pwm_control') {
            dcBias = get(source, 'dc_bias', 3.0);
          } else {
            dcBias = get(source, 'dc_bias', 12.0);
          }
          if (sourceType === 'current') {
            lines.push(
              `I${sourceRef} ${pos} 0 DC 0 AC 0 ; AC current source for measurement injection`,
            );
          } else if (injection === 'control') {
            lines.push(
              `V${sourceRef} ${pos} 0 DC ${fmt(dcBias)} AC 0 ; AC source for control injection`,
            );
            lines.push(
              `R${sourceRef}_PAR ${pos} 0 1e6 ; Parallel resistance (high-Z) for control point injection`,
            );
          } else if (injection === 'output') {
            lines.push(
              `V${sourceRef} ${sourceRef}_src 0 DC ${fmt(dcBias)} AC 0 ; AC source for output point injection`,
            );
            lines.push(
              `R${sourceRef}_series ${sourceRef}_src ${pos} 0.01 ; Series resistance (source impedance) for output point injection`,
            );
          } else {
            lines.push(
              `V${sourceRef} ${sourceRef}_src 0 DC ${fmt(dcBias)} AC 0 ; AC source for input/measurement injection`,
            );
            lines.push(
              `R${sourceRef}_series ${sourceRef}_src ${pos} 0.01 ; Series resistance (source impedance) for input/measurement injection`,
            );
          }
        } else if (kind === 'dc') {
          const voltage = get(source, 'voltage', 3.0);
          if (sourceType === 'current') {
            lines.push(
              `I${sourceRef} ${pos} 0 DC 0 ; DC current source for measurement injection`,
            );
          } else if (nodeType === 'pwm_control') {
            lines.push(
              `V${sourceRef} ${pos} 0 DC ${fmt(voltage)} ; DC source for control node`,
            );
            lines.push(
              `R${sourceRef}_PAR ${pos} 0 1e6 ; Parallel resistance (consistency with AC topology)`,
            );
          } else if (nodeType === 'voltage_source') {
            lines.push(
              `V${sourceRef} ${sourceRef}_src 0 DC ${fmt(voltage)} ; DC source for voltage source node`,
            );
            lines.push(
              `R${sourceRef}_series ${sourceRef}_src ${pos} 0.01 ; Series resistance (consistency with AC topology)`,
            );
          } else {
            lines.push(`V${sourceRef} ${pos} 0 DC ${fmt(voltage)} ; DC source`);
          }
        }
      } catch {
        // Python: log and continue with the next source
      }
    }
  }

  lines.push('', '.end');
  return lines.join('\n');
}

export interface AnalysisCirs {
  /** Base component netlist (with the `.param` reference block). */
  netlist: string;
  /** Self-contained deck per analysis the topology has requirements for. */
  analysis_cirs: Partial<Record<AnalysisKind, string>>;
}

/**
 * `simulator.generate_analysis_cirs`: the decks `/simulate/prepare` returns,
 * generated without running ngspice. Mutates `design` like the core did
 * (ESL clamp, `components_dict`), so pass a copy.
 */
export function generateAnalysisCirs(
  design: Dict,
  analysisType: 'all' | AnalysisKind = 'all',
): AnalysisCirs {
  const { netlist, controls } = generateNetlist(design, null);
  const wanted: readonly AnalysisKind[] =
    analysisType === 'all' ? ANALYSIS_KINDS : [analysisType];
  const designLine = designSummaryLine(design);
  const decks: Partial<Record<AnalysisKind, string>> = {};
  for (const kind of wanted) {
    const control = controls[kind] ?? '';
    if (!control || !control.trim()) continue;
    let body = generateNetlistForAnalysis(design, kind);
    if (designLine) {
      // Keep the SPICE title as the first line; the summary is a plain comment.
      const cut = body.indexOf('\n');
      body =
        cut < 0
          ? `${body}\n${designLine}\n`
          : `${body.slice(0, cut)}\n${designLine}\n${body.slice(cut + 1)}`;
    }
    decks[kind] = `${body}\n\n${control}`;
  }
  return { netlist, analysis_cirs: decks };
}
