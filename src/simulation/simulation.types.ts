/**
 * Design and simulation stage data, as qdonis-web reads it
 * (`src/features/studio/types/{design,simulation}.ts`).
 */

import type { DeviceSelection } from './devices.format';
import type { LossAnalysis as CoreLossAnalysis } from './loss/loss-engine';
import type { AnalysisKind } from './ngspice/ngspice.runner';

export type DeckKind = AnalysisKind;
export const DECK_KINDS: readonly DeckKind[] = ['dc', 'ac', 'transient'];

export interface RecalculatedParameter {
  ref: string;
  param: string;
  before: string;
  after: string;
  unit: string | null;
}

export interface DesignData {
  topologyId: string;
  decks: Partial<Record<DeckKind, string>>;
  recalculatedParameters: RecalculatedParameter[];
  quickParamsLine: string | null;
  reasoning: string | null;
  origin: 'optimizer' | 'upload';
  fileName: string | null;
  metadata: Record<string, string>;
  /** Last AI edit of the decks, so a later simulation can be checked against it. */
  aiEdit?: DesignAiEdit | null;
}

export interface DesignAiEdit {
  mode: 'modify' | 'fix';
  /** What the user asked for (empty for a plain fix). */
  instruction: string;
  /** Decks before the edit. */
  beforeDecks: Partial<Record<DeckKind, string>>;
  at: string;
}

export interface Measurement {
  name: string;
  value: number;
  unit: string | null;
  kind: 'output' | 'parameter';
  target: string | null;
  status: 'pass' | 'fail' | 'info';
}

export interface MeasurementGroup {
  key: string;
  title: string;
  analysis: DeckKind;
  measurements: Measurement[];
}

export interface LossComponent {
  component: string;
  model: string;
  deviceType: 'switch' | 'diode';
  conductionLossW: number;
  switchingLossW: number;
  gateDriveLossW: number;
  leakageLossW: number;
  totalLossW: number;
  switchingEvents: number;
}

export interface LossAnalysis {
  junctionTemperatureC: number;
  defaultMosfet: string | null;
  defaultDiode: string | null;
  activeModels: string;
  components: LossComponent[];
}

export interface WaveformPlotMeta {
  key: string;
  signal: string;
  title: string;
  analysis: DeckKind;
  quantity: 'voltage' | 'current';
  xUnit: string;
  yUnit: string;
  isGatePulse: boolean;
}

export interface WaveformPlot extends WaveformPlotMeta {
  x: number[];
  y: number[];
}

export interface WaveformSet {
  plots: Record<string, WaveformPlot>;
}

export interface SimulationSummary {
  analyses: DeckKind[];
  measurementCount: number;
  plotCount: number;
  semiconductorLossW: number | null;
  lossJunctionC: number | null;
  lossTemperatureSource: string | null;
}

/**
 * Simulation node data: what qdonis-web shows, plus the qdonis-core keys the
 * server-side magnetics / thermal stages read (`loss_analysis`, `metadata`).
 */
export interface SimulationData {
  /** Set while (and after) a server run owns the node. */
  runId: string;
  topologyName: string;
  analyses: DeckKind[];
  netlist: string;
  summary: SimulationSummary;
  measurements: MeasurementGroup[];
  lossAnalysis: LossAnalysis | null;
  plots: WaveformPlotMeta[];
  /** Parts chosen on the simulated waveforms (losses use them). */
  deviceSelection: DeviceSelection | null;
  loss_analysis: CoreLossAnalysis | null;
  metadata: { topology: string; analysis_type: 'all'; num_plots: number };
  /** qdonis-core structured results (for the post-run verifier). */
  results: Record<string, unknown> | null;
  /** Fingerprint of the decks ngspice ran (`decksSha256`). */
  executedDecksSha256: string | null;
}
