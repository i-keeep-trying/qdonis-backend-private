import { Module } from '@nestjs/common';

import { SimulationModule } from '../simulation/simulation.module';
import { TopologiesModule } from '../topologies/topologies.module';
import { CircuitInfoService } from './circuit-info.service';
import { CircuitsController } from './circuits.controller';
import { LibraryCircuitDataProvider } from './library-circuit-data.provider';

/** Circuit inventory (`studio_circuit.circuit_inventory`), migrated from qdonis-core. */
@Module({
  imports: [TopologiesModule, SimulationModule],
  controllers: [CircuitsController],
  providers: [CircuitInfoService, LibraryCircuitDataProvider],
  exports: [CircuitInfoService, LibraryCircuitDataProvider],
})
export class CircuitsModule {}
