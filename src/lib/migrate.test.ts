import { describe, expect, it } from "vitest";
import { buildCall, buildCalls, buildOwnershipChallenge, chunk, randomNonce } from "./migrate";
import type { Erc20Asset, NftAsset } from "./types";

const sampleErc20: Erc20Asset = {
  kind: "erc20",
  id: "0x1",
  address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  balance: 1000000000000000000n,
  isGasToken: true,
  source: "list",
};

const sampleNft: NftAsset = {
  kind: "erc721",
  id: "0xabc:1",
  address: "0x05dbdedc203e92749e2e746e2d40a768d966bd243df04a6b712e222bc040a9af",
  tokenId: 1n,
  balance: 1n,
  transferEntrypoint: "transfer_from",
  collectionName: "Starknet.id",
  source: "manual",
};

describe("buildCall / buildCalls", () => {
  it("builds erc20 transfer", () => {
    const call = buildCall({ asset: sampleErc20, amount: 123n }, "0xfrom", "0xto");
    expect(call.contractAddress).toBe(sampleErc20.address);
    expect(call.entrypoint).toBe("transfer");
    expect((call.calldata ?? []).length).toBeGreaterThan(0);
  });

  it("uses the resolved ERC-721 transfer entrypoint", () => {
    const call = buildCall({ asset: sampleNft, amount: 1n }, "0xfrom", "0xto");
    expect(call.entrypoint).toBe("transfer_from");
  });

  it("uses the resolved ERC-1155 transfer entrypoint", () => {
    const call = buildCall(
      {
        asset: {
          ...sampleNft,
          kind: "erc1155",
          transferEntrypoint: "safe_transfer_from",
        },
        amount: 2n,
      },
      "0xfrom",
      "0xto"
    );
    expect(call.entrypoint).toBe("safe_transfer_from");
  });

  it("batches via buildCalls", () => {
    const calls = buildCalls(
      [
        { asset: sampleErc20, amount: 1n },
        { asset: sampleNft, amount: 1n },
      ],
      "0xfrom",
      "0xto"
    );
    expect(calls).toHaveLength(2);
  });
});

describe("chunk", () => {
  it("splits arrays", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe("ownership challenge", () => {
  it("builds typed data and nonce is hex", () => {
    const nonce = randomNonce();
    expect(nonce.startsWith("0x")).toBe(true);
    const td = buildOwnershipChallenge({
      sender: "0xsender",
      receiver: "0xrecv",
      nonce,
    });
    expect(td.primaryType).toBe("Proof");
    expect(td.domain.name).toBeTruthy();
    expect((td.message as Record<string, unknown>).nonce).toBe(nonce);
  });
});
