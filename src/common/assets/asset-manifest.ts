import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** One copied file, as listed in `assets/MANIFEST.json`. */
export interface AssetManifestEntry {
  /** Relative to `assets/`, forward slashes. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface AssetManifest {
  source: {
    repository: string;
    commit: string;
    branch: string;
    root: string;
  };
  generatedBy: string;
  files: AssetManifestEntry[];
}

export const MANIFEST_FILE = 'MANIFEST.json';

/** Files read concurrently, to stay well below the open-file limit. */
const READ_BATCH = 32;

/** A missing, extra, changed or invalid asset. Always fatal at boot. */
export class AssetValidationError extends Error {
  constructor(path: string, reason: string) {
    super(`Asset validation failed: ${path}: ${reason}`);
    this.name = 'AssetValidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEntry = (value: unknown): value is AssetManifestEntry =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  typeof value.bytes === 'number' &&
  typeof value.sha256 === 'string' &&
  /^[0-9a-f]{64}$/.test(value.sha256);

/** Parses and shape-checks `<root>/MANIFEST.json`. */
export async function readManifest(root: string): Promise<AssetManifest> {
  let text: string;
  try {
    text = await readFile(join(root, MANIFEST_FILE), 'utf8');
  } catch (error) {
    throw new AssetValidationError(
      MANIFEST_FILE,
      `cannot read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AssetValidationError(MANIFEST_FILE, 'invalid JSON');
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.source) ||
    typeof parsed.source.commit !== 'string' ||
    !Array.isArray(parsed.files) ||
    !parsed.files.every(isEntry)
  ) {
    throw new AssetValidationError(MANIFEST_FILE, 'unexpected structure');
  }
  return parsed as unknown as AssetManifest;
}

/** Every file below `dir`, as POSIX paths relative to `root`. */
async function listFiles(root: string, dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, full)));
    else files.push(relative(root, full).split(sep).join('/'));
  }
  return files;
}

/**
 * Reads every file under `<root>/<prefix>` after checking that the files on
 * disk are exactly the manifest entries under `prefix` and that each one has
 * the listed size and SHA-256. Returns relative POSIX path → bytes.
 */
export async function loadVerifiedSubtree(
  root: string,
  manifest: AssetManifest,
  prefix: string,
): Promise<Map<string, Buffer>> {
  const expected = new Map(
    manifest.files
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => [entry.path, entry]),
  );
  // The manifest does not list itself.
  const onDisk = (
    await listFiles(root, join(root, ...prefix.split('/')))
  ).filter((path) => path !== MANIFEST_FILE);
  for (const path of onDisk) {
    if (!expected.has(path)) {
      throw new AssetValidationError(path, 'not listed in the manifest');
    }
  }
  const present = new Set(onDisk);
  for (const path of expected.keys()) {
    if (!present.has(path)) throw new AssetValidationError(path, 'missing');
  }
  const result = new Map<string, Buffer>();
  const paths = [...expected.keys()].sort();
  for (let start = 0; start < paths.length; start += READ_BATCH) {
    const batch = paths.slice(start, start + READ_BATCH);
    const contents = await Promise.all(
      batch.map((path) => readFile(join(root, ...path.split('/')))),
    );
    batch.forEach((path, index) => {
      const bytes = contents[index];
      const entry = expected.get(path) as AssetManifestEntry;
      if (bytes.length !== entry.bytes) {
        throw new AssetValidationError(
          path,
          `size ${bytes.length} does not match the manifest (${entry.bytes})`,
        );
      }
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
        throw new AssetValidationError(path, 'SHA-256 does not match');
      }
      result.set(path, bytes);
    });
  }
  return result;
}
