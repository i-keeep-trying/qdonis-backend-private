/**
 * Measurement command processing, ported from qdonis-core
 * `simulator/netlist_generator.py` (`_process_spice_command`,
 * `_token_to_expr`, `_choose_window_by_cmd`, `_emit_meas`).
 */

import { pythonStrip } from '../../common/python/python-json';
import {
  componentsDict,
  elementNameForCurrent,
  resolveVoltageNode,
  type CompNets,
} from './comp-nets';
import { pyEval } from './py-eval';
import {
  PyError,
  fmt,
  get,
  has,
  isDict,
  iter,
  len,
  pyEquals,
  pyStr,
  replaceAll,
  replaceFirst,
  splitWs,
  toFloat,
  truthy,
  type Dict,
} from './py';

const OPERATORS = ['*', '/', '+', '-'];
const WRAP_OPERATORS = ['*', '/', '^', '+'];

const hasAny = (text: string, ops: string[]) =>
  ops.some((op) => text.includes(op));

/** Measurement list of a requirement (new format, else under `variables`). */
export function measurementsOf(req: unknown): unknown[] {
  const direct = get(req, 'measurement', []);
  if (truthy(direct)) return iter(direct);
  return iter(get(get(req, 'variables', {}), 'measurement', []));
}

/** Requirement list of an analysis section (`{requirements: [...]}` or a bare list). */
export function requirementsOf(section: unknown): unknown[] {
  if (isDict(section) && has(section, 'requirements')) {
    return iter(section.requirements);
  }
  return Array.isArray(section) ? section : [];
}

/** Traverses dicts by key and lists by item `ref`. */
function getNestedValue(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (isDict(current)) {
      current = get(current, part);
    } else if (Array.isArray(current)) {
      const found: unknown = (current as unknown[]).find(
        (entry) => isDict(entry) && get(entry, 'ref') === part,
      );
      if (found === undefined) return null;
      current = found;
    } else {
      return null;
    }
    if (current === null || current === undefined) return null;
  }
  return current;
}

function resolveVariable(design: Dict, req: unknown, varPath: string): unknown {
  const parts = varPath.split('.');
  let value: unknown = null;
  if (parts[0] === 'criteria') {
    const criteria = get(req, 'criteria', {});
    if (parts.length === 2 && has(criteria, parts[1])) {
      value = get(criteria, parts[1]);
    }
  } else if (parts[0] === 'environment') {
    const environment = get(req, 'environment', []);
    if (parts.length >= 3) {
      for (const envVar of iter(environment)) {
        if (get(envVar, 'ref') === parts[1]) {
          value = getNestedValue(envVar, parts.slice(2).join('.'));
          break;
        }
      }
    }
  } else if (parts[0] === 'components' && parts.length === 3) {
    const comp = get(componentsDict(design), parts[1]);
    if (truthy(comp)) value = get(get(comp, 'params', {}), parts[2]);
  }
  return value ?? null;
}

const BRACKET = /\[([^\]]+)\]/g;
const DOUBLE_BRACE = /\{\{((?:[^{}]|\{[^}]*\})*)\}\}/;
const INNER_BRACE = /\{([^{}]+)\}/g;
const SINGLE_BRACE = /\{([^{}]+)\}/;

/** Period of the first PWM node with a usable frequency (for `Tsw`). */
function tswText(design: Dict, expression: string): string {
  for (const comp of iter(get(design, 'components', []))) {
    const params = get(comp, 'params', {});
    if (get(params, 'node_type') === 'pwm_control') {
      const frequency = get(params, 'frequency', 100e3);
      if (truthy(frequency)) {
        try {
          const f = toFloat(frequency);
          if (f > 0) return replaceAll(expression, 'Tsw', pyStr(1 / f));
        } catch {
          // ValueError / TypeError: keep looking
        }
      }
    }
  }
  return expression;
}

/**
 * `_process_spice_command`: `[REF]` -> probe expression, `{criteria.x}` /
 * `{environment...}` / `{components.R1.resistance}` -> value, `{{...}}` and
 * `{a*b}` -> evaluated arithmetic.
 */
