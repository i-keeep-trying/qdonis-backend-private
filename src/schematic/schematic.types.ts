/**
 * Synced schematic data: the drawing the engine renders (`public/engine.html`
 * synced mode) and the layout stored beside the circuit. The circuit itself
 * is the topology YAML; everything here is derived from it except positions.
 */

import type { PinGeometry } from '../simulation/netlist/signal-blocks';

export interface SymbolMeta {
  ref?: string;
  yaml_type?: unknown;
  node_type?: unknown;
  role?: unknown;
  parent?: unknown;
  /** YAML pin (or net, for sheet blocks) -> engine terminal. */
  pins: Record<string, string>;
  /** A bare net reference `[ref, pin]` (a net label with no component). */
  bare?: [string, string];
  /** Drawing-only label / ground joining far-apart pieces of a net. */
  virtual?: true;
  net?: string;
  hidden?: true;
  /** Sheet blocks and ports. */
  sheet?: string;
  rows?: number;
  sense?: unknown;
  port?: string;
  direction?: string;
  readers?: string[];
}

/** One engine component of the drawing. */
export interface SchematicSymbol {
  id: string;
  type: string;
  parameters: Record<string, string>;
  display: string;
  meta: SymbolMeta;
  label?: string | null;
  /** Glyph / YAML type shown inside block symbols. */
  symbol?: string;
  /** Per-part pin geometry (blocks, sheets, control blocks). */
  pins?: Record<string, PinGeometry>;
  x?: number;
  y?: number;
  rotation?: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
}

export type WireEnd =
  | { type: 'pin'; compId: string; terminal: string }
  | { type: 'wire'; wireId: string; x: number; y: number };

export interface SchematicWire {
  id: string;
  from: WireEnd;
  to: WireEnd;
  manualPath?: Array<{ x: number; y: number }>;
  hidden?: true;
}

export interface Placement {
  x: number;
  y: number;
  rotation: number;
  mirrorX: boolean;
  mirrorY: boolean;
}

export interface SchematicGroup {
  label: string;
  members: string[];
}

/** Positions, wires and grouping of a drawing (every sheet). */
export interface SchematicLayout {
  components?: Record<string, Placement>;
  /** Top-level wires. */
  wires?: SchematicWire[];
  sheets?: Record<string, { wires: SchematicWire[] }>;
  /** Present = explicit grouping (`{}` = no groups). */
  groups?: Record<string, SchematicGroup>;
}

export interface SheetEntry {
  id: string;
  label: string;
  parts: number;
}

export interface RenderResult {
  schematic: {
    components: SchematicSymbol[];
    wires: SchematicWire[];
    plotConfiguration: { plots: [] };
    simulationSettings: Record<string, string>;
    symbols?: Record<string, Record<string, PinGeometry>>;
  };
  layout: SchematicLayout;
  sheet: { id: string | null; label: string };
  /** Where positions came from: saved layout, power-stage structure, old drawing, placer. */
  basis: 'saved' | 'structure' | 'drawing' | 'auto';
  sheets: SheetEntry[];
  groups_explicit: boolean;
}
