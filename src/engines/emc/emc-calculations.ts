// Ported verbatim from the old frontend; keep numerically identical (see specs).
/**
 * EMC Conducted Emissions Calculation Engine
 *
 * Exact replication of the Excel tool's 8-sheet pipeline:
 *   Switching Freq (kHz) → Duty Cycle → Fourier Bn → Radial Freq →
 *   Harmonic Current → 1st Stage Voltage → 2nd Stage Attenuation →
 *   Final dBµV → Margin vs EN 55015
 *
 * All internal frequencies are in kHz to match Excel.
 * Excel parameter mapping:
 *   B1=pfcInductorMH, B2=htRailVoltage, B3=inputPower, B4=inputRMSVoltage,
 *   B5=firstInputCapNF, B6=secondInputCapNF, B7=inputFilterInductorMH,
 *   B8=passMarginDB, B9=lisnResistanceOhm
 */

import type {
  EMCInputParameters,
  EMCScanResult,
  EMCOverallResult,
  EMCSpectrumPoint,
  EMCSpectrumData,
  EN55015LimitPoint,
} from './emc.types';

const NUM_PHASE_ANGLES = 90;
const NUM_HARMONICS = 20;

/**
 * Switching frequency in kHz for a given phase angle.
 *
 * Excel ('Frequency& BS EN 55015 limits'!B3, also repeated on every sheet col B):
 * =2*Setup!B$4^2*(Setup!B$2-SQRT(2)*Setup!B$4*SIN(PI()*A3/180))/(2*Setup!B$3*Setup!B$1*Setup!B$2)
 *
 * The 2s cancel: f_kHz = Vin² * (Vht - √2·Vin·sin(θ)) / (Pin · L_mH · Vht)
 * Returns kHz directly — no conversion needed.
 */
export function calcSwitchingFrequency(
  phaseAngleDeg: number,
  vinRMS: number,
  vht: number,
  inputPowerW: number,
  inductorMH: number,
): number {
  const thetaRad = (phaseAngleDeg * Math.PI) / 180;
  const num =
    vinRMS * vinRMS * (vht - Math.SQRT2 * vinRMS * Math.sin(thetaRad));
  const den = inputPowerW * inductorMH * vht;
  if (den === 0) return 0;
  return Math.max(0, num / den);
}

/**
 * Duty cycle for a given phase angle.
 *
 * Excel ('Harmonic Component'!C3 / 'Frequency& BS EN 55015 limits'!C3):
 * C3 = B3 * 'Duty Cycle calculator'!$B$6 / 2000
 *
 * Where 'Duty Cycle calculator'!B6 ("On time" µS):
 * = 1e6 * B1(mH) * 0.001 * I_peak / (B4(Vht) * √2)
 * I_peak = √2 * Pin / Vin
 * So B6 = 1e6 * L_mH * 0.001 * (√2 * Pin / Vin) / (Vin * √2)
 *        = 1000 * L_mH * Pin / Vin²
 *
 * Therefore: D = f_kHz * (1000 * L_mH * Pin / Vin²) / 2000
 *             = f_kHz * L_mH * Pin / (2 * Vin²)
 */
export function calcDutyCycle(
  fSwitchKHz: number,
  vinRMS: number,
  inputPowerW: number,
  inductorMH: number,
): number {
  if (fSwitchKHz <= 0) return 0;
  // K = 'Duty Cycle calculator'!B6 = 1000 * L_mH * Pin / Vin²
  const K = (1000 * inductorMH * inputPowerW) / (vinRMS * vinRMS);
  const d = (fSwitchKHz * K) / 2000;
  return Math.max(0, Math.min(1, d));
}

/**
 * Fourier amplitude Bn for harmonic n.
 *
 * Excel ('Harmonic Component'!F3):
 * E3 = 1/C3  (M = 1/dutyCycle)
 * Bn = ABS(IF(ISEVEN(n), 0, 2*M²*SIN(n*(M-1)*PI()/M) / (n²*(M-1)*PI()²)))
 *
 * Using M = 1/D directly to match Excel exactly.
 */
export function calcFourierAmplitude(n: number, dutyCycle: number): number {
  if (n % 2 === 0) return 0;
  if (dutyCycle <= 0 || dutyCycle >= 1) return 0;

  const M = 1 / dutyCycle; // E3 = 1/C3
  const Mm1 = M - 1; // (M-1)
  if (Mm1 === 0) return 0;

  const num = 2 * M * M * Math.sin((n * Mm1 * Math.PI) / M);
  const den = n * n * Mm1 * Math.PI * Math.PI;
  return Math.abs(num / den);
}

/**
 * Radial frequency w.
 *
 * Excel ('Radial frequency'!C3):
 * w = 2 * PI() * $B3 * C$1 * 1000
 * where $B3 = f_kHz, C$1 = harmonic number n
 *
 * The *1000 converts kHz to Hz inside the angular frequency.
 */