export function processSpiceCommand(
  spiceCmd: unknown,
  design: Dict,
  compNets: CompNets,
  _aspect: Dict,
  req: unknown,
): string {
  if (typeof spiceCmd !== 'string') {
    throw new PyError('TypeError', 'expected string or bytes-like object');
  }
  let result = spiceCmd;
  const measurementVars = () => {
    const direct = get(req, 'measurement', []);
    return truthy(direct)
      ? iter(direct)
      : iter(get(get(req, 'variables', {}), 'measurement', []));
  };

  for (const match of [...result.matchAll(BRACKET)]) {
    const refVar = match[1];
    if (refVar.includes('.')) {
      const dot = refVar.indexOf('.');
      const measurementRef = refVar.slice(0, dot);
      const measurementName = refVar.slice(dot + 1);
      for (const measurement of measurementVars()) {
        if (get(measurement, 'ref') === measurementRef) {
          result = replaceFirst(result, match[0], measurementName);
          break;
        }
      }
      continue;
    }
    let found = false;
    for (const measurement of measurementVars()) {
      if (get(measurement, 'ref') === refVar) {
        const expr = tokenToExpr(refVar, design, compNets, measurement as Dict);
        result = replaceFirst(result, match[0], expr);
        found = true;
        break;
      }
    }
    if (!found) {
      outer: for (const measurement of measurementVars()) {
        for (const dataItem of iter(get(measurement, 'data', []))) {
          if (get(dataItem, 'name') === refVar) {
            const expr = tokenToExpr(
              refVar,
              design,
              compNets,
              measurement as Dict,
            );
            result = replaceFirst(result, match[0], expr);
            found = true;
            break outer;
          }
        }
      }
    }
    if (!found) {
      const analysisData = get(design, 'analysis', {});
      if (!isDict(analysisData)) {
        throw new PyError('AttributeError', "object has no attribute 'items'");
      }
      search: for (const section of Object.values(analysisData)) {
        for (const otherReq of requirementsOf(section)) {
          if (!pyEquals(otherReq, req)) {
            let others = get(otherReq, 'measurement', []);
            if (!truthy(others)) {
              others = get(get(otherReq, 'variables', {}), 'measurement', []);
            }
            for (const measurement of iter(others)) {
              if (get(measurement, 'ref') === refVar) {
                const expr = tokenToExpr(
                  refVar,
                  design,
                  compNets,
                  measurement as Dict,
                );
                result = replaceFirst(result, match[0], expr);
                found = true;
                break;
              }
            }
            if (!found) {
              dataSearch: for (const measurement of iter(others)) {
                for (const dataItem of iter(get(measurement, 'data', []))) {
                  if (get(dataItem, 'name') === refVar) {
                    const expr = tokenToExpr(
                      refVar,
                      design,
                      compNets,
                      measurement as Dict,
                    );
                    result = replaceFirst(result, match[0], expr);
                    found = true;
                    break dataSearch;
                  }
                }
              }
            }
          }
          if (found) break search;
        }
      }
    }
  }

  let iteration = 0;
  while (result.includes('{') && iteration < 40) {
    iteration += 1;
    let madeReplacement = false;
    const doubleMatch = DOUBLE_BRACE.exec(result);
    if (doubleMatch) {
      const expression = doubleMatch[1];
      try {
        let evalExpr = expression;
        for (const varMatch of [...expression.matchAll(INNER_BRACE)]) {
          const value = resolveVariable(design, req, varMatch[1]);
          if (value !== null)
            evalExpr = replaceAll(evalExpr, varMatch[0], pyStr(value));
        }
        if (!/\{([^{}]+)\}/.test(expression)) {
          const value = resolveVariable(design, req, expression);
          if (value !== null) evalExpr = pyStr(value);
        }
        let clean = pythonStrip(evalExpr);
        if (hasAny(clean, OPERATORS)) {
          clean = tswText(design, clean);
          try {
            result = replaceAll(result, doubleMatch[0], pyStr(pyEval(clean)));
          } catch {
            result = replaceAll(result, doubleMatch[0], clean);
          }
          madeReplacement = true;
        } else {
          result = replaceAll(result, doubleMatch[0], clean);
          madeReplacement = true;
        }
      } catch {
        // Python prints a warning and leaves the expression.
      }
    } else {
      const singleMatch = SINGLE_BRACE.exec(result);
      if (!singleMatch) break;
      const expression = singleMatch[1];
      try {
        const value = resolveVariable(design, req, expression);
        if (value !== null) {
          result = replaceAll(result, singleMatch[0], pyStr(value));
          madeReplacement = true;
        } else if (hasAny(expression, OPERATORS)) {
          try {
            result = replaceAll(
              result,
              singleMatch[0],
              pyStr(pyEval(expression)),
            );
            madeReplacement = true;
          } catch {
            // Python prints a warning and leaves the expression.
          }
        }
      } catch {
        // Python prints a warning and leaves the expression.
      }
    }
    if (!madeReplacement) break;
  }
  return result;
}

/** Marker for a differential probe the caller turns into a `let`. */
export const LET_MARKER = /__LET__([^|]+)\|([^|]+)\|([^|]+?)__LET__/;
export const LET_MARKER_ALL = /__LET__([^|]+)\|([^|]+)\|([^|]+?)__LET__/g;

