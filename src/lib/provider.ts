import { RpcProvider } from "starknet";
import { DEFAULT_RPC_URL, LEGACY_DEFAULT_RPC_URLS, LS } from "../config";

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The RPC URL in use: the user's saved override, or DEFAULT_RPC_URL. A saved
 * value that is a former default is treated as unset (and cleared), so users
 * who once pressed Save follow default changes instead of being pinned to a
 * retired endpoint.
 */
// Override kept for this page session when browser storage can't persist it.
let sessionOverride: string | undefined;

export function getRpcUrl(): string {
  if (sessionOverride !== undefined) return sessionOverride || DEFAULT_RPC_URL;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LS.rpcUrl);
  } catch {
    /* storage unavailable — use the default */
  }
  if (!saved) return DEFAULT_RPC_URL;
  if (LEGACY_DEFAULT_RPC_URLS.some((u) => normalizeUrl(u) === normalizeUrl(saved))) {
    try {
      localStorage.removeItem(LS.rpcUrl);
    } catch {
      /* ignore */
    }
    return DEFAULT_RPC_URL;
  }
  return saved;
}

/**
 * Save an RPC override. Blank or the default clears it, so future default
 * changes apply. Returns false when browser storage is unavailable; the value
 * then still applies for this page session.
 */
export function setRpcUrl(url: string): boolean {
  const value = url.trim();
  const isDefault = !value || normalizeUrl(value) === normalizeUrl(DEFAULT_RPC_URL);
  try {
    if (isDefault) {
      localStorage.removeItem(LS.rpcUrl);
    } else {
      localStorage.setItem(LS.rpcUrl, value);
    }
    sessionOverride = undefined;
    return true;
  } catch {
    sessionOverride = isDefault ? "" : value;
    return false;
  }
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
