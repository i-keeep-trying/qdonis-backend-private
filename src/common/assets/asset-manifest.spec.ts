import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssetValidationError,
  loadVerifiedSubtree,
  readManifest,
  type AssetManifest,
} from './asset-manifest';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('asset-manifest', () => {
  let root: string;

  /** Writes `files` under `root` and a manifest listing `listed` (default: all). */
  const setup = (
    files: Record<string, string>,
    listed: Record<string, string> = files,
  ) => {
    for (const [path, text] of Object.entries(files)) {
      const full = join(root, ...path.split('/'));
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, text);
    }
    const manifest: AssetManifest = {
      source: {
        repository: 'qdonis-core',
        commit: 'a'.repeat(40),
        branch: 'x',
        root: 'qdonis_backend/data',
      },
      generatedBy: 'test',
      files: Object.entries(listed).map(([path, text]) => ({
        path,
        bytes: Buffer.byteLength(text),
        sha256: sha(text),
      })),
    };
    writeFileSync(join(root, 'MANIFEST.json'), JSON.stringify(manifest));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qdonis-assets-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads a verified subtree', async () => {
    setup({ 'a/one.json': '{}', 'a/b/two.json': '[]', 'c/other.json': '1' });
    const files = await loadVerifiedSubtree(
      root,
      await readManifest(root),
      'a/',
    );
    expect([...files.keys()].sort()).toEqual(['a/b/two.json', 'a/one.json']);
    expect(files.get('a/one.json')?.toString()).toBe('{}');
  });

  it('rejects a missing manifest', async () => {
    await expect(readManifest(root)).rejects.toThrow(
      /Asset validation failed: MANIFEST\.json: cannot read/,
    );
  });

  it('rejects a missing file', async () => {
    setup({ 'a/one.json': '{}' }, { 'a/one.json': '{}', 'a/gone.json': '{}' });
    await expect(
      loadVerifiedSubtree(root, await readManifest(root), 'a/'),
    ).rejects.toThrow(
      new AssetValidationError('a/gone.json', 'missing').message,
    );
  });

  it('rejects an extra file', async () => {
    setup({ 'a/one.json': '{}', 'a/extra.json': '{}' }, { 'a/one.json': '{}' });
    await expect(
      loadVerifiedSubtree(root, await readManifest(root), 'a/'),
    ).rejects.toThrow('Asset validation failed: a/extra.json: not listed');
  });

  it('rejects a size mismatch', async () => {
    setup({ 'a/one.json': '{ }' }, { 'a/one.json': '{}' });
    await expect(
      loadVerifiedSubtree(root, await readManifest(root), 'a/'),
    ).rejects.toThrow('Asset validation failed: a/one.json: size 3');
  });

  it('rejects a hash mismatch', async () => {
    setup({ 'a/one.json': '[]' }, { 'a/one.json': '{}' });
    await expect(
      loadVerifiedSubtree(root, await readManifest(root), 'a/'),
    ).rejects.toThrow('Asset validation failed: a/one.json: SHA-256');
  });
});
