import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ASSETS_ROOT } from '../common/assets/assets-root';
import { loadTopologyCatalog } from './library/topology-catalog.loader';
import type { TopologyCatalog } from './topologies.types';

/** The read-only topology library shipped in `assets/`, loaded once at boot. */
@Injectable()
export class TopologiesRepository implements OnModuleInit {
  private readonly logger = new Logger(TopologiesRepository.name);
  private loaded: TopologyCatalog | null = null;

  async onModuleInit(): Promise<void> {
    const started = Date.now();
    this.loaded = await loadTopologyCatalog(ASSETS_ROOT);
    this.logger.log(
      `Loaded ${this.loaded.ids.length} topologies in ${Date.now() - started} ms`,
    );
  }

  get catalog(): TopologyCatalog {
    if (!this.loaded) throw new Error('Topology library is not loaded yet');
    return this.loaded;
  }
}
