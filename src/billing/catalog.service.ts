import { Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../common/errors/error-codes';
import { isUniqueViolation } from '../common/errors/prisma-errors';
import type {
  AddonPackage,
  Plan,
  PlanPackage,
} from '../generated/prisma/client';
import { BillingInterval, PlanTier } from '../generated/prisma/enums';
import {
  BillingRepository,
  type DbClient,
  type PackageWithPlan,
} from './billing.repository';
import type {
  CreateAddonDto,
  CreatePackageDto,
  UpdateAddonDto,
  UpdatePackageDto,
  UpdatePlanDto,
} from './dto/catalog.dto';

/** Tokens granted for one billing period of `pkg` at `interval`. */
export function periodTokens(
  pkg: Pick<PlanPackage, 'tokenAllocation'>,
  interval: BillingInterval,
): number {
  return interval === BillingInterval.YEARLY
    ? pkg.tokenAllocation * 12
    : pkg.tokenAllocation;
}

export function priceIdFor(
  pkg: PlanPackage,
  interval: BillingInterval,
): string | null {
  return interval === BillingInterval.YEARLY
    ? pkg.stripePriceIdYearly
    : pkg.stripePriceIdMonthly;
}

export function intervalForPrice(
  pkg: PlanPackage,
  priceId: string,
): BillingInterval {
  return pkg.stripePriceIdYearly === priceId
    ? BillingInterval.YEARLY
    : BillingInterval.MONTHLY;
}

const FREE_PLAN_ID = 'free';

@Injectable()
export class CatalogService {
  constructor(private readonly repository: BillingRepository) {}

  listPlans(
    includeInactive = false,
  ): Promise<(Plan & { packages: PlanPackage[] })[]> {
    return this.repository.listPlans(includeInactive);
  }

  listAddons(includeInactive = false): Promise<AddonPackage[]> {
    return this.repository.listAddons(includeInactive);
  }

  freePlanId(): string {
    return FREE_PLAN_ID;
  }

  /**
   * A package that can be bought through Stripe Checkout right now at
   * `interval`. Free and contact-only plans never qualify.
   */
  async purchasable(
    packageId: string,
    interval: BillingInterval,
  ): Promise<{ pkg: PackageWithPlan; priceId: string }> {
    const pkg = await this.repository.findPackage(packageId);
    if (!pkg || !pkg.isActive || !pkg.plan.isActive) {
      throw AppError.notFound(
        ErrorCode.PackageNotFound,
        'Plan package not found',
      );
    }
    if (pkg.plan.tier === PlanTier.FREE || pkg.plan.isContactOnly) {
      throw AppError.badRequest(
        ErrorCode.PackageNotPurchasable,
        'This plan cannot be purchased online; contact sales',
      );
    }
    const priceId = priceIdFor(pkg, interval);
    if (!priceId) {
      throw AppError.badRequest(
        ErrorCode.PackageNotPurchasable,
        `This package is not available with ${interval.toLowerCase()} billing`,
      );
    }
    return { pkg, priceId };
  }

  /**
   * Resolves a Stripe price to its package. Inactive packages still resolve:
   * existing subscribers keep renewing on a retired package.
   */
  async packageForPrice(
    priceId: string,
    db?: DbClient,
  ): Promise<{ pkg: PackageWithPlan; interval: BillingInterval } | null> {
    const pkg = await this.repository.findPackageByPriceId(priceId, db);
    return pkg ? { pkg, interval: intervalForPrice(pkg, priceId) } : null;
  }

  async addon(addonId: string): Promise<AddonPackage> {
    const addon = await this.repository.findAddon(addonId);
    if (!addon || !addon.isActive) {
      throw AppError.notFound(ErrorCode.AddonNotFound, 'Add-on not found');
    }
    if (!addon.stripePriceId) {
      throw AppError.badRequest(
        ErrorCode.PackageNotPurchasable,
        'This add-on is not available for purchase',
      );
    }
    return addon;
  }

  // --- admin edits -------------------------------------------------------

  async updatePlan(id: string, dto: UpdatePlanDto): Promise<Plan> {
    if (!(await this.repository.findPlan(id))) {
      throw AppError.notFound(ErrorCode.PlanNotFound, 'Plan not found');
    }
    if (id === FREE_PLAN_ID && dto.isActive === false) {
      throw AppError.badRequest(
        ErrorCode.ValidationFailed,
        'The free plan cannot be deactivated',
      );
    }
    return this.repository.updatePlan(id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.features !== undefined ? { features: dto.features } : {}),
      ...(dto.isPopular !== undefined ? { isPopular: dto.isPopular } : {}),
      ...(dto.isContactOnly !== undefined
        ? { isContactOnly: dto.isContactOnly }
        : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    });
  }

  async createPackage(dto: CreatePackageDto): Promise<PlanPackage> {
    if (!(await this.repository.findPlan(dto.planId))) {
      throw AppError.notFound(ErrorCode.PlanNotFound, 'Plan not found');
    }
    return this.mapUnique(() =>
      this.repository.createPackage({
        id: dto.id,
        planId: dto.planId,
        name: dto.name,
        tokenAllocation: dto.tokenAllocation,
        monthlyPriceCents: dto.monthlyPriceCents,
        yearlyPriceCents: dto.yearlyPriceCents,
        stripePriceIdMonthly: dto.stripePriceIdMonthly ?? null,
        stripePriceIdYearly: dto.stripePriceIdYearly ?? null,
        isDefault: dto.isDefault ?? false,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
      }),
    );
  }

  async updatePackage(id: string, dto: UpdatePackageDto): Promise<PlanPackage> {
    if (!(await this.repository.findPackage(id))) {
      throw AppError.notFound(
        ErrorCode.PackageNotFound,
        'Plan package not found',
      );
    }
    return this.mapUnique(() =>
      this.repository.updatePackage(id, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.tokenAllocation !== undefined
          ? { tokenAllocation: dto.tokenAllocation }
          : {}),
        ...(dto.monthlyPriceCents !== undefined
          ? { monthlyPriceCents: dto.monthlyPriceCents }
          : {}),
        ...(dto.yearlyPriceCents !== undefined
          ? { yearlyPriceCents: dto.yearlyPriceCents }
          : {}),
        ...(dto.stripePriceIdMonthly !== undefined
          ? { stripePriceIdMonthly: dto.stripePriceIdMonthly || null }
          : {}),
        ...(dto.stripePriceIdYearly !== undefined
          ? { stripePriceIdYearly: dto.stripePriceIdYearly || null }
          : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      }),
    );
  }

  createAddon(dto: CreateAddonDto): Promise<AddonPackage> {
    return this.mapUnique(() =>
      this.repository.createAddon({
        id: dto.id,
        name: dto.name,
        description: dto.description ?? null,
        tokenAmount: dto.tokenAmount,
        priceCents: dto.priceCents,
        stripePriceId: dto.stripePriceId ?? null,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
      }),
    );
  }

  async updateAddon(id: string, dto: UpdateAddonDto): Promise<AddonPackage> {
    if (!(await this.repository.findAddon(id))) {
      throw AppError.notFound(ErrorCode.AddonNotFound, 'Add-on not found');
    }
    return this.mapUnique(() =>
      this.repository.updateAddon(id, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description || null }
          : {}),
        ...(dto.tokenAmount !== undefined
          ? { tokenAmount: dto.tokenAmount }
          : {}),
        ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
        ...(dto.stripePriceId !== undefined
          ? { stripePriceId: dto.stripePriceId || null }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      }),
    );
  }

  private async mapUnique<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppError.conflict(
          ErrorCode.ValidationFailed,
          'Another record already uses this id or Stripe price id',
        );
      }
      throw error;
    }
  }
}
