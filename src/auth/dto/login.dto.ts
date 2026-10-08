import { ApiProperty } from '@nestjs/swagger';

import {
  EmailField,
  ExistingPasswordField,
} from '../../common/validation/field-rules';

/**
 * Login credentials. Validated by the global ValidationPipe before any
 * password hashing happens. No composition rules: a stored password may
 * predate the current policy.
 */
export class LoginDto {
  @ApiProperty({ format: 'email', example: 'ada@example.com' })
  @EmailField()
  email!: string;

  @ApiProperty({ example: 'correct-horse-battery-staple-1' })
  @ExistingPasswordField()
  password!: string;
}
