/** Lower-case, as Node exposes incoming header names. */
export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Accepts an inbound request id only if it is short and free of characters
 * that could forge log lines; anything else is discarded and a new id minted.
 */
export function resolveRequestId(
  header: string | string[] | undefined,
): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return value && SAFE_REQUEST_ID.test(value) ? value : null;
}
