/**
 * Simulation result structuring and feasibility, port of qdonis-core
 * `NgspiceMeasurePlotter.structure_simulation_results`,
 * `_analyze_formula_depths`, `_substitute_formula_variables`,
 * `_recover_trig_targ_measurement` and `embed_feasibility_in_results`.
 *
 * Values keep Python types (int = bigint, float = number) until the API
 * serialises them.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  PyError,
  get,
  has,
  isDict,
  item,
  iter,
  pyStr,
  toFloat,
  truthy,
  type Dict,
} from '../netlist/py';
import {
  RESULT_CONSTANTS,
  RESULT_FUNCTIONS,
  pyEvalWith,
} from '../netlist/py-eval';
import { pairwiseSum, pyMax0, pySum } from '../numeric/numpy';
import { readWhitespaceTable } from '../numeric/pandas-float';

const FUNCTION_NAMES = new Set([
  'abs',
  'max',
  'min',
  'pow',
  'sqrt',
  'sin',
  'cos',
  'tan',
  'log',
  'log10',
  'exp',
  'pi',
  'e',
]);

type Context = Map<string, unknown>;

/** `var_context[key]` exact, then the first case-insensitive match. */
function lookup(context: Context, name: string): unknown {
  if (context.has(name)) return context.get(name);
  const lower = name.toLowerCase();
  for (const [key, value] of context) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

const isUpperInitial = (part: string) =>
  part.length > 0 &&
  part[0] !== part[0].toLowerCase() &&
  part[0] === part[0].toUpperCase();

/** `_find_csv_for_measurement`: CSV whose trailing UPPER_CASE stem matches. */
function findCsvForMeasurement(name: string, outputDir: string): string | null {
  const dir = join(outputDir, 'time_series');
  if (!existsSync(dir)) return null;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.csv')) continue;
    const parts = file.slice(0, -4).split('_');
    const ref: string[] = [];
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (isUpperInitial(parts[i])) ref.unshift(parts[i]);
      else break;
    }
    if (ref.length && ref.join('_').toUpperCase() === name.toUpperCase())
      return join(dir, file);
  }
  return null;
}

/** pandas `Series.mean()` (skips NaN). */
function nanMean(values: number[]): number {
  const count = values.filter((v) => !Number.isNaN(v)).length;
  if (count === 0) return Number.NaN;
  // nanops.nanmean: pairwise sum of NaN-filled values / non-NaN count
  const filled = values.map((v) => (Number.isNaN(v) ? 0 : v));
  return pairwiseSum(filled) / count;
}

/** `_recover_trig_targ_measurement`: 90 % crossing time of the referenced signal. */
function recoverTrigTarg(
  name: string,
  outputDir: string | null,
  yamlData: unknown,
): number | null {
  try {
    if (!outputDir || !truthy(yamlData)) return null;
    let spiceCommand: string | null = null;
    let bracketRef: string | null = null;
    const analysis = get(yamlData, 'analysis', {});
    search: for (const kind of ['dc', 'ac', 'transient']) {
      if (!has(analysis, kind)) continue;
      const section = item(analysis, kind);
      const requirements = isDict(section)
        ? get(section, 'requirements', [])
        : section;
      for (const req of iter(requirements)) {
        for (const meas of iter(get(req, 'measurement', []))) {
          for (const dataItem of iter(get(meas, 'data', []))) {
            if (get(dataItem, 'name') === name) {
              spiceCommand = pyStr(get(dataItem, 'spice_command', ''));
              const refs = [
                ...spiceCommand.matchAll(/\[([a-zA-Z_][a-zA-Z0-9_]*)\]/g),
              ];
              if (refs.length) bracketRef = refs[0][1];
              break;
            }
          }
          if (spiceCommand && bracketRef) break search;
        }
      }
    }
    if (!spiceCommand || !bracketRef) return null;
    const csv = findCsvForMeasurement(bracketRef, outputDir);
    if (!csv || !existsSync(csv)) return null;
    const columns = readWhitespaceTable(readFileSync(csv, 'utf8'));
    if (columns.length < 2) return null;
    const time = columns[columns.length - 2];
    const signal = columns[columns.length - 1];
    const steady = nanMean(signal.slice(Math.trunc(signal.length * 0.8)));
    const target = steady * 0.9;
    const crossing = signal.findIndex((v) =>
      steady < 0 ? v <= target : v >= target,
    );
    if (crossing >= 0) return time[crossing];
    let best = -1;
    for (let i = 0; i < signal.length; i += 1) {
      const d = Math.abs(signal[i] - target);
      if (Number.isNaN(d)) continue;
      if (best < 0 || d < Math.abs(signal[best] - target)) best = i;
    }
    if (best < 0) return null;
    return time[best];
  } catch {
    return null;
  }
}

