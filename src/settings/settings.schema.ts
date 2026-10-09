import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateBy,
} from 'class-validator';

export class SignupBonusSetting {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ minimum: 0, maximum: 100_000_000 })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  bonusTokens!: number;

  @ApiProperty({
    minimum: 1,
    maximum: 365,
    description: 'Trial tokens expire after this many days',
  })
  @IsInt()
  @Min(1)
  @Max(365)
  trialDays!: number;
}

export class TokenExpirySetting {
  @ApiProperty({
    minimum: 1,
    maximum: 24,
    description:
      'Unused plan tokens stay usable this many months after their billing period ends',
  })
  @IsInt()
  @Min(1)
  @Max(24)
  monthsAfterPeriodEnd!: number;
}

export class AddonPricingSetting {
  @ApiProperty({
    description: 'Tokens granted per US dollar for custom top-ups',
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(10_000_000)
  tokensPerUsd!: number;

  @ApiProperty({ minimum: 50 })
  @IsInt()
  @Min(50)
  customMinCents!: number;

  @ApiProperty({ maximum: 10_000_000 })
  @IsInt()
  @Max(10_000_000)
  customMaxCents!: number;
}

export class ModelConfigSetting {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  modelName!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  displayName!: string;

  @ApiProperty()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  inputCostPerMillion!: number;

  @ApiProperty()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  outputCostPerMillion!: number;
}

export class TokenPricingSetting {
  @ApiProperty({ description: 'Multiplier applied to raw model token counts' })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(100)
  markupMultiplier!: number;

  @ApiProperty()
  @IsBoolean()
  displayAsCredits!: boolean;

  @ApiProperty()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  @Max(1_000_000)
  creditsPerToken!: number;
}

/** `{ step_name: multiplier }`, at most 50 steps, each multiplier 0–100. */
const IsMultiplierMap = () =>
  ValidateBy({
    name: 'isMultiplierMap',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length <= 50 &&
        Object.entries(value).every(
          ([key, n]) =>
            /^[a-z0-9_]{1,64}$/.test(key) &&
            typeof n === 'number' &&
            Number.isFinite(n) &&
            n >= 0 &&
            n <= 100,
        ),
      defaultMessage: () =>
        'multipliers must map snake_case step names (max 50) to numbers between 0 and 100',
    },
  });

export class StepMultipliersSetting {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  @IsMultiplierMap()
  multipliers!: Record<string, number>;
}

const DEFAULT_STEPS = [
  'initial_requirements',
  'project_name_generation',
  'stage_parameters_analysis',
  'mandatory_parameters',
  'topology_generation',
  'circuit_schematic_generation',
  'component_sourcing',
  'magnetics_extraction',
  'magnetics_design',
  'component_evaluation',
  // POST /studio/agent (one Studio chat agent step).
  'studio_agent',
];

/** Every known setting key, its value class and its default. */
export const SETTINGS = {
  signup_bonus: {
    schema: SignupBonusSetting,
    defaults: {
      enabled: true,
      bonusTokens: 10_000,
      trialDays: 14,
    } satisfies SignupBonusSetting,
  },
  token_expiry: {
    schema: TokenExpirySetting,
    defaults: { monthsAfterPeriodEnd: 3 } satisfies TokenExpirySetting,
  },
  addon_pricing: {
    schema: AddonPricingSetting,
    defaults: {
      tokensPerUsd: 250_000 / 79,
      customMinCents: 500,
      customMaxCents: 50_000,
    } satisfies AddonPricingSetting,
  },
  token_pricing: {
    schema: TokenPricingSetting,
    defaults: {
      markupMultiplier: 1,
      displayAsCredits: false,
      creditsPerToken: 1,
    } satisfies TokenPricingSetting,
  },
  step_multipliers: {
    schema: StepMultipliersSetting,
    defaults: {
      multipliers: Object.fromEntries(DEFAULT_STEPS.map((step) => [step, 1])),
    } satisfies StepMultipliersSetting,
  },
  model_config: {
    schema: ModelConfigSetting,
    defaults: {
      modelName: 'anthropic/claude-4.5-sonnet',
      displayName: 'Claude 4.5 Sonnet',
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
    } satisfies ModelConfigSetting,
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = InstanceType<
  (typeof SETTINGS)[K]['schema']
>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}
