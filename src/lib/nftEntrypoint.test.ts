import { describe, expect, it } from "vitest";
import { defaultNftTransferEntrypoint, nftTransferEntrypointFromAbi } from "./nftEntrypoint";

describe("NFT transfer entrypoint selection", () => {
  it("finds snake_case functions nested in Cairo interfaces", () => {
    const abi = [
      {
        type: "interface",
        name: "openzeppelin::token::erc721::interface::IERC721",
        items: [
          { type: "function", name: "owner_of", inputs: [], outputs: [] },
          { type: "function", name: "transfer_from", inputs: [], outputs: [] },
        ],
      },
    ];

    expect(nftTransferEntrypointFromAbi(abi, "erc721")).toBe("transfer_from");
  });

  it("supports legacy camelCase-only collections", () => {
    const abi = [{ type: "function", name: "safeTransferFrom", inputs: [], outputs: [] }];

    expect(nftTransferEntrypointFromAbi(abi, "erc1155")).toBe("safeTransferFrom");
  });

  it("does not mistake event fields for callable functions", () => {
    const abi = [
      {
        type: "event",
        name: "Transfer",
        members: [{ name: "transfer_from", type: "felt252" }],
      },
    ];

    expect(nftTransferEntrypointFromAbi(abi, "erc721")).toBeUndefined();
  });

  it("defaults to canonical Cairo entrypoints when an ABI is unavailable", () => {
    expect(defaultNftTransferEntrypoint("erc721")).toBe("transfer_from");
    expect(defaultNftTransferEntrypoint("erc1155")).toBe("safe_transfer_from");
  });
});