export interface FormulaContext {
  outputDir: string | null;
  yamlData: unknown;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `_substitute_formula_variables`. */
export function substituteFormulaVariables(
  formula: string,
  context: Context,
  env: FormulaContext,
): string {
  let evalFormula = formula;
  for (const match of [...formula.matchAll(/\[([^\]]+)\]/g)]) {
    const name = match[1];
    let value = lookup(context, name);
    if (value === null || value === undefined) {
      const recovered = recoverTrigTarg(name, env.outputDir, env.yamlData);
      if (recovered !== null && recovered !== undefined) {
        value = recovered;
        context.set(name, value);
      }
    }
    if (value === null || value === undefined) {
      throw new PyError(
        'ValueError',
        `Raw measurement '${name}' not found in context (recovery failed)`,
      );
    }
    evalFormula = evalFormula.split(match[0]).join(pyStr(value));
  }

  let iteration = 0;
  while (evalFormula.includes('{') && iteration < 100) {
    iteration += 1;
    const match = /\{([^{}]+)\}/.exec(evalFormula);
    if (!match) break;
    const content = match[1].trim();
    if (!context.has(content)) {
      throw new PyError(
        'ValueError',
        `Variable '${content}' not found in context`,
      );
    }
    const at = evalFormula.indexOf(match[0]);
    evalFormula =
      evalFormula.slice(0, at) +
      pyStr(context.get(content)) +
      evalFormula.slice(at + match[0].length);
  }

  for (const match of [
    ...evalFormula.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g),
  ]) {
    const name = match[0];
    if (!FUNCTION_NAMES.has(name) && context.has(name)) {
      const text = pyStr(context.get(name));
      evalFormula = evalFormula.replace(
        new RegExp(`\\b${escapeRe(name)}\\b`, 'g'),
        () => text,
      );
    }
  }
  return evalFormula;
}

/** Python `eval` with the result builtins and the variable context. */
function evaluate(expression: string, context: Context): unknown {
  const names: Record<string, unknown> = { ...RESULT_CONSTANTS };
  const functions = { ...RESULT_FUNCTIONS };
  for (const [key, value] of context) {
    if (Object.hasOwn(functions, key)) delete functions[key];
    names[key] = value;
  }
  return pyEvalWith(expression, { functions, names });
}

