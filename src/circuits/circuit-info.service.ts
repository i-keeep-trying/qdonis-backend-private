import { Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import { TopologiesService } from '../topologies/topologies.service';
import type { CircuitInfoInput, CircuitInventory } from './circuits.types';
import { applyUpdates, circuitInventory } from './library/circuit-inventory';

const MAX_DEPTH = 32;
const MAX_COMPONENTS = 10_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rejects edited circuits nested too deep or too large to walk safely. */
function assertWalkable(circuit: Record<string, unknown>): void {
  let count = 0;
  const walk = (components: unknown, depth: number): void => {
    if (!Array.isArray(components)) return;
    if (depth > MAX_DEPTH) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        `circuit components are nested deeper than ${MAX_DEPTH} levels`,
      );
    }
    for (const comp of components) {
      count += 1;
      if (count > MAX_COMPONENTS) {
        throw AppError.badRequest(
          ErrorCode.ValidationFailed,
          `circuit has more than ${MAX_COMPONENTS} components`,
        );
      }
      if (isObject(comp)) walk(comp.internal, depth + 1);
    }
  };
  walk(circuit.components, 1);
}

/** Inventory of a library topology or an edited circuit, with design values applied. */
@Injectable()
export class CircuitInfoService {
  constructor(private readonly topologies: TopologiesService) {}

  inventory(input: CircuitInfoInput): CircuitInventory {
    const { topologyId, circuit, recalculated } = input;
    if (!topologyId && !(isObject(circuit) && Object.keys(circuit).length)) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'topology_id or circuit is required',
      );
    }
    let yamlDict: Record<string, unknown>;
    if (
      isObject(circuit) &&
      Array.isArray(circuit.components) &&
      circuit.components.length > 0
    ) {
      assertWalkable(circuit);
      yamlDict = structuredClone(circuit);
    } else {
      yamlDict = this.topologies.definition(
        this.topologies.requireId(topologyId),
      );
    }
    applyUpdates(yamlDict, recalculated);
    return circuitInventory(yamlDict);
  }
}
