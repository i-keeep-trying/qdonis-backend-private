import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { Session } from '../../generated/prisma/client';

/**
 * A signed-in device, for a "where you're signed in" screen.
 * `refreshTokenHash` is never included — it is the credential itself.
 */
export class SessionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ nullable: true })
  userAgent: string | null;

  @ApiPropertyOptional({ nullable: true })
  ipAddress: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'When this login started',
  })
  signedInAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  lastUsedAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  @ApiProperty({ description: 'True for the login making this request' })
  current: boolean;

  constructor(session: Session, currentFamilyId: string) {
    this.id = session.id;
    this.userAgent = session.userAgent;
    this.ipAddress = session.ipAddress;
    this.signedInAt = session.authenticatedAt;
    this.lastUsedAt = session.createdAt;
    this.expiresAt = session.expiresAt;
    this.current = session.familyId === currentFamilyId;
  }
}
