import type { AccountInterface } from "starknet";
import { connect, disconnect } from "starknetkit";
import { CHAIN_ID, DAPP_NAME } from "../config";
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
  const { connector, connectorData } = await connect({
    modalMode,
    dappName: DAPP_NAME,
    modalTheme: "dark",
  });
  if (!connector || !connectorData?.account) return null;
  const account = await connector.account(makeProvider());
  return {
    address: connectorData.account,
    chainId: connectorData.chainId,
    account,
    walletName: connector.name ?? "Wallet",
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
