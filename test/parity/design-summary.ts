/** Test-only normalisation of the `* qdonis-design:` deck comment (parity specs). */

/**
 * The core collects the `{components.REF.PARAM}` references of the design
 * summary in a set, so the order of one part's parameters follows the hash
 * seed. Sorts them (the summary is otherwise compared byte for byte).
 */
const DESIGN_LINE = /^(\* qdonis-design: .*,"params":)(\{.*\})\}$/gm;
export const sortedSummaryParams = (text: string) =>
  text.replace(DESIGN_LINE, (_line, head: string, json: string) => {
    const params = JSON.parse(json) as Record<string, Record<string, unknown>>;
    const sorted = Object.fromEntries(
      Object.entries(params).map(([ref, values]) => [
        ref,
        Object.fromEntries(
          Object.entries(values).sort(([x], [y]) => x.localeCompare(y)),
        ),
      ]),
    );
    return `${head}${JSON.stringify(sorted)}}`;
  });
