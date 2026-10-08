import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

/**
 * Argon2id parameters following the OWASP Password Storage Cheat Sheet
 * (m=19 MiB, t=2, p=1). Argon2id resists GPU and side-channel attacks.
 */
const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * The single place passwords are hashed and verified.
 */
@Injectable()
export class PasswordHasher {
  private readonly logger = new Logger(PasswordHasher.name);

  /**
   * Digest of a random throwaway value, verified when there is no real hash to
   * check (unknown email, OAuth-only account) so every failure costs the same
   * CPU time and response timing does not reveal which emails exist.
   */
  private decoyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /**
   * Verifies `password` against `hash`. A null hash still burns a full Argon2
   * verification against the decoy and returns false.
   */
  async verify(hash: string | null, password: string): Promise<boolean> {
    if (!hash) {
      await argon2
        .verify(await this.getDecoyHash(), password)
        .catch(() => false);
      return false;
    }
    try {
      return await argon2.verify(hash, password);
    } catch (error) {
      // A malformed stored digest is a data problem, not a wrong password.
      this.logger.error(
        `Password digest could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** Spend the same time as a real verification without a real hash. */
  async burn(password: string): Promise<void> {
    await this.verify(null, password);
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  }

  private getDecoyHash(): Promise<string> {
    this.decoyHash ??= this.hash(randomBytes(32).toString('hex'));
    return this.decoyHash;
  }
}
