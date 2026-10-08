import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RolesGuard } from '../auth/guards/roles.guard';
import { BillingAdminService } from '../billing/billing-admin.service';
import {
  addonView,
  batchView,
  eventView,
  ledgerView,
  planView,
  subscriptionView,
  packageView,
} from '../billing/billing.views';
import { CatalogService } from '../billing/catalog.service';
import {
  AdminAssignPlanDto,
  AdminBatchExpiryDto,
  AdminDeductTokensDto,
  AdminGrantTokensDto,
  AdminUserQueryDto,
} from '../billing/dto/billing.dto';
import {
  CreateAddonDto,
  CreatePackageDto,
  UpdateAddonDto,
  UpdatePackageDto,
  UpdatePlanDto,
} from '../billing/dto/catalog.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import { Role } from '../generated/prisma/enums';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';

/**
 * Admin panel API. Account management itself (role, activation, deletion)
 * lives on `/users/:id`; this controller adds billing, catalog and settings.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly billing: BillingAdminService,
    private readonly catalog: CatalogService,
    private readonly settings: SettingsService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: 'Dashboard numbers' })
  async stats() {
    const [users, billing] = await Promise.all([
      this.users.userStats(),
      this.billing.stats(),
    ]);
    return { users, ...billing };
  }

  // --- users -----------------------------------------------------------------

  @Get('users')
  @ApiOperation({ summary: 'Search users with their plan and token balance' })
  async listUsers(@Query() query: AdminUserQueryDto) {
    const { items, total } = await this.users.search(
      query.search,
      query.skip,
      query.take,
    );
    const summaries = await this.billing.summaries(
      items.map((user) => user.id),
    );
    const rows = items.map((user) => {
      const summary = summaries.get(user.id);
      return {
        user,
        subscription: subscriptionView(summary?.subscription ?? null),
        balance: summary?.balance ?? 0,
      };
    });
    return new PaginatedResultDto(rows, total, query.skip, query.take);
  }

  @Get('users/:id/billing')
  @ApiOperation({ summary: 'Full billing detail of one user' })
  async userBilling(@Param('id', ParseUUIDPipe) id: string) {
    const user = await this.users.findOne(id);
    const detail = await this.billing.detail(id);
    return {
      user,
      subscription: subscriptionView(detail.subscription),
      balance: detail.balance,
      batches: detail.batches.map(batchView),
      ledger: detail.ledger.map(ledgerView),
      events: detail.events.map(eventView),
    };
  }

  @Post('users/:id/tokens')
  @ApiOperation({ summary: 'Grant bonus tokens' })
  async grantTokens(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminGrantTokensDto,
  ) {
    await this.users.findOne(id);
    return this.billing.grantTokens(actorId, id, dto);
  }

  @Post('users/:id/tokens/deduct')
  @ApiOperation({
    summary: 'Remove tokens (402 INSUFFICIENT_TOKENS if the balance is lower)',
  })
  async deductTokens(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminDeductTokensDto,
  ) {
    await this.users.findOne(id);
    return this.billing.deductTokens(actorId, id, dto);
  }

  @Post('users/:id/plan')
  @ApiOperation({
    summary: 'Assign a plan manually (no Stripe), e.g. enterprise',
  })
  async assignPlan(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminAssignPlanDto,
  ) {
    await this.users.findOne(id);
    return subscriptionView(await this.billing.assignPlan(actorId, id, dto));
  }

  @Patch('token-batches/:id')
  @ApiOperation({ summary: 'Change when a token batch expires (null = never)' })
  async updateBatch(
    @CurrentUser('id') actorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminBatchExpiryDto,
  ) {
    return batchView(await this.billing.updateBatchExpiry(actorId, id, dto));
  }

  // --- catalog -------------------------------------------------------------

  @Get('plans')
  @ApiOperation({
    summary: 'All plans and packages, including inactive and Stripe price ids',
  })
  async plans() {
    return (await this.catalog.listPlans(true)).map((plan) =>
      planView(plan, true),
    );
  }

  @Patch('plans/:id')
  async updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return planView(await this.catalog.updatePlan(id, dto), true);
  }

  @Post('packages')
  async createPackage(@Body() dto: CreatePackageDto) {
    return packageView(await this.catalog.createPackage(dto), true);
  }

  @Patch('packages/:id')
  async updatePackage(@Param('id') id: string, @Body() dto: UpdatePackageDto) {
    return packageView(await this.catalog.updatePackage(id, dto), true);
  }

  @Get('addons')
  async addons() {
    return (await this.catalog.listAddons(true)).map((addon) =>
      addonView(addon, true),
    );
  }

  @Post('addons')
  async createAddon(@Body() dto: CreateAddonDto) {
    return addonView(await this.catalog.createAddon(dto), true);
  }

  @Patch('addons/:id')
  async updateAddon(@Param('id') id: string, @Body() dto: UpdateAddonDto) {
    return addonView(await this.catalog.updateAddon(id, dto), true);
  }

  // --- settings ------------------------------------------------------------

  @Get('settings')
  @ApiOperation({ summary: 'All runtime settings with their current values' })
  listSettings() {
    return this.settings.list();
  }

  @Put('settings/:key')
  @ApiOperation({
    summary: 'Replace one setting',
    description:
      'Keys: signup_bonus, token_expiry, addon_pricing, model_config. The body is validated against the key’s schema.',
  })
  @ApiBody({ schema: { type: 'object' } })
  updateSetting(
    @CurrentUser('id') actorId: string,
    @Param('key') key: string,
    @Body() value: unknown,
  ) {
    return this.settings.update(key, value, actorId);
  }
}
