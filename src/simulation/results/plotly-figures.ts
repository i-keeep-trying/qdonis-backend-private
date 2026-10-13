/**
 * Port of `ResultsProcessor.generate_plotly_figures` (qdonis-core
 * `simulator/measure_and_plot.py`): one Plotly figure per time-series CSV.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  get,
  has,
  isDict,
  iter,
  pyEquals,
  pyStr,
  replaceAll,
  replaceFirst,
  truthy,
  type Dict,
} from '../netlist/py';
import { readWhitespaceTable } from '../numeric/pandas-float';
import { autoTraceLabel, measurementLabel } from './signal-names';

const MAX_PLOT_MAGNITUDE = 1e6;
const MAX_POINTS = 5000;

export interface PlotlyFigurePayload {
  figure: Dict;
  analysisType: string;
  requirement: string;
  signal: unknown;
  title: unknown;
  xUnit: string;
  yUnit: string;
  isGatePulse: boolean;
  quantity: 'current' | 'voltage';
  pointCount: number;
  sourceFile: string;
}

/** `_sanitize_xy`: drop non-finite samples and |y| above the sanity ceiling. */
function sanitizeXy(x: number[], y: number[]): [number[], number[]] {
  const cleanX: number[] = [];
  const cleanY: number[] = [];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const xf = x[i];
    const yf = y[i];
    if (!Number.isFinite(xf) || !Number.isFinite(yf)) continue;
    if (Math.abs(yf) > MAX_PLOT_MAGNITUDE) continue;
    cleanX.push(xf);
    cleanY.push(yf);
  }
  return [cleanX, cleanY];
}

/** Min/max-per-block decimation to `MAX_POINTS` (numpy argmin/argmax: first hit). */
function downsample(x: number[], y: number[]): [number[], number[]] {
  const nBlocks = Math.trunc(MAX_POINTS / 2);
  const blockSize = Math.trunc(x.length / nBlocks);
  const xDown: number[] = [];
  const yDown: number[] = [];
  for (let b = 0; b < nBlocks; b += 1) {
    const lo = b * blockSize;
    let minIdx = 0;
    let maxIdx = 0;
    for (let k = 1; k < blockSize; k += 1) {
      if (y[lo + k] < y[lo + minIdx]) minIdx = k;
      if (y[lo + k] > y[lo + maxIdx]) maxIdx = k;
    }
    const [first, second] =
      minIdx < maxIdx ? [minIdx, maxIdx] : [maxIdx, minIdx];
    xDown.push(x[lo + first], x[lo + second]);
    yDown.push(y[lo + first], y[lo + second]);
  }
  return [xDown, yDown];
}

const isCased = (ch: string): boolean => ch.toLowerCase() !== ch.toUpperCase();

/** Python `str.title()`. */
function pyTitle(text: string): string {
  let out = '';
  let prevCased = false;
  for (const ch of text) {
    out += prevCased ? ch.toLowerCase() : ch.toUpperCase();
    prevCased = isCased(ch);
  }
  return out;
}

/** Python `str.isupper()` for one character. */
const isUpperChar = (ch: string): boolean =>
  isCased(ch) && ch === ch.toUpperCase();

/** Requirements list of an analysis section (dict with `requirements`, or a list). */
function requirementsOf(section: unknown): unknown[] {
  if (isDict(section) && has(section, 'requirements')) {
    return iter(section.requirements);
  }
  return Array.isArray(section) ? section : [];
}

/** Runs a Python `try: ... except Exception: pass` block. */
function attempt(block: () => void): void {
  try {
    block();
  } catch {
    // Python swallowed every exception here.
  }
}

interface ParsedName {
  refName: string | null;
  reqIdentifier: string | null;
  matched: unknown;
  analysisType: string;
}

