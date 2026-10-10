import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { TrimmedString } from '../../common/validation/field-rules';

/** Finite number in a sane engineering range. */
const Num = (min: number, max: number) =>
  applyDecorators(
    IsNumber({ allowNaN: false, allowInfinity: false }),
    Min(min),
    Max(max),
  );

const KINDS = ['inductor', 'flyback', 'transformer', 'resonant'] as const;

export class MagneticPartDto {
  @ApiProperty() @TrimmedString(1, 40) ref!: string;
  @ApiProperty({ enum: KINDS }) @IsIn(KINDS) kind!: (typeof KINDS)[number];
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: string;
  @ApiPropertyOptional() @IsOptional() @Num(1e-6, 1e7) inductance_uh?: number;
  @ApiPropertyOptional() @IsOptional() @Num(1e-4, 1e4) turns_ratio?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0.001, 1e5) fsw_khz?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0.01, 0.99) duty?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 1e5) i_dc_a?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 1e5) i_ripple_pp_a?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 1e5) i_peak_a?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 1e5) i_rms_a?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 1e6) v_primary_v?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 1e8) power_w?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() unipolar?: boolean;
}

export class RunMagneticsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  material?: string;
  @ApiPropertyOptional() @IsOptional() @Num(0.01, 2) maxFluxDensity?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0.1, 50) currentDensity?: number;
  @ApiPropertyOptional() @IsOptional() @Num(1, 200) maxTempRiseC?: number;
  @ApiPropertyOptional() @IsOptional() @Num(-60, 200) ambientC?: number;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  coreOverrides?: Record<string, string>;

  @ApiPropertyOptional({
    type: [MagneticPartDto],
    description: 'Parts described directly (no circuit needed)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MagneticPartDto)
  parts?: MagneticPartDto[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() fromCircuit?: boolean;
}

const TECH = ['SiC', 'GaN', 'Si', 'IGBT'] as const;

export class ThermalDeviceDto {
  @ApiProperty() @TrimmedString(1, 60) ref!: string;
  @ApiPropertyOptional({ enum: ['switch', 'diode'] })
  @IsOptional()
  @IsIn(['switch', 'diode'])
  kind?: 'switch' | 'diode';
  @ApiPropertyOptional() @IsOptional() @Num(0, 1e6) loss_w?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 1e6) conduction_loss_w?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 1e6) switching_loss_w?: number;
  @ApiPropertyOptional({ enum: TECH })
  @IsOptional()
  @IsIn(TECH)
  technology?: (typeof TECH)[number];
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  method?: string;
}

export class ThermalMagneticDto {
  @ApiProperty() @TrimmedString(1, 60) ref!: string;
  @ApiProperty() @Num(0, 1e6) loss_w!: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 500) temp_rise_c?: number;
}

const OTHER = ['capacitor', 'resistor', 'gate_drive'] as const;

export class ThermalOtherLossDto {
  @ApiProperty() @TrimmedString(1, 60) ref!: string;
  @ApiProperty({ enum: OTHER }) @IsIn(OTHER) category!: (typeof OTHER)[number];
  @ApiProperty() @Num(0, 1e6) loss_w!: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  method?: string;
}

