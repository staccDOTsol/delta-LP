import type {Address, Hash} from 'viem';

export type NftDeployment = {
  adapter: Address;
  adapterRuntimeCodeHash: Hash;
  receipt: Address;
  collections: readonly {denomination: number; address: Address}[];
};

// Populated only from verified on-chain deployment records by publish-stack-bindings.
export const nftDeployment: NftDeployment | null = null;
