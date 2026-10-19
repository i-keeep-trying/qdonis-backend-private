// Ported verbatim from the old frontend; keep numerically identical (see specs).
/**
 * MTBF Calculation Service
 *
 * Implements multiple reliability prediction standards:
 * - MIL-HDBK-217F (US Military Standard)
 * - Telcordia SR-332 (formerly Bellcore TR-332)
 * - IEC TR 62380 (International standard)
 * - FIDES 2022 (French/European method)
 *
 * References:
 * - MIL-HDBK-217F Notice 2: Reliability Prediction of Electronic Equipment
 * - Telcordia SR-332 Issue 4: Reliability Prediction Procedure for Electronic Equipment
 * - IEC TR 62380:2004: Reliability data handbook
 * - FIDES Guide 2022 Edition A: Reliability Methodology for Electronic Systems
 */

import {
  type ThermalComponent,
  type SelectedPart,
  type MTBFComponent,
  type MTBFCalculationDetails,
} from './reliability.types';

// ============================================================================
// COMPONENT CATEGORIES AND BASE FAILURE RATES
// ============================================================================

interface ComponentCategory {
  type: string;
  milHdbk217: {
    baseLambda: number; // FIT (Failures in 10^9 hours)
    qualityFactor: number;
  };
  telcordiaSR332: {
    intrinsicLambda: number;
    qualityFactor: number;
  };
  iecTR62380: {
    referenceLambda: number;
    processFactor: number;
  };
  fides2022: {
    referenceLambda: number;
    processFactor: number;
    applicationBaseline: number;
    qualityFactor: number;
    maturityFactor: number;
  };
}

const COMPONENT_CATEGORIES: Record<string, ComponentCategory> = {
  mosfet: {
    type: 'MOSFET - Power',
    milHdbk217: { baseLambda: 4.5, qualityFactor: 1.0 },
    telcordiaSR332: { intrinsicLambda: 8.0, qualityFactor: 1.4 },
    iecTR62380: { referenceLambda: 6.5, processFactor: 1.0 },
    fides2022: {
      referenceLambda: 5.2,
      processFactor: 1.1,
      applicationBaseline: 1.3,
      qualityFactor: 1.1,
      maturityFactor: 1.0,
    },
  },
  diode: {
    type: 'Diode - Schottky',
    milHdbk217: { baseLambda: 2.5, qualityFactor: 1.0 },
    telcordiaSR332: { intrinsicLambda: 4.5, qualityFactor: 1.5 },
    iecTR62380: { referenceLambda: 3.8, processFactor: 1.0 },
    fides2022: {
      referenceLambda: 3.1,
      processFactor: 1.05,
      applicationBaseline: 1.2,
      qualityFactor: 1.1,
      maturityFactor: 1.0,
    },
  },
  inductor: {
    type: 'Inductor - Power',
    milHdbk217: { baseLambda: 3.5, qualityFactor: 1.0 },
    telcordiaSR332: { intrinsicLambda: 2.0, qualityFactor: 1.4 },
    iecTR62380: { referenceLambda: 2.8, processFactor: 1.0 },
    fides2022: {
      referenceLambda: 2.5,
      processFactor: 1.0,
      applicationBaseline: 1.1,
      qualityFactor: 1.05,
      maturityFactor: 1.0,
    },
  },
  transformer: {
    type: 'Transformer - Power',
    milHdbk217: { baseLambda: 4.2, qualityFactor: 1.0 },
    telcordiaSR332: { intrinsicLambda: 2.8, qualityFactor: 1.4 },
    iecTR62380: { referenceLambda: 3.5, processFactor: 1.0 },
    fides2022: {
      referenceLambda: 3.2,
      processFactor: 1.05,
      applicationBaseline: 1.2,
      qualityFactor: 1.1,
      maturityFactor: 1.0,
    },
  },
  capacitor: {
    type: 'Capacitor - Electrolytic',
    milHdbk217: { baseLambda: 5.5, qualityFactor: 1.0 },
    telcordiaSR332: { intrinsicLambda: 12.0, qualityFactor: 1.4 },
    iecTR62380: { referenceLambda: 8.5, processFactor: 1.0 },
    fides2022: {
      referenceLambda: 7.8,
      processFactor: 1.15,
      applicationBaseline: 1.4,
      qualityFactor: 1.2,
      maturityFactor: 1.0,
    },
  },
  resistor: {
    type: 'Resistor - Power',
    milHdbk217: { baseLambda: 1.8, qualityFactor: 1.0 },
    telcordiaSR332: { intrinsicLambda: 3.2, qualityFactor: 1.3 },
    iecTR62380: { referenceLambda: 2.5, processFactor: 1.0 },
    fides2022: {
      referenceLambda: 2.1,
      processFactor: 1.02,
      applicationBaseline: 1.1,
      qualityFactor: 1.05,
      maturityFactor: 1.0,
    },
  },
  ic: {
    type: 'IC - Switching Regulator',
    milHdbk217: { baseLambda: 12.0, qualityFactor: 1.0 },
    telcordiaSR332: { intrinsicLambda: 15.0, qualityFactor: 1.4 },
    iecTR62380: { referenceLambda: 18.0, processFactor: 1.0 },
    fides2022: {
      referenceLambda: 14.5,
      processFactor: 1.2,
      applicationBaseline: 1.5,
      qualityFactor: 1.2,
      maturityFactor: 1.0,
    },
  },
};

