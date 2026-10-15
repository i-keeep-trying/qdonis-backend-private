import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Injectable, Logger } from '@nestjs/common';

import { ASSETS_ROOT } from '../../common/assets/assets-root';
import {
  MANIFEST_FILE,
  type AssetManifest,
} from '../../common/assets/asset-manifest';
import { AppError, ErrorCode } from '../../common/errors/error-codes';
import { isDict, type Dict } from '../../simulation/netlist/py';
import { parsePyYaml } from '../../topologies/library/pyyaml-schema';
import { TopologiesService } from '../../topologies/topologies.service';
import { applySchematic } from '../library/apply';
import { readDrawing, readLayout } from '../library/drawing-input';
import { libraryLayout, mergeLayouts, placeEntry } from '../library/layout';
import { layoutToYaml, replaceSchematicSection } from '../library/layout-yaml';
import { flat } from '../library/model';
import { SheetNotFoundError, renderForTopology } from '../library/render';
import type { SchematicLayout } from '../schematic.types';

const PRIMITIVES = 'topologies/primitives';

export interface LibraryLayoutStatus {
  id: string;
  name: string | null;
  parts: number;
  hasLayout: boolean;
  tuned: boolean;
}

/**
 * DEV-LAYOUT: the developer tool for hand-tuning the library topologies'
 * layouts (temporary; remove before the public release). It draws and checks
 * library topologies without a project, and writes a layout into the
 * topology YAML's `schematic:` section only, keeping `assets/MANIFEST.json`
 * in step and reloading the library. Commit the changed assets afterwards.
 */
@Injectable()
export class DevLayoutService {
  private readonly logger = new Logger(DevLayoutService.name);
  /** Writes one at a time (each rewrites the manifest). */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly topologies: TopologiesService) {}

  /** Tuning status of every library topology. */
  status(): LibraryLayoutStatus[] {
    return this.topologies.ids().map((id) => {
      const circuit = this.topologies.definition(id);
      const section = isDict(circuit.schematic) ? circuit.schematic : null;
      return {
        id,
        name: typeof circuit.name === 'string' ? circuit.name : null,
        parts: flat(circuit).length,
        hasLayout: section !== null,
        tuned: Boolean(section?.tuned),
      };
    });
  }

  /** A library topology drawn without a project; `layout`: the unsaved layout being tuned. */
  render(
    topologyId: string,
    options: {
      sheet?: string | null;
      fresh?: boolean;
      regroup?: boolean;
      layout?: unknown;
    },
  ) {
    const id = this.topologies.requireId(topologyId);
    const result = this.sheet(() =>
      renderForTopology(this.topologies.design(id), {
        sheet: options.sheet ?? null,
        fresh: options.fresh,
        regroup: options.regroup,
        layout: readLayout(options.layout),
        drawing: structuredClone(this.topologies.schematic(id)),
      }),
    );
    // The same shape as the project render (`SchematicService.render`).
    return {
      schematic: result.schematic,
      layout: result.layout,
      sheet: result.sheet,
      sheets: result.sheets,
      palette: result.palette,
      basis: result.basis,
      groupsExplicit: result.groups_explicit,
      seededFromDrawing: result.seeded_from_drawing,
      libraryLayout: result.library_layout,
    };
  }

  /** What an edited library drawing changes (the tuner saves layout-only drawings only). */
  check(
    topologyId: string,
    schematic: unknown,
    sheet: string | null,
    layout: unknown,
  ) {
    const id = this.topologies.requireId(topologyId);
    const circuit = this.topologies.design(id);
    const result = this.sheet(() =>
      applySchematic(
        circuit,
        readDrawing(schematic),
        null,
        sheet,
        mergeLayouts(libraryLayout(circuit), readLayout(layout), circuit),
        structuredClone(this.topologies.schematic(id)) as Dict,
      ),
    );
    return {
      layoutOnly: result.layout_only,
      layout: result.layout,
      changes: result.changes,
      errors: result.errors,
    };
  }

  /**
   * Saves a full layout (every sheet, the grouping) as the topology's library
   * layout. Refuses when anything but the `schematic:` section would change
   * or the layout does not read back identically.
   */
  async save(topologyId: string, rawLayout: unknown, tuned: boolean) {
    const id = this.topologies.requireId(topologyId);
    const layout = readLayout(rawLayout);
    if (!layout)
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'A layout is required.',
      );
    const job = this.writing.then(() => this.write(id, layout, tuned));
    this.writing = job.catch(() => undefined);
    return job;
  }

  private async write(id: string, layout: SchematicLayout, tuned: boolean) {
    const relative = `${PRIMITIVES}/${id}.yaml`;
    const path = join(ASSETS_ROOT, ...relative.split('/'));
    const text = await readFile(path, 'utf8');
    const kept: SchematicLayout = {};
    for (const key of ['components', 'wires', 'groups', 'sheets'] as const) {
      if (layout[key] !== undefined && layout[key] !== null)
        Object.assign(kept, { [key]: layout[key] });
    }
    const next = replaceSchematicSection(text, layoutToYaml(kept, tuned));
    const before = parsePyYaml(text, relative) as Dict;
    const after = parsePyYaml(next, relative) as Dict;
    const rest = (doc: Dict) =>
      Object.fromEntries(
        Object.entries(doc).filter(([k]) => k !== 'schematic'),
      );
    if (!isDeepStrictEqual(rest(before), rest(after))) {
      throw refused('the rest of the YAML would change');
    }
    const back = libraryLayout(after);
    const expected = Object.fromEntries(
      Object.entries(kept.components ?? {}).map(([cid, p]) => [
        cid,
        placeEntry(p as unknown as Dict),
      ]),
    );
    if (!back || !isDeepStrictEqual(back.components, expected)) {
      throw refused('the layout does not read back identically');
    }
    if (kept.groups && !isDeepStrictEqual(back.groups, kept.groups)) {
      throw refused('the groups do not read back identically');
    }

    const bytes = Buffer.from(next, 'utf8');
    const manifestPath = join(ASSETS_ROOT, MANIFEST_FILE);
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as AssetManifest;
    const entry = manifest.files.find((f) => f.path === relative);
    if (!entry) throw refused(`${relative} is not in the asset manifest`);
    entry.bytes = bytes.length;
    entry.sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path, bytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await this.topologies.reload();
    this.logger.log(
      `Library layout of ${id} saved (${tuned ? 'tuned' : 'draft'})`,
    );
    return {
      topologyId: id,
      components: Object.keys(kept.components ?? {}).length,
      wires: kept.wires?.length ?? 0,
      groups: Object.keys(kept.groups ?? {}).length,
      tuned,
    };
  }

  private sheet<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof SheetNotFoundError)
        throw AppError.notFound(ErrorCode.SheetNotFound, error.message);
      throw error;
    }
  }
}

const refused = (why: string) =>
  AppError.conflict(
    ErrorCode.StageFailed,
    `Refusing to write the library layout: ${why}.`,
  );