export function calcRadialFrequency(fSwitchKHz: number, n: number): number {
  return 2 * Math.PI * fSwitchKHz * n * 1000;
}

/**
 * Harmonic current amplitude.
 *
 * Excel ('Harmonic Current Amplitudes'!C3):
 * = 'Frequency& BS EN 55015 limits'!$E3 * 'Harmonic Component'!F3
 *
 * Where E3 ('Frequency& BS EN 55015 limits'!E3, "Input ripple rms equivalent"):
 * = (Setup!$B$3 * SIN(PI()*A3/180) / Setup!$B$4) * (1 - 2*$D3) / (2*(1-$D3))
 *
 * D3 = IF(C3<=0.5, C3, 1-C3)  ("Manipulated figure")
 * So: Current = E3_factor * Bn
 */
export function calcHarmonicCurrent(
  vinRMS: number,
  phaseAngleDeg: number,
  bn: number,
  inputPowerW: number,
  rawDutyCycle: number,
): number {
  const thetaRad = (phaseAngleDeg * Math.PI) / 180;
  const dManip = rawDutyCycle <= 0.5 ? rawDutyCycle : 1 - rawDutyCycle;
  if (dManip >= 1) return 0;

  const factor =
    (((inputPowerW * Math.sin(thetaRad)) / vinRMS) * (1 - 2 * dManip)) /
    (2 * (1 - dManip));
  return factor * bn;
}

/**
 * 1st stage voltage.
 *
 * Excel ('1st Stage Voltages'!C3):
 * = 'Harmonic Current Amplitudes'!C3 * 1000000 / (2*PI() * C$1 * $B3 * Setup!$B$6)
 *
 * C$1 = harmonic number n
 * $B3 = precon frequency in kHz
 * Setup!$B$6 = 2nd Input Capacitor (nF)
 *
 * Note: denominator uses n * f_kHz * capNF directly (not converted to Hz/Farads).
 * The 1e6 in numerator handles the unit conversion.
 */
export function calcFirstStageVoltage(
  current: number,
  n: number,
  fSwitchKHz: number,
  secondCapNF: number,
): number {
  const den = 2 * Math.PI * n * fSwitchKHz * secondCapNF;
  if (den === 0) return 0;
  return (current * 1e6) / den;
}

/**
 * 2nd stage attenuation.
 *
 * Excel ('2nd Stage Attenuation'!C3):
 * = SQRT(ABS(
 *     (1 - w² * Setup!$B$7 * Setup!$B$5 * 1e-12)²
 *   - (Setup!$B$7 * w * 0.001 / Setup!$B$9)²
 * ))
 *
 * w = radial frequency from 'Radial frequency' sheet
 * B7 = input filter inductor (mH), B5 = 1st input cap (nF), B9 = LISN (Ω)
 *
 * Term1: (1 - w²·L_mH·C_nF·1e-12)²  — L_mH*1e-3=L_H, C_nF*1e-9=C_F → L*C = L_mH*C_nF*1e-12
 * Term2: (L_mH·w·0.001/R)²           — L_mH*0.001=L_H → (w·L_H/R)²
 */
export function calcSecondStageAttenuation(
  w: number,
  firstCapNF: number,
  filterInductorMH: number,
  lisnOhm: number,
): number {
  const LC = filterInductorMH * firstCapNF * 1e-12;
  const term1 = Math.pow(1 - w * w * LC, 2);
  const term2 = Math.pow((filterInductorMH * w * 0.001) / lisnOhm, 2);
  return Math.sqrt(Math.abs(term1 - term2));
}

/**
 * Final voltage in dBµV.
 *
 * Excel ('Final Stage Voltages (dBuV)'!C3 for harmonic 1):
 * = 20*LOG(1000000 * V1st / Attenuation)
 *
 * For harmonics 2+ (D3 onwards):
 * = 20*LOG(MAX(0.00000011, 1000000 * V1st / Attenuation))
 *
 * The MAX floor prevents log(0) for even harmonics that produce zero.
 */
export function calcFinalVoltageDBuV(
  v1st: number,
  attenuation: number,
  harmonicN: number,
): number {
  if (attenuation === 0) return 0;
  let vMicro = (v1st / attenuation) * 1e6;

  // Harmonics 2+ get the MAX floor (Excel column D onwards)
  if (harmonicN > 1) {
    vMicro = Math.max(0.00000011, vMicro);
  }

  if (vMicro <= 0) return 0;
  return 20 * Math.log10(vMicro);
}

