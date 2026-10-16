import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  MTBF_METHODS,
  MTBF_PART_TYPES,
  type MtbfMethod,
  type MtbfPartType,
} from '../mtbf.stage';

/**
 * Bodies of the branch stage runs of magnetics, thermal and MTBF, in the
 * qdonis-web contract (`RunMagneticsInput`, `RunThermalInput`,
 * `RunMtbfInput`).
 */

const Num = (min: number, max: number) =>
  applyDecorators(
    IsNumber({ allowNaN: false, allowInfinity: false }),
    Min(min),
    Max(max),
  );

/** A number in range, or null. */
const NullableNum = (min: number, max: number) =>
  applyDecorators(
    ApiProperty({ nullable: true, type: Number }),
    ValidateIf((_, v) => v !== null),
    Num(min, max),
  );

/** Designator such as Q1 or L1. */
const Ref = () =>
  applyDecorators(
    ApiProperty({ example: 'L1', maxLength: 16 }),
    IsString(),
    MaxLength(16),
    Matches(/^[A-Za-z]\w*$/, { message: 'ref must be a designator like L1' }),
  );

/** `{ref: core}` with short non-empty names (at most 32 entries). */
function IsCoreMap(): PropertyDecorator {
  return ValidateBy({
    name: 'isCoreMap',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length <= 32 &&
        Object.entries(value).every(
          ([ref, core]) =>
            /^[A-Za-z]\w{0,15}$/.test(ref) &&
            typeof core === 'string' &&
            core.trim().length > 0 &&
            core.length <= 40,
        ),
      defaultMessage: () => 'coreOverrides must map part refs to core names',
    },
  });
}

// --- magnetics -------------------------------------------------------------------

const KINDS = ['inductor', 'flyback', 'transformer', 'resonant'] as const;

export class MagneticsSettingsDto {
  @ApiProperty({ nullable: true, maxLength: 20 })
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  material!: string | null;

  @NullableNum(0.01, 2) maxFluxDensityT!: number | null;
  @NullableNum(0.5, 20) currentDensity!: number | null;
  @NullableNum(0.05, 0.8) windowUtilization!: number | null;
  @NullableNum(1, 150) maxTempRiseC!: number | null;

  @ApiProperty() @Num(-55, 150) ambientC!: number;
}

export class MagneticPartStageDto {
  @Ref() ref!: string;

  @ApiProperty({ enum: KINDS })
  @IsIn(KINDS)
  kind!: (typeof KINDS)[number];

  @ApiProperty({ nullable: true, maxLength: 60 })
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(60)
  role!: string | null;

  @NullableNum(0.001, 1_000_000) inductanceUh!: number | null;
  @NullableNum(0.001, 1_000) turnsRatio!: number | null;
  @ApiProperty() @Num(0.01, 10_000) fswKhz!: number;
  @NullableNum(0, 1) duty!: number | null;
  @NullableNum(0, 5_000) iDcA!: number | null;
  @NullableNum(0, 5_000) iRipplePpA!: number | null;
  @NullableNum(0, 5_000) iPeakA!: number | null;
  @NullableNum(0, 5_000) iRmsA!: number | null;
  @NullableNum(0, 100_000) vPrimaryV!: number | null;
  @NullableNum(0, 1_000_000) powerW!: number | null;

  @ApiProperty() @IsBoolean() unipolar!: boolean;
}

/** Body of `POST /projects/:projectId/branches/:branchId/stages/magnetics/run`. */
export class RunMagneticsStageDto {
  @ApiProperty({ enum: ['circuit', 'input'] })
  @IsIn(['circuit', 'input'])
  origin!: 'circuit' | 'input';

  @ApiPropertyOptional({ type: [MagneticPartStageDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => MagneticPartStageDto)
  inputs?: MagneticPartStageDto[];

  @ApiProperty({ type: MagneticsSettingsDto })
  @IsObject()
  @ValidateNested()
  @Type(() => MagneticsSettingsDto)
  settings!: MagneticsSettingsDto;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Cores forced by the user, by part ref',
  })
  @IsOptional()
  @IsObject()
  @IsCoreMap()
  coreOverrides?: Record<string, string>;