// ============================================================================
// ENVIRONMENTAL FACTORS
// ============================================================================
// Updated from "updated Environment list MTBF.docx" with official πE multipliers

export const ENVIRONMENT_FACTORS = {
  'MIL-HDBK-217F': {
    // MIL-HDBK-217F Notice 2 - 14 environments
    'GB - Ground, Benign (πE=1.0)': 1.0,
    'GF - Ground, Fixed (πE=2.0)': 2.0,
    'GM - Ground, Mobile (πE=4.0)': 4.0,
    'NS - Naval, Sheltered (πE=5.0)': 5.0,
    'NU - Naval, Unsheltered (πE=7.0)': 7.0,
    'AIC - Airborne, Inhabited, Cargo (πE=8.0)': 8.0,
    'AIF - Airborne, Inhabited, Fighter (πE=10.0)': 10.0,
    'AUC - Airborne, Uninhabited, Cargo (πE=15.0)': 15.0,
    'AUF - Airborne, Uninhabited, Fighter (πE=20.0)': 20.0,
    'RW - Rotary Wing Aircraft (πE=25.0)': 25.0,
    'SF - Space, Flight (πE=30.0)': 30.0,
    'MF - Missile, Flight (πE=35.0)': 35.0,
    'ML - Missile, Launch (πE=40.0)': 40.0,
    'CL - Cannon Launch (πE=50.0)': 50.0,
  },
  'Telcordia SR-332': {
    // Telcordia SR-332 Issue 4 - 3 environments
    'Controlled (πE=1.0)': 1.0,
    'Partially Controlled (πE=2.0)': 2.0,
    'Uncontrolled (πE=8.0)': 8.0,
  },
  'IEC TR 62380': {
    // IEC TR 62380 - 8 environments (mission profile based)
    'Ground, Fixed / Computer (πE=1.0)': 1.0,
    'Telecom Switching (πE=1.5)': 1.5,
    'Telecom Transmission (πE=3.0)': 3.0,
    'Telecom Subscriber (πE=5.0)': 5.0,
    'Industrial / Railway / Payphone (πE=8.0)': 8.0,
    'Avionics (Civil) (πE=10.0)': 10.0,
    'Avionics (Military) (πE=20.0)': 20.0,
    'Automotive (πE=30.0)': 30.0,
  },
  'FIDES 2022': {
    // FIDES 2022 - 9 environments with severity coefficients (γE)
    'Ground, Fixed Controlled (γE=1.0)': 1.0,
    'Ground, Fixed Harsh (γE=2.0)': 2.0,
    'Ground, Mobile (γE=3.0)': 3.0,
    'Naval, Sheltered (γE=5.0)': 5.0,
    'Naval, Unsheltered (γE=8.0)': 8.0,
    'Airborne, Inhabited (γE=10.0)': 10.0,
    'Airborne, Uninhabited (γE=15.0)': 15.0,
    'Space (γE=20.0)': 20.0,
    'Missile / Launch (γE=25.0)': 25.0,
  },
};

// ============================================================================
// TEMPERATURE ACCELERATION MODELS
// ============================================================================

/**
 * Arrhenius temperature acceleration factor
 * Based on activation energy model for semiconductor degradation
 *
 * Formula: AF = exp(Ea/k * (1/Tref - 1/Top))
 * where:
 * - Ea = Activation energy (eV)
 * - k = Boltzmann constant (8.617e-5 eV/K)
 * - Tref = Reference temperature (298K = 25°C)
 * - Top = Operating temperature (K)
 */
