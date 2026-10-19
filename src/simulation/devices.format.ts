/**
 * Device selection: qdonis-core result -> qdonis-web `DeviceSelection`
 * (`src/features/studio/types/devices.ts`).
 */

import {
  catalogue,
  type Overrides,
  type Preference,
  type SelectionResult,
} from './loss/device-selection';
import type { Dict } from './netlist/py';

export interface DevicePart {
  part: string;
  manufacturer: string;
  type: 'MOSFET' | 'IGBT' | 'Diode';
  family: string;
  vRatingV: number;
  iRatingA: number | null;
  diode: string | null;
  lossW: number;
}

export interface DeviceChoice {
  ref: string;
  kind: 'switch' | 'diode';
  stress: { vPeakV: number; iPeakA: number; iRmsA: number; fswKhz: number };
  selected: DevicePart | null;
  reason: string | null;
  alternatives: DevicePart[];
  /** The user picked this part (kept on re-selection). */
  forced: boolean;
}

/** Web selection plus the models the loss engine used (`component_models`). */
export interface DeviceSelection {
  selections: DeviceChoice[];
  junctionC: number;
  preference: Preference;
  basis: string;
  component_models: Record<string, string>;
}

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;
const rec = (v: unknown): Dict =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Dict) : {};

const manufacturer = (family: string): string =>
  /IGBT|Si diode/.test(family) ? 'Dynex' : 'Wolfspeed';

const partType = (type: unknown): DevicePart['type'] =>
  type === 'IGBT' ? 'IGBT' : type === 'Diode' ? 'Diode' : 'MOSFET';

function devicePart(raw: unknown): DevicePart | null {
  const p = rec(raw);
  if (typeof p.part !== 'string') return null;
  const family = typeof p.family === 'string' ? p.family : '';
  const known = catalogue().find((c) => c.part === p.part);
  const iRating = typeof p.i_rating === 'number' ? p.i_rating : known?.i_rating;
  return {
    part: p.part,
    manufacturer: manufacturer(family),
    type: partType(p.type),
    family,
    vRatingV: num(p.v_rating),
    iRatingA: iRating ? iRating : null,
    diode: typeof p.diode === 'string' ? p.diode : null,
    lossW: num(p.loss_w),
  };
}

const BASIS: Record<string, string> = {
  'simulated waveforms': 'Simulated waveforms',
  'idealised waveforms from the entered stresses':
    'Entered stresses (idealised waveforms)',
};

export function deviceSelectionView(result: SelectionResult): DeviceSelection {
  return {
    junctionC: result.tj,
    preference: result.preference,
    basis: BASIS[result.basis] ?? result.basis,
    component_models: result.component_models,
    selections: result.selections.map((raw) => {
      const s = rec(raw);
      const stress = rec(s.stress);
      return {
        ref: String(s.ref),
        kind: s.kind === 'diode' ? 'diode' : 'switch',
        stress: {
          vPeakV: num(stress.v_peak),
          iPeakA: num(stress.i_peak),
          iRmsA: num(stress.i_rms),
          fswKhz: num(stress.fsw) / 1e3,
        },
        selected: devicePart(s.selected),
        reason:
          typeof s.reason === 'string'
            ? s.reason
            : typeof s.note === 'string'
              ? s.note
              : null,
        alternatives: (Array.isArray(s.alternatives) ? s.alternatives : [])
          .map(devicePart)
          .filter((p): p is DevicePart => p !== null),
        forced: s.forced === true,
      };
    }),
  };
}

/**
 * Forced choices of an earlier selection, so a re-selection keeps them
 * (old frontend `priorOverrides`), then the new `overrides` on top.
 */
export function mergeOverrides(
  prior: unknown,
  overrides: Record<string, string> | undefined,
): Overrides | null {
  const out: Overrides = {};
  const selections = rec(prior).selections;
  for (const raw of Array.isArray(selections) ? selections : []) {
    const choice = rec(raw);
    const selected = rec(choice.selected);
    if (choice.forced === true && typeof selected.part === 'string') {
      out[String(choice.ref)] = {
        part: selected.part,
        diode: typeof selected.diode === 'string' ? selected.diode : null,
      };
    }
  }
  for (const [ref, part] of Object.entries(overrides ?? {})) out[ref] = part;
  return Object.keys(out).length ? out : null;
}
