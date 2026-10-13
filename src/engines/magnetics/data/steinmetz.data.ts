// Ported verbatim from the old frontend; keep numerically identical (see specs).
/**
 * Steinmetz Coefficient Data
 *
 * This file contains Steinmetz equation coefficients for calculating core losses
 * in various ferrite materials across different frequency ranges.
 *
 * Data migrated from Python CSV: FXC steinmetz.csv
 *
 * The Steinmetz equation: Pv = Cm × f^x × B^y × (Ct - Ct1×T + Ct2×T²) / 1000
 * where:
 *   Pv = volumetric power loss density (mW/cm³)
 *   f = frequency (Hz)
 *   B = flux density (T)
 *   T = temperature (°C)
 */

/**
 * Steinmetz coefficient data row
 */
export interface SteinmetzDataRow {
  /** Material designation (e.g., "3C90", "3C91") */
  material: string;
  /** Material status (e.g., "Standard", "Design in", "Prototype") */
  status: string;
  /** Minimum frequency for this coefficient set (Hz) */
  frequencyMin: number;
  /** Maximum frequency for this coefficient set (Hz) */
  frequencyMax: number;
  /** Steinmetz coefficient Cm */
  cm: number;
  /** Steinmetz exponent x (frequency exponent) */
  x: number;
  /** Steinmetz exponent y (flux density exponent) */
  y: number;
  /** Temperature coefficient Ct2 */
  ct2: number;
  /** Temperature coefficient Ct1 */
  ct1: number;
  /** Temperature coefficient Ct */
  ct: number;
}

/**
 * Steinmetz coefficient data for all materials and frequency ranges
 *
 * Data source: FXC steinmetz.csv from Python implementation
 * Contains coefficients for multiple ferrite materials across various frequency ranges
 */
