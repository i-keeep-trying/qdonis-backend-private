import {
  AssetValidationError,
  loadVerifiedSubtree,
  readManifest,
} from '../../common/assets/asset-manifest';
import type {
  DeepReadonly,
  JsonObject,
  TopologyCatalog,
} from '../topologies.types';
import { parsePyYaml } from './pyyaml-schema';

const PRIMITIVES = 'topologies/primitives/';
const SCHEMATICS = 'topologies/json_library/';

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

const stem = (path: string, prefix: string, ext: RegExp) =>
  path.slice(prefix.length).replace(ext, '');

/**
 * Loads the 35 topology YAMLs and their static schematics from the verified
 * assets. Every id needs both files; a missing partner, a non-object
 * document or a broken component list fails the boot.
 */
export async function loadTopologyCatalog(
  root: string,
): Promise<TopologyCatalog> {
  const manifest = await readManifest(root);
  const [yamls, jsons] = await Promise.all([
    loadVerifiedSubtree(root, manifest, PRIMITIVES),
    loadVerifiedSubtree(root, manifest, SCHEMATICS),
  ]);

  const definitions = new Map<string, DeepReadonly<JsonObject>>();
  const sources = new Map<string, string>();
  for (const [path, bytes] of yamls) {
    const id = stem(path, PRIMITIVES, /\.ya?ml$/);
    const text = bytes.toString('utf8');
    sources.set(id, text);
    const doc = parsePyYaml(text, path);
    if (!isObject(doc)) throw new AssetValidationError(path, 'not a mapping');
    if (doc.components !== undefined && !Array.isArray(doc.components)) {
      throw new AssetValidationError(path, '`components` is not a list');
    }
    definitions.set(id, deepFreeze(doc));
  }

  const schematics = new Map<string, DeepReadonly<JsonObject>>();
  for (const [path, bytes] of jsons) {
    const id = stem(path, SCHEMATICS, /\.json$/);
    let doc: unknown;
    try {
      doc = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new AssetValidationError(path, 'invalid JSON');
    }
    if (!isObject(doc) || !Array.isArray(doc.components)) {
      throw new AssetValidationError(path, 'schematic has no `components`');
    }
    if (!definitions.has(id)) {
      throw new AssetValidationError(path, `no ${PRIMITIVES}${id}.yaml`);
    }
    schematics.set(id, deepFreeze(doc));
  }
  for (const id of definitions.keys()) {
    if (!schematics.has(id)) {
      throw new AssetValidationError(
        `${PRIMITIVES}${id}.yaml`,
        `no ${SCHEMATICS}${id}.json`,
      );
    }
  }

  // Python `sorted()` order: plain code-unit comparison.
  const ids = [...schematics.keys()].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return { ids: Object.freeze(ids), definitions, schematics, sources };
}
