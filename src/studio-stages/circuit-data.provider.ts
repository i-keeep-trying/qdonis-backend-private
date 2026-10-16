import { Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../common/errors/error-codes';

/**
 * Integration seam with the simulation core (being ported into this backend
 * separately). Magnetics and thermal run fully here when parts / losses are
 * entered; only their circuit- and simulation-fed paths need this data. The
 * core module binds a real implementation to {@link CIRCUIT_DATA_PROVIDER}.
 */
export const CIRCUIT_DATA_PROVIDER = Symbol('CIRCUIT_DATA_PROVIDER');

/** `/api/studio/circuit-info` result. */
export interface CircuitInventory {
  components: Array<{
    ref: string;
    type: string;
    role?: string | null;
    inside?: string | null;
    params?: Record<string, unknown>;
  }>;
  magnetics: Array<{
    ref: string;
    type: string;
    role?: string | null;
    inductance?: number | null;
    magnetizing_inductance?: number | null;
    turns_ratio?: number | null;
    coupling?: number | null;
    saturation_current?: number | null;
  }>;
  switching_frequency?: number | null;
  input_voltage?: number | null;
  /** Power sources (sense / reference / carrier sources excluded). */
  power_sources?: PowerSource[];
  /** Output-voltage target from the template's analysis criteria. */
  output_voltage?: OutputVoltageTarget | null;
  load_resistance?: number | null;
}

/** A power source: DC `value`, or AC `peak` and `frequency`. */
export interface PowerSource {
  ref: string;
  role: string | null;
  kind: 'dc' | 'ac';
  value?: number;
  peak?: number;
  frequency?: number | null;
}

export interface OutputVoltageTarget {
  value: number;
  rms: boolean;
  key: string;
}

export interface WaveSummary {
  avg: number;
  rms: number;
  ac_rms: number;
  peak: number;
  max: number;
  min: number;
  pp: number;
}

export interface ComponentWaveStats {
  type?: string | null;
  role?: string | null;
  parent?: string | null;
  params: Record<string, number>;
  /** Nested parts: their connections as [ref, pin] pairs. */
  links?: Array<[string, string]>;
  v?: WaveSummary;
  i?: WaveSummary;
  i_pri?: WaveSummary;
  i_sec?: WaveSummary;
  p_avg?: number;
  i_derived?: boolean;
  wave?: { v: number[]; i: number[]; i_pri?: number[]; i_sec?: number[] };
  error?: string;
}

/** `/api/studio/waveform-stats` result (from the raw simulation telemetry). */
export interface WaveformStats {
  fsw: number | null;
  line_frequency: number | null;
  window: { start: number; span: number; basis: string; duration: number };
  dt: number;
  samples_per_period: number | null;
  components: Record<string, ComponentWaveStats>;
}

/** One row of the simulation's `loss_analysis.components`. */
export interface LossComponent {
  component: string;
  device_type?: string;
  total_loss_w?: number;
  conduction_loss_w?: number;
  switching_loss_w?: number;
  leakage_loss_w?: number;
  gate_drive_loss_w?: number;
  model?: string;
}

export interface CircuitDataProvider {
  inventory(input: {
    topologyId: string;
    circuit?: unknown;
    recalculated?: unknown[];
  }): Promise<CircuitInventory | null>;
  waveformStats(input: {
    rawTimeSeriesZip: unknown;
    topologyId?: string;
    circuit?: unknown;
    recalculated?: unknown[];
    fsw?: number | null;
  }): Promise<WaveformStats | null>;
  recalculateLosses(input: {
    topologyId: string;
    /** The branch's edited circuit (absent: the library topology). */
    circuit?: unknown;
    componentModels: Record<string, string>;
    rawTimeSeriesZip: unknown;
    junctionC: number;
  }): Promise<{ components: LossComponent[] } | null>;
}

/** Default binding until the simulation module provides the real one. */
@Injectable()
export class UnavailableCircuitDataProvider implements CircuitDataProvider {
  private unavailable(): Error {
    return AppError.unavailable(
      ErrorCode.StageNotAvailable,
      'Circuit and simulation data are not available on this server yet. Enter the part values (or losses) directly.',
    );
  }

  inventory(): Promise<CircuitInventory | null> {
    return Promise.reject(this.unavailable());
  }

  waveformStats(): Promise<WaveformStats | null> {
    return Promise.reject(this.unavailable());
  }

  recalculateLosses(): Promise<{ components: LossComponent[] } | null> {
    return Promise.reject(this.unavailable());
  }
}