function parseFileName(
  basename: string,
  stem: string,
  parts: string[],
  yamlData: unknown,
): ParsedName {
  let refName: string | null = null;
  let reqIdentifier: string | null = null;
  let matched: unknown = null;
  let analysisType = 'transient';

  if (stem.includes('_req')) {
    const at = stem.indexOf('_req');
    analysisType = stem.slice(0, at);
    const reqPart = stem.slice(at + 4);
    const sep = reqPart.indexOf('_');
    if (sep >= 0) {
      reqIdentifier = `req${reqPart.slice(0, sep)}`;
      refName = reqPart.slice(sep + 1);
    }
    return { refName, reqIdentifier, matched, analysisType };
  }

  if (yamlData !== undefined) {
    attempt(() => {
      const analysis = get(yamlData, 'analysis', {});
      for (const check of ['dc', 'ac', 'transient']) {
        if (!has(analysis, check)) continue;
        for (const req of requirementsOf(get(analysis, check))) {
          const rid = get(req, 'rid');
          if (!truthy(rid)) continue;
          for (const meas of iter(get(req, 'measurement', []))) {
            const measRef = get(meas, 'ref');
            if (
              truthy(measRef) &&
              `${pyStr(rid)}_${pyStr(measRef)}.csv` === basename
            ) {
              reqIdentifier = rid as string;
              refName = measRef as string;
              matched = meas;
              analysisType = check;
              break;
            }
          }
          if (refName) break;
        }
        if (refName) break;
      }
    });
  }

  if (
    !refName &&
    (stem.startsWith('V_') || stem.startsWith('I_') || stem.startsWith('Gate_'))
  ) {
    reqIdentifier = 'transient';
    refName = stem;
    analysisType = 'transient';
  }

  if (!refName || !reqIdentifier) {
    const measRefParts: string[] = [];
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (parts[i] && isUpperChar(parts[i][0])) measRefParts.unshift(parts[i]);
      else break;
    }
    if (measRefParts.length) {
      refName = measRefParts.join('_');
      reqIdentifier = parts
        .slice(0, parts.length - measRefParts.length)
        .join('_');
    }
    if (!refName || !reqIdentifier) {
      reqIdentifier = parts[0];
      refName = parts.slice(1).join('_');
    }
  }

  const rid: string = reqIdentifier;
  if (rid.startsWith('dc_')) analysisType = 'dc';
  else if (rid.startsWith('ac_')) analysisType = 'ac';
  else if (rid.startsWith('tr_') || rid.startsWith('tran_')) {
    analysisType = 'transient';
  }
  return { refName, reqIdentifier, matched, analysisType };
}

function findRequirement(
  yamlData: unknown,
  analysisType: string,
  reqIdentifier: string | null,
): unknown {
  const analysis = get(yamlData, 'analysis', {});
  if (!has(analysis, analysisType)) return null;
  for (const req of requirementsOf(get(analysis, analysisType))) {
    if (pyEquals(get(req, 'rid'), reqIdentifier)) return req;
  }
  return null;
}

function yamlXAxis(
  yamlData: unknown,
  analysisType: string,
  reqIdentifier: string | null,
  refName: string | null,
): unknown {
  let xAxis: unknown = null;
  attempt(() => {
    const req = findRequirement(yamlData, analysisType, reqIdentifier);
    if (req === null) return;
    for (const meas of iter(get(req, 'measurement', []))) {
      const ref = get(meas, 'ref');
      if (refName === null) throw new TypeError('NoneType has no split');
      if (pyEquals(ref, refName) || pyEquals(ref, refName.split('_')[0])) {
        const plot = get(meas, 'plot');
        if (isDict(plot)) xAxis = get(plot, 'x_axis');
        break;
      }
    }
  });
  return xAxis;
}

function yamlTitle(
  yamlData: unknown,
  analysisType: string,
  reqIdentifier: string,
  refName: string,
): { found: boolean; title: unknown } {
  const out: { found: boolean; title: unknown } = { found: false, title: null };
  attempt(() => {
    const req = findRequirement(yamlData, analysisType, reqIdentifier);
    if (!req) return;
    const variables = get(req, 'variables', {});
    for (const measurement of iter(get(variables, 'measurement', []))) {
      const measRef = get(measurement, 'ref', '___');
      // str == non-str is False, then `meas_ref + '_'` raises TypeError.
      if (typeof measRef !== 'string') throw new TypeError('str concat');
      if (refName === measRef || refName.startsWith(`${measRef}_`)) {
        const plot = get(measurement, 'plot');
        if (isDict(plot) && has(plot, 'title')) {
          out.found = true;
          out.title = plot.title;
        }
        break;
      }
    }
  });
  return out;
}

