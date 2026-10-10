// Ported verbatim from the old frontend; keep numerically identical (see specs).
/**
 * Core Geometry Data
 *
 * This file contains core geometry specifications for various magnetic core types.
 * Data migrated from Python CSV: Core geometry.csv
 *
 * All measurements are in millimeters (mm) and square millimeters (mm²).
 * Effective volume Ve = Ae × le (in mm³)
 */

/**
 * Core geometry specification
 */
export interface CoreGeometry {
  /** Effective magnetic path length in mm */
  effectiveLength: number;
  /** Effective cross-sectional area in mm² */
  effectiveArea: number;
  /** Effective volume in mm³ (Ve = Ae × le) */
  effectiveVolume: number;
  /** Window area in mm² (for winding calculation) */
  windowArea?: number;
  /** Mean length per turn in mm */
  meanLengthPerTurn?: number;
}

/**
 * Core geometry data for all available core types
 *
 * Data source: Core geometry.csv from Python implementation
 * Contains core types with their effective length, area, and volume specifications
 *
 * Effective Volume (Ve) is critical for core loss calculations:
 * Pcore = k × f^α × B^β × Ve (Steinmetz equation)
 */
export const CORE_GEOMETRY_DATA: Record<string, CoreGeometry> = {
  // EF-Series Cores (Economical Ferrite)
  'EF16/8/5': {
    effectiveLength: 37.6,
    effectiveArea: 20.1,
    effectiveVolume: 756, // Ve = 37.6 × 20.1 = ~756 mm³
    windowArea: 12.0,
    meanLengthPerTurn: 22.0,
  },
  'EF20/10/6': {
    effectiveLength: 46,
    effectiveArea: 32,
    effectiveVolume: 1472, // Ve = 46 × 32 = 1472 mm³
    windowArea: 22.0,
    meanLengthPerTurn: 30.0,
  },
  'EF25/13/7': {
    effectiveLength: 58,
    effectiveArea: 52,
    effectiveVolume: 3016, // Ve = 58 × 52 = 3016 mm³
    windowArea: 32.0,
    meanLengthPerTurn: 28.0,
  },
  'EF32/16/9': {
    effectiveLength: 74,
    effectiveArea: 83,
    effectiveVolume: 6142, // Ve = 74 × 83 = 6142 mm³
    windowArea: 60.0,
    meanLengthPerTurn: 40.0,
  },

  // E-Series Cores (Standard E-cores)
  'E42/21/20': {
    effectiveLength: 97,
    effectiveArea: 233,
    effectiveVolume: 22601, // Ve = 97 × 233 = 22601 mm³
    windowArea: 125.0,
    meanLengthPerTurn: 73.0,
  },
  'E55/28/21': {
    effectiveLength: 122,
    effectiveArea: 353,
    effectiveVolume: 43066, // Ve = 122 × 353 = 43066 mm³
    windowArea: 180.0,
    meanLengthPerTurn: 90.0,
  },
  'E65/32/27': {
    effectiveLength: 147,
    effectiveArea: 530,
    effectiveVolume: 77910, // Ve = 147 × 530 = 77910 mm³
    windowArea: 240.0,
    meanLengthPerTurn: 105.0,
  },

  // RM-Series Cores (Round Middle Leg)
  'RM6/I': {
    effectiveLength: 29.2,
    effectiveArea: 37,
    effectiveVolume: 1080, // Ve = 29.2 × 37 = ~1080 mm³
    windowArea: 9.0,
    meanLengthPerTurn: 14.0,
  },
  'RM7/I': {
    effectiveLength: 30,
    effectiveArea: 44.1,
    effectiveVolume: 1323, // Ve = 30 × 44.1 = 1323 mm³
    windowArea: 12.0,
    meanLengthPerTurn: 16.0,
  },
  'RM8/I': {
    effectiveLength: 38.4,
    effectiveArea: 63,
    effectiveVolume: 2419, // Ve = 38.4 × 63 = ~2419 mm³
    windowArea: 15.9,
    meanLengthPerTurn: 18.0,
  },
  RM12I: {
    effectiveLength: 56.6,
    effectiveArea: 146,
    effectiveVolume: 8264, // Ve = 56.6 × 146 = ~8264 mm³
    windowArea: 35.0,
    meanLengthPerTurn: 26.0,
  },
  RM14I: {
    effectiveLength: 70,
    effectiveArea: 198,
    effectiveVolume: 13860, // Ve = 70 × 198 = 13860 mm³
    windowArea: 50.0,
    meanLengthPerTurn: 30.0,
  },

  // EP-Series Cores (Economical Planar)
  EP10: {
    effectiveLength: 19.3,
    effectiveArea: 11.3,
    effectiveVolume: 218, // Ve = 19.3 × 11.3 = ~218 mm³
    windowArea: 8.0,
    meanLengthPerTurn: 12.0,
  },
  EP13: {
    effectiveLength: 25.5,
    effectiveArea: 18.8,
    effectiveVolume: 479, // Ve = 25.5 × 18.8 = ~479 mm³
    windowArea: 11.5,
    meanLengthPerTurn: 15.0,
  },
  EP17: {
    effectiveLength: 37.8,
    effectiveArea: 37.5,
    effectiveVolume: 1418, // Ve = 37.8 × 37.5 = ~1418 mm³
    windowArea: 20.0,
    meanLengthPerTurn: 20.0,
  },

  // PQ-Series Cores (Power Quality)
  PQ2020: {
    effectiveLength: 45.7,
    effectiveArea: 62.6,
    effectiveVolume: 2861, // Ve = 45.7 × 62.6 = ~2861 mm³
    windowArea: 28.0,
    meanLengthPerTurn: 31.0,
  },
  PQ2620: {
    effectiveLength: 45,
    effectiveArea: 121,
    effectiveVolume: 5445, // Ve = 45 × 121 = 5445 mm³
    windowArea: 48.0,
    meanLengthPerTurn: 38.0,
  },
  PQ2625: {
    effectiveLength: 54.3,
    effectiveArea: 120,
    effectiveVolume: 6516, // Ve = 54.3 × 120 = 6516 mm³
    windowArea: 54.0,
    meanLengthPerTurn: 42.0,
  },
  PQ3230: {
    effectiveLength: 74.7,
    effectiveArea: 167,
    effectiveVolume: 12475, // Ve = 74.7 × 167 = ~12475 mm³
    windowArea: 85.0,
    meanLengthPerTurn: 48.0,
  },
  PQ3535: {
    effectiveLength: 87.4,
    effectiveArea: 196,
    effectiveVolume: 17130, // Ve = 87.4 × 196 = ~17130 mm³
    windowArea: 150.0,
    meanLengthPerTurn: 57.0,
  },
  PQ4040: {
    effectiveLength: 102,
    effectiveArea: 201,
    effectiveVolume: 20502, // Ve = 102 × 201 = 20502 mm³
    windowArea: 180.0,
    meanLengthPerTurn: 65.0,
  },

  // ETD-Series Cores (Economical Transformer Design)
  ETD29: {
    effectiveLength: 72,
    effectiveArea: 76,
    effectiveVolume: 5472, // Ve = 72 × 76 = 5472 mm³
    windowArea: 95.0,
    meanLengthPerTurn: 52.0,
  },
  ETD34: {
    effectiveLength: 78.6,
    effectiveArea: 97.1,
    effectiveVolume: 7632, // Ve = 78.6 × 97.1 = ~7632 mm³
    windowArea: 120.0,
    meanLengthPerTurn: 58.0,
  },
  ETD39: {
    effectiveLength: 92.2,
    effectiveArea: 125,
    effectiveVolume: 11525, // Ve = 92.2 × 125 = 11525 mm³
    windowArea: 150.0,
    meanLengthPerTurn: 68.0,
  },
  ETD44: {
    effectiveLength: 103,
    effectiveArea: 173,
    effectiveVolume: 17819, // Ve = 103 × 173 = 17819 mm³
    windowArea: 180.0,
    meanLengthPerTurn: 78.0,
  },
  ETD49: {
    effectiveLength: 114,
    effectiveArea: 211,
    effectiveVolume: 24054, // Ve = 114 × 211 = 24054 mm³
    windowArea: 220.0,
    meanLengthPerTurn: 88.0,
  },
};