function calculateTemperatureFactor(
  tempCelsius: number,
  activationEnergy: number = 0.7, // eV, typical for semiconductors
  referenceTempCelsius: number = 25,
): number {
  const k = 8.617e-5; // Boltzmann constant in eV/K
  const Tref = referenceTempCelsius + 273.15; // K
  const Top = tempCelsius + 273.15; // K

  const factor = Math.exp((activationEnergy / k) * (1 / Tref - 1 / Top));
  return factor;
}

/**
 * MIL-HDBK-217F temperature factor (πT)
 * Uses exponential model with component-specific parameters
 */
function milHdbkTemperatureFactor(
  tempCelsius: number,
  componentType: string,
): number {
  // Simplified exponential model
  // πT = exp(A * (Top - Tref) / B)
  const Tref = 25;
  const A = componentType.includes('capacitor') ? 0.15 : 0.1;
  const B = componentType.includes('IC') ? 20 : 30;

  return Math.exp((A * (tempCelsius - Tref)) / B);
}

/**
 * Telcordia SR-332 temperature factor
 * Based on Arrhenius model with Ea = 0.7 eV
 */
function telcordiaTemperatureFactor(tempCelsius: number): number {
  return calculateTemperatureFactor(tempCelsius, 0.7, 25);
}

/**
 * IEC TR 62380 temperature factor
 * More conservative than Telcordia, uses higher activation energy
 */
function iecTemperatureFactor(
  tempCelsius: number,
  componentType: string,
): number {
  const Ea = componentType.includes('semiconductor') ? 0.8 : 0.6;
  return calculateTemperatureFactor(tempCelsius, Ea, 25);
}

/**
 * FIDES 2022 temperature acceleration
 * Uses component-specific physical models
 */
function fidesTemperatureFactor(
  tempCelsius: number,
  componentType: string,
): number {
  const Ea =
    componentType.includes('mosfet') || componentType.includes('ic')
      ? 0.9
      : 0.65;
  return calculateTemperatureFactor(tempCelsius, Ea, 40); // FIDES uses 40°C reference
}

// ============================================================================
// ELECTRICAL STRESS FACTORS
// ============================================================================

/**
 * Voltage stress factor (πV)
 * Based on ratio of applied voltage to rated voltage
 */
function calculateVoltageStressFactor(
  appliedVoltage: number,
  ratedVoltage: number,
  componentType: string,
): number {
  const ratio = appliedVoltage / ratedVoltage;

  if (componentType.includes('mosfet') || componentType.includes('diode')) {
    // Power law model for semiconductors
    return Math.pow(ratio, 2.5);
  } else if (componentType.includes('capacitor')) {
    // Exponential model for capacitors
    return Math.exp(3.0 * (ratio - 0.5));
  } else {
    // Linear model for others
    return 1.0 + 0.8 * ratio;
  }
}

/**
 * Current stress factor (πI)
 * For power components
 */
function calculateCurrentStressFactor(
  appliedCurrent: number,
  ratedCurrent: number,
): number {
  const ratio = appliedCurrent / ratedCurrent;
  return Math.pow(ratio, 1.5);
}

/**
 * Generic electrical stress factor (πS)
 *
 * The standards we support (MIL-HDBK-217F, Telcordia SR-332, IEC TR 62380 and
 * FIDES 2022) all reference an electrical stress multiplier. In practice the
 * dominant mechanism (voltage or current) dictates the factor, so we take the
 * maximum of the two instead of multiplying them, avoiding unrealistic growth
 * while still penalising heavy stress as recommended in the MTBF Calculation
 * Technical Breakdown document.
 */
function calculateGenericStressFactor(
  componentType: string,
  appliedVoltage?: number,
  ratedVoltage?: number,
  appliedCurrent?: number,
  ratedCurrent?: number,
): number {
  let stress = 1.0;

  if (
    appliedVoltage !== undefined &&
    ratedVoltage !== undefined &&
    ratedVoltage > 0
  ) {
    const voltageStress = calculateVoltageStressFactor(
      appliedVoltage,
      ratedVoltage,
      componentType,
    );
    stress = Math.max(stress, voltageStress);
  }

  if (
    appliedCurrent !== undefined &&
    ratedCurrent !== undefined &&
    ratedCurrent > 0
  ) {
    const currentStress = calculateCurrentStressFactor(
      appliedCurrent,
      ratedCurrent,
    );
    stress = Math.max(stress, currentStress);
  }

  return parseFloat(Math.max(1.0, stress).toFixed(2));
}

/**
 * Application factor (πA)
 * For switching vs linear operation
 */
function calculateApplicationFactor(
  isSwitching: boolean,
  switchingFrequency?: number,
): number {
  if (!isSwitching) return 1.0;

  // Higher stress for switching operation
  const baseSwitch = 2.0;
  const freqFactor = switchingFrequency
    ? Math.log10(switchingFrequency / 100000) * 0.3
    : 0;
  return baseSwitch + Math.max(0, freqFactor);
}

