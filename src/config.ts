import { constants } from "starknet";

/** App-level configuration. Mainnet only (per project scope). */

export const DAPP_NAME = "Starknet Wallet Migrator";

export const CHAIN_ID = constants.StarknetChainId.SN_MAIN;
export const CHAIN_LABEL = "Starknet Mainnet";

/**
 * Default public RPC endpoint (CORS-open, no key). Users can override it in
 * Settings. starknet.js 8.x speaks JSON-RPC 0.8, hence the `/v0_8` suffix.
 */
export const DEFAULT_RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";

export const RPC_ALTERNATIVES = [
  "https://api.cartridge.gg/x/starknet/mainnet",
  "https://free-rpc.nethermind.io/mainnet-juno/v0_8",
  "https://starknet-mainnet.public.blastapi.io/rpc/v0_8",
];

/**
 * Token-discovery proxy (Cloudflare Worker — see /worker). Starkscan's Agent API
 * 403s browser requests and its keys are server-side only, so a small Worker
 * holds the key and proxies `token-holdings`. The frontend calls THIS URL; no
 * Starkscan key ever lives in the browser. Set `VITE_PROXY_URL` at build time
 * (repo variable PROXY_URL) or paste the URL in Settings at runtime.
 *
 * NFT auto-discovery is not offered by Starkscan, so NFTs are added manually
 * (verified on-chain via `ownerOf`); an optional custom NFT holdings URL lets
 * you wire another provider.
 */
export const DEFAULT_PROXY_URL = import.meta.env.VITE_PROXY_URL ?? "";

/** Block explorer for linking out to transactions. */
export const EXPLORER_TX = (hash: string) => `https://starkscan.co/tx/${hash}`;
export const EXPLORER_CONTRACT = (addr: string) => `https://starkscan.co/contract/${addr}`;

/** Max calls per multicall transaction. Large migrations are chunked. */
export const MAX_CALLS_PER_TX = 40;

/** localStorage keys (v3 — token discovery moved to the Worker proxy). */
export const LS = {
  proxyUrl: "swm.proxyUrl.v3",
  nftUrlTemplate: "swm.nftUrl.v3",
  rpcUrl: "swm.rpc.url",
} as const;
