import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  RevocationReason,
  SessionsService,
} from '../auth/sessions/sessions.service';
import { PaginatedResultDto } from '../common/dto/paginated-result.dto';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AppError, ErrorCode } from '../common/errors/error-codes';
import { isUniqueViolation } from '../common/errors/prisma-errors';
import type { AppConfiguration } from '../config/configuration';
import type { Prisma, User } from '../generated/prisma/client';
import { Role } from '../generated/prisma/enums';
import type { CreateUserDto } from './dto/create-user.dto';
import type {
  DeleteAccountDto,
  UpdateProfileDto,
} from './dto/self-service.dto';
import type { UpdateUserDto } from './dto/update-user.dto';
import { UserEntity } from './entities/user.entity';
import { PasswordHasher } from './password-hasher.service';
import { type DbClient, UsersRepository } from './users.repository';

/**
 * Accounts without a password (Google-only) prove identity for destructive
 * self-service actions by having signed in recently instead.
 */
const RECENT_AUTH_WINDOW_MS = 15 * 60_000;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly sessionsService: SessionsService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  // --- lookups used by auth ----------------------------------------------

  /** Raw row (with `passwordHash`) for the auth layer. Never return it. */
  findRecordById(id: string): Promise<User | null> {
    return this.usersRepository.findById(id);
  }

  findRecordByEmail(email: string, db?: DbClient): Promise<User | null> {
    return this.usersRepository.findByEmail(
      UsersService.normaliseEmail(email),
      db,
    );
  }

  /** Inserts a user; a duplicate email surfaces as the raw Prisma P2002. */
  async insertRecord(
    data: Prisma.UserCreateInput,
    db?: DbClient,
  ): Promise<User> {
    const user = await this.usersRepository.create(
      { ...data, email: UsersService.normaliseEmail(data.email) },
      db,
    );
    this.logger.log(`Created user ${user.id}`);
    return user;
  }

  /**
   * Inserts a user. A duplicate email — including one created by a concurrent
   * request between any pre-check and this insert — becomes 409 EMAIL_TAKEN
   * via the unique index.
   */
  async insert(data: Prisma.UserCreateInput, db?: DbClient): Promise<User> {
    try {
      return await this.insertRecord(data, db);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppError.conflict(
          ErrorCode.EmailTaken,
          'An account with that email already exists',
        );
      }
      throw error;
    }
  }

  // --- admin ----------------------------------------------------------------

  async create(dto: CreateUserDto): Promise<UserEntity> {
    const user = await this.insert({
      email: dto.email,
      name: dto.name ?? null,
      role: dto.role ?? Role.USER,
      passwordHash: await this.passwordHasher.hash(dto.password),
    });
    return new UserEntity(user);
  }

  async findAll(
    query: PaginationQueryDto,
  ): Promise<PaginatedResultDto<UserEntity>> {
    const { items, total } = await this.usersRepository.paginate(
      query.skip,
      query.take,
    );
    return new PaginatedResultDto(
      items.map((user) => new UserEntity(user)),
      total,
      query.skip,
      query.take,
    );
  }

  async search(
    term: string | undefined,
    skip: number,
    take: number,
  ): Promise<{ items: UserEntity[]; total: number }> {
    const { items, total } = await this.usersRepository.search(
      term || undefined,
      skip,
      take,
    );
    return { items: items.map((user) => new UserEntity(user)), total };
  }

  userStats(): Promise<{
    total: number;
    active: number;
    verified: number;
    newLast30Days: number;
  }> {
    return this.usersRepository.countAll();
  }

  async findOne(id: string): Promise<UserEntity> {
    return new UserEntity(await this.findOrFail(id));
  }

  /**
   * Admin update. Guards against an admin locking themselves out and against
   * leaving the system with no active admin; deactivation and role changes
   * revoke the target's sessions in the same transaction.
   */
  async update(
    actorId: string,
    id: string,
    dto: UpdateUserDto,
  ): Promise<UserEntity> {
    const email =
      dto.email !== undefined
        ? UsersService.normaliseEmail(dto.email)
        : undefined;

    try {
      const user = await this.usersRepository.transaction(async (tx) => {
        const adminIds = await this.usersRepository.lockActiveAdminIds(tx);
        const target = await this.findOrFail(id, tx);

        const deactivating = dto.isActive === false && target.isActive;
        const roleChanging = dto.role !== undefined && dto.role !== target.role;
        const losesAdmin =
          target.role === Role.ADMIN &&
          target.isActive &&
          (deactivating || (roleChanging && dto.role !== Role.ADMIN));

        if (actorId === id && (deactivating || roleChanging)) {
          throw AppError.conflict(
            ErrorCode.SelfModification,
            'You cannot change your own role or deactivate your own account',
          );
        }
        if (losesAdmin && adminIds.length <= 1) {
          throw AppError.conflict(
            ErrorCode.LastAdmin,
            'At least one active admin must remain',
          );
        }

        const emailChanging = email !== undefined && email !== target.email;
        if (emailChanging) {
          const clash = await this.usersRepository.findByEmail(email, tx);
          if (clash) {
            throw AppError.conflict(
              ErrorCode.EmailTaken,
              'An account with that email already exists',
            );
          }
          await this.usersRepository.invalidateEmailTokens(id, tx);
        }

        const updated = await this.usersRepository.update(
          id,
          {
            ...(emailChanging ? { email, emailVerifiedAt: null } : {}),
            ...(dto.name !== undefined ? { name: dto.name || null } : {}),
            ...(dto.role !== undefined ? { role: dto.role } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
          tx,
        );

        if (deactivating) {
          await this.sessionsService.revokeAllForUser(
            id,
            RevocationReason.AdminDeactivated,
            tx,
          );
        } else if (roleChanging) {
          // Access tokens carry the role; force a fresh login so no token
          // with the old role survives.
          await this.sessionsService.revokeAllForUser(
            id,
            RevocationReason.RoleChanged,
            tx,
          );
        }
        return updated;
      });
      return new UserEntity(user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppError.conflict(
          ErrorCode.EmailTaken,
          'An account with that email already exists',
        );
      }
      throw error;
    }
  }

  async remove(actorId: string, id: string): Promise<void> {
    if (actorId === id) {
      throw AppError.conflict(
        ErrorCode.SelfModification,
        'Use DELETE /users/me to delete your own account',
      );
    }
    await this.usersRepository.transaction(async (tx) => {
      const adminIds = await this.usersRepository.lockActiveAdminIds(tx);
      const target = await this.findOrFail(id, tx);
      if (
        target.role === Role.ADMIN &&
        target.isActive &&
        adminIds.length <= 1
      ) {
        throw AppError.conflict(
          ErrorCode.LastAdmin,
          'At least one active admin must remain',
        );
      }
      await this.assertNotBilledByStripe(id, tx);
      // Sessions, tokens and OAuth links cascade; documents are detached.
      await this.usersRepository.delete(id, tx);
    });
    this.logger.log(`User ${id} deleted by admin ${actorId}`);
  }

  // --- self-service ------------------------------------------------------

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserEntity> {
    await this.findOrFail(userId);
    const user = await this.usersRepository.update(userId, {
      ...(dto.name !== undefined ? { name: dto.name || null } : {}),
      ...(dto.avatarUrl !== undefined
        ? { avatarUrl: dto.avatarUrl || null }
        : {}),
    });
    return new UserEntity(user);
  }

  /**
   * Permanently deletes the caller's account. Password accounts must confirm
   * the password; passwordless (Google) accounts must have signed in within
   * the last 15 minutes.
   */
  async deleteSelf(
    userId: string,
    sessionId: string,
    dto: DeleteAccountDto,
  ): Promise<void> {
    const user = await this.findOrFail(userId);

    if (user.passwordHash) {
      const ok = dto.password
        ? await this.passwordHasher.verify(user.passwordHash, dto.password)
        : false;
      if (!ok) {
        throw AppError.unauthorized(
          ErrorCode.InvalidCredentials,
          'Password is incorrect',
        );
      }
    } else {
      const session = await this.sessionsService.findById(sessionId);
      const recent =
        session !== null &&
        Date.now() - session.authenticatedAt.getTime() <= RECENT_AUTH_WINDOW_MS;
      if (!recent) {
        throw AppError.unauthorized(
          ErrorCode.ReauthRequired,
          'Sign in again to confirm deleting your account',
        );
      }
    }

    await this.usersRepository.transaction(async (tx) => {
      const adminIds = await this.usersRepository.lockActiveAdminIds(tx);
      if (
        user.role === Role.ADMIN &&
        adminIds.includes(userId) &&
        adminIds.length <= 1
      ) {
        throw AppError.conflict(
          ErrorCode.LastAdmin,
          'At least one active admin must remain',
        );
      }
      await this.assertNotBilledByStripe(userId, tx);
      await this.usersRepository.delete(userId, tx);
    });
    this.logger.log(`User ${userId} deleted their account`);
  }

  // --- credential changes (called by auth inside its transactions) --------

  transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.usersRepository.transaction(work);
  }

  /**
   * Stores a new password digest and clears any lockout. `markEmailVerified`
   * is used by password reset: following the emailed link proves inbox access.
   */
  async applyNewPassword(
    userId: string,
    passwordHash: string,
    options: { markEmailVerified: boolean },
    db?: DbClient,
  ): Promise<User> {
    const user = await this.usersRepository.update(
      userId,
      {
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
      db,
    );
    if (options.markEmailVerified) {
      await this.usersRepository.markEmailVerified(userId, db);
    }
    return user;
  }

  markEmailVerified(userId: string, db?: DbClient): Promise<void> {
    return this.usersRepository.markEmailVerified(userId, db);
  }

  /** Low-level update for the auth layer (e.g. Google account linking). */
  updateRecord(
    userId: string,
    data: Prisma.UserUpdateInput,
    db?: DbClient,
  ): Promise<User> {
    return this.usersRepository.update(userId, data, db);
  }

  // --- login bookkeeping ---------------------------------------------------

  recordSuccessfulLogin(id: string): Promise<User> {
    return this.usersRepository.recordSuccessfulLogin(id);
  }

  /**
   * Counts a failed password attempt and locks the account once the threshold
   * is reached. Returns whether this attempt triggered the lock.
   */
  async recordFailedLogin(id: string): Promise<boolean> {
    const auth = this.config.get('auth', { infer: true });
    const attempts = await this.usersRepository.incrementFailedLogins(id);
    if (attempts < auth.lockoutThreshold) return false;

    const locked = await this.usersRepository.lockIfThresholdReached(
      id,
      auth.lockoutThreshold,
      new Date(Date.now() + auth.lockoutDurationMs),
    );
    if (locked) {
      this.logger.warn(
        `User ${id} locked after ${auth.lockoutThreshold} failed logins`,
      );
    }
    return locked;
  }

  /** Transparent upgrade of a digest made with weaker parameters. */
  async rehashIfNeeded(user: User, password: string): Promise<void> {
    if (
      !user.passwordHash ||
      !this.passwordHasher.needsRehash(user.passwordHash)
    )
      return;
    try {
      await this.usersRepository.update(user.id, {
        passwordHash: await this.passwordHasher.hash(password),
      });
    } catch (error) {
      // A failed upgrade must not fail the login.
      this.logger.warn(
        `Could not rehash password for user ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Deleting the row would not stop Stripe from charging the card, so the
   * subscription must be set to cancel (or have ended) first.
   */
  private async assertNotBilledByStripe(
    userId: string,
    db: DbClient,
  ): Promise<void> {
    if (await this.usersRepository.hasRenewingPaidSubscription(userId, db)) {
      throw AppError.conflict(
        ErrorCode.ActiveSubscription,
        'Cancel the paid subscription before deleting the account',
      );
    }
  }

  private async findOrFail(id: string, db?: DbClient): Promise<User> {
    const user = await this.usersRepository.findById(id, db);
    if (!user)
      throw AppError.notFound(ErrorCode.UserNotFound, 'User not found');
    return user;
  }
}