// ============================================================================
// MTBF CALCULATION BY METHOD
// ============================================================================

interface MTBFInputs {
  componentType: string;
  temperature: number;
  appliedVoltage?: number;
  ratedVoltage?: number;
  appliedCurrent?: number;
  ratedCurrent?: number;
  isSwitching?: boolean;
  switchingFrequency?: number;
  environment: string;
  powerLoss?: number;
}

/**
 * MIL-HDBK-217F Parts Count & Parts Stress Prediction
 *
 * Formula: λp = λb × πT × πE × πQ × πS × πA × πL × πC
 * where:
 * - λb = base failure rate (component category lookup)
 * - πT = temperature multiplier (Arrhenius-style)
 * - πE = environment factor (Ground, Naval, Airborne, etc.)
 * - πQ = quality factor (screening level)
 * - πS = electrical stress factor (dominant voltage/current stress)
 * - πA = application factor (switching vs. linear service)
 * - πL = learning/production maturity factor
 * - πC = construction factor (package/case influence)
 */
function calculateMILHDBK217F(inputs: MTBFInputs): {
  lambda: number;
  details: MTBFCalculationDetails;
} {
  const category =
    COMPONENT_CATEGORIES[inputs.componentType] ||
    COMPONENT_CATEGORIES['resistor'];
  const { baseLambda, qualityFactor } = category.milHdbk217;

  const piT = milHdbkTemperatureFactor(inputs.temperature, category.type);
  const piS = calculateGenericStressFactor(
    category.type,
    inputs.appliedVoltage,
    inputs.ratedVoltage,
    inputs.appliedCurrent,
    inputs.ratedCurrent,
  );
  const piA = calculateApplicationFactor(
    inputs.isSwitching || false,
    inputs.switchingFrequency,
  );
  const piQ = qualityFactor;
  const piE =
    (ENVIRONMENT_FACTORS['MIL-HDBK-217F'] as Record<string, number>)[
      inputs.environment
    ] || 1.0;
  const piL = 1.0; // Production maturity assumed established
  const piC = 1.0; // Default construction factor

  const lambda = baseLambda * piT * piE * piQ * piS * piA * piL * piC;

  // Generate temperature curve data
  const failureRateVsTemp = [25, 40, 55, 70, 85, 100].map((temp) => ({
    temperature: temp,
    failureRate:
      baseLambda *
      milHdbkTemperatureFactor(temp, category.type) *
      piE *
      piQ *
      piS *
      piA *
      piL *
      piC,
  }));

  // Generate reliability curve (R(t) = e^(-λt))
  const reliabilityVsTime = [0, 8760, 17520, 26280, 35040, 43800].map(
    (time) => ({
      time: time,
      reliability: Math.exp(-(lambda / 1e9) * time),
    }),
  );

  return {
    lambda: parseFloat(lambda.toFixed(1)),
    details: {
      formula: 'λp = λb × πT × πE × πQ × πS × πA × πL × πC',
      factors: [
        {
          name: 'Base failure rate (λb)',
          value: baseLambda.toFixed(3),
          unit: 'FIT/device',
        },
        { name: 'Temperature factor (πT)', value: piT.toFixed(2) },
        { name: 'Environment factor (πE)', value: piE.toFixed(1) },
        { name: 'Quality factor (πQ)', value: piQ.toFixed(1) },
        { name: 'Stress factor (πS)', value: piS.toFixed(2) },
        { name: 'Application factor (πA)', value: piA.toFixed(2) },
        { name: 'Learning factor (πL)', value: piL.toFixed(1) },
        { name: 'Construction factor (πC)', value: piC.toFixed(1) },
      ],
      notes: `MIL-HDBK-217F Notice 2 prediction. Operating at ${inputs.temperature}°C junction temperature. ${
        inputs.appliedVoltage && inputs.ratedVoltage
          ? `Voltage stress: ${((inputs.appliedVoltage / inputs.ratedVoltage) * 100).toFixed(0)}% of rated. `
          : ''
      }${
        inputs.appliedCurrent && inputs.ratedCurrent
          ? `Current stress: ${((inputs.appliedCurrent / inputs.ratedCurrent) * 100).toFixed(0)}% of rated. `
          : ''
      }${
        inputs.isSwitching
          ? `Switching operation at ${inputs.switchingFrequency ? (inputs.switchingFrequency / 1000).toFixed(0) + ' kHz' : 'high frequency'} increases stress. `
          : 'Linear operation mode. '
      }Environment: ${inputs.environment}. Quality level: Commercial/Industrial grade.`,
      graphData: {
        failureRateVsTemp,
        reliabilityVsTime,
      },
    },
  };
}

