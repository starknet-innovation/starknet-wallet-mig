import { RpcProvider } from "starknet";
import { DEFAULT_RPC_URL, LS } from "../config";

export function getRpcUrl(): string {
  return localStorage.getItem(LS.rpcUrl) || DEFAULT_RPC_URL;
}

export function setRpcUrl(url: string) {
  localStorage.setItem(LS.rpcUrl, url.trim());
}

/** A read-only provider used for balance reads, ownerOf checks, sig verification. */
export function makeProvider(): RpcProvider {
  return new RpcProvider({ nodeUrl: getRpcUrl() });
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** True when the node answered "contract not found" (RPC error code 20). */
export function isContractNotFound(error: unknown): boolean {
  const code = (error as { baseError?: { code?: number } })?.baseError?.code;
  if (code === 20) return true;
  return /contract not found|\b20\b.*contract/i.test(rawMessage(error));
}

/**
 * An RPC failure whose message is already user-facing (from describeRpcError).
 * Callers show its message as-is instead of formatting it again.
 */
export class RpcError extends Error {
  constructor(cause: unknown, rpcUrl?: string) {
    super(describeRpcError(cause, rpcUrl));
    this.name = "RpcError";
  }
}

/**
 * True when the request never got a usable answer from the RPC node. Matches
 * known fetch/network/HTTP-status messages only, so unrelated TypeErrors (e.g. a
 * wallet rejecting a signing call) are not mistaken for RPC failures.
 */
export function isRpcTransportError(error: unknown): boolean {
  if (error instanceof RpcError) return false;
  const text = rawMessage(error);
  return /failed to fetch|networkerror|load failed|cors|err_|timed? ?out|(?:status(?: code)?|http)[: ]+[45]\d\d\b|\b(429|502|503|504)\b/i.test(
    text
  );
}

/**
 * Human-readable description of an RPC failure, naming the endpoint so the user
 * can tell a node/CORS/network problem apart from a contract-level error.
 */
export function describeRpcError(error: unknown, rpcUrl: string = getRpcUrl()): string {
  const text = rawMessage(error).trim() || "unknown error";
  if (isRpcTransportError(error)) {
    return `Couldn't reach the Starknet RPC at ${rpcUrl} (${text}). Check your connection, or switch RPC in Settings.`;
  }
  return `RPC error from ${rpcUrl}: ${text}`;
}
