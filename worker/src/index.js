/**
 * Cloudflare Worker: Starkscan token-holdings proxy.
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
 *
 * The frontend treats `items` as the *candidate* token list and re-reads live
 * balances on-chain, so a stale indexer snapshot can never inflate a transfer.
 */

const STARKSCAN_BASE = "https://api.starkscan.co";
const DEFAULT_ALLOWED_ORIGINS = ["https://starknet-innovation.github.io", "http://localhost:5173"];

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