/**
 * EN 55015 target emission level (with pass margin baked in).
 *
 * Excel ('Frequency& BS EN 55015 limits'!F3):
 * =IF(n*f<9, "NONE",
 *   IF(n*f<50, 110-margin,
 *     IF(n*f<150, (80+10*(LOG(n*f)-LOG(150))/(LOG(50)-LOG(150)))-margin,
 *       IF(n*f>500, 56-margin,
 *         66-margin-19.125*LOG(n*f/150)
 *       )
 *     )
 *   )
 * )
 *
 * where n*f is harmonic_number * precon_freq_kHz (product in kHz).
 * Returns NaN for "NONE" (below 9 kHz — not testable).
 */
export function getTargetEmissionLevel(
  harmonicFreqKHz: number,
  passMarginDB: number,
): number {
  if (harmonicFreqKHz < 9) return NaN; // "NONE"
  if (harmonicFreqKHz < 50) return 110 - passMarginDB;
  if (harmonicFreqKHz < 150) {
    // Log interpolation between 50 kHz (110 dB) and 150 kHz (80 dB)
    return (
      80 +
      (10 * (Math.log10(harmonicFreqKHz) - Math.log10(150))) /
        (Math.log10(50) - Math.log10(150)) -
      passMarginDB
    );
  }
  if (harmonicFreqKHz > 500) return 56 - passMarginDB;
  // 150–500 kHz range
  return 66 - passMarginDB - 19.125 * Math.log10(harmonicFreqKHz / 150);
}

/**
 * Full calculation pipeline for a single phase-angle + harmonic point.
 * Mirrors the Excel column-by-column flow across all sheets.
 */
function calcSinglePoint(
  phaseAngleDeg: number,
  harmonicN: number,
  vinRMS: number,
  params: EMCInputParameters,
): {
  finalDBuV: number;
  targetDBuV: number;
  margin: number;
  freqKHz: number;
} | null {
  // 1. Switching frequency (kHz)
  const fKHz = calcSwitchingFrequency(
    phaseAngleDeg,
    vinRMS,
    params.htRailVoltage,
    params.inputPower,
    params.pfcInductorMH,
  );
  if (fKHz <= 0) return null;

  // 2. Duty cycle
  const dutyCycle = calcDutyCycle(
    fKHz,
    vinRMS,
    params.inputPower,
    params.pfcInductorMH,
  );

  // 3. Harmonic frequency in kHz
  const harmonicFreqKHz = fKHz * harmonicN;

  // 4. Target emission level (returns NaN for "NONE")
  const targetDBuV = getTargetEmissionLevel(
    harmonicFreqKHz,
    params.passMarginDB,
  );
  if (isNaN(targetDBuV)) return null;

  // 5. Fourier amplitude
  const bn = calcFourierAmplitude(harmonicN, dutyCycle);

  // 6. Harmonic current
  const current = calcHarmonicCurrent(
    vinRMS,
    phaseAngleDeg,
    bn,
    params.inputPower,
    dutyCycle,
  );

  // 7. 1st stage voltage
  const v1st = calcFirstStageVoltage(
    current,
    harmonicN,
    fKHz,
    params.secondInputCapNF,
  );

  // 8. Radial frequency for attenuation calc
  const w = calcRadialFrequency(fKHz, harmonicN);

  // 9. 2nd stage attenuation
  const attenuation = calcSecondStageAttenuation(
    w,
    params.firstInputCapNF,
    params.inputFilterInductorMH,
    params.lisnResistanceOhm,
  );

  // 10. Final voltage dBµV
  const finalDBuV = calcFinalVoltageDBuV(v1st, attenuation, harmonicN);

  // 11. Margin = target - actual
  const margin = targetDBuV - finalDBuV;

  return { finalDBuV, targetDBuV, margin, freqKHz: harmonicFreqKHz };
}

/**
 * Voltage scan 108–264V matching the Excel VBA "Margin" macro.
 *
 * Key differences from old code:
 * - Only checks odd harmonics (VBA: `If Cells(1,k) Mod 2 = 0 Then GoTo Skip`)
 * - Pass/fail threshold: margin >= 0 means pass (margin already includes passMarginDB)
 * - Fail coloring in Excel: margin < passMarginDB (6 dB default)
 *   We use margin >= 0 for pass since margin is already reduced by passMarginDB.
 */
