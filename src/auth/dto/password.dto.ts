import { ApiProperty } from '@nestjs/swagger';

import {
  EmailField,
  EmailTokenField,
  ExistingPasswordField,
  NewPasswordField,
} from '../../common/validation/field-rules';

export class EmailOnlyDto {
  @ApiProperty({ format: 'email', example: 'ada@example.com' })
  @EmailField()
  email!: string;
}

export class TokenDto {
  @ApiProperty({ description: 'Token from the emailed link' })
  @EmailTokenField()
  token!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token from the reset email' })
  @EmailTokenField()
  token!: string;

  @ApiProperty({ minLength: 10, maxLength: 128 })
  @NewPasswordField()
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @ExistingPasswordField()
  currentPassword!: string;

  @ApiProperty({ minLength: 10, maxLength: 128 })
  @NewPasswordField()
  newPassword!: string;
}
