import type { HttpException } from '@nestjs/common';
import type { JsonObject } from '../ai/bedrock/bedrock.types';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { jsonText } from '../common/python/python-semantics';

export type { JsonObject, JsonValue } from '../ai/bedrock/bedrock.types';

export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** The built-in topology library, loaded and frozen at boot. */
export interface TopologyCatalog {
  /** json_library stems in code-unit order (= Python `sorted()`). */
  ids: readonly string[];
  /** Primitive YAML per id (`yaml.safe_load` result), deep-frozen. */
  definitions: ReadonlyMap<string, DeepReadonly<JsonObject>>;
  /** Static schematic JSON per id, deep-frozen. */
  schematics: ReadonlyMap<string, DeepReadonly<JsonObject>>;
  /** Raw YAML text per id (re-parsed with Python int/float types for the netlist generator). */
  sources: ReadonlyMap<string, string>;
}

export type TopologyFamily = 'DC-DC' | 'AC-DC' | 'DC-AC' | 'Other';

/** One row of `GET /topologies` (the qdonis-web topology picker). */
export interface TopologyLibraryEntry {
  id: string;
  title: string;
  family: TopologyFamily;
}

/** 404 `TOPOLOGY_NOT_FOUND` with the (truncated) requested name. */
export function topologyNotFound(name: unknown): HttpException {
  const shown = jsonText(name);
  return AppError.notFound(
    ErrorCode.TopologyNotFound,
    `Topology '${shown.length > 256 ? shown.slice(0, 256) : shown}' not found`,
  );
}
