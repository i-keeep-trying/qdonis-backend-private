import {
  loadVerifiedSubtree,
  readManifest,
} from '../../common/assets/asset-manifest';
import {
  DEVICE_KINDS,
  KIND_TYPE,
  type CataloguePart,
  type DeviceKind,
  type DeviceLibrary,
  type DeviceModel,
} from '../devices.types';
import { currentFromPart, partFamily, voltageFromPart } from './part-ratings';

const LIBRARY = 'models/library/';
const USABLE_TYPES = new Set(['MOSFET with Diode', 'IGBT', 'Diode']);

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const toNumber = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Reads the device model library (loss LUT JSONs) and derives the two
 * listings the core served: per-kind models and the usable-part catalogue.
 * Extracted MOSFET body diodes (`*_bodydiode`) are skipped in both, and an
 * unreadable file is skipped like the core did.
 */
export async function loadDeviceLibrary(root: string): Promise<DeviceLibrary> {
  const manifest = await readManifest(root);
  const files = await loadVerifiedSubtree(root, manifest, LIBRARY);

  const models: Record<DeviceKind, DeviceModel[]> = {
    mosfet: [],
    diode: [],
    igbt: [],
  };
  const catalogue: CataloguePart[] = [];

  for (const path of [...files.keys()].sort(byCodeUnit)) {
    if (!path.endsWith('.json')) continue;
    const stem = path.slice(path.lastIndexOf('/') + 1, -'.json'.length);
    if (stem.toLowerCase().endsWith('_bodydiode')) continue;
    let metadata: Record<string, unknown>;
    try {
      const doc = JSON.parse(
        (files.get(path) as Buffer).toString('utf8'),
      ) as Record<string, unknown>;
      metadata =
        typeof doc.metadata === 'object' && doc.metadata !== null
          ? (doc.metadata as Record<string, unknown>)
          : {};
    } catch {
      continue;
    }
    const type = typeof metadata.type === 'string' ? metadata.type : '';

    for (const kind of DEVICE_KINDS) {
      if (KIND_TYPE[kind] === type) {
        models[kind].push({
          part_number: stem,
          type,
          v_rating: metadata.voltage_rating_V ?? 0,
          i_rating: metadata.current_rating_A ?? 0,
        });
      }
    }

    if (USABLE_TYPES.has(type)) {
      const iLut = toNumber(metadata.current_rating_A);
      const iRating = currentFromPart(stem) || iLut;
      catalogue.push({
        part: stem,
        type,
        kind: type === 'Diode' ? 'diode' : 'switch',
        family: partFamily(stem, type, metadata.technology),
        v_rating: voltageFromPart(stem) || toNumber(metadata.voltage_rating_V),
        i_rating: iRating,
        i_lut: iLut || iRating,
      });
    }
  }

  for (const kind of DEVICE_KINDS) {
    models[kind].sort((a, b) => byCodeUnit(a.part_number, b.part_number));
  }
  return { models, catalogue, files: files.size };
}
