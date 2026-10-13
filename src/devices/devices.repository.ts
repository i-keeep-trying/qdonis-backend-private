import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ASSETS_ROOT } from '../common/assets/assets-root';
import type { DeviceLibrary } from './devices.types';
import { loadDeviceLibrary } from './library/device-library.loader';

/** The read-only device model library shipped in `assets/`, loaded once at boot. */
@Injectable()
export class DevicesRepository implements OnModuleInit {
  private readonly logger = new Logger(DevicesRepository.name);
  private loaded: DeviceLibrary | null = null;

  async onModuleInit(): Promise<void> {
    const started = Date.now();
    this.loaded = await loadDeviceLibrary(ASSETS_ROOT);
    this.logger.log(
      `Loaded ${this.loaded.files} device models (${this.loaded.catalogue.length} usable) in ${Date.now() - started} ms`,
    );
  }

  get library(): DeviceLibrary {
    if (!this.loaded) throw new Error('Device library is not loaded yet');
    return this.loaded;
  }
}
