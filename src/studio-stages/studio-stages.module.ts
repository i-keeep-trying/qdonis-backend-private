import { Module } from '@nestjs/common';

import { CircuitsModule } from '../circuits/circuits.module';
import { LibraryCircuitDataProvider } from '../circuits/library-circuit-data.provider';
import { ProjectsModule } from '../projects/projects.module';
import { SimulationModule } from '../simulation/simulation.module';
import { CIRCUIT_DATA_PROVIDER } from './circuit-data.provider';
import { BomService } from './bom.service';
import {
  BomController,
  CalculatorsController,
  ProjectMtbfController,
  StudioStageRunsController,
  StudioStagesController,
} from './studio-stages.controller';
import { StudioStagesService } from './studio-stages.service';

/**
 * Magnetics, thermal, MTBF and EMC. Circuit data, waveform statistics and
 * loss recalculation come from the migrated library and simulation modules.
 */
@Module({
  imports: [ProjectsModule, CircuitsModule, SimulationModule],
  controllers: [
    StudioStagesController,
    StudioStageRunsController,
    ProjectMtbfController,
    BomController,
    CalculatorsController,
  ],
  providers: [
    StudioStagesService,
    BomService,
    {
      provide: CIRCUIT_DATA_PROVIDER,
      useExisting: LibraryCircuitDataProvider,
    },
  ],
  exports: [StudioStagesService],
})
export class StudioStagesModule {}
