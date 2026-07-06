import { CallData, type RpcProvider } from "starknet";
import { addressKey } from "./address";
import { chunk } from "./migrate";

/**
 * On-chain USD prices via Ekubo's Oracle (PriceFetcher contract). Quotes every
 * token against a USD stablecoin using a TWAP, in a single batched call.
 *
 * PriceFetcher.get_prices(quote, base_tokens: Span, period: u64, min_token: u128)
 *   -> Span<PriceResult>, where PriceResult is an enum:
 *      0 NotInitialized | 1 InsufficientLiquidity | 2 PeriodTooLong | 3 Price(u256)
 * The u256 is a 128.128 fixed-point price = quote-raw per base-raw. So:
 *   usd_per_whole_token = (x128 / 2^128) * 10^(baseDecimals - QUOTE_DECIMALS)
 *
 * IMPORTANT — quote token choice: Ekubo's oracle routes every pair through its
 * `oracle_token` (= EKUBO). So USD prices depend on the chosen stablecoin's
 * EKUBO oracle pool being fresh. The USDC/EKUBO oracle pool is STALE on mainnet
 * (it implied EKUBO ~$1.50 vs ~$0.48 real → inflated every price ~3.1x). The
 * USDT/EKUBO oracle pool is fresh, so we quote against USDT. Verified vs CEX
 * (2026-06-29): ETH/STRK/WBTC within ~0.6% of spot. (USDC->USDC returning
 * exactly 2^128 was a hardcoded early-return, NOT a real validation.)
 */
const PRICE_FETCHER = "0x04946fb4ad5237d97bbb1256eba2080c4fe1de156da6a7f83e3b4823bb6d7da1";
// USDT (6 decimals) — fresh EKUBO oracle leg, unlike USDC.
const QUOTE_TOKEN = "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8";
const QUOTE_DECIMALS = 6;
const TWAP_PERIOD = 300n; // seconds
const MIN_TOKEN = 0n; // accept any liquidity (display-only)
const TWO_128 = 2 ** 128;

// Known USD stablecoins → pinned to $1 (the oracle can't price these reliably:
// e.g. USDC's own EKUBO leg is stale, and a stable is $1 by definition here).
const STABLES = new Set(
  [
    "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8", // USDC
    "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8", // USDT
    "0x05574eb6b8789a91466f902c380d978e472db68170ff82a5b650b95a58ddf4ad", // DAI
  ].map((a) => BigInt(a).toString())
);

export interface PricedToken {
  address: string;
  decimals: number;
}

/**
 * Returns a map of `numericAddressKey -> USD price per whole token`. Tokens with
 * no oracle pool (or insufficient history) are simply omitted. Best-effort:
 * pricing failures never throw.
 */
export async function fetchUsdPrices(
  provider: RpcProvider,
  tokens: PricedToken[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tokens.length === 0) return out;

  // Pin known stablecoins to $1 (oracle is unreliable for them).
  const oraclePriced = tokens.filter((t) => {
    if (STABLES.has(addressKey(t.address))) {
      out.set(addressKey(t.address), 1);
      return false;
    }
    return true;
  });

  for (const group of chunk(oraclePriced, 40)) {
    try {
      const calldata = CallData.compile([
        QUOTE_TOKEN,
        group.map((t) => t.address),
        TWAP_PERIOD,
        MIN_TOKEN,
      ]);
      const res = await provider.callContract({
        contractAddress: PRICE_FETCHER,
        entrypoint: "get_prices",
        calldata,
      });
      decodeInto(res, group, out);
    } catch {
      /* pricing is best-effort */
    }
  }
  return out;
}

function decodeInto(res: string[], group: PricedToken[], out: Map<string, number>) {
  let i = 0;
  const n = Number(BigInt(res[i++] ?? "0"));
  for (let k = 0; k < n && k < group.length; k++) {
    const tag = Number(BigInt(res[i++] ?? "0"));
    if (tag === 3) {
      const low = BigInt(res[i++] ?? "0");
      const high = BigInt(res[i++] ?? "0");
      const x128 = low + (high << 128n);
      const t = group[k];
      const usd = (Number(x128) / TWO_128) * 10 ** (t.decimals - QUOTE_DECIMALS);
      if (Number.isFinite(usd) && usd > 0) out.set(addressKey(t.address), usd);
    }
    // variants 0/1/2 carry no extra felts — nothing to skip.
  }
}

export function priceKey(addr: string): string {
  return addressKey(addr);
}
