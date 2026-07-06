// Re-export address utilities from the canonical module for backward compat in this file's consumers.
export { addressKey, addressesEqual, normalizeAddress } from "./address";

/** Combine two u256 felts (low, high) into a single bigint. */
export function u256FromFelts(low: string | bigint, high: string | bigint): bigint {
  return BigInt(low) + (BigInt(high) << 128n);
}

/** Format a raw integer balance with `decimals` into a human string. */
export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const out = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return neg ? `-${out}` : out;
}

/** Parse a human decimal string into a raw integer given `decimals`. Throws on bad input. */
export function parseUnits(input: string, decimals: number): bigint {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") {
    throw new Error(`Invalid amount: "${input}"`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    throw new Error(`Too many decimals (max ${decimals})`);
  }
  const fracPadded = frac.padEnd(decimals, "0");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

/** Shorten an address for display: 0x1234…abcd */
export function shortenAddress(addr: string, lead = 6, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= lead + tail) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}
