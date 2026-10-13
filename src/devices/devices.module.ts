import { Module } from '@nestjs/common';

import { DevicesController } from './devices.controller';
import { DevicesRepository } from './devices.repository';
import { DevicesService } from './devices.service';

/** Device model library (MOSFET / diode / IGBT loss LUTs), migrated from qdonis-core. */
@Module({
  controllers: [DevicesController],
  providers: [DevicesRepository, DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
