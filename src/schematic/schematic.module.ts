import { Module } from '@nestjs/common';

import { CircuitsModule } from '../circuits/circuits.module';
import { ProjectsModule } from '../projects/projects.module';
import { TopologiesModule } from '../topologies/topologies.module';
import { DevLayoutController } from './dev-layout/dev-layout.controller';
import { DevLayoutService } from './dev-layout/dev-layout.service';
import { LayoutToolGuard } from './dev-layout/layout-tool.guard';
import { SchematicController } from './schematic.controller';
import { SchematicService } from './schematic.service';

/** Synced schematic of the Circuit stage (render, check and apply drawing edits). */
@Module({
  imports: [ProjectsModule, TopologiesModule, CircuitsModule],
  // DEV-LAYOUT: DevLayoutController / DevLayoutService / LayoutToolGuard (temporary)
  controllers: [SchematicController, DevLayoutController],
  providers: [SchematicService, DevLayoutService, LayoutToolGuard],
  exports: [SchematicService],
})
export class SchematicModule {}
