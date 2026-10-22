/**
 * Output trim for the open-loop DC-DC templates.
 *
 * These circuits have no feedback: the duty cycle (or the turns ratio) alone
 * sets Vout, and the sizing formulas are ideal or only roughly loss-corrected,
 * so the simulated output landed 3-15 % off target (buck 12 -> 5 V: 4.59 V,
 * LLC 400 -> 48 V: 51.4 V). After sizing, the transient deck is simulated, the
 * average output measured, and the knob rescaled through the converter's
 * conversion law; repeated once if still off.
 */
import { generateAnalysisCirs } from '../netlist/netlist-generator';
import { pyStr, type Dict } from '../netlist/py';
import {
  allComponents,
  applyUpdatesToYaml,
  enforcePwmRules,
  syncInterleavedBuckPwms,
  type SizingOutcome,
  type Updates,
} from './sizing.logic';

type Law = 'buck' | 'boost' | 'buckboost' | 'linear';

interface Knob {
  ref: string;
  param: 'duty_cycle' | 'turns_ratio' | 'amplitude';
  law: Law;
  /** Highest duty the template's timing allows. */
  maxDuty?: number;
  /** Highest value of a linear knob. */
  max?: number;
  /** Re-derive the dependent PWMs from PWM1. */
  sync?: 'pwm_rules' | 'interleaved';
  /** Other refs that take the same value (the other phases' references). */
  also?: string[];
  /** Refs set to a fixed fraction of the knob (third-harmonic injection). */
  scaled?: Record<string, number>;
  /** Which measured output is the target (default: the DC average). */
  output?: Output;
}

type Output = 'dc' | 'line_rms' | 'rms';

const KNOBS: Record<string, Knob> = {
  dcdc_buck: { ref: 'PWM', param: 'duty_cycle', law: 'buck', maxDuty: 0.95 },
  dcdc_synchronous_buck: {
    ref: 'PWM1',
    param: 'duty_cycle',
    law: 'buck',
    maxDuty: 0.9,
    sync: 'pwm_rules',
  },
  dcdc_interleaved_multiphase_buck: {
    ref: 'PWM1',
    param: 'duty_cycle',
    law: 'buck',
    maxDuty: 0.9,
    sync: 'interleaved',
  },
  dcdc_boost: { ref: 'PWM', param: 'duty_cycle', law: 'boost', maxDuty: 0.9 },
  dcdc_buck_boost: {
    ref: 'PWM',
    param: 'duty_cycle',
    law: 'buckboost',
    maxDuty: 0.9,
  },
  dcdc_sepic: {
    ref: 'PWM',
    param: 'duty_cycle',
    law: 'buckboost',
    maxDuty: 0.9,
  },
  dcdc_cuk: { ref: 'PWM', param: 'duty_cycle', law: 'buckboost', maxDuty: 0.9 },
  dcdc_zeta: {
    ref: 'PWM',
    param: 'duty_cycle',
    law: 'buckboost',
    maxDuty: 0.85,
  },
  dcdc_four_switch_buck_boost: {
    ref: 'PWM1',
    param: 'duty_cycle',
    law: 'buckboost',
    maxDuty: 0.9,
    sync: 'pwm_rules',
  },
  // Isolated: the output is linear in Ns/Np; the duty stays where the timing
  // rules (core reset, symmetric halves, ZVS) put it.
  dcdc_flyback: { ref: 'T1', param: 'turns_ratio', law: 'linear' },
  dcdc_active_clamp_flyback: { ref: 'T1', param: 'turns_ratio', law: 'linear' },
  dcdc_single_switch_forward: {
    ref: 'T1',
    param: 'turns_ratio',
    law: 'linear',
  },
  dcdc_two_switch_forward: { ref: 'T1', param: 'turns_ratio', law: 'linear' },
  dcdc_push_pull: { ref: 'T1', param: 'turns_ratio', law: 'linear' },
  dcdc_half_bridge: { ref: 'T1', param: 'turns_ratio', law: 'linear' },
  dcdc_full_bridge_centertapped: {
    ref: 'T1',
    param: 'turns_ratio',
    law: 'linear',
  },
  dcdc_phase_shifted_full_bridge_not_centertapped: {
    ref: 'T1',
    param: 'turns_ratio',
    law: 'linear',
  },
  dcdc_half_bridge_llc_resonant: {
    ref: 'T1',
    param: 'turns_ratio',
    law: 'linear',
  },
  dcdc_full_bridge_llc_resonant: {
    ref: 'T1',
    param: 'turns_ratio',
    law: 'linear',
  },
  dcdc_cllc_resonant: { ref: 'T1', param: 'turns_ratio', law: 'linear' },
  // DCM flyback PFC (constant on-time, open loop): the power, and so
  // Vout = sqrt(P R), scales with the duty; kept below 0.5 to stay in DCM.
  acdc_flyback_pfc_dcm: {
    ref: 'PWM',
    param: 'duty_cycle',
    law: 'buck',
    maxDuty: 0.5,
  },
  // Open-loop SPWM: the reference amplitude (against the +/-10 V carrier) is
  // the modulation index; dead band and switch drops pull V_LL 6-9 % low.
  dcac_three_phase_voltage_source_inverter: {
    ref: 'V2',
    param: 'amplitude',
    law: 'linear',
    max: 11.547,
    also: ['V3', 'V4'],
    scaled: { V6: 1 / 6 },
    output: 'line_rms',
  },
  dcac_single_phase_h_bridge: {
    ref: 'VREF',
    param: 'amplitude',
    law: 'linear',
    max: 10,
    output: 'rms',
  },
};

