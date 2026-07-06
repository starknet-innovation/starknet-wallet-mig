import {
  type AccountInterface,
  type Call,
  CallData,
  type Signature,
  type TypedData,
  cairo,
} from "starknet";
import { CHAIN_ID, DAPP_NAME, MAX_CALLS_PER_TX } from "../config";
import type { Asset } from "./types";

export interface MigrationItem {
  asset: Asset;
  /** ERC-20: raw token amount. ERC-721: 1. ERC-1155: count. */
  amount: bigint;
}

/** Build an ERC-20 `transfer(to, amount)` call. */
export function erc20TransferCall(token: string, to: string, amount: bigint): Call {
  return {
    contractAddress: token,
    entrypoint: "transfer",
    calldata: CallData.compile([to, cairo.uint256(amount)]),
  };
}

/** Build the single transfer Call for one migration item. */
export function buildCall(item: MigrationItem, from: string, to: string): Call {
  const a = item.asset;
  if (a.kind === "erc20") {
    return erc20TransferCall(a.address, to, item.amount);
  }
  if (a.kind === "erc721") {
    return {
      contractAddress: a.address,
      entrypoint: "transferFrom",
      calldata: CallData.compile([from, to, cairo.uint256(a.tokenId)]),
    };
  }
  // erc1155
  return {
    contractAddress: a.address,
    entrypoint: "safeTransferFrom",
    calldata: CallData.compile([
      from,
      to,
      cairo.uint256(a.tokenId),
      cairo.uint256(item.amount),
      [],
    ]),
  };
}

export function buildCalls(items: MigrationItem[], from: string, to: string): Call[] {
  return items.map((it) => buildCall(it, from, to));
}

export function chunk<T>(arr: T[], size = MAX_CALLS_PER_TX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function estimateFee(account: AccountInterface, calls: Call[]) {
  return account.estimateInvokeFee(calls);
}

export interface ExecResult {
  transactionHash: string;
}

export async function executeCalls(account: AccountInterface, calls: Call[]): Promise<ExecResult> {
  const res = await account.execute(calls);
  return { transactionHash: res.transaction_hash };
}

// ---------------------------------------------------------------------------
// Receiving-wallet ownership proof (SNIP-12 typed-data signature)
// ---------------------------------------------------------------------------

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * SNIP-12 (revision 1) typed message the receiving wallet signs to prove it
 * controls the destination address.
 */
export function buildOwnershipChallenge(opts: {
  sender: string;
  receiver: string;
  nonce: string;
}): TypedData {
  return {
    domain: {
      name: DAPP_NAME,
      version: "1",
      chainId: CHAIN_ID,
      revision: "1",
    },
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      Proof: [
        { name: "intent", type: "shortstring" },
        { name: "sender", type: "ContractAddress" },
        { name: "receiver", type: "ContractAddress" },
        { name: "nonce", type: "felt" },
      ],
    },
    primaryType: "Proof",
    message: {
      intent: "Receive wallet migration",
      sender: opts.sender,
      receiver: opts.receiver,
      nonce: opts.nonce,
    },
  };
}

/** Verify a typed-data signature on-chain against the receiver's account. */
export async function verifyOwnership(
  account: AccountInterface,
  typedData: TypedData,
  signature: Signature,
  receiver: string
): Promise<boolean> {
  try {
    return await account.verifyMessageInStarknet(typedData, signature, receiver);
  } catch {
    return false;
  }
}
