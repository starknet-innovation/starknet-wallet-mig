# snf-wallet-proxy (Cloudflare Worker)

Server-side proxy for Starkscan token and NFT discovery. The frontend calls this Worker;
the Worker holds the Starkscan API key as a secret and calls Starkscan
server-to-server (avoiding the 403 that Starkscan returns to browser requests).

## Why it's needed

- Starkscan's Agent API returns **403** to any request carrying an `Origin`
  header (i.e. every browser fetch). Verified directly against the API.
- `mzk_live_*` keys are **server-side credentials** — they must never be shipped
  in a public frontend bundle.

So token auto-detection from a static site requires a tiny server in front. This
Worker is that server.

## Deploy

```bash
cd worker
npx wrangler login                       # one-time, opens browser
npx wrangler secret put STARKSCAN_API_KEY   # paste a FRESHLY ROTATED key
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://snf-wallet-proxy.<your-subdomain>.workers.dev`.

Then tell the frontend about it, either:
- at build time: set repo **variable** `PROXY_URL` to that URL (the deploy
  workflow passes it as `VITE_PROXY_URL`), or
- at runtime: paste it into the app's **Settings → Token-discovery proxy URL**.

## Configure allowed origins

Edit `ALLOWED_ORIGINS` in `wrangler.toml` (comma-separated) to match where the
frontend is served, then redeploy. Browser requests from other origins are
rejected, protecting the key's request quota.

## Endpoint

```
GET /token-holdings?address=0x...&chain=SN_MAIN
-> { "items": [ { normalizedTokenAddress, indexedBalanceRaw, symbol, name, decimals }, ... ] }
GET /nft-holdings?address=0x...&chain=SN_MAIN
-> { "items": [ { tokenAddress, tokenId, standard, ... }, ... ] }
GET /health -> { "ok": true }
```

The NFT route combines address-scoped transfers with targeted legacy collection
events. The frontend uses those indexed results only as *candidate lists*: it
re-reads live token balances, ERC-721 owners, and ERC-1155 balances on-chain, so
stale indexer data cannot create or inflate a transfer.
