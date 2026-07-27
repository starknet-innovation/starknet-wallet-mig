/**
 * Cloudflare Worker: Starkscan token and NFT discovery proxy.
 *
 * Why this exists: Starkscan's Agent API returns 403 to any browser request
 * (one that carries an `Origin` header), and `mzk_live_*` keys are server-side
 * credentials that must never ship in a public frontend. This Worker holds the
 * key as a secret, calls Starkscan server-to-server (no Origin → 200),
 * paginates, and returns the holdings to the browser with proper CORS.
 *
 * Setup:
 *   cd worker
 *   npx wrangler secret put STARKSCAN_API_KEY     # paste a freshly rotated key
 *   npx wrangler deploy
 *
 * Endpoint:
 *   GET /token-holdings?address=0x...&chain=SN_MAIN
 *   -> { "items": [ { normalizedTokenAddress, indexedBalanceRaw, symbol, name, decimals }, ... ] }
 *   GET /nft-holdings?address=0x...&chain=SN_MAIN
 *   -> { "items": [ { tokenAddress, tokenId, standard, ... }, ... ] }
 *
 * The frontend treats `items` as the *candidate* token list and re-reads live
 * balances on-chain, so a stale indexer snapshot can never inflate a transfer.
 */

const STARKSCAN_BASE = "https://api.starkscan.co";
const DEFAULT_ALLOWED_ORIGINS = ["https://starknet-innovation.github.io", "http://localhost:5173"];
const TRANSFER_SELECTOR = "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";
const TRANSFER_SINGLE_SELECTOR =
  "0x182d859c0807ba9db63baf8b9d9fdbfeb885d820be6e206b9dab626d995c433";
const LEGACY_NFT_COLLECTIONS = [
  {
    address: "0x05dbdedc203e92749e2e746e2d40a768d966bd243df04a6b712e222bc040a9af",
    name: "Starknet.id",
    standard: "erc721",
    layout: "keys",
  },
  {
    address: "0x076503062d78f4481be03c9145022d6a4a71ec0719aa07756f79a2384dc7ef16",
    name: "Starknet Quest",
    standard: "erc721",
    layout: "keys",
  },
  {
    address: "0x031075ef90ad626dc13fb97cdc7e04499ee5fa1007f2c4e1a9439b22fc3755b9",
    name: "Lil Duckies",
    standard: "erc1155",
    layout: "keys",
  },
  {
    address: "0x02c3d976495cd521f00f98e22ce6feb25b9e5b1724f6af3423c932d44d0fc152",
    name: "Ducks Everywhere",
    standard: "erc721",
    layout: "keys",
  },
  {
    address: "0x058e75fe127b94923d6efe51c56bca98bd82cd43c7fd2ea562019a3101c245f9",
    name: "Collection 0x058e…245f9",
    standard: "erc721",
    layout: "keys",
  },
  {
    address: "0x02acee8c430f62333cf0e0e7a94b2347b5513b4c25f699461dd8d7b23c072478",
    name: "EveraiDuo",
    standard: "erc721",
    layout: "keys",
  },
  {
    address: "0x058949fa2955b10b3a82521934e8b0505dc0b7ba929c3049622ae91d2c52e194",
    name: "Dungeon Ducks",
    standard: "erc721",
    layout: "keys",
  },
  {
    address: "0x04fa864a706e3403fd17ac8df307f22eafa21b778b73353abf69a622e47a2003",
    name: "Ducks Everywhere (DUCKS)",
    standard: "erc721",
    layout: "data",
  },
];

