import { PY_WHITESPACE, pythonStrip } from '../../common/python/python-json';

/** `data_utils.TOPOLOGY_NAME_ALIASES` (qdonis-core 239d79a), verbatim. */
export const TOPOLOGY_NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  ['dual_active_bridge', 'dcdc_dual_active_bridge'],
  ['dual_active_bridge_converter', 'dcdc_dual_active_bridge'],
  ['dual_active_bridge_(dab)_converter', 'dcdc_dual_active_bridge'],
  ['dab', 'dcdc_dual_active_bridge'],
  ['dab_converter', 'dcdc_dual_active_bridge'],
  ['dcdc_dab', 'dcdc_dual_active_bridge'],
  ['four_switch_buck_boost', 'dcdc_four_switch_buck_boost'],
  ['fsbb', 'dcdc_four_switch_buck_boost'],
  ['buck', 'dcdc_buck'],
  ['boost', 'dcdc_boost'],
  ['buck_boost', 'dcdc_buck_boost'],
  ['flyback', 'dcdc_flyback'],
  ['sepic', 'dcdc_sepic'],
  ['cuk', 'dcdc_cuk'],
  ['zeta', 'dcdc_zeta'],
  ['half_bridge', 'dcdc_half_bridge'],
  ['full_bridge', 'dcdc_full_bridge_centertapped'],
  ['push_pull', 'dcdc_push_pull'],
  ['synchronous_buck', 'dcdc_synchronous_buck'],
]);

const PARENTHESISED = new RegExp(`[${PY_WHITESPACE}]*\\([^)]*\\)`, 'gu');

/**
 * Port of `data_utils.get_builtin_topology_path` restricted to catalog
 * membership: aliases and name normalisation as in Python, then the raw
 * name. Never touches the filesystem, so paths and `..` never resolve.
 */
export function resolveTopologyName(
  name: string,
  ids: ReadonlySet<string>,
): string | null {
  let base = pythonStrip(name);
  if (base.endsWith('.yaml')) base = base.slice(0, -5);
  else if (base.endsWith('.yml')) base = base.slice(0, -4);
  const clean = pythonStrip(base.replace(PARENTHESISED, ''));
  const norm = clean
    .toLowerCase()
    .replaceAll('-', '_')
    .replaceAll(' ', '_')
    .replace(/_+/g, '_');
  const target =
    TOPOLOGY_NAME_ALIASES.get(norm) ||
    TOPOLOGY_NAME_ALIASES.get(base.toLowerCase()) ||
    norm;
  const key = target.endsWith('.yaml') ? target.slice(0, -5) : target;
  if (ids.has(key)) return key;
  const orig = name.endsWith('.yaml') ? name.slice(0, -5) : name;
  if (ids.has(orig)) return orig;
  return null;
}