/** Trim when the error is above this; give up past MAX_ERR (a broken design). */
const TOLERANCE = 0.01;
const MAX_ERR = 0.4;
const MAX_TRIMS = 2;

export const hasOpenLoopTrim = (topologyId: string): boolean =>
  topologyId in KNOBS;

/** Names of the output measurement, most specific first. */
function outputPatterns(output: Output): RegExp[] {
  return output === 'line_rms'
    ? [/^vout_ll_rms/i, /(ll|line).*rms/i]
    : output === 'rms'
      ? [/^vout_rms/i, /^v_?(out|load).*rms/i]
      : [/^vout_avg/i, /^v_?out.*avg/i, /vout.*(steady|final|mean)/i];
}

/**
 * Output of the transient results: the DC average, or (inverters) the
 * line-to-line RMS.
 */
export function measuredVout(
  results: unknown,
  output: Output = 'dc',
): number | null {
  const transient = (results as Dict | null)?.transient;
  if (!transient || typeof transient !== 'object') return null;
  for (const pattern of outputPatterns(output)) {
    for (const req of Object.values(transient as Dict)) {
      const outputs = (req as Dict | null)?.outputs;
      if (!outputs || typeof outputs !== 'object') continue;
      for (const [key, out] of Object.entries(outputs as Dict)) {
        const value = (out as Dict | null)?.value;
        if (
          pattern.test(key) &&
          typeof value === 'number' &&
          Number.isFinite(value)
        )
          return value;
      }
    }
  }
  return null;
}

function componentParams(yaml: Dict, ref: string): Dict | null {
  for (const [comp] of allComponents(yaml.components ?? [])) {
    if (pyStr(comp.ref ?? '') === ref) {
      const p = comp.params;
      return p && typeof p === 'object' ? (p as Dict) : null;
    }
  }
  return null;
}

/** Knob value giving `ratio` times the present output. */
function rescale(knob: Knob, value: number, ratio: number): number {
  const clamp = (d: number) => Math.min(Math.max(d, 0.02), knob.maxDuty ?? 0.9);
  switch (knob.law) {
    case 'linear':
      return knob.max ? Math.min(value * ratio, knob.max) : value * ratio;
    case 'buck':
      return clamp(value * ratio);
    case 'boost': {
      // M = 1 / (1 - D)
      return clamp(1 - (1 - value) / ratio);
    }
    case 'buckboost': {
      // M = D / (1 - D)
      const m = (value / (1 - value)) * ratio;
      return clamp(m / (1 + m));
    }
  }
}

const round6 = (v: number) => Number(v.toPrecision(6));

/**
 * The design with only the transient requirement that sets the output target
 * (the trim does not need the dynamic / efficiency / stress runs: a buck's four
 * requirements made each check ~4x slower). When that requirement does not
 * measure the output (the half bridge states the target only on its line / load
 * steps, which measure deviations), the first one that does is kept instead.
 */
function outputOnly(yaml: Dict, output: Output): Dict {
  const transient = (yaml.analysis as Dict | undefined)?.transient as
    Dict | undefined;
  const reqs: unknown = transient?.requirements;
  if (!Array.isArray(reqs) || reqs.length < 2) return yaml;
  const patterns = outputPatterns(output);
  const measures = (r: unknown, pattern: RegExp): boolean => {
    const outs = (r as Dict | null)?.outputs;
    return (
      Array.isArray(outs) &&
      outs.some((o) => pattern.test(pyStr((o as Dict | null)?.var ?? '')))
    );
  };
  const list = reqs as unknown[];
  const targeted = list.find((r) => {
    const c = (r as Dict | null)?.criteria;
    return (
      !!c &&
      typeof c === 'object' &&
      ('target_vout' in c || 'target_vout_rms' in c)
    );
  });
  const keep: unknown =
    targeted !== undefined && patterns.some((p) => measures(targeted, p))
      ? targeted
      : (patterns
          .map((p) => list.find((r) => measures(r, p)))
          .find((r) => r !== undefined) ??
        targeted ??
        list[0]);
  const copy = structuredClone(yaml);
  ((copy.analysis as Dict).transient as Dict).requirements = [keep];
  return copy;
}