export function runVoltageScan(params: EMCInputParameters): EMCOverallResult {
  const scanResults: EMCScanResult[] = [];
  let worstOverallMargin = Infinity;
  let passCount = 0;
  let failCount = 0;

  const scanStart = 108;
  const scanEnd = Math.max(264, Math.ceil(params.inputRMSVoltage));

  for (let v = scanStart; v <= scanEnd; v++) {
    let worstMargin = 1000000; // Excel initializes l = 1000000
    let worstFreqKHz = 0;
    let worstPhaseAngle = 0;
    let worstDetector = 'Avg';

    for (let angle = 1; angle <= NUM_PHASE_ANGLES; angle++) {
      for (let n = 1; n <= NUM_HARMONICS; n++) {
        // VBA macro skips even harmonics: If Cells(1,k) Mod 2 = 0 Then GoTo Skip
        if (n % 2 === 0) continue;

        const result = calcSinglePoint(angle, n, v, params);
        if (result === null) continue;

        if (result.margin < worstMargin) {
          worstMargin = result.margin;
          worstFreqKHz = result.freqKHz;
          worstPhaseAngle = angle;
          // VBA: Detector = IIf(harmonic Mod 2 = 1, "Avg", "QP")
          // Since we only process odd harmonics, detector is always "Avg"
          worstDetector = n % 2 === 1 ? 'Avg' : 'QP';
        }
      }
    }

    // VBA pass logic: If l < 6 Then FailCount (where 6 = passMarginDB)
    // The margin already has passMarginDB subtracted in the limit formula,
    // but the VBA macro compares the margin against passMarginDB again for pass/fail.
    const pass = worstMargin >= params.passMarginDB;
    if (pass) passCount++;
    else failCount++;

    if (worstMargin < worstOverallMargin) {
      worstOverallMargin = worstMargin;
    }

    scanResults.push({
      inputVoltage: v,
      minMarginDB: Math.round(worstMargin * 1000) / 1000,
      frequencyOfMinMarginKHz: Math.round(worstFreqKHz * 1000) / 1000,
      inputPhaseAngle: worstPhaseAngle,
      detectorType: worstDetector,
      pass,
    });
  }

  return {
    passCount,
    failCount,
    worstMarginDB: Math.round(worstOverallMargin * 1000) / 1000,
    scanResults,
    overallPass: failCount === 0,
  };
}

/**
 * Spectrum data for chart rendering at a specific voltage.
 * Matches the VBA "Create_Perfect_Spectrum_Chart" macro:
 * - Plots all phase angles (1–90°)
 * - Only odd harmonics (VBA: If Cells(1,k) Mod 2 = 0 Then GoTo NextJ)
 * - X axis = frequency in MHz, Y axis = dBµV
 */
export function getSpectrumData(
  params: EMCInputParameters,
  voltage: number,
): EMCSpectrumData {
  const emissions: EMCSpectrumPoint[] = [];

  for (let angle = 1; angle <= NUM_PHASE_ANGLES; angle++) {
    const fKHz = calcSwitchingFrequency(
      angle,
      voltage,
      params.htRailVoltage,
      params.inputPower,
      params.pfcInductorMH,
    );
    if (fKHz <= 0) continue;

    const dutyCycle = calcDutyCycle(
      fKHz,
      voltage,
      params.inputPower,
      params.pfcInductorMH,
    );

    for (let n = 1; n <= NUM_HARMONICS; n++) {
      if (n % 2 === 0) continue;

      const harmonicFreqKHz = fKHz * n;

      // Skip if below 9 kHz (NONE in Excel)
      if (harmonicFreqKHz < 9) continue;

      const bn = calcFourierAmplitude(n, dutyCycle);
      const current = calcHarmonicCurrent(
        voltage,
        angle,
        bn,
        params.inputPower,
        dutyCycle,
      );
      const v1st = calcFirstStageVoltage(
        current,
        n,
        fKHz,
        params.secondInputCapNF,
      );
      const w = calcRadialFrequency(fKHz, n);
      const attenuation = calcSecondStageAttenuation(
        w,
        params.firstInputCapNF,
        params.inputFilterInductorMH,
        params.lisnResistanceOhm,
      );
      const finalDBuV = calcFinalVoltageDBuV(v1st, attenuation, n);

      emissions.push({
        frequencyMHz: harmonicFreqKHz / 1000, // kHz to MHz
        levelDBuV: finalDBuV,
        phaseAngle: angle,
        harmonicNumber: n,
      });
    }
  }

  // EN 55015 limit lines matching VBA chart macro
  const qpLimit: EN55015LimitPoint[] = [
    { frequencyMHz: 0.009, limitDBuV: 110 },
    { frequencyMHz: 0.05, limitDBuV: 90 },
    { frequencyMHz: 0.15, limitDBuV: 80 },
    { frequencyMHz: 0.5, limitDBuV: 56 },
    { frequencyMHz: 5, limitDBuV: 56 },
    { frequencyMHz: 30, limitDBuV: 60 },
  ];

  const avgLimit: EN55015LimitPoint[] = [
    { frequencyMHz: 0.009, limitDBuV: 100 },
    { frequencyMHz: 0.05, limitDBuV: 80 },
    { frequencyMHz: 0.15, limitDBuV: 70 },
    { frequencyMHz: 0.5, limitDBuV: 46 },
    { frequencyMHz: 5, limitDBuV: 46 },
    { frequencyMHz: 30, limitDBuV: 50 },
  ];

  return { emissions, qpLimit, avgLimit, voltage };
}
