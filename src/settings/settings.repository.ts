import { Injectable } from '@nestjs/common';

import type { AppSetting, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<AppSetting[]> {
    return this.prisma.appSetting.findMany();
  }

  find(key: string): Promise<AppSetting | null> {
    return this.prisma.appSetting.findUnique({ where: { key } });
  }

  upsert(
    key: string,
    value: Prisma.InputJsonValue,
    updatedById: string,
  ): Promise<AppSetting> {
    return this.prisma.appSetting.upsert({
      where: { key },
      create: { key, value, updatedById },
      update: { value, updatedById },
    });
  }
}