/** `_analyze_formula_depths`: outputs grouped by dependency depth. */
function analyzeFormulaDepths(outputs: unknown[]): Map<number, Dict[]> {
  const groups = new Map<number, Dict[]>();
  const byName = new Map<unknown, Dict>();
  for (const output of outputs) byName.set(get(output, 'var'), output as Dict);
  const cache = new Map<string, number>();
  const depthOf = (
    name: string,
    formula: string,
    visited: Set<string>,
  ): number => {
    if (visited.has(name)) return 0;
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    visited.add(name);
    let max = 0;
    for (const m of formula.matchAll(/\[([^\]]+)\]/g)) {
      const dep = m[1];
      if (byName.has(dep)) {
        max = Math.max(
          max,
          depthOf(
            dep,
            pyStr(get(byName.get(dep), 'formula', '')),
            new Set(visited),
          ) + 1,
        );
      }
    }
    const bare = formula.replace(/\[[^\]]+\]/g, '').replace(/\{[^}]+\}/g, '');
    for (const m of bare.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g)) {
      const dep = m[0];
      if (FUNCTION_NAMES.has(dep)) continue;
      if (byName.has(dep)) {
        max = Math.max(
          max,
          depthOf(
            dep,
            pyStr(get(byName.get(dep), 'formula', '')),
            new Set(visited),
          ) + 1,
        );
      }
    }
    visited.delete(name);
    cache.set(name, max);
    return max;
  };
  for (const output of outputs) {
    const name = get(output, 'var');
    const formula = get(output, 'formula', '');
    if (truthy(name) && truthy(formula)) {
      if (typeof formula !== 'string')
        throw new PyError('TypeError', 'expected string or bytes-like object');
      const depth = depthOf(pyStr(name), formula, new Set());
      if (!groups.has(depth)) groups.set(depth, []);
      groups.get(depth)?.push(output as Dict);
    }
  }
  return groups;
}

const requirementsOf = (section: unknown): unknown[] =>
  isDict(section) && has(section, 'requirements')
    ? iter(section.requirements)
    : Array.isArray(section)
      ? section
      : [];

