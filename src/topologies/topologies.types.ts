import type { HttpException } from '@nestjs/common';
import type { JsonObject } from '../ai/bedrock/bedrock.types';
import { AppError, ErrorCode } from '../common/errors/error-codes';

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
  definitions: ReadonlyMap<string, JsonObject>;
  /** Static schematic JSON per id, deep-frozen. */
  schematics: ReadonlyMap<string, DeepReadonly<JsonObject>>;
}

/** 404 `TOPOLOGY_NOT_FOUND` with the (truncated) requested name. */
export function topologyNotFound(name: unknown): HttpException {
  const shown = typeof name === 'string' ? name : String(name ?? '');
  return AppError.notFound(
    ErrorCode.TopologyNotFound,
    `Topology '${shown.length > 256 ? shown.slice(0, 256) : shown}' not found`,
  );
}
