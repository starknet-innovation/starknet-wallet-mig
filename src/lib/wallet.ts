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

/** Open the wallet modal and return a connected account, or null if cancelled. */
export async function connectWallet(
  modalMode: "alwaysAsk" | "canAsk" = "alwaysAsk"
): Promise<WalletConnection | null> {
  const wallet = await connect({
    modalMode,
    modalTheme: "dark",
  });
  if (!wallet) return null;

  // get-starknet already requested access; reconnect silently to wrap the
  // selected wallet in the starknet.js v10 AccountInterface.
  const account = await WalletAccount.connect(makeProvider(), wallet, undefined, undefined, true);
  const chainId = await wallet.request({ type: "wallet_requestChainId" });
  return {
    address: account.address,
    chainId: BigInt(chainId),
    account,
    walletName: wallet.name ?? "Wallet",
  };
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
