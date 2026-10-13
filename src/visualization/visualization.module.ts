import { Module } from '@nestjs/common';

import { CircuitsModule } from '../circuits/circuits.module';
import { ProjectsModule } from '../projects/projects.module';
import { TopologiesModule } from '../topologies/topologies.module';
import { VisualizationController } from './visualization.controller';
import { VisualizationService } from './visualization.service';

/** Circuit stage (library schematic + inventory), replacing qdonis-core `/api/visualize`. */
@Module({
  imports: [ProjectsModule, TopologiesModule, CircuitsModule],
  controllers: [VisualizationController],
  providers: [VisualizationService],
  exports: [VisualizationService],
})
export class VisualizationModule {}
