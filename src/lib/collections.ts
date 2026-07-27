/**
 * Curated list of Starknet **mainnet** NFT (ERC-721) collections, for plain-RPC
 * discovery. Starknet has no core "list my NFTs" call, so the app uses the
 * cheapest safe strategy each collection supports: ERC-721 Enumerable,
 * collection-specific owner/count views, bounded sequential ownership checks,
 * or the app's indexed-transfer proxy. Every discovered ERC-721 ID is verified
 * with `ownerOf`; ERC-1155 balances are re-read on-chain.
 *
 * Add collections freely — only the address matters; `name` is for display.
 * Each entry below was verified to respond on-chain.
 */
export interface NftCollectionInfo {
  address: string;
  name: string;
  standard?: "erc721" | "erc1155";
  /** View that returns a token ID associated with an owner (for example, a main ID). */
  ownerTokenEntrypoint?: string;
  /** View that returns the next token ID or total minted count for a small collection. */
  tokenCountEntrypoint?: string;
}

export const MAINNET_NFT_COLLECTIONS: NftCollectionInfo[] = [
  {
    address: "0x05dbdedc203e92749e2e746e2d40a768d966bd243df04a6b712e222bc040a9af",
    name: "Starknet.id",
    ownerTokenEntrypoint: "get_main_id",
  },
  {
    address: "0x076503062d78f4481be03c9145022d6a4a71ec0719aa07756f79a2384dc7ef16",
    name: "Starknet Quest",
  },
  {
    address: "0x031075ef90ad626dc13fb97cdc7e04499ee5fa1007f2c4e1a9439b22fc3755b9",
    name: "Lil Duckies",
    standard: "erc1155",
    tokenCountEntrypoint: "next_token_id",
  },
  {
    address: "0x02c3d976495cd521f00f98e22ce6feb25b9e5b1724f6af3423c932d44d0fc152",
    name: "Ducks Everywhere",
    tokenCountEntrypoint: "next_token_id",
  },
  {
    // Minimal ERC-721 (snake-case balance_of, no on-chain name/symbol) — rename
    // this label to taste.
    address: "0x058e75fe127b94923d6efe51c56bca98bd82cd43c7fd2ea562019a3101c245f9",
    name: "Collection 0x058e…245f9",
    tokenCountEntrypoint: "total_minted_token",
  },
  {
    address: "0x02acee8c430f62333cf0e0e7a94b2347b5513b4c25f699461dd8d7b23c072478",
    name: "EveraiDuo",
  },
  {
    address: "0x058949fa2955b10b3a82521934e8b0505dc0b7ba929c3049622ae91d2c52e194",
    name: "Dungeon Ducks",
  },
  {
    // Distinct from the briq-based "Ducks Everywhere" (0x02c3…).
    address: "0x04fa864a706e3403fd17ac8df307f22eafa21b778b73353abf69a622e47a2003",
    name: "Ducks Everywhere (DUCKS)",
  },
];
