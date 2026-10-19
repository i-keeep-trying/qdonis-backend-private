import {
  Injectable,
  NotFoundException,
  type CanActivate,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfiguration } from '../../config/configuration';

/**
 * DEV-LAYOUT: the developer layout tool's routes exist only where
 * `SCHEMATIC_LAYOUT_TOOL` is on (never in production); elsewhere they are 404.
 */
@Injectable()
export class LayoutToolGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  canActivate(): boolean {
    if (!this.config.get('app', { infer: true }).schematicLayoutTool) {
      throw new NotFoundException(); // as an unknown route
    }
    return true;
  }
}
