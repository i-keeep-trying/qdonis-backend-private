import { Module } from '@nestjs/common';

import { TopologiesController } from './topologies.controller';
import { TopologiesRepository } from './topologies.repository';
import { TopologiesService } from './topologies.service';

/** Built-in topology library (YAML definitions + static schematics), migrated from qdonis-core. */
@Module({
  controllers: [TopologiesController],
  providers: [TopologiesRepository, TopologiesService],
  exports: [TopologiesService],
})
export class TopologiesModule {}
