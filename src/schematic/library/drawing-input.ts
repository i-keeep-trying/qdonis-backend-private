/**
 * Drawings and layouts sent by the client (the engine runs in a sandboxed
 * frame, so its output is untrusted). Only the fields the editor uses are
 * kept, with checked types and sizes; anything else is a 400. What passes is
 * what gets stored in the project, so nothing unexpected can be persisted.
 */

import { AppError, ErrorCode } from '../../common/errors/error-codes';
import { isDict, type Dict } from '../../simulation/netlist/py';
import type {
  Placement,
  SchematicGroup,
  SchematicLayout,
  SchematicWire,
  WireEnd,
} from '../schematic.types';

export const MAX_PARTS = 5_000;
export const MAX_WIRES = 20_000;
const MAX_ID = 256;
const MAX_TEXT = 2_000;
const MAX_PATH = 200;
const MAX_PARAMS = 200;

const invalid = (what: string) =>
  AppError.badRequest(ErrorCode.ValidationFailed, `Invalid schematic: ${what}`);

const id = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value || value.length > MAX_ID)
    throw invalid(what);
  return value;
};
const finite = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(what);
  return value;
};
const text = (value: unknown, what: string): string => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw invalid(what);
  return value;
};
const list = (value: unknown, max: number, what: string): unknown[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw invalid(what);
  return value;
};
const record = (value: unknown, max: number, what: string): Dict => {
  if (value === undefined || value === null) return {};
  if (!isDict(value) || Object.keys(value).length > max) throw invalid(what);
  return value;
};

function end(value: unknown): WireEnd {
  if (!isDict(value)) throw invalid('wire end');
  if (value.type === 'pin') {
    return {
      type: 'pin',
      compId: id(value.compId, 'wire end part'),
      terminal: id(value.terminal, 'wire end terminal'),
    };
  }
  if (value.type === 'wire') {
    return {
      type: 'wire',
      wireId: id(value.wireId, 'wire tap'),
      x: finite(value.x, 'wire tap x'),
      y: finite(value.y, 'wire tap y'),
    };
  }
  throw invalid('wire end type');
}

function wires(value: unknown): SchematicWire[] {
  return list(value, MAX_WIRES, 'wires').map((w) => {
    if (!isDict(w)) throw invalid('wire');
    const wire: SchematicWire = {
      id: id(w.id, 'wire id'),
      from: end(w.from),
      to: end(w.to),
    };
    if (w.manualPath !== undefined && w.manualPath !== null) {
      wire.manualPath = list(w.manualPath, MAX_PATH, 'wire path').map((p) => {
        if (!isDict(p)) throw invalid('wire path point');
        return { x: finite(p.x, 'wire path x'), y: finite(p.y, 'wire path y') };
      });
    }
    return wire;
  });
}

const ROTATIONS = new Set([0, 90, 180, 270]);

function placement(value: unknown, what: string): Placement {
  if (!isDict(value)) throw invalid(what);
  const rotation =
    value.rotation === undefined
      ? 0
      : finite(value.rotation, `${what} rotation`);
  if (!ROTATIONS.has(rotation)) throw invalid(`${what} rotation`);
  return {
    x: finite(value.x, `${what} x`),
    y: finite(value.y, `${what} y`),
    rotation,
    mirrorX: value.mirrorX === true,
    mirrorY: value.mirrorY === true,
  };
}

/** The parts of `meta` that editing reads (pins, identity, copies, sheet ports). */
function meta(value: unknown): Dict {
  const raw = record(value, 50, 'part meta');
  const out: Dict = {};
  if (raw.ref !== undefined && raw.ref !== null)
    out.ref = id(raw.ref, 'part ref');
  if (raw.copyOf !== undefined && raw.copyOf !== null)
    out.copyOf = id(raw.copyOf, 'copied part');
  if (raw.virtual === true) out.virtual = true;
  if (raw.port !== undefined && raw.port !== null)
    out.port = id(raw.port, 'port net');
  if (raw.bare !== undefined && raw.bare !== null) {
    const bare = list(raw.bare, 2, 'bare net reference');
    if (bare.length !== 2) throw invalid('bare net reference');
    out.bare = [
      id(bare[0], 'bare ref'),
      typeof bare[1] === 'string' ? bare[1] : '',
    ];
  }
  if (raw.pins !== undefined && raw.pins !== null) {
    out.pins = Object.fromEntries(
      Object.entries(record(raw.pins, MAX_PARAMS, 'part pins')).map(
        ([pin, t]) => [pin.slice(0, MAX_ID), id(t, 'part pin terminal')],
      ),
    );
  }
  return out;
}

/** An edited drawing `{components, wires}` from the engine. */
export function readDrawing(value: unknown): Dict {
  if (!isDict(value)) throw invalid('drawing');
  const components = list(value.components, MAX_PARTS, 'parts').map((c) => {
    if (!isDict(c)) throw invalid('part');
    const out: Dict = {
      id: id(c.id, 'part id'),
      type: id(c.type, 'part type'),
      ...placement(c, 'part'),
      parameters: Object.fromEntries(
        Object.entries(record(c.parameters, MAX_PARAMS, 'part parameters')).map(
          ([k, v]) => [k.slice(0, MAX_ID), text(v, 'part parameter')],
        ),
      ),
      meta: meta(c.meta),
    };
    if (typeof c.label === 'string') out.label = c.label.slice(0, MAX_TEXT);
    if (c.pins !== undefined && c.pins !== null) {
      // a generic block's own pin table
      out.pins = Object.fromEntries(
        Object.entries(record(c.pins, MAX_PARAMS, 'part pin table')).map(
          ([t, p]) => {
            if (!isDict(p)) throw invalid('part pin');
            return [
              t.slice(0, MAX_ID),
              {
                x: finite(p.x, 'pin x'),
                y: finite(p.y, 'pin y'),
                dx: finite(p.dx, 'pin dx'),
                dy: finite(p.dy, 'pin dy'),
              },
            ];
          },
        ),
      );
    }
    return out;
  });
  return { components, wires: wires(value.wires) };
}

/** A full layout (every sheet, the grouping) the client rendered with. */
export function readLayout(value: unknown): SchematicLayout | null {
  if (value === undefined || value === null) return null;
  if (!isDict(value)) throw invalid('layout');
  const out: SchematicLayout = {
    components: Object.fromEntries(
      Object.entries(record(value.components, MAX_PARTS, 'layout parts')).map(
        ([cid, p]) => [id(cid, 'layout part id'), placement(p, 'layout part')],
      ),
    ),
    wires: wires(value.wires),
  };
  if (value.sheets !== undefined && value.sheets !== null) {
    out.sheets = Object.fromEntries(
      Object.entries(record(value.sheets, 500, 'sheets')).map(([gid, sh]) => [
        id(gid, 'sheet id'),
        { wires: wires(isDict(sh) ? sh.wires : undefined) },
      ]),
    );
  }
  if (value.groups !== undefined && value.groups !== null) {
    out.groups = Object.fromEntries(
      Object.entries(record(value.groups, 500, 'groups')).map(
        ([gid, g]): [string, SchematicGroup] => {
          if (!isDict(g)) throw invalid('group');
          return [
            id(gid, 'group id'),
            {
              label: text(g.label ?? gid, 'group label'),
              members: list(g.members, MAX_PARTS, 'group members').map((m) =>
                id(m, 'group member'),
              ),
            },
          ];
        },
      ),
    );
  }
  return out;
}
