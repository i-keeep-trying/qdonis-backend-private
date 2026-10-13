// Ported verbatim from the old frontend; keep numerically identical (see specs).
/**
 * Material Properties Data
 *
 * This file contains magnetic material properties for various ferrite and powder core materials.
 * Data migrated from Python hardcoded data in magnetics_designer.py
 *
 * Properties include saturation flux density, initial permeability, and coercivity.
 */

/**
 * Material properties specification
 */
export interface MaterialProperties {
  /** Saturation flux density in Tesla (T) */
  saturationB: number;
  /** Initial relative permeability (dimensionless) */
  initialPermeability: number;
  /** Coercivity in A/m */
  coercivity: number;
  /** Saturation H field in A/m (used for permeability curves) */
  saturationH: number;
}

/**
 * Material properties data for all available materials
 *
 * Data source: magnetics_designer.py from Python implementation
 * Contains 16 materials with their magnetic properties
 *
 * Materials include:
 * - Ferroxcube 3C series (3C90, 3C91, 3C92, 3C94, 3C95, 3C96, 3C97, 3C98)
 * - Ferroxcube 3F and 4F series (3F36, 4F1)
 * - EPCOS/TDK N series (N87, N27, N30)
 * - Powder cores (MPP, HighFlux, Sendust)
 */
export const MATERIAL_PROPERTIES: Record<string, MaterialProperties> = {
  '3C90': {
    saturationB: 0.47,
    initialPermeability: 2300,
    coercivity: 12,
    saturationH: 100,
  },
  '3C91': {
    saturationB: 0.47,
    initialPermeability: 3000,
    coercivity: 15,
    saturationH: 120,
  },
  '3C92': {
    saturationB: 0.54,
    initialPermeability: 1500,
    coercivity: 13,
    saturationH: 110,
  },
  '3C94': {
    saturationB: 0.47,
    initialPermeability: 2300,
    coercivity: 11,
    saturationH: 100,
  },
  '3C95': {
    saturationB: 0.53,
    initialPermeability: 3000,
    coercivity: 14,
    saturationH: 115,
  },
  '3C96': {
    saturationB: 0.5,
    initialPermeability: 2000,
    coercivity: 13,
    saturationH: 110,
  },
  '3C97': {
    saturationB: 0.53,
    initialPermeability: 3000,
    coercivity: 12,
    saturationH: 100,
  },
  '3C98': {
    saturationB: 0.53,
    initialPermeability: 2500,
    coercivity: 13,
    saturationH: 110,
  },
  '3F36': {
    saturationB: 0.52,
    initialPermeability: 1600,
    coercivity: 13,
    saturationH: 110,
  },
  '4F1': {
    saturationB: 0.32,
    initialPermeability: 80,
    coercivity: 45,
    saturationH: 250,
  },
  N87: {
    saturationB: 0.4,
    initialPermeability: 2200,
    coercivity: 12,
    saturationH: 100,
  },
  N27: {
    saturationB: 0.4,
    initialPermeability: 1500,
    coercivity: 15,
    saturationH: 120,
  },
  N30: {
    saturationB: 0.4,
    initialPermeability: 3000,
    coercivity: 10,
    saturationH: 90,
  },
  MPP: {
    saturationB: 0.7,
    initialPermeability: 60,
    coercivity: 40,
    saturationH: 200,
  },
  HighFlux: {
    saturationB: 1.5,
    initialPermeability: 160,
    coercivity: 30,
    saturationH: 150,
  },
  Sendust: {
    saturationB: 1.0,
    initialPermeability: 125,
    coercivity: 35,
    saturationH: 180,
  },
};
