import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  ValidateBy,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { DECK_KINDS, type DeckKind } from '../simulation.types';

/** `{ref: part}` with short non-empty strings (at most 32 entries). */
function IsPartMap(): PropertyDecorator {
  return ValidateBy({
    name: 'isPartMap',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length <= 32 &&
        Object.entries(value).every(
          ([ref, part]) =>
            ref.trim().length > 0 &&
            ref.length <= 32 &&
            typeof part === 'string' &&
            part.trim().length > 0 &&
            part.length <= 64,
        ),
      defaultMessage: () =>
        'overrides must map device refs to part numbers (at most 32)',
    },
  });
}

/** A self-contained ngspice deck (netlist + control block). */
const MAX_DECK_CHARS = 2_000_000;

export class DesignDecksDto {
  @ApiPropertyOptional({ maxLength: MAX_DECK_CHARS })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_DECK_CHARS)
  dc?: string;

  @ApiPropertyOptional({ maxLength: MAX_DECK_CHARS })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_DECK_CHARS)
  ac?: string;

  @ApiPropertyOptional({ maxLength: MAX_DECK_CHARS })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_DECK_CHARS)
  transient?: string;
}

/** Body of `PUT /projects/:projectId/branches/:branchId/stages/design/decks`. */
export class UpdateDesignDecksDto {
  @ApiProperty({
    type: DesignDecksDto,
    description: 'Decks to replace; the others are kept.',
  })
  @IsObject()
  @ValidateNested()
  @Type(() => DesignDecksDto)
  decks!: DesignDecksDto;
}

export class DesignValueDto {
  @ApiProperty({ example: 'L1', maxLength: 32 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(32)
  ref!: string;

  @ApiProperty({ example: 'inductance', maxLength: 32 })
  @IsString()
  @Matches(/^[A-Za-z_][A-Za-z0-9_]*$/)
  @MaxLength(32)
  param!: string;

  @ApiProperty({ example: '22u', maxLength: 40 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(40)
  value!: string;
}

/** Body of `PATCH /projects/:projectId/branches/:branchId/stages/design/values`. */
export class SetDesignValuesDto {
  @ApiProperty({ type: [DesignValueDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => DesignValueDto)
  values!: DesignValueDto[];
}

/** Body of `POST /projects/:projectId/branches/:branchId/stages/simulation/run`. */
export class RunSimulationDto {
  @ApiProperty({
    enum: DECK_KINDS,
    isArray: true,
    example: ['dc', 'transient'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DECK_KINDS.length)
  @ArrayUnique()
  @IsIn(DECK_KINDS, { each: true })
  analyses!: DeckKind[];
}

/** Body of `POST /projects/:projectId/branches/:branchId/stages/simulation/devices`. */
export class SelectDevicesDto {
  @ApiPropertyOptional({ enum: ['auto', 'mosfet', 'igbt'] })
  @IsOptional()
  @IsIn(['auto', 'mosfet', 'igbt'])
  preference?: 'auto' | 'mosfet' | 'igbt';

  @ApiPropertyOptional({
    description: 'Parts picked by hand, by device ref',
    example: { SW: 'C3M0065090D' },
  })
  @IsOptional()
  @IsObject()
  @IsPartMap()
  overrides?: Record<string, string>;
}

/** Body of `POST …/stages/design/modify`. */
export class ModifyDesignDto {
  @ApiProperty({ example: 'reduce output ripple below 20 mV', maxLength: 4000 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(4000)
  instruction!: string;
}

/** Body of `POST …/stages/design/ai-fix`. */
export class AiFixDesignDto {
  @ApiPropertyOptional({
    description: 'Extra instructions; a sensible default is used without them',
    maxLength: 4000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  instruction?: string;
}

/** Body of `POST /projects/:projectId/simulations/:nodeId/verify`. */
export class VerifySimulationDto {
  @ApiProperty({ example: 'Make Vout 12 V', maxLength: 4000 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(4000)
  userRequest!: string;

  @ApiProperty({ type: DesignDecksDto, description: 'Decks before the change' })
  @IsObject()
  @ValidateNested()
  @Type(() => DesignDecksDto)
  @IsDeckMap()
  beforeDecks!: DesignDecksDto;

  @ApiProperty({
    type: DesignDecksDto,
    description: 'Decks that were simulated',
  })
  @IsObject()
  @ValidateNested()
  @Type(() => DesignDecksDto)
  @IsDeckMap()
  afterDecks!: DesignDecksDto;
}

/** At least one non-empty dc / ac / transient deck. */
function IsDeckMap(): PropertyDecorator {
  return ValidateBy({
    name: 'isDeckMap',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        DECK_KINDS.some((k) => {
          const deck = (value as Record<string, unknown>)[k];
          return typeof deck === 'string' && deck.trim().length > 0;
        }),
      defaultMessage: () => 'at least one dc, ac or transient deck is required',
    },
  });
}
