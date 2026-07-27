import { DEFAULT_PROXY_URL, LS } from "../config";

export interface DiscoveryConfig {
  /** Base URL of the token-discovery Worker (Cloudflare). Blank = keyless mode. */
  proxyUrl: string;
  /**
   * Optional override for NFT-by-owner discovery.
   * Use `{address}` as a placeholder. Blank → use the configured Worker.
   */
  nftUrlTemplate: string;
}

export function getIndexerConfig(): DiscoveryConfig {
  return {
    proxyUrl: localStorage.getItem(LS.proxyUrl) || DEFAULT_PROXY_URL,
    nftUrlTemplate: localStorage.getItem(LS.nftUrlTemplate) || "",
  };
}

export function setIndexerConfig(cfg: Partial<DiscoveryConfig>) {
  if (cfg.proxyUrl !== undefined) localStorage.setItem(LS.proxyUrl, cfg.proxyUrl.trim());
  if (cfg.nftUrlTemplate !== undefined)
    localStorage.setItem(LS.nftUrlTemplate, cfg.nftUrlTemplate.trim());
}

export function hasProxy(): boolean {
  return getIndexerConfig().proxyUrl.length > 0;
}
