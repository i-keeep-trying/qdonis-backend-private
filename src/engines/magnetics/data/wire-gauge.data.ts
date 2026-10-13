// Ported verbatim from the old frontend; keep numerically identical (see specs).
/**
 * Wire Gauge Data
 *
 * This file contains conductor cross-sectional area data for AWG (American Wire Gauge) sizes.
 * Data migrated from Python hardcoded data in magnetics_designer.py
 *
 * All areas are in square millimeters (mm²).
 */

/**
 * Wire gauge conductor area data
 *
 * Data source: magnetics_designer.py from Python implementation
 * Contains AWG 10-24 conductor cross-sectional areas in mm²
 *
 * These values are used for:
 * - Wire resistance calculations
 * - Fill factor calculations
 * - Current density calculations
 */
export const WIRE_GAUGE_DATA: Record<string, number> = {
  'AWG 10': 5.26,
  'AWG 12': 3.31,
  'AWG 14': 2.08,
  'AWG 16': 1.31,
  'AWG 18': 0.823,
  'AWG 20': 0.518,
  'AWG 22': 0.326,
  'AWG 24': 0.205,
};