function figureFor(
  file: string,
  basename: string,
  yamlData: unknown,
): [string, PlotlyFigurePayload] | null {
  const stem = replaceAll(basename, '.csv', '');
  const parts = stem.split('_');
  if (parts.length < 2) return null;

  const { refName, reqIdentifier, matched, analysisType } = parseFileName(
    basename,
    stem,
    parts,
    yamlData,
  );

  const columns = readWhitespaceTable(readFileSync(file, 'latin1'));
  if (columns.length < 2) return null;

  let actualXAxis: unknown =
    yamlData !== undefined
      ? yamlXAxis(yamlData, analysisType, reqIdentifier, refName)
      : null;
  if (actualXAxis === null || actualXAxis === undefined) {
    if (analysisType === 'ac') actualXAxis = 'frequency';
    else if (analysisType === 'tran' || analysisType === 'transient') {
      actualXAxis = 'time';
    } else actualXAxis = 'voltage';
  }

  const columnCount = columns.length;
  let xSeries: number[];
  let ySeries: number[];
  if (actualXAxis === 'time' || actualXAxis === 'frequency') {
    xSeries = columns[0];
    ySeries = columns[columnCount - 1];
  } else if (columnCount >= 4) {
    xSeries = columns[1];
    ySeries = columns[3];
  } else {
    xSeries = columns[0];
    ySeries = columns[columnCount - 1];
  }

  let [xData, yData] = sanitizeXy(xSeries, ySeries);
  if (yData.length === 0) return null;
  if (xData.length > MAX_POINTS) [xData, yData] = downsample(xData, yData);

  let xUnit: string;
  let xLabel: string;
  if (actualXAxis === 'time') {
    const maxX = xData.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    let xScale: number;
    if (maxX > 1e-3) [xScale, xUnit] = [1e3, 'ms'];
    else if (maxX > 1e-6) [xScale, xUnit] = [1e6, 'μs'];
    else [xScale, xUnit] = [1e9, 'ns'];
    xData = xData.map((v) => v * xScale);
    xLabel = `Time (${xUnit})`;
  } else if (actualXAxis === 'frequency') {
    xUnit = 'Hz';
    xLabel = 'Frequency (Hz)';
  } else {
    xUnit = 'V';
    xLabel = `${pyStr(actualXAxis)} (V)`;
  }

  let displayName: unknown = refName;
  let autoGate: boolean | null = null;
  if (matched !== null) {
    const label = measurementLabel(matched, yamlData ?? null);
    displayName = truthy(label) ? label : refName;
  } else {
    const auto = autoTraceLabel(stem, yamlData ?? null);
    if (auto) [displayName, autoGate] = auto;
  }
  if (reqIdentifier === null || typeof displayName !== 'string') return null;
  const name = displayName;

  const signalUpper = refName ? refName.toUpperCase() : '';
  let yUnit: string;
  if (signalUpper.startsWith('I') || signalUpper.includes('CURRENT')) {
    const maxY = yData.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (maxY > 1) yUnit = 'A';
    else if (maxY > 1e-3) {
      yData = yData.map((v) => v * 1e3);
      yUnit = 'mA';
    } else {
      yData = yData.map((v) => v * 1e6);
      yUnit = 'μA';
    }
  } else if (
    analysisType === 'ac' &&
    (signalUpper.includes('DB') || signalUpper.includes('MAG'))
  ) {
    yUnit = 'dB';
  } else if (analysisType === 'ac' && signalUpper.includes('PHASE')) {
    yUnit = 'degrees';
  } else {
    yUnit = 'V';
  }
  const yLabel = `${name} (${yUnit})`;

  let friendly = analysisType ? analysisType.toUpperCase() : 'TRANSIENT';
  if (friendly === 'TRAN') friendly = 'TRANSIENT';
  const reqTitle = pyTitle(replaceAll(reqIdentifier, '_', ' '));
  let title: unknown = `${friendly} - ${reqTitle} - ${name}`;
  if (name.endsWith('_V')) {
    title = `${friendly} - ${reqTitle} - Component: ${name.slice(0, -2)} (Voltage)`;
  } else if (name.endsWith('_I')) {
    title = `${friendly} - ${reqTitle} - Component: ${name.slice(0, -2)} (Current)`;
  } else if (name.endsWith('_Gate')) {
    title = `${friendly} - ${reqTitle} - Component: ${name.slice(0, -5)} (Gate)`;
  }
  if (yamlData !== undefined && refName !== null) {
    const fromYaml = yamlTitle(yamlData, analysisType, reqIdentifier, refName);
    if (fromYaml.found) title = fromYaml.title;
  }

  const figure: Dict = {
    data: [
      {
        x: xData,
        y: yData,
        type: 'scattergl',
        mode: 'lines',
        name,
        line: { color: '#3b82f6', width: 1.5 },
        hovertemplate: `${name}: %{y:.4g} ${yUnit}<br>%{x:.4g} ${xUnit}<extra></extra>`,
      },
    ],
    layout: {
      title: { text: title, font: { color: '#1e293b', size: 14 } },
      xaxis: {
        title: { text: xLabel, font: { color: '#334155' } },
        gridcolor: 'rgba(148, 163, 184, 0.3)',
        tickfont: { color: '#475569' },
        type: analysisType === 'ac' ? 'log' : 'linear',
      },
      yaxis: {
        title: { text: yLabel, font: { color: '#334155' } },
        gridcolor: 'rgba(148, 163, 184, 0.3)',
        tickfont: { color: '#475569' },
      },
      paper_bgcolor: '#ffffff',
      plot_bgcolor: '#ffffff',
      margin: { l: 60, r: 30, t: 50, b: 60 },
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.15,
        font: { color: '#1e293b', size: 10 },
      },
    },
    config: { responsive: true, displaylogo: false, displayModeBar: true },
  };

  const refUpper = (refName ?? '').toUpperCase();
  const isTelemetry = refUpper.startsWith('V_') || refUpper.startsWith('I_');
  let isPwm =
    !isTelemetry && (refUpper.includes('PWM') || refUpper.includes('GATE'));
  if (autoGate !== null) isPwm = autoGate;
  const quantity =
    ['A', 'mA', 'μA', 'uA'].includes(yUnit) ||
    (refName && refName.toUpperCase().startsWith('I'))
      ? 'current'
      : 'voltage';

  return [
    stem,
    {
      figure,
      analysisType:
        analysisType === 'tran' || analysisType === 'transient'
          ? 'transient'
          : analysisType,
      requirement: reqIdentifier || 'unknown',
      signal: name || 'unknown',
      title,
      xUnit,
      yUnit,
      isGatePulse: isPwm,
      quantity,
      pointCount: yData.length,
      sourceFile: basename,
    },
  ];
}

