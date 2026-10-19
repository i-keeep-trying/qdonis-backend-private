import type { BomSourcePart } from '../engines/bom/bom';
import type { MagneticDesign } from '../engines/magnetics/magnetics-engine';
import type { ComponentOption } from '../engines/reliability/reliability.types';
import {
  stageNodeOnBranch,
  type StudioProject,
} from '../projects/studio/studio-graph';
import {
  byRef,
  circuitParts,
  customWound,
  magneticDesigns,
  type PartType,
  refKey,
  selectedDevices,
  type SelectedDevice,
} from './branch-parts';
import type { CircuitDataProvider } from './circuit-data.provider';
import type { StagePlan } from './magnetics.stage';

/**
 * BOM stage (port of the old `BOMExportScreen`). The old screen listed the
 * parts picked in Component Selection (Mouser results); here every physical
 * part of the branch circuit is a designator, with the Simulation device
 * selection and the custom magnetics filled in, plus a heatsink line from the
 * Thermal stage's cooling recommendation. Designators with the same part are
 * one line (`refs`, quantity). The selected devices are looked up on Mouser by
 * exact manufacturer part number (`lookups`, done by the service); the user
 * picks the other parts per line. The user's choices (part, quantity,
 * included, extra lines) are kept per designator on re-runs.
 */

export const BOM_CATEGORIES = [
  'mosfet',
  'diode',
  'inductor',
  'transformer',
  'capacitor',
  'resistor',
  'ic',
  'heatsink',
  'other',
] as const;
export type BomCategory = (typeof BOM_CATEGORIES)[number];

/** A distributor part chosen for a line (from a Mouser search). */
export interface SourcedPart {
  manufacturer: string;
  partNumber: string;
  mouserPartNumber: string | null;
  description: string | null;
  packageType: string | null;
  pricingTiers: Array<{ quantity: number; price: number }>;
  /** Currency of the prices (Mouser answers in the account's currency). */
  currency: string | null;
  availability: string | null;
  leadTime: string | null;
  rohsStatus: string | null;
  lifecycleStatus: string | null;
  datasheetUrl: string | null;
}

const clip = (v: string | null | undefined, max: number) =>
  v ? v.slice(0, max) : null;

/** A Mouser search result as a line part (the web maps its results the same way). */
export function sourcedPart(option: ComponentOption): SourcedPart {
  return {
    manufacturer: option.manufacturer.slice(0, 120),
    partNumber: option.partNumber.slice(0, 120),
    mouserPartNumber: clip(option.mouserPartNumber, 120),
    description: clip(option.description, 500),
    packageType: clip(option.mountingType, 120),
    pricingTiers: option.pricingTiers
      .filter(
        (t) => Number.isInteger(t.quantity) && t.quantity >= 1 && t.price >= 0,
      )
      .slice(0, 20),
    currency: /^[A-Z]{3}$/.test(option.currency ?? '')
      ? option.currency!
      : null,
    availability: clip(option.availability, 200),
    leadTime: clip(option.leadTime, 120),
    rohsStatus: clip(option.rohsStatus, 120),
    lifecycleStatus: clip(option.lifecycleStatus, 120),
    datasheetUrl: /^https?:\/\//.test(option.datasheetLink ?? '')
      ? option.datasheetLink.slice(0, 1000)
      : null,
  };
}

/** Mouser lookup of a selected device by its manufacturer part number. */
export interface PartLookup {
  /** The exact match, or null when Mouser does not list the part. */
  part: SourcedPart | null;
  checkedAt: string;
}

/** The user's choices for one designator, kept across re-runs. */
export interface LineChoice {
  included?: boolean;
  quantity?: number;
  part?: SourcedPart;
  /** A line the user added (not in the circuit). */
  extra?: { category: BomCategory; description: string };
}

/** A patch of one line's choice; `null` resets that field (or removes the extra line). */
export interface LineChoicePatch {
  included?: boolean | null;
  quantity?: number | null;
  part?: SourcedPart | null;
  extra?: { category: BomCategory; description: string } | null;
}

export type BomLineSource =
  'mouser' | 'device_selection' | 'magnetics' | 'thermal' | 'none';

