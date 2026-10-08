import { PickType } from '@nestjs/swagger';

import { CreateUserDto } from '../../users/dto/create-user.dto';

/**
 * Self-service registration. `role` is deliberately omitted — allowing it
 * would let anyone register as an administrator.
 */
export class RegisterDto extends PickType(CreateUserDto, [
  'email',
  'password',
  'name',
] as const) {}
