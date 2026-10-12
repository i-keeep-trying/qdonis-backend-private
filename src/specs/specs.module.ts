import { Module } from '@nestjs/common';

import { DesignModule } from '../design/design.module';
import { ProjectsModule } from '../projects/projects.module';
import { SimulationModule } from '../simulation/simulation.module';
import { SpecsController } from './specs.controller';
import { SpecsService } from './specs.service';

/** Specs stage of a branch: key spec table, approval, constraints list (queued AI run). */
@Module({
  imports: [ProjectsModule, DesignModule, SimulationModule],
  controllers: [SpecsController],
  providers: [SpecsService],
  exports: [SpecsService],
})
export class SpecsModule {}
