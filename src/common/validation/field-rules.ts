import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Minimum password length. Long-but-simple beats short-but-complex (NIST
 * 800-63B), so length is enforced strictly and composition rules stay light.
 */
export const PASSWORD_MIN_LENGTH = 10;

/**
 * Upper bound: the raw value travels through validation and Argon2, so very
 * large inputs are a denial-of-service vector.
 */
export const PASSWORD_MAX_LENGTH = 128;

const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Valid email, at most 255 chars, normalised to trimmed lower case. */
export const EmailField = () =>
  applyDecorators(
    Transform(trimLower),
    IsEmail({}, { message: 'email must be a valid email address' }),
    MaxLength(255),
  );

/** Password policy for any newly chosen password. */
export const NewPasswordField = () =>
  applyDecorators(
    IsString(),
    MinLength(PASSWORD_MIN_LENGTH, {
      message: `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    }),
    MaxLength(PASSWORD_MAX_LENGTH, {
      message: `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    }),
    Matches(/(?=.*\p{L})(?=.*\p{N})/u, {
      message: 'password must contain at least one letter and one number',
    }),
  );

/**
 * A password being checked, not chosen. No composition rules (it may predate
 * the current policy) but still bounded.
 */
export const ExistingPasswordField = () =>
  applyDecorators(IsString(), IsNotEmpty(), MaxLength(PASSWORD_MAX_LENGTH));

/** Display name: trimmed, at most 120 chars. */
export const NameField = () =>
  applyDecorators(Transform(trim), IsString(), MaxLength(120));

/** Opaque emailed token; real ones are 43 chars of base64url. */
export const EmailTokenField = () =>
  applyDecorators(
    IsString(),
    IsNotEmpty(),
    MaxLength(256),
    Matches(/^[A-Za-z0-9_-]+$/, {
      message: 'token is malformed',
    }),
  );
