/**
 * Display-name <-> library-id mapping for topologies (ported verbatim from
 * the old frontend `mapTopologyNameToBackend` / `humanizeTopology`, so legacy
 * project data maps to the same ids).
 */
const MAPPINGS: Record<string, string> = {
  // DC-DC variations
  'DC-DC Buck Converter': 'dcdc_buck',
  'DC-DC Boost Converter': 'dcdc_boost',
  'DC-DC Buck-Boost Converter': 'dcdc_buck_boost',
  'DC-DC Flyback Converter': 'dcdc_flyback',
  'DC-DC Forward Converter': 'dcdc_single_switch_forward',
  'DC-DC Push-Pull Converter': 'dcdc_push_pull',
  'DC-DC Half-Bridge Converter': 'dcdc_half_bridge',
  'DC-DC Full-Bridge Converter': 'dcdc_full_bridge_centertapped',
  'DC-DC SEPIC Converter': 'dcdc_sepic',
  'DC-DC Ćuk Converter': 'dcdc_cuk',
  'DC-DC Zeta Converter': 'dcdc_zeta',
  'DC-DC Synchronous Buck Converter': 'dcdc_synchronous_buck',
  // Full names with "Converter"
  'Buck Converter': 'dcdc_buck',
  'Boost Converter': 'dcdc_boost',
  'Buck-Boost Converter': 'dcdc_buck_boost',
  'Ćuk Converter': 'dcdc_cuk',
  'Zeta Converter': 'dcdc_zeta',
  // Short names (AI-generated)
  Buck: 'dcdc_buck',
  Boost: 'dcdc_boost',
  'Buck-Boost': 'dcdc_buck_boost',
  Ćuk: 'dcdc_cuk',
  Zeta: 'dcdc_zeta',
  // Isolated topologies
  Flyback: 'dcdc_flyback',
  'Half-Bridge LLC Resonant': 'dcdc_half_bridge_llc_resonant',
  'Full-Bridge LLC Resonant': 'dcdc_full_bridge_llc_resonant',
  'Single-Switch Forward': 'dcdc_single_switch_forward',
  'Push-Pull': 'dcdc_push_pull',
  'Half-Bridge': 'dcdc_half_bridge',
  'Full-Bridge': 'dcdc_full_bridge_centertapped',
  // Special names
  SEPIC: 'dcdc_sepic',
  // Custom JSON library topologies
  'Three-Phase Voltage Source Inverter (SPWM)':
    'dcac_three_phase_voltage_source_inverter',
  '3 Phase Voltage Source Inverter': 'dcac_three_phase_voltage_source_inverter',
  '3-Phase SPWM Inverter': 'dcac_three_phase_voltage_source_inverter',
  '3 Phase Active Front End': 'acdc_three_phase_active_front_end',
  'Three Phase Active Front End': 'acdc_three_phase_active_front_end',
  'AC Voltage Controller': 'dcac_single_phase_h_bridge',
  'Active-Clamp Flyback Converter': 'dcdc_active_clamp_flyback',
  'Back To Back VSI': 'dcac_three_phase_voltage_source_inverter',
  'CLLC Resonant Converter': 'dcdc_cllc_resonant',
  'Direct Matrix Converter': 'dcac_three_phase_voltage_source_inverter',
  'Dual Active Bridge (DAB) Converter': 'dcdc_dual_active_bridge',
  'Dual Active Bridge Converter': 'dcdc_dual_active_bridge',
  'Dual Active Bridge (DAB)': 'dcdc_dual_active_bridge',
  'Dual Active Bridge': 'dcdc_dual_active_bridge',
  'DAB Converter': 'dcdc_dual_active_bridge',
  DAB: 'dcdc_dual_active_bridge',
  'FSBB Converter': 'dcdc_four_switch_buck_boost',
  'Interleaved Multiphase Buck Converter': 'dcdc_interleaved_multiphase_buck',
  'Interleaved-Boost PFC Converter':
    'acdc_single_phase_boost_power_factor_correction',
  'Phase Shift Full Bridge Converter':
    'dcdc_phase_shifted_full_bridge_not_centertapped',
  'Single Phase Boost PFC Rectifier':
    'acdc_single_phase_boost_power_factor_correction',
  'Flyback PFC DCM': 'acdc_flyback_pfc_dcm',
  'Three-Phase Vienna Rectifier': 'acdc_three_phase_vienna',
  'Single Phase Diode Bridge Rectifier': 'acdc_single_phase_diode_bridge',
  'Single Phase Full Wave Rectifier (Transformer)':
    'acdc_single_phase_full_wave(transformer)',
  'Centre Tapped Full Wave Rectifier': 'acdc_centre_tapped_full_wave',
  'Interleaved Boost PFC Rectifier':
    'acdc_interleaved_boost_power_factor_correction',
  'Single Phase Active Front End': 'acdc_single_phase_active_front_end',
  'Single Phase Full Bridge Inverter': 'dcac_single_phase_h_bridge',
  'Single Stage LLC Resonant AC-DC Converter': 'dcdc_llc_resonant',
  'Synchronous Buck Converter': 'dcdc_synchronous_buck',
  'Three Level Neutral Point Clamped': 'dcac_neutral_point_clamped',
  'Totem Pole Bridgeless PFC Rectifier':
    'acdc_totem_pole_power_factor_correction',
  'T-Type Multilevel Inverter': 'dcac_t_type',
  'Two Stage LLC Resonant AC-DC Converter': 'dcdc_llc_resonant',
  'Two Switch Forward Converter': 'dcdc_two_switch_forward',
  'Vienna Rectifier': 'acdc_three_phase_vienna',
  // Case variations
  buck: 'dcdc_buck',
  boost: 'dcdc_boost',
  flyback: 'dcdc_flyback',
  sepic: 'dcdc_sepic',
  dab: 'dcdc_dual_active_bridge',
};

