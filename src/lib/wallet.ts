import { connect, disconnect } from "@starknet-io/get-starknet";
import { type AccountInterface, WalletAccount } from "starknet";
import { CHAIN_ID } from "../config";
import { makeProvider } from "./provider";

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

  // The chain id gates migration to the target network, so a wallet that
  // can't report it must fail the connection rather than pass as "unknown".
  let chainId: bigint;
  try {
    chainId = BigInt(
      await withTimeout(wallet.request({ type: "wallet_requestChainId" }), 15_000, "timeout")
    );
  } catch {
    throw new Error(`${walletName} did not report its network. Check the wallet and try again.`);
  }

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
