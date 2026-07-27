import { useState } from "react";
import { DEFAULT_RPC_URL } from "../config";
import { getIndexerConfig, setIndexerConfig } from "../lib/indexerConfig";
import { getRpcUrl, setRpcUrl } from "../lib/provider";

export function Settings({ onClose }: { onClose: () => void }) {
  const idx = getIndexerConfig();
  const [rpc, setRpc] = useState(getRpcUrl());
  const [proxy, setProxy] = useState(idx.proxyUrl);
  const [nftUrl, setNftUrl] = useState(idx.nftUrlTemplate);
  const [saved, setSaved] = useState(false);

  function save() {
    setRpcUrl(rpc || DEFAULT_RPC_URL);
    setIndexerConfig({ proxyUrl: proxy, nftUrlTemplate: nftUrl });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <label className="field">
          <span>Starknet RPC URL</span>
          <input value={rpc} onChange={(e) => setRpc(e.target.value)} spellCheck={false} />
          <small>
            Public, CORS-open mainnet RPC. Used for balance reads &amp; signature checks.
          </small>
        </label>

        <hr />
        <h3>Token-discovery proxy (Cloudflare Worker)</h3>
        <p className="muted">
          Base URL of the Worker in <code>/worker</code>. It holds the Starkscan API key server-side
          and lists every token the wallet holds — no key ever lives in the browser. Leave blank to
          fall back to the built-in token list. Deploy steps are in <code>worker/README.md</code>.
        </p>
        <label className="field">
          <span>Proxy URL</span>
          <input
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="https://snf-wallet-proxy.your-subdomain.workers.dev"
            spellCheck={false}
          />
        </label>

        <hr />
        <h3>Custom NFT holdings URL (optional)</h3>
        <p className="muted">
          The token-discovery Worker also finds NFTs. To override it with another provider, put its
          URL here using <code>{"{address}"}</code> as a placeholder. Every returned NFT is still
          verified on-chain.
        </p>
        <label className="field">
          <span>NFT holdings URL template</span>
          <input
            value={nftUrl}
            onChange={(e) => setNftUrl(e.target.value)}
            placeholder="https://…/nfts?owner={address}"
            spellCheck={false}
          />
        </label>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={save}>
            {saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
