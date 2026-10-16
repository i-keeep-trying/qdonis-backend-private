import type {
  OutputVoltageTarget,
  PowerSource,
} from '../studio-stages/circuit-data.provider';

/** `POST /studio/circuit-info` inventory (snake_case, as qdonis-core returned it). */
export interface CircuitInventory {
  id: unknown;
  name: unknown;
  components: Array<{
    ref: unknown;
    type: unknown;
    role: unknown;
    inside: unknown;
    params: Record<string, unknown>;
  }>;
  magnetics: Array<{
    ref: unknown;
    type: string;
    role: unknown;
    inductance: number | null;
    magnetizing_inductance: number | null;
    turns_ratio: number | null;
    coupling: number | null;
    saturation_current: number | null;
  }>;
  switching_frequency: number | null;
  input_voltage: number | null;
  power_sources: PowerSource[];
  output_voltage: OutputVoltageTarget | null;
  load_resistance: number | null;
}

export interface CircuitInfoInput {
  topologyId?: string | null;
  /** An edited topology dict; used instead of the library when it has components. */
  circuit?: Record<string, unknown> | null;
  /** Design values `[{ref, param, after}]` applied before the inventory. */
  recalculated?: unknown[] | null;
}
