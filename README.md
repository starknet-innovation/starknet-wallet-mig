# Starknet Wallet Migrator

A static web app to migrate **ERC-20 tokens** and **NFTs** from one Starknet
wallet to another, bundled into a single signed transaction (Starknet
multicall). Mainnet only.

> ⚠️ **Use carefully.** Transfers are irreversible. Always double-check the
> recipient address. This is a self-service tool — review everything before you
> sign. Nothing here is financial or security advice; verify on a small amount
> first.

## What it does

1. **Connect the sending wallet** via [starknetkit](https://github.com/argentlabs/starknetkit)
   (ArgentX / Ready, Braavos, web wallet, …). Your keys never leave your wallet —
   the app only ever asks your wallet to sign.
2. **Set the receiving wallet** by pasting its address, with an **optional
   ownership proof**: connect the receiver and sign a gas-free SNIP-12 message
   that is verified on-chain (`is_valid_signature`). Skip it for cold/hardware
   wallets you can't connect in the browser.
3. **Pick assets to migrate**:
   - **ERC-20** — with the token-discovery **Worker proxy** configured (see
     `/worker`), all fungible holdings are auto-detected: the Worker calls
     Starkscan server-side (holding the API key) and the app re-reads **live
     on-chain balances** for each token (so a stale indexer snapshot can never
     inflate a transfer). Without a proxy, the app falls back to a built-in
     token list (`src/lib/tokens.ts`) over public RPC — no key, no Worker.
   - **NFTs** — with the Worker proxy configured, indexed address activity is
     used to find candidate ERC-721 and ERC-1155 holdings. Every candidate is
     verified live on-chain (`ownerOf` for ERC-721; `balanceOf` for ERC-1155)
     before it can be selected. Without the Worker, the app falls back to a
     curated collection list (`src/lib/collections.ts`): it reads
     `balanceOf(owner)` per collection and resolves IDs through Enumerable,
     collection-specific, or compact sequential-ID views where available.
     Collections whose IDs cannot be resolved remain available for a manual,
     on-chain-verified add. A custom NFT-holdings URL in Settings can override
     the Worker with another indexer.
   - **NFT transfer compatibility** — the app reads each selected collection's
     deployed ABI and calls the transfer function it actually exposes. This
     supports both current Cairo `transfer_from` / `safe_transfer_from` and
     older camelCase `transferFrom` / `safeTransferFrom` collections.
   - **Add manually** anything not detected (by contract + token ID).
   - **USD prices** are read **on-chain** from Ekubo's Oracle (the `PriceFetcher`
     contract), quoted against USDC via a TWAP — shown per token and as a
     portfolio total. Tokens without an Ekubo oracle pool show no price. Prices
     are informational only; transfer amounts are always token-denominated.

> **Why a Worker?** Starkscan's Agent API returns `403` to any browser request
> and its `mzk_live_*` keys are server-side credentials. A static site therefore
> can't call it directly. The tiny Cloudflare Worker in `/worker` holds the key
> as a secret and proxies the call. See `worker/README.md` to deploy it, then set
> repo variable `PROXY_URL` (or paste the URL in Settings).
4. **Review & migrate** — all selected transfers are batched into one multicall
   (chunked into several transactions if there are many), with a fee estimate.
   For ETH/STRK the default keeps a small gas buffer so you can still pay fees.

What it does **not** do: unwind DeFi/staking/LP positions or vesting. Those
aren't simple transfers and must be handled in their own protocols first.

## Security model

- **No private keys, seed phrases, or signing material are ever handled by this
  app.** All signing happens inside your wallet extension.
- The receiving-wallet "proof" is a standard `signMessage` flow; the signature is
  verified against the account on-chain.
- The app contains no indexer API key. When the Worker is used, its Starkscan
  key is a Cloudflare secret and is never sent to the browser or bundled into
  the build.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs static site to dist/
npm run preview  # serve the production build
```

## Configuration (in-app Settings ⚙)

- **RPC URL** — defaults to a public, CORS-open mainnet endpoint. Override with
  your own provider if you hit rate limits.
- **Token-discovery proxy URL** — the deployed Cloudflare Worker (`/worker`).
  Holds the Starkscan key server-side; the browser never sees it. Blank → the
  built-in token list is used instead.
- **Custom NFT holdings URL** (optional) — overrides Worker-based NFT discovery
  with another provider. Use `{address}` as the wallet-address placeholder;
  every returned holding is still verified live on-chain.

> Note: Starknet has no on-chain "list my assets" call. The Worker provides
> indexer-backed discovery for all ERC-20 holdings and NFT candidates, while
> the no-Worker fallback checks only the built-in token and curated NFT
> collection lists. Anything outside those sources can still be added manually
> and is verified on-chain.

## Deploy to GitHub Pages

This repo includes `.github/workflows/deploy.yml`, which builds and deploys on
every push to `main`.

1. Push this project to a GitHub repository.
2. In the repo, go to **Settings → Pages → Build and deployment → Source:
   GitHub Actions**.
3. Push to `main` (or run the workflow manually). The site deploys to
   `https://<user>.github.io/<repo>/`.

The Vite build uses `base: "./"` (relative asset paths), so it works at any
sub-path without extra configuration.

## Tech

React + Vite + TypeScript · [starknet.js](https://github.com/starknet-io/starknet.js)
`8.9.2` · starknetkit `3.4.3`.

## Adding tokens

Edit `src/lib/tokens.ts` — each entry is `{ address, symbol, name, decimals }`
(set `isGasToken: true` for fee tokens). The bundled list was verified on-chain;
balances for any listed token are read at scan time.
