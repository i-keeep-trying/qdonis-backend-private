import { resolve } from 'node:path';

/**
 * Read-only reference assets copied from qdonis-core (see
 * `assets/MANIFEST.json`). `src/common/assets` (ts-jest, `nest start`) and
 * `dist/common/assets` (`nest build`) sit at the same depth, so both resolve
 * to `<repo>/assets`.
 */
export const ASSETS_ROOT = resolve(__dirname, '..', '..', '..', 'assets');