/**
 * Telcordia SR-332 (Bellcore TR-332) Method
 *
 * Generic prediction formula: λp = λG × πE × πQ × πS
 * where:
 * - λG = intrinsic/generic failure rate derived from field databases
 * - πE = environment multiplier (Controlled, Sheltered, Ground, Mobile)
 * - πQ = quality factor (process/supplier grading)
 * - πS = combined stress factor (temperature acceleration × electrical stress)
 *
 * When field return data exists, Telcordia blends predictions via a Bayesian correction.
 */
function calculateTelcordiaSR332(inputs: MTBFInputs): {
  lambda: number;
  details: MTBFCalculationDetails;
} {
  const category =
    COMPONENT_CATEGORIES[inputs.componentType] ||
    COMPONENT_CATEGORIES['resistor'];
  const { intrinsicLambda, qualityFactor } = category.telcordiaSR332;

  const piQ = qualityFactor;
  const piE =
    (ENVIRONMENT_FACTORS['Telcordia SR-332'] as Record<string, number>)[
      inputs.environment
    ] || 1.0;
  const electricalStress = calculateGenericStressFactor(
    category.type,
    inputs.appliedVoltage,
    inputs.ratedVoltage,
    inputs.appliedCurrent,
    inputs.ratedCurrent,
  );
  const piS = telcordiaTemperatureFactor(inputs.temperature) * electricalStress;

  const lambda = intrinsicLambda * piE * piQ * piS;

  const failureRateVsTemp = [25, 40, 55, 70, 85, 100].map((temp) => ({
    temperature: temp,
    failureRate:
      intrinsicLambda *
      ((ENVIRONMENT_FACTORS['Telcordia SR-332'] as Record<string, number>)[
        inputs.environment
      ] || 1.0) *
      piQ *
      (telcordiaTemperatureFactor(temp) * electricalStress),
  }));

  const reliabilityVsTime = [0, 8760, 17520, 26280, 35040, 43800].map(
    (time) => ({
      time: time,
      reliability: Math.exp(-(lambda / 1e9) * time),
    }),
  );

  return {
    lambda: parseFloat(lambda.toFixed(1)),
    details: {
      formula: 'λp = λG × πE × πQ × πS',
      factors: [
        {
          name: 'Intrinsic failure rate (λ0)',
          value: intrinsicLambda.toFixed(3),
          unit: 'FIT/device',
        },
        { name: 'Environment factor (πE)', value: piE.toFixed(2) },
        { name: 'Quality factor (πQ)', value: piQ.toFixed(1) },
        { name: 'Stress factor (πS)', value: piS.toFixed(2) },
      ],
      notes: `Telcordia SR-332 Issue 4 prediction based on field return data. Uses Arrhenius temperature model with Ea = 0.7 eV. Operating temperature: ${inputs.temperature}°C. ${
        category.type.includes('MOSFET') || category.type.includes('IC')
          ? 'Field data shows lower failure rates for modern semiconductors compared to MIL-HDBK-217F predictions. '
          : ''
      }${
        category.type.includes('Capacitor')
          ? 'Electrolytic capacitors show higher field failure rates due to electrolyte degradation. '
          : ''
      }Environment: ${inputs.environment}. Quality: Commercial grade components. Composite stress factor accounts for temperature acceleration and electrical loading per Telcordia guidelines.`,
      graphData: {
        failureRateVsTemp,
        reliabilityVsTime,
      },
    },
  };
}

/**
 * IEC TR 62380 (formerly IEC 61709) Method
 *
 * Mission profile-driven formula:
 * λsteady = λref × Σ(πT,i × Di) × πStress × πM × πP × πE
 * λtransient = Ncycles × λcycle
 * λtotal = λsteady + λtransient
 * where:
 * - λref = reference failure rate at standard conditions
 * - πT,i = temperature factor in mission segment i
 * - Di = duty cycle of segment i
 * - πStress = dominant electrical stress multiplier
 * - πM = maturity factor (new vs mature technology)
 * - πP = process factor (manufacturing quality)
 * - πE = environment factor (Ground Fixed, Ground Mobile, Naval, Airborne)
 * - λcycle = fatigue contribution per on/off transition
 */
