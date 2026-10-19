/**
 * Ratings parsed from part numbers, ported from qdonis-core
 * `simulator/device_selection.py` (`_voltage_from_part`, `_current_from_part`,
 * `_family`). The library LUT ratings are often the LUT range, not the
 * datasheet rating, so the part number wins when it encodes one.
 */

const DYNEX_VOLTAGE: Record<number, number> = {
  6: 600,
  12: 1200,
  17: 1700,
  33: 3300,
  45: 4500,
  65: 6500,
};

export function voltageFromPart(stem: string): number | null {
  const s = stem.toUpperCase().replace('DNX_', '');
  // Wolfspeed discrete SiC MOSFETs: C3M0065090D -> 900 V; C4MS008065L -> 650 V.
  let m = /^[CE]\dM(\d{4})(\d{3})/.exec(s) ?? /^[CE]\dMS(\d{3})(\d{3})/.exec(s);
  if (m) return Number(m[2]) * 10;
  // Wolfspeed SiC modules: CAB011M12FM3 -> 1200 V; CAB5R0A23GM4 -> 2300 V;
  // CAB525F12XM3 -> 1200 V.
  m = /^[A-Z]{3}\d*R?\d+[MAF](\d{2})/.exec(s);
  if (m && !s.startsWith('DIM')) {
    const code = Number(m[1]);
    return code === 6 ? 650 : code * 100;
  }
  // Wolfspeed SiC Schottky diodes: C3D10065A -> 650 V.
  m = /^(?:[CE]\dD|CSD|CVFD)(\d{2,3})(\d{3})/.exec(s);
  if (m) return Number(m[2]) * 10;
  // Dynex IGBT modules and their diodes: DIM800NSM12-A000 -> 1200 V.
  m = /^DIM(\d+)\D[A-Z0-9]*?(\d{2})-/.exec(s);
  if (m) {
    const code = Number(m[2]);
    return DYNEX_VOLTAGE[code] ?? code * 100;
  }
  return null;
}

export function currentFromPart(stem: string): number | null {
  const s = stem.toUpperCase().replace('DNX_', '');
  let m = /^DIM(\d+)/.exec(s);
  if (m) return Number(m[1]);
  m = /^[CE]\dD(\d{2,3})\d{3}/.exec(s);
  if (m) return Number(m[1]);
  // Wolfspeed SiC modules named by current: CAB450M12XM3 -> 450 A. A code with
  // a leading zero or an R (CAB011M12FM3, CAB3R5M12DM4) is the on-resistance.
  m = /^[A-Z]{3}([1-9]\d{2})[MAF]\d{2}/.exec(s);
  if (m && !s.startsWith('DIM')) return Number(m[1]);
  return null;
}

/**
 * A power module (Wolfspeed SiC modules, Dynex IGBT / diode modules), not a
 * discrete part (C3M0065090D, E4MS008075J2, C3D10065A, CSD01060A, CVFD20065A).
 */
export function isModulePart(stem: string): boolean {
  const s = stem.toUpperCase().replace('DNX_', '');
  return !/^(?:[CE]\d[MD]|CSD|CVFD)/.test(s);
}

export function partFamily(stem: string, type: string): string {
  const s = stem.toUpperCase();
  if (type === 'IGBT') return 'Si IGBT module';
  if (type === 'Diode') {
    return s.startsWith('DIM') || s.startsWith('DNX_DIM')
      ? 'Si diode (IGBT module)'
      : 'SiC Schottky diode';
  }
  return /^[A-Z]{3}\d*R?\d+[MAF]\d{2}/.test(s) && !/^[CE]\dM/.test(s)
    ? 'SiC MOSFET module'
    : 'SiC MOSFET';
}
