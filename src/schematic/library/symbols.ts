/**
 * Symbol registry: the one table between topology-YAML component types and
 * the Studio engine's schematic symbols. Every YAML type / variant maps to
 * exactly one symbol with its YAML pin -> terminal map, and every palette
 * part maps back to one YAML component. The engine gets the pin geometry with
 * every drawing, so placer, router and drawing can not drift apart.
 * Port of qdonis-core `schematic_symbols.py` (feature/synced-schematic).
 *
 * Terminal names are internal: every three-terminal transistor uses D
 * (upper), S (lower), G (control), so a saved layout survives a symbol change.
 */

import {
  CONTROL_BLOCK_DEFAULTS,
  CONTROL_BLOCK_GLYPHS,
  CONTROL_BLOCK_TYPES,
  blockPins,
  controlBlockSymbolPins,
  type PinGeometry,
} from '../../simulation/netlist/signal-blocks';
import {
  or,
  pyStr,
  pyStr as text,
  type Dict as Json,
} from '../../simulation/netlist/py';

/** Terminal -> [x, y, dx, dy] unrotated; (dx, dy) is the direction a wire leaves. */
export type PinTable = Readonly<
  Record<string, readonly [number, number, number, number]>
>;

const TWO: PinTable = { A: [0, -40, 0, -1], B: [0, 40, 0, 1] };
const FOUR: PinTable = {
  A: [0, -40, 0, -1],
  B: [0, 40, 0, 1],
  CP: [-40, -20, -1, 0],
  CN: [-40, 20, -1, 0],
};
const TRANSISTOR: PinTable = {
  D: [0, -40, 0, -1],
  S: [0, 40, 0, 1],
  G: [-20, 0, -1, 0],
};
export const TWO_TERMINAL = TWO;

export const TRANSISTOR_SYMBOLS = [
  'MOSFET',
  'PMOS',
  'IGBT',
  'NJFET',
  'PJFET',
  'NPN',
  'PNP',
] as const;

const each = (names: readonly string[], table: PinTable) =>
  Object.fromEntries(names.map((name) => [name, table]));

export const PINS: Readonly<Record<string, PinTable>> = {
  ...each(['R', 'L', 'C', 'D', 'V', 'AC_V', 'VPULSE'], TWO),
  ...each(TRANSISTOR_SYMBOLS, TRANSISTOR),
  // A behavioural source may list the nodes its expression reads as ctrl+ /
  // ctrl- (ignored by SPICE): drawn as dashed sense inputs.
  ...each(['VSW', 'ESRC', 'GSRC', 'BSRC'], FOUR),
  // E source with control inputs: an amplifier, inputs left, output right.
  EAMP: {
    CP: [-40, -20, -1, 0],
    CN: [-40, 20, -1, 0],
    A: [40, 0, 1, 0],
    B: [0, 40, 0, 1],
  },
  XFMR: {
    P1: [-20, -40, 0, -1],
    P2: [-20, 40, 0, 1],
    S1: [20, -40, 0, -1],
    S2: [20, 40, 0, 1],
  },
  XFMR_CT: {
    P1: [-20, -40, 0, -1],
    P2: [-20, 40, 0, 1],
    S1: [20, -40, 0, -1],
    SCT: [20, 0, 1, 0],
    S2: [20, 40, 0, 1],
  },
  XFMR_DCT: {
    P1: [-20, -40, 0, -1],
    PCT: [-20, 0, -1, 0],
    P2: [-20, 40, 0, 1],
    S1: [20, -40, 0, -1],
    SCT: [20, 0, 1, 0],
    S2: [20, 40, 0, 1],
  },
  LABEL: { P: [-20, 0, -1, 0] },
  PORT: { P: [-20, 0, -1, 0] },
  GND: { P: [0, -20, 0, -1] },
  SPICE: {},
};

/** Half extents of each symbol (unrotated), for placement. */
export const EXTENT: Readonly<Record<string, readonly [number, number]>> = {
  XFMR: [36, 44],
  XFMR_CT: [40, 44],
  XFMR_DCT: [40, 44],
  LABEL: [46, 12],
  PORT: [46, 12],
  GND: [14, 22],
  SPICE: [80, 16],
  VSW: [44, 44],
  ESRC: [44, 44],
  GSRC: [44, 44],
  BSRC: [44, 44],
  EAMP: [44, 44],
  ...Object.fromEntries(TRANSISTOR_SYMBOLS.map((t) => [t, [26, 44] as const])),
};

