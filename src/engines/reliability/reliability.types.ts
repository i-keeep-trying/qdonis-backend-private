/** Shapes used by the MTBF engine (ported from the old frontend `types.ts`). */

export type ThermalStatus = 'safe' | 'warning' | 'critical';

export interface ThermalProperties {
  thermalResistance: string;
  temperature: string;
  powerLoss: string;
  voltageStress: string;
  currentStress: string;
  efficiency: string;
  thermalTimeConstant: string;
  maxOperatingTemp: string;
  derating: string;
  coolingRequirement: string;
  coreLoss?: string;
  copperLoss?: string;
  switchingLoss?: string;
  conductionLoss?: string;
  totalLoss?: string;
  peakVoltage?: string;
  ratedVoltage?: string;
  /** RMS current through the part and its current rating, A (current stress). */
  rmsCurrent?: string;
  ratedCurrent?: string;
  temperatureMargin?: string;
  voltageMargin?: string;
  thermalStatus?: ThermalStatus;
  voltageStressStatus?: ThermalStatus;
  inputPower?: string;
  outputPower?: string;
  overallEfficiency?: string;
}

export interface ThermalComponent {
  id: string;
  name: string;
  type:
    | 'mosfet'
    | 'diode'
    | 'inductor'
    | 'transformer'
    | 'capacitor'
    | 'resistor'
    | 'ic';
  position: { x: number; y: number };
  thermalProperties: ThermalProperties;
  partNumber?: string;
  isSelected: boolean;
  userTemperatureMargin?: number;
  userVoltageMargin?: number;
}

export interface ComponentOption {
  id: string;
  manufacturer: string;
  partNumber: string;
  description: string;
  mountingType: string;
  availability: string;
  pricingTiers: { quantity: number; price: number }[];
  datasheetLink: string;
  electricalSpecs: Record<string, string>;
  isSelected: boolean;
  quantity?: number;
  thumbnailImage?: string;
  mouserPartNumber?: string;
  factoryStock?: string;
  leadTime?: string;
  lifecycleStatus?: string;
  rohsStatus?: string;
  /** Price currency of `pricingTiers` (Mouser: the account's currency). */
  currency?: string;
}

export interface SelectedPart extends ComponentOption {
  componentName: string;
  componentType: string;
  componentId: string;
  isCircuitComponent: boolean;
  selectionSource: 'suggested' | 'manual';
  includeInMTBF?: boolean;
}

export interface MTBFCalculationDetails {
  formula: string;
  factors: Array<{ name: string; value: string; unit?: string }>;
  notes?: string;
  graphData?: {
    failureRateVsTemp: Array<{ temperature: number; failureRate: number }>;
    reliabilityVsTime: Array<{ time: number; reliability: number }>;
  };
}

export interface MTBFComponent {
  id: string;
  designator: string;
  partNumber: string;
  category: string;
  lambda: number;
  mtbf: number;
  contribution: number;
  status: 'safe' | 'warning' | 'critical';
  calculationDetails?: MTBFCalculationDetails;
}
