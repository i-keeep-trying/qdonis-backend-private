/**
 * Drawing geometry: the 20 px grid, pin positions (mirror, then rotation, as
 * the engine draws them), symbol extents and an occupancy map for placement.
 * Port of the "Geometry helpers" of qdonis-core `schematic_sync.py`.
 */

import { EXTENT, PINS, type PinTable } from './symbols';
import type { SchematicSymbol } from '../schematic.types';

export const GRID = 20;

/** Python `round()`: half to even. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export const snap = (v: number): number => roundHalfEven(v / GRID) * GRID + 0;

export function rotate(
  x: number,
  y: number,
  rotation: number,
): [number, number] {
  const rad = ((rotation || 0) * Math.PI) / 180;
  const c = roundHalfEven(Math.cos(rad));
  const s = roundHalfEven(Math.sin(rad));
  return [x * c - y * s + 0, x * s + y * c + 0];
}

/** A part's pin table: its own `pins` (blocks, sheets) or the symbol's. */
export function pinTable(comp: SchematicSymbol): PinTable {
  if (comp.pins) {
    return Object.fromEntries(
      Object.entries(comp.pins).map(([k, v]) => [k, [v.x, v.y, v.dx, v.dy]]),
    );
  }
  return Object.hasOwn(PINS, comp.type) ? PINS[comp.type] : {};
}

/** Absolute pin position and outward direction. */
export function pinPoint(
  comp: SchematicSymbol,
  terminal: string,
): [number, number, number, number] {
  const table = pinTable(comp);
  let [x, y, dx, dy] = Object.hasOwn(table, terminal)
    ? table[terminal]
    : [0, 0, 0, 0];
  if (comp.mirrorX) [x, dx] = [-x, -dx];
  if (comp.mirrorY) [y, dy] = [-y, -dy];
  const [rx, ry] = rotate(x, y, comp.rotation ?? 0);
  const [rdx, rdy] = rotate(dx, dy, comp.rotation ?? 0);
  return [(comp.x ?? 0) + rx, (comp.y ?? 0) + ry, rdx, rdy];
}

/** Python `len(str(value or ""))`. */
const codePoints = (value: string | null | undefined): number =>
  value ? Array.from(value).length : 0;

/** Half extents [w, h] of a placed part (caption room included, rotation applied). */
export function extent(comp: SchematicSymbol): [number, number] {
  let hw: number;
  let hh: number;
  const caption = () =>
    Math.min(Math.max(codePoints(comp.display), codePoints(comp.id)), 18) * 3;
  const pinYs = () => {
    const ys = Object.values(comp.pins ?? {}).map((p) => p.y);
    return ys.length ? ys : [0];
  };
  if (comp.type === 'BLOCK') {
    const n = Math.max(1, Math.ceil(Object.keys(comp.pins ?? {}).length / 2));
    hw = 40;
    hh = Math.max(24, n * 12 + 12);
  } else if (comp.type.startsWith('CB_')) {
    const ys = pinYs();
    hw = 40 + caption();
    hh = Math.max(30, Math.floor((Math.max(...ys) - Math.min(...ys)) / 2) + 24);
  } else if (comp.type === 'SHEET') {
    const ys = pinYs();
    hw = 100;
    hh = Math.max(50, Math.floor((Math.max(...ys) - Math.min(...ys)) / 2) + 40);
  } else if (comp.type === 'LABEL' || comp.type === 'PORT') {
    // the engine draws ~7 px per character
    hw = 24 + 7 * codePoints(comp.label ?? '');
    hh = 12;
  } else {
    [hw, hh] = Object.hasOwn(EXTENT, comp.type) ? EXTENT[comp.type] : [24, 44];
    hw += caption();
  }
  const quarter = ((Math.trunc(comp.rotation ?? 0) % 180) + 180) % 180;
  return quarter === 90 ? [hh, hw] : [hw, hh];
}

export type Bounds = [number, number, number, number];

/** Boxes of placed parts; finds the nearest free spot for a new one. */
export class Occupancy {
  readonly boxes = new Map<string, [number, number, number, number]>();

  constructor(private readonly margin = 32) {}

  add(cid: string, comp: SchematicSymbol): void {
    const [hw, hh] = extent(comp);
    this.boxes.set(cid, [comp.x ?? 0, comp.y ?? 0, hw, hh]);
  }

  free(x: number, y: number, hw: number, hh: number, margin?: number): boolean {
    const m = margin ?? this.margin;
    for (const [ox, oy, ohw, ohh] of this.boxes.values()) {
      if (!(
        Math.abs(x - ox) >= hw + ohw + m || Math.abs(y - oy) >= hh + ohh + m
      )) {
        return false;
      }
    }
    return true;
  }

  /** Nearest free position; `margin` is the clearance to other symbols. */
  spot(
    x0: number,
    y0: number,
    hw: number,
    hh: number,
    step = 40,
    rings = 40,
    margin?: number,
  ): [number, number] {
    const x = snap(x0);
    const y = snap(y0);
    for (let r = 0; r < rings; r += 1) {
      const ring: Array<[number, number]> = [];
      for (let i = -r; i <= r; i += 1) {
        for (let j = -r; j <= r; j += 1) {
          if (Math.max(Math.abs(i), Math.abs(j)) === r) {
            ring.push([x + i * step, y + j * step]);
          }
        }
      }
      ring.sort(
        (a, b) =>
          Math.abs(a[0] - x) +
            Math.abs(a[1] - y) -
            (Math.abs(b[0] - x) + Math.abs(b[1] - y)) ||
          a[1] - b[1] ||
          a[0] - b[0],
      );
      for (const [px, py] of ring) {
        if (this.free(px, py, hw, hh, margin)) return [px, py];
      }
    }
    // Nothing free nearby: look further out rather than overlap.
    if (rings < 60) {
      return this.spot(x, y, hw, hh, Math.max(step, 40), 60, margin);
    }
    return [x, y + rings * step];
  }

  bounds(): Bounds | null {
    if (!this.boxes.size) return null;
    const boxes = [...this.boxes.values()];
    return [
      Math.min(...boxes.map(([x, , hw]) => x - hw)),
      Math.min(...boxes.map(([, y, , hh]) => y - hh)),
      Math.max(...boxes.map(([x, , hw]) => x + hw)),
      Math.max(...boxes.map(([, y, , hh]) => y + hh)),
    ];
  }
}
