/**
 * `.control` blocks per analysis, ported from qdonis-core
 * `simulator/netlist_generator.py` (`generate_dc_control_block`,
 * `generate_ac_control_block`, `generate_transient_control_block`).
 */

import { pythonStrip } from '../../common/python/python-json';
import {
  componentsDict,
  deviceCurrentVector,
  elementNameForCurrent,
  keyText,
  needPins,
  resolveVoltageNode,
  spiceDevName,
  type CompNets,
} from './comp-nets';
import {
  LET_MARKER,
  LET_MARKER_ALL,
  chooseWindowByCmd,
  emitMeas,
  measurementsOf,
  processSpiceCommand,
  tokenToExpr,
} from './spice-command';
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
  replaceAll,
  splitWs,
  toFloat,
  truthy,
  type Dict,
} from './py';
import {
  alignWindowToLineCycles,
  detectPwmPeriod,
  linePeriod,
  parseValue,
} from './timing';

export const RELTOL_DEFAULT = 1e-2;
export const ABSTOL_DEFAULT = 1e-9;
export const VNTOL_DEFAULT = 1e-5;
export const CHGTOL_DEFAULT = 1e-11;
export const GMIN_DEFAULT = 1e-10;
export const TRTOL_DEFAULT = 4n;
export const METHOD_DEFAULT = 'gear';
export const MAXORD_DEFAULT = 2n;
const PRINT_POINTS_PER_PERIOD = 25;
const MAXSTEP_DIV = 10;
const MIN_TSTEP_DEFAULT = 1e-8;

const SIMPLE = ['min', 'max', 'avg', 'pp', 'rms'];

const netsOf = (compNets: CompNets, ref: unknown): Map<string, string> =>
  compNets.get(keyText(ref)) ?? new Map<string, string>();

const sectionRequirements = (section: unknown): unknown[] =>
  isDict(section) ? iter(get(section, 'requirements', [])) : iter(section);

/** Requirement heading key and comment line (`rid`, else `req<N>`). */
function requirementHeader(
  req: unknown,
  requirements: unknown[],
  label: string,
  prefix: string,
): [string, string] {
  const rid = get(req, 'rid');
  if (truthy(rid)) {
    const title = get(req, 'requirement', `${prefix}_${pyStr(rid)}`);
    return [
      pyStr(rid),
      `\n* ${label} Requirement ${pyStr(rid)}: ${pyStr(title)}`,
    ];
  }
  const ridx = requirements.findIndex((other) => pyEquals(other, req)) + 1;
  const title = get(req, 'requirement', `${prefix}_REQ${ridx}`);
  return [`req${ridx}`, `\n* ${label} Requirement ${ridx}: ${pyStr(title)}`];
}

/** Resolves a `nets: [[pos_ref, pos_pin], [neg_ref, neg_pin]]` spec. */
function diffNodes(
  design: Dict,
  compNets: CompNets,
  netsSpec: unknown,
): [string, string] {
  const spec = netsSpec as unknown[][];
  return [
    resolveVoltageNode(design, compNets, spec[0][0], spec[0][1]),
    resolveVoltageNode(design, compNets, spec[1][0], spec[1][1]),
  ];
}

const isTwoNetSpec = (spec: unknown): boolean =>
  truthy(spec) && len(spec) === 2;

/** Pops a `__LET__` marker into a `let` line; returns the expression to use. */
function extractLet(expr: string, lines: string[]): string {
  const match = LET_MARKER.exec(expr);
  if (!match) return expr;
  lines.push(`let ${match[1]} = v(${match[2]}) - v(${match[3]})`);
  return match[1];
}

// ---------------------------------------------------------------- DC

