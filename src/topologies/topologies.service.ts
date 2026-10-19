import { Injectable } from '@nestjs/common';

import { humanizeTopology } from '../projects/studio/topology-names';
import { parsePyYamlDesign } from './library/pyyaml-schema';
import { resolveTopologyName } from './library/topology-names';
import { TopologiesRepository } from './topologies.repository';
import {
  topologyNotFound,
  type DeepReadonly,
  type JsonObject,
  type TopologyFamily,
  type TopologyLibraryEntry,
} from './topologies.types';

const FAMILY: Record<string, TopologyFamily> = {
  dcdc: 'DC-DC',
  acdc: 'AC-DC',
  dcac: 'DC-AC',
};

/** Lookups on the built-in topology library. */
@Injectable()
export class TopologiesService {
  private idSet: ReadonlySet<string> | null = null;
  private entries: readonly TopologyLibraryEntry[] | null = null;

  constructor(private readonly repository: TopologiesRepository) {}

  /** DEV-LAYOUT: reads the library again after a library layout was saved. */
  async reload(): Promise<void> {
    await this.repository.reload();
    this.idSet = null;
    this.entries = null;
  }

  /** Library ids in the order the core listed them. */
  ids(): readonly string[] {
    return this.repository.catalog.ids;
  }

  /** The picker list: id, display title and family. */
  library(): TopologyLibraryEntry[] {
    this.entries ??= this.ids().map((id) => ({
      id,
      title: this.title(id),
      family: FAMILY[id.split('_')[0]] ?? 'Other',
    }));
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Display name, as the projects module names stored topologies. */
  title(id: string): string {
    return humanizeTopology(id);
  }

  /** Library id for a raw id, file name or alias; null when unknown. */
  resolveId(name: unknown): string | null {
    if (typeof name !== 'string' || name.length === 0) return null;
    this.idSet ??= new Set(this.ids());
    return resolveTopologyName(name, this.idSet);
  }

  /** Like {@link resolveId}, but 404 `TOPOLOGY_NOT_FOUND` when unknown. */
  requireId(name: unknown): string {
    const id = this.resolveId(name);
    if (!id) throw topologyNotFound(name);
    return id;
  }

  /** Mutable copy of the topology YAML (`yaml.safe_load` result). */
  definition(id: string): JsonObject {
    const doc = this.repository.catalog.definitions.get(id);
    if (!doc) throw topologyNotFound(id);
    return structuredClone(doc) as JsonObject;
  }

  /**
   * Fresh design dict for the netlist generator: like {@link definition},
   * but YAML integers are `bigint` so Python's int / float printing survives.
   */
  design(id: string): Record<string, unknown> {
    const text = this.repository.catalog.sources.get(id);
    if (text === undefined) throw topologyNotFound(id);
    return parsePyYamlDesign(
      text,
      `topologies/primitives/${id}.yaml`,
    ) as Record<string, unknown>;
  }

  /** The static schematic (frozen; copy before changing it). */
  schematic(id: string): DeepReadonly<JsonObject> {
    const doc = this.repository.catalog.schematics.get(id);
    if (!doc) throw topologyNotFound(id);
    return doc;
  }
}