export interface BomLine {
  /** First designator: the line's key in the view. */
  ref: string;
  /** Every designator of the line (same part). */
  refs: string[];
  category: BomCategory;
  role: string | null;
  value: string | null;
  description: string;
  manufacturer: string | null;
  partNumber: string | null;
  mouserPartNumber: string | null;
  packageType: string | null;
  quantity: number;
  /** Price break for the line quantity; null until a part is sourced. */
  unitPrice: number | null;
  extendedPrice: number | null;
  pricingTiers: Array<{ quantity: number; price: number }>;
  currency: string | null;
  availability: string | null;
  leadTime: string | null;
  rohsStatus: string | null;
  lifecycleStatus: string | null;
  datasheetUrl: string | null;
  source: BomLineSource;
  /** The Mouser part was matched automatically (selected device's part number). */
  autoMatched: boolean;
  /** Why the line has no price, or what to check. */
  note: string | null;
  /** Keyword for a distributor search (part number, or type and value). */
  searchKeyword: string;
  included: boolean;
  excludedReason: string | null;
  /** Added by the user, not in the circuit. */
  extra: boolean;
}

export interface BomTotals {
  lines: number;
  quantity: number;
  /** Sum of the priced lines, in `currency`. */
  cost: number;
  currency: string | null;
  pricedLines: number;
  manufacturers: number;
  inStockLines: number;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const fin = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const fail = (
  summary: string,
  payload?: Record<string, unknown>,
): StagePlan => ({
  ok: false,
  result: { ok: false, summary, ...(payload ? { payload } : {}) },
});

const KIND: Record<BomCategory, string> = {
  mosfet: 'Power switch',
  diode: 'Diode',
  inductor: 'Inductor',
  transformer: 'Transformer',
  capacitor: 'Capacitor',
  resistor: 'Resistor',
  ic: 'IC',
  heatsink: 'Heatsink',
  other: 'Part',
};

const SEARCH_WORD: Partial<Record<BomCategory, string>> = {
  capacitor: 'capacitor',
  resistor: 'resistor',
  inductor: 'power inductor',
  transformer: 'transformer',
  diode: 'diode',
  mosfet: 'MOSFET',
};

const SYMBOL: Record<string, string> = { USD: '$', GBP: '£', EUR: '€' };
/** "£992.10", "$2.50", "CHF 3.10". */
export const money = (value: number, currency: string | null) =>
  `${SYMBOL[currency ?? 'USD'] ?? `${currency} `}${value.toFixed(2)}`;

/** Money without float noise (Mouser quotes sub-cent unit prices). */
const cents = (value: number) => Number(value.toFixed(4));

const inStock = (availability: string | null) =>
  /in stock|available/i.test(availability ?? '');

/** Part-number key: case and punctuation ignored ("E6D40065A" = "e6d40065-a"). */
export const partKey = (partNumber: string) =>
  partNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** What the branch already knows about a circuit part. */
function known(
  ref: string,
  category: PartType,
  value: string | null,
  devices: Map<string, SelectedDevice>,
  designs: Map<string, MagneticDesign>,
): Pick<
  BomLine,
  | 'description'
  | 'manufacturer'
  | 'partNumber'
  | 'source'
  | 'searchKeyword'
  | 'note'
> {
  const device = byRef(devices, ref);
  if (device && (category === 'mosfet' || category === 'diode')) {
    const rating = [
      device.vRatingV ? `${device.vRatingV} V` : null,
      device.iRatingA ? `${device.iRatingA} A` : null,
    ]
      .filter(Boolean)
      .join(' / ');
    return {
      description: [
        device.family ?? device.deviceType ?? KIND[category],
        rating,
      ]
        .filter(Boolean)
        .join(', '),
      manufacturer: device.manufacturer,
      partNumber: device.part,
      source: 'device_selection',
      searchKeyword: device.part,
      note: null,
    };
  }
  const design = byRef(designs, ref);
  if (design && (category === 'inductor' || category === 'transformer')) {
    const turns = design.turnsSecondary
      ? `${design.turnsPrimary}:${design.turnsSecondary} turns`
      : `${design.turnsPrimary} turns`;
    return {
      description: [KIND[category], value, `${turns}, ${design.wirePrimary}`]
        .filter(Boolean)
        .join(', '),
      manufacturer: 'Custom',
      partNumber: customWound(design),
      source: 'magnetics',
      // The bobbin-less core set is what is bought.
      searchKeyword: `${design.core} ${design.material}`,
      note: 'Custom wound (Magnetics stage): quote it from a magnetics supplier, or pick the core on Mouser with Find.',
    };
  }
  return {
    description: [KIND[category], value].filter(Boolean).join(' '),
    manufacturer: null,
    partNumber: null,
    source: 'none',
    searchKeyword: [value?.replace(/\s+/g, ''), SEARCH_WORD[category]]
      .filter(Boolean)
      .join(' '),
    note: null,
  };
}

/** Heatsink spec from the Thermal stage's cooling recommendation, if any. */
function heatsinkLine(
  project: StudioProject,
): Pick<BomLine, 'description' | 'source' | 'searchKeyword' | 'note'> | null {
  const result = rec(rec(stageNodeOnBranch(project, 'thermal')?.data).result);
  const cooling = rec(result.cooling);
  const sink = rec(cooling.heatsink);
  const rsa = fin(sink.rsaMaxCW) ?? fin(rec(result.heatsink).rsaRequired);
  if (rsa === undefined) return null;
  const method = str(cooling.method);
  const size = str(sink.sizeHint);
  const limit = `Rθsa ≤ ${Number(rsa.toPrecision(3))} °C/W`;
  return {
    description: [`Heatsink, ${limit}`, method, size]
      .filter(Boolean)
      .join(', '),
    source: 'thermal',
    searchKeyword: 'heatsink TO-247',
    note: `Sized by the Thermal stage: pick a profile whose datasheet gives ${limit} (Find on Mouser).`,
  };
}

/** Applies a sourced part (it replaces what the branch knew). */
function withPart(
  line: BomLine,
  part: SourcedPart | undefined,
  autoMatched = false,
): BomLine {
  if (!part) return line;
  return {
    ...line,
    manufacturer: part.manufacturer,
    partNumber: part.partNumber,
    mouserPartNumber: part.mouserPartNumber,
    description: part.description || line.description,
    packageType: part.packageType,
    pricingTiers: part.pricingTiers,
    currency: part.currency ?? null,
    availability: part.availability,
    leadTime: part.leadTime,
    rohsStatus: part.rohsStatus,
    lifecycleStatus: part.lifecycleStatus,
    datasheetUrl: part.datasheetUrl,
    source: 'mouser',
    autoMatched,
    note: null,
  };
}

/** Unit price at the line quantity (the largest price break it reaches). */
export function unitPriceAt(
  tiers: Array<{ quantity: number; price: number }>,
  quantity: number,
): { price: number; minimum: number } | null {
  // Mouser lists 0 for "quote" breaks: not a price.
  const valid = tiers
    .filter(
      (t) =>
        Number.isFinite(t.price) && t.price > 0 && Number.isFinite(t.quantity),
    )
    .sort((a, b) => a.quantity - b.quantity);
  if (!valid.length) return null;
  let price = valid[0].price;
  for (const tier of valid) if (tier.quantity <= quantity) price = tier.price;
  return { price, minimum: valid[0].quantity };
}

function priced(line: BomLine): BomLine {
  const at = unitPriceAt(line.pricingTiers, line.quantity);
  if (!at) {
    return {
      ...line,
      unitPrice: null,
      extendedPrice: null,
      note:
        line.note ??
        (line.source === 'mouser'
          ? 'Mouser lists no price for this part (quote only).'
          : line.source === 'device_selection'
            ? 'Not priced yet: find this part on Mouser with Find.'
            : 'No part chosen yet: pick one with Find, rated for the voltage and current it sees in the circuit.'),
    };
  }
  return {
    ...line,
    unitPrice: at.price,
    // A minimum order above the quantity is bought whole.
    extendedPrice: cents(at.price * Math.max(line.quantity, at.minimum)),
    note:
      at.minimum > line.quantity
        ? `Minimum order ${at.minimum} on Mouser: the extended price is for ${at.minimum}.`
        : line.note,
  };
}

/** Designators with the same part, in circuit order, as one line. */
function grouped(lines: BomLine[]): BomLine[] {
  const groups = new Map<string, BomLine>();
  for (const line of lines) {
    const key = line.extra
      ? `extra:${refKey(line.ref)}`
      : JSON.stringify([
          line.included,
          line.category,
          line.value,
          line.description,
          line.partNumber,
          line.mouserPartNumber,
          line.source,
          line.autoMatched,
          line.excludedReason,
          line.note,
          line.pricingTiers,
        ]);
    const group = groups.get(key);
    if (group) {
      group.refs.push(line.ref);
      group.quantity += line.quantity;
    } else {
      groups.set(key, { ...line, refs: [line.ref] });
    }
  }
  return [...groups.values()];
}

export function bomTotals(lines: BomLine[]): BomTotals {
  const counted = lines.filter((l) => l.included);
  const withPrice = counted.filter((l) => l.extendedPrice !== null);
  // One currency per Mouser account; a line in another currency is not added.
  const currencies = new Map<string, number>();
  for (const l of withPrice) {
    const c = l.currency ?? 'USD';
    currencies.set(c, (currencies.get(c) ?? 0) + 1);
  }
  const currency = [...currencies].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const inCurrency = withPrice.filter(
    (l) => (l.currency ?? 'USD') === currency,
  );
  return {
    lines: counted.length,
    quantity: counted.reduce((s, l) => s + l.quantity, 0),
    cost: cents(inCurrency.reduce((s, l) => s + (l.extendedPrice ?? 0), 0)),
    currency,
    pricedLines: inCurrency.length,
    manufacturers: new Set(
      counted
        .map((l) => l.manufacturer)
        .filter((m): m is string => !!m && m !== 'Custom'),
    ).size,
    inStockLines: counted.filter((l) => inStock(l.availability)).length,
  };
}

/** Included lines in the export engine's shape (`engines/bom`). */
export function exportParts(lines: BomLine[]): BomSourcePart[] {
  return lines
    .filter((l) => l.included)
    .map((l) => ({
      componentName: (l.refs ?? [l.ref]).join(', '),
      manufacturer: l.manufacturer ?? undefined,
      partNumber: l.partNumber ?? undefined,
      mouserPartNumber: l.mouserPartNumber ?? undefined,
      description: l.description,
      quantity: l.quantity,
      mountingType: l.packageType ?? undefined,
      // The export takes the first tier: the line's own price break.
      pricingTiers:
        l.unitPrice === null ? [] : [{ quantity: 1, price: l.unitPrice }],
      unpriced: l.unitPrice === null,
      availability: l.availability ?? undefined,
      leadTime: l.leadTime ?? undefined,
      rohsStatus: l.rohsStatus ?? undefined,
      lifecycleStatus: l.lifecycleStatus ?? undefined,
      datasheetLink: l.datasheetUrl ?? undefined,
    }));
}

/**
 * Selected-device part numbers to look up on Mouser: included lines without
 * a chosen part and not looked up yet (or not found, when `retryMissing`).
 */
export function partsToLookUp(
  lines: BomLine[],
  lookups: Record<string, PartLookup>,
  retryMissing: boolean,
): string[] {
  const out = new Map<string, string>();
  for (const l of lines) {
    if (!l.included || l.source !== 'device_selection' || !l.partNumber) {
      continue;
    }
    const key = partKey(l.partNumber);
    const stored = lookups[key];
    if (!stored || (retryMissing && stored.part === null)) {
      out.set(key, l.partNumber);
    }
  }
  return [...out.values()];
}

/** Stored choices merged with a patch (`null` fields reset). */
export function mergeChoices(
  stored: Record<string, LineChoice>,
  patch: Record<string, LineChoicePatch>,
): Record<string, LineChoice> {
  const out: Record<string, LineChoice> = { ...stored };
  for (const [ref, change] of Object.entries(patch)) {
    const next: LineChoice = { ...out[ref] };
    for (const field of ['included', 'quantity', 'part', 'extra'] as const) {
      if (!(field in change)) continue;
      const value = change[field];
      if (value === null || value === undefined) delete next[field];
      else (next as Record<string, unknown>)[field] = value;
    }
    if (Object.keys(next).length) out[ref] = next;
    else delete out[ref];
  }
  return out;
}

export async function planBom(
  project: StudioProject,
  patch: Record<string, LineChoicePatch>,
  provider: CircuitDataProvider,
  /** New Mouser lookups (merged over the stored ones). */
  fresh: Record<string, PartLookup> = {},
): Promise<StagePlan> {
  const previous = rec(stageNodeOnBranch(project, 'bom')?.data);
  const choices = mergeChoices(
    rec(previous.choices) as Record<string, LineChoice>,
    patch,
  );
  const lookups: Record<string, PartLookup> = {
    ...(rec(previous.lookups) as Record<string, PartLookup>),
    ...fresh,
  };
  const circuit = await circuitParts(project, provider);
  if (!circuit) {
    return fail(
      'The BOM lists the parts of the branch circuit, and this branch has none yet: choose a topology (select_topology) or import a netlist first.',
      { missing: 'circuit' },
    );
  }
  const devices = selectedDevices(project);
  const designs = magneticDesigns(project);
  const base = (
    ref: string,
    category: BomCategory,
    fields: Partial<BomLine>,
  ): BomLine => ({
    ref,
    refs: [ref],
    category,
    role: null,
    value: null,
    description: KIND[category],
    manufacturer: null,
    partNumber: null,
    mouserPartNumber: null,
    packageType: null,
    quantity: 1,
    unitPrice: null,
    extendedPrice: null,
    pricingTiers: [],
    currency: null,
    availability: null,
    leadTime: null,
    rohsStatus: null,
    lifecycleStatus: null,
    datasheetUrl: null,
    source: 'none',
    autoMatched: false,
    note: null,
    searchKeyword: KIND[category],
    included: true,
    excludedReason: null,
    extra: false,
    ...fields,
  });

  const lines: BomLine[] = circuit.parts.map((p) =>
    base(p.ref, p.type, {
      role: p.role,
      value: p.value,
      ...known(p.ref, p.type, p.value, devices, designs),
      included: p.excludedReason === null,
      excludedReason: p.excludedReason,
    }),
  );
  const sink = heatsinkLine(project);
  const refs = new Set(lines.map((l) => refKey(l.ref)));
  if (sink && !refs.has('hs1')) {
    lines.push(base('HS1', 'heatsink', sink));
    refs.add('hs1');
  }
  for (const [ref, choice] of Object.entries(choices)) {
    if (choice.extra && !refs.has(refKey(ref))) {
      lines.push(
        base(ref, choice.extra.category, {
          description: choice.extra.description,
          searchKeyword: choice.extra.description,
          extra: true,
        }),
      );
      refs.add(refKey(ref));
    }
  }
  // Choices of lines that are gone (circuit edited) are dropped.
  for (const ref of Object.keys(choices)) {
    if (!refs.has(refKey(ref))) delete choices[ref];
  }

  const designators = lines.map((line) => {
    const choice = choices[line.ref] ?? {};
    const own = {
      ...line,
      included: choice.included ?? line.included,
      quantity: choice.quantity ?? line.quantity,
    };
    if (choice.part) return withPart(own, choice.part);
    if (line.source !== 'device_selection' || !line.partNumber) return own;
    const lookup = lookups[partKey(line.partNumber)];
    if (!lookup) return own;
    return lookup.part
      ? withPart(own, lookup.part, true)
      : {
          ...own,
          note: `${line.partNumber} is not listed on Mouser: quote it from ${line.manufacturer ?? 'the manufacturer'} or another distributor, or pick an equivalent with Find.`,
        };
  });
  const final = grouped(designators).map(priced);
  const totals = bomTotals(final);
  if (totals.lines === 0) {
    return fail('Every line is excluded: include at least one part.', {
      missing: 'lines',
    });
  }
  // Only the part numbers still on the BOM keep their lookup.
  const used = new Set(
    lines.flatMap((l) => (l.partNumber ? [partKey(l.partNumber)] : [])),
  );
  const keptLookups = Object.fromEntries(
    Object.entries(lookups).filter(([key]) => used.has(key)),
  );

  const data = JSON.parse(
    JSON.stringify({
      lines: final,
      totals,
      choices,
      lookups: keptLookups,
      currency: totals.currency ?? 'USD',
    }),
  ) as Record<string, unknown>;
  const counted = final.filter((l) => l.included);
  const unpriced = counted.filter((l) => l.unitPrice === null);
  const cost = money(totals.cost, totals.currency);
  return {
    ok: true,
    data,
    summary: `BOM · ${totals.lines} lines · ${totals.quantity} parts${totals.pricedLines ? ` · ${cost}` : ''}`,
    result: (fork) => ({
      ok: true,
      summary: `BOM · ${totals.lines} lines, ${totals.quantity} parts, ${totals.pricedLines}/${totals.lines} priced${totals.pricedLines ? ` (${cost} for the priced lines)` : ''}`,
      payload: {
        lines: counted.map((l) => ({
          refs: l.refs,
          part: l.partNumber ?? l.description,
          manufacturer: l.manufacturer ?? undefined,
          quantity: l.quantity,
          unit_price: l.unitPrice ?? undefined,
          currency: l.unitPrice === null ? undefined : (l.currency ?? 'USD'),
          from: l.autoMatched
            ? 'mouser (matched to the selected device)'
            : l.source,
          note: l.note ?? undefined,
        })),
        excluded: grouped(final.filter((l) => !l.included)).map((l) => ({
          refs: l.refs,
          reason: l.excludedReason ?? 'excluded by the user',
        })),
        totals: {
          lines: totals.lines,
          quantity: totals.quantity,
          priced_lines: totals.pricedLines,
          cost: Number(totals.cost.toFixed(2)),
          currency: totals.currency ?? undefined,
          manufacturers: totals.manufacturers,
          in_stock_lines: totals.inStockLines,
        },
        ...(unpriced.length
          ? {
              note: `${unpriced.length} line(s) have no price (${unpriced
                .slice(0, 12)
                .map((l) => l.refs.join('/'))
                .join(
                  ', ',
                )}); each line's note says why. The cost covers the priced lines only. The user picks Mouser parts per line in the BOM view (Find on Mouser), which also exports XLSX / CSV.`,
            }
          : {}),
        ...fork,
      },
    }),
  };
}
