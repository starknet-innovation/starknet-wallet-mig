import { type RpcProvider, cairo } from "starknet";
import { addressKey } from "./address";
import { MAINNET_NFT_COLLECTIONS, type NftCollectionInfo } from "./collections";
import { decodeCairoString } from "./decode";
import { addressesEqual, normalizeAddress, u256FromFelts } from "./format";
import { getIndexerConfig } from "./indexerConfig";
import { MAINNET_TOKENS } from "./tokens";
import type { Erc20Asset, NftAsset } from "./types";

/** Addresses that can pay fees (ETH, STRK), keyed by numeric value. */
const GAS_TOKEN_VALUES = new Set(
  MAINNET_TOKENS.filter((t) => t.isGasToken).map((t) => BigInt(t.address))
);
function isGasTokenAddress(addr: string): boolean {
  try {
    return GAS_TOKEN_VALUES.has(BigInt(addr));
  } catch {
    return false;
  }
}

/** Whether a contract (account) is deployed on-chain at `address`. */
export async function isDeployed(provider: RpcProvider, address: string): Promise<boolean> {
  try {
    const h = await provider.getClassHashAt(address);
    return !!h && BigInt(h) !== 0n;
  } catch {
    return false;
  }
}

/** Run async `fn` over `items` with a bounded concurrency. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const ret: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      ret[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return ret;
}

async function readBalance(provider: RpcProvider, token: string, owner: string): Promise<bigint> {
  let res: string[];
  try {
    res = await provider.callContract({
      contractAddress: token,
      entrypoint: "balanceOf",
      calldata: [owner],
    });
  } catch {
    res = await provider.callContract({
      contractAddress: token,
      entrypoint: "balance_of",
      calldata: [owner],
    });
  }
  return u256FromFelts(res[0] ?? "0", res[1] ?? "0");
}

export interface Erc20ScanResult {
  assets: Erc20Asset[];
  notice?: string;
}

/** A token to check: address plus whatever metadata we already know. */
interface Candidate {
  address: string;
  symbol?: string | null;
  name?: string | null;
  decimals?: number | null;
  isGasToken?: boolean;
}

/** Read `symbol`/`decimals` on-chain for tokens whose metadata is unknown. */
async function enrichMeta(
  provider: RpcProvider,
  addr: string
): Promise<{ symbol?: string; decimals?: number }> {
  const [symRes, decRes] = await Promise.all([
    provider
      .callContract({ contractAddress: addr, entrypoint: "symbol", calldata: [] })
      .catch(() => [] as string[]),
    provider
      .callContract({ contractAddress: addr, entrypoint: "decimals", calldata: [] })
      .catch(() => [] as string[]),
  ]);
  return {
    symbol: decodeCairoString(symRes) || undefined,
    decimals: decRes.length ? Number(BigInt(decRes[0])) : undefined,
  };
}

/**
 * For each candidate, read the LIVE on-chain balance (never trust an indexer
 * snapshot for amounts) and fill in any missing symbol/decimals. Keeps only
 * tokens with a positive balance.
 */
async function scanBalances(
  provider: RpcProvider,
  owner: string,
  candidates: Candidate[]
): Promise<Erc20Asset[]> {
  const results = await mapLimit(candidates, 8, async (c) => {
    try {
      const balance = await readBalance(provider, c.address, owner);
      if (balance <= 0n) return null;
      let symbol = c.symbol ?? undefined;
      let decimals = c.decimals ?? undefined;
      const name = c.name ?? undefined;
      if (symbol == null || decimals == null) {
        const meta = await enrichMeta(provider, c.address);
        symbol = symbol ?? meta.symbol;
        decimals = decimals ?? meta.decimals;
      }
      const addr = normalizeAddress(c.address) ?? c.address;
      const asset: Erc20Asset = {
        kind: "erc20",
        id: addr,
        address: addr,
        symbol: symbol || "TOKEN",
        name: name || symbol || "Token",
        decimals: decimals ?? 18,
        balance,
        isGasToken: c.isGasToken ?? isGasTokenAddress(addr),
        source: "list",
      };
      return asset;
    } catch {
      return null;
    }
  });
  return results.filter((r): r is Erc20Asset => r !== null);
}