function sameFelt(left, right) {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

function u256(low, high) {
  try {
    return (BigInt(low || 0) + (BigInt(high || 0) << 128n)).toString();
  } catch {
    return null;
  }
}

async function fetchLegacyNftCandidates(collection, owner, chain, apiKey) {
  const candidates = [];
  let cursor = null;
  let guard = 0;
  do {
    guard++;
    const api = new URL(`${STARKSCAN_BASE}/v1/${chain}/contract/${collection.address}/events`);
    api.searchParams.set(
      "topic0",
      collection.standard === "erc1155" ? TRANSFER_SINGLE_SELECTOR : TRANSFER_SELECTOR
    );
    if (collection.standard === "erc1155") {
      api.searchParams.set("topic3", owner);
    } else if (collection.layout === "keys") {
      api.searchParams.set("topic2", owner);
    }
    api.searchParams.set("limit", "100");
    if (cursor) api.searchParams.set("cursor", cursor);
    const response = await fetch(api.toString(), {
      headers: {
        "X-Starkscan-Api-Key": apiKey,
        accept: "application/json",
      },
    });
    if (!response.ok) break;
    const data = await response.json();
    for (const event of data.items || []) {
      const keys = event.keys || [];
      const values = event.data || [];
      let recipient;
      let tokenId;
      if (collection.standard === "erc1155") {
        recipient = keys[3];
        tokenId = u256(values[0], values[1]);
      } else if (collection.layout === "keys") {
        recipient = keys[2];
        tokenId = u256(keys[3], keys[4]);
      } else {
        recipient = values[1];
        tokenId = u256(values[2], values[3]);
      }
      if (!sameFelt(recipient, owner) || tokenId == null) continue;
      candidates.push({
        tokenAddress: collection.address,
        tokenId,
        standard: collection.standard,
        tokenName: collection.name,
      });
    }
    cursor = data.nextCursor || null;
  } while (cursor && guard < 30);
  return candidates;
}

function allowedOrigins(env) {
  if (env && typeof env.ALLOWED_ORIGINS === "string" && env.ALLOWED_ORIGINS.trim()) {
    return env.ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(origin, env) {
  const list = allowedOrigins(env);
  const allow = list.includes(origin) ? origin : list[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, origin, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin, env) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    // Soft anti-abuse: reject browser requests from origins not on the allowlist
    // (browsers always send Origin; this protects the key's quota).
    if (origin && !allowedOrigins(env).includes(origin)) {
      return json({ error: "origin not allowed" }, 403, origin, env);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (request.method === "GET" && path.endsWith("/nft-holdings")) {
      const address = url.searchParams.get("address");
      const chain = (url.searchParams.get("chain") || "SN_MAIN").toUpperCase();
      if (!address || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
        return json({ error: "missing or invalid 'address'" }, 400, origin, env);
      }
      if (!/^SN_[A-Z]+$/.test(chain)) {
        return json({ error: "invalid 'chain'" }, 400, origin, env);
      }
      if (!env.STARKSCAN_API_KEY) {
        return json({ error: "server missing STARKSCAN_API_KEY" }, 500, origin, env);
      }

      try {
        const items = new Map();
        let cursor = null;
        let guard = 0;
        do {
          guard++;
          const api = new URL(`${STARKSCAN_BASE}/v1/${chain}/address/${address}/transfers`);
          api.searchParams.set("direction", "in");
          api.searchParams.set("limit", "100");
          if (cursor) api.searchParams.set("cursor", cursor);
          const response = await fetch(api.toString(), {
            headers: {
              "X-Starkscan-Api-Key": env.STARKSCAN_API_KEY,
              accept: "application/json",
            },
          });
          if (!response.ok) {
            const body = await response.text().catch(() => "");
            return json(
              { error: `starkscan ${response.status}`, detail: body.slice(0, 200) },
              502,
              origin,
              env
            );
          }
          const data = await response.json();
          for (const item of data.items || []) {
            const standard = String(item.standard || "").toLowerCase();
            if (item.tokenId == null || (!standard.includes("721") && !standard.includes("1155"))) {
              continue;
            }
            items.set(`${item.tokenAddress}:${item.tokenId}`, item);
          }
          cursor = data.nextCursor || null;
        } while (cursor && guard < 100);

        const legacyCandidates = await Promise.all(
          LEGACY_NFT_COLLECTIONS.map((collection) =>
            fetchLegacyNftCandidates(collection, address, chain, env.STARKSCAN_API_KEY).catch(
              () => []
            )
          )
        );
        for (const item of legacyCandidates.flat()) {
          items.set(`${item.tokenAddress}:${item.tokenId}`, item);
        }

        return json({ items: [...items.values()], truncated: Boolean(cursor) }, 200, origin, env);
      } catch (error) {
        console.error("Starkscan NFT holdings request failed", error);
        return json({ error: "upstream failure" }, 502, origin, env);
      }
    }

    if (request.method === "GET" && path.endsWith("/token-holdings")) {
      const address = url.searchParams.get("address");
      const chain = (url.searchParams.get("chain") || "SN_MAIN").toUpperCase();
      if (!address || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
        return json({ error: "missing or invalid 'address'" }, 400, origin, env);
      }
      if (!/^SN_[A-Z]+$/.test(chain)) {
        return json({ error: "invalid 'chain'" }, 400, origin, env);
      }
      if (!env.STARKSCAN_API_KEY) {
        return json({ error: "server missing STARKSCAN_API_KEY" }, 500, origin, env);
      }

      try {
        const items = [];
        let cursor = null;
        let guard = 0;
        do {
          guard++;
          const api = new URL(`${STARKSCAN_BASE}/v1/${chain}/address/${address}/token-holdings`);
          if (cursor) api.searchParams.set("cursor", cursor);
          const r = await fetch(api.toString(), {
            headers: {
              "X-Starkscan-Api-Key": env.STARKSCAN_API_KEY,
              accept: "application/json",
            },
          });
          if (!r.ok) {
            const body = await r.text().catch(() => "");
            let hint;
            if (r.status === 401)
              hint =
                "Starkscan rejected the API key (401). The STARKSCAN_API_KEY secret is missing, wrong, or revoked — re-run `wrangler secret put STARKSCAN_API_KEY` with a valid key.";
            else if (r.status === 403)
              hint = "Starkscan returned 403 — the key may lack access for this route/chain.";
            else if (r.status === 429)
              hint = "Starkscan rate limit (429) — slow down or upgrade the key.";
            return json(
              { error: `starkscan ${r.status}`, hint, detail: body.slice(0, 200) },
              502,
              origin,
              env
            );
          }
          const data = await r.json();
          for (const it of data.items || []) items.push(it);
          cursor = data.nextCursor || data.next_cursor || null;
        } while (cursor && guard < 30);

        return json({ items }, 200, origin, env);
      } catch (error) {
        // Keep exception details in Worker logs; they can expose upstream internals to callers.
        console.error("Starkscan token-holdings request failed", error);
        return json({ error: "upstream failure" }, 502, origin, env);
      }
    }

    if (request.method === "GET" && (path === "" || path.endsWith("/health"))) {
      return json({ ok: true, service: "snf-wallet-proxy" }, 200, origin, env);
    }

    return json({ error: "not found" }, 404, origin, env);
  },
};
