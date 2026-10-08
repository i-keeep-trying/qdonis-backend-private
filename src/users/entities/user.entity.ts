import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';

import type { User } from '../../generated/prisma/client';
import type { Role } from '../../generated/prisma/enums';

/**
 * API representation of a user.
 *
 * Secret and security-internal columns (`passwordHash`, lockout counters) are
 * never copied onto the entity, and `passwordHash` is additionally marked
 * `@Exclude()` so the global `instanceToPlain` interceptor can never serialise
 * it. Always construct entities from Prisma rows rather than returning rows.
 */
export class UserEntity {
  @ApiProperty({ format: 'uuid' })
  @Expose()
  id: string;

  @ApiProperty({ format: 'email' })
  @Expose()
  email: string;

  @ApiProperty({ description: 'True once the email address has been verified' })
  @Expose()
  emailVerified: boolean;

  @ApiPropertyOptional({ nullable: true })
  @Expose()
  name: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uri' })
  @Expose()
  avatarUrl: string | null;

  @ApiProperty({ enum: ['USER', 'ADMIN'] })
  @Expose()
  role: Role;

  @ApiProperty()
  @Expose()
  isActive: boolean;

  @ApiProperty({
    description: 'False for accounts that only sign in with Google',
  })
  @Expose()
  hasPassword: boolean;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  @Expose()
  lastLoginAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @Expose()
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @Expose()
  updatedAt: Date;

  @Exclude()
  passwordHash?: never;

  constructor(user: User) {
    this.id = user.id;
    this.email = user.email;
    this.emailVerified = user.emailVerifiedAt !== null;
    this.name = user.name;
    this.avatarUrl = user.avatarUrl;
    this.role = user.role;
    this.isActive = user.isActive;
    this.hasPassword = user.passwordHash !== null;
    this.lastLoginAt = user.lastLoginAt;
    this.createdAt = user.createdAt;
    this.updatedAt = user.updatedAt;
  }
}
