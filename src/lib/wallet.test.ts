import { constants } from "starknet";
import { describe, expect, it } from "vitest";
import { parseChainId } from "./wallet";

const MAIN = BigInt(constants.StarknetChainId.SN_MAIN);

describe("parseChainId", () => {
  it("accepts hex, decimal, number and bigint", () => {
    expect(parseChainId(constants.StarknetChainId.SN_MAIN)).toBe(MAIN);
    expect(parseChainId(MAIN.toString())).toBe(MAIN);
    expect(parseChainId(MAIN)).toBe(MAIN);
    expect(parseChainId(1)).toBe(1n);
  });
  it("accepts plain chain names", () => {
    expect(parseChainId("SN_MAIN")).toBe(MAIN);
    expect(parseChainId("SN_SEPOLIA")).toBe(BigInt(constants.StarknetChainId.SN_SEPOLIA));
  });
  it("rejects empty or non-string values", () => {
    expect(parseChainId(undefined)).toBeUndefined();
    expect(parseChainId("")).toBeUndefined();
    expect(parseChainId({})).toBeUndefined();
  });
});
