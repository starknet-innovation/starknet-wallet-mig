import { describe, expect, it } from "vitest";
import { tokenUsdValue } from "./prices";

describe("tokenUsdValue", () => {
  it("calculates the USD value of a token balance", () => {
    expect(tokenUsdValue(500_000n, 6, 1.5)).toBe(0.75);
  });

  it("returns undefined when the token has no price", () => {
    expect(tokenUsdValue(500_000n, 6, undefined)).toBeUndefined();
  });
});
