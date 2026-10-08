import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import {
  EmailField,
  NameField,
  NewPasswordField,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../common/validation/field-rules';
import { Role } from '../../generated/prisma/enums';

export class CreateUserDto {
  @ApiProperty({ format: 'email', example: 'ada@example.com' })
  @EmailField()
  email!: string;

  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    example: 'correct-horse-battery-staple-1',
  })
  @NewPasswordField()
  password!: string;

  @ApiPropertyOptional({ maxLength: 120, example: 'Ada Lovelace' })
  @IsOptional()
  @NameField()
  name?: string;

  @ApiPropertyOptional({
    enum: Role,
    default: Role.USER,
    description: 'Only settable by administrators.',
  })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