/** Pin map key that matches any YAML pin (labels, grounds). */
export const ANY = '*';
type PinMap = Readonly<Record<string, string>>;
const PASSIVE: PinMap = {
  pos: 'A',
  pin1: 'A',
  p: 'A',
  '+': 'A',
  neg: 'B',
  pin2: 'B',
  n: 'B',
  '-': 'B',
};
const SOURCE: PinMap = {
  '+': 'A',
  plus: 'A',
  pos: 'A',
  '': 'A',
  output: 'A',
  '-': 'B',
  minus: 'B',
  neg: 'B',
  return: 'B',
};
const CONTROLLED: PinMap = {
  '+': 'A',
  pos: 'A',
  '-': 'B',
  neg: 'B',
  'ctrl+': 'CP',
  'ctrl-': 'CN',
};
const FET: PinMap = { drain: 'D', source: 'S', body: 'S', gate: 'G' };
const IGBT: PinMap = {
  collector: 'D',
  emitter: 'S',
  gate: 'G',
  drain: 'D',
  source: 'S',
};
const BJT: PinMap = { collector: 'D', emitter: 'S', base: 'G' };

/** Python `str(params.get(key) or fallback).lower()`. */
const lowerOr = (params: Json, key: string, fallback: string) =>
  text(or(params[key], fallback)).toLowerCase();

export const isAcSource = (params: Json): boolean =>
  ['sine', 'sin', 'ac'].includes(lowerOr(params, 'source', 'dc'));

