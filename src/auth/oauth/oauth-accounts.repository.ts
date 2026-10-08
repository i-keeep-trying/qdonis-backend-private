import { Injectable } from '@nestjs/common';

import type { OAuthAccount, Prisma, User } from '../../generated/prisma/client';
import type { OAuthProvider } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';

type DbClient = Prisma.TransactionClient;

/** Data access for `oauth_accounts`. */
@Injectable()
export class OAuthAccountsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findWithUser(
    provider: OAuthProvider,
    providerAccountId: string,
    db: DbClient = this.prisma,
  ): Promise<(OAuthAccount & { user: User }) | null> {
    return db.oAuthAccount.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      include: { user: true },
    });
  }

  findForUser(
    userId: string,
    provider: OAuthProvider,
    db: DbClient = this.prisma,
  ): Promise<OAuthAccount | null> {
    return db.oAuthAccount.findUnique({
      where: { userId_provider: { userId, provider } },
    });
  }

  create(
    data: {
      userId: string;
      provider: OAuthProvider;
      providerAccountId: string;
      email: string;
    },
    db: DbClient = this.prisma,
  ): Promise<OAuthAccount> {
    return db.oAuthAccount.create({ data });
  }

  async updateEmail(
    id: string,
    email: string,
    db: DbClient = this.prisma,
  ): Promise<void> {
    await db.oAuthAccount.update({ where: { id }, data: { email } });
  }
}
