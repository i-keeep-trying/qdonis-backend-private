import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

import { CreateUserDto } from './create-user.dto';

/**
 * Admin update. Every field optional, minus `password` — credentials change
 * only through the reset / change-password flows.
 */
export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['password'] as const),
) {
  @ApiPropertyOptional({
    description: 'Deactivating a user blocks login and revokes their sessions.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
