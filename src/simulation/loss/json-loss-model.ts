/**
 * Port of qdonis-core `simulator/json_loss_model.py`: datasheet loss LUTs
 * evaluated like scipy `RegularGridInterpolator(method='linear',
 * bounds_error=False, fill_value=None)` (linear extrapolation).
 */

import { readFileSync } from 'node:fs';

import { isDict, toFloat, type Dict } from '../netlist/py';
import { maximum0, pyMax0 } from '../numeric/numpy';

/** A rectilinear grid with float64 values in C order. */
class GridInterpolator {
  private readonly strides: number[];

  constructor(
    private readonly axes: number[][],
    private readonly values: Float64Array,
  ) {
    this.strides = axes.map((_, d) =>
      axes.slice(d + 1).reduce((n, axis) => n * axis.length, 1),
    );
  }

  get ndim(): number {
    return this.axes.length;
  }

  /** `find_interval_ascending(..., extrapolate=True)` + normalised distance. */
  private locate(d: number, x: number): [number, number] {
    const grid = this.axes[d];
    const n = grid.length;
    // scipy: a single-point axis is constant along that dimension.
    if (n === 1) return [0, 0];
    let index: number;
    if (x < grid[0]) index = 0;
    else if (x >= grid[n - 1]) index = n - 2;
    else {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (grid[mid] <= x) lo = mid;
        else hi = mid;
      }
      index = lo;
    }
    return [index, (x - grid[index]) / (grid[index + 1] - grid[index])];
  }

  private value(indices: number[]): number {
    let offset = 0;
    for (let d = 0; d < indices.length; d += 1) {
      offset += indices[d] * this.strides[d];
    }
    return this.values[offset];
  }

  evaluate(point: number[]): number {
    if (point.length !== this.ndim) {
      throw new Error(
        `The requested sample points xi have dimension ${point.length} but this RegularGridInterpolator has dimension ${this.ndim}`,
      );
    }
    if (point.some((x) => Number.isNaN(x))) return Number.NaN;
    const located = point.map((x, d) => this.locate(d, x));
    const flat = this.axes.map((axis) => axis.length === 1);
    if (this.ndim === 2 && !flat.some(Boolean)) {
      // scipy `evaluate_linear_2d` (cython): v * (1 - y0) * (1 - y1), summed from 0.
      const [[i0, y0], [i1, y1]] = located;
      let out = 0;
      out += this.value([i0, i1]) * (1 - y0) * (1 - y1);
      out += this.value([i0, i1 + 1]) * (1 - y0) * y1;
      out += this.value([i0 + 1, i1]) * y0 * (1 - y1);
      out += this.value([i0 + 1, i1 + 1]) * y0 * y1;
      return out;
    }
    // scipy `_evaluate_linear`: hypercube corners, low edge first per axis.
    let out = 0;
    const corners = 1 << this.ndim;
    corner: for (let c = 0; c < corners; c += 1) {
      let weight = 1;
      const indices: number[] = [];
      for (let d = 0; d < this.ndim; d += 1) {
        const high = (c >> (this.ndim - 1 - d)) & 1;
        if (high && flat[d]) continue corner;
        const [i, y] = located[d];
        indices.push(i + high);
        weight = weight * (high ? y : 1 - y);
      }
      out = out + this.value(indices) * weight;
    }
    return out;
  }
}

const floats = (value: unknown): number[] =>
  Array.isArray(value) ? value.map((v) => toFloat(v)) : [];

/** `np.array(block['data'])` flattened, checked against the grid shape. */
function flatten(data: unknown, shape: number[]): Float64Array {
  const out: number[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth === shape.length) {
      out.push(toFloat(node));
      return;
    }
    if (!Array.isArray(node) || node.length !== shape[depth]) {
      throw new Error(
        'The points in dimension do not match the shape of the values array',
      );
    }
    for (const child of node) walk(child, depth + 1);
  };
  walk(data, 0);
  return Float64Array.from(out);
}

function parseBlock(block: unknown): GridInterpolator | null {
  if (!isDict(block) || Object.keys(block).length === 0) return null;
  const iAxis = floats(block.i_axis);
  const tAxis = floats(block.t_axis);
  const axes =
    'v_axis' in block && block.v_axis !== null && block.v_axis !== undefined
      ? [floats(block.v_axis), iAxis, tAxis]
      : [iAxis, tAxis];
  for (const axis of axes) {
    if (axis.length < 1) {
      throw new Error('There are 0 points in dimension');
    }
    for (let k = 1; k < axis.length; k += 1) {
      if (!(axis[k] > axis[k - 1])) {
        throw new Error('The points in dimension must be strictly ascending');
      }
    }
  }
  return new GridInterpolator(
    axes,
    flatten(
      block.data,
      axes.map((a) => a.length),
    ),
  );
}

/** `metadata.get(key, default)` (null when the key holds JSON null). */
const meta = (metadata: Dict, key: string, dflt: unknown): unknown =>
  key in metadata ? metadata[key] : dflt;

export class JsonLossModel {
  readonly partNumber: unknown;
  readonly deviceType: unknown;
  readonly qgNc: unknown;
  readonly iLeakageUa: unknown;
  readonly vDrvV: unknown;
  private readonly turnOn: GridInterpolator | null;
  private readonly turnOff: GridInterpolator | null;
  private readonly conductionOn: GridInterpolator | null;
  private readonly conductionOff: GridInterpolator | null;

  constructor(readonly filepath: string) {
    const data = JSON.parse(readFileSync(filepath, 'utf8')) as unknown;
    if (!isDict(data)) throw new Error('model JSON must be an object');
    const metadata = isDict(data.metadata) ? data.metadata : {};
    this.partNumber = meta(metadata, 'part_number', 'Unknown');
    this.deviceType = meta(metadata, 'type', 'Unknown');
    this.qgNc = meta(metadata, 'Qg_nC', 0.0);
    this.iLeakageUa = meta(metadata, 'I_leakage_uA', 0.0);
    this.vDrvV = meta(metadata, 'V_drv_V', 15.0);
    this.turnOn = parseBlock(data.turn_on_loss);
    this.turnOff = parseBlock(data.turn_off_loss);
    this.conductionOn = parseBlock(data.conduction_loss_on);
    this.conductionOff = parseBlock(data.conduction_loss_off);
  }

  getTurnOnEnergy(v: number, i: number, t: number): number {
    return this.turnOn ? pyMax0(this.turnOn.evaluate([v, i, t])) : 0.0;
  }

  getTurnOffEnergy(v: number, i: number, t: number): number {
    return this.turnOff ? pyMax0(this.turnOff.evaluate([v, i, t])) : 0.0;
  }

  /** Vectorised conduction drop: `np.maximum(0.0, interp([[i, t], ...]))`. */
  getConductionVoltageDrops(
    currents: number[],
    t: number,
    gateOn = true,
  ): number[] {
    const block = gateOn ? this.conductionOn : this.conductionOff;
    if (!block || currents.length === 0) return currents.map(() => 0);
    return currents.map((i) => maximum0(block.evaluate([i, t])));
  }

  get hasDiodeConductionLut(): boolean {
    return this.conductionOff !== null || this.conductionOn !== null;
  }

  getDiodeVoltageDrops(currents: number[], t: number): number[] {
    return this.getConductionVoltageDrops(
      currents,
      t,
      this.conductionOff === null,
    );
  }
}