const LIBRARY_ID = /^(dcdc|acdc|dcac)_[a-z0-9_()]+$/;

export function mapTopologyNameToBackend(uiTopologyName: string): string {
  if (LIBRARY_ID.test(uiTopologyName)) return uiTopologyName;
  if (MAPPINGS[uiTopologyName]) return MAPPINGS[uiTopologyName];

  const lowerName = uiTopologyName.toLowerCase().trim();
  for (const [key, value] of Object.entries(MAPPINGS)) {
    if (key.toLowerCase() === lowerName) return value;
  }

  const cleanName = uiTopologyName.replace(/\s*\([^)]*\)/g, ' ').trim();
  const result = cleanName
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/^dc_dc_/, 'dcdc_')
    .replace(/^ac_dc_/, 'acdc_')
    .replace(/^dc_ac_/, 'dcac_');
  if (result.endsWith('_converter')) {
    const stripped = result.replace(/_converter$/, '');
    for (const value of Object.values(MAPPINGS)) {
      if (value === stripped) return stripped;
    }
    for (const [key, value] of Object.entries(MAPPINGS)) {
      const normalised = key
        .toLowerCase()
        .replace(/\s*\([^)]*\)/g, '')
        .trim()
        .replace(/[\s-]+/g, '_')
        .replace(/_converter$/, '');
      if (normalised === stripped) return value;
    }
  }
  return result;
}

const FAMILY: Record<string, string> = {
  dcdc: 'DC-DC',
  acdc: 'AC-DC',
  dcac: 'DC-AC',
};

/** `dcdc_buck` -> `Buck · DC-DC`. */
export function humanizeTopology(id: string): string {
  const [prefix, ...rest] = id.split('_');
  if (!FAMILY[prefix]) return id.replace(/_/g, ' ');
  const name = rest
    .join(' ')
    .replace(/\(([^)]*)\)/g, ' ($1)')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `${name} · ${FAMILY[prefix]}`;
}
