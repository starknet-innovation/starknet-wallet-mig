import { shortString } from "starknet";

/**
 * Decode a Cairo string returned by `symbol()` / `name()`. Handles both the
 * legacy felt252 short-string form (1 felt) and the Cairo 1 ByteArray form
 * (`[num_full_words, ...words, pending_word, pending_word_len]`).
 */
export function decodeCairoString(felts: string[]): string {
  if (!felts || felts.length === 0) return "";
  if (felts.length === 1) {
    try {
      return shortString.decodeShortString(felts[0]);
    } catch {
      return "";
    }
  }
  try {
    const n = Number(BigInt(felts[0]));
    const bytes: number[] = [];
    for (let i = 0; i < n; i++) pushFeltBytes(felts[1 + i], 31, bytes);
    const pending = felts[1 + n];
    const pendingLen = Number(BigInt(felts[2 + n] ?? "0"));
    if (pending !== undefined && pendingLen > 0) {
      pushFeltBytes(pending, pendingLen, bytes);
    }
    const s = new TextDecoder().decode(new Uint8Array(bytes));
    if (s) return s;
  } catch {
    /* fall through */
  }
  try {
    return shortString.decodeShortString(felts[0]);
  } catch {
    return "";
  }
}

function pushFeltBytes(felt: string, len: number, out: number[]) {
  let hex = BigInt(felt).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = (hex.match(/.{2}/g) ?? []).map((h) => Number.parseInt(h, 16));
  while (bytes.length < len) bytes.unshift(0);
  bytes = bytes.slice(bytes.length - len);
  for (const b of bytes) out.push(b);
}