/** `structure_simulation_results`. */
export function structureSimulationResults(
  measurements: Map<string, number>,
  yamlData: unknown,
  analysisFilter: string[] | null,
  env: FormulaContext,
): Dict {
  const filter = analysisFilter
    ? analysisFilter.map((a) => a.toLowerCase())
    : null;
  const structured: Dict = {};
  for (const kind of filter ?? ['dc', 'ac', 'transient']) structured[kind] = {};

  if (!(truthy(yamlData) && has(yamlData, 'analysis'))) {
    (structured.dc as Dict) = (structured.dc as Dict) ?? {};
    (structured.dc as Dict).requirement_1 = {
      title: 'Unknown requirements (no YAML file provided)',
      outputs: Object.fromEntries(measurements),
      parameters: {},
    };
    return structured;
  }
  const analysis = item(yamlData, 'analysis');
  if (!isDict(analysis)) return structured;

  const globalCriteria = new Map<string, unknown>();
  const allRequirements: unknown[] = [];
  for (const section of Object.values(analysis))
    allRequirements.push(...requirementsOf(section));
  for (const req of allRequirements) {
    const criteria = get(req, 'criteria', {});
    if (!isDict(criteria))
      throw new PyError('AttributeError', "object has no attribute 'items'");
    for (const [key, value] of Object.entries(criteria)) {
      if (isDict(value)) {
        for (const [sub, subValue] of Object.entries(value))
          globalCriteria.set(`${key}.${sub}`, subValue);
      } else globalCriteria.set(key, value);
    }
  }

  const components = has(yamlData, 'components')
    ? iter(item(yamlData, 'components'))
    : [];
  for (const [kind, section] of Object.entries(analysis)) {
    if (filter && !filter.includes(kind.toLowerCase())) continue;
    if (!['dc', 'ac', 'transient'].includes(kind)) continue;
    const bucket = structured[kind] as Dict;
    const requirements = requirementsOf(section);
    for (const req of requirements) {
      const rid = get(req, 'rid');
      const reqKey = truthy(rid)
        ? pyStr(rid)
        : `requirement_${requirements.findIndex((r) => r === req) + 1}`;
      const entry: Dict = {
        title: get(req, 'requirement', `Requirement ${reqKey}`),
        outputs: {},
        parameters: {},
        measurement: {},
      };
      bucket[reqKey] = entry;
      const outputsOut = entry.outputs as Dict;

      for (const optVar of iter(get(req, 'optimisation', []))) {
        const ref = get(optVar, 'ref');
        let compParams: unknown = {};
        for (const comp of components) {
          if (get(comp, 'ref') === ref) {
            compParams = get(comp, 'params', {});
            break;
          }
        }
        const toNumber = (value: unknown) => {
          if (
            ['string', 'number', 'bigint', 'boolean'].includes(typeof value)
          ) {
            try {
              return toFloat(value);
            } catch {
              return value;
            }
          }
          return value;
        };
        for (const param of iter(get(optVar, 'parameters', []))) {
          if (typeof param === 'string') {
            (entry.parameters as Dict)[`${pyStr(ref)}.${param}`] = toNumber(
              get(compParams, param, null),
            );
          } else if (isDict(param)) {
            for (const [key, value] of Object.entries(param)) {
              const paramKey = `${pyStr(ref)}.${key}`;
              if (typeof value === 'string' && value.startsWith('implied by')) {
                (entry.parameters as Dict)[paramKey] = value;
              } else {
                (entry.parameters as Dict)[paramKey] = toNumber(
                  get(compParams, key, value),
                );
              }
            }
          }
        }
      }

      const outputs = get(req, 'outputs', []);
      if (truthy(outputs)) {
        const context: Context = new Map(measurements);
        for (const [key, value] of globalCriteria) context.set(key, value);
        for (const [key, value] of globalCriteria)
          context.set(`criteria.${key}`, value);
        for (const envVar of iter(get(req, 'environment', []))) {
          if (!isDict(envVar)) continue;
          const envRef = get(envVar, 'ref');
          if (!truthy(envRef)) continue;
          for (const [key, value] of Object.entries(envVar)) {
            if (key !== 'ref')
              context.set(`environment.${pyStr(envRef)}.${key}`, value);
          }
        }
        for (const comp of components) {
          const compRef = pyStr(get(comp, 'ref'));
          const params = get(comp, 'params', {});
          if (!isDict(params))
            throw new PyError(
              'AttributeError',
              "object has no attribute 'items'",
            );
          for (const [name, value] of Object.entries(params)) {
            context.set(`${compRef}.${name}`, value);
            context.set(`components.${compRef}.${name}`, value);
          }
        }
        for (const measConfig of iter(get(req, 'measurement', []))) {
          if (!isDict(measConfig)) continue;
          for (const dataItem of iter(get(measConfig, 'data', []))) {
            if (!isDict(dataItem)) continue;
            const measName = get(dataItem, 'name');
            if (!truthy(measName)) continue;
            const name = pyStr(measName);
            let found: number | null = measurements.has(name)
              ? (measurements.get(name) as number)
              : null;
            if (found === null) {
              for (const [raw, value] of measurements) {
                if (raw.toLowerCase() === name.toLowerCase()) {
                  found = value;
                  break;
                }
              }
            }
            if (found !== null) {
              context.set(name, found);
              (entry.measurement as Dict)[name] = found;
            }
          }
        }

        const groups = analyzeFormulaDepths(iter(outputs));
        for (const depth of [...groups.keys()].sort((a, b) => a - b)) {
          for (const output of groups.get(depth) ?? []) {
            const varName = get(output, 'var');
            const formula = get(output, 'formula');
            const description = get(output, 'description', '');
            if (!(truthy(varName) && truthy(formula))) continue;
            const key = pyStr(varName);
            const store = (value: unknown) => {
              outputsOut[key] = truthy(description)
                ? { value, description }
                : value;
              context.set(key, value);
            };
            try {
              if (typeof formula !== 'string')
                throw new PyError('AttributeError', 'no startswith');
              if (
                formula.startsWith('[') &&
                formula.endsWith(']') &&
                formula.split('[').length - 1 === 1
              ) {
                const result = lookup(context, formula.slice(1, -1));
                if (result !== null && result !== undefined) store(result);
                else outputsOut[key] = null;
                continue;
              }
              const expr = substituteFormulaVariables(formula, context, env);
              try {
                store(evaluate(expr, context));
              } catch {
                outputsOut[key] = null;
              }
            } catch {
              outputsOut[key] = null;
            }
          }
        }
      }

      for (const [name, value] of measurements) {
        const lower = name.toLowerCase();
        if (
          (lower.startsWith('v_') || lower.startsWith('i_')) &&
          (lower.includes('_peak') || lower.includes('_rms'))
        ) {
          if (!Object.hasOwn(outputsOut, name)) {
            const parts = name.split('_');
            const comp =
              parts.length >= 3
                ? parts.slice(1, -1).join('_').toUpperCase()
                : name.toUpperCase();
            outputsOut[name] = {
              value,
              description: `${comp} ${lower.includes('_peak') ? 'Peak' : 'RMS'} ${lower.startsWith('v_') ? 'Voltage' : 'Current'} (Auto)`,
            };
          }
        }
      }
    }
  }
  return structured;
}

