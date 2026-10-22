import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { loadVerifiedSubtree, readManifest } from './asset-manifest';
import { ASSETS_ROOT } from './assets-root';

/** Every file under `assets/`, POSIX relative paths. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : [relative(ASSETS_ROOT, join(dir, entry.name)).split(sep).join('/')],
  );
}

describe('assets/MANIFEST.json (real assets)', () => {
  it('lists exactly the 990 files (967 copied + 23 low-voltage Si models), all hashes matching', async () => {
    const manifest = await readManifest(ASSETS_ROOT);
    expect(manifest.source.commit).toBe(
      '0054f7202abd61e503dbac26ac676431698e66ea',
    );
    expect(manifest.files).toHaveLength(990);
    const onDisk = walk(ASSETS_ROOT).filter((p) => p !== 'MANIFEST.json');
    expect(onDisk.sort()).toEqual(manifest.files.map((f) => f.path).sort());
    // Verifies size + SHA-256 of every file.
    const all = await loadVerifiedSubtree(ASSETS_ROOT, manifest, '');
    expect(all.size).toBe(990);
  }, 60_000);

  it('has the per-folder counts of core 0054f72 plus the chat-first prompts', async () => {
    const paths = (await readManifest(ASSETS_ROOT)).files.map((f) => f.path);
    const count = (prefix: string, suffix: string) =>
      paths.filter(
        (p) =>
          p.startsWith(prefix) &&
          !p.slice(prefix.length).includes('/') &&
          p.endsWith(suffix),
      ).length;
    expect(count('topologies/primitives/', '.yaml')).toBe(35);
    expect(count('topologies/json_library/', '.json')).toBe(35);
    expect(count('topologies/prompts/', '.prompt.md')).toBe(35);
    expect(count('models/library/diode/', '.json')).toBe(491);
    expect(count('models/library/igbt/', '.json')).toBe(122);
    expect(count('models/library/mosfet/', '.json')).toBe(268);
    expect(
      [
        'spice/spice_components.json',
        'mosfet_database.json',
        'models/C3D10065A.json',
        'models/E3M0060065K.json',
      ].every((p) => paths.includes(p)),
    ).toBe(true);
  });
});