/** Symbol of a transistor, by the netlist generator's family / polarity rules. */
function transistorSymbol(ctype: string, params: Json): [string, PinMap] {
  const family = text(
    or(params.family, ctype === 'transistor' ? 'bjt' : ctype),
  ).toLowerCase();
  if (family === 'bjt') {
    return [lowerOr(params, 'type', 'npn') === 'pnp' ? 'PNP' : 'NPN', BJT];
  }
  if (family === 'jfet') {
    return [
      lowerOr(params, 'polarity', 'n').startsWith('p') ? 'PJFET' : 'NJFET',
      FET,
    ];
  }
  if (family === 'igbt') return ['IGBT', IGBT];
  if (family === 'vdmos') {
    const model = text(
      or(or(params.model, params.model_name), 'power_nmos'),
    ).toLowerCase();
    return [
      model.includes('pmos') || model.includes('pchan') ? 'PMOS' : 'MOSFET',
      FET,
    ];
  }
  // mosfet / vg-fet: p-channel when the channel type mentions "p".
  const channel = text(
    or(or(params.channelType, params.type), 'nmos'),
  ).toLowerCase();
  return [channel.includes('p') ? 'PMOS' : 'MOSFET', FET];
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const paramsOf = (comp: Json): Json =>
  isObject(comp.params) ? comp.params : {};

/** [engine symbol, YAML pin -> terminal]; "BLOCK" = no symbol fits. */
export function symbolFor(comp: Json): [string, PinMap] {
  const ctype = text(or(comp.type, ''));
  const params = paramsOf(comp);
  if (Object.hasOwn(CONTROL_BLOCK_TYPES, ctype)) {
    const { inputs, outputs } = blockPins(ctype, params);
    return [
      `CB_${ctype}`,
      Object.fromEntries([...inputs, ...outputs].map((pin) => [pin, pin])),
    ];
  }
  switch (ctype) {
    case 'resistor':
      return ['R', PASSIVE];
    case 'capacitor':
      return ['C', PASSIVE];
    case 'inductor':
      return ['L', PASSIVE];
    case 'diode':
      return ['D', { anode: 'A', cathode: 'B', pos: 'A', neg: 'B' }];
    case 'transistor':
    case 'mosfet':
    case 'igbt':
    case 'vg-fet':
      return transistorSymbol(ctype, params);
    case 'switch':
      return ['VSW', CONTROLLED];
    case 'b_source':
      return ['BSRC', CONTROLLED];
    case 'e_source':
      // gain form: an amplifier; expression form (VALUE = {...}): a source
      return [
        Object.hasOwn(params, 'expression') || Object.hasOwn(params, 'value')
          ? 'ESRC'
          : 'EAMP',
        CONTROLLED,
      ];
    case 'g_source':
      return ['GSRC', CONTROLLED];
    case 'transformer':
      return ['XFMR', { P1: 'P1', P2: 'P2', S1: 'S1', S2: 'S2' }];
    case 'ct_transformer':
      return ['XFMR_CT', { P1: 'P1', P2: 'P2', S1: 'S1', S2: 'S2', CT: 'SCT' }];
    case 'dual_ct_transformer':
      return [
        'XFMR_DCT',
        {
          P1: 'P1',
          CT_P: 'PCT',
          P2: 'P2',
          S1: 'S1',
          CT_S: 'SCT',
          S2: 'S2',
        },
      ];
    case 'custom_spice':
      return ['SPICE', {}];
    case 'node': {
      const nodeType = params.node_type;
      if (nodeType === 'voltage_source') {
        return [isAcSource(params) ? 'AC_V' : 'V', SOURCE];
      }
      if (nodeType === 'pwm_control') return ['VPULSE', SOURCE];
      if (
        nodeType === 'label' ||
        nodeType === 'net' ||
        nodeType === 'net_label'
      ) {
        return ['LABEL', { [ANY]: 'P' }];
      }
      if (nodeType === 'ground') return ['GND', { [ANY]: 'P' }];
      break;
    }
  }
  return ['BLOCK', {}];
}

const SOURCES = new Set(['BSRC', 'ESRC', 'EAMP', 'GSRC']);

const own = (map: PinMap, key: string): string | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

/**
 * [symbol, YAML pin -> terminal] for a component whose pins sit on the nets
 * `used`; terminals null when the symbol can not show those pins truthfully
 * (the part is then drawn as a generic BLOCK). B / E / G sources: a `pos` /
 * `neg` beside `+` / `-` names one of the part's nodes and is drawn there.
 */
export function pinTerminals(
  comp: Json,
  used: ReadonlyMap<string, string>,
): [string, Map<string, string> | null] {
  const [symbol, pinMap] = symbolFor(comp);
  if (symbol === 'BLOCK') return [symbol, null];
  const table = PINS[symbol] as PinTable | undefined;
  const out = new Map<string, string>();
  for (const [pin, net] of used) {
    let terminal: string | undefined = own(pinMap, ANY) || own(pinMap, pin);
    if (
      SOURCES.has(symbol) &&
      (pin === 'pos' || pin === 'neg') &&
      (used.has('+') || used.has('-'))
    ) {
      const same = ['+', '-', 'ctrl+', 'ctrl-'].find(
        (p) => used.has(p) && used.get(p) === net,
      );
      terminal = same ? own(pinMap, same) : undefined;
    }
    // The symbol must really have the terminal.
    if (terminal === undefined || (table && !Object.hasOwn(table, terminal))) {
      return [symbol, null];
    }
    // Two YAML pins on one terminal must be the same node.
    for (const [p, t] of out) {
      if (t === terminal && used.get(p) !== net) return [symbol, null];
    }
    out.set(pin, terminal);
  }
  return [symbol, out];
}

// ---------------------------------------------------------------------------
// Palette: parts the user can add in the editor (engine symbol -> YAML part).
// ---------------------------------------------------------------------------

export interface PaletteEntry {
  type: string;
  label: string;
  prefix: string;
  group?: string;
  yaml: { type: string; params?: Json };
  parameters: Record<string, string>;
  /** Engine terminal -> YAML pin. */
  pins: Record<string, string>;
  pinsGeom?: Record<string, PinGeometry>;
  glyph?: string;
}

const FET_PINS = { D: 'drain', S: 'source', G: 'gate' };
const CONTROLLED_PINS = { A: '+', B: '-', CP: 'ctrl+', CN: 'ctrl-' };

const BLOCK_PREFIX: Record<string, string> = {
  gain: 'K',
  sum: 'SUM',
  product: 'MUL',
  const: 'CONST',
  function: 'FN',
  limiter: 'LIM',
  comparator: 'CMP',
  integrator: 'INT',
  lowpass: 'LPF',
  pi: 'PI',
  pid: 'PID',
  carrier: 'CAR',
  pwm: 'PWM',
  gate_driver: 'DRV',
  and: 'AND',
  or: 'OR',
  not: 'NOT',
  xor: 'XOR',
};

export const PALETTE: readonly PaletteEntry[] = [
  {
    type: 'R',
    label: 'Resistor',
    prefix: 'R',
    yaml: { type: 'resistor' },
    parameters: { resistance: '10' },
    pins: { A: 'pos', B: 'neg' },
  },
  {
    type: 'C',
    label: 'Capacitor',
    prefix: 'C',
    yaml: { type: 'capacitor' },
    parameters: { capacitance: '1u', esr: '10m' },
    pins: { A: 'pos', B: 'neg' },
  },
  {
    type: 'L',
    label: 'Inductor',
    prefix: 'L',
    yaml: { type: 'inductor' },
    parameters: { inductance: '100u', series_resistance: '10m' },
    pins: { A: 'pos', B: 'neg' },
  },
  {
    type: 'D',
    label: 'Diode',
    prefix: 'D',
    yaml: { type: 'diode' },
    parameters: {
      Is: '1p',
      n: '1.1',
      Rs: '50m',
      Cjo: '10p',
      Tt: '20n',
      Bv: '600',
    },
    pins: { A: 'anode', B: 'cathode' },
  },
  {
    type: 'MOSFET',
    label: 'N-MOSFET',
    prefix: 'Q',
    yaml: { type: 'transistor' },
    parameters: {
      family: 'mosfet',
      type: 'nmos',
      mode: 'enhancement',
      voltage_rating: '100',
      current_rating: '10',
    },
    pins: FET_PINS,
  },
  {
    type: 'PMOS',
    label: 'P-MOSFET',
    prefix: 'Q',
    yaml: { type: 'transistor' },
    parameters: {
      family: 'mosfet',
      type: 'pmos',
      mode: 'enhancement',
      voltage_rating: '100',
      current_rating: '10',
    },
    pins: FET_PINS,
  },
  {
    // Simulated as a MOSFET: drain / source pin names.
    type: 'IGBT',
    label: 'IGBT',
    prefix: 'Q',
    yaml: { type: 'transistor' },
    parameters: { family: 'igbt', voltage_rating: '600', current_rating: '20' },
    pins: FET_PINS,
  },
  {
    type: 'NJFET',
    label: 'N-JFET',
    prefix: 'J',
    yaml: { type: 'transistor' },
    parameters: { family: 'jfet', polarity: 'n' },
    pins: FET_PINS,
  },
  {
    type: 'PJFET',
    label: 'P-JFET',
    prefix: 'J',
    yaml: { type: 'transistor' },
    parameters: { family: 'jfet', polarity: 'p' },
    pins: FET_PINS,
  },
  {
    type: 'NPN',
    label: 'NPN transistor',
    prefix: 'Q',
    yaml: { type: 'transistor' },
    parameters: { family: 'bjt', type: 'npn' },
    pins: { D: 'collector', S: 'emitter', G: 'base' },
  },
  {
    type: 'PNP',
    label: 'PNP transistor',
    prefix: 'Q',
    yaml: { type: 'transistor' },
    parameters: { family: 'bjt', type: 'pnp' },
    pins: { D: 'collector', S: 'emitter', G: 'base' },
  },
  {
    type: 'VSW',
    label: 'Controlled switch',
    prefix: 'S',
    yaml: { type: 'switch' },
    parameters: { model: 'sw_ctrl' },
    pins: { A: 'pos', B: 'neg', CP: 'ctrl+', CN: 'ctrl-' },
  },
  {
    type: 'V',
    label: 'DC source',
    prefix: 'V',
    yaml: { type: 'node', params: { node_type: 'voltage_source' } },
    parameters: { voltage: '12', source: 'dc' },
    pins: { A: '+', B: '-' },
  },
  {
    type: 'AC_V',
    label: 'AC source',
    prefix: 'VAC',
    yaml: { type: 'node', params: { node_type: 'voltage_source' } },
    parameters: { source: 'sine', amplitude: '325', frequency: '50' },
    pins: { A: '+', B: '-' },
  },
  {
    type: 'VPULSE',
    label: 'PWM source',
    prefix: 'PWM',
    yaml: { type: 'node', params: { node_type: 'pwm_control' } },
    parameters: {
      frequency: '100k',
      duty_cycle: '0.5',
      vhigh: '12',
      vlow: '0',
      trise: '100n',
      tfall: '100n',
      tdelay: '0',
      drive_resistance: '10',
    },
    pins: { A: 'pos', B: 'neg' },
  },
  {
    type: 'XFMR',
    label: 'Transformer',
    prefix: 'T',
    yaml: { type: 'transformer' },
    parameters: {
      Lm_primary: '1m',
      turns_ratio: '1',
      k_coupling: '0.99',
      phase: 'same',
    },
    pins: { P1: 'P1', P2: 'P2', S1: 'S1', S2: 'S2' },
  },
  {
    type: 'XFMR_CT',
    label: 'Centre-tap transformer',
    prefix: 'T',
    yaml: { type: 'ct_transformer' },
    parameters: {
      Lm_primary: '1m',
      turns_ratio: '1',
      k_coupling: '0.99',
      phase_s1: 'same',
      phase_s2: 'opposite',
    },
    pins: { P1: 'P1', P2: 'P2', S1: 'S1', SCT: 'CT', S2: 'S2' },
  },
  {
    type: 'XFMR_DCT',
    label: 'Dual centre-tap transformer',
    prefix: 'T',
    yaml: { type: 'dual_ct_transformer' },
    parameters: {
      Lm_primary: '1m',
      turns_ratio: '1',
      k_coupling: '0.99',
      phase_s1: 'same',
      phase_s2: 'opposite',
    },
    pins: {
      P1: 'P1',
      PCT: 'CT_P',
      P2: 'P2',
      S1: 'S1',
      SCT: 'CT_S',
      S2: 'S2',
    },
  },
  {
    type: 'BSRC',
    label: 'Behavioural source',
    prefix: 'B',
    yaml: { type: 'b_source' },
    parameters: { expression: '0' },
    pins: CONTROLLED_PINS,
  },
  {
    type: 'EAMP',
    label: 'VCVS / amplifier (E)',
    prefix: 'E',
    yaml: { type: 'e_source' },
    parameters: { gain: '1' },
    pins: CONTROLLED_PINS,
  },
  {
    type: 'ESRC',
    label: 'Expression source (E)',
    prefix: 'E',
    yaml: { type: 'e_source' },
    parameters: { expression: '0' },
    pins: CONTROLLED_PINS,
  },
  {
    type: 'GSRC',
    label: 'VCCS (G)',
    prefix: 'G',
    yaml: { type: 'g_source' },
    parameters: { gain: '1m' },
    pins: CONTROLLED_PINS,
  },
  {
    type: 'SPICE',
    label: 'SPICE directive',
    prefix: 'SPICE',
    yaml: { type: 'custom_spice' },
    parameters: { spice_line: '* comment' },
    pins: {},
  },
  {
    type: 'LABEL',
    label: 'Net label',
    prefix: 'NET',
    yaml: { type: 'node', params: { node_type: 'label' } },
    parameters: { net_name: 'NET' },
    pins: { P: 'pin' },
  },
  {
    type: 'GND',
    label: 'Ground',
    prefix: 'GND',
    yaml: { type: 'node', params: { node_type: 'ground' } },
    parameters: {},
    pins: { P: 'pin' },
  },
  ...Object.entries(CONTROL_BLOCK_TYPES).map(([btype, label]) => {
    const defaults = CONTROL_BLOCK_DEFAULTS[btype];
    const { inputs, outputs } = blockPins(btype, defaults);
    return {
      type: `CB_${btype}`,
      label,
      prefix: BLOCK_PREFIX[btype] ?? 'CB',
      group: 'Control blocks',
      yaml: { type: btype },
      parameters: Object.fromEntries(
        Object.entries(defaults).map(([k, v]) => [k, pyStr(v)]),
      ),
      pins: Object.fromEntries(
        [...inputs, ...outputs].map((pin) => [pin, pin]),
      ),
      pinsGeom: controlBlockSymbolPins(btype, defaults),
      glyph: CONTROL_BLOCK_GLYPHS[btype] ?? '',
    };
  }),
];

export const PALETTE_BY_TYPE: ReadonlyMap<string, PaletteEntry> = new Map(
  PALETTE.map((entry) => [entry.type, entry]),
);

/** The YAML component a palette entry adds (without ref). */
export function paletteYaml(entry: PaletteEntry): Json {
  return {
    type: entry.yaml.type,
    params: { ...(entry.yaml.params ?? {}), ...entry.parameters },
  };
}

/** The palette as the engine receives it. */
export function paletteForEngine(): Json[] {
  return PALETTE.map((p) => {
    const out: Json = {
      type: p.type,
      label: p.label,
      prefix: p.prefix,
      parameters: p.parameters,
    };
    if (p.group !== undefined) out.group = p.group;
    if (p.pinsGeom !== undefined) out.pinsGeom = p.pinsGeom;
    if (p.glyph !== undefined) out.glyph = p.glyph;
    return out;
  });
}

/** Pin geometry of every fixed symbol, in the engine's format. */
export function symbolsForEngine(): Record<
  string,
  Record<string, PinGeometry>
> {
  return Object.fromEntries(
    Object.entries(PINS).map(([symbol, table]) => [
      symbol,
      Object.fromEntries(
        Object.entries(table).map(([t, [x, y, dx, dy]]) => [
          t,
          { x, y, dx, dy },
        ]),
      ),
    ]),
  );
}

export const symbolLabel = (symbol: string): string | null =>
  PALETTE_BY_TYPE.get(symbol)?.label ?? null;