// ------------------------------------------------------------- feasibility

interface Constraint {
  constraint_id: unknown;
  status: string;
  residual: number;
  target_value: unknown;
  actual_value: unknown;
  description: string;
}

const RESIDUAL_EVAL = (expr: string): unknown =>
  pyEvalWith(expr, {
    functions: RESULT_FUNCTIONS,
    names: { ...RESULT_CONSTANTS },
  });

function constraintContext(req: unknown, reqResults: unknown): Context {
  const context: Context = new Map();
  const rid = pyStr(get(req, 'rid', ''));
  for (const [name, data] of Object.entries(
    (get(reqResults, 'measurement', {}) ?? {}) as Dict,
  )) {
    context.set(name, data);
    context.set(`${rid}.measurement.${name}`, data);
  }
  for (const [name, data] of Object.entries(
    (get(reqResults, 'outputs', {}) ?? {}) as Dict,
  )) {
    const value = isDict(data) && has(data, 'value') ? data.value : data;
    context.set(name, value);
    context.set(`${rid}.outputs.${name}`, value);
  }
  for (const [key, value] of Object.entries(
    (get(req, 'criteria', {}) ?? {}) as Dict,
  )) {
    context.set(`criteria.${key}`, value);
    context.set(`${rid}.criteria.${key}`, value);
  }
  return context;
}

