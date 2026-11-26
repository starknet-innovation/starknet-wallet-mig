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
  const request = async (): Promise<bigint> => {
    const raw = await withTimeout(
      wallet.request({ type: "wallet_requestChainId" }),
      15_000,
      "timed out"
    );
    const parsed = parseChainId(raw);
    if (parsed == null) throw new Error(`unrecognized value ${JSON.stringify(raw)}`);
    return parsed;
  };

  let reason: string;
  try {
    return await request();
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }

  // Ready X (ex-Argent X) returns accounts from wallet_requestAccounts but
  // doesn't register the dapp as authorized, so wallet_requestChainId fails
  // with "Not preauthorized". Its legacy `enable()` completes the authorization
  // (no extra popup once the user has approved); then retry.
  const legacyEnable = (wallet as unknown as { enable?: () => Promise<unknown> }).enable;
  if (typeof legacyEnable === "function") {
    try {
      await withTimeout(legacyEnable.call(wallet), 60_000, "enable timed out");
      return await request();
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
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

type InjectedWallet = ConnectedWallet & { request: ConnectedWallet["request"] };

interface AccountsAttempt {
  wallet: InjectedWallet;
  accounts?: string[];
  error?: unknown;
}

/**
 * Temporarily wrap `request` on every injected `window.starknet*` wallet to
 * record the `wallet_requestAccounts` call get-starknet makes while enabling
 * the chosen wallet. get-starknet's `connect` returns null both when the user
 * closes the modal and when enabling fails (e.g. Ready X on a fresh install
 * returns accounts but doesn't report the accounts permission yet), so this is
 * the only way to tell those apart, and it lets us reuse the accounts instead
 * of asking the wallet a second time (which opens a second popup in Bramble).
 */
export function recordAccountRequests(target: Record<string, unknown> = globalThis as never): {
  attempts: AccountsAttempt[];
  restore: () => void;
} {
  const attempts: AccountsAttempt[] = [];
  const restores: (() => void)[] = [];
  const seen = new Set<unknown>();
  let names: string[] = [];
  try {
    names = Object.getOwnPropertyNames(target).filter((n) => n.startsWith("starknet"));
  } catch {
    /* no window */
  }
  for (const name of names) {
    let wallet: InjectedWallet | undefined;
    try {
      wallet = target[name] as InjectedWallet;
    } catch {
      continue;
    }
    if (!wallet || typeof wallet.request !== "function" || seen.has(wallet)) continue;
    seen.add(wallet);
    const original = wallet.request;
    const wrapped = (async (call: { type: string }) => {
      if (call?.type !== "wallet_requestAccounts") {
        return (original as (c: unknown) => Promise<unknown>).call(wallet, call);
      }
      const attempt: AccountsAttempt = { wallet: wallet as InjectedWallet };
      attempts.push(attempt);
      try {
        const res = (await (original as (c: unknown) => Promise<string[]>).call(
          wallet,
          call
        )) as string[];
        attempt.accounts = res;
        return res;
      } catch (e) {
        attempt.error = e;
        throw e;
      }
    }) as InjectedWallet["request"];
    try {
      wallet.request = wrapped;
      if (wallet.request !== wrapped) continue; // read-only/proxied — skip
      restores.push(() => {
        try {
          wallet.request = original;
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* non-writable — skip this wallet */
    }
  }
  return {
    attempts,
    restore: () => {
      for (const r of restores) r();
    },
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Open the wallet modal (or, with "canAsk", reuse the last wallet without a
 * modal) and return a connected account, or null if the user cancelled.
 */
export async function connectWallet(
  modalMode: "alwaysAsk" | "canAsk" = "alwaysAsk"
): Promise<WalletConnection | null> {
  const probe = recordAccountRequests();
  let wallet: ConnectedWallet | null;
  try {
    wallet = await connect({
      modalMode,
      modalTheme: "dark",
    });
  } finally {
    probe.restore();
  }

  const attempt = probe.attempts.at(-1);
  if (!wallet) {
    // No wallet was asked for accounts → the user closed the modal.
    if (!attempt) return null;
    const name = attempt.wallet.name ?? "Wallet";
    // The wallet returned accounts but get-starknet still rejected it (Ready X
    // on a fresh install doesn't report the accounts permission yet). The
    // dapp is effectively authorized, so carry on with it; readChainId below
    // completes Ready's legacy authorization.
    if (attempt.accounts?.length) {
      wallet = attempt.wallet;
    } else {
      throw new Error(
        attempt.error
          ? `${name} didn't connect: ${messageOf(attempt.error)}. Unlock the wallet, approve the connection, and try again.`
          : `${name} didn't approve the connection. Unlock the wallet, approve the connection, and try again.`
      );
    }
  }
  const walletName = wallet.name ?? "Wallet";

  // Reuse the accounts get-starknet already requested while enabling this
  // wallet; only ask again if they weren't captured (e.g. a virtual wallet).
  // Don't use `silent_mode: true` (WalletAccount.connect(..., true)): Ready
  // (ex-Argent X) never answers it, which left the UI stuck on "Connecting…".
  const captured =
    attempt && attempt.wallet === wallet && attempt.accounts?.length ? attempt.accounts : undefined;
  const accounts =
    captured ??
    (await withTimeout(
      wallet.request({ type: "wallet_requestAccounts" }),
      60_000,
      `${walletName} did not return an account. Unlock the wallet and try again.`
    ));
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
