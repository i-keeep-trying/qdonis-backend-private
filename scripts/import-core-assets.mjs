#!/usr/bin/env node
/**
 * Copies the read-only data assets from a qdonis-core git commit into
 * assets/ byte for byte (git blobs, never the CRLF working tree) and writes
 * assets/MANIFEST.json (path, size, SHA-256).
 *
 *   node scripts/import-core-assets.mjs [--core <path>] [--check]
 *
 * --core   qdonis-core checkout (default: sibling ../qdonis-core of this repo)
 * --check  read-only: every file in assets/ must match MANIFEST.json and the
 *          core blobs; missing, extra or changed files fail.
 *
 * Exit codes: 0 ok, 1 count/hash/content mismatch, 2 commit not found.
 * Core is read through git only and never written.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = '0054f7202abd61e503dbac26ac676431698e66ea';
const BRANCH = 'feature/synced-schematic';
const ROOT = 'qdonis_backend/data';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(REPO_ROOT, 'assets');
const MANIFEST = join(ASSETS, 'MANIFEST.json');

/** Pathspecs (4 directories, 4 files), each with its file filter and expected count. */
const GROUPS = [
  { spec: `${ROOT}/topologies/primitives`, suffix: '.yaml', count: 35 },
  { spec: `${ROOT}/topologies/json_library`, suffix: '.json', count: 35 },
  { spec: `${ROOT}/topologies/prompts`, suffix: '.prompt.md', count: 31 },
  { spec: `${ROOT}/models/library/diode`, suffix: '.json', count: 483 },
  { spec: `${ROOT}/models/library/igbt`, suffix: '.json', count: 122 },
  { spec: `${ROOT}/models/library/mosfet`, suffix: '.json', count: 253 },
];
const SINGLE_FILES = [
  `${ROOT}/spice/spice_components.json`,
  `${ROOT}/mosfet_database.json`,
  `${ROOT}/models/C3D10065A.json`,
  `${ROOT}/models/E3M0060065K.json`,
];
const PATHSPECS = [
  `${ROOT}/topologies/primitives`,
  `${ROOT}/topologies/json_library`,
  `${ROOT}/topologies/prompts`,
  `${ROOT}/models/library`,
  ...SINGLE_FILES,
];

function parseArgs(argv) {
  let core = resolve(REPO_ROOT, '..', 'qdonis-core');
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--core' && argv[i + 1]) core = resolve(argv[++i]);
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return { core, check };
}

function git(core, args, encoding) {
  return execFileSync('git', ['-C', core, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Direct child of a directory pathspec (no nested folders) with the suffix. */
function belongs(path, group) {
  if (!path.startsWith(`${group.spec}/`)) return false;
  const name = path.slice(group.spec.length + 1);
  return !name.includes('/') && name.endsWith(group.suffix);
}

/** The commit's blobs selected by the pathspecs and filters, counts asserted. */
function listBlobs(core) {
  try {
    git(core, ['rev-parse', '--verify', `${COMMIT}^{commit}`], 'utf8');
  } catch {
    console.error(`Commit ${COMMIT} not found in ${core}`);
    process.exit(2);
  }
  const out = git(
    core,
    ['ls-tree', '-r', '-z', '--full-tree', COMMIT, '--', ...PATHSPECS],
    'utf8',
  );
  const entries = out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [, type, sha] = line.slice(0, tab).split(' ');
      return { type, sha, path: line.slice(tab + 1) };
    })
    .filter((entry) => entry.type === 'blob');
  const selected = [];
  for (const group of GROUPS) {
    const matched = entries.filter((entry) => belongs(entry.path, group));
    if (matched.length !== group.count) {
      console.error(
        `Expected ${group.count} files in ${group.spec}, found ${matched.length}`,
      );
      process.exit(1);
    }
    selected.push(...matched);
  }
  const singles = entries.filter((entry) => SINGLE_FILES.includes(entry.path));
  if (singles.length !== SINGLE_FILES.length) {
    console.error(
      `Expected ${SINGLE_FILES.length} single files, found ${singles.length}`,
    );
    process.exit(1);
  }
  selected.push(...singles);
  return selected
    .map((entry) => ({ ...entry, rel: entry.path.slice(ROOT.length + 1) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Every file under assets/ (except MANIFEST.json) as a POSIX relative path. */
function filesOnDisk(dir = ASSETS) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...filesOnDisk(full));
    else result.push(relative(ASSETS, full).split(sep).join('/'));
  }
  return result.filter((path) => path !== 'MANIFEST.json');
}

function manifestText(files) {
  const manifest = {
    source: {
      repository: 'qdonis-core',
      commit: COMMIT,
      branch: BRANCH,
      root: ROOT,
    },
    generatedBy: 'scripts/import-core-assets.mjs',
    files,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function runImport(core) {
  const blobs = listBlobs(core);
  const files = [];
  let written = 0;
  for (const blob of blobs) {
    const bytes = git(core, ['cat-file', 'blob', blob.sha]);
    const hash = sha256(bytes);
    const target = join(ASSETS, ...blob.rel.split('/'));
    if (existsSync(target)) {
      if (sha256(readFileSync(target)) !== hash) {
        console.error(`Refusing to overwrite changed file: assets/${blob.rel}`);
        process.exit(1);
      }
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      written += 1;
    }
    files.push({ path: blob.rel, bytes: bytes.length, sha256: hash });
  }
  const extra = filesOnDisk().filter(
    (path) => !files.some((file) => file.path === path),
  );
  if (extra.length > 0) {
    console.error(`Unexpected files in assets/: ${extra.join(', ')}`);
    process.exit(1);
  }
  writeFileSync(MANIFEST, manifestText(files));
  console.log(
    `Imported ${files.length} files from ${COMMIT.slice(0, 7)} (${written} written, ${files.length - written} unchanged)`,
  );
}

function runCheck(core) {
  const problems = [];
  if (!existsSync(MANIFEST)) {
    console.error('assets/MANIFEST.json is missing');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const blobs = listBlobs(core);
  const expectedText = manifestText(
    blobs.map((blob) => {
      const bytes = git(core, ['cat-file', 'blob', blob.sha]);
      return { path: blob.rel, bytes: bytes.length, sha256: sha256(bytes) };
    }),
  );
  if (readFileSync(MANIFEST, 'utf8') !== expectedText) {
    problems.push('MANIFEST.json does not match the core blobs');
  }
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  const onDisk = filesOnDisk();
  for (const path of onDisk) {
    const entry = listed.get(path);
    if (!entry) {
      problems.push(`extra file: ${path}`);
      continue;
    }
    const bytes = readFileSync(join(ASSETS, ...path.split('/')));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      problems.push(`changed file: ${path}`);
    }
  }
  const present = new Set(onDisk);
  for (const path of listed.keys()) {
    if (!present.has(path)) problems.push(`missing file: ${path}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`assets/ matches MANIFEST.json and core ${COMMIT.slice(0, 7)} (${onDisk.length} files)`);
}

const { core, check } = parseArgs(process.argv.slice(2));
if (check) runCheck(core);
else runImport(core);
