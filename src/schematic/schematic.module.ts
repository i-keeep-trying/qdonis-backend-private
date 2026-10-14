import { Module } from '@nestjs/common';

import { CircuitsModule } from '../circuits/circuits.module';
import { ProjectsModule } from '../projects/projects.module';
import { TopologiesModule } from '../topologies/topologies.module';
import { SchematicController } from './schematic.controller';
import { SchematicService } from './schematic.service';

/** Synced schematic of the Circuit stage (render, check and apply drawing edits). */
@Module({
  imports: [ProjectsModule, TopologiesModule, CircuitsModule],
  controllers: [SchematicController],
  providers: [SchematicService],
  exports: [SchematicService],
})
export class SchematicModule {}