export function generateDcControlBlock(
  design: Dict,
  compNets: CompNets,
): string {
  const lines = [
    '.control',
    'set noaskquit',
    'set nomoremode',
    'set numdgt=9',
    '',
  ];
  const analysisData = get(design, 'analysis', {});
  const dcAnalysis = get(analysisData, 'dc', {});
  const requirements = sectionRequirements(dcAnalysis);

  for (const req of requirements) {
    const [reqKey, heading] = requirementHeader(req, requirements, 'DC', 'DC');
    lines.push(heading);

    const sweepVars = iter(get(req, 'environment', [])).filter(
      (envVar) =>
        get(envVar, 'ref') === 'dc_sweep' &&
        ['voltage', 'current'].includes(get(envVar, 'parameter') as string),
    );
    if (sweepVars.length > 0) {
      for (const sweep of sweepVars) {
        let sourceRef = get(sweep, 'source');
        const start = get(sweep, 'start', 0n);
        const stop = get(sweep, 'stop', 10n);
        const step = get(sweep, 'step', 1n);
        if (!truthy(sourceRef)) sourceRef = 'VIN';
        lines.push(
          `dc v${lower(sourceRef)} ${fmt(start)} ${fmt(stop)} ${fmt(step)}`,
        );
      }
    } else {
      lines.push('op');
    }

    const measurementVars = measurementsOf(req);
    for (const measurement of measurementVars) {
      for (const dataItem of iter(get(measurement, 'data', []))) {
        const name = pyStr(item(dataItem, 'name'));
        const spiceCmd = item(dataItem, 'spice_command');
        const processed = processSpiceCommand(
          spiceCmd,
          design,
          compNets,
          measurement as Dict,
          req,
        );
        let analysisType: string;
        let cmdRest: string;
        if (processed.startsWith('op')) {
          analysisType = 'op';
          cmdRest = pythonStrip(processed.slice(2));
        } else {
          analysisType = sweepVars.length > 0 ? 'dc' : 'op';
          cmdRest = processed;
        }
        const quantity = get(measurement, 'quantity');

        if (analysisType === 'op') {
          if (quantity === 'voltage') {
            const netsSpec = get(measurement, 'nets');
            if (isTwoNetSpec(netsSpec)) {
              const [pos, neg] = diffNodes(design, compNets, netsSpec);
              lines.push(
                neg === '0'
                  ? `let ${name} = v(${pos})`
                  : `let ${name} = v(${pos}) - v(${neg})`,
              );
              lines.push(`print ${name}`);
            }
          } else if (quantity === 'current') {
            const component = get(measurement, 'component');
            if (truthy(component)) {
              const elem = elementNameForCurrent(design, component);
              lines.push(`let ${name} = i(${elem.toLowerCase()})`);
              lines.push(`print ${name}`);
            }
          }
          continue;
        }

        if (quantity === 'scalar') {
          if (cmdRest.startsWith('when') || cmdRest.startsWith('param')) {
            lines.push(`meas ${analysisType} ${name} ${cmdRest}`);
          } else if (SIMPLE.includes(cmdRest)) {
            const component = get(measurement, 'component');
            const index = componentsDict(design);
            let emitted = false;
            if (truthy(component) && has(index, keyText(component))) {
              const compType = get(index[keyText(component)], 'type');
              if (
                ['resistor', 'capacitor', 'inductor'].includes(
                  compType as string,
                )
              ) {
                if (compNets.has(keyText(component))) {
                  const nets = netsOf(compNets, component);
                  const node = or(
                    or(nets.get('pos'), nets.get('anode')),
                    nets.values().next().value,
                  );
                  if (truthy(node)) {
                    lines.push(
                      `meas ${analysisType} ${name} ${cmdRest} v(${pyStr(node)})`,
                    );
                    emitted = true;
                  }
                }
              }
            }
            if (!emitted) lines.push(`meas ${analysisType} ${name} ${cmdRest}`);
          } else {
            lines.push(`meas ${analysisType} ${name} ${cmdRest}`);
          }
          lines.push(`print ${name}`);
        } else if (quantity === 'voltage') {
          const netsSpec = get(measurement, 'nets');
          if (isTwoNetSpec(netsSpec)) {
            const [pos, neg] = diffNodes(design, compNets, netsSpec);
            let vExpr: string;
            if (neg !== '0') {
              vExpr = `${name}_diff`;
              lines.push(`let ${vExpr} = v(${pos}) - v(${neg})`);
            } else {
              vExpr = `v(${pos})`;
            }
            if (SIMPLE.includes(cmdRest))
              lines.push(`meas ${analysisType} ${name} ${cmdRest} ${vExpr}`);
            else if (cmdRest.startsWith('find'))
              lines.push(`meas ${analysisType} ${name} ${cmdRest}`);
            else if (cmdRest === 'param')
              lines.push(`meas ${analysisType} ${name} param ${vExpr}`);
            else if (cmdRest.startsWith('param '))
              lines.push(`meas ${analysisType} ${name} ${cmdRest}`);
            else lines.push(`meas ${analysisType} ${name} avg ${vExpr}`);
          } else {
            lines.push(`meas ${analysisType} ${name} ${cmdRest}`);
          }
          lines.push(`print ${name}`);
        } else if (quantity === 'current') {
          const component = get(measurement, 'component');
          if (truthy(component)) {
            const iExpr = `i(${elementNameForCurrent(design, component).toLowerCase()})`;
            if (SIMPLE.includes(cmdRest))
              lines.push(`meas ${analysisType} ${name} ${cmdRest} ${iExpr}`);
            else if (cmdRest.startsWith('find'))
              lines.push(`meas ${analysisType} ${name} ${cmdRest}`);
            else if (cmdRest === 'param')
              lines.push(`meas ${analysisType} ${name} param ${iExpr}`);
            else if (cmdRest.startsWith('param '))
              lines.push(`meas ${analysisType} ${name} ${cmdRest}`);
            else lines.push(`meas ${analysisType} ${name} avg ${iExpr}`);
          } else {
            lines.push(`meas ${analysisType} ${name} ${cmdRest}`);
          }
          lines.push(`print ${name}`);
        }
      }
    }

    for (const measurement of measurementVars) {
      const ref = get(measurement, 'ref');
      const plot = get(measurement, 'plot');
      if (!(
        truthy(ref) &&
        truthy(plot) &&
        isDict(plot) &&
        sweepVars.length > 0
      ))
        continue;
      try {
        const xAxis = get(plot, 'x_axis', 'time');
        let xExpr: string;
        if (
          typeof xAxis === 'string' &&
          xAxis.startsWith('[') &&
          xAxis.endsWith(']')
        ) {
          const xRef = xAxis.slice(1, -1);
          const xMeasurement = measurementVars.find(
            (m) => get(m, 'ref') === xRef,
          );
          xExpr = tokenToExpr(
            xRef,
            design,
            compNets,
            (xMeasurement as Dict | undefined) ?? {},
          );
        } else {
          xExpr = pyStr(xAxis);
        }
        let yExpr = tokenToExpr(ref, design, compNets, measurement as Dict);
        yExpr = extractLet(yExpr, lines);
        xExpr = extractLet(xExpr, lines);
        lines.push(
          `wrdata time_series/${reqKey}_${pyStr(ref)}.csv ${xExpr} ${yExpr}`,
        );
      } catch {
        // Python: `except Exception: pass`
      }
    }
  }
  lines.push('.endc');
  return lines.join('\n');
}

