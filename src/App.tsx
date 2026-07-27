import { useCallback, useEffect, useMemo, useState } from "react";
import { Section } from "./components/Section";
import { Settings } from "./components/Settings";
import { CHAIN_LABEL, EXPLORER_CONTRACT, EXPLORER_TX, MAX_CALLS_PER_TX } from "./config";
import {
  type HeldCollection,
  isDeployed,
  lookupErc20,
  lookupNft,
  scanErc20,
  scanNfts,
} from "./lib/discovery";
import {
  addressesEqual,
  formatUnits,
  normalizeAddress,
  parseUnits,
  shortenAddress,
} from "./lib/format";
import {
  type MigrationItem,
  buildCalls,
  buildOwnershipChallenge,
  chunk,
  erc20TransferCall,
  estimateFee,
  executeCalls,
  randomNonce,
  verifyOwnership,
} from "./lib/migrate";
import { fetchUsdPrices, priceKey } from "./lib/prices";
import { makeProvider } from "./lib/provider";
import { MAINNET_TOKENS } from "./lib/tokens";
import type { Asset, Erc20Asset, NftAsset } from "./lib/types";
import {
  type WalletConnection,
  connectWallet,
  disconnectWallet,
  isOnTargetChain,
} from "./lib/wallet";

const STRK = MAINNET_TOKENS.find((t) => t.symbol === "STRK")!;

function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: n > 0 && n < 1 ? 6 : 2,
  }).format(n);
}

type ProofState =
  | { status: "none" }
  | { status: "verifying" }
  | { status: "verified"; signer: string }
  | { status: "failed"; message: string };

type DeployFund =
  | { status: "idle" }
  | { status: "funding" }
  | { status: "submitted"; hash: string }
  | { status: "funded"; hash: string }
  | { status: "error"; error: string };

type DeployTx =
  | { status: "idle" }
  | { status: "deploying" }
  | { status: "submitted"; hash: string }
  | { status: "deployed"; hash?: string }
  | { status: "error"; error: string };

interface TxState {
  hash: string;
  status: "submitted" | "confirmed" | "reverted" | "error";
  note?: string;
}

type MigrateStatus = "idle" | "estimating" | "estimated" | "executing" | "done" | "error";

const STEPS = ["Connect", "Recipient", "Assets", "Review"] as const;

function gasBufferRaw(a: Erc20Asset): bigint {
  if (!a.isGasToken) return 0n;
  if (a.symbol === "ETH") return parseUnits("0.0005", a.decimals);
  if (a.symbol === "STRK") return parseUnits("1", a.decimals);
  return 0n;
}