/** `fnmatch('*_*.csv')` on a non-hidden file name. */
const isPlotCsv = (name: string): boolean =>
  !name.startsWith('.') &&
  name.endsWith('.csv') &&
  name.slice(0, -4).includes('_');

/** `generate_plotly_figures(output_dir, yaml_path)`; `yamlData` undefined = no YAML. */
export function generatePlotlyFigures(
  outputDir: string,
  yamlData: unknown,
): Record<string, PlotlyFigurePayload> {
  const figures: Record<string, PlotlyFigurePayload> = {};
  const dir = join(outputDir, 'time_series');
  if (!existsSync(dir)) return figures;
  const files = readdirSync(dir).filter(isPlotCsv).sort();
  for (const basename of files) {
    try {
      const entry = figureFor(join(dir, basename), basename, yamlData);
      if (entry) figures[entry[0]] = entry[1];
    } catch {
      // Python logged and skipped the file.
    }
  }

  const bySignal = new Map<unknown, string[]>();
  for (const key of Object.keys(figures).sort()) {
    const signal = figures[key].signal;
    const list = bySignal.get(signal) ?? [];
    list.push(key);
    bySignal.set(signal, list);
  }
  for (const [signal, keys] of bySignal) {
    if (keys.length < 2) continue;
    const primary =
      keys.find((k) => figures[k].requirement === 'transient') ?? keys[0];
    for (const key of keys) {
      if (key === primary) continue;
      const entry = figures[key];
      const tagged = `${pyStr(signal)} (${entry.requirement})`;
      entry.signal = tagged;
      for (const trace of entry.figure.data as Dict[]) {
        trace.name = tagged;
        trace.hovertemplate = replaceFirst(
          trace.hovertemplate as string,
          `${pyStr(signal)}:`,
          `${tagged}:`,
        );
      }
    }
  }
  return figures;
}
