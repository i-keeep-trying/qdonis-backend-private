import { Injectable } from '@nestjs/common';

import { DevicesRepository } from './devices.repository';
import type { CataloguePart, DeviceKind, DeviceModel } from './devices.types';

@Injectable()
export class DevicesService {
  constructor(private readonly repository: DevicesRepository) {}

  /** Library models of one kind, sorted by part number. */
  models(kind: DeviceKind): DeviceModel[] {
    return this.repository.library.models[kind].map((model) => ({ ...model }));
  }

  /** Usable parts with parsed ratings (device selection input). */
  catalogue(): CataloguePart[] {
    return this.repository.library.catalogue.map((part) => ({ ...part }));
  }
}