/**
 * Get effective volume for a core geometry
 * @param coreType - Core type designation (e.g., "EF16/8/5")
 * @returns Effective volume in mm³, or null if not found
 */
export function getEffectiveVolume(coreType: string): number | null {
  const geometry = CORE_GEOMETRY_DATA[coreType];
  return geometry ? geometry.effectiveVolume : null;
}

/**
 * Get all available core types
 * @returns Array of core type names
 */
export function getAvailableCoreTypes(): string[] {
  return Object.keys(CORE_GEOMETRY_DATA);
}

/**
 * Filter core geometries by power level
 * @param powerWatts - Target power in watts
 * @returns Array of suitable core types
 */
export function getCoresByPowerLevel(powerWatts: number): string[] {
  const coreTypes = Object.entries(CORE_GEOMETRY_DATA);

  // Power-to-volume rough mapping (based on typical power handling)
  // Very approximate: ~5W per 1000mm³ of effective volume
  const minVolume = (powerWatts / 5) * 1000 * 0.5; // Lower bound
  const maxVolume = (powerWatts / 5) * 1000 * 3; // Upper bound with margin

  return coreTypes
    .filter(
      ([_, data]) =>
        data.effectiveVolume >= minVolume && data.effectiveVolume <= maxVolume,
    )
    .map(([name, _]) => name);
}
