import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SourcingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async cached(key: string): Promise<unknown> {
    const row = await this.prisma.supplierSearchCache.findUnique({ where: { key } });
    return row && row.expiresAt > new Date() ? row.results : null;
  }

  async cache(input: {
    supplier: string;
    key: string;
    componentName: string;
    results: Prisma.InputJsonValue;
    expiresAt: Date;
  }): Promise<void> {
    await this.prisma.supplierSearchCache.upsert({
      where: { key: input.key },
      create: input,
      update: { results: input.results, expiresAt: input.expiresAt, componentName: input.componentName },
    });
  }

  async pruneCache(): Promise<number> {
    const { count } = await this.prisma.supplierSearchCache.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  }

  async callsSince(supplier: string, since: Date): Promise<number> {
    return this.prisma.supplierApiCall.count({ where: { supplier, createdAt: { gte: since } } });
  }

  async logCall(data: Prisma.SupplierApiCallUncheckedCreateInput): Promise<void> {
    await this.prisma.supplierApiCall.create({ data });
  }
}