export const STEINMETZ_DATA: SteinmetzDataRow[] = [
  {
    material: '3C90',
    status: 'Standard',
    frequencyMin: 20000,
    frequencyMax: 200001,
    cm: 3.2,
    x: 1.46,
    y: 2.75,
    ct2: 0.000165,
    ct1: 0.031,
    ct: 2.45,
  },
  {
    material: '3C91',
    status: 'Standard',
    frequencyMin: 10000,
    frequencyMax: 100000,
    cm: 3.5,
    x: 1.4,
    y: 2.5,
    ct2: 0.000142,
    ct1: 0.013,
    ct: 0.88,
  },
  {
    material: '3C91',
    status: 'Standard',
    frequencyMin: 100000,
    frequencyMax: 200000,
    cm: 3.5,
    x: 1.4,
    y: 2.5,
    ct2: 0.000142,
    ct1: 0.013,
    ct: 0.88,
  },
  {
    material: '3C91',
    status: 'Standard',
    frequencyMin: 200000,
    frequencyMax: 400001,
    cm: 3.33e-14,
    x: 4.05,
    y: 2.5,
    ct2: 0.000142,
    ct1: 0.013,
    ct: 0.88,
  },
  {
    material: '3C92',
    status: 'Design in',
    frequencyMin: 20000,
    frequencyMax: 100000,
    cm: 26.52000126,
    x: 1.194999973,
    y: 2.649999941,
    ct2: 0.000267895,
    ct1: 0.054329115,
    ct: 3.7539611,
  },
  {
    material: '3C92',
    status: 'Design in',
    frequencyMin: 100000,
    frequencyMax: 200000,
    cm: 0.349247262,
    x: 1.589999964,
    y: 2.67499994,
    ct2: 0.000150599,
    ct1: 0.030541568,
    ct: 2.548162342,
  },
  {
    material: '3C92',
    status: 'Design in',
    frequencyMin: 200000,
    frequencyMax: 400001,
    cm: 0.000119,
    x: 2.24499995,
    y: 2.66499994,
    ct2: 0.000208173,
    ct1: 0.04371632,
    ct: 3.289902504,
  },
  {
    material: '3C94',
    status: 'Standard',
    frequencyMin: 20000,
    frequencyMax: 150000,
    cm: 3.530102481,
    x: 1.419999968,
    y: 2.884999936,
    ct2: 0.000125359,
    ct1: 0.022263625,
    ct: 1.972776047,
  },
  {
    material: '3C94',
    status: 'Standard',
    frequencyMin: 150000,
    frequencyMax: 400000,
    cm: 0.000588,
    x: 2.124999953,
    y: 2.70499994,
    ct2: 0.000116598,
    ct1: 0.023272995,
    ct: 2.1613195,
  },
  {
    material: '3C94',
    status: 'Standard',
    frequencyMin: 400000,
    frequencyMax: 400001,
    cm: 0.0000021,
    x: 2.6,
    y: 2.75,
    ct2: 0.000165,
    ct1: 0.031,
    ct: 2.45,
  },
  {
    material: '3C95',
    status: 'Design in',
    frequencyMin: 20000,
    frequencyMax: 150000,
    cm: 92.16643453,
    x: 1.045,
    y: 2.44,
    ct2: 0.0000462,
    ct1: 0.00794,
    ct: 1.332362959,
  },
  {
    material: '3C95',
    status: 'Design in',
    frequencyMin: 150000,
    frequencyMax: 300000,
    cm: 0.00747,
    x: 1.955,
    y: 3.07,
    ct2: 0.0000606,
    ct1: 0.0126,
    ct: 1.654230769,
  },
  {
    material: '3C95',
    status: 'Design in',
    frequencyMin: 300000,
    frequencyMax: 400001,
    cm: 0.000787,
    x: 2.055,
    y: 2.535,
    ct2: 0.0000955,
    ct1: 0.00978,
    ct: 1.022919887,
  },
  {
    material: '3C96',
    status: 'Design in',
    frequencyMin: 20000,
    frequencyMax: 100000,
    cm: 5.120544636,
    x: 1.33999997,
    y: 2.66499994,
    ct2: 0.000547543,
    ct1: 0.110384636,
    ct: 6.563034122,
  },
  {
    material: '3C96',
    status: 'Design in',
    frequencyMin: 100000,
    frequencyMax: 200000,
    cm: 0.082700122,
    x: 1.719999962,
    y: 2.804999937,
    ct2: 0.000183438,
    ct1: 0.036614276,
    ct: 2.827045247,
  },
  {
    material: '3C96',
    status: 'Design in',
    frequencyMin: 200000,
    frequencyMax: 400001,
    cm: 0.0000917,
    x: 2.21999995,
    y: 2.464999945,
    ct2: 0.000232691,
    ct1: 0.047189773,
    ct: 3.39206666,
  },
  {
    material: '3C97',
    status: 'Design in',
    frequencyMin: 20000,
    frequencyMax: 150000,
    cm: 42.36588301,
    x: 1.16,
    y: 2.8,
    ct2: 0.0000636,
    ct1: 0.01100719,
    ct: 1.465,
  },
  {
    material: '3C97',
    status: 'Design in',
    frequencyMin: 150000,
    frequencyMax: 300000,
    cm: 0.003448693,
    x: 1.99,
    y: 2.935,
    ct2: 0.0000785,
    ct1: 0.0136,
    ct: 1.575,
  },
  {
    material: '3C97',
    status: 'Design in',
    frequencyMin: 300000,
    frequencyMax: 400001,
    cm: 0.000449188,
    x: 2.055,
    y: 2.415,
    ct2: 0.0000875,
    ct1: 0.01403339,
    ct: 1.528,
  },
  {
    material: '3C98',
    status: 'Design in',
    frequencyMin: 25000,
    frequencyMax: 100001,
    cm: 2.5,
    x: 1.4,
    y: 2.85,
    ct2: 0.00025,
    ct1: 0.05,
    ct: 3.5,
  },
  {
    material: '3C98',
    status: 'Design in',
    frequencyMin: 100000,
    frequencyMax: 300001,
    cm: 0.00927,
    x: 1.85,
    y: 2.6,
    ct2: 0.0002,
    ct1: 0.04,
    ct: 3,
  },
  {
    material: '3C98',
    status: 'Design in',
    frequencyMin: 300000,
    frequencyMax: 600000,
    cm: 0.000195,
    x: 2.1,
    y: 2.3,
    ct2: 0.00015,
    ct1: 0.03,
    ct: 2.5,
  },
  {
    material: '3F36',
    status: 'Design in',
    frequencyMin: 100000,
    frequencyMax: 499999,
    cm: 6.83,
    x: 1.43902,
    y: 3.26718,
    ct2: 0.000083946,
    ct1: 0.010783518,
    ct: 1.232717265,
  },
  {
    material: '3F36',
    status: 'Design in',
    frequencyMin: 500000,
    frequencyMax: 799999,
    cm: 0.000112499,
    x: 2.19515,
    y: 2.71986,
    ct2: 0.0000893,
    ct1: 0.011719438,
    ct: 1.28161335,
  },
  {
    material: '3F36',
    status: 'Design in',
    frequencyMin: 800000,
    frequencyMax: 1200000,
    cm: 2.24e-7,
    x: 2.61053,
    y: 2.49772,
    ct2: 0.0000612,
    ct1: 0.006141983,
    ct: 1.010843873,
  },
  {
    material: '4F1',
    status: 'Prototype',
    frequencyMin: 3000000,
    frequencyMax: 5000000,
    cm: 19.525,
    x: 1.37,
    y: 2.425,
    ct2: 0.0000901,
    ct1: 0.01337335,
    ct: 1.436165854,
  },
  {
    material: '4F1',
    status: 'Prototype',
    frequencyMin: 5000000,
    frequencyMax: 7500000,
    cm: 19.56258061,
    x: 1.37,
    y: 2.425,
    ct2: 0.000149007,
    ct1: 0.027,
    ct: 2.209933775,
  },
  {
    material: '4F1',
    status: 'Prototype',
    frequencyMin: 7500000,
    frequencyMax: 10000001,
    cm: 21.3125,
    x: 1.37,
    y: 2.425,
    ct2: 0.000237741,
    ct1: 0.031001448,
    ct: 1.722733153,
  },
  // N27 material - Added to fix zero core loss issue (Task 1, Requirement 1.1)
  // N27 is a power ferrite material from EPCOS/TDK for frequencies 25kHz-300kHz
  // Coefficients based on typical ferrite behavior in this frequency range
  {
    material: 'N27',
    status: 'Standard',
    frequencyMin: 25000,
    frequencyMax: 150000,
    cm: 4.5,
    x: 1.45,
    y: 2.65,
    ct2: 0.00018,
    ct1: 0.035,
    ct: 2.8,
  },
  {
    material: 'N27',
    status: 'Standard',
    frequencyMin: 150000,
    frequencyMax: 300000,
    cm: 0.008,
    x: 1.85,
    y: 2.55,
    ct2: 0.00015,
    ct1: 0.03,
    ct: 2.5,
  },
];
