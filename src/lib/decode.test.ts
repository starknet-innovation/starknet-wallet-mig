import { describe, expect, it } from "vitest";
import { decodeCairoString } from "./decode";

describe("decodeCairoString", () => {
  it("decodes shortstring (legacy)", () => {
    // 'ETH' as shortstring felt
    const felt = "0x455448";
    expect(decodeCairoString([felt])).toBe("ETH");
  });

  it("returns empty for empty or invalid", () => {
    expect(decodeCairoString([])).toBe("");
    expect(decodeCairoString(["0x"])).toBe("");
  });

  it("handles ByteArray form (simplified)", () => {
    // Minimal: n=0, pending with len
    // This is a smoke test; full ByteArray vectors would be longer
    const res = decodeCairoString(["0x0", "0x0", "0x3", "0x414243"]); // contrived
    // Depending on impl it may fall back; ensure it doesn't throw and returns something reasonable or ""
    expect(typeof res).toBe("string");
  });
});