function evaluateConstraint(
  config: unknown,
  req: unknown,
  reqResults: unknown,
  env: FormulaContext,
): Constraint {
  const id = item(config, 'id');
  const fail = (status: string, description: string): Constraint => ({
    constraint_id: id,
    status,
    residual: 0,
    target_value: null,
    actual_value: null,
    description,
  });
  try {
    if (!(has(config, 'target') && has(config, 'actual'))) {
      return fail(
        'error',
        `Constraint ${pyStr(id)} missing target/actual fields`,
      );
    }
    const context = constraintContext(req, reqResults);
    const targetExpr = pyStr(get(config, 'target'));
    const actualExpr = pyStr(get(config, 'actual'));
    const operator = get(config, 'operator', '<=');
    const target = Number(
      RESIDUAL_EVAL(substituteFormulaVariables(targetExpr, context, env)),
    );
    const actual = Number(
      RESIDUAL_EVAL(substituteFormulaVariables(actualExpr, context, env)),
    );
    let residual: number;
    if (operator === '<=') residual = actual - target;
    else if (operator === '>=') residual = target - actual;
    else
      throw new PyError(
        'ValueError',
        `Unsupported operator: ${pyStr(operator)}`,
      );
    if (!Number.isFinite(residual))
      return fail('error', `Invalid numerical result: ${residual}`);
    return {
      constraint_id: id,
      status: residual <= 0 ? 'pass' : 'fail',
      residual,
      target_value: target,
      actual_value: actual,
      description: `Constraint ${pyStr(id)}: ${pyStr(actual)} ${pyStr(operator)} ${pyStr(target)}`,
    };
  } catch (error) {
    return fail(
      'error',
      `Error evaluating constraint ${pyStr(id)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `embed_feasibility_in_results`: per-analysis feasibility block. */
export function embedFeasibility(
  structured: Dict,
  yamlData: unknown,
  analysisFilter: string[] | null,
  env: FormulaContext,
): void {
  if (!(truthy(yamlData) && has(yamlData, 'analysis'))) return;
  const analysis = item(yamlData, 'analysis');
  const filter = analysisFilter
    ? analysisFilter.map((a) => a.toLowerCase())
    : null;
  for (const kind of ['dc', 'ac', 'transient']) {
    if (filter && !filter.includes(kind)) continue;
    if (!has(analysis, kind) || !has(structured, kind)) continue;
    const section = item(analysis, kind);
    if (!has(section, 'requirements')) continue;
    const results = structured[kind] as Dict;
    const requirements = iter(item(section, 'requirements'));
    // Criteria constraints are never generated, so every requirement is feasible
    // unless its results are missing.
    const reqResults = requirements.map((req) => {
      const rid = pyStr(item(req, 'rid'));
      item(req, 'requirement');
      if (!has(results, rid)) {
        return {
          feasible: false,
          maxResidual: Infinity,
          limiting: `${rid}_missing`,
          constraints: [
            {
              constraint_id: `${rid}_missing`,
              status: 'missing',
              residual: Infinity,
              target_value: null,
              actual_value: null,
              description: `No simulation results for requirement ${rid}`,
            },
          ] as Constraint[],
        };
      }
      return {
        feasible: true,
        maxResidual: 0,
        limiting: null,
        constraints: [] as Constraint[],
      };
    });
    const metrics: Constraint[] = [];
    const metricsSection = get(section, 'metrics');
    if (has(section, 'metrics') && has(metricsSection, 'constraints')) {
      for (const config of iter(item(metricsSection, 'constraints'))) {
        if (requirements.length) {
          const first = requirements[0];
          metrics.push(
            evaluateConstraint(
              config,
              first,
              get(results, pyStr(get(first, 'rid', ''))),
              env,
            ),
          );
        }
      }
    }
    const requirementsFeasible = reqResults.every((r) => r.feasible);
    const metricsFeasible = metrics.every((c) => c.status === 'pass');
    const feasible = requirementsFeasible && metricsFeasible;
    // Python `sum(max(0, c.residual) ...)`: compensated sum, NaN -> 0.
    const reqViolation = pySum(
      reqResults.map((r) =>
        pySum(r.constraints.map((c) => pyMax0(c.residual))),
      ),
    );
    const metricsViolation = pySum(metrics.map((c) => pyMax0(c.residual)));
    const reqMax = reqResults.length
      ? Math.max(...reqResults.map((r) => r.maxResidual))
      : 0;
    const metricsMax = metrics.length
      ? Math.max(...metrics.map((c) => c.residual))
      : 0;
    let limiting: unknown = null;
    if (!feasible) {
      const infeasible = reqResults.filter((r) => !r.feasible);
      if (infeasible.length) {
        limiting = infeasible.reduce((best, r) =>
          r.maxResidual > best.maxResidual ? r : best,
        ).limiting;
      }
    }
    const residuals: number[] = [];
    const all: Constraint[] = [];
    for (const r of reqResults) {
      for (const c of r.constraints) {
        if (!['missing', 'error'].includes(c.status))
          residuals.push(c.residual);
        all.push(c);
      }
    }
    for (const c of metrics) {
      if (!['missing', 'error'].includes(c.status)) residuals.push(c.residual);
      all.push(c);
    }
    results.feasibility = {
      overall_feasible: feasible,
      total_violation: reqViolation + metricsViolation,
      max_residual: Math.max(reqMax, metricsMax),
      limiting_constraint: limiting,
      constraint_residuals: residuals,
      constraints: all,
    };
  }
}
