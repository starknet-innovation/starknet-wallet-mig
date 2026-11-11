import { connect, disconnect } from "@starknet-io/get-starknet";
import { type AccountInterface, WalletAccount, shortString } from "starknet";
import { CHAIN_ID } from "../config";
import { makeProvider } from "./provider";

type ConnectedWallet = NonNullable<Awaited<ReturnType<typeof connect>>>;

export interface WalletConnection {
  address: string;
  chainId?: bigint;
  account: AccountInterface;
  walletName: string;
}

/** Reject if `p` hasn't settled within `ms` — wallets sometimes never answer a request. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Normalize a wallet-reported chain id. The spec says 0x-hex, but wallets also
 * return decimal strings, numbers, or the plain name ("SN_MAIN").
 */
export function parseChainId(raw: unknown): bigint | undefined {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return BigInt(raw);
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  if (/^0x[0-9a-f]+$/i.test(v) || /^[0-9]+$/.test(v)) return BigInt(v);
  if (/^[A-Za-z_][\w-]{0,30}$/.test(v)) return BigInt(shortString.encodeShortString(v));
  return undefined;
}

/**
 * Read the wallet's chain id. It gates migration to the target network, so a
 * wallet that can't report one fails the connection rather than passing as
 * "unknown".
 */
async function readChainId(wallet: ConnectedWallet, walletName: string): Promise<bigint> {
  let reason = "no response";
  try {
    const raw = await withTimeout(
      wallet.request({ type: "wallet_requestChainId" }),
      15_000,
      "timed out"
    );
    const parsed = parseChainId(raw);
    if (parsed != null) return parsed;
    reason = `unrecognized value ${JSON.stringify(raw)}`;
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }

  // Legacy injected wallets (Argent X / Ready) also expose the chain directly.
  const legacy = wallet as unknown as { chainId?: unknown; provider?: { chainId?: unknown } };
  const fallback = parseChainId(legacy.chainId) ?? parseChainId(legacy.provider?.chainId);
  if (fallback != null) return fallback;

  console.warn(`[wallet] ${walletName} chain id unavailable:`, reason, wallet);
  throw new Error(
    `${walletName} did not report its network (${reason}). Check the wallet and try again.`
  );
}

/** Open the wallet modal and return a connected account, or null if cancelled. */
export async function connectWallet(
  modalMode: "alwaysAsk" | "canAsk" = "alwaysAsk"
): Promise<WalletConnection | null> {
  const wallet = await connect({
    modalMode,
    modalTheme: "dark",
  });
  if (!wallet) return null;
  const walletName = wallet.name ?? "Wallet";

  // get-starknet already authorized the dapp, so a plain (non-silent)
  // requestAccounts returns the active account immediately. Don't use
  // `silent_mode: true` (WalletAccount.connect(..., true)): Ready (ex-Argent X)
  // never answers it, which left the UI stuck on "Connecting…".
  const accounts = await withTimeout(
    wallet.request({ type: "wallet_requestAccounts" }),
    60_000,
    `${walletName} did not return an account. Unlock the wallet and try again.`
  );
  const address = accounts?.[0];
  if (!address) throw new Error(`${walletName} returned no account.`);

  const account = new WalletAccount({
    provider: makeProvider(),
    walletProvider: wallet,
    address,
  });

  const chainId = await readChainId(wallet, walletName);
  return { address: account.address, chainId, account, walletName };
}

export async function disconnectWallet(): Promise<void> {
  try {
    await disconnect({ clearLastWallet: true });
  } catch {
    /* ignore */
  }
}

/** True if the connected chainId matches the app's target chain (Mainnet). */
export function isOnTargetChain(chainId?: bigint): boolean {
  if (chainId == null) return true; // unknown — don't block
  try {
    return chainId === BigInt(CHAIN_ID);
  } catch {
    return true;
  }
}
