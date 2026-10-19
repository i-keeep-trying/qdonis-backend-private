import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import { loadTopologyCatalog } from '../../topologies/library/topology-catalog.loader';
import { TopologiesRepository } from '../../topologies/topologies.repository';
import { TopologiesService } from '../../topologies/topologies.service';
import type { AppConfiguration } from '../../config/configuration';
import { DevLayoutService } from './dev-layout.service';
import { LayoutToolGuard } from './layout-tool.guard';

const ID = 'dcdc_buck';
const YAML = join(ASSETS_ROOT, 'topologies', 'primitives', `${ID}.yaml`);
const MANIFEST = join(ASSETS_ROOT, 'MANIFEST.json');

describe('DEV-LAYOUT developer layout tool', () => {
  let topologies: TopologiesService;
  let dev: DevLayoutService;
  const original = {
    yaml: readFileSync(YAML),
    manifest: readFileSync(MANIFEST),
  };

  beforeAll(async () => {
    const repository = new TopologiesRepository();
    await repository.onModuleInit();
    topologies = new TopologiesService(repository);
    dev = new DevLayoutService(topologies);
  });

  afterAll(() => {
    // The save test writes into assets/: put the library back byte for byte.
    writeFileSync(YAML, original.yaml);
    writeFileSync(MANIFEST, original.manifest);
  });

  it('lists the tuning status of every library topology', () => {
    const status = dev.status();
    expect(status).toHaveLength(35);
    expect(status.every((s) => s.hasLayout)).toBe(true);
    expect(status.find((s) => s.id === ID)).toMatchObject({ tuned: true });
  });

  it('draws and checks a library topology without a project', () => {
    const drawn = dev.render(ID, {});
    expect(drawn.basis).toBe('saved');
    const moved = structuredClone(drawn.schematic);
    const part = moved.components.find((c) => c.id === 'L1');
    if (part) part.x = (part.x ?? 0) + 40;
    expect(dev.check(ID, moved, null, drawn.layout)).toMatchObject({
      layoutOnly: true,
      errors: [],
    });
    const fresh = dev.render(ID, { fresh: true });
    expect(fresh.basis).not.toBe('saved');
  });

  it('saves a layout into the YAML only, keeps the manifest valid and reloads the library', async () => {
    const drawn = dev.render(ID, {});
    const layout = structuredClone(drawn.layout);
    const l1 = layout.components?.L1;
    if (l1) l1.x += 40;
    const result = await dev.save(ID, layout, false);
    expect(result).toMatchObject({ topologyId: ID, tuned: false });

    const text = readFileSync(YAML, 'utf8');
    const before = original.yaml.toString('utf8');
    expect(text.slice(0, text.indexOf('\nschematic:'))).toBe(
      before.slice(0, before.indexOf('\nschematic:')),
    );
    expect(text).toContain('  tuned: false');
    // The boot-time check of assets/ (sizes and hashes) still passes.
    await expect(loadTopologyCatalog(ASSETS_ROOT)).resolves.toBeDefined();
    expect(dev.status().find((s) => s.id === ID)?.tuned).toBe(false);
    expect(
      dev.render(ID, {}).schematic.components.find((c) => c.id === 'L1')?.x,
    ).toBe(l1?.x);
  });

  it('refuses a missing layout and unknown topologies', async () => {
    await expect(dev.save(ID, null, true)).rejects.toMatchObject({
      status: 400,
    });
    expect(() => dev.render('nope', {})).toThrow();
  });

  it('exists only where the tool is enabled', () => {
    const guard = (on: boolean) =>
      new LayoutToolGuard({
        get: () => ({ schematicLayoutTool: on }),
      } as unknown as ConfigService<AppConfiguration, true>);
    expect(guard(true).canActivate()).toBe(true);
    expect(() => guard(false).canActivate()).toThrow('Not Found');
  });
});
