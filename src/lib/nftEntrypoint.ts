import type { NftAsset, NftTransferEntrypoint } from "./types";

const ENTRYPOINTS: Record<NftAsset["kind"], readonly NftTransferEntrypoint[]> = {
  erc721: ["transfer_from", "transferFrom"],
  erc1155: ["safe_transfer_from", "safeTransferFrom"],
};

export function defaultNftTransferEntrypoint(kind: NftAsset["kind"]): NftTransferEntrypoint {
  return ENTRYPOINTS[kind][0];
}

function collectAbiFunctionNames(abi: unknown, names: Set<string>): void {
  if (Array.isArray(abi)) {
    for (const entry of abi) collectAbiFunctionNames(entry, names);
    return;
  }
  if (!abi || typeof abi !== "object") return;

  const entry = abi as { type?: unknown; name?: unknown; items?: unknown };
  if (entry.type === "function" && typeof entry.name === "string") {
    names.add(entry.name);
  }
  if (entry.items) collectAbiFunctionNames(entry.items, names);
}

/**
 * Select the transfer function actually exposed by a collection's ABI.
 * Cairo 1 contracts normally use snake_case, while some older collections
 * expose camelCase aliases.
 */
export function nftTransferEntrypointFromAbi(
  abi: unknown,
  kind: NftAsset["kind"]
): NftTransferEntrypoint | undefined {
  const names = new Set<string>();
  collectAbiFunctionNames(abi, names);
  return ENTRYPOINTS[kind].find((entrypoint) => names.has(entrypoint));
}