/** `_token_to_expr`: a measurement token as an ngspice expression. */
export function tokenToExpr(
  tokenValue: unknown,
  design: Dict,
  compNets: CompNets,
  aspect: Dict | null = null,
): string {
  const token = pyStr(tokenValue);
  for (const reqCheck of iter(get(design, 'evaluation', []))) {
    for (const envVar of iter(get(reqCheck, 'environment', []))) {
      if (get(envVar, 'ref') === token) return token;
    }
  }
  for (const req of iter(get(design, 'evaluation', []))) {
    if (has(get(req, 'criteria', {}), token)) return token;
  }

  if (aspect && truthy(aspect) && token === get(aspect, 'ref')) {
    const quantity = get(aspect, 'quantity');
    const component = get(aspect, 'component');
    if (quantity === 'voltage') {
      const netsSpec = get(aspect, 'nets');
      if (truthy(netsSpec) && len(netsSpec) === 2) {
        const spec = netsSpec as unknown[][];
        const posNode = resolveVoltageNode(
          design,
          compNets,
          spec[0][0],
          spec[0][1],
        );
        const negNode = resolveVoltageNode(
          design,
          compNets,
          spec[1][0],
          spec[1][1],
        );
        if (negNode === '0') return `v(${posNode})`;
        const ref = pyStr(get(aspect, 'ref', 'measurement'));
        return `__LET__${ref}_diff|${posNode}|${negNode}__LET__`;
      }
    } else if (quantity === 'current') {
      if (truthy(component)) {
        return `i(${elementNameForCurrent(design, component).toLowerCase()})`;
      }
      return `i(${elementNameForCurrent(design, truthy(component) ? component : token)})`;
    }
  }

  let result = token;
  const index = componentsDict(design);

  for (const match of [...result.matchAll(/v\(([^)]+)\)/g)]) {
    const compRef = match[1];
    if (!has(index, compRef)) continue;
    const ctype = get(index[compRef], 'type');
    let replacement: string;
    if (ctype === 'diode') {
      const anode = resolveVoltageNode(design, compNets, compRef, 'anode');
      const cathode = resolveVoltageNode(design, compNets, compRef, 'cathode');
      replacement = `v(${anode},${cathode})`;
    } else if (ctype === 'transistor') {
      const collector = resolveVoltageNode(
        design,
        compNets,
        compRef,
        'collector',
      );
      replacement = `v(${collector},n_${compRef}_esense)`;
    } else if (ctype === 'node') {
      replacement = `v(${resolveVoltageNode(design, compNets, compRef, '')})`;
    } else {
      continue;
    }
    result = replaceAll(result, match[0], replacement);
  }

  for (const match of [...result.matchAll(/i\(([^)]+)\)/g)]) {
    const compRef = match[1];
    if (!has(index, compRef)) continue;
    const compData = index[compRef];
    let elem: string;
    if (get(compData, 'type') === 'capacitor' && result.includes('esr(')) {
      const esr = toFloat(get(get(compData, 'params', {}), 'esr', 0.0));
      elem = esr > 0 ? `R${compRef}_ESR` : `C${compRef}`;
    } else {
      elem = elementNameForCurrent(design, compRef);
    }
    result = replaceAll(result, match[0], `i(${elem})`);
  }

  for (const match of [
    ...result.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\(([^)]+)\)/g),
  ]) {
    const paramName = match[1];
    const compRef = match[2];
    if (
      ['v', 'i', 'max', 'min', 'avg', 'rms', 'pp'].includes(
        paramName.toLowerCase(),
      )
    ) {
      continue;
    }
    if (has(index, compRef)) {
      const params = get(index[compRef], 'params', {});
      if (has(params, paramName)) {
        result = replaceAll(result, match[0], fmt(get(params, paramName)));
      }
    }
  }

  const stripped = pythonStrip(result);
  if (
    hasAny(result, WRAP_OPERATORS) &&
    !stripped.startsWith('(') &&
    !stripped.endsWith(')')
  ) {
    result = `(${result})`;
  }
  return result;
}

const firstWord = (text: string): string => {
  const words = splitWs(pythonStrip(text));
  if (words.length === 0)
    throw new PyError('IndexError', 'list index out of range');
  return words[0].toUpperCase();
};

/** `_choose_window_by_cmd`: steady-state window unless the command sets its own. */
export function chooseWindowByCmd(
  spiceCommand: string,
): [string | null, string | null] {
  const cmd = firstWord(spiceCommand);
  if (['TRIG', 'PARAM', 'FIND'].includes(cmd)) return [null, null];
  return ['0.8*t_stop', 't_stop'];
}

/** `_emit_meas` (always called without expressions). */
export function emitMeas(
  name: string,
  spiceCmd: string,
  winFrom: string | null,
  winTo: string | null,
): string {
  firstWord(spiceCmd);
  let filled = spiceCmd;
  if (winFrom && winTo) filled = `${filled} from=${winFrom} to=${winTo}`;
  return `meas tran ${name} ${filled}`;
}