function calculateIECTR62380(inputs: MTBFInputs): {
  lambda: number;
  details: MTBFCalculationDetails;
} {
  const category =
    COMPONENT_CATEGORIES[inputs.componentType] ||
    COMPONENT_CATEGORIES['resistor'];
  const { referenceLambda, processFactor } = category.iecTR62380;

  const piP = processFactor;
  const piM = 1.0; // Assume mature technology per documentation
  const piE =
    (ENVIRONMENT_FACTORS['IEC TR 62380'] as Record<string, number>)[
      inputs.environment
    ] || 1.0;
  const piStress = calculateGenericStressFactor(
    category.type,
    inputs.appliedVoltage,
    inputs.ratedVoltage,
    inputs.appliedCurrent,
    inputs.ratedCurrent,
  );

  // Mission profile approximation based on IEC TR 62380 guidance:
  // - Active mode (ON): dominant thermal stress
  // - Standby mode: reduced temperature
  // - Off mode: ambient temperature, minimal contribution
  const activeDuty = inputs.isSwitching ? 0.65 : 0.5;
  const standbyDuty = inputs.isSwitching ? 0.25 : 0.35;
  const offDuty = Math.max(0, 1 - activeDuty - standbyDuty);

  const dutySegments = [
    { duty: activeDuty, temperature: inputs.temperature },
    { duty: standbyDuty, temperature: Math.max(0, inputs.temperature - 15) },
    { duty: offDuty, temperature: Math.max(0, inputs.temperature - 25) },
  ];

  const lambdaSteady =
    referenceLambda *
    piStress *
    piP *
    piM *
    piE *
    dutySegments.reduce((sum, segment) => {
      const segmentFactor = iecTemperatureFactor(
        segment.temperature,
        category.type,
      );
      return sum + segment.duty * segmentFactor;
    }, 0);

  // Transient term approximated from on/off cycles per hour.
  const cyclesPerHour = inputs.isSwitching ? 4 : 1;
  const lambdaCycle = referenceLambda * 0.02 * piE * piStress;
  const lambdaTransient = cyclesPerHour * lambdaCycle;

  const lambda = lambdaSteady + lambdaTransient;

  const failureRateVsTemp = [25, 40, 55, 70, 85, 100].map((temp) => ({
    temperature: temp,
    failureRate:
      referenceLambda *
      iecTemperatureFactor(temp, category.type) *
      piStress *
      piM *
      piP *
      piE,
  }));

  const reliabilityVsTime = [0, 8760, 17520, 26280, 35040, 43800].map(
    (time) => ({
      time: time,
      reliability: Math.exp(-(lambda / 1e9) * time),
    }),
  );

  return {
    lambda: parseFloat(lambda.toFixed(1)),
    details: {
      formula:
        'λtotal = λsteady + λtransient = λref × Σ(πT,i × Di) × πStress × πM × πP × πE + Ncycles × λcycle',
      factors: [
        {
          name: 'Reference failure rate (λref)',
          value: referenceLambda.toFixed(3),
          unit: 'FIT/device',
        },
        { name: 'Environment factor (πE)', value: piE.toFixed(2) },
        { name: 'Process factor (πP)', value: piP.toFixed(2) },
        { name: 'Maturity factor (πM)', value: piM.toFixed(1) },
        { name: 'Stress factor (πStress)', value: piStress.toFixed(2) },
        {
          name: 'Steady contribution (λsteady)',
          value: lambdaSteady.toFixed(1),
          unit: 'FIT',
        },
        {
          name: 'Transient contribution (λtransient)',
          value: lambdaTransient.toFixed(1),
          unit: 'FIT',
        },
      ],
      notes: `IEC TR 62380:2004 reliability prediction using physics-of-failure approach. Temperature: ${inputs.temperature}°C with ${
        category.type.includes('mosfet') || category.type.includes('diode')
          ? 'activation energy Ea = 0.8 eV for semiconductors'
          : 'activation energy Ea = 0.6 eV for passive components'
      }. ${
        inputs.appliedVoltage && inputs.ratedVoltage
          ? `Electrical stress: ${((inputs.appliedVoltage / inputs.ratedVoltage) * 100).toFixed(0)}% of rated voltage. `
          : ''
      }Maturity factor assumes proven, stable component technology. Process factor accounts for modern manufacturing quality standards. Environment: ${inputs.environment}. Duty cycle approximation follows the MTBF Prediction Standards Detailed guidance for IEC TR 62380 mission profiles.`,
      graphData: {
        failureRateVsTemp,
        reliabilityVsTime,
      },
    },
  };
}

