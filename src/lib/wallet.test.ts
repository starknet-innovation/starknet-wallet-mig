import { constants } from "starknet";
import { describe, expect, it } from "vitest";
import { parseChainId, recordAccountRequests } from "./wallet";

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

describe("recordAccountRequests", () => {
  it("records accounts from wallet_requestAccounts and restores request", async () => {
    const original = async (call: { type: string }) =>
      call.type === "wallet_requestAccounts" ? ["0xabc"] : ["accounts"];
    const wallet: any = { id: "w", name: "W", request: original };
    const target = { starknet_w: wallet, other: {} } as any;
    const probe = recordAccountRequests(target);
    expect(wallet.request).not.toBe(original);
    await wallet.request({ type: "wallet_getPermissions" });
    await wallet.request({ type: "wallet_requestAccounts" });
    probe.restore();
    expect(wallet.request).toBe(original);
    expect(probe.attempts).toHaveLength(1);
    expect(probe.attempts[0].accounts).toEqual(["0xabc"]);
  });

  it("records a rejected request", async () => {
    const wallet: any = {
      id: "w",
      request: async () => {
        throw new Error("User rejected");
      },
    };
    const probe = recordAccountRequests({ starknet: wallet } as any);
    await expect(wallet.request({ type: "wallet_requestAccounts" })).rejects.toThrow();
    probe.restore();
    expect(probe.attempts[0].error).toBeInstanceOf(Error);
  });
});
