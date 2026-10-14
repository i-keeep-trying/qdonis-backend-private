/**
 * An edited circuit as the Circuit stage stores it (`customCircuit`): the
 * topology YAML as plain JSON, without its `schematic:` section (the layout
 * is stored beside it, and the library's own layout keeps showing through).
 *
 * The netlist generator prints YAML ints and floats differently (`12` vs
 * `12.0`), and JSON has one number type: whole numbers come back as ints, as
 * they did when the old Studio stored the circuit through the browser.
 */

import { isDict, type Dict } from '../../simulation/netlist/py';

function mapNumbers(
  value: unknown,
  convert: (n: number | bigint) => unknown,
): unknown {
  if (typeof value === 'number' || typeof value === 'bigint')
    return convert(value);
  if (Array.isArray(value)) return value.map((v) => mapNumbers(v, convert));
  if (isDict(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mapNumbers(v, convert)]),
    );
  }
  return value;
}

/** Circuit (YAML ints as bigint) -> stored JSON. */
export function toStoredCircuit(circuit: Dict): Dict {
  const out = mapNumbers(circuit, (n) => Number(n)) as Dict;
  delete out.schematic;
  return out;
}

/** Stored JSON -> circuit for the netlist generator and the drawing, with the library's layout section. */
export function fromStoredCircuit(
  stored: Dict,
  librarySchematic: unknown,
): Dict {
  const out = mapNumbers(stored, (n) =>
    typeof n === 'number' && Number.isSafeInteger(n) ? BigInt(n) : n,
  ) as Dict;
  delete out.schematic;
  if (librarySchematic !== undefined)
    out.schematic = structuredClone(librarySchematic);
  return out;
}

/**
 * The circuit a branch designs and simulates: its edited circuit when the
 * schematic was edited, else the library topology (`library`, as
 * `TopologiesService.design` returns it).
 */
export function branchCircuit(customCircuit: unknown, library: Dict): Dict {
  return isDict(customCircuit)
    ? fromStoredCircuit(customCircuit, library.schematic)
    : library;
}