/**
 * FIDES 2022 Guide Method
 *
 * Useful-life formula: λp = λref × ΠProcess × ΠApplication × ΠEnvironment × ΠQuality × ΠMaturity
 * where:
 * - λref = reference base rate (technology-specific catalogue data)
 * - ΠProcess = design & manufacturing process grading
 * - ΠApplication = severity due to temperature, electrical loading & duty
 * - ΠEnvironment = external stress (radiation, humidity, vibration, etc.)
 * - ΠQuality = supplier/manufacturer quality factor
 * - ΠMaturity = design maturity factor (new vs proven product)
 */
function calculateFIDES2022(inputs: MTBFInputs): {
  lambda: number;
  details: MTBFCalculationDetails;
} {
  const category =
    COMPONENT_CATEGORIES[inputs.componentType] ||
    COMPONENT_CATEGORIES['resistor'];
  const {
    referenceLambda,
    processFactor,
    applicationBaseline,
    qualityFactor,
    maturityFactor,
  } = category.fides2022;

  const piProcess = processFactor;
  const piEnvironment =
    (ENVIRONMENT_FACTORS['FIDES 2022'] as Record<string, number>)[
      inputs.environment
    ] || 1.0;
  const piMaturity = maturityFactor;
  const piQuality = qualityFactor;
  const electricalStress = calculateGenericStressFactor(
    category.type,
    inputs.appliedVoltage,
    inputs.ratedVoltage,
    inputs.appliedCurrent,
    inputs.ratedCurrent,
  );

  // Application factor combines baseline mission profile weighting with temperature acceleration and electrical loading
  const piTemperature = fidesTemperatureFactor(
    inputs.temperature,
    category.type,
  );
  const piApplication = applicationBaseline * piTemperature * electricalStress;

  const lambda =
    referenceLambda *
    piProcess *
    piApplication *
    piEnvironment *
    piQuality *
    piMaturity;

  const failureRateVsTemp = [25, 40, 55, 70, 85, 100].map((temp) => ({
    temperature: temp,
    failureRate:
      referenceLambda *
      piProcess *
      (applicationBaseline *
        fidesTemperatureFactor(temp, category.type) *
        electricalStress) *
      piEnvironment *
      piQuality *
      piMaturity,
  }));

  const reliabilityVsTime = [0, 8760, 17520, 26280, 35040, 43800].map(
    (time) => ({
      time: time,
      reliability: Math.exp(-(lambda / 1e9) * time),
    }),
  );

  return {
    lambda: parseFloat(lambda.toFixed(1)),
    details: {
      formula:
        'λp = λref × ΠProcess × ΠApplication × ΠEnvironment × ΠQuality × ΠMaturity',
      factors: [
        {
          name: 'Reference failure rate (λref)',
          value: referenceLambda.toFixed(2),
          unit: 'FIT/device',
        },
        { name: 'Process factor (ΠProcess)', value: piProcess.toFixed(2) },
        {
          name: 'Application factor (ΠApplication)',
          value: piApplication.toFixed(2),
        },
        {
          name: 'Environment factor (ΠEnvironment)',
          value: piEnvironment.toFixed(2),
        },
        { name: 'Quality factor (ΠQuality)', value: piQuality.toFixed(2) },
        { name: 'Maturity factor (ΠMaturity)', value: piMaturity.toFixed(2) },
      ],
      notes: `FIDES Guide 2022 Edition A physics-of-failure prediction. ${
        category.type.includes('mosfet') || category.type.includes('ic')
          ? 'Semiconductor failure mechanisms: electromigration, hot carrier injection, TDDB. '
          : category.type.includes('capacitor')
            ? 'Dielectric degradation and electrolyte dry-out modeled. '
            : 'Failure mechanisms: thermal fatigue, interconnect stress. '
      }Operating temperature: ${inputs.temperature}°C (Tref = 40°C). ${
        inputs.powerLoss
          ? `Power dissipation: ${inputs.powerLoss.toFixed(2)}W contributing to thermal stress. `
          : ''
      }Application factor captures baseline mission severity (${applicationBaseline.toFixed(2)}), temperature acceleration and electrical loading (${electricalStress.toFixed(2)}). Environment: ${inputs.environment}. Most accurate for European applications.`,
      graphData: {
        failureRateVsTemp,
        reliabilityVsTime,
      },
    },
  };
}

// ============================================================================
// MAIN CALCULATION FUNCTION
// ============================================================================

export interface MTBFCalculationOptions {
  selectedParts: SelectedPart[];
  thermalComponents: ThermalComponent[];
  predictionMethod:
    'MIL-HDBK-217F' | 'Telcordia SR-332' | 'IEC TR 62380' | 'FIDES 2022';
  environment: string;
  defaultVoltage?: number;
  defaultCurrent?: number;
  switchingFrequency?: number;
}

