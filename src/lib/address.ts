import { validateAndParseAddress } from "starknet";

/**
 * Validate + normalize a Starknet address to a 0x-prefixed, zero-padded felt.
 * Returns null when invalid (instead of throwing) for use in form validation.
 */
export function normalizeAddress(addr: string): string | null {
  try {
    return validateAndParseAddress(addr.trim());
  } catch {
    return null;
  }
}

/** Compare two addresses by numeric value (tolerant of padding/casing). */
export function addressesEqual(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

/**
 * Stable string key for an address suitable for Map keys or de-duping.
 * Uses the numeric (BigInt) representation when possible, else lowercased.
 */
export function addressKey(addr: string): string {
  try {
    return BigInt(addr).toString();
  } catch {
    return addr.toLowerCase();
  }
}
