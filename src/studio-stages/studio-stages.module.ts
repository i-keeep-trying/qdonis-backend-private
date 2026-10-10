import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module';
import {
  CIRCUIT_DATA_PROVIDER,
  UnavailableCircuitDataProvider,
} from './circuit-data.provider';
import { BomService } from './bom.service';
import {
  BomController,
  CalculatorsController,
  ProjectMtbfController,
  StudioStagesController,
} from './studio-stages.controller';
import { StudioStagesService } from './studio-stages.service';

/**
 * Magnetics, thermal, MTBF and EMC. The circuit/simulation data provider is
 * a seam for the simulation module: rebind CIRCUIT_DATA_PROVIDER there.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [
    StudioStagesController,
    ProjectMtbfController,
    BomController,
    CalculatorsController,
  ],
  providers: [
    StudioStagesService,
    BomService,
    {
      provide: CIRCUIT_DATA_PROVIDER,
      useClass: UnavailableCircuitDataProvider,
    },
  ],
})
export class StudioStagesModule {}