/**
 * Discover ERC-20 holdings. With the Worker proxy configured, it lists every
 * token the address holds (via Starkscan) and re-reads live balances on-chain.
 * Without a proxy, it checks the built-in token list over RPC (keyless).
 */
export async function scanErc20(provider: RpcProvider, owner: string): Promise<Erc20ScanResult> {
  const cfg = getIndexerConfig();
  if (cfg.proxyUrl) {
    try {
      const assets = await scanErc20ViaProxy(provider, owner, cfg.proxyUrl);
      return { assets };
    } catch (e: any) {
      const fallback = await scanErc20ViaRpc(provider, owner);
      return {
        assets: fallback,
        notice: `Token-discovery proxy failed (${e?.message ?? "error"}). Showed the built-in token list instead — add anything missing manually.`,
      };
    }
  }
  const assets = await scanErc20ViaRpc(provider, owner);
  return {
    assets,
    notice:
      "No token-discovery proxy configured — checked the built-in token list only. Deploy the Cloudflare worker and set its URL in Settings to auto-detect every token, or add tokens manually.",
  };
}

/** Curated-list + RPC balance scan (keyless fallback). */
async function scanErc20ViaRpc(provider: RpcProvider, owner: string): Promise<Erc20Asset[]> {
  return scanBalances(
    provider,
    owner,
    MAINNET_TOKENS.map((t) => ({ ...t }))
  );
}

/**
 * Token discovery via the Worker proxy. The proxy returns Starkscan's
 * `token-holdings` items; we use them as the candidate set, merge in curated
 * metadata, then read live balances.
 */
