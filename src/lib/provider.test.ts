import { describe, expect, it } from "vitest";
import { RpcError, describeRpcError, isContractNotFound, isRpcTransportError } from "./provider";

describe("rpc error helpers", () => {
  it("detects contract-not-found", () => {
    expect(
      isContractNotFound(new Error("RPC: starknet_getClassHashAt ... 20: Contract not found"))
    ).toBe(true);
    expect(isContractNotFound({ baseError: { code: 20 } })).toBe(true);
    expect(isContractNotFound(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("classifies transport failures", () => {
    expect(isRpcTransportError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRpcTransportError(new Error("status: 503"))).toBe(true);
    expect(isRpcTransportError(new Error("Request failed with status code 401"))).toBe(true);
    expect(isRpcTransportError(new Error("HTTP 403 Forbidden"))).toBe(true);
    expect(isRpcTransportError(new Error("status code 500"))).toBe(true);
    expect(isRpcTransportError(new Error("Contract not found"))).toBe(false);
    expect(isRpcTransportError(new TypeError("signMessage is not a function"))).toBe(false);
    expect(isRpcTransportError(new RpcError(new TypeError("Failed to fetch"), "https://x"))).toBe(
      false
    );
  });

  it("names the endpoint in the message", () => {
    const msg = describeRpcError(new TypeError("Failed to fetch"), "https://rpc.example/v0_10");
    expect(msg).toContain("https://rpc.example/v0_10");
    expect(msg).toContain("Settings");
    const once = new RpcError(new TypeError("Failed to fetch"), "https://rpc.example/v0_10")
      .message;
    expect(once.match(/Settings/g)).toHaveLength(1);
  });
});
