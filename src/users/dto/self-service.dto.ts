import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUrl, MaxLength, ValidateIf } from 'class-validator';

import {
  ExistingPasswordField,
  NameField,
} from '../../common/validation/field-rules';

/** Fields a user may change on their own profile. Email and role are not. */
export class UpdateProfileDto {
  @ApiPropertyOptional({
    maxLength: 120,
    nullable: true,
    example: 'Ada Lovelace',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @NameField()
  name?: string | null;

  @ApiPropertyOptional({ maxLength: 2048, nullable: true, format: 'uri' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsUrl(
    { protocols: ['https'], require_protocol: true },
    {
      message: 'avatarUrl must be an https URL',
    },
  )
  @MaxLength(2048)
  avatarUrl?: string | null;
}

export class DeleteAccountDto {
  @ApiPropertyOptional({
    description: 'Required for accounts that have a password.',
  })
  @IsOptional()
  @ExistingPasswordField()
  password?: string;
}