async function scanErc20ViaProxy(
  provider: RpcProvider,
  owner: string,
  proxyUrl: string
): Promise<Erc20Asset[]> {
  const base = proxyUrl.replace(/\/+$/, "");
  const r = await fetch(`${base}/token-holdings?address=${owner}`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${body.slice(0, 140)}`);
  }
  const j: any = await r.json();
  const items: any[] = j.items ?? j.holdings ?? j.data ?? [];
  const curated = new Map(MAINNET_TOKENS.map((t) => [addressKey(t.address), t] as const));
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const it of items) {
    const raw = it.normalizedTokenAddress ?? it.tokenAddress ?? it.token ?? it.address;
    if (!raw) continue;
    const addr = normalizeAddress(raw) ?? raw;
    const key = addressKey(addr);
    if (seen.has(key)) continue;
    seen.add(key);
    const cur = curated.get(key);
    candidates.push({
      address: addr,
      symbol: it.symbol ?? cur?.symbol ?? null,
      name: it.name ?? cur?.name ?? null,
      decimals: it.decimals ?? cur?.decimals ?? null,
      isGasToken: cur?.isGasToken ?? isGasTokenAddress(addr),
    });
  }
  return scanBalances(provider, owner, candidates);
}

/** Manual ERC-20 lookup by contract address. Reads symbol/decimals/balance on-chain. */
export async function lookupErc20(
  provider: RpcProvider,
  address: string,
  owner: string
): Promise<Erc20Asset> {
  const addr = normalizeAddress(address);
  if (!addr) throw new Error("Invalid contract address.");
  const [symRes, decRes] = await Promise.all([
    provider
      .callContract({ contractAddress: addr, entrypoint: "symbol", calldata: [] })
      .catch(() => [] as string[]),
    provider
      .callContract({ contractAddress: addr, entrypoint: "decimals", calldata: [] })
      .catch(() => [] as string[]),
  ]);
  const balance = await readBalance(provider, addr, owner);
  const symbol = decodeCairoString(symRes) || "TOKEN";
  const decimals = decRes.length ? Number(BigInt(decRes[0])) : 18;
  return {
    kind: "erc20",
    id: addr,
    address: addr,
    symbol,
    name: symbol,
    decimals,
    balance,
    source: "manual",
  };
}

async function ownerOf(
  provider: RpcProvider,
  contract: string,
  tokenId: bigint
): Promise<string | null> {
  const u = cairo.uint256(tokenId);
  const calldata = [u.low.toString(), u.high.toString()];
  for (const entrypoint of ["ownerOf", "owner_of"]) {
    try {
      const res = await provider.callContract({
        contractAddress: contract,
        entrypoint,
        calldata,
      });
      if (res[0]) return res[0];
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Manual NFT add. Verifies ownership via `ownerOf` before returning. */
export async function lookupNft(
  provider: RpcProvider,
  contract: string,
  tokenIdInput: string,
  owner: string
): Promise<NftAsset> {
  const addr = normalizeAddress(contract);
  if (!addr) throw new Error("Invalid NFT contract address.");
  let tokenId: bigint;
  try {
    tokenId = BigInt(tokenIdInput.trim());
  } catch {
    throw new Error("Invalid token ID.");
  }
  const holder = await ownerOf(provider, addr, tokenId);
  if (!holder) {
    throw new Error(
      "Could not read ownerOf for this token — it may not be a standard ERC-721, or the ID is wrong."
    );
  }
  if (!addressesEqual(holder, owner)) {
    throw new Error("The connected wallet does not own this token.");
  }
  let collectionName: string | undefined;
  try {
    const r = await provider.callContract({
      contractAddress: addr,
      entrypoint: "name",
      calldata: [],
    });
    collectionName = decodeCairoString(r) || undefined;
  } catch {
    /* optional */
  }
  return {
    kind: "erc721",
    id: `${addr}:${tokenId.toString()}`,
    address: addr,
    tokenId,
    balance: 1n,
    collectionName,
    source: "manual",
  };
}

export interface HeldCollection {
  address: string;
  name: string;
  balance: number;
  /** true when balance exceeded the enumerate cap and not all IDs were read */
  truncated?: boolean;
}

export interface NftScanResult {
  assets: NftAsset[];
  /** Held collections whose token IDs could not be resolved automatically. */
  manualNeeded?: HeldCollection[];
  error?: string;
  notice?: string;
}

/** Max token IDs to enumerate per collection (avoids huge loops). */
const ENUMERATE_CAP = 50n;
/** Only scan compact sequential ID spaces; larger collections use indexed transfers. */
const SEQUENTIAL_SCAN_CAP = 1_000n;

/**
 * NFT discovery. Indexed candidates are always checked against live on-chain
 * ownership. Plain RPC over the curated collection list is the fallback.
 */
export async function scanNfts(provider: RpcProvider, owner: string): Promise<NftScanResult> {
  const cfg = getIndexerConfig();
  if (cfg.nftUrlTemplate) return scanNftsViaCustomUrl(provider, owner);
  if (cfg.proxyUrl) {
    try {
      const assets = await scanNftsViaProxy(provider, owner, cfg.proxyUrl);
      return { assets };
    } catch (error) {
      const fallback = await scanNftsViaRpc(provider, owner);
      const message = error instanceof Error ? error.message : "unknown error";
      return {
        ...fallback,
        notice:
          `NFT indexer failed (${message}). Used on-chain collection checks instead. ${fallback.notice ?? ""}`.trim(),
      };
    }
  }
  return scanNftsViaRpc(provider, owner);
}

function readU256(res: string[]): bigint {
  return u256FromFelts(res[0] ?? "0", res[1] ?? "0");
}

/** Read an owner's token IDs in an Enumerable collection; null if not enumerable. */
async function tryEnumerate(
  provider: RpcProvider,
  contract: string,
  owner: string,
  balance: bigint
): Promise<{ ids: bigint[]; truncated: boolean } | null> {
  const cap = balance > ENUMERATE_CAP ? ENUMERATE_CAP : balance;
  for (const entrypoint of ["token_of_owner_by_index", "tokenOfOwnerByIndex"]) {
    const ids: bigint[] = [];
    let ok = true;
    for (let i = 0n; i < cap; i++) {
      const idx = cairo.uint256(i);
      try {
        const res = await provider.callContract({
          contractAddress: contract,
          entrypoint,
          calldata: [owner, idx.low.toString(), idx.high.toString()],
        });
        ids.push(readU256(res));
      } catch {
        ok = false;
        break;
      }
    }
    if (ok) return { ids, truncated: balance > ENUMERATE_CAP };
  }
  return null;
}

async function readErc1155Balance(
  provider: RpcProvider,
  contract: string,
  owner: string,
  tokenId: bigint
): Promise<bigint> {
  const id = cairo.uint256(tokenId);
  const calldata = [owner, id.low.toString(), id.high.toString()];
  for (const entrypoint of ["balance_of", "balanceOf"]) {
    try {
      const res = await provider.callContract({ contractAddress: contract, entrypoint, calldata });
      return readU256(res);
    } catch {
      /* try next */
    }
  }
  return 0n;
}

function nftAsset(
  col: NftCollectionInfo,
  address: string,
  tokenId: bigint,
  balance = 1n
): NftAsset {
  return {
    kind: col.standard === "erc1155" ? "erc1155" : "erc721",
    id: `${address}:${tokenId.toString()}`,
    address,
    tokenId,
    balance,
    collectionName: col.name,
    source: "indexer",
  };
}

/** Try a collection-specific owner → token ID view, then verify it with ownerOf. */
async function tryOwnerToken(
  provider: RpcProvider,
  col: NftCollectionInfo,
  address: string,
  owner: string
): Promise<NftAsset[]> {
  if (!col.ownerTokenEntrypoint || col.standard === "erc1155") return [];
  try {
    const res = await provider.callContract({
      contractAddress: address,
      entrypoint: col.ownerTokenEntrypoint,
      calldata: [owner],
    });
    const tokenId = readU256(res);
    const holder = await ownerOf(provider, address, tokenId);
    return holder && addressesEqual(holder, owner) ? [nftAsset(col, address, tokenId)] : [];
  } catch {
    return [];
  }
}

/**
 * Resolve compact collections by checking their complete ID space. The count
 * views in the curated list are deliberately limited to small collections.
 */
async function trySequentialOwnership(
  provider: RpcProvider,
  col: NftCollectionInfo,
  address: string,
  owner: string
): Promise<{ assets: NftAsset[]; complete: boolean } | null> {
  if (!col.tokenCountEntrypoint) return null;
  try {
    const res = await provider.callContract({
      contractAddress: address,
      entrypoint: col.tokenCountEntrypoint,
      calldata: [],
    });
    const count = readU256(res);
    if (count > SEQUENTIAL_SCAN_CAP) return { assets: [], complete: false };

    // Include `count` itself so this works for both next-ID and total-minted views,
    // regardless of whether a collection starts numbering at zero or one.
    const ids = Array.from({ length: Number(count + 1n) }, (_, index) => BigInt(index));
    const found = await mapLimit(ids, 10, async (tokenId) => {
      if (col.standard === "erc1155") {
        const balance = await readErc1155Balance(provider, address, owner, tokenId);
        return balance > 0n ? nftAsset(col, address, tokenId, balance) : null;
      }
      const holder = await ownerOf(provider, address, tokenId);
      return holder && addressesEqual(holder, owner) ? nftAsset(col, address, tokenId) : null;
    });
    return {
      assets: found.filter((asset): asset is NftAsset => asset !== null),
      complete: true,
    };
  } catch {
    return null;
  }
}

async function scanNftsViaProxy(
  provider: RpcProvider,
  owner: string,
  proxyUrl: string
): Promise<NftAsset[]> {
  const base = proxyUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/nft-holdings?address=${owner}&chain=SN_MAIN`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${body.slice(0, 140)}`);
  }
  const payload: any = await response.json();
  if (payload.truncated) {
    throw new Error("indexed transfer history was truncated");
  }
  const items: any[] = payload.items ?? [];
  const curated = new Map(
    MAINNET_NFT_COLLECTIONS.map((collection) => [addressKey(collection.address), collection])
  );
  const candidates = new Map<
    string,
    { address: string; tokenId: bigint; standard: string; collection: NftCollectionInfo }
  >();
  for (const item of items) {
    const rawAddress = item.tokenAddress ?? item.contractAddress ?? item.contract_address;
    const rawTokenId = item.tokenId ?? item.token_id;
    if (!rawAddress || rawTokenId == null) continue;
    try {
      const address = normalizeAddress(rawAddress) ?? rawAddress;
      const tokenId = BigInt(rawTokenId);
      const indexedStandard = String(item.standard ?? item.token_standard ?? "").toLowerCase();
      const knownCollection = curated.get(addressKey(address));
      const isErc1155 = knownCollection?.standard === "erc1155" || indexedStandard.includes("1155");
      const isErc721 = indexedStandard.includes("721");
      if (!knownCollection && !isErc721 && !isErc1155) continue;
      const collection: NftCollectionInfo = knownCollection ?? {
        address,
        name: item.tokenName ?? item.tokenSymbol ?? `NFT ${address.slice(0, 8)}…`,
        standard: isErc1155 ? "erc1155" : "erc721",
      };
      candidates.set(`${address}:${tokenId}`, {
        address,
        tokenId,
        standard: indexedStandard || collection.standard || "erc721",
        collection,
      });
    } catch {
      /* ignore malformed indexed candidates */
    }
  }

  const verified = await mapLimit([...candidates.values()], 10, async (candidate) => {
    const isErc1155 =
      candidate.collection.standard === "erc1155" || candidate.standard.includes("1155");
    if (isErc1155) {
      const balance = await readErc1155Balance(
        provider,
        candidate.address,
        owner,
        candidate.tokenId
      );
      return balance > 0n
        ? nftAsset(
            { ...candidate.collection, standard: "erc1155" },
            candidate.address,
            candidate.tokenId,
            balance
          )
        : null;
    }
    const holder = await ownerOf(provider, candidate.address, candidate.tokenId);
    return holder && addressesEqual(holder, owner)
      ? nftAsset(candidate.collection, candidate.address, candidate.tokenId)
      : null;
  });
  const assets = new Map(
    verified
      .filter((asset): asset is NftAsset => asset !== null)
      .map((asset) => [asset.id, asset] as const)
  );

  // Some older ERC-1155 mints were not classified by transfer indexers. Curated
  // compact ERC-1155 collections can be checked exhaustively with a few live
  // balance reads, so merge those results into the verified indexed set.
  const compactErc1155 = MAINNET_NFT_COLLECTIONS.filter(
    (collection) => collection.standard === "erc1155" && collection.tokenCountEntrypoint
  );
  await mapLimit(compactErc1155, 4, async (collection) => {
    const address = normalizeAddress(collection.address) ?? collection.address;
    const sequential = await trySequentialOwnership(provider, collection, address, owner);
    for (const asset of sequential?.assets ?? []) assets.set(asset.id, asset);
  });

  return [...assets.values()];
}

/** Plain-RPC NFT scan with automatic ID resolution for curated collections. */
export async function scanNftsViaRpc(provider: RpcProvider, owner: string): Promise<NftScanResult> {
  const assets: NftAsset[] = [];
  const manualNeeded: HeldCollection[] = [];
  await mapLimit(MAINNET_NFT_COLLECTIONS, 6, async (col) => {
    const addr = normalizeAddress(col.address) ?? col.address;

    if (col.standard === "erc1155") {
      const sequential = await trySequentialOwnership(provider, col, addr, owner);
      if (sequential) assets.push(...sequential.assets);
      return;
    }

    let balance: bigint;
    try {
      // readBalance tries both balanceOf (camelCase) and balance_of (snake).
      balance = await readBalance(provider, col.address, owner);
    } catch {
      return; // not a standard ERC-721 / no balance_of
    }
    if (balance <= 0n) return;
    const enumerated = await tryEnumerate(provider, addr, owner, balance);
    if (enumerated && enumerated.ids.length > 0) {
      for (const tokenId of enumerated.ids) {
        assets.push({
          kind: "erc721",
          id: `${addr}:${tokenId.toString()}`,
          address: addr,
          tokenId,
          balance: 1n,
          collectionName: col.name,
          source: "indexer",
        });
      }
      if (enumerated.truncated) {
        manualNeeded.push({
          address: addr,
          name: col.name,
          balance: Number(balance),
          truncated: true,
        });
      }
    } else {
      const direct = await tryOwnerToken(provider, col, addr, owner);
      const sequential = await trySequentialOwnership(provider, col, addr, owner);
      const resolved = new Map<string, NftAsset>();
      for (const asset of [...direct, ...(sequential?.assets ?? [])]) {
        resolved.set(asset.id, asset);
      }
      assets.push(...resolved.values());
      if (BigInt(resolved.size) < balance) {
        manualNeeded.push({
          address: addr,
          name: col.name,
          balance: Number(balance - BigInt(resolved.size)),
        });
      }
    }
  });
  const notice = manualNeeded.some((m) => !m.truncated)
    ? "Automatic lookup could not resolve every NFT in one or more legacy collections. Resolved NFTs are selectable below; the manual form remains available for any missing legacy item."
    : undefined;
  return { assets, manualNeeded, notice };
}

async function scanNftsViaCustomUrl(provider: RpcProvider, owner: string): Promise<NftScanResult> {
  const cfg = getIndexerConfig();
  const url = cfg.nftUrlTemplate.replaceAll("{address}", owner);
  const headers: Record<string, string> = { accept: "application/json" };
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return {
        assets: [],
        error: `NFT indexer responded ${r.status}. ${body.slice(0, 160)}`,
      };
    }
    const j: any = await r.json();
    const items: any[] = j.data ?? j.items ?? j.results ?? j.holdings ?? j.nfts ?? [];
    const candidates = new Map<string, NftAsset>();
    for (const it of items) {
      const contract: string | undefined =
        it.tokenAddress ?? it.contract_address ?? it.contractAddress ?? it.contract?.address;
      const rawTokenId = it.token_id ?? it.tokenId ?? it.id;
      if (!contract || rawTokenId == null) continue;
      let tokenId: bigint;
      try {
        tokenId = BigInt(rawTokenId);
      } catch {
        continue;
      }
      let bal = 1n;
      try {
        if (it.balance != null) bal = BigInt(it.balance);
      } catch {
        bal = 1n;
      }
      if (bal <= 0n) continue;
      const typeStr = String(
        it.standard ?? it.contract?.type ?? it.token_standard ?? it.type ?? ""
      ).toLowerCase();
      const kind: "erc721" | "erc1155" = typeStr.includes("1155") ? "erc1155" : "erc721";
      const addr = normalizeAddress(contract) ?? contract;
      const asset: NftAsset = {
        kind,
        id: `${addr}:${tokenId.toString()}`,
        address: addr,
        tokenId,
        balance: bal,
        name: it.name ?? it.nft_metadata?.name ?? it.metadata?.name,
        collectionName: it.contract?.name ?? it.collection_name ?? it.collection?.name,
        imageUrl:
          it.image_url ?? it.image_medium_url ?? it.nft_metadata?.image ?? it.metadata?.image,
        source: "indexer",
      };
      candidates.set(asset.id, asset);
    }
    const verified = await mapLimit([...candidates.values()], 10, async (asset) => {
      if (asset.kind === "erc1155") {
        const balance = await readErc1155Balance(provider, asset.address, owner, asset.tokenId);
        return balance > 0n ? { ...asset, balance } : null;
      }
      const holder = await ownerOf(provider, asset.address, asset.tokenId);
      return holder && addressesEqual(holder, owner) ? { ...asset, balance: 1n } : null;
    });
    return { assets: verified.filter((asset): asset is NftAsset => asset !== null) };
  } catch (e: any) {
    return {
      assets: [],
      error: `NFT indexer request failed (network or CORS). ${e?.message ?? ""}`,
    };
  }
}