const KNOB_NAMES: Record<Knob['param'], string> = {
  duty_cycle: 'duty cycle',
  turns_ratio: 'turns ratio',
  amplitude: 'modulation index (reference amplitude)',
};

export interface TrimResult {
  outcome: SizingOutcome;
  /** Markdown appended to the design reasoning (empty: nothing done). */
  note: string;
}

/**
 * Simulates the sized design and rescales its open-loop knob until the average
 * output is within 1 % of `target` (at most two trims). `simulate` runs the
 * transient deck and returns the structured results.
 */
export async function trimOpenLoopOutput(
  topologyId: string,
  outcome: SizingOutcome,
  params: Dict,
  target: number | null,
  simulate: (transientDeck: string) => Promise<unknown>,
): Promise<TrimResult> {
  const knob = KNOBS[topologyId];
  if (!knob || !target) return { outcome, note: '' };
  const goal = Math.abs(target);
  const lines: string[] = [];
  let yaml = outcome.yaml;
  const updates: Updates = outcome.updates;
  for (let pass = 0; pass <= MAX_TRIMS; pass += 1) {
    const deck = generateAnalysisCirs(
      outputOnly(yaml, knob.output ?? 'dc'),
      'transient',
    ).analysis_cirs.transient;
    if (!deck) break;
    let vout: number | null;
    try {
      vout = measuredVout(await simulate(deck), knob.output);
    } catch {
      break; // the simulation stage will report the failure
    }
    if (vout === null || !Number.isFinite(vout) || vout === 0) break;
    // Inverting converters (buck-boost, Cuk) report a negative output: compare magnitudes.
    const err = Math.abs(vout) / goal - 1;
    lines.push(
      `${pass === 0 ? 'Sized design' : `After trim ${pass}`}: simulated ${round6(Math.abs(vout))} V (${(err * 100).toFixed(1)} %)`,
    );
    if (Math.abs(err) <= TOLERANCE || Math.abs(err) > MAX_ERR) break;
    if (pass === MAX_TRIMS) break;
    const p = componentParams(yaml, knob.ref);
    const now = Number(p?.[knob.param]);
    if (!p || !Number.isFinite(now) || now <= 0) break;
    const next = round6(rescale(knob, now, goal / Math.abs(vout)));
    if (next === now) break;
    const patch: Updates = {};
    const set = (ref: string, value: number) => {
      patch[ref] = { ...(updates[ref] ?? {}), [knob.param]: value };
      updates[ref] = patch[ref];
    };
    for (const ref of [knob.ref, ...(knob.also ?? [])]) set(ref, next);
    for (const [ref, k] of Object.entries(knob.scaled ?? {})) {
      if (componentParams(yaml, ref)) set(ref, round6(next * k));
    }
    if (knob.sync) {
      if (knob.sync === 'interleaved') syncInterleavedBuckPwms(yaml, updates);
      else enforcePwmRules(yaml, updates, params);
      for (const [ref, value] of Object.entries(updates)) {
        if (ref.startsWith('PWM')) patch[ref] = value;
      }
    }
    yaml = structuredClone(yaml);
    applyUpdatesToYaml(yaml, patch, params);
    lines.push(`  ${knob.ref}.${knob.param} ${round6(now)} -> ${next}`);
  }
  if (lines.length <= 1 && !lines.some((l) => l.includes('->'))) {
    return {
      outcome: { ...outcome, yaml },
      note: lines.length
        ? `\n\n## Output check (open loop)\n- ${lines[0]}; no trim needed.`
        : '',
    };
  }
  return {
    outcome: { ...outcome, yaml, updates },
    note: `\n\n## Output trim (open loop)\nThis circuit has no feedback loop, so the sized ${KNOB_NAMES[knob.param]} was checked by simulation and rescaled to reach ${goal} V${knob.output === 'line_rms' ? ' line-to-line RMS' : knob.output === 'rms' ? ' RMS' : ''}:\n${lines.map((l) => (l.startsWith('  ') ? `  - ${l.trim()}` : `- ${l}`)).join('\n')}`,
  };
}
