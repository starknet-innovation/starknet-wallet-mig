import { describe, expect, it } from "vitest";
import { addressKey, addressesEqual, formatUnits, normalizeAddress, parseUnits } from "./format";

describe("format units", () => {
  it("formats whole numbers", () => {
    expect(formatUnits(123n, 0)).toBe("123");
    expect(formatUnits(0n, 18)).toBe("0");
  });

  it("formats with decimals and strips trailing zeros", () => {
    expect(formatUnits(1234500000000000000n, 18)).toBe("1.2345");
    expect(formatUnits(1000000000000000000n, 18)).toBe("1");
  });

  it("handles negative", () => {
    expect(formatUnits(-500n, 2)).toBe("-5");
    expect(formatUnits(-1234n, 3)).toBe("-1.234");
  });
});

describe("parse units", () => {
  it("parses simple amounts", () => {
    expect(parseUnits("1", 18)).toBe(1000000000000000000n);
    expect(parseUnits("0.5", 6)).toBe(500000n);
  });

  it("rejects too many decimals", () => {
    expect(() => parseUnits("0.1234", 3)).toThrow(/too many decimals/i);
  });

  it("rejects invalid", () => {
    expect(() => parseUnits("abc", 18)).toThrow(/invalid amount/i);
    expect(() => parseUnits(".", 18)).toThrow();
  });
});

describe("address utils", () => {
  const a = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
  const aPadded = `0x${"0".repeat(10)}${a.slice(2)}`;

  it("normalizes and compares equal tolerant of padding", () => {
    expect(normalizeAddress(a)).toBeTruthy();
    expect(addressesEqual(a, aPadded)).toBe(true);
  });

  it("produces stable numeric keys", () => {
    expect(addressKey(a)).toBe(addressKey(aPadded));
    expect(addressKey("0xABC")).toMatch(/^\d+$/);
  });

  it("returns null for bad address", () => {
    expect(normalizeAddress("not-an-address")).toBeNull();
  });
});