export class ThermalInputsDto {
  @ApiPropertyOptional({ type: [ThermalDeviceDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ThermalDeviceDto)
  devices?: ThermalDeviceDto[];

  @ApiPropertyOptional({ type: [ThermalMagneticDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ThermalMagneticDto)
  magnetics?: ThermalMagneticDto[];

  @ApiPropertyOptional({ type: [ThermalOtherLossDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ThermalOtherLossDto)
  other_losses?: ThermalOtherLossDto[];

  @ApiPropertyOptional() @IsOptional() @Num(0, 1e8) output_power_w?: number;
}

export class RunThermalDto {
  @ApiPropertyOptional() @IsOptional() @Num(-60, 200) ambientC?: number;
  @ApiPropertyOptional() @IsOptional() @Num(25, 300) maxJunctionC?: number;
  @ApiPropertyOptional({ enum: ['auto', 'none', 'shared'] })
  @IsOptional()
  @IsIn(['auto', 'none', 'shared'])
  strategy?: 'auto' | 'none' | 'shared';
  @ApiPropertyOptional() @IsOptional() @Num(0, 20) rthCs?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 100) marginC?: number;

  @ApiPropertyOptional({
    type: ThermalInputsDto,
    description: 'Heat sources entered directly',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThermalInputsDto)
  inputs?: ThermalInputsDto;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() fromSimulation?: boolean;
}

// --- calculators ---------------------------------------------------------------

export class EmcParametersDto {
  @ApiProperty({ description: 'PFC inductor, mH' })
  @Num(0.001, 1000)
  pfcInductorMH!: number;
  @ApiProperty({ description: 'DC bus, V' })
  @Num(1, 2000)
  htRailVoltage!: number;
  @ApiProperty({ description: 'Input power, W' })
  @Num(0.1, 1e6)
  inputPower!: number;
  @ApiProperty({ description: 'Input RMS voltage, V' })
  @Num(1, 1000)
  inputRMSVoltage!: number;
  @ApiProperty({ description: '1st input capacitor, nF' })
  @Num(0.001, 1e7)
  firstInputCapNF!: number;
  @ApiProperty({ description: '2nd input capacitor, nF' })
  @Num(0.001, 1e7)
  secondInputCapNF!: number;
  @ApiProperty({ description: 'Input filter inductor, mH' })
  @Num(0.001, 1000)
  inputFilterInductorMH!: number;
  @ApiProperty({ description: 'Pass margin, dB' })
  @Num(0, 60)
  passMarginDB!: number;
  @ApiProperty({ description: 'LISN resistance, Ω' })
  @Num(1, 1000)
  lisnResistanceOhm!: number;
}

export class EmcSpectrumDto extends EmcParametersDto {
  @ApiProperty({ description: 'Input voltage to plot, V' })
  @Num(1, 1000)
  voltage!: number;
}

export const MTBF_METHODS = [
  'MIL-HDBK-217F',
  'Telcordia SR-332',
  'IEC TR 62380',
  'FIDES 2022',
] as const;

export class MtbfPartDto {
  @ApiProperty() @TrimmedString(1, 100) id!: string;
  @ApiProperty({ description: 'Designator, e.g. Q1' })
  @TrimmedString(1, 60)
  componentName!: string;
  @ApiProperty({ description: 'mosfet, diode, inductor, capacitor, ...' })
  @TrimmedString(1, 60)
  componentType!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  partNumber?: string;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isCircuitComponent?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() includeInMTBF?: boolean;
}

export class MtbfThermalDto {
  @ApiProperty() @TrimmedString(1, 60) name!: string;
  @ApiPropertyOptional({ description: 'e.g. "85" or "85 °C"' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  temperature?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  peakVoltage?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  ratedVoltage?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  totalLoss?: string;
  @ApiPropertyOptional({ enum: ['safe', 'warning', 'critical'] })
  @IsOptional()
  @IsIn(['safe', 'warning', 'critical'])
  thermalStatus?: 'safe' | 'warning' | 'critical';
}

export class MtbfDto {
  @ApiProperty({ enum: MTBF_METHODS })
  @IsIn(MTBF_METHODS)
  predictionMethod!: (typeof MTBF_METHODS)[number];
  @ApiProperty({
    description: 'One of GET /calculators/mtbf/options environments',
  })
  @IsString()
  @MaxLength(120)
  environment!: string;

  @ApiPropertyOptional({
    type: [MtbfPartDto],
    description: 'Defaults to the project selected parts',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => MtbfPartDto)
  parts?: MtbfPartDto[];

  @ApiPropertyOptional({
    type: [MtbfThermalDto],
    description: 'Defaults to the project thermal components',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => MtbfThermalDto)
  thermal?: MtbfThermalDto[];

  @ApiPropertyOptional() @IsOptional() @Num(0, 1e6) defaultVoltage?: number;
  @ApiPropertyOptional() @IsOptional() @Num(0, 1e5) defaultCurrent?: number;
  @ApiPropertyOptional() @IsOptional() @Num(1, 1e9) switchingFrequency?: number;
}

export class BomQuantityDto {
  @ApiProperty({ minimum: 1, maximum: 1_000_000 })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;
}

export class BomExportDto {
  @ApiProperty({ enum: ['xlsx', 'csv'] })
  @IsIn(['xlsx', 'csv'])
  format!: 'xlsx' | 'csv';
}
