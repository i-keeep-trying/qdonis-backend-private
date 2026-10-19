import type { SchematicLayout } from '../schematic/schematic.types';

/** Schematic in the qdonis-web engine format (`public/engine.html` LOAD_CIRCUIT). */
export interface EngineComponent {
  id: string;
  type: string;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  mirrorX: boolean;
  mirrorY: boolean;
  parameters: Record<string, string>;
}

export type EngineEndpoint =
  | { type: 'pin'; compId: string; terminal: string }
  | { type: 'point'; x: number; y: number };

export interface EngineWire {
  id: string;
  from: EngineEndpoint;
  to: EngineEndpoint;
}

export interface EngineCircuit {
  components: EngineComponent[];
  wires: EngineWire[];
}

/** Inventory with display values ("22 µH"), as the Circuit tab shows it. */
export interface DisplayInventory {
  components: Array<{
    ref: string;
    type: string;
    role: string | null;
    params: Record<string, string>;
  }>;
  magnetics: Array<{
    ref: string;
    type: string;
    role: string | null;
    inductance: string | null;
    turnsRatio: string | null;
    saturationCurrent: string | null;
  }>;
  switchingFrequency: string | null;
  inputVoltage: string | null;
}

/** One circuit change, as the Circuit tab lists it. */
export interface CircuitEdit {
  id: string;
  instruction: string;
  summary: string;
  changes: string[];
  added: string[];
  removed: string[];
  appliedAt: string;
}

/** Data of a `visualization` stage node. */
export interface VisualizationData {
  topologyId: string;
  topologyName: string;
  reason: string | null;
  circuit: EngineCircuit | null;
  /** Base SPICE netlist of the library topology (null if it could not be generated). */
  netlist: string | null;
  inventory: DisplayInventory | null;
  edits: CircuitEdit[];
  customStructure: boolean;
  /**
   * The edited circuit (topology YAML as JSON, without its `schematic:`
   * section) once the schematic was edited; null = the library topology.
   */
  customCircuit?: Record<string, unknown> | null;
  /** The project's own drawing layout (moves, edits); null = the library layout. */
  layout?: SchematicLayout | null;
}
