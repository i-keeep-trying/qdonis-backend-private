/**
 * ngspice log parsing, port of qdonis-core
 * `NgspiceMeasurePlotter.parse_measurements`.
 */

import { pythonStrip } from '../../common/python/python-json';
import { splitWs, toFloat } from '../netlist/py';

const tryFloat = (text: string): number | null => {
  try {
    return toFloat(text);
  } catch {
    return null;
  }
};

const PRINTED = ['vout_dc', 'vin_dc', 'iin_dc', 'iout_dc'];

/** `.meas` results (and a few printed operating-point values) from a log. */
export function parseMeasurements(logContent: string): Map<string, number> {
  const measurements = new Map<string, number>();
  if (!logContent) return measurements;
  const lines = logContent.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = pythonStrip(lines[i]);
    if (
      line.includes('=') &&
      (line.startsWith('v(') ||
        line.startsWith('i(') ||
        PRINTED.some((n) => line.startsWith(n))) &&
      !line.startsWith('----')
    ) {
      const at = line.indexOf('=');
      const expr = pythonStrip(line.slice(0, at));
      const value = tryFloat(pythonStrip(line.slice(at + 1)));
      if (value !== null) {
        if (expr.startsWith('v(') && expr.endsWith(')'))
          measurements.set(`v_${expr.slice(2, -1)}`, value);
        else if (expr.startsWith('i(') && expr.endsWith(')')) {
          measurements.set(`i_${expr.slice(2, -1).toUpperCase()}`, value);
        } else measurements.set(expr, value);
      }
    } else if (line.includes('No. of Data Rows')) {
      i += 1;
      while (i < lines.length) {
        const m = pythonStrip(lines[i]);
        if (m.startsWith('Reset') || m.startsWith('Circuit:')) break;
        if (
          m.includes('=') &&
          !m.startsWith('Node') &&
          !m.startsWith('----') &&
          !m.includes('failed!') &&
          !pythonStrip(m).startsWith('meas ')
        ) {
          const at = m.indexOf('=');
          const name = pythonStrip(m.slice(0, at));
          const valuePart = pythonStrip(m.slice(at + 1));
          const words = splitWs(valuePart);
          const value = tryFloat(words.length ? words[0] : valuePart);
          if (value !== null) measurements.set(name, value);
        }
        i += 1;
      }
    }
    i += 1;
  }
  return measurements;
}
