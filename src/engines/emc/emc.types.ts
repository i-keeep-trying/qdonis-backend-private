// Ported verbatim from the old frontend.
/**
 * EMC Conducted Emissions Calculator Types
 *
 * Types for the PFC boost converter EMC prediction tool,
 * replicating the Excel tool's calculation pipeline.
 */

/** The 9 user input parameters from the Setup sheet */
export interface EMCInputParameters {
  /** PFC Inductor value in mH */
  pfcInductorMH: number;
  /** HT rail (DC bus) voltage in V */
  htRailVoltage: number;
  /** Input power in W */
  inputPower: number;
  /** Input RMS voltage in V */
  inputRMSVoltage: number;
  /** 1st Input Capacitor in nF */
  firstInputCapNF: number;
  /** 2nd Input Capacitor in nF */
  secondInputCapNF: number;
  /** Input Filter Inductor in mH */
  inputFilterInductorMH: number;
  /** Pass margin in dBµV */
  passMarginDB: number;
  /** LISN resistance in Ω */
  lisnResistanceOhm: number;
}

/** Default parameter values matching the Excel tool */
export const DEFAULT_EMC_PARAMS: EMCInputParameters = {
  pfcInductorMH: 1.464,
  htRailVoltage: 394,
  inputPower: 108,
  inputRMSVoltage: 264,
  firstInputCapNF: 1,
  secondInputCapNF: 1,
  inputFilterInductorMH: 8,
  passMarginDB: 6,
  lisnResistanceOhm: 50,
};

/** Result for a single voltage step in the scan */
export interface EMCScanResult {
  /** Input voltage being scanned (V) */
  inputVoltage: number;
  /** Minimum pass margin over target (dB) — negative = FAIL */
  minMarginDB: number;
  /** Frequency of minimum margin (kHz) */
  frequencyOfMinMarginKHz: number;
  /** Input phase angle where worst case occurs (degrees) */
  inputPhaseAngle: number;
  /** Detector type: "Avg" or "QP" */
  detectorType: string;
  /** Whether this voltage step passes */
  pass: boolean;
}

/** Overall result of a full voltage scan */
export interface EMCOverallResult {
  /** Total PASS count across all voltages */
  passCount: number;
  /** Total FAIL count across all voltages */
  failCount: number;
  /** Worst margin from entire scan (dB) */
  worstMarginDB: number;
  /** Array of per-voltage scan results */
  scanResults: EMCScanResult[];
  /** Overall pass/fail verdict */
  overallPass: boolean;
}

/** A single point for the spectrum chart */
export interface EMCSpectrumPoint {
  /** Frequency in MHz */
  frequencyMHz: number;
  /** Emission level in dBµV */
  levelDBuV: number;
  /** Phase angle (degrees) */
  phaseAngle: number;
  /** Harmonic number */
  harmonicNumber: number;
}

/** EN 55015 limit point for chart overlays */
export interface EN55015LimitPoint {
  /** Frequency in MHz */
  frequencyMHz: number;
  /** Limit level in dBµV */
  limitDBuV: number;
}

/** Spectrum chart data bundle */
export interface EMCSpectrumData {
  /** Emission data points (all phase angles, odd harmonics only) */
  emissions: EMCSpectrumPoint[];
  /** QP limit line points */
  qpLimit: EN55015LimitPoint[];
  /** Average limit line points */
  avgLimit: EN55015LimitPoint[];
  /** The voltage this spectrum is for */
  voltage: number;
}