/**
 * Calculate MTBF for all selected components using specified prediction method
 */
export function calculateMTBFComponents(
  options: MTBFCalculationOptions,
): MTBFComponent[] {
  const {
    selectedParts,
    thermalComponents,
    predictionMethod,
    environment,
    defaultVoltage = 20,
    defaultCurrent = 3,
    switchingFrequency = 200000,
  } = options;

  return selectedParts
    .filter((part) => part.isCircuitComponent || part.includeInMTBF)
    .map((part) => {
      // Find thermal data
      const thermalComp = thermalComponents.find(
        (tc) => tc.name === part.componentName,
      );

      // Extract parameters from thermal properties
      const temperature = thermalComp
        ? parseFloat(thermalComp.thermalProperties.temperature) || 25
        : 25;

      const appliedVoltage = thermalComp?.thermalProperties.peakVoltage
        ? parseFloat(thermalComp.thermalProperties.peakVoltage)
        : defaultVoltage;

      const ratedVoltage = thermalComp?.thermalProperties.ratedVoltage
        ? parseFloat(thermalComp.thermalProperties.ratedVoltage)
        : appliedVoltage * 1.5; // Assume 50% derating if unknown

      // Real current stress when the part's RMS current and rating are known;
      // otherwise the old placeholder (applied / rated = 2/3, no effect).
      const rmsCurrent = parseFloat(
        thermalComp?.thermalProperties.rmsCurrent ?? '',
      );
      const ratedCurrent = parseFloat(
        thermalComp?.thermalProperties.ratedCurrent ?? '',
      );
      const currentKnown = rmsCurrent >= 0 && ratedCurrent > 0;

      const powerLoss = thermalComp?.thermalProperties.totalLoss
        ? parseFloat(thermalComp.thermalProperties.totalLoss.split(' ')[0])
        : undefined;

      // Determine if switching component
      const isSwitching =
        part.componentType.includes('mosfet') ||
        part.componentType.includes('ic');

      // Prepare inputs
      const inputs: MTBFInputs = {
        componentType: part.componentType,
        temperature,
        appliedVoltage,
        ratedVoltage,
        appliedCurrent: currentKnown ? rmsCurrent : defaultCurrent,
        ratedCurrent: currentKnown ? ratedCurrent : defaultCurrent * 1.5,
        isSwitching,
        switchingFrequency: isSwitching ? switchingFrequency : undefined,
        environment,
        powerLoss,
      };

      // Calculate based on method
      let result: { lambda: number; details: MTBFCalculationDetails };

      switch (predictionMethod) {
        case 'MIL-HDBK-217F':
          result = calculateMILHDBK217F(inputs);
          break;
        case 'Telcordia SR-332':
          result = calculateTelcordiaSR332(inputs);
          break;
        case 'IEC TR 62380':
          result = calculateIECTR62380(inputs);
          break;
        case 'FIDES 2022':
          result = calculateFIDES2022(inputs);
          break;
        default:
          result = calculateMILHDBK217F(inputs);
      }

      const mtbf = 1e9 / result.lambda;

      // Determine status based on thermal properties
      const status: 'safe' | 'warning' | 'critical' =
        thermalComp?.thermalProperties.thermalStatus ||
        (temperature > 80 ? 'critical' : temperature > 60 ? 'warning' : 'safe');

      const category = COMPONENT_CATEGORIES[part.componentType];

      return {
        id: part.id,
        designator: part.componentName,
        partNumber: part.partNumber,
        category: category?.type || part.componentType,
        lambda: result.lambda,
        mtbf: parseFloat(mtbf.toFixed(0)),
        contribution: 0, // Will be calculated after all components
        status,
        calculationDetails: result.details,
      };
    });
}

/**
 * Calculate system-level MTBF (series reliability)
 */
export function calculateSystemMTBF(components: MTBFComponent[]): {
  mtbf: number;
  totalFailureRate: number;
  componentsWithContributions: MTBFComponent[];
} {
  const totalLambda = components.reduce((sum, comp) => sum + comp.lambda, 0);
  const systemMTBF = totalLambda > 0 ? 1e9 / totalLambda : 0;

  const componentsWithContributions = components.map((comp) => ({
    ...comp,
    contribution: parseFloat(((comp.lambda / totalLambda) * 100).toFixed(1)),
  }));

  return {
    mtbf: parseFloat(systemMTBF.toFixed(0)),
    totalFailureRate: parseFloat(totalLambda.toFixed(1)),
    componentsWithContributions,
  };
}