function defaultAmountInput(a: Asset): string {
  if (a.kind === "erc20") {
    const keep = gasBufferRaw(a);
    const send = a.balance > keep ? a.balance - keep : 0n;
    return formatUnits(send, a.decimals);
  }
  if (a.kind === "erc1155") return a.balance.toString();
  return "1";
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [step, setStep] = useState(0);

  // Sending wallet
  const [sender, setSender] = useState<WalletConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string>();

  // Recipient
  const [recipientInput, setRecipientInput] = useState("");
  const recipient = useMemo(() => normalizeAddress(recipientInput), [recipientInput]);

  // As soon as a valid recipient is entered, check on-chain whether its account
  // is deployed (debounced). If not, the activation panel appears proactively.
  useEffect(() => {
    if (!recipient) {
      setRecipientStatus("idle");
      setReceiverUndeployed(false);
      return;
    }
    let cancelled = false;
    setRecipientStatus("checking");
    const timer = setTimeout(async () => {
      try {
        const deployed = await isDeployed(makeProvider(), recipient);
        if (cancelled) return;
        setRecipientStatus(deployed ? "deployed" : "undeployed");
        setReceiverUndeployed(!deployed);
      } catch {
        if (cancelled) return;
        setRecipientStatus("error");
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [recipient]);
  const [proof, setProof] = useState<ProofState>({ status: "none" });
  const [recipientStatus, setRecipientStatus] = useState<
    "idle" | "checking" | "deployed" | "undeployed" | "error"
  >("idle");
  const [receiverUndeployed, setReceiverUndeployed] = useState(false);
  const [deployFund, setDeployFund] = useState<DeployFund>({ status: "idle" });
  const [deployTx, setDeployTx] = useState<DeployTx>({ status: "idle" });
  const [fundAmount, setFundAmount] = useState("2");

  // Assets
  const [scanning, setScanning] = useState(false);
  const [erc20s, setErc20s] = useState<Erc20Asset[]>([]);
  const [nfts, setNfts] = useState<NftAsset[]>([]);
  const [nftNotice, setNftNotice] = useState<string>();
  const [tokenNotice, setTokenNotice] = useState<string>();
  const [heldCollections, setHeldCollections] = useState<HeldCollection[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [prices, setPrices] = useState<Map<string, number>>(new Map());

  const priceOf = useCallback(
    (a: Asset): number | undefined => {
      if (a.kind !== "erc20") return undefined;
      return prices.get(priceKey(a.address));
    },
    [prices]
  );

  const tokenValueUsd = useCallback(
    (a: Erc20Asset, amountRaw: bigint): number | undefined => {
      const p = prices.get(priceKey(a.address));
      if (p === undefined) return undefined;
      return (Number(amountRaw) / 10 ** a.decimals) * p;
    },
    [prices]
  );

  // Manual add
  const [manualToken, setManualToken] = useState("");
  const [manualNftAddr, setManualNftAddr] = useState("");
  const [manualNftId, setManualNftId] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string>();

  // Migration
  const [mStatus, setMStatus] = useState<MigrateStatus>("idle");
  const [feeText, setFeeText] = useState<string>();
  const [mError, setMError] = useState<string>();
  const [txs, setTxs] = useState<TxState[]>([]);

  const allAssets: Asset[] = useMemo(() => [...erc20s, ...nfts], [erc20s, nfts]);
  const chainOk = sender ? isOnTargetChain(sender.chainId) : true;

  const selectedItems: MigrationItem[] = useMemo(() => {
    const items: MigrationItem[] = [];
    for (const a of allAssets) {
      if (!selected[a.id]) continue;
      const raw = amounts[a.id] ?? defaultAmountInput(a);
      try {
        if (a.kind === "erc20") {
          let amt = parseUnits(raw, a.decimals);
          if (amt > a.balance) amt = a.balance;
          if (amt > 0n) items.push({ asset: a, amount: amt });
        } else if (a.kind === "erc1155") {
          let amt = BigInt(raw || "0");
          if (amt > a.balance) amt = a.balance;
          if (amt > 0n) items.push({ asset: a, amount: amt });
        } else {
          items.push({ asset: a, amount: 1n });
        }
      } catch {
        /* invalid amount — skip from build, surfaced in UI */
      }
    }
    return items;
  }, [allAssets, selected, amounts]);

  const detectedValue = useMemo(
    () => erc20s.reduce((sum, a) => sum + (tokenValueUsd(a, a.balance) ?? 0), 0),
    [erc20s, tokenValueUsd]
  );
  const migratingValue = useMemo(
    () =>
      selectedItems.reduce(
        (sum, it) =>
          it.asset.kind === "erc20" ? sum + (tokenValueUsd(it.asset, it.amount) ?? 0) : sum,
        0
      ),
    [selectedItems, tokenValueUsd]
  );

  async function refreshPrices(tokens: Erc20Asset[]) {
    if (tokens.length === 0) return;
    try {
      const m = await fetchUsdPrices(
        makeProvider(),
        tokens.map((t) => ({ address: t.address, decimals: t.decimals }))
      );
      setPrices((prev) => {
        const next = new Map(prev);
        for (const [k, v] of m) next.set(k, v);
        return next;
      });
    } catch {
      /* prices are best-effort */
    }
  }

  // ---- handlers ---------------------------------------------------------

  async function handleConnect() {
    setConnectError(undefined);
    setConnecting(true);
    try {
      const w = await connectWallet("alwaysAsk");
      if (w) {
        setSender(w);
        setStep(1);
      }
    } catch (e: any) {
      setConnectError(e?.message ?? "Failed to connect.");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    await disconnectWallet();
    setSender(null);
    setErc20s([]);
    setNfts([]);
    setSelected({});
    setAmounts({});
    setPrices(new Map());
    setHeldCollections([]);
    setProof({ status: "none" });
    setTxs([]);
    setMStatus("idle");
    setFeeText(undefined);
    setStep(0);
  }

  async function handleProve() {
    if (!sender || !recipient) return;
    setProof({ status: "verifying" });
    setReceiverUndeployed(false);
    try {
      const w = await connectWallet("alwaysAsk");
      if (!w) {
        setProof({ status: "none" });
        return;
      }
      if (!addressesEqual(w.address, recipient)) {
        setProof({
          status: "failed",
          message: `Connected wallet ${shortenAddress(w.address)} does not match the recipient ${shortenAddress(recipient)}.`,
        });
        return;
      }
      const typedData = buildOwnershipChallenge({
        sender: sender.address,
        receiver: recipient,
        nonce: randomNonce(),
      });
      const signature = await w.account.signMessage(typedData);
      const ok = await verifyOwnership(w.account, typedData, signature, recipient);
      if (ok) {
        setProof({ status: "verified", signer: w.address });
        return;
      }
      // Verification failed — distinguish "account not deployed yet" (common for
      // a fresh wallet) from an actually-bad signature.
      const deployed = await isDeployed(makeProvider(), recipient);
      if (!deployed) {
        setReceiverUndeployed(true);
        setProof({
          status: "failed",
          message:
            "This receiving account isn't deployed on-chain yet (normal for a brand-new wallet), so its signature can't be verified.",
        });
      } else {
        setProof({
          status: "failed",
          message:
            "Signature did not verify on-chain. The wallet may have rejected it, or it isn't the owner of this address.",
        });
      }
    } catch (e: any) {
      setProof({
        status: "failed",
        message: e?.message ?? "Could not get a signature.",
      });
    }
  }

  // Fund the receiving account's deployment from the SENDING wallet. The deploy
  // itself must be signed by the receiver's own wallet (only it holds the key),
  // so this sends gas (STRK) and then guides the user to activate the receiver.
  async function handleFundDeploy() {
    if (!sender || !recipient) return;
    setDeployFund({ status: "funding" });
    try {
      // Make sure the wallet's active account is the sender before paying.
      const w = await connectWallet("alwaysAsk");
      if (!w) {
        setDeployFund({ status: "idle" });
        return;
      }
      if (!addressesEqual(w.address, sender.address)) {
        setDeployFund({
          status: "error",
          error: `Select the sending account ${shortenAddress(sender.address)} in your wallet, then try again (currently active: ${shortenAddress(w.address)}).`,
        });
        return;
      }
      let amount: bigint;
      try {
        amount = parseUnits(fundAmount || "0", STRK.decimals);
      } catch {
        setDeployFund({ status: "error", error: "Invalid STRK amount." });
        return;
      }
      if (amount <= 0n) {
        setDeployFund({ status: "error", error: "Enter an amount greater than 0." });
        return;
      }
      const call = erc20TransferCall(STRK.address, recipient, amount);
      const res = await w.account.execute(call);
      setDeployFund({ status: "submitted", hash: res.transaction_hash });
      await makeProvider().waitForTransaction(res.transaction_hash);
      setDeployFund({ status: "funded", hash: res.transaction_hash });
    } catch (e: any) {
      setDeployFund({
        status: "error",
        error: e?.message ?? "Funding transaction failed or was rejected.",
      });
    }
  }

  // Deploy the receiving account from ITS OWN wallet. A Starknet wallet deploys
  // a counterfactual account automatically on its first transaction, so we
  // trigger a harmless 0-value self-transfer; the wallet prepends the deploy and
  // pays with the STRK funded above.
  async function handleDeployReceiver() {
    if (!recipient) return;
    setDeployTx({ status: "deploying" });
    try {
      const w = await connectWallet("alwaysAsk");
      if (!w) {
        setDeployTx({ status: "idle" });
        return;
      }
      if (!addressesEqual(w.address, recipient)) {
        setDeployTx({
          status: "error",
          error: `Select the receiving account ${shortenAddress(recipient)} in your wallet, then try again (currently active: ${shortenAddress(w.address)}).`,
        });
        return;
      }
      const provider = makeProvider();
      if (await isDeployed(provider, recipient)) {
        setReceiverUndeployed(false);
        setDeployTx({ status: "deployed" });
        return;
      }
      const call = erc20TransferCall(STRK.address, recipient, 0n);
      const res = await w.account.execute(call);
      setDeployTx({ status: "submitted", hash: res.transaction_hash });
      await provider.waitForTransaction(res.transaction_hash);
      const nowDeployed = await isDeployed(provider, recipient);
      setReceiverUndeployed(!nowDeployed);
      setDeployTx(
        nowDeployed
          ? { status: "deployed", hash: res.transaction_hash }
          : {
              status: "error",
              error:
                "Transaction confirmed but the account still reads as undeployed. Check your wallet — it may not auto-deploy on a dapp transaction; deploy it from the wallet's own UI instead.",
            }
      );
    } catch (e: any) {
      setDeployTx({
        status: "error",
        error:
          e?.message ??
          "Deployment failed or was rejected. Make sure the account has a little STRK for the fee.",
      });
    }
  }

  async function handleScan() {
    if (!sender) return;
    setScanning(true);
    setNftNotice(undefined);
    setTokenNotice(undefined);
    try {
      const provider = makeProvider();
      const [tokenRes, nftRes] = await Promise.all([
        scanErc20(provider, sender.address),
        scanNfts(provider, sender.address),
      ]);
      setErc20s(tokenRes.assets);
      setTokenNotice(tokenRes.notice);
      refreshPrices(tokenRes.assets);
      setNfts(nftRes.assets);
      setHeldCollections(nftRes.manualNeeded ?? []);
      setNftNotice(nftRes.error ?? nftRes.notice);
      const sel: Record<string, boolean> = {};
      const amt: Record<string, string> = {};
      for (const a of [...tokenRes.assets, ...nftRes.assets]) {
        sel[a.id] = true;
        amt[a.id] = defaultAmountInput(a);
      }
      setSelected(sel);
      setAmounts(amt);
    } finally {
      setScanning(false);
    }
  }

  async function handleAddToken() {
    if (!sender || !manualToken.trim()) return;
    setManualBusy(true);
    setManualError(undefined);
    try {
      const asset = await lookupErc20(makeProvider(), manualToken, sender.address);
      if (asset.balance <= 0n) {
        setManualError("That token has a zero balance in this wallet.");
        return;
      }
      if (erc20s.some((t) => t.id === asset.id)) {
        setManualError("Token already in the list.");
        return;
      }
      setErc20s((prev) => [...prev, asset]);
      setSelected((s) => ({ ...s, [asset.id]: true }));
      setAmounts((m) => ({ ...m, [asset.id]: defaultAmountInput(asset) }));
      refreshPrices([asset]);
      setManualToken("");
    } catch (e: any) {
      setManualError(e?.message ?? "Lookup failed.");
    } finally {
      setManualBusy(false);
    }
  }

  async function handleAddNft() {
    if (!sender || !manualNftAddr.trim() || !manualNftId.trim()) return;
    setManualBusy(true);
    setManualError(undefined);
    try {
      const asset = await lookupNft(makeProvider(), manualNftAddr, manualNftId, sender.address);
      if (nfts.some((n) => n.id === asset.id)) {
        setManualError("NFT already in the list.");
        return;
      }
      setNfts((prev) => [...prev, asset]);
      setSelected((s) => ({ ...s, [asset.id]: true }));
      setAmounts((m) => ({ ...m, [asset.id]: "1" }));
      setManualNftAddr("");
      setManualNftId("");
    } catch (e: any) {
      setManualError(e?.message ?? "Lookup failed.");
    } finally {
      setManualBusy(false);
    }
  }

  async function handleEstimate() {
    if (!sender || !recipient) return;
    setMStatus("estimating");
    setMError(undefined);
    setFeeText(undefined);
    try {
      const calls = buildCalls(selectedItems, sender.address, recipient);
      if (calls.length === 0) {
        setMError("No assets selected.");
        setMStatus("idle");
        return;
      }
      const est = await estimateFee(sender.account, calls);
      const overall = (est as any).overall_fee ?? (est as any).suggestedMaxFee;
      const unit = (est as any).unit;
      const tokenLabel = unit === "WEI" ? "ETH" : unit === "FRI" ? "STRK" : "";
      if (overall != null) {
        setFeeText(`${formatUnits(BigInt(overall), 18)} ${tokenLabel}`.trim());
      } else {
        setFeeText("estimated");
      }
      setMStatus("estimated");
    } catch (e: any) {
      setMError(
        `Fee estimate failed: ${e?.message ?? e}. If you are sending most of your ETH/STRK, keep more of the gas token and try again.`
      );
      setMStatus("error");
    }
  }

  async function handleMigrate() {
    if (!sender || !recipient) return;
    setMStatus("executing");
    setMError(undefined);
    setTxs([]);
    const provider = makeProvider();
    try {
      const calls = buildCalls(selectedItems, sender.address, recipient);
      const batches = chunk(calls, MAX_CALLS_PER_TX);
      for (let i = 0; i < batches.length; i++) {
        const { transactionHash } = await executeCalls(sender.account, batches[i]);
        setTxs((prev) => [
          ...prev,
          {
            hash: transactionHash,
            status: "submitted",
            note: batches.length > 1 ? `Batch ${i + 1} of ${batches.length}` : undefined,
          },
        ]);
        try {
          await provider.waitForTransaction(transactionHash);
          setTxs((prev) =>
            prev.map((t) => (t.hash === transactionHash ? { ...t, status: "confirmed" } : t))
          );
        } catch (waitErr: any) {
          setTxs((prev) =>
            prev.map((t) =>
              t.hash === transactionHash ? { ...t, status: "reverted", note: waitErr?.message } : t
            )
          );
        }
      }
      setMStatus("done");
    } catch (e: any) {
      setMError(e?.message ?? "Transaction failed or was rejected.");
      setMStatus("error");
    }
  }

  function toggle(id: string) {
    setSelected((s) => ({ ...s, [id]: !s[id] }));
  }
  function setAmt(id: string, v: string) {
    setAmounts((m) => ({ ...m, [id]: v }));
  }

  // ---- render -----------------------------------------------------------

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span>
          <div>
            <h1>Starknet Wallet Migrator</h1>
            <span className="badge">{CHAIN_LABEL}</span>
          </div>
        </div>
        <div className="topbar-right">
          {sender && (
            <span className="wallet-pill" title={sender.address}>
              {sender.walletName}: {shortenAddress(sender.address)}
              <button className="link" onClick={handleDisconnect}>
                disconnect
              </button>
            </span>
          )}
          <button className="icon-btn" onClick={() => setShowSettings(true)}>
            ⚙ Settings
          </button>
        </div>
      </header>

      {!chainOk && (
        <div className="banner warn">
          Connected wallet is not on {CHAIN_LABEL}. Switch the network in your wallet — this app
          only operates on mainnet.
        </div>
      )}

      <div className="stepper">
        {STEPS.map((s, i) => (
          <button
            key={s}
            className={`stepper-item ${i === step ? "active" : ""} ${i < step ? "done" : ""}`}
            disabled={i > step && !(i === 1 && sender)}
            onClick={() => i <= step && setStep(i)}
          >
            <span className="step-num">{i + 1}</span>
            {s}
          </button>
        ))}
      </div>

      <main className="content">
        {step === 0 && (
          <Section
            title="1 · Connect the sending wallet"
            sub="Connect the wallet you want to migrate assets out of. The app never sees your keys — your wallet signs everything."
          >
            {sender ? (
              <div className="ok-row">
                <span className="dot ok" /> Connected: <code>{sender.address}</code>
                <button className="btn primary" onClick={() => setStep(1)}>
                  Continue →
                </button>
              </div>
            ) : (
              <button className="btn primary big" onClick={handleConnect} disabled={connecting}>
                {connecting ? "Connecting…" : "Connect wallet"}
              </button>
            )}
            {connectError && <p className="error">{connectError}</p>}
          </Section>
        )}

        {step === 1 && (
          <Section
            title="2 · Set the receiving wallet"
            sub="Paste the destination Starknet address. Double-check it — transfers are irreversible. Optionally prove you control it by signing a challenge."
          >
            <label className="field">
              <span>Recipient address</span>
              <input
                value={recipientInput}
                onChange={(e) => {
                  setRecipientInput(e.target.value);
                  setProof({ status: "none" });
                  setReceiverUndeployed(false);
                  setDeployFund({ status: "idle" });
                  setDeployTx({ status: "idle" });
                }}
                placeholder="0x…"
                spellCheck={false}
              />
              {recipientInput && !recipient && (
                <small className="error">Not a valid Starknet address.</small>
              )}
              {recipient && <small className="muted">Parsed: {recipient}</small>}
              {recipient && recipientStatus === "checking" && (
                <small className="muted">Checking deployment status…</small>
              )}
              {recipient && recipientStatus === "deployed" && (
                <small className="muted">✓ Account is deployed on-chain.</small>
              )}
              {recipient && recipientStatus === "undeployed" && (
                <small className="warn-text">
                  ⚠ This account isn’t deployed on-chain yet — activation options are below.
                </small>
              )}
              {recipient && recipientStatus === "error" && (
                <small className="muted">
                  Couldn’t check deployment status (RPC) — you can still proceed.
                </small>
              )}
              {recipient && sender && addressesEqual(recipient, sender.address) && (
                <small className="error">Recipient is the same as the sending wallet.</small>
              )}
            </label>

            <div className="proof-box">
              <div className="proof-head">
                <strong>Optional: prove ownership</strong>
                {proof.status === "verified" && <span className="tag ok">✓ Verified on-chain</span>}
                {proof.status === "failed" && <span className="tag bad">✗ Not verified</span>}
              </div>
              <p className="muted">
                Connect the receiving wallet and sign a gas-free message. The signature is checked
                against the address on-chain, confirming you control it. Skip this if the
                destination is a cold/hardware wallet you can&apos;t connect here.
              </p>
              <button
                className="btn ghost"
                onClick={handleProve}
                disabled={!recipient || proof.status === "verifying"}
              >
                {proof.status === "verifying"
                  ? "Waiting for signature…"
                  : "Connect receiver & sign"}
              </button>
              {proof.status === "failed" && <p className="error">{proof.message}</p>}

              {receiverUndeployed && (
                <div className="deploy-box">
                  <strong>Activate the receiving account</strong>
                  <p className="muted">
                    You can <em>skip this and migrate anyway</em> — transfers to an undeployed
                    address succeed. Or activate it now: fund the gas from the{" "}
                    <strong>sending</strong> wallet, then deploy from the <strong>receiving</strong>{" "}
                    wallet (only it can sign its own deployment).
                  </p>

                  <div className="deploy-step">
                    <span className="step-pill">1</span>
                    <div className="deploy-step-body">
                      <div className="inline">
                        <input
                          className="short"
                          value={fundAmount}
                          onChange={(e) => setFundAmount(e.target.value)}
                          spellCheck={false}
                        />
                        <span className="muted small" style={{ alignSelf: "center" }}>
                          STRK
                        </span>
                        <button
                          className="btn ghost"
                          onClick={handleFundDeploy}
                          disabled={deployFund.status === "funding"}
                        >
                          {deployFund.status === "funding"
                            ? "Sending…"
                            : "Fund gas from sending wallet"}
                        </button>
                      </div>
                      {(deployFund.status === "submitted" || deployFund.status === "funded") && (
                        <p className="muted small">
                          {deployFund.status === "funded" ? "✓ Gas sent. " : "Sent, confirming… "}
                          <a href={EXPLORER_TX(deployFund.hash)} target="_blank" rel="noreferrer">
                            {shortenAddress(deployFund.hash, 10, 8)}
                          </a>
                        </p>
                      )}
                      {deployFund.status === "error" && <p className="error">{deployFund.error}</p>}
                    </div>
                  </div>

                  <div className="deploy-step">
                    <span className="step-pill">2</span>
                    <div className="deploy-step-body">
                      <button
                        className="btn ghost"
                        onClick={handleDeployReceiver}
                        disabled={deployTx.status === "deploying" || deployTx.status === "deployed"}
                      >
                        {deployTx.status === "deploying"
                          ? "Deploying…"
                          : "Deploy from receiving wallet"}
                      </button>
                      <span className="muted small">
                        {" "}
                        switches your wallet to the receiving account
                      </span>
                      {deployTx.status === "submitted" && (
                        <p className="muted small">
                          Deploying, confirming…{" "}
                          <a href={EXPLORER_TX(deployTx.hash)} target="_blank" rel="noreferrer">
                            {shortenAddress(deployTx.hash, 10, 8)}
                          </a>
                        </p>
                      )}
                      {deployTx.status === "deployed" && (
                        <p className="muted small">
                          ✓ Account deployed
                          {deployTx.hash ? (
                            <>
                              {" "}
                              <a href={EXPLORER_TX(deployTx.hash)} target="_blank" rel="noreferrer">
                                {shortenAddress(deployTx.hash, 10, 8)}
                              </a>
                            </>
                          ) : null}{" "}
                          — click “Connect receiver &amp; sign” above to verify.
                        </p>
                      )}
                      {deployTx.status === "error" && <p className="error">{deployTx.error}</p>}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="nav">
              <button className="btn ghost" onClick={() => setStep(0)}>
                ← Back
              </button>
              <button
                className="btn primary"
                disabled={!recipient || (sender ? addressesEqual(recipient, sender.address) : true)}
                onClick={() => {
                  setStep(2);
                  if (allAssets.length === 0) handleScan();
                }}
              >
                Continue →
              </button>
            </div>
          </Section>
        )}

        {step === 2 && (
          <Section
            title="3 · Choose what to migrate"
            sub="Detected ERC-20 balances and NFTs. Untick anything you want to leave behind, and edit amounts if needed."
          >
            <div className="nav-inline">
              <button className="btn ghost" onClick={handleScan} disabled={scanning}>
                {scanning ? "Scanning…" : "↻ Rescan"}
              </button>
              <span className="muted">
                {erc20s.length} token(s), {nfts.length} NFT(s) found
                {detectedValue > 0 && <> · ≈ {formatUsd(detectedValue)} total</>}
              </span>
            </div>

            {tokenNotice && <p className="notice">{tokenNotice}</p>}

            {erc20s.length > 0 && (
              <>
                <h3>Tokens</h3>
                <div className="asset-list">
                  {erc20s.map((a) => (
                    <div className="asset-row" key={a.id}>
                      <input
                        type="checkbox"
                        checked={!!selected[a.id]}
                        onChange={() => toggle(a.id)}
                      />
                      <div className="asset-main">
                        <strong>{a.symbol}</strong> <span className="muted">{a.name}</span>
                        {a.isGasToken && <span className="tag">gas token</span>}
                        <div className="muted small">
                          Balance: {formatUnits(a.balance, a.decimals)}
                          {priceOf(a) !== undefined && <> · {formatUsd(priceOf(a)!)}/ea</>}
                          {tokenValueUsd(a, a.balance) !== undefined && (
                            <> · ≈ {formatUsd(tokenValueUsd(a, a.balance)!)}</>
                          )}
                        </div>
                      </div>
                      <div className="asset-amt">
                        <input
                          value={amounts[a.id] ?? ""}
                          onChange={(e) => setAmt(a.id, e.target.value)}
                          disabled={!selected[a.id]}
                        />
                        <button
                          className="link"
                          onClick={() => setAmt(a.id, formatUnits(a.balance, a.decimals))}
                        >
                          max
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="muted small">
                  For ETH and STRK the default keeps a small buffer so you can still pay the
                  transaction fee.
                </p>
              </>
            )}

            {nfts.length > 0 && (
              <>
                <h3>NFTs</h3>
                <div className="asset-list">
                  {nfts.map((a) => (
                    <div className="asset-row" key={a.id}>
                      <input
                        type="checkbox"
                        checked={!!selected[a.id]}
                        onChange={() => toggle(a.id)}
                      />
                      {a.imageUrl ? (
                        <img className="nft-thumb" src={a.imageUrl} alt="" />
                      ) : (
                        <div className="nft-thumb placeholder">NFT</div>
                      )}
                      <div className="asset-main">
                        <strong>{a.collectionName ?? a.name ?? "NFT"}</strong>
                        <div className="muted small">
                          #{a.tokenId.toString()} ·{" "}
                          {a.kind === "erc1155" ? `x${a.balance}` : "ERC-721"} ·{" "}
                          <a href={EXPLORER_CONTRACT(a.address)} target="_blank" rel="noreferrer">
                            {shortenAddress(a.address)}
                          </a>
                        </div>
                      </div>
                      {a.kind === "erc1155" && (
                        <div className="asset-amt">
                          <input
                            value={amounts[a.id] ?? ""}
                            onChange={(e) => setAmt(a.id, e.target.value)}
                            disabled={!selected[a.id]}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {heldCollections.length > 0 && (
              <>
                <h3>Detected NFT holdings — add token IDs</h3>
                <div className="asset-list">
                  {heldCollections.map((c) => (
                    <div className="asset-row" key={c.address}>
                      <div className="asset-main">
                        <strong>{c.name}</strong>
                        <div className="muted small">
                          Holds {c.balance}
                          {c.truncated ? "+" : ""} · not enumerable on-chain ·{" "}
                          <a href={EXPLORER_CONTRACT(c.address)} target="_blank" rel="noreferrer">
                            {shortenAddress(c.address)}
                          </a>
                        </div>
                      </div>
                      <button
                        className="btn ghost"
                        onClick={() => {
                          setManualNftAddr(c.address);
                          setManualOpen(true);
                        }}
                      >
                        Add token ID
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {nftNotice && <p className="notice">{nftNotice}</p>}

            <details
              className="manual"
              open={manualOpen}
              onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary>Add an asset manually</summary>
              <div className="manual-grid">
                <div className="field">
                  <span>ERC-20 token address</span>
                  <div className="inline">
                    <input
                      value={manualToken}
                      onChange={(e) => setManualToken(e.target.value)}
                      placeholder="0x…"
                      spellCheck={false}
                    />
                    <button className="btn ghost" onClick={handleAddToken} disabled={manualBusy}>
                      Add token
                    </button>
                  </div>
                </div>
                <div className="field">
                  <span>NFT contract + token ID</span>
                  <div className="inline">
                    <input
                      value={manualNftAddr}
                      onChange={(e) => setManualNftAddr(e.target.value)}
                      placeholder="0x… contract"
                      spellCheck={false}
                    />
                    <input
                      className="short"
                      value={manualNftId}
                      onChange={(e) => setManualNftId(e.target.value)}
                      placeholder="token id"
                      spellCheck={false}
                    />
                    <button className="btn ghost" onClick={handleAddNft} disabled={manualBusy}>
                      Add NFT
                    </button>
                  </div>
                </div>
              </div>
              {manualError && <p className="error">{manualError}</p>}
            </details>

            {!scanning && erc20s.length === 0 && nfts.length === 0 && (
              <p className="muted">
                Nothing detected yet. Configure the token-discovery proxy URL in Settings to
                auto-detect all tokens (without it, only a built-in token list is checked). NFTs
                aren’t auto-detected — add them with “Add an asset manually”.
              </p>
            )}

            <div className="nav">
              <button className="btn ghost" onClick={() => setStep(1)}>
                ← Back
              </button>
              <button
                className="btn primary"
                disabled={selectedItems.length === 0}
                onClick={() => {
                  setMStatus("idle");
                  setFeeText(undefined);
                  setStep(3);
                }}
              >
                Review {selectedItems.length} transfer(s) →
              </button>
            </div>
          </Section>
        )}

        {step === 3 && sender && recipient && (
          <Section
            title="4 · Review & migrate"
            sub="Everything below is bundled into one signed transaction (or a few, if there are many transfers)."
          >
            <div className="review-meta">
              <div>
                <span className="muted">From</span>
                <code>{shortenAddress(sender.address, 10, 8)}</code>
              </div>
              <div className="arrow">→</div>
              <div>
                <span className="muted">
                  To{" "}
                  {proof.status === "verified" ? (
                    <span className="tag ok">ownership verified</span>
                  ) : (
                    <span className="tag warn">unverified</span>
                  )}
                </span>
                <code>{shortenAddress(recipient, 10, 8)}</code>
              </div>
            </div>

            <table className="summary">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Amount</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {selectedItems.map((it) => (
                  <tr key={it.asset.id}>
                    <td>
                      {it.asset.kind === "erc20" ? (
                        it.asset.symbol
                      ) : (
                        <div className="review-nft">
                          {it.asset.imageUrl ? (
                            <img className="nft-thumb" src={it.asset.imageUrl} alt="" />
                          ) : (
                            <div className="nft-thumb placeholder">NFT</div>
                          )}
                          <div>
                            <strong>{it.asset.collectionName ?? it.asset.name ?? "NFT"}</strong>
                            <div className="muted small">
                              #{it.asset.tokenId} ·{" "}
                              {it.asset.kind === "erc1155" ? "ERC-1155" : "ERC-721"}
                            </div>
                          </div>
                        </div>
                      )}
                    </td>
                    <td>
                      {it.asset.kind === "erc20"
                        ? formatUnits(it.amount, it.asset.decimals)
                        : it.amount.toString()}
                    </td>
                    <td className="muted">
                      {it.asset.kind === "erc20" && tokenValueUsd(it.asset, it.amount) !== undefined
                        ? `≈ ${formatUsd(tokenValueUsd(it.asset, it.amount)!)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              {migratingValue > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={2}>
                      <strong>Total (priced tokens)</strong>
                    </td>
                    <td>
                      <strong>≈ {formatUsd(migratingValue)}</strong>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>

            <p className="muted small">
              {selectedItems.length} transfer(s) · {chunk(selectedItems, MAX_CALLS_PER_TX).length}{" "}
              transaction(s)
            </p>

            <div className="nav-inline">
              <button
                className="btn ghost"
                onClick={handleEstimate}
                disabled={mStatus === "estimating" || mStatus === "executing"}
              >
                {mStatus === "estimating" ? "Estimating…" : "Estimate fee"}
              </button>
              {feeText && <span className="muted">Estimated fee: ~{feeText}</span>}
            </div>

            {mError && <p className="error">{mError}</p>}

            <div className="banner warn small">
              ⚠ Transfers are irreversible. Confirm the recipient address is correct. If you proved
              ownership above, the address is verified.
            </div>

            <div className="nav">
              <button
                className="btn ghost"
                onClick={() => setStep(2)}
                disabled={mStatus === "executing"}
              >
                ← Back
              </button>
              <button
                className="btn primary big"
                onClick={handleMigrate}
                disabled={
                  mStatus === "executing" ||
                  mStatus === "done" ||
                  selectedItems.length === 0 ||
                  !chainOk
                }
              >
                {mStatus === "executing"
                  ? "Confirm in your wallet…"
                  : `Migrate ${selectedItems.length} asset(s)`}
              </button>
            </div>

            {txs.length > 0 && (
              <div className="tx-list">
                {txs.map((t) => (
                  <div className={`tx-row ${t.status}`} key={t.hash}>
                    <span className="dot" />
                    <a href={EXPLORER_TX(t.hash)} target="_blank" rel="noreferrer">
                      {shortenAddress(t.hash, 10, 8)}
                    </a>
                    <span className="muted">
                      {t.note ? `${t.note} · ` : ""}
                      {t.status}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {mStatus === "done" && (
              <div className="banner ok">
                ✓ Migration submitted. Verify balances in the receiving wallet and on the explorer.
              </div>
            )}
          </Section>
        )}
      </main>

      <footer className="foot">
        <span>
          Open-source migration tool · your wallet signs every action · keys never leave your
          browser.
        </span>
      </footer>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
