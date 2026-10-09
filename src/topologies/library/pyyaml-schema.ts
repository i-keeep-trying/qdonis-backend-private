import {
  isScalar,
  parseDocument,
  visit,
  type ScalarTag,
  type Tags,
} from 'yaml';
import type { JsonValue } from '../../ai/bedrock/bedrock.types';
import { AssetValidationError } from '../../common/assets/asset-manifest';

/**
 * YAML parsing with PyYAML 6 `safe_load` scalar semantics (YAML 1.1 with
 * PyYAML's own implicit resolvers). The difference that matters: a float
 * needs a dot, so plain `1e5` / `10e-6` stay strings, as the core returned
 * them. Only plain scalars are resolved; quoted scalars stay strings.
 */

const TAG = 'tag:yaml.org,2002:';
const REPLACED = new Set(
  ['bool', 'int', 'float', 'null', 'timestamp'].map((name) => TAG + name),
);

const BOOL_TRUE = /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/;
const BOOL =
  /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const INT =
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const FLOAT =
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const NULL = /^(?:~|null|Null|NULL|)$/;
const TIMESTAMP =
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;

/** Port of `SafeConstructor.construct_yaml_int`. */
function constructInt(text: string, onError: (message: string) => void) {
  let value = text.replace(/_/g, '');
  const sign = value[0] === '-' ? -1n : 1n;
  if (value[0] === '-' || value[0] === '+') value = value.slice(1);
  if (value === '0') return 0;
  let result = 0n;
  try {
    // BigInt rejects an empty digit string, as Python's int() does.
    if (value.startsWith('0b')) result = BigInt(`0b${value.slice(2)}`);
    else if (value.startsWith('0x')) result = BigInt(`0x${value.slice(2)}`);
    else if (value[0] === '0') result = BigInt(`0o${value.slice(1)}`);
    else if (value.includes(':')) {
      let base = 1n;
      for (const part of value.split(':').reverse()) {
        result += BigInt(part) * base;
        base *= 60n;
      }
    } else result = BigInt(value);
  } catch {
    onError(`invalid integer ${text}`);
    return text;
  }
  const number = Number(sign * result);
  if (!Number.isSafeInteger(number)) {
    onError(`integer ${text} is outside the safe JSON range`);
  }
  return number;
}

/** Port of `SafeConstructor.construct_yaml_float`; non-finite is an error. */
function constructFloat(text: string, onError: (message: string) => void) {
  let value = text.replace(/_/g, '').toLowerCase();
  const sign = value[0] === '-' ? -1 : 1;
  if (value[0] === '-' || value[0] === '+') value = value.slice(1);
  let result: number;
  if (value === '.inf') result = sign * Infinity;
  else if (value === '.nan') result = Number.NaN;
  else if (value.includes(':')) {
    result = 0;
    let base = 1;
    for (const part of value.split(':').reverse()) {
      result += Number(part) * base;
      base *= 60;
    }
    result *= sign;
  } else result = sign * Number(value);
  if (!Number.isFinite(result)) {
    onError(`non-finite float ${text} cannot be represented in JSON`);
  }
  return result;
}

const scalarTag = (
  name: string,
  test: RegExp,
  resolve: ScalarTag['resolve'],
): ScalarTag => ({ tag: TAG + name, default: true, test, resolve });

const PYYAML_SCALARS: ScalarTag[] = [
  scalarTag('bool', BOOL, (text) => BOOL_TRUE.test(text)),
  scalarTag('float', FLOAT, (text, onError) => constructFloat(text, onError)),
  scalarTag('int', INT, (text, onError) => constructInt(text, onError)),
  scalarTag('null', NULL, () => null),
  scalarTag('timestamp', TIMESTAMP, (text, onError) => {
    onError(`unsupported YAML timestamp ${text}`);
    return text;
  }),
];

const customTags = (tags: Tags): Tags => [
  ...tags.filter((tag) => typeof tag === 'string' || !REPLACED.has(tag.tag)),
  ...PYYAML_SCALARS,
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Throws unless `value` is made only of plain JSON values. */
function assertJson(value: unknown, path: string, where: string): void {
  if (value === null || typeof value === 'string') return;
  if (typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AssetValidationError(path, `non-finite number at ${where}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertJson(item, path, `${where}[${index}]`),
    );
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertJson(item, path, `${where}.${key}`);
    }
    return;
  }
  throw new AssetValidationError(path, `non-JSON value at ${where}`);
}

/**
 * `yaml.safe_load(text)` for a reference asset. Throws
 * {@link AssetValidationError} on any parse error, on a non-string or
 * integer-like mapping key, and on values JSON cannot carry.
 */
export function parsePyYaml(text: string, path: string): JsonValue {
  const doc = parseDocument(text, {
    version: '1.1',
    schema: 'yaml-1.1',
    merge: true,
    uniqueKeys: false,
    strict: true,
    prettyErrors: true,
    customTags,
  });
  if (doc.errors.length > 0) {
    throw new AssetValidationError(path, doc.errors[0].message);
  }
  visit(doc, {
    Pair: (_, pair) => {
      const key = pair.key;
      if (
        isScalar(key) &&
        typeof key.value === 'symbol' &&
        key.value.description === '<<'
      ) {
        return;
      }
      if (
        !isScalar(key) ||
        typeof key.value !== 'string' ||
        /^(0|[1-9][0-9]*)$/.test(key.value)
      ) {
        const shown = isScalar(key) ? String(key.value) : String(key);
        throw new AssetValidationError(
          path,
          `mapping key ${JSON.stringify(shown)} must be a non-numeric string`,
        );
      }
    },
  });
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new AssetValidationError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  assertJson(value, path, '$');
  return value as JsonValue;
}
