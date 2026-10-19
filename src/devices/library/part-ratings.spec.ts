import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectDevices } from '../../simulation/loss/device-selection';
import {
  currentFromPart,
  isModulePart,
  partFamily,
  voltageFromPart,
} from './part-ratings';

describe('part ratings from part numbers', () => {
  it('reads Wolfspeed module voltages, F variants included', () => {
    expect(voltageFromPart('CAB525F12XM3')).toBe(1200);
    expect(voltageFromPart('CAB011M12FM3')).toBe(1200);
    expect(voltageFromPart('CAB5R0A23GM4')).toBe(2300);
    expect(partFamily('CAB525F12XM3', 'MOSFET with Diode')).toBe(
      'SiC MOSFET module',
    );
  });

  it('reads the current of modules named by current, not by on-resistance', () => {
    expect(currentFromPart('CAB450M12XM3')).toBe(450);
    expect(currentFromPart('CAB525F12XM3')).toBe(525);
    expect(currentFromPart('CAS120M12BM2')).toBe(120);
    expect(currentFromPart('CAB011M12FM3')).toBeNull();
    expect(currentFromPart('CAB3R5M12DM4')).toBeNull();
    expect(currentFromPart('DIM600WHS12-PC500')).toBe(600);
    expect(currentFromPart('C3D10065A')).toBe(10);
  });

  it('tells modules from discrete parts', () => {
    for (const part of [
      'C3M0065090D',
      'E4MS008075J2',
      'C3D10065A',
      'E6D40065A',
      'CSD01060A',
      'CVFD20065A',
    ]) {
      expect([part, isModulePart(part)]).toEqual([part, false]);
    }
    for (const part of [
      'CAB525F12XM3',
      'CAS300M12BM2',
      'DIM600WHS12-PC500',
      'DIM600DDM12-A000 - DIODE',
      'EDB003M06TM3',
    ]) {
      expect([part, isModulePart(part)]).toEqual([part, true]);
    }
  });
});

describe('device selection prefers discrete parts', () => {
  /**
   * A hard-switched switch at 20 kHz, D = 0.5: blocks `vOff`, conducts `iOn`
   * with a 3.5x turn-on spike (the peak sets the current requirement).
   */
  const switchWaveforms = (dir: string, vOff: number, iOn: number) => {
    const rows = { V: '', I: '', Gate: '' };
    const period = 50e-6;
    for (let k = 0; k <= 2000; k += 1) {
      const t = (k * period) / 100;
      const on = k % 100 < 50;
      const time = t.toExponential(6);
      const current = k % 100 < 2 ? 3.5 * iOn : iOn;
      rows.V += `${time} ${on ? 0.2 : vOff}\n`;
      rows.I += `${time} ${on ? current : 0}\n`;
      rows.Gate += `${time} ${on ? 15 : 0}\n`;
    }
    writeFileSync(join(dir, 'V_SW1.csv'), rows.V);
    writeFileSync(join(dir, 'I_SW1.csv'), rows.I);
    writeFileSync(join(dir, 'Gate_SW1.csv'), rows.Gate);
  };

  const pick = (vOff: number, iOn: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'device_select_'));
    try {
      switchWaveforms(dir, vOff, iOn);
      const sel = selectDevices(dir, 100, { SW1: 'switch' });
      const choice = sel.selections[0] as { selected: { part: string } | null };
      return choice.selected?.part ?? null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('picks a discrete part when one carries the current, though a module has less loss', () => {
    // Without the rule: CAB004A12GM4 (800 V, 40 A), a 2300 V CHB module (1000 V, 15 A).
    for (const [vOff, iOn] of [
      [800, 40],
      [1000, 15],
    ]) {
      const part = pick(vOff, iOn);
      expect(part).not.toBeNull();
      expect([vOff, iOn, isModulePart(part as string)]).toEqual([
        vOff,
        iOn,
        false,
      ]);
    }
  });

  it('falls back to a module when no discrete part carries the current', () => {
    const part = pick(800, 80);
    expect(part).not.toBeNull();
    expect(isModulePart(part as string)).toBe(true);
  });
});