  @ApiPropertyOptional({
    type: [MagneticPartStageDto],
    description:
      "Circuit parts designed from these values instead of their simulated waveforms (by ref); kept across re-designs. With origin 'input' they replace the entered parts.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => MagneticPartStageDto)
  partOverrides?: MagneticPartStageDto[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Refs whose entered values are dropped (back to the circuit waveforms)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  clearOverrides?: string[];

  @ApiPropertyOptional({ description: 'Drop every entered value' })
  @IsOptional()
  @IsBoolean()
  clearAllOverrides?: boolean;
}

// --- thermal ---------------------------------------------------------------------

const TECH = ['SiC', 'GaN', 'Si', 'IGBT'] as const;
const OTHER = ['capacitor', 'resistor', 'gate_drive'] as const;

export class ThermalSettingsDto {
  @ApiProperty() @Num(-55, 150) ambientC!: number;
  @NullableNum(0, 100) marginC!: number | null;
  @NullableNum(25, 250) maxJunctionC!: number | null;
  @NullableNum(0, 50) rthCs!: number | null;

  @ApiProperty({ enum: ['auto', 'none', 'shared'] })
  @IsIn(['auto', 'none', 'shared'])
  strategy!: 'auto' | 'none' | 'shared';

  @NullableNum(0, 1_000_000) outputPowerW!: number | null;
}

export class ThermalDeviceStageDto {
  @Ref() ref!: string;
  @ApiProperty({ enum: ['switch', 'diode'] })
  @IsIn(['switch', 'diode'])
  kind!: 'switch' | 'diode';
  @ApiProperty() @Num(0, 100_000) lossW!: number;
  @ApiProperty({ enum: TECH })
  @IsIn(TECH)
  technology!: (typeof TECH)[number];
}

export class ThermalMagneticStageDto {
  @Ref() ref!: string;
  @ApiProperty() @Num(0, 100_000) lossW!: number;
  @NullableNum(0, 200) tempRiseC!: number | null;
}

export class ThermalOtherLossStageDto {
  @Ref() ref!: string;
  @ApiProperty({ enum: OTHER })
  @IsIn(OTHER)
  category!: (typeof OTHER)[number];
  @ApiProperty() @Num(0, 100_000) lossW!: number;
}

export class ThermalInputsStageDto {
  @ApiProperty({ type: [ThermalDeviceStageDto] })
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => ThermalDeviceStageDto)
  devices!: ThermalDeviceStageDto[];

  @ApiProperty({ type: [ThermalMagneticStageDto] })
  @IsArray()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => ThermalMagneticStageDto)
  magnetics!: ThermalMagneticStageDto[];

  @ApiProperty({ type: [ThermalOtherLossStageDto] })
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => ThermalOtherLossStageDto)
  otherLosses!: ThermalOtherLossStageDto[];

  @NullableNum(0, 1_000_000) outputPowerW!: number | null;
}

/** Body of `POST /projects/:projectId/branches/:branchId/stages/thermal/run`. */
export class RunThermalStageDto {
  @ApiProperty({ enum: ['simulation', 'input'] })
  @IsIn(['simulation', 'input'])
  origin!: 'simulation' | 'input';

  @ApiPropertyOptional({ type: ThermalInputsStageDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ThermalInputsStageDto)
  inputs?: ThermalInputsStageDto;

  @ApiProperty({ type: ThermalSettingsDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ThermalSettingsDto)
  settings!: ThermalSettingsDto;
}

// --- MTBF ------------------------------------------------------------------------

/** `{ref: include}` for at most 200 parts. */
function IsIncludeMap(): PropertyDecorator {
  return ValidateBy({
    name: 'isIncludeMap',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length <= 200 &&
        Object.entries(value).every(
          ([ref, include]) =>
            /^[A-Za-z]\w{0,39}$/.test(ref) && typeof include === 'boolean',
        ),
      defaultMessage: () => 'overrides must map part refs to true / false',
    },
  });
}

export class MtbfSettingsDto {
  @ApiProperty({ enum: MTBF_METHODS })
  @IsIn(MTBF_METHODS)
  predictionMethod!: MtbfMethod;

  @ApiProperty({ description: "One of the method's environments" })
  @IsString()
  @MaxLength(120)
  environment!: string;

  @ApiProperty({
    description: 'Parts included (true) or left out (false) by the user',
    example: { R_LOAD: false },
  })
  @IsIncludeMap()
  overrides!: Record<string, boolean>;
}

export class MtbfPartStageDto {
  @Ref() ref!: string;
  @ApiProperty({ enum: MTBF_PART_TYPES })
  @IsIn(MTBF_PART_TYPES)
  type!: MtbfPartType;
  @ApiProperty({ nullable: true, maxLength: 60 })
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(60)
  partNumber!: string | null;
  @NullableNum(-55, 250) temperatureC!: number | null;
  @NullableNum(0, 100_000) voltageV!: number | null;
  @NullableNum(0.1, 100_000) ratedVoltageV!: number | null;
}

/** Body of `POST /projects/:projectId/branches/:branchId/stages/mtbf/run`. */
export class RunMtbfStageDto {
  @ApiProperty({ enum: ['circuit', 'input'] })
  @IsIn(['circuit', 'input'])
  origin!: 'circuit' | 'input';

  @ApiPropertyOptional({ type: [MtbfPartStageDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => MtbfPartStageDto)
  inputs?: MtbfPartStageDto[];

  @ApiProperty({ type: MtbfSettingsDto })
  @IsObject()
  @ValidateNested()
  @Type(() => MtbfSettingsDto)
  settings!: MtbfSettingsDto;
}