// ---------------------------------------------------------------- AC

function acSourceDefs(requirements: unknown[]): Map<string, Dict> {
  const defs = new Map<string, Dict>();
  for (const otherReq of requirements) {
    for (const envVar of iter(get(otherReq, 'environment', []))) {
      if (get(envVar, 'ref') !== 'ac_sources') continue;
      for (const [componentRef, config] of Object.entries(envVar as Dict)) {
        if (componentRef === 'ref' || componentRef === 'net') continue;
        if (!isDict(config)) {
          throw new PyError(
            'ValueError',
            'dictionary update sequence element #0 has length 1; 2 is required',
          );
        }
        defs.set(componentRef, { ...config, component: componentRef });
      }
    }
  }
  return defs;
}

export function generateAcControlBlock(
  design: Dict,
  compNets: CompNets,
): string {
  const lines = [
    '.control',
    'set noaskquit',
    'set nomoremode',
    'set numdgt=9',
    '',
  ];
  const analysisData = get(design, 'analysis', {});
  const requirements = sectionRequirements(get(analysisData, 'ac', {}));

  for (const req of requirements) {
    const [reqKey, heading] = requirementHeader(req, requirements, 'AC', 'AC');
    lines.push(heading);

    const environment = iter(get(req, 'environment', []));
    let frequency: unknown = {};
    for (const envVar of environment) {
      if (get(envVar, 'ref') === 'frequency_sweep') {
        frequency = envVar;
        break;
      }
    }
    if (!truthy(frequency)) frequency = {};

    // All AC source refs (computed by the core; kept for its error behaviour).
    for (const otherReq of requirements) {
      for (const envVar of iter(get(otherReq, 'environment', []))) {
        if (get(envVar, 'ref') === 'ac_sources') iter(envVar);
      }
    }

    const acSources: Dict[] = [];
    for (const envVar of environment) {
      if (get(envVar, 'ref') === 'ac_sources') {
        for (const [componentRef, config] of Object.entries(envVar as Dict)) {
          if (
            componentRef !== 'ref' &&
            componentRef !== 'net' &&
            isDict(config)
          ) {
            acSources.push({ ...config, component: componentRef });
          }
        }
        break;
      }
    }
    const active = new Map<string, unknown>();
    for (const source of acSources) {
      const component = get(source, 'component');
      if (truthy(component))
        active.set(keyText(component), get(source, 'magnitude', 0.1));
    }

    lines.push('* Configure AC source magnitudes and DC biases');
    const defs = acSourceDefs(requirements);
    for (const key of [...defs.keys()].sort()) {
      const def = defs.get(key) as Dict;
      const componentRef = get(def, 'component');
      const netSpec = get(def, 'net');
      const sourceType = get(def, 'type', 'voltage');
      if (!truthy(componentRef)) continue;
      const deviceName =
        sourceType === 'current'
          ? `${pyStr(sourceType)[0].toUpperCase()}${pyStr(componentRef)}`
          : `V${pyStr(componentRef)}`;
      const lookup =
        truthy(netSpec) && len(netSpec) === 2
          ? (netSpec as unknown[])[0]
          : componentRef;
      const original = truthy(lookup)
        ? get(componentsDict(design), keyText(lookup))
        : null;
      const nodeType = truthy(original)
        ? get(get(original, 'params', {}), 'node_type')
        : null;
      let dcBias: unknown;
      if (nodeType === 'voltage_source') {
        dcBias = get(
          def,
          'dc_bias',
          get(get(original, 'params', {}), 'voltage', 12.0),
        );
      } else if (nodeType === 'pwm_control') {
        dcBias = get(def, 'dc_bias', 3.0);
      } else {
        dcBias = get(def, 'dc_bias', 12.0);
      }
      lines.push(`alter ${deviceName} dc=${fmt(dcBias)}`);
      const ref = keyText(componentRef);
      lines.push(
        active.has(ref)
          ? `alter ${deviceName} acmag=${pyStr(active.get(ref))}`
          : `alter ${deviceName} acmag=0`,
      );
    }

    const start = get(frequency, 'start', 1n);
    const stop = get(frequency, 'stop', 1e6);
    const points = get(frequency, 'points_per_decade', 20n);
    lines.push(`ac dec ${pyStr(points)} ${pyStr(start)} ${pyStr(stop)}`);

    // Derived variables, emitted in dependency-depth order.
    const derivedVars = iter(get(req, 'derived', []));
    const derivedByRef = new Map<string, unknown>();
    for (const derived of derivedVars) {
      const ref = get(derived, 'ref');
      if (truthy(ref)) derivedByRef.set(keyText(ref), derived);
    }
    const deps = new Map<string, Set<string>>();
    for (const derived of derivedVars) {
      const ref = get(derived, 'ref', '');
      const cmd = get(derived, 'spice_command', '');
      if (truthy(ref)) {
        if (typeof cmd !== 'string')
          throw new PyError(
            'TypeError',
            'expected string or bytes-like object',
          );
        deps.set(
          keyText(ref),
          new Set(
            [...cmd.matchAll(/\{derived\.([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map(
              (m) => m[1],
            ),
          ),
        );
      }
    }
    const depthCache = new Map<string, number>();
    const depth = (ref: string, visited: Set<string>): number => {
      const cached = depthCache.get(ref);
      if (cached !== undefined) return cached;
      if (visited.has(ref)) return 0;
      visited.add(ref);
      let max = 0;
      for (const dep of deps.get(ref) ?? []) {
        if (derivedByRef.has(dep))
          max = Math.max(max, depth(dep, new Set(visited)) + 1);
      }
      depthCache.set(ref, max);
      return max;
    };
    for (const ref of derivedByRef.keys()) depth(ref, new Set());
    const sorted = [...derivedByRef.entries()].sort(
      (a, b) => (depthCache.get(a[0]) ?? 0) - (depthCache.get(b[0]) ?? 0),
    );
    for (const [ref, derived] of sorted) {
      const cmd = get(derived, 'spice_command');
      if (ref && truthy(cmd)) {
        lines.push(
          `let ${ref} = ${processSpiceCommand(cmd, design, compNets, {}, req)}`,
        );
      }
    }

    const measurementVars = measurementsOf(req);
    for (const measurement of measurementVars) {
      const measurementRef = get(measurement, 'ref', '');
      for (const dataItem of iter(get(measurement, 'data', []))) {
        const name = pyStr(item(dataItem, 'name'));
        let processed = processSpiceCommand(
          item(dataItem, 'spice_command'),
          design,
          compNets,
          measurement as Dict,
          req,
        );
        if (SIMPLE.includes(processed) && truthy(measurementRef)) {
          const quantity = get(measurement, 'quantity');
          if (quantity === 'voltage') {
            const netsSpec = get(measurement, 'nets');
            if (isTwoNetSpec(netsSpec)) {
              const [pos, neg] = diffNodes(design, compNets, netsSpec);
              let vExpr: string;
              if (neg !== '0') {
                vExpr = `${name}_diff`;
                lines.push(`let ${vExpr} = v(${pos}) - v(${neg})`);
              } else {
                vExpr = `v(${pos})`;
              }
              processed = `${processed} ${vExpr}`;
            }
          } else if (quantity === 'current') {
            const component = get(measurement, 'component');
            if (truthy(component)) {
              processed = `${processed} i(${elementNameForCurrent(design, component).toLowerCase()})`;
            }
          }
        }
        lines.push(`meas ac ${name} ${processed}`);
        lines.push(`print ${name}`);
      }
    }

    for (const measurement of measurementVars) {
      const ref = get(measurement, 'ref');
      const plot = get(measurement, 'plot');
      if (truthy(ref) && truthy(plot) && isDict(plot)) {
        try {
          const xExpr = pyStr(get(plot, 'x_axis', 'frequency'));
          const yExpr = extractLet(
            tokenToExpr(ref, design, compNets, measurement as Dict),
            lines,
          );
          lines.push(
            `wrdata time_series/${reqKey}_${pyStr(ref)}_mag.csv ${xExpr} mag(${yExpr})`,
          );
          lines.push(
            `wrdata time_series/${reqKey}_${pyStr(ref)}_phase.csv ${xExpr} phase(${yExpr})`,
          );
        } catch {
          // Python: `except Exception: pass`
        }
      } else if (truthy(ref) && pyEquals(plot, true)) {
        try {
          const expr = extractLet(
            tokenToExpr(ref, design, compNets, measurement as Dict),
            lines,
          );
          lines.push(
            `wrdata time_series/${reqKey}_${pyStr(ref)}_mag.csv frequency mag(${expr})`,
          );
          lines.push(
            `wrdata time_series/${reqKey}_${pyStr(ref)}_phase.csv frequency phase(${expr})`,
          );
        } catch {
          // Python: `except Exception: pass`
        }
      }
    }
  }
  lines.push('.endc');
  return lines.join('\n');
}

// ---------------------------------------------------------------- transient

const PHYSICAL = [
  'resistor',
  'capacitor',
  'inductor',
  'diode',
  'transistor',
  'mosfet',
  'igbt',
  'switch',
  'transformer',
  'ct_transformer',
  'dual_ct_transformer',
];
const CONTROL_TOKENS = [
  '_INT',
  '_FLT',
  '_CPA',
  '_CPB',
  '_CPC',
  '_DAMP',
  '_REFA',
  '_REFB',
  '_REFC',
  'VTRI',
  '_TRI',
  '_PWA',
  '_PWB',
  '_PWC',
  'B_ERR',
  'B_P',
  'B_SENSE',
  'R_IACT',
  'R_RAW_DUMMY',
  'R_DC_A',
  'R_DC_B',
  'R_DC_C',
  'R_ISO',
];

const AUTO_TELEMETRY_FILES = [
  'gate_',
  'v_m_',
  'v_r_',
  'v_c_',
  'v_l_',
  'v_rp',
  'v_d',
  'i_m_',
  'i_d',
];

/**
 * Nested resistors (RC snubbers, damping) inside a parent part: exports their
 * voltage so the Thermal stage computes V_rms^2/R from the waveform. R_ISO-style
 * ground anchors are simulation aids, not parts.
 */
function exportNestedResistors(
  comp: unknown,
  compNets: CompNets,
  uniqueRefs: ReadonlyMap<string, Dict>,
  lines: string[],
): void {
  for (const inner of iter(or(get(comp, 'internal', []), []))) {
    const iref = get(inner, 'ref');
    if (
      !truthy(iref) ||
      lower(pyStr(get(inner, 'type', ''))) !== 'resistor' ||
      uniqueRefs.has(keyText(iref))
    )
      continue;
    const refText = pyStr(iref);
    if (
      refText.toUpperCase().includes('R_ISO') ||
      lower(pyStr(get(inner, 'role', ''))).includes('anchor')
    )
      continue;
    const nets = netsOf(compNets, iref);
    const pos = nets.get('pos') ?? '0';
    const neg = nets.get('neg') ?? '0';
    if (pos === neg) continue;
    const vLet = `v_${refText}_auto`;
    if (pos === '0') lines.push(`let ${vLet} = 0 - v(${neg})`);
    else if (neg === '0') lines.push(`let ${vLet} = v(${pos})`);
    else lines.push(`let ${vLet} = v(${pos}) - v(${neg})`);
    lines.push(`wrdata time_series/V_${refText}.csv ${vLet}`);
  }
}

function calculateWindowTimes(
  winFrom: string | null,
  winTo: string | null,
  period: number,
  tStop: number,
): [string | null, string | null] {
  if (winFrom === null || winTo === null) return [null, null];
  const tStep = 300 * period;
  let from = winFrom;
  let to = winTo;
  if (from.includes('t_step + 200*Tsw')) from = fmt(tStep + 200 * period);
  else if (from.includes('t_step + 50*Tsw')) from = fmt(tStep + 50 * period);
  else if (from.includes('t_step')) from = fmt(tStep);
  else if (from.includes('0.8*t_stop')) from = fmt(0.8 * tStop);
  if (to.includes('t_step + 300*Tsw'))
    to = fmt(Math.min(tStep + 300 * period, tStop));
  else if (to.includes('t_step + 50*Tsw'))
    to = fmt(Math.min(tStep + 50 * period, tStop));
  else if (to.includes('t_stop')) to = fmt(tStop);
  if (from && to) {
    try {
      if (toFloat(from) >= toFloat(to)) {
        from = fmt(0.8 * tStop);
        to = fmt(tStop);
      }
    } catch {
      // Python: bare except
    }
  }
  return [from, to];
}

/** `wrdata` signal for a voltage measurement (differential via `let`). */
function voltageSignal(
  design: Dict,
  compNets: CompNets,
  measurement: Dict,
  ref: string,
  lines: string[],
  aliasRef: boolean,
): string {
  const netsSpec = get(measurement, 'nets');
  if (isTwoNetSpec(netsSpec)) {
    const [pos, neg] = diffNodes(design, compNets, netsSpec);
    if (neg !== '0') {
      const letVar = `${ref}_csv_diff`;
      lines.push(`let ${letVar} = v(${pos}) - v(${neg})`);
      if (aliasRef && ref !== letVar) lines.push(`let ${ref} = ${letVar}`);
      return letVar;
    }
    if (aliasRef) lines.push(`let ${ref} = v(${pos})`);
    return `v(${pos})`;
  }
  return extractLet(tokenToExpr(ref, design, compNets, measurement), lines);
}

export function generateTransientControlBlock(
  design: Dict,
  compNets: CompNets,
  pwmPeriod: number | null,
): string {
  const per = (pwmPeriod ?? detectPwmPeriod(design)) || 1e-5;
  let tstep: number = Math.max(
    per / PRINT_POINTS_PER_PERIOD,
    MIN_TSTEP_DEFAULT,
  );
  let maxstep: number = per / MAXSTEP_DIV;

  const analysisData = get(design, 'analysis', {});
  let transientData = get(analysisData, 'transient', {});
  if (Array.isArray(transientData))
    transientData = { requirements: transientData };
  const spiceSettings = get(transientData, 'spice_settings', {});
  for (const key of [
    'reltol',
    'abstol',
    'vntol',
    'chgtol',
    'gmin',
    'method',
    'maxord',
    'trtol',
  ]) {
    get(spiceSettings, key);
  }
  const defaultTstop = Math.max(1500 * per, 15e-3);
  const tstop = get(spiceSettings, 'tstop', defaultTstop);
  const useIc = get(spiceSettings, 'use_ic', true);

  const lines = [
    '.control',
    'set noaskquit',
    'set nomoremode',
    'set numdgt=9',
    'set hcopypscolor=1',
    'set color0=white',
    'set color1=black',
  ];
  for (const req of sectionRequirements(get(analysisData, 'ac', {}))) {
    for (const envVar of iter(get(req, 'environment', []))) {
      if (get(envVar, 'ref') === 'ac_sources') iter(envVar);
    }
  }
  lines.push('');

  const requirements = sectionRequirements(get(analysisData, 'transient', {}));
  const period = linePeriod(design);
  for (const req of requirements) {
    const [reqKey, heading] = requirementHeader(
      req,
      requirements,
      'Transient',
      'TRAN',
    );
    lines.push(heading);

    let reqTstop: unknown = tstop;
    for (const envVar of iter(or(get(req, 'environment', []), []))) {
      if (get(envVar, 'ref') !== 'time_domain') continue;
      // Values may carry SPICE suffixes ("30m", "1u"); unparsable ones keep the default.
      const envTstop = parseValue(or(get(envVar, 't_stop'), null));
      if (envTstop && envTstop > 0) reqTstop = envTstop;
      const envTstep = parseValue(
        or(get(envVar, 't_step'), get(envVar, 'step_size')),
      );
      if (envTstep && envTstep > 0) tstep = envTstep;
      const envMax = parseValue(
        or(
          or(get(envVar, 't_max_step'), get(envVar, 'max_step')),
          get(envVar, 'tmax'),
        ),
      );
      if (envMax && envMax > 0) maxstep = envMax;
      break;
    }

    const isDab = pyStr(get(design, 'id', ''))
      .toLowerCase()
      .includes('dual_active_bridge');
    const saveSetting = isDab
      ? null
      : or(
          or(
            get(spiceSettings, 'save'),
            isDict(transientData) ? get(transientData, 'save') : null,
          ),
          get(get(get(design, 'analysis', {}), 'spice_settings', {}), 'save'),
        );
    const first = pyEquals(req, requirements[0]);
    const deviceVecs: string[] = [];
    if (first) {
      for (const comp of iter(get(design, 'components', []))) {
        const vec = deviceCurrentVector(comp as Dict);
        if (vec) deviceVecs.push(vec);
      }
    }
    if (truthy(saveSetting)) {
      let saveStr = Array.isArray(saveSetting)
        ? saveSetting.map(pyStr).join(' ')
        : pyStr(saveSetting);
      if (deviceVecs.length) saveStr = `${saveStr} ${deviceVecs.join(' ')}`;
      lines.push(`save ${saveStr}`);
    } else if (deviceVecs.length) {
      lines.push(`save all ${deviceVecs.join(' ')}`);
    }

    const uic = truthy(useIc) ? 'uic' : '';
    lines.push(
      pythonStrip(
        `tran ${fmt(tstep)} ${fmt(reqTstop)} 0 ${fmt(maxstep)} ${uic}`,
      ),
    );
    lines.push('linearize');
    const plotStart = lines.length;

    const measurementVars = measurementsOf(req);
    for (const measurement of measurementVars) {
      for (const dataItem of iter(or(get(measurement, 'data', []), []))) {
        const name = pyStr(item(dataItem, 'name'));
        let processed = processSpiceCommand(
          item(dataItem, 'spice_command'),
          design,
          compNets,
          measurement as Dict,
          req,
        );
        for (const match of [...processed.matchAll(LET_MARKER_ALL)]) {
          lines.push(`let ${match[1]} = v(${match[2]}) - v(${match[3]})`);
          processed = replaceAll(processed, match[0], match[1]);
        }

        let cmdRest = processed;
        const mref = get(measurement, 'ref');
        if (SIMPLE.includes(processed) && truthy(mref)) {
          let expr: string;
          if (get(measurement, 'quantity') === 'voltage') {
            const netsSpec = get(measurement, 'nets');
            if (isTwoNetSpec(netsSpec)) {
              const [pos, neg] = diffNodes(design, compNets, netsSpec);
              if (neg !== '0') {
                expr = `${name}_diff`;
                lines.push(`let ${expr} = v(${pos}) - v(${neg})`);
              } else {
                expr = `v(${pos})`;
              }
            } else {
              expr = tokenToExpr(mref, design, compNets, measurement as Dict);
            }
          } else {
            expr = tokenToExpr(mref, design, compNets, measurement as Dict);
          }
          cmdRest = `${processed} ${expr}`;
        } else if (
          processed.startsWith('TRIG') ||
          processed.startsWith('FIND') ||
          processed.startsWith('find')
        ) {
          const diff = /v\(([^,]+),([^)]+)\)/.exec(processed);
          if (diff) {
            const letVar = `${name}_diff`;
            lines.push(
              `let ${letVar} = v(${pythonStrip(diff[1])}) - v(${pythonStrip(diff[2])})`,
            );
            cmdRest = processed.replace(/v\([^,]+,[^)]+\)/gi, () => letVar);
          }
        }

        let winFrom: string | null;
        let winTo: string | null;
        if (has(dataItem, 'from') && has(dataItem, 'to')) {
          winFrom = pyStr(get(dataItem, 'from'));
          winTo = pyStr(get(dataItem, 'to'));
        } else {
          [winFrom, winTo] = chooseWindowByCmd(cmdRest);
          [winFrom, winTo] = calculateWindowTimes(
            winFrom,
            winTo,
            per,
            toFloat(reqTstop),
          );
          [winFrom, winTo] = alignWindowToLineCycles(
            cmdRest,
            winFrom,
            winTo,
            period,
          );
        }
        lines.push(emitMeas(name, cmdRest, winFrom, winTo));
        lines.push(`print ${name}`);
      }
    }

    const uniqueRefs = new Map<string, Dict>();
    for (const measurement of measurementVars) {
      const ref = get(measurement, 'ref');
      if (truthy(ref) && !uniqueRefs.has(keyText(ref))) {
        uniqueRefs.set(keyText(ref), measurement as Dict);
      }
    }
    for (const ref of [...uniqueRefs.keys()].sort()) {
      const measurement = uniqueRefs.get(ref) as Dict;
      const plot = get(measurement, 'plot');
      if (!truthy(plot)) continue;
      try {
        if (isDict(plot)) {
          const xExpr = pyStr(get(plot, 'x_axis', 'time'));
          const yExpr =
            get(measurement, 'quantity') === 'voltage'
              ? voltageSignal(design, compNets, measurement, ref, lines, true)
              : tokenToExpr(ref, design, compNets, measurement);
          const file = `time_series/${reqKey}_${ref}.csv`;
          lines.push(
            xExpr.toLowerCase() === 'time'
              ? `wrdata ${file} ${yExpr}`
              : `wrdata ${file} ${xExpr} ${yExpr}`,
          );
        } else {
          const signal =
            get(measurement, 'quantity') === 'voltage'
              ? voltageSignal(design, compNets, measurement, ref, lines, false)
              : tokenToExpr(ref, design, compNets, measurement);
          if (
            signal.startsWith('v(') ||
            signal.startsWith('i(') ||
            signal.endsWith('_diff')
          ) {
            lines.push(`wrdata time_series/${reqKey}_${ref}.csv ${signal}`);
          }
        }
      } catch {
        // Python prints a warning and skips this trace.
      }
    }

    for (const comp of iter(get(design, 'components', []))) {
      const ref = get(comp, 'ref');
      if (!truthy(ref)) continue;
      const refText = pyStr(ref);
      const params = or(get(comp, 'params', {}), {}) as Dict;
      const ctype = lower(get(comp, 'type', ''));

      if (first && PHYSICAL.includes(ctype)) {
        const refUp = refText.toUpperCase();
        if (!CONTROL_TOKENS.some((token) => refUp.includes(token))) {
          if (uniqueRefs.has(keyText(ref))) continue;
          const nets = netsOf(compNets, ref);
          const pin = (name: string, dflt: string) => nets.get(name) ?? dflt;
          let posPin: string | null = null;
          let negPin: string | null = null;
          if (['resistor', 'capacitor', 'inductor'].includes(ctype)) {
            try {
              const pn = needPins(refText, nets, ['pos', 'neg'], ctype);
              posPin = pn.get('pos') ?? '0';
              negPin = pn.get('neg') ?? '0';
            } catch {
              posPin = pin('pos', '0');
              negPin = pin('neg', '0');
            }
          } else if (ctype === 'diode') {
            posPin = pin('anode', '0');
            negPin = pin('cathode', '0');
          } else if (['transistor', 'mosfet', 'igbt'].includes(ctype)) {
            posPin = nets.get('drain') ?? pin('collector', '0');
            negPin = nets.get('source') ?? pin('emitter', '0');
          } else if (ctype === 'switch') {
            posPin = pin('pos', '0');
            negPin = pin('neg', '0');
          } else if (
            ['transformer', 'ct_transformer', 'dual_ct_transformer'].includes(
              ctype,
            )
          ) {
            posPin = pin('P1', '0');
            negPin = pin('P2', '0');
          }

          if (posPin && negPin && (posPin !== '0' || negPin !== '0')) {
            const vLet = `v_${refText}_auto`;
            if (posPin === '0') lines.push(`let ${vLet} = 0 - v(${negPin})`);
            else if (negPin === '0') lines.push(`let ${vLet} = v(${posPin})`);
            else lines.push(`let ${vLet} = v(${posPin}) - v(${negPin})`);
            lines.push(`wrdata time_series/V_${refText}.csv ${vLet}`);

            const deviceVec = deviceCurrentVector(comp as Dict);
            if (deviceVec) {
              const iLet = `i_${refText}_auto`;
              lines.push(`let ${iLet} = ${deviceVec}`);
              lines.push(`wrdata time_series/I_${refText}.csv ${iLet}`);
            } else if (
              ['transformer', 'ct_transformer', 'dual_ct_transformer'].includes(
                ctype,
              )
            ) {
              if (get(params, 'sense') !== false) {
                const pri =
                  ctype === 'dual_ct_transformer'
                    ? `V${refText}_SENSE_PRI1`
                    : `V${refText}_SENSE_PRI`;
                const sec = ['ct_transformer', 'dual_ct_transformer'].includes(
                  ctype,
                )
                  ? `V${refText}_SENSE_SEC1`
                  : `V${refText}_SENSE_SEC`;
                lines.push(`wrdata time_series/I_${refText}_pri.csv i(${pri})`);
                lines.push(`wrdata time_series/I_${refText}_sec.csv i(${sec})`);
                lines.push(`wrdata time_series/I_${refText}.csv i(${pri})`);
              }
            } else if (get(params, 'sense') !== false) {
              lines.push(
                `wrdata time_series/I_${refText}.csv i(V${refText}_SENSE)`,
              );
            } else if (ctype === 'inductor') {
              lines.push(
                `wrdata time_series/I_${refText}.csv i(${spiceDevName('L', ref)})`,
              );
            }

            if (['transistor', 'mosfet', 'igbt'].includes(ctype)) {
              const gatePin = nets.get('gate') ?? pin('base', '0');
              if (gatePin !== '0') {
                const gLet = `v_${refText}_gate_auto`;
                lines.push(
                  negPin !== '0'
                    ? `let ${gLet} = v(${gatePin}) - v(${negPin})`
                    : `let ${gLet} = v(${gatePin})`,
                );
                lines.push(`wrdata time_series/Gate_${refText}.csv ${gLet}`);
              }
            } else if (ctype === 'switch') {
              const ctrlPos = pin('ctrl+', '0');
              const ctrlNeg = pin('ctrl-', '0');
              if (ctrlPos !== '0') {
                const gLet = `v_${refText}_gate_auto`;
                lines.push(
                  ctrlNeg !== '0'
                    ? `let ${gLet} = v(${ctrlPos}) - v(${ctrlNeg})`
                    : `let ${gLet} = v(${ctrlPos})`,
                );
                lines.push(`wrdata time_series/Gate_${refText}.csv ${gLet}`);
              }
            }
          }
        }
      }

      if (first) exportNestedResistors(comp, compNets, uniqueRefs, lines);

      const nodeType = get(params, 'node_type', '');
      if (
        !PHYSICAL.includes(ctype) &&
        (nodeType === 'pwm_control' ||
          ctype === 'pwm_control' ||
          refText.toUpperCase().startsWith('PWM'))
      ) {
        if (!uniqueRefs.has(keyText(ref))) {
          const nets = netsOf(compNets, ref);
          let posPin = or(
            or(nets.get('pos'), nets.get('output')),
            nets.get('+'),
          );
          let negPin = or(
            or(nets.get('neg'), nets.get('return')),
            nets.get('-'),
          );
          if (!truthy(posPin) && nets.size > 0)
            posPin = nets.values().next().value;
          if (!truthy(negPin)) negPin = '0';
          if (truthy(posPin)) {
            let sig: string;
            if (negPin !== '0') {
              sig = `${refText}_gate_diff`;
              lines.push(`let ${sig} = v(${posPin}) - v(${negPin})`);
            } else {
              sig = `v(${posPin})`;
            }
            lines.push(`wrdata time_series/Gate_${refText}.csv ${sig}`);
          }
        }
      }
    }

    for (const line of lines.slice(plotStart)) {
      const s = pythonStrip(line);
      if (!s.startsWith('wrdata ')) continue;
      const parts = splitWs(s);
      if (parts.length < 3) continue;
      // Internal component auto-telemetry gets no interactive plot command.
      const file = (parts[1].split(/[\\/]/).pop() ?? parts[1]).toLowerCase();
      if (AUTO_TELEMETRY_FILES.some((prefix) => file.startsWith(prefix)))
        continue;
      const signalStart =
        parts.length >= 4 &&
        ['time', 'frequency'].includes(parts[2].toLowerCase())
          ? 3
          : 2;
      const yExpr = parts.slice(signalStart).join(' ');
      if (!yExpr) continue;
      const base = parts[1].split(/[\\/]/).pop() ?? parts[1];
      const title = replaceAll(
        replaceAll(base, '.csv', ''),
        'time_series/',
        '',
      );
      lines.push(`plot ${yExpr} title '${title}'`);
    }
  }
  lines.push('.endc');
  return lines.join('\n');
}
