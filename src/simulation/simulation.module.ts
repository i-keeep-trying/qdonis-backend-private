import { Module } from '@nestjs/common';

import { DesignModule } from '../design/design.module';
import { ProjectsModule } from '../projects/projects.module';
import { TopologiesModule } from '../topologies/topologies.module';
import { ComputeService } from './compute/compute.service';
import { DesignSizingService } from './sizing/design-sizing.service';
import { SimulationArtifactsService } from './simulation-artifacts.service';
import {
  SimulationStagesController,
  SimulationWaveformsController,
} from './simulation.controller';
import { SimulationRunsRepository } from './simulation-runs.repository';
import { SimulationRunsService } from './simulation-runs.service';
import { SimulationService } from './simulation.service';

/**
 * Design decks, ngspice simulation and device selection, replacing
 * qdonis-core `/api/simulate/*` and `/api/studio/select-devices`. Runs are
 * queued in `simulation_runs`; waveforms and raw time series go to S3.
 */
@Module({
  imports: [ProjectsModule, TopologiesModule, DesignModule],
  controllers: [SimulationStagesController, SimulationWaveformsController],
  providers: [
    SimulationService,
    DesignSizingService,
    SimulationRunsRepository,
    SimulationRunsService,
    ComputeService,
    SimulationArtifactsService,
  ],
  exports: [
    SimulationService,
    SimulationRunsService,
    ComputeService,
    SimulationArtifactsService,
  ],
})
export class SimulationModule {}
